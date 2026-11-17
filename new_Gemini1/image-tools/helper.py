#!/usr/bin/env python3
"""ROSIDE PC Image Helper. All block data stays on this PC; no cloud client."""
import argparse
import base64
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import threading
import time
import uuid
import webbrowser

import adapters
from fat_marker import FatMarkers

CHUNK = 4*1024*1024


def patch_chunk(data, offset, patches):
    output = None
    for start, content in patches:
        a, b = max(start, offset), min(start+len(content), offset+len(data))
        if a < b:
            if output is None:output = bytearray(data)
            output[a-offset:b-offset] = content[a-start:b-start]
    return bytes(output) if output is not None else data


def marker_patches(stream, request):
    fat = FatMarkers(stream)
    if fat.read_json('ROSIDE.PRP').get('identityVersion') != 2:
        raise ValueError('Image ยังไม่ได้เตรียมตัวตนสำหรับหุ่นใหม่')
    marker = fat.read_json('ROSIDE.NEW')
    if marker.get('armed') is True and marker.get('template') is not True:
        raise ValueError('ต้นแบบมีการตั้งค่าหุ่นใหม่ค้างอยู่')
    blocks, size = fat.locate('ROSIDE.NEW')
    content = json.dumps(request, ensure_ascii=False).encode()
    if len(content) > size:raise ValueError('ข้อมูลหุ่นใหม่ยาวเกินไป')
    content = content.ljust(size, b' ')
    result = []
    for start in blocks:
        if not content:break
        part, content = content[:fat.cluster_size], content[fat.cluster_size:]
        result.append((start, part))
    if content:raise ValueError('พื้นที่ตั้งค่าหุ่นใหม่ไม่ครบ')
    stream.seek(0)
    return result


