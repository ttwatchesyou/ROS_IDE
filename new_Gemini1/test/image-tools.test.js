'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),express=require('express'),{spawnSync}=require('node:child_process');
const {mountImageTools}=require('../image-tools');
test('image tools cloud only prepares small metadata and serves a cached helper, with no image upload/flash route',async()=>{
  const calls=[],app=express();app.use(express.json({limit:'8kb'}));mountImageTools(app,{auth:(req,res,next)=>next(),getOwnedSess:()=>({robotKey:'target'}),isSim:()=>false,agentReq:async(key,action,payload)=>{calls.push({key,action,payload});return action==='exec'?{code:0,stdout:'/home/operator'}:{};},privilegedExec:async()=>({code:0,stdout:JSON.stringify({ros:['humble'],model:'Pi test'})})});
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  try{
    const result=await fetch(origin+'/api/system-images/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'selected'})});assert.equal(result.status,410);assert.match((await result.json()).error,/Jazzy/);
    const huge=await fetch(origin+'/api/system-images/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:'x'.repeat(9000)})});assert.equal(huge.status,413);
    assert.equal(calls.length,0);
    for(const route of ['/api/backup','/api/flash'])assert.equal((await fetch(origin+route,{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,404);
    const bundle=await fetch(origin+'/tools/roside-image-helper.zip'),data=Buffer.from(await bundle.arrayBuffer());assert.ok(data.length>5000&&data.length<500000);assert.equal(bundle.headers.get('content-type'),'application/zip');
    assert.equal((await fetch(origin+'/tools/roside-image-helper.zip',{headers:{'If-None-Match':bundle.headers.get('etag')}})).status,304);
    const inspected=spawnSync('python3',['-c',"import zipfile,sys,io,json;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));print(json.dumps(z.namelist()))"],{input:data,encoding:'utf8'});assert.equal(inspected.status,0,inspected.stderr);const names=JSON.parse(inspected.stdout);
    for(const file of ['helper.py','adapters.py','fat_marker.py','environment.py','fat_seed.py','passwords.py','env_install.py','ICONS-LICENSE.txt','Start-ImageHelper.ps1','Start-ImageHelper.command','Start-ImageHelper.sh','public/image-tools.html'])assert.ok(names.includes('ROSIDE-Image-Helper/'+file),file);
  }finally{await new Promise(r=>server.close(r));}
});
test('all image actions have tooltips, each PC OS has a launcher, and the dashboard tool is outside missions',()=>{
  const html=fs.readFileSync('public/image-tools.html','utf8');for(const button of html.matchAll(/<button\b[^>]*>/g))assert.match(button[0],/data-tip=/);
  for(const os of ['Windows','Linux','Darwin'])assert.ok(html.includes('value="'+os+'"'));
  const index=fs.readFileSync('public/index.html','utf8');assert.match(index,/class="motor-control-tool-card" data-real-only href="\/image-tools.html"/);
  const js=fs.readFileSync('public/image-tools.js','utf8');assert.match(js,/document\.hidden/);assert.match(js,/running'\?2000:15000/);assert.doesNotMatch(js,/FileReader|readAsArrayBuffer|FormData|\/api\/exec/);
  const helper=fs.readFileSync('image-tools/helper.py','utf8');assert.match(helper,/127\.0\.0\.1/);assert.doesNotMatch(helper,/requests\.|urllib\.request|wss?:\/\//);
});
test('local image engine, disk protection, identity isolation and HTTP boundaries',()=>{
  const result=spawnSync('python3',['-m','unittest','discover','-s','test/image-tools','-v'],{cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:120000,maxBuffer:200000});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
