"""Official Ubuntu download + fresh per-card cloud-init environment preset.
Network/image IO happens only in the PC Helper. Ubuntu installs ROS on first boot.
"""
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import secrets
import shutil
import struct
import threading
import time
import urllib.parse
import urllib.request
import uuid

import adapters
from fat_seed import SeedVolume
from passwords import password_hash
from env_install import BASE_PACKAGES, ROS_PACKAGES

PROFILE={'id':'ubuntu-2404-jazzy-rpi-v1','ubuntu':'24.04 LTS','ros':'ROS 2 Jazzy','architecture':'arm64','boards':['Raspberry Pi 4','Raspberry Pi 5','Compute Module 4/5'],'minimumCardBytes':30000000000,'packages':BASE_PACKAGES+ROS_PACKAGES,'firstBootInternet':True}
BASE_URL='https://cdimage.ubuntu.com/ubuntu/releases/24.04/release/'
MANIFEST=BASE_URL+'SHA256SUMS'
CHUNK=4*1024*1024


def choose_release(text):
    choices=[]
    for line in text.splitlines():
        match=re.fullmatch(r'([a-f0-9]{64})\s+\*?(ubuntu-24\.04\.(\d+)-preinstalled-server-arm64\+raspi\.img\.xz)',line.strip())
        if match:choices.append((int(match[3]),match[2],match[1]))
    if not choices:raise ValueError('ไม่พบ Image Ubuntu 24.04 ARM64 Raspberry Pi จาก Ubuntu')
    _,name,digest=max(choices)
    return {'file':name,'sha256':digest,'url':BASE_URL+name}


def xz_size(path):
    with Path(path).open('rb') as f:
        f.seek(-12,2);footer=f.read(12)
        if footer[10:]!=b'YZ':raise ValueError('Invalid Ubuntu XZ image')
        size=(struct.unpack_from('<I',footer,4)[0]+1)*4
        if not 4<=size<=32*1024*1024:raise ValueError('XZ index too large')
        f.seek(-12-size,2);data=f.read(size)
    if data[0]!=0:raise ValueError('Invalid XZ index')
    pos=1
    def vli():
        nonlocal pos
        value=0
        for shift in range(0,63,7):
            byte=data[pos];pos+=1;value|=(byte&127)<<shift
            if not byte&128:return value
        raise ValueError('Invalid XZ VLI')
    count=vli()
    if count>1000000:raise ValueError('XZ block count invalid')
    total=0
    for _ in range(count):vli();total+=vli()
    if total<=0 or total%512:raise ValueError('Ubuntu image size is not sector aligned')
    return total


def validate_settings(body):
    hostname=str(body.get('hostname',''));username=str(body.get('username',''))
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',hostname):raise ValueError('ชื่อเครื่องใช้ a-z, 0-9 และ - ความยาว 1–63 ตัว')
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,30}',username) or username in ('root','daemon','nobody','systemd-network','sshd'):raise ValueError('ชื่อผู้ใช้ Ubuntu ไม่ถูกต้อง')
    password=body.get('password','')
    if not isinstance(password,str) or not 10<=len(password)<=128:raise ValueError('รหัสผ่าน Ubuntu ต้องยาว 10–128 ตัวอักษร')
    domain=body.get('domainId',10)
    if isinstance(domain,bool) or not isinstance(domain,int) or not 0<=domain<=232:raise ValueError('ROS Domain ID ต้องเป็นจำนวนเต็ม 0–232')
    ssid=str(body.get('ssid',''));wifi=body.get('wifiPassword','')
    if len(ssid.encode())>32 or not isinstance(wifi,str) or len(wifi)>63 or (ssid and len(wifi)<8):raise ValueError('Wi-Fi ใช้ SSID ไม่เกิน 32 bytes และรหัสผ่าน 8–63 ตัว')
    cloud=str(body.get('cloudUrl','')).rstrip('/');install=body.get('installAgent',True) is True
    parsed=urllib.parse.urlsplit(cloud)
    if install and (parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):raise ValueError('ใส่ URL ของ ROSIDE Cloud แบบ https://ชื่อเซิร์ฟเวอร์:พอร์ต')
    return {'hostname':hostname,'username':username,'password':password,'domainId':domain,'ssid':ssid,'wifiPassword':wifi,'cloudUrl':cloud,'installAgent':install}


