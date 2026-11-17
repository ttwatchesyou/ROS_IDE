'use strict';
const fs=require('node:fs');
const path=require('node:path');

function startId(pid){try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];}catch{return '';}}
function alive(job,owners){if(!job.ownerStart)return false;if(!owners)return startId(job.ownerPid)===job.ownerStart;if(!owners.has(job.ownerPid))owners.set(job.ownerPid,startId(job.ownerPid));return owners.get(job.ownerPid)===job.ownerStart;}

// Shared tickets provide FIFO order across the two PM2 servers. Receipts also
// survive restart; interrupted work is reported explicitly rather than replayed
// with a stale session. Saved map.json remains available for a safe retry.
class MapsimJobStore {
  constructor(directory,{snapshotMs=250,clock=Date.now}={}){this.directory=directory;this.ownerPid=process.pid;this.ownerStart=startId(process.pid);this.snapshotMs=snapshotMs;this.clock=clock;this.snapshot=null;}
  directoryStamp(){try{const stat=fs.statSync(this.directory,{bigint:true});return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;}catch{return '';}}
  file(id){if(!/^[a-f0-9-]{36}$/.test(id))return null;return path.join(this.directory,id+'.json');}
  write(job){
    const file=this.file(job.id);if(!file)throw new Error('Invalid job ID');
    fs.mkdirSync(this.directory,{recursive:true});
    const record={id:job.id,key:job.key,order:job.order,state:job.state,phase:job.phase,createdAt:job.createdAt,startedAt:job.startedAt||null,finishedAt:job.finishedAt||null,result:job.result||null,ownerPid:job.ownerPid||this.ownerPid,ownerStart:job.ownerStart||this.ownerStart};
    const pending=file+'.'+process.pid+'.pending';fs.writeFileSync(pending,JSON.stringify(record));fs.renameSync(pending,file);this.snapshot=null;
  }
  get(id,owners){
    const file=this.file(id);if(!file)return null;
    try{
      const job=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!['succeeded','failed'].includes(job.state)&&!alive(job,owners)){
        job.state='failed';job.phase='interrupted';job.finishedAt=Date.now();
        job.result={ok:false,error:'เซิร์ฟเวอร์รีสตาร์ตระหว่างรอหรือทำงาน แผนที่ที่บันทึกแล้วยังอยู่ กรุณากด Save เพื่อลองใหม่'};
        this.write(job);
      }
      return job;
    }catch{return null;}
  }
  list(){
    let files;try{files=fs.readdirSync(this.directory);}catch{return [];}
    const owners=new Map();return files.filter(file=>file.endsWith('.json')).map(file=>this.get(file.slice(0,-5),owners)).filter(Boolean);
  }
  waitingSnapshot(){
    const now=this.clock();let jobs=[];
    for(let attempt=0;attempt<3;attempt++){
      const stamp=this.directoryStamp();
      if(this.snapshot&&this.snapshot.expiresAt>now&&this.snapshot.stamp===stamp)return this.snapshot;
      jobs=this.list().filter(job=>!job.finishedAt&&!job.startedAt).sort((a,b)=>String(a.order).localeCompare(String(b.order)));
      if(this.directoryStamp()!==stamp)continue;
      this.snapshot={jobs,positions:new Map(jobs.map((job,index)=>[job.id,index+1])),expiresAt:now+this.snapshotMs,stamp,stable:true};return this.snapshot;
    }
    // Never grant a FIFO turn from a directory that changed during its scan.
    return{jobs,positions:new Map(jobs.map((job,index)=>[job.id,index+1])),stable:false};
  }
  waiting(){return this.waitingSnapshot().jobs.slice();}
  position(id){return this.waitingSnapshot().positions.get(id)||0;}
  isFirst(id){const snapshot=this.waitingSnapshot();return snapshot.stable&&snapshot.jobs[0]?.id===id;}
  prune(retentionMs){
    for(const job of this.list())if(job.finishedAt&&Date.now()-job.finishedAt>retentionMs){try{fs.unlinkSync(this.file(job.id));this.snapshot=null;}catch{}}
  }
}
module.exports={MapsimJobStore};
