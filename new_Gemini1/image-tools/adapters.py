"""OS-native external disk discovery. No arbitrary user-supplied device paths."""
import contextlib
import ctypes
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import subprocess


def command(args, timeout=30):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr.decode(errors='replace').strip()[:700] or 'คำสั่งระบบไม่สำเร็จ')
    return p.stdout


def powershell(script):
    import base64
    encoded = base64.b64encode(script.encode('utf-16le')).decode()
    raw = command(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
    return json.loads(raw.decode('utf-8-sig').strip() or 'null')


def normalize_linux(tree):
    items = []
    for d in tree.get('blockdevices', []):
        if d.get('type') != 'disk':
            continue
        descendants = []
        def visit(n):
            descendants.append(n)
            for child in n.get('children', []):visit(child)
        visit(d)
        mounts = [m for n in descendants for m in (n.get('mountpoints') or []) if m]
        system = int(d.get('log-sec') or 512) != 512 or any(m in ('/', '/boot', '/boot/firmware', '/usr', '/var', '/home', '[SWAP]') for m in mounts)
        external = bool(d.get('rm')) or d.get('tran') in ('usb', 'mmc')
        path = d.get('path', '')
        if not path.startswith('/dev/') or not external:
            continue
        items.append({'id': path, 'path': path, 'label': d.get('model') or d.get('name'), 'serial': d.get('serial') or '', 'size': int(d.get('size') or 0), 'blocked': bool(system or d.get('ro')), 'reason': 'ดิสก์ระบบ/อ่านอย่างเดียว/ขนาด sector ไม่ใช่ 512 byte' if system or d.get('ro') else '', 'mounted': mounts, 'children': [n['path'] for n in descendants[1:] if n.get('path')]})
    return items


def normalize_windows(disks):
    if isinstance(disks, dict):disks = [disks]
    return [{'id': str(d['Number']), 'path': '\\\\.\\PhysicalDrive'+str(d['Number']), 'label': d.get('FriendlyName') or 'SD / USB', 'serial': str(d.get('SerialNumber') or '').strip(), 'size': int(d['Size']), 'blocked': bool(d.get('IsBoot') or d.get('IsSystem') or d.get('IsReadOnly') or d.get('IsOffline') or int(d.get('LogicalSectorSize') or 512)!=512), 'reason': 'ดิสก์ระบบ/ออฟไลน์/อ่านอย่างเดียว/sector ไม่ใช่ 512 byte' if d.get('IsBoot') or d.get('IsSystem') or d.get('IsReadOnly') or d.get('IsOffline') or int(d.get('LogicalSectorSize') or 512)!=512 else '', 'mounted': [], 'number': int(d['Number'])} for d in (disks or []) if str(d.get('BusType')).lower() in ('usb', 'sd', 'mmc')]


def mac_system_disks(root, apfs):
    protected = set()
    for name in ('ParentWholeDisk', 'DeviceIdentifier'):
        value = str(root.get(name) or '')
        if value.startswith('disk'):
            protected.add(re.match(r'disk\d+', value).group(0))
    container = root.get('APFSContainerReference') or root.get('ParentWholeDisk')
    if root.get('FilesystemType') == 'apfs' or root.get('APFSContainerReference'):
        matched = False
        for item in apfs.get('Containers', []):
            if item.get('ContainerReference') == container:
                for store in item.get('PhysicalStores', []):
                    value = str(store.get('DeviceIdentifier') or '')
                    if value.startswith('disk'):
                        protected.add(re.match(r'disk\d+', value).group(0));matched = True
        if not matched:raise ValueError('ระบุดิสก์ระบบ APFS ไม่สำเร็จ จึงยังไม่อนุญาตให้เขียน SD')
    if not protected:raise ValueError('ระบุดิสก์ระบบไม่สำเร็จ')
    return protected


def inventory():
    system = platform.system()
    if system == 'Linux':
        return normalize_linux(json.loads(command(['lsblk', '-b', '-J', '-o', 'NAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,RM,RO,MOUNTPOINTS,LOG-SEC'])))
    if system == 'Windows':
        return normalize_windows(powershell("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-Disk | Select-Object Number,FriendlyName,SerialNumber,Size,LogicalSectorSize,IsBoot,IsSystem,IsReadOnly,IsOffline,@{N='BusType';E={$_.BusType.ToString()}}) | ConvertTo-Json -Compress"))
    if system == 'Darwin':
        root = plistlib.loads(command(['diskutil', 'info', '-plist', '/']))
        apfs = plistlib.loads(command(['diskutil', 'apfs', 'list', '-plist'])) if root.get('FilesystemType') == 'apfs' or root.get('APFSContainerReference') else {}
        protected = mac_system_disks(root, apfs)
        listing = plistlib.loads(command(['diskutil', 'list', '-plist', 'external', 'physical']))
        result = []
        for name in listing.get('WholeDisks', []):
            if not name.startswith('disk') or not name[4:].isdigit():continue
            d = plistlib.loads(command(['diskutil', 'info', '-plist', name]))
            if d.get('Internal') or d.get('Virtual') or not d.get('Whole'):continue
            result.append({'id': name, 'path': '/dev/r'+name, 'label': d.get('MediaName') or name, 'serial': str(d.get('DiskUUID') or d.get('DeviceTreePath') or ''), 'size': int(d.get('TotalSize') or 0), 'blocked': bool(name in protected or d.get('SystemImage') or not d.get('Writable', True) or int(d.get('DeviceBlockSize') or 512)!=512), 'reason': 'ดิสก์ระบบ/อ่านอย่างเดียว/ขนาด sector ไม่ใช่ 512 byte' if name in protected or d.get('SystemImage') or not d.get('Writable', True) or int(d.get('DeviceBlockSize') or 512)!=512 else '', 'mounted': []})
        return result
    raise RuntimeError('รองรับ Ubuntu/Linux, Windows และ macOS')


def fingerprint(d):
    return [d['id'], d['path'], d['size'], d.get('serial', ''), d['label']]


def validate(selected):
    current = next((d for d in inventory() if d['id'] == selected.get('id')), None)
    if not current or fingerprint(current) != fingerprint(selected):
        raise ValueError('การ์ดถูกเปลี่ยนหรือถอดแล้ว กดค้นหาการ์ดและเลือกใหม่')
    if current['blocked'] or current['size'] <= 0:
        raise ValueError('ห้ามอ่าน/เขียนดิสก์ระบบหรือดิสก์ที่ถูกป้องกัน')
    return current


def unmount(d):
    d = validate(d)
    system = platform.system()
    if system == 'Linux':
        for child in reversed(d.get('children', [])):
            p = subprocess.run(['findmnt', '-n', '-S', child], capture_output=True)
            if p.returncode == 0:command(['umount', child])
        if validate(d).get('mounted'):
            raise ValueError('ยังมีพาร์ทิชันใช้งานอยู่ ปิดโปรแกรมที่เปิดการ์ดก่อน')
    elif system == 'Darwin':
        command(['diskutil', 'unmountDisk', '/dev/'+d['id']])
    # Windows locks all current volumes for the entire operation below.
    return d


def privileged():
    return bool(ctypes.windll.shell32.IsUserAnAdmin()) if platform.system() == 'Windows' else os.geteuid() == 0


@contextlib.contextmanager
def open_disk(selected, writing=False):
    d = validate(selected)
    unmount(d)
    d = validate(d)
    handles = []
    if platform.system() == 'Windows':
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.DeviceIoControl.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        invalid = ctypes.c_void_p(-1).value
        def opened(name, access):
            h = kernel.CreateFileW(name, access, 3, None, 3, 0, None)
            if h in (None, invalid):raise ctypes.WinError(ctypes.get_last_error())
            return h
        try:
            volumes = powershell(f"@(Get-Partition -DiskNumber {d['number']} | ForEach-Object {{$_.AccessPaths}} | Where-Object {{$_ -like '\\\\?\\Volume*'}}) | ConvertTo-Json -Compress") or []
            if isinstance(volumes, str):volumes = [volumes]
            for volume in volumes:
                h = opened(volume.rstrip('\\'), 0xC0000000)
                handles.append(h)
                returned = ctypes.c_uint32()
                for ioctl in (0x00090018, 0x00090020):  # LOCK_VOLUME, DISMOUNT_VOLUME
                    if not kernel.DeviceIoControl(h, ioctl, None, 0, None, 0, ctypes.byref(returned), None):
                        raise RuntimeError('ล็อก SD card ไม่ได้ ปิด Explorer/โปรแกรมที่ใช้งานการ์ดก่อน')
            raw = opened(d['path'], 0xC0000000 if writing else 0x80000000)
            fd = msvcrt.open_osfhandle(raw, os.O_BINARY | (os.O_RDWR if writing else os.O_RDONLY))
            with os.fdopen(fd, 'r+b' if writing else 'rb', buffering=0) as stream:
                yield stream, d
        finally:
            for h in handles:kernel.CloseHandle(h)
    else:
        if platform.system() == 'Linux':
            fd=os.open(d['path'], (os.O_RDWR if writing else os.O_RDONLY) | os.O_EXCL | getattr(os,'O_NOFOLLOW',0))
            with os.fdopen(fd,'r+b' if writing else 'rb',buffering=0) as stream:yield stream,d
        else:
            with open(d['path'], 'r+b' if writing else 'rb', buffering=0) as stream:yield stream,d
