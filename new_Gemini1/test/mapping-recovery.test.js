'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/mapping.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(statuses=[]){
  const nodes=new Map(),requests=[],streams=[],timers=[],logs=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='controller-port'?'/dev/ttyAMA0':'',disabled:false,textContent:'',classList:{toggle(){}}});return nodes.get(id);};
  class WebSocket{
    static OPEN=1;
    constructor(){this.readyState=0;this.sent=[];streams.push(this);}
    send(raw){this.sent.push(JSON.parse(raw));}
    close(){this.readyState=3;this.onclose?.();}
  }
  const context=vm.createContext({$:node,WebSocket,TOKEN:'fixture',sessionId:'session',controllerBaud:115200,controllerPidCommand:'',location:{protocol:'https:',host:'fixture'},
    setTimeout(callback){timers.push(callback);},log:message=>logs.push(message),state(){},stopDrive(){},applyRuntimeStatus(){},handleFrame(){},
    api:async(_url,body)=>{requests.push(body);assert.equal(body.action,'status','restore/retry must never start or stop robot processes');assert.ok(statuses.length,'unexpected status request');return statuses.shift();}
  });
  vm.runInContext('let socket=null,running=false,mappingRuntimePending=false,mappingRuntimeWaiting=false;let mappingDiagnosticBusy=false,lastMappingDiagnosticAt=0,lastScanAt=0,lastMappingLidarLine="";',context);
  vm.runInContext(source.split('\n').find(line=>line.startsWith('function setRuntime(')),context);
  vm.runInContext(source.slice(source.indexOf('async function resumeMappingRuntime('),source.indexOf('function handleFrame(')),context);
  vm.runInContext(source.split('\n').find(line=>line.startsWith('async function checkMappingDiagnostics(')),context);
  return{node,requests,streams,timers,logs,run:code=>vm.runInContext(code,context)};
}
const busy={ok:true,runtimeBusy:true,runtimeRetryable:true,runtimeAction:'start',processRunning:true,lidarRunning:false};
const ready={ok:true,runtimeBusy:false,processRunning:true,lidarRunning:true};

test('restore waits for startup before opening exactly one Mapping stream, without stopping partially started SLAM',async()=>{
  const f=fixture([busy,ready]),restoring=f.run('resumeMappingRuntime()');await tick();
  assert.equal(f.streams.length,0);assert.equal(f.node('controller-port').disabled,true);assert.equal(f.node('start').disabled,true);
  await f.run('resumeMappingRuntime()');assert.equal(f.requests.length,1,'duplicate recovery cannot add a poller');
  f.timers.shift()();await restoring;
  assert.equal(f.requests.length,2);assert.equal(f.streams.length,1);assert.equal(f.run('running'),true);
  const stream=f.streams[0];stream.readyState=1;stream.onopen();assert.equal(stream.sent[0].controllerPort,'/dev/ttyAMA0');
  assert.equal(f.node('stop').disabled,false);
});

test('startup beginning between status and WS handshake retries only after the operation finishes',async()=>{
  const f=fixture([busy,ready]);f.run('running=true;connectStream()');const old=f.streams[0];
  old.onmessage({data:JSON.stringify({type:'error',code:'ROBOT_BUSY',retryable:true,message:'pending'})});old.close();await tick();
  assert.equal(f.streams.length,1);assert.equal(f.run('running'),false);assert.equal(f.node('start').disabled,true);
  f.timers.shift()();await tick();assert.equal(f.streams.length,2);assert.equal(f.run('running'),true);
  old.onclose();assert.equal(f.run('socket')===f.streams[1],true,'late old close must not clear current socket');
});

test('a competing control lease is not retried and failed stream unlocks port selection',async()=>{
  const f=fixture();f.run('running=true;connectStream()');const stream=f.streams[0];
  stream.onmessage({data:JSON.stringify({type:'error',code:'ROBOT_BUSY',message:'other controller'})});stream.close();await tick();
  assert.equal(f.requests.length,0);assert.equal(f.run('running'),false);assert.equal(f.node('controller-port').disabled,false);
});

test('a different session or mission is never auto-attached',async()=>{
  const f=fixture([{...busy,runtimeRetryable:false}]);await f.run('resumeMappingRuntime()');
  assert.equal(f.streams.length,0);assert.equal(f.timers.length,0);assert.equal(f.node('start').disabled,false);
});

test('stop completion and status failure both release the waiting UI without creating a stream',async()=>{
  for(const final of [{ok:true,processRunning:false,lidarRunning:false},{ok:false,error:'offline'}]){
    const f=fixture([{...busy,runtimeAction:'stop'},final]),restoring=f.run('resumeMappingRuntime()');await tick();
    f.timers.shift()();await restoring;
    assert.equal(f.streams.length,0);assert.equal(f.node('start').disabled,false);assert.equal(f.node('controller-port').disabled,false);
  }
});

test('diagnostics ignore partial runtime state and do not report successful serial preflight as a LiDAR error',async()=>{
  const f=fixture([{...busy,lidarLog:'ID_VENDOR=Silicon_Labs\nROSIDE_SERIAL_PREFLIGHT=ok port=/dev/ttyUSB0 baud=460800'}]);
  await f.run('running=true;checkMappingDiagnostics()');assert.equal(f.logs.length,0);
});
