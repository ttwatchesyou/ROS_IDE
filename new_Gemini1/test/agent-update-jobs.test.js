'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {AgentUpdateJobs}=require('../agent-update-jobs');
const {mountAgentManagement}=require('../agent-management');
const {VERSION}=require('../agent-runtime');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('update stages persist across reload and public status never exposes report credentials',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roside-update-state-'));
  try{
    const store=new AgentUpdateJobs(root),{job,token}=store.create('REAL-test-update',1,VERSION);
    assert.equal(store.report(job.id,'wrong','ready'),null);assert.equal(store.report(job.id,token,'succeeded'),null);
    store.report(job.id,token,'installing');store.report(job.id,token,'checking');assert.equal(job.progress,55);
    const reloaded=new AgentUpdateJobs(root);assert.equal(reloaded.get(job.robotKey).stage,'installing');assert.equal(reloaded.busy(job.robotKey),true);
    assert.equal(JSON.stringify(reloaded.view(job)).includes(token),false);assert.equal(reloaded.view(job).tokenHash,undefined);
    reloaded.report(job.id,token,'ready');assert.equal(reloaded.get(job.robotKey).progress,95);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roside-update-route-')),routes=new Map(),key='REAL-test-update-0123456789';
  fs.mkdirSync(path.join(root,'releases'));fs.writeFileSync(path.join(root,'releases','agent-release.json'),JSON.stringify({version:VERSION,sha256:'a'.repeat(64)}));fs.writeFileSync(path.join(root,'agent-install.sh'),'# fixture installer\n');
  const app={get:(url,...handlers)=>routes.set('GET '+url,handlers.at(-1)),post:(url,...handlers)=>routes.set('POST '+url,handlers.at(-1))};
  const agents=new Map([[key,{version:null,connectedAt:Date.now()-1000,capabilities:[]}]]),pendingReqs=new Map(),calls=[];
  const socket={robotKey:key,send(){},close(){this.closed=true;}},sim={robotKey:'SIM-untouched',close(){this.closed=true;}};
  let launchFail=false,mode='online';
  const rpc=async(robot,action,payload)=>{calls.push({robot,action,payload});if(action==='agent_status')return{version:VERSION,releaseSha256:'a'.repeat(64),mode,busy:0,terminals:0};if(action==='control_select'){mode=payload.mode;return{mode};}if(payload.command.startsWith('systemctl --user is-active'))return{code:3,stdout:'',stderr:''};if(payload.command.startsWith('systemd-run'))return{code:launchFail?1:0,stdout:'',stderr:launchFail?'No user bus':''};return{code:0,stdout:'ActiveState=active\nResult=success',stderr:''};};
  const manager=mountAgentManagement(app,{auth(){},getOwnedSess:req=>({robotKey:req.body.robotKey||key,userId:1}),accessibleRobot:async(user,id)=>id===1&&user.id===1?{robot_key:key}:null,isSim:k=>k.startsWith('SIM-'),agents,agentReq:rpc,maintenanceReq:rpc,pendingReqs,webSockets:new Map([['real',socket],['sim',sim]]),monSockets:new Map(),localRuntime:null,root});
  const invoke=(url,body={},headers={},userId=1)=>new Promise((resolve,reject)=>{const response={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,...data});return this;}};const match=url.match(/^\/api\/robots\/(\d+)\/agent\/(status|update|update-status)$/),route=match?`/api/robots/:id/agent/${match[2]}`:url;try{Promise.resolve(routes.get('POST '+route)({body,params:match?{id:match[1]}:{},headers:{host:'robot.example:8443',origin:'https://robot.example:8443',...headers},user:{id:userId},protocol:'http'},response)).catch(reject);}catch(e){reject(e);}});
  const stored=()=>new AgentUpdateJobs(path.join(root,'tmp','agent-updates')).get(key);
  const waitLaunched=async()=>{for(let i=0;i<100&&!calls.some(c=>c.payload?.command?.startsWith('systemd-run'));i++)await pause(10);};
  return{root,key,agents,pendingReqs,socket,sim,calls,manager,invoke,stored,waitLaunched,failLaunch:()=>{launchFail=true;},setMode:value=>{mode=value;},close(){manager.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('one click closes only this physical robot tools, waits pending work, coalesces duplicates and verifies reconnect',async()=>{
  const f=fixture();
  try{
    f.pendingReqs.set('old',{robotKey:f.key});
    const result=await f.invoke('/api/real/agent/update',{confirm:true});assert.equal(result.status,202);assert.equal(f.manager.busy(f.key),true);assert.equal(f.socket.closed,true);assert.equal(f.sim.closed,undefined);assert.equal(f.manager.busy('SIM-untouched'),false);
    const duplicate=await f.invoke('/api/real/agent/update',{confirm:true});assert.equal(duplicate.update.id,result.update.id);
    await pause(50);assert.equal(f.calls.length,0,'must not restart while existing request is running');f.pendingReqs.delete('old');await f.waitLaunched();
    const command=f.calls.find(c=>c.payload?.command?.startsWith('systemd-run')).payload.command;
    assert.match(command,/https:\/\/robot.example:8443\/agent-install.sh/,'must retain external HTTPS scheme behind reverse proxy');
    const job=f.stored(),token=command.match(/[a-f0-9]{64}/g).find(value=>crypto.createHash('sha256').update(value).digest('hex')===job.tokenHash);
    assert.equal((await f.invoke('/api/agent-update/report',{jobId:job.id,stage:'ready'},{'x-update-token':'bad'})).status,403);
    assert.equal((await f.invoke('/api/agent-update/report',{jobId:job.id,stage:'ready'},{'x-update-token':token})).ok,true);
    let status=await f.invoke('/api/real/agent/update-status');assert.equal(status.update.progress,95,'installer alone may not report success');
    f.agents.set(f.key,{version:VERSION,connectedAt:Date.now(),capabilities:['local-ide']});
    status=await f.invoke('/api/real/agent/update-status');assert.equal(status.update.stage,'succeeded');assert.equal(status.update.progress,100);assert.equal(f.manager.busy(f.key),false);
  }finally{f.close();}
});
test('failed launch is visible and retry creates a new job instead of a five-minute lock',async()=>{
  const f=fixture();
  try{f.failLaunch();const first=await f.invoke('/api/real/agent/update',{confirm:true});await f.waitLaunched();await pause(10);const status=await f.invoke('/api/real/agent/update-status');assert.equal(status.update.stage,'failed');assert.match(status.update.message,/No user bus/);const retry=await f.invoke('/api/real/agent/update',{confirm:true});assert.notEqual(retry.update.id,first.update.id);await pause(400);}
  finally{f.close();}
});
test('new update status/report endpoints never mutate Sim or accept success from an untrusted report',async()=>{
  const f=fixture();try{assert.equal((await f.invoke('/api/real/agent/update-status',{robotKey:'SIM-untouched'})).status,400);assert.equal((await f.invoke('/api/real/agent/update',{robotKey:'SIM-untouched',confirm:true})).status,400);assert.equal(f.calls.length,0);}finally{f.close();}
});
test('Cloud selector can inspect and update only an accessible physical robot without an IDE session',async()=>{
  const f=fixture();
  try{
    assert.equal((await f.invoke('/api/robots/2/agent/status')).status,403);
    assert.equal((await f.invoke('/api/robots/1/agent/status',{}, {},2)).status,403);
    const status=await f.invoke('/api/robots/1/agent/status');assert.equal(status.ok,true);assert.equal(status.updateAvailable,true);
    assert.equal((await f.invoke('/api/robots/1/agent/update')).status,400);
    const update=await f.invoke('/api/robots/1/agent/update',{confirm:true});assert.equal(update.status,202);
    const progress=await f.invoke('/api/robots/1/agent/update-status');assert.equal(progress.update.id,update.update.id);
  }finally{f.close();}
});
test('Cloud uses the release version when its loaded runtime version is older',async()=>{
  const f=fixture();
  try{
    const next='2.4.18';
    fs.writeFileSync(path.join(f.root,'releases','agent-release.json'),JSON.stringify({version:next,sha256:'b'.repeat(64)}));
    const status=await f.invoke('/api/robots/1/agent/status');
    assert.equal(status.latestVersion,next);
    assert.equal(status.latestReleaseSha256,'b'.repeat(64));
    assert.equal(status.updateAvailable,true);
    const update=await f.invoke('/api/robots/1/agent/update',{confirm:true});
    assert.equal(update.update.targetVersion,next);
  }finally{f.close();}
});
test('Cloud selector moves an idle Local Agent to Online before launching its update',async()=>{
  const f=fixture();
  try{
    f.agents.get(f.key).capabilities=['control-mode-v1'];f.setMode('local');
    assert.equal((await f.invoke('/api/robots/1/agent/update',{confirm:true})).status,202);
    await f.waitLaunched();
    const selected=f.calls.find(call=>call.action==='control_select');
    assert.deepEqual(selected.payload,{mode:'online',confirm:true});
    assert.ok(f.calls.findIndex(call=>call.action==='control_select')<f.calls.findIndex(call=>call.payload?.command?.startsWith('systemd-run')));
  }finally{f.close();}
});
