'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const {fixture,pause}=require('../test-support/local-fixture');

test('clicking a Local URL obtains a Cloud handoff and opens the Local IDE', {skip:!fs.existsSync('/usr/bin/google-chrome'),timeout:30000},async()=>{
  const local=await fixture();
  const online=local.runtime.link('online',()=>{});
  const html=fs.readFileSync(path.join(__dirname,'..','public','robots.html'),'utf8');
  const clickHandler=html.slice(html.indexOf('async function openDirectLocal('),html.indexOf('async function openIDE('));
  let requestedUrl='';
  const cloud=http.createServer(async(req,res)=>{
    if(req.url==='/route'&&req.method==='POST'){
      let body='';for await(const chunk of req)body+=chunk;
      requestedUrl=JSON.parse(body).preferredLocalUrl;
      const ticket=crypto.randomBytes(32).toString('base64url');
      await local.runtime.action(online,'local_handoff',{ticket,sudoPassword:'saved-pass',username:'cloud-user'});
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ok:true,route:'local',localUrl:requestedUrl,handoff:ticket}));
      return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<a id="local-link" href="${local.origin}/" onclick="openDirectLocal(event,7,'${local.origin}/')">Local</a><script>const api=(url,opts)=>fetch('/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(opts.body)}).then(r=>r.json());function notif(message){document.body.dataset.error=message}${clickHandler}</script>`);
  });
  await new Promise(resolve=>cloud.listen(0,'127.0.0.1',resolve));
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-direct-local-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let socket;
  try{
    const debuggerUrl=await new Promise((resolve,reject)=>{
      let output='';const timeout=setTimeout(()=>reject(new Error('Chrome startup timed out: '+output)),10000);
      chrome.stderr.on('data',data=>{output+=data;const match=output.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
      chrome.once('error',reject);
    });
    socket=new WebSocket(debuggerUrl);
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    let sequence=0;const pending=new Map();
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));
    });
    socket.on('message',raw=>{
      const message=JSON.parse(raw),entry=pending.get(message.id);
      if(entry){pending.delete(message.id);message.error?entry.reject(new Error(JSON.stringify(message.error))):entry.resolve(message.result);}
    });
    const target=await send('Target.createTarget',{url:'about:blank'});
    const attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    const cdp=(method,params={})=>send(method,params,attached.sessionId);
    await cdp('Page.enable');await cdp('Runtime.enable');
    const evaluate=async expression=>{
      const result=await cdp('Runtime.evaluate',{expression,returnByValue:true});
      if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await cdp('Page.navigate',{url:`http://127.0.0.1:${cloud.address().port}/`});
    let loaded=false;
    for(let i=0;i<100;i++){if(await evaluate('!!document.getElementById("local-link")')){loaded=true;break;}await pause(100);}
    assert.equal(loaded,true,`Cloud fixture did not load: ${await evaluate('location.href+" "+document.body.innerText.slice(0,300)')}`);
    await evaluate('document.getElementById("local-link").click()');
    let localTarget;
    for(let i=0;i<100;i++){
      const targets=(await send('Target.getTargets')).targetInfos;
      localTarget=targets.find(item=>item.type==='page'&&item.url.startsWith(local.origin+'/app'));
      if(localTarget)break;
      await pause(100);
    }
    assert.ok(localTarget,`Local popup did not reach /app; Cloud error: ${await evaluate('document.body.dataset.error||""')}`);
    const localSession=await send('Target.attachToTarget',{targetId:localTarget.targetId,flatten:true});
    const user=(await send('Runtime.evaluate',{expression:'JSON.parse(localStorage.getItem("ros2ide_user")).username',returnByValue:true},localSession.sessionId)).result.value;
    assert.equal(requestedUrl,local.origin+'/');
    assert.equal(user,'cloud-user');
    assert.equal(await evaluate('document.body.dataset.error||""'),'');
  }finally{
    socket?.close();chrome.kill('SIGTERM');
    await new Promise(resolve=>cloud.close(resolve));
    await local.stop();fs.rmSync(profile,{recursive:true,force:true});
  }
});
