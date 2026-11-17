'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {PtyJsonStream}=require('../pty-json-stream'),{PtyOutputBatcher}=require('../pty-output-batcher'),{ReadRequestCache}=require('../read-request-cache'),{RequestAdmission}=require('../request-admission'),{MapsimJobStore}=require('../mapsim-job-store'),{createRuntime}=require('../agent-runtime');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('PTY JSON decoding preserves UTF-8, nested braces, quotes, backslashes, multiple frames and chunk boundaries',()=>{
  const values=[{text:'ไทย 🛞 { } " \\ end',nested:{x:1},array:[{y:2}]},{nav:'active',map:null}];
  const encoded=Buffer.from('shell$ '+values.map(JSON.stringify).join('\r\n')+'\r\n');
  for(const size of [1,2,3,7,4096]){const parser=new PtyJsonStream(),frames=[];for(let at=0;at<encoded.length;at+=size)frames.push(...parser.write(encoded.subarray(at,at+size)));assert.deepEqual(frames.map(JSON.parse),values);assert.equal(parser.bytes,0);}
});
test('PTY parser bounds incomplete frames and supports many small frames without carrying old data',()=>{
  const parser=new PtyJsonStream({maxBytes:64});assert.deepEqual(parser.write(Buffer.from('{"a":"')),[]);assert.throws(()=>parser.write(Buffer.from('x'.repeat(60))),/limit/);
  const normal=new PtyJsonStream();for(let i=0;i<10000;i++)assert.deepEqual(normal.write(Buffer.from('{"n":1}')).map(JSON.parse),[{n:1}]);assert.equal(normal.parts.length,0);assert.equal(normal.blocks.length,0);
  const fragmented=new PtyJsonStream(),large={text:'x'.repeat(20000)};const frames=[];for(const byte of Buffer.from(JSON.stringify(large)))frames.push(...fragmented.write(Buffer.from([byte])));assert.deepEqual(frames.map(JSON.parse),[large]);
});
test('PTY batching preserves output order, flushes before close, and bounds buffered chunks',async()=>{
  const sent=[],batch=new PtyOutputBatcher(message=>sent.push(message),{delayMs:10,maxBytes:10});
  batch.write('term1','ไทย');batch.write('term1','x');assert.equal(sent.length,1);assert.equal(Buffer.from(sent[0].data,'base64').toString(),'ไทยx');
  batch.write('term2','one');batch.write('term2','two');batch.flushTerm('term2');assert.equal(Buffer.from(sent[1].data,'base64').toString(),'onetwo');
  batch.write('term3','next');await delay(20);assert.equal(sent[2].termId,'term3');
  batch.write('term4','discard');batch.clear();await delay(20);assert.equal(sent.length,3);
});
test('read-only probe cache coalesces concurrent callers, expires after completion and rejects no failures into the cache',async()=>{
  let time=0,calls=0,finish;const cache=new ReadRequestCache({ttlMs:1000,clock:()=>time});
  const load=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const first=cache.get('robot\0workspace\0nav',load),second=cache.get('robot\0workspace\0nav',load);assert.equal(first,second);await delay(0);assert.equal(calls,1);
  time=5000;assert.equal(cache.get('robot\0workspace\0nav',load),first);finish({ok:true});await first;
  time=5500;assert.deepEqual(await cache.get('robot\0workspace\0nav',()=>assert.fail()),{ok:true});
  cache.clear('robot\0');assert.equal(await cache.get('robot\0workspace\0nav',async()=>2),2);
  let errors=0;for(let i=0;i<2;i++)await assert.rejects(cache.get('bad',async()=>{errors++;throw Error('failed');}),/failed/);assert.equal(errors,2);
});
test('invalidating an in-flight probe cannot overwrite its replacement and pending cache is bounded',async()=>{
  const cache=new ReadRequestCache({limit:1});let finish;const old=cache.get('r\0x',()=>new Promise(resolve=>{finish=resolve;}));await delay(0);
  await assert.rejects(cache.get('s\0x',async()=>0),/เต็ม/);cache.clear('r\0');assert.equal(await cache.get('r\0x',async()=>2),2);finish(1);assert.equal(await old,1);assert.equal(await cache.get('r\0x',async()=>3),2);
});
test('queue position snapshots read jobs once and observe writes from another server immediately',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-store-cache-'));
  const original=fs.readFileSync;try{
    let now=0;const a=new MapsimJobStore(directory,{clock:()=>now}),b=new MapsimJobStore(directory),ids=[];
    for(let i=0;i<100;i++){const id=crypto.randomUUID();ids.push(id);a.write({id,key:String(i),order:String(i).padStart(24,'0'),state:'queued',phase:'queued'});}
    let reads=0;fs.readFileSync=function(file,...args){reads++;return original.call(this,file,...args);};
    assert.equal(a.position(ids[99]),100);assert.equal(reads,101,'100 tickets and one owner /proc read');reads=0;
    for(let i=0;i<50;i++)assert.equal(a.position(ids[i]),i+1);assert.equal(reads,0,'warm positions require no ticket/owner reads');
    const job=b.get(ids[0]);b.write({...job,state:'succeeded',finishedAt:1});assert.equal(a.position(ids[0]),0);assert.equal(a.isFirst(ids[1]),true);
    now=251;reads=0;a.position(ids[99]);assert.ok(reads>0,'owner liveness is checked again after TTL');
  }finally{fs.readFileSync=original;fs.rmSync(directory,{recursive:true,force:true});}
});
test('request admission bounds background exec without blocking I/O, control-mode selection or status',()=>{
  const gate=new RequestAdmission({maxTotal:5,maxPerRobot:3,maxExecPerRobot:1});const exec=gate.enter('r','exec');assert.throws(()=>gate.enter('r','exec'),/ขีดจำกัด/);
  const write=gate.enter('r','fs_write');const read=gate.enter('r','fs_read');assert.throws(()=>gate.enter('r','fs_list'),/ขีดจำกัด/);
  const status=gate.enter('r','agent_status'),control=gate.enter('r','control_select');status();control();assert.equal(gate.total,3);
  exec();exec();write();read();assert.equal(gate.total,0);assert.equal(gate.robots.size,0);
});
test('Agent heartbeat keeps fresh tickets and full status access while sending compact stable metadata',()=>{
  const messages=[],runtime=createRuntime({pty:{},config:{local_enabled:true}}),link=runtime.link('online',message=>messages.push(message));
  runtime.pulse();runtime.pulse();const [full,compact]=messages;assert.ok(full.capabilities);assert.ok(full.lanInterfaces);assert.equal(compact.capabilities,undefined);assert.equal(compact.mode,full.mode);assert.equal(compact.epoch,full.epoch);assert.notEqual(compact.commandToken,full.commandToken);assert.deepEqual(compact.localUrls,full.localUrls);assert.ok(runtime.status().capabilities);assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(full)));runtime.close(link);
});
