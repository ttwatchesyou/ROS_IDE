'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/navigation.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(statuses=[]){
  const nodes=new Map(),streams=[],requests=[],logs=[],timers=new Map();let seq=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='controller-port'?'/dev/ttyAMA0':'0.2',textContent:'',disabled:false,classList:{toggle(){}}});return nodes.get(id);};
  class WebSocket{static OPEN=1;constructor(){this.readyState=0;this.sent=[];streams.push(this);}send(raw){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;this.onclose?.({code:1011,reason:'fixture exit'});}}
  const context=vm.createContext({$:node,WebSocket,TOKEN:'fixture',sessionId:'session',controllerBaud:115200,pidCommand:'',location:{protocol:'https:',host:'fixture'},
    log:m=>logs.push(m),state(){},frame(){},setTimeout(fn){timers.set(++seq,fn);return seq;},clearTimeout(id){timers.delete(id);},
    api:async(_url,body)=>{requests.push(body);assert.equal(body.action,'status','recovery cannot mutate robot runtime');assert.ok(statuses.length,'unexpected status request');return statuses.shift();}
  });
  vm.runInContext('let navigationRuntimePending=false,navigationRuntimeWaiting=false,socket=null,running=false,poseRetryTimer=null,speedTimer=null,pose=null,lastPose=0,navStartedAt=0,navPhase="idle";',context);
  vm.runInContext(source.split('\n').find(line=>line.startsWith('function runtime(')),context);
  vm.runInContext(source.slice(source.indexOf('async function resumeNavigationRuntime('),source.indexOf('function send(command)')),context);
  return{node,streams,requests,logs,timers,context,run:code=>vm.runInContext(code,context)};
}
const ready={ok:true,processRunning:true,lidarRunning:true};
const busy={ok:true,runtimeBusy:true,runtimeRetryable:true,runtimeAction:'start',processRunning:true,lidarRunning:false};

test('Nav2 entry waits for startup and never attaches to partially started runtime',async()=>{
  const f=fixture([busy,ready]),resuming=f.run('resumeNavigationRuntime()');await tick();
  assert.equal(f.streams.length,0);assert.equal(f.node('start').disabled,true);
  await f.run('resumeNavigationRuntime()');assert.equal(f.requests.length,1);
  [...f.timers.values()][0]();await resuming;
  assert.equal(f.streams.length,1);assert.equal(f.run('running'),true);assert.equal(f.node('stop').disabled,false);
});

test('Nav2 startup/status handshake race reconnects only the matching runtime',async()=>{
  const f=fixture([busy,ready]);f.run('running=true;connect()');const old=f.streams[0];
  old.onmessage({data:JSON.stringify({type:'error',code:'ROBOT_BUSY',retryable:true,message:'pending'})});old.close();await tick();
  assert.equal(f.streams.length,1);[...f.timers.values()][0]();await tick();assert.equal(f.streams.length,2);
  old.onclose({code:1011});assert.equal(f.run('socket'),f.streams[1]);
  assert.ok(f.streams.every(s=>s.sent.every(m=>m.type!=='command')),'no goals replayed');
});

test('Nav2 bridge death unlocks controls, clears stale localization and exposes remote traceback',async()=>{
  const f=fixture([{...ready,log:'ROSIDE_BRIDGE_LOG_BEGIN\nModuleNotFoundError: missing rclpy\nROSIDE_BRIDGE_LOG_END'}]);
  f.run('running=true;pose={x:1};poseRetryTimer=setTimeout(()=>{},1);speedTimer=setTimeout(()=>{},1);connect()');
  const stream=f.streams[0];stream.onmessage({data:JSON.stringify({type:'error',code:'NAV_BRIDGE_EXIT',message:'bridge exited'})});stream.close();await tick();
  assert.equal(f.run('running'),false);assert.equal(f.run('pose'),null);assert.equal(f.timers.size,0);
  assert.equal(f.node('start').disabled,false);assert.equal(f.node('controller-port').disabled,false);assert.equal(f.node('run-route').disabled,true);
  assert.ok(f.logs.some(line=>line.includes('ModuleNotFoundError')));assert.equal(f.streams.length,1);
});

test('Nav2 rejects foreign operations and failed status without leaving the UI locked',async()=>{
  for(const status of [{...busy,runtimeRetryable:false},{ok:false,error:'Robot offline'},{ok:true,processRunning:true,lidarRunning:false}]){
    const f=fixture([status]);await f.run('resumeNavigationRuntime()');assert.equal(f.streams.length,0);assert.equal(f.node('start').disabled,false);
  }
});

test('Nav2 status requests time out and expose a useful error instead of hanging forever',async()=>{
  let timeout,cleared=false;
  const context=vm.createContext({TOKEN:'fixture',AbortController,authHeaders:()=>({}),setTimeout(fn){timeout=fn;return 1;},clearTimeout(){cleared=true;},fetch:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))))});
  vm.runInContext(source.split('\n').find(line=>line.startsWith('async function api(')),context);
  const pending=vm.runInContext('api("/api/navigation/runtime",{action:"status"})',context);timeout();const result=await pending;
  assert.equal(result.ok,false);assert.match(result.error,/15/);assert.equal(cleared,true);
});