class Jobs:
    def __init__(self, output, opener=adapters.open_disk, discover=adapters.inventory):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.opener, self.discover = opener, discover
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.state = {'id': None, 'state': 'idle', 'phase': 'idle', 'done': 0, 'total': 0}
        self.last_update = 0

    def snapshot(self):
        with self.lock:return dict(self.state)

    def update(self, force=False, **values):
        now = time.monotonic()
        if not force and now-self.last_update < .5:return
        self.last_update = now
        with self.lock:self.state.update(values)

    def checkpoint(self):
        if self.cancel.is_set():raise InterruptedError('ยกเลิกงานแล้ว หากเป็นการ Flash ห้ามนำการ์ดไปบูตจนทำใหม่สำเร็จ')

    def images(self):
        result = []
        for p in sorted(self.output.glob('*.json'), key=lambda p:p.stat().st_mtime, reverse=True)[:200]:
            try:
                if p.is_symlink() or p.stat().st_size>65536:continue
                value = json.loads(p.read_text())
                if re.fullmatch(r'[a-f0-9]{32}', value['id']) and self.image_path(value).is_file():result.append(value)
            except (ValueError, KeyError, OSError):continue
        return result

    def image_path(self, meta):
        if not re.fullmatch(r'[a-f0-9]{32}\.img(?:\.gz)?', meta.get('file', '')):
            raise ValueError('ชื่อไฟล์ Image ไม่ถูกต้อง')
        p = self.output/meta['file']
        if p.is_symlink() or p.resolve().parent != self.output:raise ValueError('Image path is not allowed')
        return p

    def metadata(self, image_id):
        if not re.fullmatch(r'[a-f0-9]{32}', str(image_id)):raise ValueError('Image ID ไม่ถูกต้อง')
        p = self.output/(image_id+'.json')
        if p.is_symlink() or p.stat().st_size>65536:raise ValueError('Image metadata path is not allowed')
        value = json.loads(p.read_text())
        if value['id'] != image_id:raise ValueError('Image metadata ไม่ตรงกัน')
        return value

    def start(self, operation, body):
        if operation not in ('backup', 'flash'):raise ValueError('Unknown operation')
        if not adapters.privileged():raise ValueError('เปิด Helper ด้วยสิทธิ์ Administrator / sudo ก่อน')
        device = next((d for d in self.discover() if d['id'] == body.get('deviceId')), None)
        if not device or device['blocked']:raise ValueError('เลือก SD card ภายนอกที่ไม่ใช่ดิสก์ระบบ')
        if body.get('fingerprint') != adapters.fingerprint(device):raise ValueError('การ์ดเปลี่ยนแล้ว กดค้นหาใหม่')
        if operation == 'flash':
            if body.get('confirm') != device['id']:raise ValueError('พิมพ์รหัสดิสก์ปลายทางเพื่อยืนยันการลบข้อมูล')
            if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', body.get('hostname', '')):raise ValueError('ชื่อหุ่นใหม่ใช้ a-z, 0-9 และ - ความยาว 1–63 ตัว')
            meta = self.metadata(body.get('imageId'))
            if device['size'] < meta['rawBytes']:raise ValueError('SD ปลายทางเล็กกว่า Image ต้องใช้การ์ดขนาดจริงเท่ากันหรือใหญ่กว่า')
        with self.lock:
            if self.state['state'] == 'running':raise ValueError('เครื่องนี้ทำ Image ได้ครั้งละหนึ่งงาน รอหรือยกเลิกงานเดิมก่อน')
            self.cancel.clear()
            self.state = {'id': uuid.uuid4().hex, 'state': 'running', 'operation': operation, 'phase': 'preflight', 'done': 0, 'total': device['size'], 'startedAt': time.time(), 'device': device['label'], 'error': ''}
        threading.Thread(target=self.worker, args=(operation, device, body), daemon=True).start()
        return self.snapshot()

    def worker(self, operation, device, body):
        try:
            if operation == 'backup':result = self.backup(device, body)
            else:result = self.flash(device, body)
            self.update(force=True, state='complete', phase='complete', result=result)
        except InterruptedError as error:self.update(force=True, state='cancelled', error=str(error))
        except Exception as error:self.update(force=True, state='failed', error=str(error)[:1000])

    def finish_owner(self, path):
        if path.is_symlink():raise ValueError('Image file must not be a symbolic link')
        if os.name != 'nt':
            fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            try:
                info = self.output.stat()
                os.fchown(fd, info.st_uid, info.st_gid)
                os.fchmod(fd, 0o600)
            finally:os.close(fd)

    def backup(self, device, body):
        image_id = uuid.uuid4().hex
        compressed = body.get('compress', True) is not False
        filename = image_id+('.img.gz' if compressed else '.img')
        target = self.output/filename
        partial = target.with_suffix(target.suffix+'.partial')
        raw_hash, source_hash = hashlib.sha256(), hashlib.sha256()
        try:
            with self.opener(device, False) as (source, current):
                fat = FatMarkers(source)
                prepared = fat.read_json('ROSIDE.PRP')
                if prepared.get('identityVersion') != 2 or fat.read_json('ROSIDE.NEW').get('armed'):
                    raise ValueError('ต้องเตรียมหุ่นต้นแบบและปิดเครื่องก่อนนำการ์ดมาสร้าง Image')
                patches = marker_patches(source, {'version':1,'armed':True,'template':True,'id':uuid.uuid4().hex})
                if shutil.disk_usage(self.output).free < current['size']+256*1024*1024:
                    raise ValueError('พื้นที่คอมไม่พอ ต้องมีพื้นที่ว่างอย่างน้อยเท่าขนาด SD ต้นแบบ + 256 MB')
                self.update(force=True, phase='reading', done=0, total=current['size'])
                with partial.open('xb') as raw_out:
                    os.chmod(partial, 0o600)
                    sink = gzip.GzipFile(fileobj=raw_out, mode='wb', compresslevel=1) if compressed else raw_out
                    done = 0
                    try:
                        while done < current['size']:
                            self.checkpoint()
                            data = source.read(min(CHUNK, current['size']-done))
                            if not data:raise IOError('อ่าน SD ไม่ครบ Image ยังไม่สมบูรณ์')
                            source_hash.update(data);data=patch_chunk(data,done,patches);raw_hash.update(data);sink.write(data);done += len(data)
                            self.update(done=done)
                    finally:
                        if compressed:sink.close()
                    raw_out.flush();os.fsync(raw_out.fileno())
            self.update(force=True, phase='checking', done=0, total=partial.stat().st_size)
            file_hash = self.hash_file(partial)
            os.replace(partial, target)
            meta = {'version': 1, 'id': image_id, 'file': filename, 'label': str(body.get('label') or 'Robot image')[:100], 'rawBytes': current['size'], 'fileBytes': target.stat().st_size, 'rawSha256': raw_hash.hexdigest(), 'sourceRawSha256': source_hash.hexdigest(), 'fileSha256': file_hash, 'createdAt': time.time(), 'template': prepared, 'containsSourceCredentials': True}
            metadata = self.output/(image_id+'.json')
            pending = self.output/(image_id+'.json.pending')
            with pending.open('x', encoding='utf8') as handle:
                json.dump(meta, handle, ensure_ascii=False, indent=2);handle.flush();os.fsync(handle.fileno())
            os.replace(pending, metadata)
            self.finish_owner(target);self.finish_owner(metadata)
            return {'imageId': image_id, 'file': filename, 'folder': str(self.output)}
        finally:
            if partial.exists():partial.unlink()

    def hash_file(self, path):
        h, done = hashlib.sha256(), 0
        with path.open('rb') as f:
            while True:
                self.checkpoint();data = f.read(CHUNK)
                if not data:break
                h.update(data);done += len(data);self.update(done=done)
        return h.hexdigest()

    def flash(self, device, body):
        meta = self.metadata(body['imageId']);path = self.image_path(meta)
        if path.stat().st_size != meta['fileBytes']:raise ValueError('ขนาดไฟล์ Image เปลี่ยนไป')
        self.update(force=True, phase='checking', done=0, total=meta['fileBytes'])
        if self.hash_file(path) != meta['fileSha256']:raise ValueError('ไฟล์ Image เสียหรือถูกแก้ไข ยังไม่เขียน SD')
        request = {'version': 1, 'armed': True, 'id': uuid.uuid4().hex, 'hostname': body['hostname'], 'robotKey': secrets.token_hex(32)}
        factory = gzip.open if path.suffix == '.gz' else open
        with factory(path, 'rb') as source:
            patches = marker_patches(source, request)
            with self.opener(device, True) as (dest, current):
                if current['size'] < meta['rawBytes']:raise ValueError('การ์ดปลายทางเล็กเกินไป')
                raw_hash, patched_hash, done = hashlib.sha256(), hashlib.sha256(), 0
                self.update(force=True, phase='writing', done=0, total=meta['rawBytes'])
                while done < meta['rawBytes']:
                    self.checkpoint();data = source.read(min(CHUNK, meta['rawBytes']-done))
                    if not data:raise IOError('Image อ่านไม่ครบ')
                    raw_hash.update(data);data = patch_chunk(data, done, patches);patched_hash.update(data)
                    view = memoryview(data)
                    while view:
                        n = dest.write(view)
                        if not n:raise IOError('SD card เขียนข้อมูลไม่ครบ')
                        view = view[n:]
                    done += len(data);self.update(done=done)
                if raw_hash.hexdigest() != meta['rawSha256']:raise ValueError('ข้อมูลต้นฉบับใน Image ไม่ตรงกับ checksum')
                dest.flush();os.fsync(dest.fileno())
                self.update(force=True, phase='verifying', done=0, total=meta['rawBytes'])
                dest.seek(0);verify, done = hashlib.sha256(), 0
                while done < meta['rawBytes']:
                    self.checkpoint();data = dest.read(min(CHUNK, meta['rawBytes']-done))
                    if not data:raise IOError('อ่าน SD กลับมาตรวจไม่ครบ')
                    verify.update(data);done += len(data);self.update(done=done)
                if verify.hexdigest() != patched_hash.hexdigest():raise IOError('ตรวจข้อมูล SD หลังเขียนไม่ผ่าน ห้ามนำไปใช้งาน')
                if FatMarkers(dest).read_json('ROSIDE.NEW') != request:raise IOError('ตรวจคำขอแยกตัวตนหุ่นใหม่ไม่ผ่าน')
        return {'hostname': body['hostname'], 'robotKey': request['robotKey'], 'next': 'ถอด SD อย่างปลอดภัย เปิด Pi รุ่นที่รองรับ รอรีบูตครั้งแรก แล้วอ่าน Robot Key ใหม่จาก /boot/firmware/ROSIDE.OK หรือ /boot/ROSIDE.OK เพื่อลงทะเบียนใน ROSIDE และลงชื่อเข้า Tailscale ใหม่'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):pass  # Never log bearer tokens or large bodies.

    def send_json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status);self.write_headers('application/json', len(data));self.end_headers();self.wfile.write(data)

    def write_headers(self, kind, size):
        self.send_header('Content-Type', kind);self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-store');self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY');self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")

    def allowed(self, auth=True):
        origin = 'http://127.0.0.1:'+str(self.server.server_port)
        if self.headers.get('Host') != origin[7:] or self.headers.get('Origin') not in (None, origin):
            self.send_json({'ok': False, 'error': 'Local origin required'}, 403);return False
        if auth and not secrets.compare_digest(self.headers.get('X-Image-Token', ''), self.server.token):
            self.send_json({'ok': False, 'error': 'เปิด URL จากหน้าต่าง Helper บนคอมเครื่องนี้อีกครั้ง'}, 401);return False
        return True

    def do_GET(self):
        if self.path.startswith('/api/'):
            if not self.allowed():return
            try:
                if self.path == '/api/info':value = {'os': platform.system(), 'privileged': adapters.privileged(), 'folder': str(self.server.jobs.output), 'traffic': 'local-only', 'identityVersion': 2}
                elif self.path == '/api/disks':value = {'devices': self.server.jobs.discover()}
                elif self.path == '/api/images':value = {'images': self.server.jobs.images()}
                elif self.path == '/api/status':value = {'job': self.server.jobs.snapshot()}
                elif self.path == '/api/environment':value = {'profile': self.server.environment.profile(), 'cached': self.server.environment.cached()}
                else:self.send_json({'ok': False, 'error': 'Not found'}, 404);return
                self.send_json({'ok': True, **value})
            except Exception as error:self.send_json({'ok': False, 'error': str(error)}, 400)
            return
        if not self.allowed(False):return
        name = self.path.split('?', 1)[0].lstrip('/') or 'image-tools.html'
        if name not in ('image-tools.html', 'image-tools.js', 'image-tools.css'):
            self.send_json({'ok': False, 'error': 'Not found'}, 404);return
        data = (self.server.assets/name).read_bytes()
        if name.endswith('.html'):data = data.replace(b'data-mode="cloud"', b'data-mode="helper"')
        kind = 'text/html; charset=utf-8' if name.endswith('.html') else 'text/javascript; charset=utf-8' if name.endswith('.js') else 'text/css; charset=utf-8'
        self.send_response(200);self.write_headers(kind, len(data));self.end_headers();self.wfile.write(data)

    def do_POST(self):
        if not self.allowed():return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192 or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':raise ValueError('JSON metadata only; file uploads are not accepted')
            body = json.loads(self.rfile.read(size))
            if self.path in ('/api/environment/download','/api/environment/flash'):
                value={'job':self.server.environment.start(self.path.rsplit('/',1)[1],body)}
            elif self.path in ('/api/backup', '/api/flash'):
                value = {'job': self.server.jobs.start(self.path.rsplit('/', 1)[1], body)}
            elif self.path == '/api/cancel':
                self.server.jobs.cancel.set();value = {'job': self.server.jobs.snapshot()}
            else:self.send_json({'ok': False, 'error': 'Not found'}, 404);return
            self.send_json({'ok': True, **value})
        except Exception as error:self.send_json({'ok': False, 'error': str(error)}, 400)

    def do_OPTIONS(self):self.send_json({'ok': False, 'error': 'Cross-origin access is disabled'}, 403)


