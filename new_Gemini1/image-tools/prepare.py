#!/usr/bin/env python3
"""Install inert clone hooks on an Ubuntu/Pi source; never arms its card."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

SERVICES = ['user@', 'ros2ide-agent', 'tailscaled', 'ssh', 'sshd', 'NetworkManager', 'systemd-networkd', 'systemd-resolved', 'dhcpcd', 'wpa_supplicant', 'wpa_supplicant@', 'cron']
UNIT = '''[Unit]
Description=ROSIDE new robot identity on cloned SD card
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target network.target systemd-user-sessions.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 /usr/local/lib/roside-image/first_boot.py
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
'''


def prepare(first_boot_source, root=Path('/'), run=subprocess.run):
    if sys.version_info < (3,9):raise ValueError('ต้นแบบต้องมี Python 3.9 ขึ้นไป')
    boot = next((root/p for p in ('boot/firmware', 'boot') if (root/p/'config.txt').is_file()), None)
    if boot is None or not (root/'etc/os-release').is_file():
        raise ValueError('รองรับต้นแบบ Ubuntu/Raspberry Pi ที่มี Boot FAT และ systemd')
    homes = [root/'root']+list((root/'home').glob('*'))
    configs = [h/'.ros2ide/config.json' for h in homes if (h/'.ros2ide/config.json').is_file()]
    if not configs:raise ValueError('ต้นแบบต้องติดตั้ง ROSIDE Agent แบบ Online + Local ก่อนเตรียม Image')
    for config in configs:
        if not json.loads(config.read_text()).get('robot_key'):raise ValueError('Agent config ของต้นแบบไม่มี Robot Key')
    marker = boot/'ROSIDE.NEW'
    if marker.exists() and json.loads(marker.read_text().strip()).get('armed'):
        raise ValueError('มีคำขอสร้างหุ่นใหม่ค้างอยู่ ต้องบูตให้เสร็จก่อน')
    lib = root/'usr/local/lib/roside-image'
    lib.mkdir(parents=True, exist_ok=True)
    (lib/'first_boot.py').write_text(first_boot_source)
    (lib/'first_boot.py').chmod(0o755)
    units = root/'etc/systemd/system'
    units.mkdir(parents=True, exist_ok=True)
    (units/'roside-clone-firstboot.service').write_text(UNIT)
    for service in SERVICES:
        directory = units/(service+'.service.d')
        directory.mkdir(exist_ok=True)
        (directory/'10-roside-clone.conf').write_text('[Unit]\nRequires=roside-clone-firstboot.service\nAfter=roside-clone-firstboot.service\n')
    wants = units/'multi-user.target.wants'
    wants.mkdir(exist_ok=True)
    link = wants/'roside-clone-firstboot.service'
    if not link.exists():
        link.symlink_to('../roside-clone-firstboot.service')
    info = {'version': 1, 'identityVersion': 2, 'os': (root/'etc/os-release').read_text()[:4096], 'architecture': platform.machine(), 'ros': [p.name for p in (root/'opt/ros').glob('*') if p.is_dir()]}
    model = root/'proc/device-tree/model'
    info['model'] = model.read_text().strip('\0') if model.exists() else platform.machine()
    for name, value in [('ROSIDE.PRP', info), ('ROSIDE.NEW', {'armed': False})]:
        data = json.dumps(value, ensure_ascii=False).encode()
        if len(data) > 2048:
            raise ValueError('ข้อมูลต้นแบบมีขนาดใหญ่เกินไป')
        with (boot/name).open('wb') as handle:
            handle.write(data.ljust(2048, b' '));handle.flush();os.fsync(handle.fileno())
    if root == Path('/'):
        run(['systemctl', 'daemon-reload'], check=True, timeout=30)
        os.sync()
    return info


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--first-boot', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('ต้องรันด้วย sudo เพื่อเตรียมหุ่นต้นแบบ')
    print(json.dumps(prepare(Path(args.first_boot).read_text()), ensure_ascii=False))
