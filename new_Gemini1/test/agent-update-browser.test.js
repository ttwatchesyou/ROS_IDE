'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),WebSocket=require('ws');
test('one-click update UI polls real stages, resumes the dialog and only shows 100% after confirmation',{skip:process.env.ROSIDE_TEST_BROWSER!=='1',timeout:20000},async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-update-ui-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});let socket;
  try{
    const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),8000);let text='';chrome.stderr.on('data',data=>{text+=data;const match=text.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});chrome.once('error',reject);});
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let seq=0;const pending=new Map();
    let requestedNavigation=null;
    socket.on('message',raw=>{const result=JSON.parse(raw),entry=pending.get(result.id);if(result.method==='Page.frameRequestedNavigation')requestedNavigation=result.params.url;if(entry){pending.delete(result.id);result.error?entry.reject(new Error(JSON.stringify(result.error))):entry.resolve(result.result);}});
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const target=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true}),cdp=(method,params)=>send(method,params,sessionId);
    await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await cdp('Emulation.setDeviceMetricsOverride',{width:900,height:800,deviceScaleFactor:1,mobile:false});
    const {frameTree}=await cdp('Page.getFrameTree');await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<html><style>:root{--bg1:#fff;--bg2:#f0efe9;--bg3:#e4e3db;--txt:#1a1c23;--mt:#5a5e72;--acc:#1a6ef5}body{background:#d5d5d0}</style><body><div id="topbar"><div class="top-actions"></div></div></body></html>'});
    const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    await evaluate(`var sessionId='physical-test',isSimWorkspace=false,updateClicks=0,closedTools=0,job=null;window.confirm=()=>true;function termResetTabs(){closedTools++}function termRenderTabs(){};async function API(url){if(url.endsWith('/update')){updateClicks++;job={id:'test-update',stage:'preparing',progress:5,message:'กำลังปิดเครื่องมือและรอให้งานเดิมจบ',active:true,targetVersion:'2.1.0'};return{ok:true,update:job}}if(url.endsWith('/update-status'))return{ok:true,update:job};return{ok:true,version:job?.stage==='succeeded'?'2.1.0':'legacy',legacy:job?.stage!=='succeeded',connection:'online',updateAvailable:job?.stage!=='succeeded',update:job}}`);
    await evaluate(fs.readFileSync(path.join(__dirname,'..','public','real-agent.js'),'utf8'));
    await evaluate('document.getElementById("real-agent-button").click()');
    await evaluate('new Promise(r=>setTimeout(r,50))');
    await evaluate('Promise.all([document.querySelector("[data-update]").onclick(),document.querySelector("[data-update]").onclick()])');
    assert.equal(await evaluate('updateClicks'),1);assert.equal(await evaluate('closedTools'),1);
    assert.equal(await evaluate('document.querySelector("progress").value'),5);assert.equal(await evaluate('document.querySelector("[data-update]").disabled'),true);
    await evaluate('job={...job,stage:"installing",progress:55,message:"กำลังติดตั้ง dependencies"};new Promise(r=>setTimeout(r,1800))');
    assert.equal(await evaluate('document.querySelector("progress").value'),55);
    await evaluate('document.getElementById("real-agent-dialog").close();document.getElementById("real-agent-button").click();new Promise(r=>setTimeout(r,50))');
    assert.equal(await evaluate('document.querySelector("progress").value'),55);assert.equal(await evaluate('updateClicks'),1);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});const screenshot=path.join(profile,'progress.png');fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));console.log('Update progress screenshot:',screenshot);
    await evaluate('job={...job,stage:"ready",progress:95,message:"รอ Agent เชื่อมกลับ"};new Promise(r=>setTimeout(r,1800))');assert.equal(await evaluate('document.querySelector("progress").value'),95);
    await evaluate('job={...job,stage:"succeeded",progress:100,message:"อัปเดตสำเร็จ Agent รุ่นใหม่เชื่อมต่อแล้ว",active:false};new Promise(r=>setTimeout(r,1800))');
    assert.equal(await evaluate('document.querySelector("progress").value'),100);assert.match(await evaluate('document.querySelector("[data-update]").textContent'),/สำเร็จ/);assert.equal(await evaluate('window.rosideAgentUpdating'),false);
    // A current Agent, like the user's screenshot: tidy addresses and an explicit latest-version state.
    await evaluate(`job=null;var modeClicks=0;API=async url=>{if(url.endsWith('/mode'))modeClicks++;return{ok:true,version:'2.1.0',latestVersion:'2.1.0',legacy:false,connection:'online',mode:'online',terminals:1,busy:0,localUrls:['http://192.168.1.123:3080','http://100.121.38.120:3080','javascript:alert(1)'],updateAvailable:false,update:null}};document.querySelector('[data-refresh]').click();new Promise(r=>setTimeout(r,50))`);
    assert.equal(await evaluate('document.querySelector("[data-version]").textContent'),'v2.1.0');
    // The Agent dialog lists addresses only; Cloud's robot card creates the
    // authenticated handoff before opening any Local URL.
    assert.equal(await evaluate('document.querySelectorAll("[data-links] span").length'),2);
    assert.equal(await evaluate('document.querySelectorAll("[data-links] a").length'),0);
    assert.match(await evaluate('document.querySelector("[data-update]").textContent'),/เวอร์ชันล่าสุด/);
    assert.equal(await evaluate('document.querySelector("[data-update]").disabled'),true);
    assert.equal(await evaluate('document.querySelector("[data-update-progress]").hidden'),true);
    // Clicking a nested icon/label must disable the actual control, not its child.
    await evaluate('document.querySelector("[data-select-label]").click();new Promise(r=>setTimeout(r,50))');
    assert.equal(await evaluate('modeClicks'),1);
    await evaluate(`var cloudOpens=[];window.open=url=>cloudOpens.push(url);API=async()=>({ok:true,version:'2.4.3',latestVersion:'2.4.3',legacy:false,connection:'local',mode:'local',updateAvailable:false,update:null});document.querySelector('[data-refresh]').click();new Promise(r=>setTimeout(r,50))`);
    assert.equal(await evaluate('document.querySelector("[data-update]").disabled'),false);
    await evaluate('document.querySelector("[data-update]").click()');
    assert.deepEqual(await evaluate('cloudOpens'),['/robots']);
    await evaluate('document.querySelector("[data-message]").textContent="";document.activeElement.blur()');
    const capture=async name=>{await evaluate('new Promise(r=>setTimeout(r,200))');const result=await cdp('Page.captureScreenshot',{format:'png'});const file=path.join(profile,name+'.png');fs.writeFileSync(file,Buffer.from(result.data,'base64'));console.log('Agent UI screenshot:',file);};
    const fits=()=>evaluate(`(()=>{const d=document.getElementById('real-agent-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1})()`);
    assert.equal(await fits(),true);await capture('current-light');
    await evaluate('document.documentElement.dataset.theme="dark"');await capture('current-dark');
    for(const width of [768,390,320]){
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
      assert.equal(await fits(),true,`Dialog fits ${width}px viewport without horizontal scrolling`);
      const size=await evaluate('document.querySelector("[data-select]").getBoundingClientRect().height');
      assert.ok(size>=40,'Touch controls retain a usable height');
    }
    await evaluate('document.documentElement.dataset.theme="light"');await capture('mobile-light');
    await evaluate('document.getElementById("real-agent-dialog").close();isSimWorkspace=true;new Promise(r=>setTimeout(r,2100))');
    assert.equal(await evaluate('document.getElementById("real-agent-button").hidden'),true);
    // Only a manual update confirmed as succeeded should return to the robot list.
    await evaluate(`document.head.insertAdjacentHTML('afterbegin','<base href="https://robot.example/">');
      const memory=new Map();Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,String(value)),removeItem:key=>memory.delete(key)}});
      Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:key=>key==='ros2ide_robotkey'?'REAL-test':null}});
      isSimWorkspace=false;var returnJob=null;API=async url=>{if(url.endsWith('/update')){returnJob={id:'manual-return',stage:'preparing',progress:5,message:'กำลังติดตั้ง',active:true,targetVersion:'2.4.0'};return{ok:true,update:returnJob}}if(url.endsWith('/update-status'))return{ok:true,update:returnJob};return{ok:true,version:'2.4.0',legacy:false,connection:'online',mode:'online',terminals:0,busy:0,localUrls:[],updateAvailable:true,update:returnJob}};
      new Promise(r=>setTimeout(r,2100))`);
    await evaluate('document.getElementById("real-agent-button").click();new Promise(r=>setTimeout(r,50))');
    await evaluate('document.querySelector("[data-update]").click();new Promise(r=>setTimeout(r,50))');
    assert.equal(requestedNavigation,null);
    await evaluate('returnJob={...returnJob,stage:"succeeded",progress:100,message:"เชื่อมกลับแล้ว",active:false};document.querySelector("[data-refresh]").click();new Promise(r=>setTimeout(r,50))');
    await new Promise(resolve=>setTimeout(resolve,1500));
    assert.equal(requestedNavigation,'https://robot.example/robots');
  }finally{socket?.close();chrome.kill('SIGTERM');}
});
