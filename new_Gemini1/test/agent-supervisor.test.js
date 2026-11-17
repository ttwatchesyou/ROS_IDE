'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const {VERSION}=require('../agent-runtime');
const {pause}=require('../test-support/local-fixture');
test('installed Agent starts Local broker and native PTY remains usable after Cloud disconnect', {skip:!process.env.ROSIDE_TEST_LOCAL_BUNDLE,timeout:30000},async()=>{
  const root=process.env.ROSIDE_TEST_LOCAL_BUNDLE,directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-supervisor-test-'));
  const cloud=new WebSocket.Server({port:0,host:'127.0.0.1'});await new Promise(resolve=>cloud.once('listening',resolve));
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
  const configPath=path.join(directory,'config.json'),secret='test-supervisor-secret-01234567890123456789';
  fs.writeFileSync(configPath,JSON.stringify({robot_key:'real-supervisor-test-0123456789',local_secret:secret,cloud_url:`ws://127.0.0.1:${cloud.address().port}/ws/agent`,workspace:directory,local_host:'127.0.0.1',local_port:port}),{mode:0o600});
  let online,terminal,logs='',agent,authenticated=false;
  cloud.on('connection',ws=>{online=ws;ws.on('message',raw=>{const message=JSON.parse(raw);if(message.type==='auth'){assert.equal(message.version,VERSION);authenticated=true;ws.send(JSON.stringify({type:'auth_ok',workspace:directory}));}});});
  try{
    agent=spawn(process.execPath,[path.join(root,'agent.js')],{cwd:root,env:{PATH:process.env.PATH,HOME:os.homedir(),SHELL:'/bin/bash',ROSIDE_AGENT_CONFIG:configPath},stdio:['ignore','pipe','pipe']});
    agent.stdout.on('data',data=>logs+=data);agent.stderr.on('data',data=>logs+=data);
    const origin=`http://127.0.0.1:${port}`;
    let ready=false;for(let i=0;i<150;i++){try{const response=await fetch(origin+'/api/local/info');if(response.ok&&authenticated){ready=true;break;}}catch{}if(agent.exitCode!==null)throw new Error(logs);await pause(50);}
    assert.ok(ready,logs);
    const post=async(url,body,token)=>{const response=await fetch(origin+url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'x-auth-token':token}:{})},body:JSON.stringify(body)});return response.json();};
    const login=await post('/api/local/auto',{});assert.ok(login.ok);
    let connection;for(let i=0;i<70;i++){connection=await post('/api/connect',{robotId:1},login.token);if(connection.ok)break;await pause(50);}assert.ok(connection.ok,JSON.stringify(connection));
    assert.equal((await post('/api/real/agent/mode',{sessionId:connection.sessionId,confirm:true},login.token)).mode,'local');
    terminal=new WebSocket(origin.replace('http:','ws:')+'/ws/terminal',['ros2ide',login.token],{origin});
    await new Promise((resolve,reject)=>{terminal.once('open',resolve);terminal.once('error',reject);});
    let output='';const packets=[];terminal.on('message',raw=>{const message=JSON.parse(raw);packets.push(message);if(['data','pty_output'].includes(message.type)&&typeof message.data==='string')output+=Buffer.from(message.data,'base64').toString('utf8');});
    terminal.send(JSON.stringify({type:'init',sessionId:connection.sessionId}));await pause(250);
    terminal.send(JSON.stringify({type:'data',data:'printf "SUPERVISOR_LOCAL_OK\\n"\n'}));
    for(let i=0;i<50&&!output.includes('SUPERVISOR_LOCAL_OK');i++)await pause(50);
    assert.match(output,/SUPERVISOR_LOCAL_OK/,JSON.stringify(packets)+'\n'+logs);
    online.terminate();await pause(100);output='';
    terminal.send(JSON.stringify({type:'data',data:'printf "CLOUD_LOSS_LOCAL_OK\\n"\n'}));
    for(let i=0;i<50&&!output.includes('CLOUD_LOSS_LOCAL_OK');i++)await pause(50);
    assert.match(output,/CLOUD_LOSS_LOCAL_OK/);assert.equal(terminal.readyState,WebSocket.OPEN);
    assert.equal(fs.statSync(path.join(directory,'local-access.txt')).mode&0o777,0o600);
    assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).robot_key,'real-supervisor-test-0123456789');
    assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).active_mode,'local');
  }finally{
    terminal?.terminate();online?.terminate();agent?.kill('SIGTERM');
    if(agent)await Promise.race([new Promise(resolve=>agent.once('exit',resolve)),pause(2500)]);
    if(agent&&agent.exitCode===null)agent.kill('SIGKILL');
    for(const client of cloud.clients)client.terminate();await new Promise(resolve=>cloud.close(resolve));fs.rmSync(directory,{recursive:true,force:true});
  }
});
