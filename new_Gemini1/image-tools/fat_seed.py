"""Edit cloud-init seed files in a PRIVATE regular image file, never a disk.
FAT16/32, mirrored tables and long filenames; all edits are verified on readback.
"""
import math
import os
import stat
import struct
from fat_marker import FatMarkers


def checksum(short):
    value = 0
    for b in short:value = (((value & 1)<<7)+(value>>1)+b) & 255
    return value


class SeedVolume(FatMarkers):
    def __init__(self, disk):
        if not stat.S_ISREG(os.fstat(disk.fileno()).st_mode):
            raise ValueError('Seed edits are only allowed on a private image file')
        super().__init__(disk)
        self.boot = bytearray(self.read(self.base,512))
        self.copies = self.boot[16]
        self.fat_size = (self.root_start-self.fat)//self.copies
        if self.fat_size > 64*1024*1024:raise ValueError('FAT table too large')
        self.table = bytearray(self.read(self.fat,self.fat_size))

    def fat_get(self, cluster):
        size = self.bits//8
        return int.from_bytes(self.table[cluster*size:(cluster+1)*size],'little') & (0xffff if size==2 else 0xfffffff)

    def fat_set(self, cluster, value):
        size = self.bits//8
        if size==4:value |= int.from_bytes(self.table[cluster*size:(cluster+1)*size],'little') & 0xf0000000
        self.table[cluster*size:(cluster+1)*size] = value.to_bytes(size,'little')

    def flush_tables(self):
        for copy in range(self.copies):
            self.disk.seek(self.fat+copy*self.fat_size);self.disk.write(self.table)
        if self.bits==32:
            reserved = struct.unpack_from('<H',self.boot,14)[0]
            info, backup = struct.unpack_from('<HH',self.boot,48)
            for sector in (info,info+backup):
                if 0 < sector < reserved:
                    b=bytearray(self.read(self.base+sector*512,512))
                    if b[:4]==b'RRaA' and b[484:488]==b'rrAa':
                        struct.pack_into('<II',b,488,0xffffffff,0xffffffff);self.disk.seek(self.base+sector*512);self.disk.write(b)
        self.disk.flush()

    def allocated(self, cluster):
        result=[];seen=set()
        while 2 <= cluster < self.clusters+2:
            if cluster in seen:raise ValueError('FAT cycle')
            seen.add(cluster);result.append(cluster);value=self.fat_get(cluster)
            if value >= (0xfff8 if self.bits==16 else 0xffffff8):return result
            cluster=value
        if not cluster:return []
        raise ValueError('Invalid cluster chain')

    def allocate(self, count):
        free=[]
        for cluster in range(2,self.clusters+2):
            if not self.fat_get(cluster):free.append(cluster)
            if len(free)==count:break
        if len(free)!=count:raise ValueError('Boot partition ไม่มีพื้นที่พอสำหรับค่าตั้งเริ่มต้น')
        for i,cluster in enumerate(free):self.fat_set(cluster,free[i+1] if i+1<len(free) else (0xffff if self.bits==16 else 0xfffffff))
        return free

    def cluster_offset(self, cluster):return self.data_start+(cluster-2)*self.cluster_size

    def directory(self):
        if self.bits==16:blocks=[(self.root_start,self.root_size)]
        else:blocks=[(self.cluster_offset(c),self.cluster_size) for c in self.allocated(self.root_cluster)]
        return [(offset+i,bytearray(self.read(offset+i,32))) for offset,size in blocks for i in range(0,size,32)]

    def files(self):
        long={};names=[]
        for offset,entry in self.directory():
            if entry[0]==0:break
            if entry[0]==0xe5:long={};continue
            if entry[11]==15:
                raw=entry[1:11]+entry[14:26]+entry[28:32]
                if entry[0]&64:long={}
                long[entry[0]&31]=(raw,entry[13]);continue
            if entry[11]&0x18:long={};continue
            short=bytes(entry[:11]);name=short[:8].decode('ascii',errors='replace').rstrip()+('.'+short[8:].decode('ascii').rstrip() if short[8:].strip() else '')
            if long and all(c==checksum(short) for _,c in long.values()):
                raw=b''.join(long[k][0] for k in sorted(long));name=raw.decode('utf-16le').split('\0',1)[0].rstrip('\uffff')
            names.append((name,offset,entry));long={}
        return names

    def read_file(self,name):
        for found,_,entry in self.files():
            if found.lower()!=name.lower():continue
            cluster=int.from_bytes(entry[26:28],'little') | (int.from_bytes(entry[20:22],'little')<<16 if self.bits==32 else 0)
            size=int.from_bytes(entry[28:32],'little')
            return b''.join(self.read(self.cluster_offset(c),self.cluster_size) for c in self.allocated(cluster))[:size]
        raise ValueError('Boot seed file missing: '+name)

    def write_file(self,name,data):
        if name not in ('user-data','meta-data','network-config'):raise ValueError('Only cloud-init seed filenames are allowed')
        if not 0<len(data)<=128*1024:raise ValueError('Seed size invalid')
        found=next(((o,e) for n,o,e in self.files() if n.lower()==name.lower()),None)
        old=[]
        if found:
            offset,entry=found;old=self.allocated(int.from_bytes(entry[26:28],'little') | (int.from_bytes(entry[20:22],'little')<<16 if self.bits==32 else 0))
        else:
            shorts={bytes(e[:11]) for _,_,e in self.files()}
            short=next((f'RS{i:06d}'.encode()+b'CFG' for i in range(1,10000) if f'RS{i:06d}'.encode()+b'CFG' not in shorts),None)
            if not short:raise ValueError('No FAT short name available')
            raw=name.encode('utf-16le')+b'\0\0';parts=[raw[i:i+26].ljust(26,b'\xff') for i in range(0,len(raw),26)]
            records=[]
            for seq in range(len(parts),0,-1):
                e=bytearray(32);e[0]=seq|(64 if seq==len(parts) else 0);e[11]=15;e[13]=checksum(short);part=parts[seq-1];e[1:11]=part[:10];e[14:26]=part[10:22];e[28:32]=part[22:];records.append(e)
            entries=self.directory();slots=[]
            for pos,e in entries:
                if e[0] in (0,0xe5):slots.append(pos)
                else:slots=[]
                if len(slots)==len(records)+1:break
            if len(slots)<len(records)+1:raise ValueError('Boot root directory is full')
            for pos,e in zip(slots,records):self.disk.seek(pos);self.disk.write(e)
            offset=slots[-1];entry=bytearray(32);entry[:11]=short;entry[11]=32
        clusters=self.allocate(math.ceil(len(data)/self.cluster_size))
        for i,c in enumerate(clusters):self.disk.seek(self.cluster_offset(c));self.disk.write(data[i*self.cluster_size:(i+1)*self.cluster_size].ljust(self.cluster_size,b'\0'))
        struct.pack_into('<H',entry,26,clusters[0]&0xffff)
        if self.bits==32:struct.pack_into('<H',entry,20,clusters[0]>>16)
        struct.pack_into('<I',entry,28,len(data));self.disk.seek(offset);self.disk.write(entry)
        for c in old:self.fat_set(c,0)
        self.flush_tables()
        if self.read_file(name)!=data:raise IOError('Cloud-init seed verification failed: '+name)
