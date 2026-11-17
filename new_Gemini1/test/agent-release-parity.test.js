'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {sourceDigest,ensureRelease,SOURCES,ASSETS}=require('../build-agent-release');

test('release fingerprint changes with Local web files and bundled runtime',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roside-release-fingerprint-'));
  try{
    for(const file of [...SOURCES,'agent/package.json','agent/package-lock.json','public/robots.html']){
      const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file);
    }
    const first=await sourceDigest(root);
    fs.writeFileSync(path.join(root,'public','robots.html'),'new robot page');
    const second=await sourceDigest(root);assert.notEqual(second,first);
    fs.writeFileSync(path.join(root,'agent-runtime.js'),'new runtime');
    const third=await sourceDigest(root);assert.notEqual(third,second);
    fs.writeFileSync(path.join(root,'public','index_backup.html'),'ignored backup');
    assert.equal(await sourceDigest(root),third);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Cloud release rebuilds a changed robot page offline and pins its archive by SHA',async()=>{
  const source=path.join(__dirname,'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'roside-release-refresh-'));
  const previousFetch=global.fetch;
  try{
    for(const file of [...SOURCES,'agent/package.json','agent/package-lock.json']){
      const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,file),target);
    }
    fs.cpSync(path.join(source,'public'),path.join(root,'public'),{recursive:true});
    for(const file of ['agent-runtime.js','agent/package.json','agent/package-lock.json']){
      const target=path.join(root,file);fs.writeFileSync(target,fs.readFileSync(target,'utf8').replaceAll(require('../agent/package.json').version,'2.4.99'));
    }
    const old=await ensureRelease(root);
    assert.equal(old.version,'2.4.99','release uses the source version even if Cloud loaded an older Agent module');
    for(const file of ['navigation-sequence.html','navigation-sequence.js','navigation-sequence.css','real-drive-motion.js','motor-control.html','motor-control.js','motor-control.css','dashboard.js','hardware.html','hardware.js','transformation.js','mecanum-xy.js','mecanum-xy-source.js']){
      const bundled=execFileSync('tar',['-xOzf',path.join(root,'releases','agent-release.tar.gz'),'./public/'+file],{encoding:'utf8',maxBuffer:8*1024*1024});
      if(file==='hardware.html'){
        assert.match(bundled,/src="\/mecanum-xy-source\.js/);assert.match(bundled,/src="\/mecanum-xy\.js/);
        assert.doesNotMatch(bundled,/fonts.googleapis.com|600&family=Mitr/,'offline font removal must remove the whole URL');
      }else {let expected=fs.readFileSync(path.join(source,'public',file),'utf8');for(const [url,name] of Object.entries(ASSETS))expected=expected.replaceAll(url,'/vendor/'+name);assert.equal(bundled,expected,file+' must reach every Local Agent with bundled dependencies');}
    }
    assert.match(execFileSync('tar',['-xOzf',path.join(root,'releases','agent-release.tar.gz'),'./MECANUM_XY_README.md'],{encoding:'utf8'}),/position_goal/);
    fs.appendFileSync(path.join(root,'public','mecanum-xy.js'),'\n// OFFLINE_XY_RELEASE_TEST\n');
    fs.appendFileSync(path.join(root,'public','robots.html'),'\n<!-- PARITY_REFRESH_TEST -->\n');
    global.fetch=async()=>{throw Error('offline fixture');};
    const next=await ensureRelease(root);
    assert.equal(next.version,old.version);assert.notEqual(next.sha256,old.sha256);
    assert.equal(next.sourceSha256,await sourceDigest(root));
    const archive=path.join(root,'releases',`agent-${next.sha256}.tar.gz`);
    assert.match(execFileSync('tar',['-xOzf',archive,'./public/robots.html'],{encoding:'utf8'}),/PARITY_REFRESH_TEST/);
  }finally{global.fetch=previousFetch;fs.rmSync(root,{recursive:true,force:true});}
});
