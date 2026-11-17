#!/usr/bin/env python3
"""Ubuntu 24.04/Jazzy first-boot provisioning; runs ON THE PI, never Cloud."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

BASE_PACKAGES = ['build-essential','cmake','git','curl','wget','ca-certificates','gnupg','locales','software-properties-common','python3','python3-pip','python3-venv','python3-dev','python3-serial','python3-numpy','python3-scipy','python3-opencv','python3-matplotlib','python3-yaml','python3-setuptools','python3-argcomplete','libudev-dev','pkg-config','usbutils','i2c-tools','python3-smbus','net-tools','iproute2','iputils-ping','dnsutils','htop','tmux','unzip','openssh-server','avahi-daemon','ubuntu-desktop-minimal','mesa-utils','xauth']
ROS_PACKAGES = ['ros-dev-tools','ros-jazzy-desktop','ros-jazzy-rviz2','ros-jazzy-navigation2','ros-jazzy-nav2-bringup','ros-jazzy-slam-toolbox','ros-jazzy-robot-localization','ros-jazzy-robot-state-publisher','ros-jazzy-joint-state-publisher-gui','ros-jazzy-xacro','ros-jazzy-tf2-tools','ros-jazzy-rmw-cyclonedds-cpp','ros-jazzy-rosbridge-server','ros-jazzy-cv-bridge','ros-jazzy-rqt-common-plugins']
APT_SOURCE_URL = 'https://github.com/ros-infrastructure/ros-apt-source/releases/download/1.3.0/ros2-apt-source_1.3.0.noble_all.deb'
APT_SOURCE_SHA = 'f31d84adf5054c7d60ded0e82c0f776a77ea33af53d08f40b9ad7c94cca55296'
STATE = Path('/var/lib/roside-env')


def status(phase, message, error=''):
    STATE.mkdir(parents=True,exist_ok=True)
    value={'profile':'ubuntu-24.04-jazzy','phase':phase,'message':message,'error':error,'updatedAt':time.time()}
    path=STATE/'status.json';tmp=path.with_suffix('.pending');tmp.write_text(json.dumps(value));os.replace(tmp,path)
    for boot in [Path('/boot/firmware'),Path('/boot')]:
        if (boot/'config.txt').exists():
            (boot/'ROSIDE.ENV').write_text(json.dumps(value,indent=2));break
    print(message,flush=True)


def run(args, env=None):
    merged={**os.environ,'DEBIAN_FRONTEND':'noninteractive','LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8',**(env or {})}
    with Path('/var/log/roside-environment.log').open('a') as log:
        result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,env=merged)
    if result.returncode:raise RuntimeError('Command failed: '+args[0]+'; ดู /var/log/roside-environment.log')


def download(url, dest, expected=None):
    digest=hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'ROSIDE-Environment/1'}),timeout=120) as response,dest.open('wb') as out:
        if not response.url.startswith('https://'):raise ValueError('HTTPS is required')
        while True:
            chunk=response.read(1024*1024)
            if not chunk:break
            out.write(chunk);digest.update(chunk)
    if expected and digest.hexdigest()!=expected:raise ValueError('Download checksum mismatch')


def install_node():
    manifest=urllib.request.urlopen('https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt',timeout=60).read(100000).decode()
    found=re.search(r'^([a-f0-9]{64})\s+(node-(v22\.\d+\.\d+)-linux-arm64\.tar\.xz)$',manifest,re.M)
    if not found:raise ValueError('ไม่พบ Node 22 ARM64 จากผู้ผลิต')
    digest,filename,version=found.groups();archive=STATE/filename
    download('https://nodejs.org/dist/latest-v22.x/'+filename,archive,digest)
    target=Path('/usr/local/lib/roside-node');target.mkdir(exist_ok=True)
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            if not member.name.startswith('node-'+version+'-linux-arm64/') or '..' in Path(member.name).parts:raise ValueError('Invalid Node archive')
        t.extractall(target,filter='data')
    base=target/('node-'+version+'-linux-arm64/bin')
    for name in ['node','npm','npx']:
        link=Path('/usr/local/bin')/name
        if link.is_symlink():link.unlink()
        elif link.exists():raise ValueError('มี '+str(link)+' อยู่แล้ว ต้องตรวจด้วยตนเอง')
        link.symlink_to(base/name)


def provision(config):
    release=Path('/etc/os-release').read_text()
    if 'VERSION_ID="24.04"' not in release or subprocess.check_output(['dpkg','--print-architecture'],text=True).strip()!='arm64':
        raise ValueError('โปรไฟล์นี้รองรับ Ubuntu 24.04 ARM64 เท่านั้น')
    user=config['username'];domain=int(config['domainId']);home=Path('/home')/user
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,30}',user) or not 0<=domain<=232:raise ValueError('Invalid environment settings')
    apt=['apt-get','-o','DPkg::Lock::Timeout=600','-o','Acquire::Retries=5']
    status('base','กำลังติดตั้งเครื่องมือ Ubuntu / Python / Desktop GUI')
    run(apt+['update']);run(apt+['install','-y','locales','ca-certificates','curl','gnupg','software-properties-common'])
    run(['locale-gen','en_US.UTF-8']);run(['update-locale','LANG=en_US.UTF-8','LC_ALL=en_US.UTF-8'])
    run(['add-apt-repository','-y','universe'])
    sources=Path('/etc/apt/sources.list.d/ubuntu.sources')
    if sources.exists():
        text=sources.read_text()
        text=re.sub(r'^Suites:\s*noble\s*$', 'Suites: noble noble-updates noble-backports',text,flags=re.M)
        sources.write_text(text)
    run(apt+['update']);run(apt+['upgrade','-y']);run(apt+['install','-y']+BASE_PACKAGES)
    status('ros','กำลังติดตั้ง ROS 2 Jazzy, RViz2, Nav2 และ SLAM')
    archive=STATE/'ros2-apt-source.deb';download(APT_SOURCE_URL,archive,APT_SOURCE_SHA)
    run(['dpkg','-i',str(archive)]);run(apt+['update']);run(apt+['install','-y']+ROS_PACKAGES)
    rosdep=['rosdep','init']
    if not Path('/etc/ros/rosdep/sources.list.d/20-default.list').exists():run(rosdep)
    uid=subprocess.check_output(['id','-u',user],text=True).strip();gid=subprocess.check_output(['id','-g',user],text=True).strip()
    run(['groupadd','-f','i2c']);run(['usermod','-aG','dialout,video,render,i2c',user])
    envtext=f'export ROS_DOMAIN_ID={domain}\nif [ -n "$BASH_VERSION" ] && [ -f /opt/ros/jazzy/setup.bash ]; then . /opt/ros/jazzy/setup.bash; fi\n'
    Path('/etc/profile.d/roside-ros.sh').write_text(envtext)
    bashrc=home/'.bashrc';text=bashrc.read_text() if bashrc.exists() else ''
    if '# ROSIDE Jazzy environment' not in text:bashrc.write_text(text+'\n# ROSIDE Jazzy environment\n. /etc/profile.d/roside-ros.sh\n')
    envdir=Path('/etc/environment.d');envdir.mkdir(exist_ok=True);(envdir/'90-roside.conf').write_text(f'ROS_DOMAIN_ID={domain}\n')
    run(['runuser','-u',user,'--','python3','-m','venv','--system-site-packages',str(home/'roside-venv')])
    run(['runuser','-u',user,'--','rosdep','update','--rosdistro','jazzy'])
    run(['systemctl','enable','ssh']);run(['systemctl','set-default','graphical.target'])
    if user!='ubuntu' and subprocess.run(['id','ubuntu'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:run(['usermod','-L','ubuntu'])
    if config.get('installAgent'):
        status('agent','กำลังติดตั้ง ROSIDE Agent สำหรับหุ่นใหม่')
        install_node()
        cloud=config['cloudUrl'];directory=home/'.ros2ide';directory.mkdir(exist_ok=True,mode=0o700)
        agent={'robot_key':config['robotKey'],'active_mode':'local','robot_name':config['hostname']}
        (directory/'config.json').write_text(json.dumps(agent));(directory/'config.json').chmod(0o600)
        os.chown(directory,int(uid),int(gid));os.chown(directory/'config.json',int(uid),int(gid))
        installer=STATE/'agent-install.sh';download(cloud+'/agent-install.sh',installer)
        run(['loginctl','enable-linger',user]);run(['systemctl','start','user@'+uid+'.service'])
        runtime='/run/user/'+uid
        run(['runuser','-u',user,'--','env','XDG_RUNTIME_DIR='+runtime,'DBUS_SESSION_BUS_ADDRESS=unix:path='+runtime+'/bus','PATH=/usr/local/bin:/usr/bin:/bin','CLOUD_URL='+cloud,'ROSIDE_NONINTERACTIVE=1','bash',str(installer)])
    status('verifying','กำลังตรวจ Python, ROS, RViz2 และ ifconfig')
    run(['bash','-lc','source /opt/ros/jazzy/setup.bash && ros2 pkg prefix rviz2 && ros2 pkg prefix nav2_bringup && python3 -c "import rclpy,serial,numpy,cv2" && command -v ifconfig'])
    (STATE/'ready').write_text('Ubuntu 24.04 + ROS 2 Jazzy ready\n')
    status('ready','ติดตั้ง Ubuntu 24.04 + ROS 2 Jazzy และเครื่องมือครบแล้ว พร้อมรีบูต')


if __name__=='__main__':
    try:provision(json.loads(Path('/opt/roside-env/config.json').read_text()))
    except Exception as error:
        status('failed','ติดตั้งยังไม่สำเร็จ รัน sudo python3 /opt/roside-env/install_env.py เพื่อลองต่อ',str(error));raise
