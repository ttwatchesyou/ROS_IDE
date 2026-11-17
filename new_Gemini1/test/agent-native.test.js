'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const fakePty=`exports.spawn=()=>({onData(fn){setTimeout(()=>fn('ROSIDE_NATIVE_PTY_OK'),10)},onExit(fn){setTimeout(()=>fn({exitCode:0}),20)},kill(){}});`;
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'roside-native-'));for(const file of ['agent-native-check.js','agent-native-install.sh'])fs.copyFileSync(path.join(root,file),path.join(dir,file));return dir;}
test('native check cannot accidentally validate NODE_PATH outside the installed release',()=>{
  const dir=fixture();try{const result=spawnSync(process.execPath,[path.join(dir,'agent-native-check.js')],{encoding:'utf8',env:{...process.env,NODE_PATH:path.join(root,'agent/node_modules')}});assert.notEqual(result.status,0);assert.match(result.stderr,/node_modules\/node-pty/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
for(const phase of ['healthy','repair','failed'])test('native installer '+phase+' validates an actual shell before accepting the release',()=>{
  const dir=fixture();try{
    const bin=path.join(dir,'bin');fs.mkdirSync(bin);fs.mkdirSync(path.join(dir,'node_modules/node-pty'),{recursive:true});
    fs.writeFileSync(path.join(dir,'fixture.js'),fakePty);
    fs.writeFileSync(path.join(dir,'node_modules/node-pty/index.js'),phase==='healthy'?fakePty:"throw Error('missing ARM64 pty.node');");
    fs.writeFileSync(path.join(bin,'npm'),'#!/bin/sh\nprintf "%s|%s" "$npm_config_build_from_source" "$*" > rebuild.log\n'+(phase==='failed'?'exit 1\n':'cp fixture.js node_modules/node-pty/index.js\n'),{mode:0o755});
    const result=spawnSync('bash',[path.join(dir,'agent-native-install.sh')],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,npm_config_ignore_scripts:'true'}});
    assert.equal(result.status,phase==='failed'?1:0,result.stderr);
    if(phase==='healthy')assert.equal(fs.existsSync(path.join(dir,'rebuild.log')),false);
    else assert.match(fs.readFileSync(path.join(dir,'rebuild.log'),'utf8'),/^true\|rebuild node-pty --ignore-scripts=false --foreground-scripts/);
    if(phase!=='failed')assert.match(result.stdout,/Native PTY verified/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
