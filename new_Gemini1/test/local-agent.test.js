'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {createRuntime,VERSION}=require('../agent-runtime');
const {fixture}=require('../test-support/local-fixture');

function harness(config={}){
  const spawned=[];
  const runtime=createRuntime({config,pty:{spawn(){let exit;const terminal={writes:[],onData(){},onExit(fn){exit=fn;},write(data){this.writes.push(data);},resize(){},kill(){this.killed=true;exit?.({exitCode:0});}};spawned.push(terminal);return terminal;}}});
  const onlineMessages=[],localMessages=[];
  return{runtime,online:runtime.link('online',msg=>onlineMessages.push(msg)),local:runtime.link('local',msg=>localMessages.push(msg)),spawned,onlineMessages,localMessages};
}
test('legacy action shapes remain compatible; explicit control mode cannot switch with a running PTY',async()=>{
  const {runtime,online,local,spawned}=harness();
  assert.equal(runtime.status().version,VERSION);assert.equal(runtime.status().mode,'online');
  await runtime.handle(online,{type:'pty_init',termId:'term_test'});
  await assert.rejects(runtime.action(local,'control_select',{mode:'local',confirm:true}),/Close terminals/);
  await runtime.handle(online,{type:'pty_input',termId:'term_test',data:'echo test\n'});
  assert.deepEqual(spawned[0].writes,['echo test\n']);
  await runtime.handle(online,{type:'pty_close',termId:'term_test'});
  const oldEpoch=runtime.status().epoch;
  await runtime.action(local,'control_select',{mode:'local',confirm:true});
  await assert.rejects(runtime.action(online,'exec',{command:'false'}),/LOCAL/);
  await assert.rejects(runtime.action(local,'fs_list',{path:'/nonexistent'},{epoch:oldEpoch}),/Stale control/);
  assert.equal((await runtime.action(local,'exec',{command:'printf local-ok'})).stdout,'local-ok');
});
test('cloud disconnection never kills local PTYs and stale control tickets never reach the PTY',async()=>{
  const {runtime,online,local,spawned}=harness();
  await runtime.action(local,'control_select',{mode:'local',confirm:true});
  await runtime.handle(local,{type:'pty_init',termId:'mapping_test'});
  runtime.close(online);assert.equal(spawned[0].killed,undefined);
  await runtime.handle(local,{type:'pty_input',termId:'mapping_test',data:'CMD .1 0\n',epoch:runtime.status().epoch,commandToken:runtime.status().commandToken});
  await runtime.handle(local,{type:'pty_input',termId:'mapping_test',data:'CMD .9 0\n',epoch:runtime.status().epoch,commandToken:'expired'});
  assert.deepEqual(spawned[0].writes,['CMD .1 0\n']);assert.equal(spawned[0].killed,true);
});
test('Agent restores selected Local mode and refuses a mode change when persistence fails',async()=>{
  const restored=harness({active_mode:'local'});assert.equal(restored.runtime.status().mode,'local');
  await assert.rejects(restored.runtime.action(restored.online,'exec',{command:'false'}),/LOCAL/);
  const runtime=createRuntime({pty:{},persistMode(){throw new Error('disk full');}}),local=runtime.link('local',()=>{});
  await assert.rejects(runtime.action(local,'control_select',{mode:'local',confirm:true}),/disk full/);
  assert.equal(runtime.status().mode,'online');
});
test('file CAS rejects concurrent stale saves; robot library persists across Agent restart',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'roside-cas-test-'));
  try{
    const {runtime,online}=harness({data_dir:directory});const file=path.join(directory,'example.txt');
    const first=await runtime.action(online,'fs_write',{path:file,content:'one',ifRevision:null});
    const results=await Promise.allSettled(['two','three'].map(content=>runtime.action(online,'fs_write',{path:file,content,ifRevision:first.revision})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/FILE_CONFLICT/);
    const items=[{id:'custom-sensor',label:'sensor',parts:[]}];
    const saved=await runtime.action(online,'library_write',{items,ifRevision:null});
    await assert.rejects(runtime.action(online,'library_write',{items:[],ifRevision:null}),/FILE_CONFLICT/);
    const restarted=harness({data_dir:directory});const read=await restarted.runtime.action(restarted.online,'library_read');
    assert.deepEqual(read.items,items);assert.equal(read.revision,saved.revision);
    // Old clients may omit a revision: backwards compatibility remains explicit.
    await runtime.action(online,'fs_write',{path:file,content:'legacy'});assert.equal((await runtime.action(online,'fs_read',{path:file})).content,'legacy');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('Local broker opens automatically on the robot and rejects unauthenticated LAN access', {timeout:20000},async()=>{
  const f=await fixture();
  try{
    const selector=await fetch(f.origin+'/robots',{redirect:'manual'});
    assert.equal(selector.status,302);
    assert.equal(selector.headers.get('location'),'https://cloud.example.test/robots');
    const info=await fetch(f.origin+'/api/local/info').then(response=>response.json());
    assert.equal(info.cloudUrl,selector.headers.get('location'));
    assert.equal((await f.post('/api/connect',{robotId:1})).status,401);
    assert.equal((await f.post('/api/local/login',{password:f.config.local_secret})).status,404);
    const blocked=await fetch(f.origin+'/api/local/auto',{method:'POST',headers:{'Content-Type':'application/json','x-forwarded-for':'192.168.1.8'},body:'{}'});
    assert.equal(blocked.status,403);
    const login=await f.post('/api/local/auto',{});assert.equal(login.ok,true);
    const connected=await f.post('/api/connect',{robotId:1},login.token);assert.equal(connected.ok,true);assert.equal(connected.isSim,false);assert.equal(connected.workspace,f.directory);
    const sessionId=connected.sessionId;
    assert.equal((await f.post('/api/real/agent/mode',{sessionId,confirm:true},login.token)).mode,'local');
    assert.equal((await f.post('/api/exec',{sessionId,command:'printf offline-ok'},login.token)).stdout,'offline-ok');
    const file=path.join(f.directory,'offline.txt');assert.equal((await f.post('/api/files/write',{sessionId,path:file,content:'offline',ifRevision:null},login.token)).ok,true);
    const read=await f.post('/api/files/read',{sessionId,path:file},login.token);assert.equal(read.content,'offline');assert.match(read.revision,/^[a-f0-9]{64}$/);
    assert.equal((await f.post('/api/sim/run-mapsim',{sessionId},login.token)).status,404);
    assert.equal((await f.post('/api/auth/register',{username:'test',password:'secret'},login.token)).status,404);
    assert.equal((await fetch(f.origin+'/api/auth/me',{headers:{'x-auth-token':login.token,Origin:'http://evil.invalid'}})).status,403);
    const badHost=await new Promise((resolve,reject)=>require('node:http').get(f.origin+'/api/auth/me',{headers:{'x-auth-token':login.token,Host:'evil.invalid'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject));
    assert.equal(badHost,403);
    await f.post('/api/auth/logout',{},login.token);assert.equal((await f.post('/api/connect',{robotId:1},login.token)).status,401);
    assert.doesNotMatch(f.logs(),/MySQL connected|SIM.*fallback/);
  }finally{await f.stop();}
});
test('Cloud-to-Local handoff is Agent-only, one-time, and opens without browser passwords', {timeout:20000},async()=>{
  const f=await fixture();
  try{
    const ticket=crypto.randomBytes(32).toString('base64url');
    assert.equal((await f.post('/api/local/handoff/prepare',{ticket,sudoPassword:'saved-pass',username:'cloud-user'})).status,403);
    assert.equal((await f.post('/api/local/handoff',{ticket})).status,401);
    const online=f.runtime.link('online',()=>{}),local=f.runtime.link('local',()=>{});
    const payload={ticket,sudoPassword:'saved-pass',username:'cloud-user'};
    await assert.rejects(f.runtime.action(local,'local_handoff',payload),/Cloud Agent link required/);
    assert.deepEqual(await f.runtime.action(online,'local_handoff',payload),{ready:true});
    const login=await f.post('/api/local/handoff',{ticket});
    assert.equal(login.status,200);assert.equal(login.user.username,'cloud-user');
    assert.equal((await f.post('/api/local/handoff',{ticket})).status,401);
    const me=await fetch(f.origin+'/api/auth/me',{headers:{'x-auth-token':login.token}}).then(response=>response.json());
    assert.equal(me.user.username,'cloud-user');
    const connected=await f.post('/api/connect',{robotId:1},login.token);
    assert.equal(connected.status,200);assert.equal(connected.isSim,false);
  }finally{await f.stop();}
});
