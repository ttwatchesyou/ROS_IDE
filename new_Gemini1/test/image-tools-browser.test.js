'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),WebSocket=require('ws');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('Image UI explains next steps, all PC platforms, hover tooltips and local-only flash confirmation',{skip:process.env.ROSIDE_TEST_BROWSER!=='1',timeout:30000},async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-image-tools-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});let socket;
  try{
    const url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),8000);chrome.stderr.on('data',data=>{output+=data;const match=output.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});chrome.once('error',reject);});
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let seq=0;const pending=new Map();
    socket.on('message',raw=>{const result=JSON.parse(raw),entry=pending.get(result.id);if(entry){pending.delete(result.id);result.error?entry.reject(Error(JSON.stringify(result.error))):entry.resolve(result.result);}});
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const target=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true}),cdp=(method,params)=>send(method,params,sessionId);
    await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
    const {frameTree}=await cdp('Page.getFrameTree');
    const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    const html=file=>read(file).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'').replace(/@import\s+url\([^)]*\);/g,'');
    const capture=async name=>{const shot=await cdp('Page.captureScreenshot',{format:'png'});const file=path.join(profile,name+'.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));console.log('Control screenshot:',file);};

    const markup=html('public/image-tools.html').replace('</head>',`<style>${read('public/image-tools.css')}</style></head>`);
    await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html:markup});
    await evaluate(`Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null,setItem(){}},configurable:true});globalThis.imageRequests=[];globalThis.fetch=async path=>{imageRequests.push(path);throw Error('Cloud page must not poll')};void 0;`);
    await evaluate(read('public/image-tools.js'));
    assert.equal(await evaluate('imageRequests.length'),0);
    for(const osName of ['Windows','Linux','Darwin']){
      await evaluate(`document.querySelector('input[value="${osName}"]').click();void 0;`);
      assert.match(await evaluate('document.getElementById("launch-command").textContent'),osName==='Windows'?/ps1/:osName==='Darwin'?/command/:/sh/);
    }
    await evaluate(`document.getElementById('download').scrollIntoView();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
    const box=await evaluate(`(()=>{const b=document.getElementById('download').getBoundingClientRect();return{x:b.x+20,y:b.y+15}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
    await evaluate('new Promise(r=>requestAnimationFrame(r))');
    assert.equal(await evaluate('document.getElementById("tooltip").hidden'),false);
    assert.match(await evaluate('document.getElementById("tooltip").textContent'),/เครื่องมือขนาดเล็ก/);
    await capture('image-tools-cloud-desktop');
    await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html:markup.replace('data-mode="cloud"','data-mode="helper"')});
    await evaluate(`globalThis.imageRequests=[];globalThis.fetch=async(path,options)=>{imageRequests.push(path);const values={'/api/info':{os:'Linux',privileged:true,folder:'/home/user/ROSIDEImages'},'/api/environment':{cached:{file:'ubuntu.img.xz',rawBytes:12000000000,fileBytes:1400000000}},'/api/disks':{devices:[{id:'sd2',path:'/dev/sdb',label:'USB SD Card',serial:'unique',size:64000000000,blocked:false},{id:'root',path:'/dev/sda',label:'System disk',serial:'root',size:128000000000,blocked:true,reason:'ดิสก์ระบบ'}]},'/api/status':{job:{state:'idle',phase:'idle',done:0,total:0}},'/api/flash':{job:{id:'job1',state:'running',operation:'flash',phase:'checking',done:0,total:10,startedAt:Date.now()/1000}}};return{ok:true,json:async()=>({ok:true,...values[path]})}};void 0;`);
    await evaluate(read('public/image-tools.js'));
    await evaluate('new Promise(r=>setTimeout(r,70))');
    await evaluate(`document.getElementById('scan-target').click();new Promise(r=>setTimeout(r,50))`);
    assert.equal(await evaluate('document.querySelector("#target option[value=root]").disabled'),true);
    assert.equal(await evaluate('document.getElementById("flash").disabled'),true);
    await evaluate(`for(const [id,value] of [['target','sd2'],['hostname','agv-002'],['password','safe-password-123']]){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}void 0;`);
    assert.equal(await evaluate('document.getElementById("flash").disabled'),true);
    await evaluate(`const confirm=document.getElementById('confirm-disk');confirm.value='sd2';confirm.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
    assert.equal(await evaluate('document.getElementById("flash").disabled'),false);
    assert.equal(await evaluate('imageRequests.some(p=>/^https?:/.test(p))'),false);
    await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await evaluate(`document.getElementById('target').scrollIntoView();void 0;`);
    await capture('image-tools-helper-mobile');
    // No Flash is clicked in this test. It only verifies UI authorization gates.
    assert.equal(await evaluate('imageRequests.includes("/api/flash")'),false);
    for(const [jobId,key] of [['first','a'.repeat(64)],['second','b'.repeat(64)]]){
      await evaluate(`globalThis.fetch=async p=>{imageRequests.push(p);return{ok:true,json:async()=>({ok:true,job:{id:'${jobId}',state:'complete',phase:'complete',operation:'flash',done:10,total:10,result:{kind:'flash',username:'roside',hostname:'agv-test',robotKey:'${key}',next:'Register'}}})}};document.dispatchEvent(new Event('visibilitychange'));new Promise(r=>setTimeout(r,50))`);
      assert.equal(await evaluate('document.getElementById("new-robot-key").value'),key);
    }
    await evaluate(`globalThis.fetch=async p=>({ok:true,json:async()=>({ok:true,job:{id:'third',state:'running',phase:'writing',operation:'flash',done:1,total:10}})});document.dispatchEvent(new Event('visibilitychange'));new Promise(r=>setTimeout(r,50))`);
    assert.equal(await evaluate('document.getElementById("new-key-panel").hidden'),true);

  }finally{socket?.close();chrome.kill('SIGTERM');}
});