def cloud_seed(settings,robot_key):
    config={k:v for k,v in settings.items() if k not in ('password','wifiPassword','ssid')};config['robotKey']=robot_key
    script=Path(__file__).with_name('env_install.py').read_text()
    content={'hostname':settings['hostname'],'preserve_hostname':True,'manage_etc_hosts':True,'disable_root':True,'ssh_pwauth':True,'ssh_deletekeys':True,'users':[{'name':settings['username'],'groups':['adm','sudo','dialout','video'],'shell':'/bin/bash','lock_passwd':False,'sudo':'ALL=(ALL) NOPASSWD:ALL','passwd':password_hash(settings['password'])}],'write_files':[{'path':'/opt/roside-env/install_env.py','permissions':'0700','content':script},{'path':'/opt/roside-env/config.json','permissions':'0600','content':json.dumps(config)}],'runcmd':[['python3','/opt/roside-env/install_env.py']],'power_state':{'mode':'reboot','timeout':30,'condition':['test','-f','/var/lib/roside-env/ready']}}
    network={'version':2,'renderer':'networkd','ethernets':{'lan':{'match':{'name':'e*'},'dhcp4':True,'optional':True}}}
    if settings['ssid']:network['wifis']={'wifi':{'match':{'name':'wl*'},'dhcp4':True,'optional':True,'access-points':{settings['ssid']:{'password':settings['wifiPassword']}}}}
    return {'user-data':('#cloud-config\n'+json.dumps(content,ensure_ascii=False)).encode(),'meta-data':json.dumps({'instance-id':'roside-'+uuid.uuid4().hex,'local-hostname':settings['hostname']}).encode(),'network-config':json.dumps(network,ensure_ascii=False).encode()}


