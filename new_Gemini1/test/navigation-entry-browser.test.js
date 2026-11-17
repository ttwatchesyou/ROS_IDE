'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),WebSocket=require('ws');

test('real Nav2 page loads a map, waits for startup, and remains usable after a bridge disconnect',{
  skip:process.env.ROSIDE_TEST_BROWSER!=='1',timeout:30000,
},async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-nav-entry-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),10000);chrome.stderr.on('data',data=>{output+=data;const match=output.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});chrome.once('error',reject);});
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    let seq=0;const pending=new Map();socket.on('message',raw=>{const msg=JSON.parse(raw),entry=pending.get(msg.id);if(entry){pending.delete(msg.id);msg.error?entry.reject(Error(JSON.stringify(msg.error))):entry.resolve(msg.result);}});
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const target=await send('Target.createTarget',{url:'about:blank'}),attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const cdp=(method,params)=>send(method,params,attached.sessionId);
    await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});
    const {frameTree}=await cdp('Page.getFrameTree'),read=file=>fs.readFileSync(path.join(__dirname,'../public',file),'utf8');
    await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html:read('navigation.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')});
    async function evaluate(expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;}
    await evaluate(`
      window.getAuthToken=()=> 'fixture';window.authHeaders=()=>({});window.fixtureCalls=[];window.fixtureStreams=[];window.fixtureErrors=[];window.fixtureStatusCount=0;
      window.addEventListener('error',e=>fixtureErrors.push(e.message));window.addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
      // Bound a broken observer in the fixture so a regression fails instead of hanging Chrome.
      const NativeObserver=window.MutationObserver;window.fixtureObserverCalls=0;
      window.MutationObserver=class extends NativeObserver {constructor(callback){super((records,observer)=>{if(++fixtureObserverCalls>30){observer.disconnect();fixtureErrors.push('MutationObserver did not settle');return;}callback(records,observer);});}};
      Object.defineProperty(window,'localStorage',{value:{getItem:()=> 'fixture',setItem(){}}});
      window.WebSocket=class {static OPEN=1;constructor(){this.readyState=0;this.sent=[];fixtureStreams.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}send(raw){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;this.onclose?.({code:1011,reason:'fixture bridge exited'});}};
      window.fetch=async(url,options)=>{const b=JSON.parse(options.body);fixtureCalls.push({url,...b});let r={ok:true};
        if(url==='/api/session/restore')r={ok:true,sessionId:'fixture',workspace:'~/ros2_ws'};
        if(url==='/api/files/read')r={ok:true,content:JSON.stringify(b.path.endsWith('hardware.json')?{serialPort:'/dev/ttyAMA0',baudRate:115200}:b.path.endsWith('selected_lidar.json')?{port:'/dev/ttyUSB0',modelId:'rplidar_c1'}:{mapName:'map1'})};
        if(url==='/api/navigation/maps')r={ok:true,maps:[{name:'map1',latest:true}]};
        if(url==='/api/serial/ports')r={ok:true,ports:[{path:'/dev/ttyAMA0',kind:'uart'},{path:'/dev/ttyUSB0',kind:'usb'}]};
        if(url==='/api/navigation/map-data')r={ok:true,map:{width:4,height:3,resolution:.05,originX:0,originY:0,data:Array(12).fill(0)}};
        if(url==='/api/navigation/runtime'&&b.action==='status')r=++fixtureStatusCount===1?{ok:true,runtimeBusy:true,runtimeRetryable:true,runtimeAction:'start'}:{ok:true,processRunning:true,lidarRunning:true,log:'ROSIDE_BRIDGE_LOG_BEGIN\\nModuleNotFoundError: fixture\\nROSIDE_BRIDGE_LOG_END'};
        return{ok:true,json:async()=>r};
      };
    `);
    await evaluate(read('navigation.js'));
    await evaluate('new Promise(resolve=>setTimeout(resolve,150))');
    assert.equal(await evaluate('fixtureStreams.length'),0,'no stream while startup is busy');
    assert.equal(await evaluate('document.getElementById("start").disabled'),true);
    await evaluate('new Promise(resolve=>setTimeout(resolve,2100))');
    assert.equal(await evaluate('fixtureStreams.length'),1);
    assert.equal(await evaluate('document.getElementById("empty").hidden'),true,'saved map is rendered');
    await evaluate(`fixtureStreams[0].onmessage({data:JSON.stringify({type:'error',code:'NAV_BRIDGE_EXIT',message:'fixture bridge exited'})});fixtureStreams[0].close();new Promise(resolve=>setTimeout(resolve,100));`);
    assert.equal(await evaluate('document.getElementById("start").disabled'),false);
    assert.match(await evaluate('document.getElementById("log").textContent'),/ModuleNotFoundError/);
    assert.deepEqual(await evaluate('fixtureErrors'),[]);
    assert.equal(await evaluate('fixtureCalls.some(c=>c.action==="start"||c.action==="stop")'),false,'opening page never starts or stops robot processes');
    assert.equal(await evaluate('fixtureStreams.some(s=>s.sent.some(m=>m.type==="command"))'),false);
    const ports=await evaluate(`(async()=>{
      const controller=document.getElementById('controller-port'),lidar=document.getElementById('lidar-port');
      controller.add(new Option('/dev/ttyUSB0','/dev/ttyUSB0'));controller.value='/dev/ttyUSB0';
      fixtureObserverCalls=0;lidar.innerHTML='<option value="">เลือก COM port</option><option value="/dev/ttyUSB0">/dev/ttyUSB0</option>';
      await new Promise(resolve=>setTimeout(resolve,100));
      return {calls:fixtureObserverCalls,count:lidar.options.length,value:lidar.value,errors:fixtureErrors};
    })()`);
    assert.ok(ports.calls<=2,`port observer must settle, got ${ports.calls} callbacks`);
    assert.equal(ports.count,2,'must not append duplicate USB0 options when controller uses USB0');
    assert.equal(ports.value,'','a conflicting port must not be selected for LiDAR');
    assert.deepEqual(ports.errors,[]);
    const recovered=await evaluate(`(async()=>{
      const controller=document.getElementById('controller-port'),lidar=document.getElementById('lidar-port');
      controller.value='/dev/ttyAMA0';controller.dispatchEvent(new Event('change'));
      await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
      return {value:lidar.value,count:lidar.options.length,disabled:lidar.options[1].disabled,errors:fixtureErrors};
    })()`);
    assert.equal(recovered.value,'/dev/ttyUSB0','changing controller back to GPIO restores the available USB LiDAR');
    assert.equal(recovered.count,2);assert.equal(recovered.disabled,false);assert.deepEqual(recovered.errors,[]);
    assert.equal(await evaluate('fixtureCalls.some(c=>c.action==="start"||c.action==="stop")'),false);
  }finally{
    socket?.close();chrome.kill('SIGTERM');
    await new Promise(resolve=>{if(chrome.exitCode!==null)return resolve();const timer=setTimeout(()=>{chrome.kill('SIGKILL');resolve();},2000);chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
    fs.rmSync(profile,{recursive:true,force:true});
  }
});
