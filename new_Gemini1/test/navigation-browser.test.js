'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');

test('Chrome renders SVG controls and navigation templates without keyboard steering from inputs', {skip:process.env.ROSIDE_TEST_BROWSER!=='1',timeout:45000},async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-nav-browser-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Chrome startup timed out')),15000);let stderr='';
      chrome.stderr.on('data',data=>{stderr+=data;const match=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
      chrome.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    let id=0;const pending=new Map();
    socket.on('message',raw=>{const msg=JSON.parse(raw);const entry=pending.get(msg.id);if(entry){pending.delete(msg.id);msg.error?entry.reject(new Error(JSON.stringify(msg.error))):entry.resolve(msg.result);}});
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const seq=++id;pending.set(seq,{resolve,reject});socket.send(JSON.stringify({id:seq,method,params,sessionId}));});
    const target=await send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const cdp=(method,params)=>send(method,params,sessionId);
    await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});
    const {frameTree}=await cdp('Page.getFrameTree');
    const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
    const html=read('public/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,'');
    await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
    async function evaluate(expression){const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;}
    await evaluate("var sessionId='test',_live=true,isSimWorkspace=true;var driveCalls=[];function rvizTeleopSet(dir,on){driveCalls.push([dir,on]);}function rvizTeleopStop(){};var API=async(path,body)=>({ok:true,parameters:NavigationSettings.normalize(body)});");
    await evaluate(read('public/navigation-settings.js'));await evaluate(read('public/playground.js'));
    const result=await evaluate(`(async()=>{
      const page=document.getElementById('page-playground');page.classList.add('show');
      playgroundNavPreset('safe',document.querySelector('[data-preset="safe"]'));
      const safe=playgroundNavigationParameters();
      playgroundNavPreset('sport',document.querySelector('[data-preset="sport"]'));
      const narrow=playgroundNavigationParameters();
      document.getElementById('pg-nav-radius').value=.5;document.getElementById('pg-nav-clearance').value=.2;document.getElementById('pg-nav-inflation').value=.3;
      const applied=await playgroundApplyNavParams();
      playgroundMode='control';playgroundBindDrive();
      const input=document.getElementById('pg-nav-speed');input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
      const afterInput=driveCalls.length;
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
      const button=document.querySelector('.pg-drive-btn[data-dir="left"]');button.querySelector('svg').dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,bubbles:true}));button.dispatchEvent(new PointerEvent('pointerup',{pointerId:7,bubbles:true}));
      return {safe,narrow,applied,inflation:document.getElementById('pg-nav-inflation').value,note:document.getElementById('pg-nav-clearance-note').textContent,afterInput,driveCalls,buttons:[...document.querySelectorAll('.pg-drive-btn')].map(b=>({text:b.textContent,svg:!!b.querySelector('svg'),select:getComputedStyle(b).userSelect,pointer:getComputedStyle(b.querySelector('svg')).pointerEvents}))};
    })()`);
    assert.equal(result.safe.clearance,.16);assert.equal(result.narrow.clearance,.02);assert.equal(result.applied,true);
    assert.equal(Number(result.inflation),.7);assert.match(result.note,/0.70/);assert.equal(result.afterInput,0);
    assert.deepEqual(result.driveCalls,[['fwd',true],['left',true],['left',false]]);
    assert.equal(result.buttons.length,4);for(const b of result.buttons){assert.equal(b.text,'');assert.equal(b.svg,true);assert.equal(b.select,'none');assert.equal(b.pointer,'none');}
    // Load the real shared widget as an admin: both buttons from the report exist.
    await evaluate(`Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:key=>key==='ros2ide_user'?'{"username":"test-admin","role":"admin"}':null}});var getAuthToken=()=>'';const helpStyle=document.createElement('style');helpStyle.textContent=${JSON.stringify(read('public/youtube-help.css'))};document.head.appendChild(helpStyle);`);
    await evaluate(read('public/youtube-help.js'));
    for(const [width,height] of [[1280,800],[390,844]]){
      await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
      const visibility=await evaluate(`(async()=>{
        const page=document.getElementById('page-playground'),widget=document.querySelector('.youtube-help');
        const buttons=[...widget.querySelectorAll('.youtube-help-button,.support-presence-button')];
        page.classList.add('show');
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const hiddenOnEntry=getComputedStyle(widget).display==='none'&&buttons.every(b=>!b.getClientRects().length);
        buttons[0].focus();const cannotFocusHidden=!buttons.includes(document.activeElement);
        page.classList.remove('show');
        const visibleElsewhere=getComputedStyle(widget).display==='flex'&&buttons.every(b=>b.getClientRects().length>0);
        widget.querySelector('.youtube-help-button').click();
        const player=widget.querySelector('.youtube-help-player'),panelOpened=!player.hidden;
        page.classList.add('show');
        const openPanelHidden=!player.getClientRects().length;
        const underlying=document.createElement('button');underlying.style.cssText='position:fixed;right:20px;bottom:20px;width:60px;height:60px;z-index:10500';document.body.appendChild(underlying);
        const rect=underlying.getBoundingClientRect(),clickThrough=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===underlying;underlying.remove();
        page.classList.remove('show');
        const restored=getComputedStyle(widget).display==='flex';
        widget.querySelector('.youtube-help-close').click();
        return {buttonCount:buttons.length,hiddenOnEntry,cannotFocusHidden,visibleElsewhere,panelOpened,openPanelHidden,clickThrough,restored};
      })()`);
      assert.equal(visibility.buttonCount,2);
      for(const [name,value] of Object.entries(visibility))if(name!=='buttonCount')assert.equal(value,true,`${width}px: ${name}`);
    }
  }finally{
    socket?.close();chrome.kill('SIGTERM');
    await new Promise(resolve=>{if(chrome.exitCode!==null)return resolve();const timer=setTimeout(()=>{chrome.kill('SIGKILL');resolve();},2000);chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
    fs.rmSync(profile,{recursive:true,force:true});
  }
});