class Environment:
    def __init__(self,jobs):
        self.jobs=jobs;self.cache=jobs.output/'.environment-cache';self.cache.mkdir(mode=0o700,exist_ok=True)
        if self.cache.is_symlink() or self.cache.resolve().parent!=jobs.output:raise ValueError('Invalid environment cache folder')

    def profile(self):return PROFILE

    def cached(self):
        p=self.cache/'base.json'
        if not p.is_file() or p.is_symlink() or p.stat().st_size>10000:return None
        try:
            value=json.loads(p.read_text());path=self.path(value)
            return value if path.is_file() and path.stat().st_size==value['fileBytes'] else None
        except (ValueError,KeyError,OSError):return None

    def path(self,meta):
        name=meta.get('file','')
        if not re.fullmatch(r'ubuntu-24\.04\.\d+-preinstalled-server-arm64\+raspi\.img\.xz',name):raise ValueError('Invalid Ubuntu image filename')
        p=self.cache/name
        if p.is_symlink() or p.resolve().parent!=self.cache:raise ValueError('Invalid Ubuntu image path')
        return p

    def start(self,operation,body):
        if operation not in ('download','flash'):raise ValueError('Unknown environment action')
        device=None
        if operation=='flash':
            if not adapters.privileged():raise ValueError('เปิด Helper ด้วย Administrator / sudo ก่อน Flash')
            settings=validate_settings(body)
            device=next((d for d in self.jobs.discover() if d['id']==body.get('deviceId')),None)
            if not device or device['blocked'] or body.get('fingerprint')!=adapters.fingerprint(device):raise ValueError('เลือก SD card ใหม่ แล้วกดค้นหาอีกครั้ง')
            if body.get('confirm')!=device['id']:raise ValueError('พิมพ์รหัสดิสก์ปลายทางเพื่อยืนยันลบข้อมูล')
            meta=self.cached()
            if not meta:raise ValueError('ดาวน์โหลด Image Ubuntu ให้เสร็จก่อน')
            if device['size']<max(PROFILE['minimumCardBytes'],meta['rawBytes']):raise ValueError('ต้องใช้ SD card 32 GB ขึ้นไปที่มีพื้นที่จริงพอสำหรับ Image')
        else:settings=None
        with self.jobs.lock:
            if self.jobs.state['state']=='running':raise ValueError('ทำได้ครั้งละหนึ่งงาน รอหรือยกเลิกงานเดิมก่อน')
            self.jobs.cancel.clear();self.jobs.state={'id':uuid.uuid4().hex,'state':'running','operation':'environment-'+operation,'phase':'preflight','done':0,'total':0,'startedAt':time.time(),'error':''}
        threading.Thread(target=self.worker,args=(operation,device,settings),daemon=True).start()
        return self.jobs.snapshot()

    def worker(self,operation,device,settings):
        try:
            result=self.download() if operation=='download' else self.flash(device,settings)
            self.jobs.update(force=True,state='complete',phase='complete',result=result)
        except InterruptedError as error:self.jobs.update(force=True,state='cancelled',error=str(error))
        except Exception as error:self.jobs.update(force=True,state='failed',error=str(error)[:1000])

    def download(self):
        self.jobs.update(force=True,phase='catalog',done=0,total=0)
        with urllib.request.urlopen(urllib.request.Request(MANIFEST,headers={'User-Agent':'ROSIDE-Environment/1'}),timeout=30) as r:meta=choose_release(r.read(100000).decode())
        path=self.path(meta);old=self.cached()
        if old and old['sha256']==meta['sha256']:
            self.jobs.update(force=True,phase='checking',done=0,total=path.stat().st_size)
            if self.jobs.hash_file(path)==meta['sha256']:return {'kind':'download','image':old}
        partial=path.with_name(path.name+'.partial')
        try:
            with urllib.request.urlopen(urllib.request.Request(meta['url'],headers={'User-Agent':'ROSIDE-Environment/1'}),timeout=90) as response:
                host=urllib.parse.urlsplit(response.url).hostname or ''
                if not host.endswith('.ubuntu.com') or not response.url.startswith('https://'):raise ValueError('Ubuntu download redirected outside the official HTTPS host')
                length=int(response.headers.get('Content-Length') or 0)
                if length and shutil.disk_usage(self.cache).free<length+256*1024*1024:raise ValueError('พื้นที่คอมไม่พอสำหรับดาวน์โหลด Ubuntu')
                self.jobs.update(force=True,phase='downloading',done=0,total=length)
                digest=hashlib.sha256();done=0
                fd=os.open(partial,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,'wb') as out:
                    while True:
                        self.jobs.checkpoint();chunk=response.read(CHUNK)
                        if not chunk:break
                        out.write(chunk);digest.update(chunk);done+=len(chunk);self.jobs.update(done=done)
                    out.flush();os.fsync(out.fileno())
                if length and done!=length:raise IOError('ดาวน์โหลด Ubuntu ไม่ครบ')
                if digest.hexdigest()!=meta['sha256']:raise ValueError('SHA256 ของ Image ไม่ตรงกับ Ubuntu ห้าม Flash')
            meta.update(rawBytes=xz_size(partial),fileBytes=partial.stat().st_size,verifiedAt=time.time(),profile=PROFILE['id'])
            os.replace(partial,path)
            tmp=self.cache/'base.json.pending';tmp.write_text(json.dumps(meta));os.replace(tmp,self.cache/'base.json')
            return {'kind':'download','image':meta}
        finally:
            if partial.exists():partial.unlink()

    def flash(self,device,settings):
        meta=self.cached()
        if not meta:raise ValueError('Image Ubuntu ยังไม่พร้อม')
        path=self.path(meta);jobs=self.jobs
        jobs.update(force=True,phase='checking',done=0,total=meta['fileBytes'])
        if jobs.hash_file(path)!=meta['sha256']:raise ValueError('ไฟล์ Ubuntu ถูกแก้ไขหรือเสีย ต้องดาวน์โหลดใหม่')
        if shutil.disk_usage(self.cache).free<meta['rawBytes']+256*1024*1024:raise ValueError('คอมต้องมีพื้นที่ว่างสำหรับแตก Image '+str(round(meta['rawBytes']/1024**3,1))+' GB + 256 MB')
        variant=self.cache/('seed-'+uuid.uuid4().hex+'.img');robot_key=secrets.token_hex(32)
        try:
            jobs.update(force=True,phase='extracting',done=0,total=meta['rawBytes']);done=0
            fd=os.open(variant,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w+b') as raw,lzma.open(path,'rb') as source:
                while True:
                    jobs.checkpoint();data=source.read(CHUNK)
                    if not data:break
                    raw.write(data);done+=len(data);jobs.update(done=done)
                if done!=meta['rawBytes']:raise ValueError('ขนาด Image หลังแตกไม่ตรงกัน')
                raw.flush();volume=SeedVolume(raw)
                jobs.update(force=True,phase='configuring',done=0,total=3)
                for i,(name,data) in enumerate(cloud_seed(settings,robot_key).items()):volume.write_file(name,data);jobs.update(force=True,done=i+1)
                raw.flush();os.fsync(raw.fileno())
                with jobs.opener(device,True) as (dest,current):
                    if current['size']<max(PROFILE['minimumCardBytes'],meta['rawBytes']):raise ValueError('SD ปลายทางเล็กเกินไป')
                    raw.seek(0);digest=hashlib.sha256();done=0;jobs.update(force=True,phase='writing',done=0,total=meta['rawBytes'])
                    while done<meta['rawBytes']:
                        jobs.checkpoint();data=raw.read(min(CHUNK,meta['rawBytes']-done))
                        if not data:raise IOError('อ่าน Image ไม่ครบ')
                        digest.update(data);view=memoryview(data)
                        while view:
                            n=dest.write(view)
                            if not n:raise IOError('SD เขียนไม่ครบ')
                            view=view[n:]
                        done+=len(data);jobs.update(done=done)
                    dest.flush();os.fsync(dest.fileno());dest.seek(0);check=hashlib.sha256();done=0;jobs.update(force=True,phase='verifying',done=0,total=meta['rawBytes'])
                    while done<meta['rawBytes']:
                        jobs.checkpoint();data=dest.read(min(CHUNK,meta['rawBytes']-done))
                        if not data:raise IOError('ตรวจ SD กลับมาไม่ครบ')
                        check.update(data);done+=len(data);jobs.update(done=done)
                    if check.hexdigest()!=digest.hexdigest():raise IOError('SD หลัง Flash ไม่ผ่านการตรวจข้อมูล')
            return {'kind':'flash','hostname':settings['hostname'],'username':settings['username'],'robotKey':robot_key if settings['installAgent'] else None,'installAgent':settings['installAgent'],'next':'Flash Ubuntu สำเร็จแล้ว ยังต้องบูต Pi และต่อ Internet เพื่อให้ติดตั้ง ROS/Jazzy และเครื่องมืออัตโนมัติ รอจน /boot/firmware/ROSIDE.ENV แสดง ready และรีบูตหนึ่งครั้ง'}
        finally:
            if variant.exists():variant.unlink()
