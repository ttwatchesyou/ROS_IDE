'use strict';
const {randomUUID}=require('node:crypto');

// One worker covers preparation, build, launch AND readiness. Waiting jobs do
// not spawn ROS processes and duplicate requests share the same result.
class MapsimQueue {
  constructor({limit=230,retentionMs=600000,acquire=null,store=null}={}) {
    this.limit=limit;this.retentionMs=retentionMs;
    this.acquire=acquire;
    this.store=store;
    this.jobs=new Map();this.pending=[];this.active=null;
  }
  prune() {
    this.store?.prune(this.retentionMs);
    const now=Date.now();
    for(const [id,job] of this.jobs)if(job.finishedAt&&now-job.finishedAt>this.retentionMs)this.jobs.delete(id);
    for(const [id,job] of this.jobs){if(this.jobs.size<500)break;if(job.finishedAt)this.jobs.delete(id);}
  }
  busy(key) { return [this.active,...this.pending].find(job=>job?.key===key); }
  get(id) { return this.jobs.get(id)||this.store?.get(id); }
  persist(job){this.store?.write(job);}
  enqueue(key,fingerprint,run,{prepare}={}) {
    this.prune();
    const existing=this.busy(key);
    if(existing){
      if(fingerprint&&existing.fingerprint!==fingerprint)throw new Error('สนามนี้มีงานค้างอยู่ในคิว กรุณารอให้เสร็จก่อนบันทึกการแก้ไขใหม่');
      return existing;
    }
    if(this.pending.length>=this.limit)throw new Error('คิวเต็ม กรุณาลองบันทึกอีกครั้งในภายหลัง');
    const job={id:randomUUID(),key,fingerprint,state:'queued',phase:'queued',createdAt:Date.now(),order:process.hrtime.bigint().toString().padStart(24,'0'),run};
    // Synchronous commit before admission returns: a rejected/duplicate save
    // must never replace map.json. A write failure must not leave a queued job.
    if(prepare)prepare(job);
    this.persist(job);
    job.done=new Promise(resolve=>{job.resolve=resolve;});
    this.jobs.set(job.id,job);this.pending.push(job);
    queueMicrotask(()=>this.drain());
    return job;
  }
  status(job) {
    return {id:job.id,state:job.state,phase:job.phase,position:!job.finishedAt&&!job.startedAt?(this.store?this.store.position(job.id):Math.max(1,this.pending.indexOf(job)+1)):0,
      createdAt:job.createdAt,startedAt:job.startedAt||null,finishedAt:job.finishedAt||null,result:job.result||null};
  }
  async drain() {
    if(this.active||!this.pending.length)return;
    const job=this.active=this.pending.shift();job.state='running';job.phase='waiting';
    let release;
    try {
      if(this.acquire)release=await this.acquire(job);
      job.phase='prepare';job.startedAt=Date.now();
      this.persist(job);
      job.result=await job.run(phase=>{job.phase=phase;this.persist(job);});
      job.state=job.result?.ok?'succeeded':'failed';
    } catch(error) { job.result={ok:false,error:error.message};job.state='failed'; }
    finally {
      try{if(release)await release();}catch(error){job.result={ok:false,error:error.message};job.state='failed';}
      job.finishedAt=Date.now();job.run=null;
      try{this.persist(job);}catch(error){console.error('[MapSim queue] receipt write failed:',error.message);}
      job.resolve(job.result);job.resolve=null;
      this.active=null;queueMicrotask(()=>this.drain());
    }
  }
}
module.exports={MapsimQueue};
