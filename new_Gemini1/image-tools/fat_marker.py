"""Read/overwrite preallocated ROSIDE markers on a FAT16/32 boot partition.
Never allocates clusters, edits partition tables or resizes a filesystem.
"""
import json
import struct

MARKER_SIZE = 2048


class FatMarkers:
    def __init__(self, disk):
        self.disk = disk
        sector = self.read(0, 512)
        starts = []
        if sector[510:512] == b'\x55\xaa':
            for i in range(4):
                entry = sector[446+i*16:462+i*16]
                if entry[4] in (0x01, 0x04, 0x06, 0x0b, 0x0c, 0x0e):
                    starts.append(struct.unpack_from('<I', entry, 8)[0]*512)
                if entry[4] == 0xee:
                    hdr = self.read(512, 512)
                    if hdr[:8] != b'EFI PART':
                        continue
                    lba, count, size = struct.unpack_from('<QII', hdr, 72)
                    if not 128 <= size <= 4096 or count > 4096:
                        raise ValueError('Unsupported GPT partition table')
                    for n in range(min(count, 128)):
                        g = self.read(lba*512+n*size, size)
                        if any(g[:16]):
                            starts.append(struct.unpack_from('<Q', g, 32)[0]*512)
        for offset in starts:
            b = self.read(offset, 512)
            bps = struct.unpack_from('<H', b, 11)[0]
            spc = b[13]
            reserved = struct.unpack_from('<H', b, 14)[0]
            roots = struct.unpack_from('<H', b, 17)[0]
            fatsz = struct.unpack_from('<H', b, 22)[0] or struct.unpack_from('<I', b, 36)[0]
            total = struct.unpack_from('<H', b, 19)[0] or struct.unpack_from('<I', b, 32)[0]
            if b[510:512] != b'\x55\xaa' or bps != 512 or not spc or spc & (spc-1) or spc > 128 or not reserved or b[16] not in (1, 2) or not fatsz:
                continue
            root_sectors = (roots*32+bps-1)//bps
            data_sectors = total-reserved-b[16]*fatsz-root_sectors
            clusters = data_sectors//spc
            if clusters < 4085:
                continue  # FAT12 is not a supported Pi boot partition.
            self.base, self.bps, self.cluster_size = offset, bps, bps*spc
            self.fat = offset+reserved*bps
            self.bits = 16 if clusters < 65525 else 32
            self.root_start = offset+(reserved+b[16]*fatsz)*bps
            self.root_size = roots*32
            self.root_cluster = struct.unpack_from('<I', b, 44)[0] if self.bits == 32 else None
            self.data_start = self.root_start+root_sectors*bps
            self.clusters = clusters
            return
        raise ValueError('ไม่พบพาร์ทิชัน Boot แบบ FAT16/FAT32 ที่รองรับ')

    def read(self, offset, size):
        # Windows PhysicalDrive and macOS rdisk require sector-aligned reads.
        start = offset//512*512
        length = ((offset+size+511)//512)*512-start
        self.disk.seek(start)
        data = self.disk.read(length)
        if len(data) < offset-start+size:
            raise ValueError('อ่านข้อมูลการ์ดไม่ครบ')
        return data[offset-start:offset-start+size]

    def chain(self, cluster):
        seen = set()
        while 2 <= cluster < self.clusters+2:
            if cluster in seen or len(seen) > 65536:
                raise ValueError('FAT cluster chain is invalid')
            seen.add(cluster)
            yield self.data_start+(cluster-2)*self.cluster_size
            value = int.from_bytes(self.read(self.fat+cluster*(self.bits//8), self.bits//8), 'little')
            cluster = value & (0xffff if self.bits == 16 else 0x0fffffff)
            if cluster >= (0xfff8 if self.bits == 16 else 0x0ffffff8):
                return
        raise ValueError('FAT cluster is outside the volume')

    def locate(self, name):
        stem, suffix = name.upper().split('.')
        target = stem.ljust(8).encode()+suffix.ljust(3).encode()
        chunks = ((self.root_start, self.root_size),) if self.bits == 16 else ((p, self.cluster_size) for p in self.chain(self.root_cluster))
        for offset, size in chunks:
            entries = self.read(offset, size)
            for i in range(0, len(entries), 32):
                e = entries[i:i+32]
                if e[0] == 0:
                    raise ValueError('ยังไม่ได้เตรียมหุ่นต้นแบบ: ไม่พบ '+name)
                if e[0] == 0xe5 or e[11] & 0x18 or e[11] == 0x0f:
                    continue
                if e[:11] == target:
                    cluster = int.from_bytes(e[26:28], 'little')
                    if self.bits == 32:
                        cluster |= int.from_bytes(e[20:22], 'little') << 16
                    size = int.from_bytes(e[28:32], 'little')
                    if size != MARKER_SIZE:
                        raise ValueError('ROSIDE marker size is invalid; prepare the source robot again')
                    return list(self.chain(cluster)), size
        raise ValueError('ยังไม่ได้เตรียมหุ่นต้นแบบ: ไม่พบ '+name)

    def read_json(self, name):
        blocks, size = self.locate(name)
        data = b''.join(self.read(p, self.cluster_size) for p in blocks)[:size]
        return json.loads(data.rstrip(b' \x00').decode('utf-8'))

    def arm(self, request):
        blocks, size = self.locate('ROSIDE.NEW')
        data = json.dumps(request, ensure_ascii=False).encode()
        if len(data) > size:
            raise ValueError('Clone request is too large')
        padded = data.ljust(size, b' ')
        written = 0
        for offset in blocks:
            n = min(self.cluster_size, size-written)
            if n <= 0:
                break
            self.disk.seek(offset)
            if self.disk.write(padded[written:written+n]) != n:
                raise IOError('เขียนข้อมูลหุ่นใหม่ไม่ครบ')
            written += n
        if written != size:
            raise ValueError('Marker cluster chain is too short')
        self.disk.flush()
        if self.read_json('ROSIDE.NEW') != request:
            raise IOError('ตรวจสอบข้อมูลหุ่นใหม่ไม่ผ่าน')
