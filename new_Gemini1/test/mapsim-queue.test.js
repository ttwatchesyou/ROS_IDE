'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {MapsimQueue}=require('../mapsim-queue');
const {acquireMapsimHostLock}=require('../mapsim-host-lock');
const {MapsimJobStore}=require('../mapsim-job-store');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('simultaneous saves run FIFO with one worker, deduplicate and continue after a failure',async()=>{
  const queue=new MapsimQueue(),order=[];let active=0,peak=0,finish;
  const first=queue.enqueue('a','map1',async update=>{
    ++active;peak=Math.max(peak,active);order.push('a');update('build');
    await new Promise(resolve=>{finish=resolve;});--active;return {ok:true};
  });
  assert.equal(queue.enqueue('a','map1',()=>assert.fail('duplicate ran')),first);
  assert.throws(()=>queue.enqueue('a','map2',()=>{}),/งานค้าง/);
  const jobs=Array.from({length:20},(_,i)=>queue.enqueue('b'+i,'map',async()=>{
    ++active;peak=Math.max(peak,active);order.push(i);await delay(1);--active;
    if(i===5)throw new Error('build failed');return {ok:true};
  }));
  await delay(0);assert.equal(queue.status(first).phase,'build');
  assert.equal(queue.status(jobs[0]).position,1);assert.equal(queue.status(jobs[19]).position,20);
  finish();await Promise.all([first.done,...jobs.map(j=>j.done)]);
  assert.equal(peak,1);assert.deepEqual(order,['a',...Array.from({length:20},(_,i)=>i)]);
  assert.equal(jobs[5].state,'failed');assert.equal(jobs[19].state,'succeeded');
  assert.notEqual(queue.enqueue('a','map2',async()=>({ok:true})).id,first.id);
});

test('two independent server queues share a host lock and release it after failures',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mapsim-lock-test-'));
  const acquire=()=>acquireMapsimHostLock(path.join(dir,'build.lock'));
  const a=new MapsimQueue({acquire}),b=new MapsimQueue({acquire});let active=0,peak=0;
  try{
    const jobs=Array.from({length:8},(_,i)=>(i%2?a:b).enqueue('robot'+i,'map',async()=>{
      peak=Math.max(peak,++active);await delay(15);--active;
      if(i===2)throw new Error('failure inside host lock');return {ok:true};
    }));
    await Promise.all(jobs.map(j=>j.done));assert.equal(peak,1);
    assert.equal(jobs[2].state,'failed');assert.equal(jobs.filter(j=>j.state==='succeeded').length,7);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('queue is bounded and old completed jobs expire',async()=>{
  const queue=new MapsimQueue({limit:1,retentionMs:1});
  const first=queue.enqueue('a',null,async()=>({ok:true}));
  assert.throws(()=>queue.enqueue('b',null,async()=>({ok:true})),/คิวเต็ม/);
  await first.done;await delay(5);queue.prune();assert.equal(queue.jobs.size,0);
});

test('a dead lock helper does not hang release or the next queued job',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mapsim-lock-exit-')),file=path.join(dir,'build.lock');
  try{
    const release=await acquireMapsimHostLock(file);
    const children=fs.readFileSync(`/proc/self/task/${process.pid}/children`,'utf8').trim().split(/\s+/);
    const pid=children.map(Number).find(pid=>{try{return fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').includes(file);}catch{return false;}});
    assert.ok(pid);process.kill(-pid,'SIGKILL');await delay(30);
    let timer;try{await Promise.race([release(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('release hung after helper exit')),1000);})]);}finally{clearTimeout(timer);}
    const next=await acquireMapsimHostLock(file);await next();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('shared tickets preserve FIFO across two queues and completed receipts survive reconstruction',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mapsim-tickets-')),store=new MapsimJobStore(path.join(dir,'jobs')),order=[];
  const options={store,acquire:job=>acquireMapsimHostLock(path.join(dir,'lock'),{isTurn:()=>store.isFirst(job.id)})};
  const a=new MapsimQueue(options),b=new MapsimQueue(options);
  try{
    const jobs=Array.from({length:20},(_,i)=>(i%2?a:b).enqueue('sim-'+i,'map',async()=>{order.push(i);await delay(2);return {ok:true};}));
    assert.equal(a.status(jobs[19]).position,20);
    await Promise.all(jobs.map(j=>j.done));assert.deepEqual(order,Array.from({length:20},(_,i)=>i));
    const restored=new MapsimQueue({store:new MapsimJobStore(path.join(dir,'jobs'))});
    assert.equal(restored.get(jobs[0].id).state,'succeeded');
    const dead={id:require('node:crypto').randomUUID(),key:'dead',order:'0',state:'queued',phase:'queued',createdAt:Date.now(),ownerPid:99999999,ownerStart:'missing'};
    store.write(dead);assert.equal(restored.get(dead.id).state,'failed');assert.match(restored.get(dead.id).result.error,/รีสตาร์ต/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('rejected duplicate saves do not commit and a release error never stops the queue',async()=>{
  let commits=0,finish;
  const queue=new MapsimQueue({acquire:async()=>async()=>{throw new Error('release failed');}});
  const first=queue.enqueue('a','one',async()=>{await new Promise(resolve=>{finish=resolve;});return {ok:true};},{prepare:()=>commits++});
  queue.enqueue('a','one',async()=>assert.fail(),{prepare:()=>commits++});
  assert.throws(()=>queue.enqueue('a','two',async()=>{}, {prepare:()=>commits++}),/งานค้าง/);
  assert.equal(commits,1);await delay(0);
  const next=queue.enqueue('b','two',async()=>({ok:true}));finish();
  await Promise.all([first.done,next.done]);assert.equal(next.state,'failed');assert.equal(queue.active,null);
});

test('browser follows queue positions and stages using short requests and returns real failures',async()=>{
  const requests=[],progress=[];
  const job=(state,phase,position=0,result=null)=>({id:'job-1',state,phase,position,result});
  const responses=[job('queued','queued',3),job('queued','queued',1),job('running','build'),job('running','start'),job('running','verify'),job('failed','verify',0,{ok:false,error:'node failed'})];
  const context={localStorage:{getItem:()=>null},getAuthToken:()=>'',authHeaders:()=>({}),
    AbortController,clearTimeout,setTimeout:(fn,ms)=>setTimeout(fn,ms===2000?0:ms),
    fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {status:200,text:async()=>JSON.stringify({ok:true,job:responses.shift()})};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/common.js'),'utf8')+'\nglobalThis.callAPI=API;',context);
  const result=await context.callAPI('/api/sim/run-mapsim',{sessionId:'s'},{onProgress:text=>progress.push(text)});
  assert.equal(result.ok,false);assert.equal(result.error,'node failed');
  assert.equal(requests[0].body.async,true);assert.equal(requests.filter(r=>r.url==='/api/sim/run-mapsim').length,1);
  assert.ok(requests.slice(1).every(r=>r.body.jobId==='job-1'&&r.body.sessionId==='s'));
  assert.match(progress.join('\n'),/ลำดับที่ 3[\s\S]*ลำดับที่ 1[\s\S]*Build[\s\S]*เปิด Simulation[\s\S]*ตรวจความพร้อม/);
});
