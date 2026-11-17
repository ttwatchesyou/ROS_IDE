'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function fixture(kind){
  const source=fs.readFileSync(path.join(__dirname,`../public/${kind}.js`),'utf8'),nodes=new Map(),requests=[],timers=new Map();let complete;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:({'map-select':'map1','controller-port':'/dev/ttyAMA0','lidar-port':'/dev/ttyUSB0','lidar-model':'rplidar_c1'})[id]||'1',textContent:'idle',disabled:false,classList:{toggle(){}}});return nodes.get(id);};
  const context=vm.createContext({$:node,running:false,sessionId:'session',socket:null,lidarPort:'',aptRetries:0,aptRetryTimer:null,navInstallTimer:null,controllerBaud:115200,controllerPidCommand:'',pidCommand:'',
    LIDAR_MODELS:{rplidar_c1:{name:'C1',baud:460800}},validPort:()=>true,updateNote(){},updatePortNote(){},log(){},connect(){},connectStream(){},applyRuntimeStatus(){},stopDrive(){},send(){},watchNavInstall(){},
    setTimeout(callback){const id=timers.size+1;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);},
    api:async(_url,body)=>{requests.push(body);if(body.action==='status')return{ok:true,processRunning:false};return new Promise(resolve=>{complete=resolve;});}
  });
  vm.runInContext(`let ${kind==='mapping'?'mapping':'navigation'}RuntimePending=false;let mappingRuntimeWaiting=false,navigationRuntimeWaiting=false;`,context);
  for(const prefix of [kind==='mapping'?'function setRuntime(':'function runtime(','async function start(','async function stop('])vm.runInContext(source.split('\n').find(line=>line.startsWith(prefix)),context);
  if(kind==='mapping'){
    const at=source.indexOf('const mappingStartRequest=start;');
    vm.runInContext(source.slice(at,source.indexOf('\nnew MutationObserver',at)),context);
  }
  return{node,requests,timers,run:code=>vm.runInContext(code,context),complete:result=>complete(result)};
}

for(const kind of ['mapping','navigation']){
  test(`${kind} ignores duplicate starts and locks port selection until startup finishes`,async()=>{
    const f=fixture(kind),first=f.run('start(false)');await f.run('start(false)');await f.run('stop()');
    assert.equal(f.requests.length,1);assert.equal(f.node('controller-port').disabled,true);assert.equal(f.node('lidar-model').disabled,true);
    f.complete({ok:true});await first;assert.equal(f.run('running'),true);
    assert.equal(f.node('start').disabled,true);assert.equal(f.node('stop').disabled,false);
    await f.run('start(false)');assert.equal(f.requests.length,1,'already running is not restarted');
  });
  test(`${kind} releases a failed startup and prevents start/stop overlap while stopping`,async()=>{
    const f=fixture(kind),first=f.run('start(false)');f.complete({ok:false,error:'fixture failure'});await first;
    assert.equal(f.node('start').disabled,false);assert.equal(f.node('controller-port').disabled,false);
    const retry=f.run('start(false)');f.complete({ok:true});await retry;
    const stopping=f.run('stop()');const count=f.requests.length;await f.run('start(false)');await f.run('stop()');
    assert.equal(f.requests.length,count);assert.equal(f.node('start').disabled,true);
    f.complete({ok:true});await stopping;assert.equal(f.node('start').disabled,false);
  });
}

test('Mapping APT retry is not swallowed by the duplicate-start guard',async()=>{
  const f=fixture('mapping'),first=f.run('start(false)');f.complete({ok:false,aptBusy:true,error:'fixture apt busy'});await first;
  assert.equal(f.requests.length,1,'recovery probe must not race a scheduled retry');assert.equal(f.timers.size,1);
  [...f.timers.values()][0]();assert.equal(f.requests.length,2);assert.equal(f.requests[1].action,'start');
  f.complete({ok:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.run('running'),true);
});
