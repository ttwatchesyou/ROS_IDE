import contextlib
import hashlib
import io
import json
import lzma
import shutil
import struct
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'image-tools'))
import environment as env
from fat_seed import SeedVolume
from passwords import password_hash
from test_image_tools import disk_fixture
from helper import Jobs

class EnvironmentTests(unittest.TestCase):
    def settings(self,**kw):return env.validate_settings(dict(hostname='agv-002',username='roside',password='safe-password-123',domainId=10,installAgent=True,cloudUrl='https://roside.example:8443',**kw))
    def test_hash_vectors(self):
        import crypt
        for password in ['safe-password-123','ภาษาไทย123456','test$symbols&123']:
            result=password_hash(password,salt='testSalt123',rounds=5000)
            self.assertEqual(result,crypt.crypt(password,result))
    def test_profile_and_release(self):
        manifest='a'*64+' *ubuntu-24.04.4-preinstalled-server-arm64+raspi.img.xz\n'+'b'*64+' *ubuntu-24.04.5-preinstalled-server-arm64+raspi.img.xz\n'+'c'*64+' *ubuntu-26.04.9-preinstalled-server-arm64+raspi.img.xz'
        self.assertIn('24.04.5',env.choose_release(manifest)['file'])
        for package in ['net-tools','python3-venv','ros-jazzy-rviz2','ros-jazzy-navigation2','ros-dev-tools']:
            self.assertIn(package,env.PROFILE['packages'])
    def test_seed_is_fresh_and_password_hashed(self):
        settings=self.settings();first=env.cloud_seed(settings,'a'*64);second=env.cloud_seed(settings,'b'*64)
        self.assertNotEqual(first['meta-data'],second['meta-data'])
        data=json.loads(first['user-data'].decode().split('\n',1)[1]);self.assertTrue(data['users'][0]['passwd'].startswith('$6$'))
        self.assertNotIn(settings['password'],first['user-data'].decode())
        config=json.loads(data['write_files'][1]['content']);self.assertEqual(config['robotKey'],'a'*64)
        self.assertNotIn('password',config);self.assertEqual(data['runcmd'],[['python3','/opt/roside-env/install_env.py']])
        for kw in [{'hostname':'../../etc'},{'password':'short'},{'domainId':True},{'cloudUrl':'https://user:pass@example.test/'}]:
            values=dict(settings);values.update(kw)
            with self.assertRaises(ValueError):env.validate_settings(values)
    def test_seed_edits_fat16_and_32_and_preserves_other_files(self):
        for fat32 in (False,True):
            with self.subTest(fat32=fat32),tempfile.TemporaryDirectory() as folder:
                p=Path(folder)/'image';disk_fixture(p,fat32)
                with p.open('r+b') as f:
                    volume=SeedVolume(f);old=volume.read_file('ROSIDE.PRP')
                    for name,data in env.cloud_seed(self.settings(),'a'*64).items():volume.write_file(name,data);self.assertEqual(volume.read_file(name),data)
                    for size in [20000,32]:volume.write_file('user-data',b'x'*size);self.assertEqual(volume.read_file('user-data'),b'x'*size)
                    self.assertEqual(volume.read_file('ROSIDE.PRP'),old)
                    self.assertEqual(volume.read(volume.fat,volume.fat_size),volume.read(volume.fat+volume.fat_size,volume.fat_size))
    @unittest.skipUnless(shutil.which('mkfs.fat') and shutil.which('fsck.fat'),'dosfstools unavailable')
    def test_seed_is_accepted_by_independent_fat_checker(self):
        for bits,mb in [(16,32),(32,64)]:
            with self.subTest(bits=bits),tempfile.TemporaryDirectory() as folder:
                boot=Path(folder)/'boot';boot.write_bytes(b'');
                with boot.open('wb') as f:f.truncate(mb*1024*1024)
                subprocess.run(['mkfs.fat','-F',str(bits),str(boot)],check=True,stdout=subprocess.DEVNULL)
                image=Path(folder)/'image';mbr=bytearray(512);mbr[450]=0x0c if bits==32 else 0x0e;struct.pack_into('<II',mbr,454,1,mb*2048);mbr[510:512]=b'\x55\xaa'
                with image.open('wb') as f:f.write(mbr);f.write(boot.read_bytes())
                with image.open('r+b') as f:
                    volume=SeedVolume(f)
                    for name,data in env.cloud_seed(self.settings(),'a'*64).items():volume.write_file(name,data)
                    volume.write_file('user-data',b'#cloud-config\n'+b' '*30000)
                boot.write_bytes(image.read_bytes()[512:]);check=subprocess.run(['fsck.fat','-n',str(boot)],capture_output=True,text=True)
                self.assertEqual(check.returncode,0,check.stdout+check.stderr)
    def test_flash_temp_file_and_cache_immutable(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder);base=output/'base';disk_fixture(base);raw=base.read_bytes();compressed=lzma.compress(raw);self.assertEqual(len(raw),self._size(output,compressed))
            target=output/'target';target.write_bytes(b'\0'*len(raw))
            @contextlib.contextmanager
            def opener(device,write):
                with target.open('r+b',buffering=0) as f:yield f,device
            jobs=Jobs(output,discover=lambda:[],opener=opener);builder=env.Environment(jobs)
            filename='ubuntu-24.04.5-preinstalled-server-arm64+raspi.img.xz';(builder.cache/filename).write_bytes(compressed)
            meta=dict(file=filename,fileBytes=len(compressed),rawBytes=len(raw),sha256=hashlib.sha256(compressed).hexdigest());(builder.cache/'base.json').write_text(json.dumps(meta))
            with patch.dict(env.PROFILE,minimumCardBytes=512):result=builder.flash({'size':len(raw)},self.settings())
            self.assertEqual(result['kind'],'flash');self.assertEqual((builder.cache/filename).read_bytes(),compressed);self.assertFalse(list(builder.cache.glob('seed-*')))
            with target.open('r+b') as f:
                seed=json.loads(SeedVolume(f).read_file('user-data').decode().split('\n',1)[1]);config=json.loads(seed['write_files'][1]['content']);self.assertEqual(config['robotKey'],result['robotKey'])
            # A corrupt base must fail before a target can be opened/written.
            before=target.read_bytes();(builder.cache/filename).write_bytes(b'x'*len(compressed))
            with self.assertRaisesRegex(ValueError,'เสีย'):builder.flash({'size':len(raw)},self.settings())
            self.assertEqual(target.read_bytes(),before)
    def test_download_checks_official_hash_and_reuses_cached_image(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder);base=output/'base';disk_fixture(base);data=lzma.compress(base.read_bytes());digest=hashlib.sha256(data).hexdigest()
            manifest=(digest+' *ubuntu-24.04.5-preinstalled-server-arm64+raspi.img.xz\n').encode();calls=[]
            class Response(io.BytesIO):
                def __init__(self,data,url):super().__init__(data);self.url=url;self.headers={'Content-Length':str(len(data))}
            def fetch(request,**kw):
                url=request.full_url;calls.append(url);return Response(manifest if url==env.MANIFEST else data,url)
            builder=env.Environment(Jobs(output))
            with patch('environment.urllib.request.urlopen',side_effect=fetch):
                result=builder.download();self.assertEqual(result['image']['sha256'],digest)
                builder.download();self.assertEqual(len(calls),3) # manifest only on reuse
            self.assertEqual(len(list(builder.cache.glob('*.xz'))),1)
            self.assertFalse(list(builder.cache.glob('*.partial')))
    def _size(self,folder,data):
        p=folder/'size.xz';p.write_bytes(data);return env.xz_size(p)
