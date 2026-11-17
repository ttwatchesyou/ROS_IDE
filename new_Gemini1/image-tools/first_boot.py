#!/usr/bin/env python3
"""Runs before networking/user services. An unarmed source card is untouched."""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys


def atomic_json(path, data, mode=0o600):
    original = path.stat() if path.exists() else None
    tmp = path.with_name(path.name+'.roside-pending')
    tmp.write_text(json.dumps(data, indent=2)+'\n')
    if mode is not None:tmp.chmod(mode)
    if original and mode is not None:
        os.chown(tmp, original.st_uid, original.st_gid)
    os.replace(tmp, path)


def reset_clone(root=Path('/'), run=subprocess.run):
    boot = next((root/p for p in ('boot/firmware', 'boot') if (root/p/'ROSIDE.NEW').is_file()), None)
    if boot is None:
        return False
    marker = boot/'ROSIDE.NEW'
    request = json.loads(marker.read_text().strip())
    if request.get('armed') is not True:
        return False
    proposed_key = request.get('robotKey')
    if proposed_key is not None and not re.fullmatch(r'[a-f0-9]{64}', proposed_key):
        raise ValueError('Invalid new Robot Key; networking remains blocked')
    is_template = request.get('template') is True
    hostname = 'robot-clone' if is_template else request.get('hostname', '')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', hostname):
        raise ValueError('Invalid clone hostname; networking remains blocked')
    # Persist chosen identities before changing anything; failed boots can retry.
    state = root/'var/lib/roside-clone'
    state.mkdir(parents=True, exist_ok=True)
    identity_file = state/'pending.json'
    if identity_file.exists():
        identity = json.loads(identity_file.read_text())
        if identity['request'] != request['id']:
            completed = boot/'ROSIDE.OK'
            if not completed.exists() or json.loads(completed.read_text()).get('request') != identity['request']:
                raise ValueError('Different clone request is already pending')
            identity_file.unlink()
            identity = {'request': request['id'], 'robotKey': proposed_key or secrets.token_hex(32), 'machineId': secrets.token_hex(16), 'localSecret': secrets.token_urlsafe(32)}
            atomic_json(identity_file, identity)
    else:
        identity = {'request': request['id'], 'robotKey': proposed_key or secrets.token_hex(32), 'machineId': secrets.token_hex(16), 'localSecret': secrets.token_urlsafe(32)}
        atomic_json(identity_file, identity)
    if is_template:hostname = 'robot-'+identity['robotKey'][:8]
    homes = [root/'root']+list((root/'home').glob('*'))
    configs = [h/'.ros2ide/config.json' for h in homes if (h/'.ros2ide/config.json').is_file()]
    if not configs:
        raise ValueError('ROSIDE Agent config missing; networking remains blocked')
    backups = [p for home in homes for p in (home/'.ros2ide/releases').glob('*/previous-config.json')]
    for config in configs+backups:
        value = json.loads(config.read_text())
        value.update(robot_key=identity['robotKey'], robot_name=hostname, local_secret=identity['localSecret'], active_mode='local')
        # Device-specific allowlists and VPN addresses cannot follow the source.
        for key in ('local_hosts', 'local_origin'):
            value.pop(key, None)
        atomic_json(config, value)
    etc = root/'etc'
    (etc/'hostname').write_text(hostname+'\n')
    if (etc/'cloud').is_dir():
        directory = etc/'cloud/cloud.cfg.d'
        directory.mkdir(exist_ok=True)
        (directory/'99-roside-clone.cfg').write_text('preserve_hostname: true\n')
    hosts = etc/'hosts'
    content = hosts.read_text() if hosts.exists() else '127.0.0.1 localhost\n'
    content = re.sub(r'^127\.0\.1\.1\s+.*$', '127.0.1.1 '+hostname, content, flags=re.M)
    if not re.search(r'^127\.0\.1\.1\s', content, re.M):
        content += '\n127.0.1.1 '+hostname+'\n'
    hosts.write_text(content)
    (etc/'machine-id').write_text(identity['machineId']+'\n')
    dbus = root/'var/lib/dbus/machine-id'
    if dbus.exists() and not dbus.is_symlink():
        dbus.write_text(identity['machineId']+'\n')
    for key in (etc/'ssh').glob('ssh_host_*'):
        if key.is_file():
            key.unlink()
    # Tailscale and other local logins must be registered for the new robot.
    tailscale = root/'var/lib/tailscale'
    for item in tailscale.glob('tailscaled.state*'):
        if item.is_file():
            item.unlink()
    for home in homes:
        ssh = home/'.ssh'
        for item in ssh.glob('*'):
            if item.is_file() and (item.name.startswith('id_') or item.name in ('authorized_keys', 'known_hosts')):
                item.unlink()
    if root == Path('/'):
        run(['ssh-keygen', '-A'], check=True, timeout=60)
    # No old key appears on the network. Reboot into a fresh PID1/machine-id.
    atomic_json(boot/'ROSIDE.OK', {'hostname': hostname, 'robotKey': identity['robotKey'], 'request': request['id'], 'next': 'Register a new robot in ROSIDE and sign in to Tailscale again'}, None)
    marker.write_text(json.dumps({'armed': False, 'completed': request['id']}).ljust(2048, ' '))
    os.sync() if hasattr(os, 'sync') else None
    identity_file.unlink(missing_ok=True)
    return True


if __name__ == '__main__':
    try:
        changed = reset_clone()
        if changed:
            subprocess.run(['systemctl', '--no-block', 'reboot'], check=True, timeout=15)
            # Fail closed until the requested reboot: dependent networking waits.
            sys.exit(75)
    except Exception as error:
        print('ROSIDE clone setup stopped: '+str(error), file=sys.stderr)
        sys.exit(1)
