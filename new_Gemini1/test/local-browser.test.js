'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const {VERSION}=require('../agent-runtime');
const {fixture,pause}=require('../test-support/local-fixture');

test('fresh browser on the robot opens Local without a password and shows its route', {skip:!process.env.ROSIDE_TEST_LOCAL_BUNDLE,timeout:45000},async()=>{
  const f=await fixture({root:process.env.ROSIDE_TEST_LOCAL_BUNDLE});
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-offline-browser-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chrome timeout')),10000);let logs='';chrome.stderr.on('data',data=>{logs+=data;const match=logs.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});chrome.once('error',reject);});
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    let seq=0;const pending=new Map(),external=[],errors=[];
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
    socket.on('message',raw=>{
      const msg=JSON.parse(raw),entry=pending.get(msg.id);if(entry){pending.delete(msg.id);msg.error?entry.reject(new Error(JSON.stringify(msg.error))):entry.resolve(msg.result);}
      if(msg.method==='Fetch.requestPaused'){
        const url=msg.params.request.url,allowed=url.startsWith(f.origin+'/')||url.startsWith('data:');if(!allowed)external.push(url);
        send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId:msg.params.requestId,...(allowed?{}:{errorReason:'InternetDisconnected'})},msg.sessionId).catch(()=>{});
      }
      if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);
    });
    const target=await send('Target.createTarget',{url:'about:blank'}),attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const cdp=(method,params)=>send(method,params,attached.sessionId);
    await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1200,height:850,deviceScaleFactor:1,mobile:false});
    const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100);}const diagnostic=await evaluate('JSON.stringify({url:location.href,text:document.body.innerText.slice(0,1000),scripts:[...document.scripts].map(s=>s.src),session:typeof sessionId,isSim:typeof isSimWorkspace!=="undefined"?isSimWorkspace:null})');throw new Error('Browser condition timed out: '+expression+'\n'+errors.join('\n')+'\n'+diagnostic+'\nexternal='+JSON.stringify(external));}
    assert.doesNotMatch(await fetch(f.origin+'/').then(response=>response.text()),/id="(?:password|pair)"/);
    await cdp('Page.navigate',{url:f.origin+'/'});
    await until('location.pathname==="/app"&&!!document.getElementById("real-agent-button")');
    assert.equal(await evaluate('document.getElementById("control-route").textContent'),'Local');
    assert.equal(await evaluate('typeof Terminal'), 'function');
    await evaluate('switchPage("transformation")');await until('typeof tf!=="undefined"&&tf.ready===true');
    assert.equal(await evaluate('isSimWorkspace'),false);
    await evaluate('document.getElementById("real-agent-button").click()');
    await until(`document.querySelector("#real-agent-dialog [data-version]").textContent.includes(${JSON.stringify(VERSION)})`);
    assert.equal(await evaluate('document.getElementById("real-agent-dialog").open'),true);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});const screenshot=path.join(profile,'local-agent.png');fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));console.log('Offline screenshot:',screenshot);
    assert.deepEqual(external,[],'offline bundle must not request CDN/fonts/internet');
    assert.deepEqual(errors,[],'no uncaught browser exceptions');
    const ticket=crypto.randomBytes(32).toString('base64url');
    const online=f.runtime.link('online',()=>{});
    await f.runtime.action(online,'local_handoff',{ticket,sudoPassword:'saved-on-cloud',username:'cloud-operator'});
    await evaluate('localStorage.clear()');
    await cdp('Page.navigate',{url:f.origin+'/#handoff='+ticket});
    await until('location.pathname==="/app"&&!!document.getElementById("real-agent-button")');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("ros2ide_user")).username'),'cloud-operator');
    assert.equal(await evaluate('location.hash'),'');
    await evaluate('void doDisconnect()');
    for(let i=0;i<100&&!external.includes('https://cloud.example.test/robots');i++)await pause(100);
    assert.ok(external.includes('https://cloud.example.test/robots'),'Local disconnect must open the Cloud robot selector');
  }finally{socket?.close();chrome.kill('SIGTERM');await f.stop();}
});