def user_home():
    if os.name != 'nt' and os.environ.get('SUDO_USER'):
        import pwd
        return Path(pwd.getpwnam(os.environ['SUDO_USER']).pw_dir)
    return Path.home()


def main():
    parser = argparse.ArgumentParser(description='ROSIDE Image Helper — images stay on this computer')
    parser.add_argument('--output', type=Path, default=user_home()/'ROSIDEImages')
    parser.add_argument('--port', type=int, default=3088)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:raise SystemExit('Invalid local port')
    fresh = not args.output.exists()
    jobs = Jobs(args.output)
    if fresh and os.name != 'nt' and os.environ.get('SUDO_USER'):
        import pwd
        owner = pwd.getpwnam(os.environ['SUDO_USER']);os.chown(jobs.output, owner.pw_uid, owner.pw_gid)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.token, server.jobs = secrets.token_urlsafe(32), jobs
    from environment import Environment
    server.environment=Environment(jobs)
    server.assets = Path(__file__).resolve().parent/'public'
    if not server.assets.exists():server.assets = Path(__file__).resolve().parent.parent/'public'
    url = f'http://127.0.0.1:{args.port}/#token={server.token}'
    print('ROSIDE Image Helper (Ubuntu/Linux, Windows, macOS)\n'+url, flush=True)
    print('Image folder: '+str(jobs.output)+'\nKeep this window open. No image data goes to ROSIDE Cloud.', flush=True)
    if not adapters.privileged():print('เปิดโปรแกรมใหม่ด้วย Administrator / sudo เพื่ออ่านเขียน SD card', flush=True)
    if not args.no_browser:
        if os.name != 'nt' and os.environ.get('SUDO_USER'):
            import subprocess
            subprocess.Popen(['sudo', '-u', os.environ['SUDO_USER'], 'open' if platform.system() == 'Darwin' else 'xdg-open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:jobs.cancel.set()
    finally:server.server_close()


if __name__ == '__main__':main()
