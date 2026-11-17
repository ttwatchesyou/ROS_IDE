import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[2]/'image-tools'
sys.path.insert(0, str(BASE))
import adapters
import helper
import first_boot
import prepare
from fat_marker import FatMarkers


def disk_fixture(path, fat32=False):
    clusters, fatsz, roots = (65536, 600, 0) if fat32 else (4096, 20, 64)
    root_secs = roots*32//512
    total = 1+2*fatsz+root_secs+clusters
    with path.open('w+b') as f:
        f.truncate((total+1)*512)
        mbr = bytearray(512);mbr[450] = 0x0c if fat32 else 0x0e;struct.pack_into('<II',mbr,454,1,total);mbr[510:512]=b'\x55\xaa';f.write(mbr)
        b = bytearray(512);b[:3]=b'\xeb\x3c\x90';struct.pack_into('<H',b,11,512);b[13]=1;struct.pack_into('<H',b,14,1);b[16]=2;struct.pack_into('<H',b,17,roots);struct.pack_into('<I',b,32,total)
        if fat32:struct.pack_into('<II',b,36,fatsz,0);struct.pack_into('<I',b,44,2)
        else:struct.pack_into('<H',b,22,fatsz)
        b[510:512]=b'\x55\xaa';f.seek(512);f.write(b)
        data = (1+1+2*fatsz+root_secs)*512
        root = data if fat32 else (1+1+2*fatsz)*512
        first = 3 if fat32 else 2
        for copy in range(2):
            fat = bytearray(fatsz*512)
            fmt, end = ('<I',0x0fffffff) if fat32 else ('<H',0xffff)
            size=4 if fat32 else 2
            for cluster in [0,1]+([2] if fat32 else []):struct.pack_into(fmt,fat,cluster*size,end)
            for start in [first,first+4]:
                for n in range(4):struct.pack_into(fmt,fat,(start+n)*size,start+n+1 if n<3 else end)
            f.seek((1+1+copy*fatsz)*512);f.write(fat)
        for i,(name,value) in enumerate([('ROSIDE.PRP',{'version':1,'identityVersion':2,'ros':['humble'],'os':'Ubuntu test','model':'Pi test'}),('ROSIDE.NEW',{'armed':False})]):
            entry=bytearray(32);stem,ext=name.split('.');entry[:11]=stem.ljust(8).encode()+ext.encode();entry[11]=0x20;cluster=first+i*4;struct.pack_into('<H',entry,26,cluster);struct.pack_into('<I',entry,28,2048)
            f.seek(root+i*32);f.write(entry);f.seek(data+(cluster-2)*512);f.write(json.dumps(value).encode().ljust(2048,b' '))
    return path.stat().st_size


