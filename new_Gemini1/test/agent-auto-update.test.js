'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createAutoUpdater,newer}=require('../agent-auto-update');
const {createRuntime}=require('../agent-runtime');

test('automatic update requires a configured interlock, idle tools, newer release and one attempt per digest',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-auto-update-'));
  try{
    const config={cloud_url:'wss://cloud.example/ws/agent',auto_update_topic:''};
    const calls=[],info={version:'2.3.0',sha256:'a'.repeat(64),notes:['new']};
    const updater=createAutoUpdater({config,configPath:path.join(directory,'config.json'),version:'2.2.0',fetchImpl:async()=>({ok:true,json:async()=>info}),setupPath:()=>'/opt/ros/test/setup.bash',preflight:async()=>{},run:(command,args,options,done)=>{calls.push({command,args});done(null,'started','');}});
    const idle=()=>({busy:0,terminals:0,autoUpdate:updater.status()});
    await updater.check(idle);assert.equal(calls.length,0);
    config.auto_update_topic='/robot/update_safe';
    await updater.check(()=>({...idle(),busy:1}));assert.equal(calls.length,0);
    await updater.check(()=>({...idle(),terminals:1}));assert.equal(calls.length,0);
    await updater.check(idle);assert.equal(calls.length,1);
    assert.match(calls[0].args.at(-1),/agent-safe-update\.py/);
    assert.match(calls[0].args.at(-1),/\/robot\/update_safe/);
    await updater.check(idle);assert.equal(calls.length,1);
    assert.equal(updater.status().active,true);
    assert.equal(newer('2.3.0','2.2.9'),true);
    assert.equal(newer('2.2.0','2.2.0'),false);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('invalid topic is rejected and active update blocks commands and terminals',async()=>{
  const config={},runtime=createRuntime({pty:{spawn(){throw Error('must not spawn');}},config,persistSafety:topic=>{config.auto_update_topic=topic;},autoState:()=>({active:!!config.updating})});
  const link=runtime.link('online',()=>{});
  await assert.rejects(runtime.action(link,'auto_update_config',{topic:'relative'}),/absolute ROS topic/);
  await runtime.action(link,'auto_update_config',{topic:'/robot/update_safe'});
  assert.equal(runtime.status().autoUpdate.topic,'/robot/update_safe');
  config.updating=true;
  await assert.rejects(runtime.action(link,'exec',{command:'true'}),/update is in progress/);
  await runtime.handle(link,{type:'pty_init',termId:'test'});
  assert.equal(runtime.status().terminals,0);
});

test('same Agent version installs a changed website digest once',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-web-revision-test-'));
  try{
    const config={cloud_url:'wss://cloud.example/ws/agent',auto_update_topic:'/robot/update_safe',release_sha256:'a'.repeat(64)};
    let launches=0;
    const updater=createAutoUpdater({config,configPath:path.join(directory,'config.json'),version:'2.4.0',fetchImpl:async()=>({ok:true,json:async()=>({version:'2.4.0',sha256:'b'.repeat(64)})}),setupPath:()=>'/opt/ros/test/setup.bash',preflight:async()=>{},run:(_command,_args,_options,done)=>{launches++;done(null,'started','');}});
    await updater.check(()=>({busy:0,terminals:0,autoUpdate:updater.status()}));
    assert.equal(launches,1);
    assert.equal(updater.status().attemptedVersion,'2.4.0');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

for(const failure of ['interlock loss','nonzero /cmd_vel'])test(failure+' terminates installer and stops Agent service',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-interlock-test-'));
  try{
    fs.mkdirSync(path.join(directory,'rclpy'));fs.mkdirSync(path.join(directory,'std_msgs'));fs.mkdirSync(path.join(directory,'geometry_msgs'));
    fs.writeFileSync(path.join(directory,'rclpy','__init__.py'),`import os
import time
from types import SimpleNamespace
started=time.monotonic()
node=None
def init(): pass
def create_node(name):
 global node
 node=Node()
 return node
def shutdown(): pass
class Node:
 def __init__(self): self.callbacks={}
 def create_subscription(self,typ,topic,callback,qos): self.callbacks[topic]=callback
 def destroy_node(self): pass
def spin_once(node,timeout_sec=0.1):
 time.sleep(timeout_sec)
 elapsed=time.monotonic()-started
 mode=os.environ.get('ROSIDE_TEST_FAILURE')
 node.callbacks['/robot/update_safe'](SimpleNamespace(data=mode=='motion' or elapsed<3.3))
 velocity=1.0 if mode=='motion' and elapsed>=3.3 else 0.0
 node.callbacks['/cmd_vel'](SimpleNamespace(linear=SimpleNamespace(x=velocity,y=0.0,z=0.0),angular=SimpleNamespace(x=0.0,y=0.0,z=0.0)))
`);
    fs.writeFileSync(path.join(directory,'rclpy','qos.py'),'class QoSProfile:\n def __init__(self,**kwargs): pass\nclass ReliabilityPolicy:\n BEST_EFFORT=1\n');
    fs.writeFileSync(path.join(directory,'std_msgs','__init__.py'),'');
    fs.writeFileSync(path.join(directory,'std_msgs','msg.py'),'class Bool: pass\n');
    fs.writeFileSync(path.join(directory,'geometry_msgs','__init__.py'),'');
    fs.writeFileSync(path.join(directory,'geometry_msgs','msg.py'),'class Twist: pass\n');
    const bin=path.join(directory,'bin');fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\ntouch "$ROSIDE_TEST_ROOT/service-stopped"\n',{mode:0o700});
    const installer=path.join(directory,'installer.sh');fs.writeFileSync(installer,'#!/bin/bash\ntouch "$ROSIDE_TEST_ROOT/installer-started"\nsleep 20\n',{mode:0o700});
    const record=path.join(directory,'state.json');
    const result=spawnSync('python3',[path.join(__dirname,'..','agent-safe-update.py'),'/robot/update_safe',installer,'https://cloud.invalid','a'.repeat(64),'2.3.1',record],{encoding:'utf8',timeout:12000,env:{...process.env,PYTHONPATH:directory,PATH:bin+':'+process.env.PATH,ROSIDE_TEST_ROOT:directory,ROSIDE_TEST_FAILURE:failure==='interlock loss'?'safety':'motion'}});
    assert.notEqual(result.status,0,result.stderr);
    assert.equal(fs.existsSync(path.join(directory,'installer-started')),true);
    assert.equal(fs.existsSync(path.join(directory,'service-stopped')),true);
    assert.equal(JSON.parse(fs.readFileSync(record,'utf8')).stage,'failed');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