class ImageTests(unittest.TestCase):
    def test_fat_marker_only_overwrites_preallocated_bytes(self):
        for fat32 in (False, True):
            with self.subTest(fat32=fat32),tempfile.TemporaryDirectory() as folder:
                p=Path(folder)/'sd';disk_fixture(p,fat32);before=p.read_bytes()
                with p.open('r+b',buffering=0) as f:
                    fat=FatMarkers(f);blocks,size=fat.locate('ROSIDE.NEW');request={'armed':True,'hostname':'agv-002','id':'new'};fat.arm(request);self.assertEqual(fat.read_json('ROSIDE.NEW'),request)
                after=p.read_bytes();allowed={i for b in blocks for i in range(b,b+512)}
                self.assertTrue(all(i in allowed for i,(a,b) in enumerate(zip(before,after)) if a!=b));self.assertEqual(len(before),len(after))

    def test_raw_io_uses_sector_aligned_reads_on_windows_and_macos(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'sd';disk_fixture(p)
            class Aligned:
                def __init__(self,f):self.f=f
                def seek(self,n):
                    assert n%512==0;return self.f.seek(n)
                def read(self,n):
                    assert n%512==0;return self.f.read(n)
            with p.open('rb') as f:self.assertEqual(FatMarkers(Aligned(f)).read_json('ROSIDE.PRP')['identityVersion'],2)

    def test_backup_and_flash_are_local_and_verified_with_unique_request(self):
        with tempfile.TemporaryDirectory() as folder:
            r=Path(folder);source=r/'source';target=r/'target';size=disk_fixture(source);target.write_bytes(b'\0'*size)
            device={'id':'card','path':str(source),'size':size,'label':'Test SD','serial':'123','blocked':False}
            @contextlib.contextmanager
            def opener(selected,writing=False):
                with Path(selected['path']).open('r+b' if writing else 'rb',buffering=0) as f:yield f,selected
            jobs=helper.Jobs(r/'images',opener,lambda:[device]);before=hashlib.sha256(source.read_bytes()).hexdigest()
            result=jobs.backup(device,{'label':'AGV test','compress':True});meta=jobs.metadata(result['imageId']);self.assertEqual(meta['sourceRawSha256'],before);self.assertNotEqual(meta['rawSha256'],before);self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
            dest={**device,'path':str(target)};result=jobs.flash(dest,{'imageId':meta['id'],'hostname':'agv-002'});self.assertEqual(result['hostname'],'agv-002')
            with target.open('rb') as f:
                request=FatMarkers(f).read_json('ROSIDE.NEW');self.assertTrue(request['armed']);self.assertEqual(request['hostname'],'agv-002');self.assertEqual(request['robotKey'],result['robotKey']);self.assertEqual(len(result['robotKey']),64)
            self.assertNotEqual(hashlib.sha256(target.read_bytes()).hexdigest(),before)
            with gzip.open(jobs.image_path(meta),'rb') as f:self.assertEqual(hashlib.sha256(f.read()).hexdigest(),meta['rawSha256'])

    def test_corrupt_image_rejected_before_destination_open(self):
        with tempfile.TemporaryDirectory() as folder:
            r=Path(folder);p=r/'a';size=disk_fixture(p)
            @contextlib.contextmanager
            def opener(d,writing=False):
                if writing:raise AssertionError('Corrupt image must not open a destination')
                with p.open('rb') as f:yield f,d
            jobs=helper.Jobs(r/'images',opener);result=jobs.backup({'size':size},{'compress':False});meta=jobs.metadata(result['imageId']);image=jobs.image_path(meta)
            with image.open('r+b') as f:f.seek(100);f.write(b'changed')
            with self.assertRaisesRegex(ValueError,'เสีย|แก้ไข'):jobs.flash({}, {'imageId':meta['id'],'hostname':'test'})

    def test_system_disks_hotplug_and_wrong_confirmation_are_rejected(self):
        tree={'blockdevices':[{'name':'sda','path':'/dev/sda','type':'disk','rm':True,'tran':'usb','size':9999,'children':[{'path':'/dev/sda1','mountpoints':['/']}]}]}
        d=adapters.normalize_linux(tree)[0];self.assertTrue(d['blocked'])
        self.assertTrue(adapters.normalize_windows([{'Number':1,'BusType':'USB','Size':9999,'IsSystem':True}])[0]['blocked'])
        with patch.object(adapters,'inventory',return_value=[{**d,'serial':'new'}]):
            with self.assertRaises(ValueError):adapters.validate({**d,'serial':'old'})
        with tempfile.TemporaryDirectory() as folder,patch.object(adapters,'privileged',return_value=True):
            jobs=helper.Jobs(folder,discover=lambda:[d])
            with self.assertRaises(ValueError):jobs.start('backup',{'deviceId':d['id']})

    def test_mac_apfs_root_physical_store_is_protected(self):
        protected=adapters.mac_system_disks({'FilesystemType':'apfs','ParentWholeDisk':'disk3'}, {'Containers':[{'ContainerReference':'disk3','PhysicalStores':[{'DeviceIdentifier':'disk2s2'}]}]})
        self.assertIn('disk2',protected)
        with self.assertRaises(ValueError):adapters.mac_system_disks({'FilesystemType':'apfs','ParentWholeDisk':'disk3'}, {'Containers':[]})

    def test_single_job_and_cancel(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(adapters,'privileged',return_value=True):
            d={'id':'1','path':'disk','size':1024,'label':'SD','serial':'s','blocked':False}
            jobs=helper.Jobs(folder,discover=lambda:[d]);wait=threading.Event()
            def slow(*args):wait.wait(2);jobs.checkpoint()
            jobs.backup=slow
            body={'deviceId':'1','fingerprint':adapters.fingerprint(d)};jobs.start('backup',body)
            with self.assertRaisesRegex(ValueError,'หนึ่งงาน'):jobs.start('backup',body)
            jobs.cancel.set();wait.set()
            for _ in range(50):
                if jobs.snapshot()['state']!='running':break
                time.sleep(.01)
            self.assertEqual(jobs.snapshot()['state'],'cancelled')

    def test_prepare_is_inert_and_clone_resets_only_requested_identities(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(first_boot.os,'sync',return_value=None):
            root=Path(folder)
            for d in ['boot/firmware','etc/ssh','home/ubuntu/.ros2ide','home/ubuntu/.ssh','var/lib/tailscale','var/lib/dbus','opt/ros/humble']:(root/d).mkdir(parents=True,exist_ok=True)
            (root/'boot/firmware/config.txt').write_text('')
            (root/'etc/os-release').write_text('PRETTY_NAME="Ubuntu"')
            (root/'etc/hostname').write_text('old')
            (root/'etc/machine-id').write_text('old-id')
            config=root/'home/ubuntu/.ros2ide/config.json';config.write_text(json.dumps({'robot_key':'old-key','local_secret':'old-secret','cloud_url':'wss://example/ws/agent'}))
            (root/'etc/ssh/ssh_host_rsa_key').write_text('old private key');(root/'home/ubuntu/.ssh/id_rsa').write_text('old client key');(root/'var/lib/tailscale/tailscaled.state').write_text('old vpn')
            prepare.prepare('test firstboot',root);self.assertFalse(first_boot.reset_clone(root));self.assertEqual(json.loads(config.read_text())['robot_key'],'old-key')
            for name in ['user@.service.d','tailscaled.service.d','systemd-networkd.service.d']:
                self.assertIn('Requires=roside-clone-firstboot.service',(root/'etc/systemd/system'/name/'10-roside-clone.conf').read_text())
            marker=root/'boot/firmware/ROSIDE.NEW';marker.write_text(json.dumps({'armed':True,'id':'first','hostname':'agv-002','robotKey':'a'*64}).ljust(2048))
            self.assertTrue(first_boot.reset_clone(root));new=json.loads(config.read_text());self.assertNotEqual(new['robot_key'],'old-key');self.assertEqual(new['robot_key'],'a'*64);self.assertEqual((root/'etc/hostname').read_text(),'agv-002\n');self.assertFalse((root/'var/lib/tailscale/tailscaled.state').exists());self.assertFalse((root/'home/ubuntu/.ssh/id_rsa').exists());self.assertFalse(first_boot.reset_clone(root))
            marker.write_text(json.dumps({'armed':True,'id':'second','template':True}).ljust(2048));self.assertTrue(first_boot.reset_clone(root));self.assertNotEqual(json.loads(config.read_text())['robot_key'],new['robot_key']);self.assertTrue((root/'etc/hostname').read_text().startswith('robot-'))

    def test_source_without_native_agent_is_not_marked_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'boot/firmware').mkdir(parents=True);(root/'etc').mkdir();(root/'boot/firmware/config.txt').write_text('');(root/'etc/os-release').write_text('Ubuntu')
            with self.assertRaisesRegex(ValueError,'Online'):prepare.prepare('source',root)
            self.assertFalse((root/'boot/firmware/ROSIDE.PRP').exists())
            self.assertFalse((root/'etc/systemd/system/roside-clone-firstboot.service').exists())

    def test_invalid_clone_request_leaves_identity_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'boot').mkdir();(root/'boot/ROSIDE.NEW').write_text(json.dumps({'armed':True,'id':'x','hostname':'bad; command'}))
            with self.assertRaises(ValueError):first_boot.reset_clone(root)
            self.assertFalse((root/'var/lib/roside-clone').exists())


class HttpTests(unittest.TestCase):
    def test_helper_rejects_csrf_and_never_discloses_token(self):
        import urllib.request
        import urllib.error
        with tempfile.TemporaryDirectory() as folder:
            server=helper.ThreadingHTTPServer(('127.0.0.1',0),helper.Handler);server.daemon_threads=True
            server.jobs=helper.Jobs(folder);server.token='private-test-token';server.assets=BASE.parent/'public'
            t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
            base='http://127.0.0.1:'+str(server.server_port)
            try:
                with urllib.request.urlopen(base+'/') as r:
                    html=r.read().decode();self.assertIn('data-mode="helper"',html);self.assertNotIn(server.token,html);self.assertIsNone(r.headers.get('Access-Control-Allow-Origin'))
                with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(base+'/api/status')
                self.assertEqual(e.exception.code,401)
                request=urllib.request.Request(base+'/api/status',headers={'X-Image-Token':server.token})
                with urllib.request.urlopen(request) as r:self.assertEqual(json.load(r)['job']['state'],'idle')
                request=urllib.request.Request(base+'/api/cancel',data=b'{}',headers={'X-Image-Token':server.token,'Origin':'https://evil.example','Content-Type':'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(request)
                self.assertEqual(e.exception.code,403);self.assertFalse(server.jobs.cancel.is_set())
                request=urllib.request.Request(base+'/api/cancel',data=b'x'*9000,headers={'X-Image-Token':server.token,'Content-Type':'application/json'})
                with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(request)
                self.assertFalse(server.jobs.cancel.is_set())
            finally:server.shutdown();server.server_close();t.join()

if __name__=='__main__':unittest.main()
