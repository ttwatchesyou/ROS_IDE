'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');

async function installScript(){
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  let script;
  const context=vm.createContext({
    rosDistroForSession:()=> 'jazzy',mappingSourceCommand:()=> ':',
    shellQuote:value=>`'${value}'`,remoteShellPath:value=>`'${value}'`,
    agentReq:async()=>({code:1}),
    lidarSudoExec:async(_session,command)=>{script=command;throw Error('captured script');},
  });
  vm.runInContext(source.slice(source.indexOf('async function prepareMappingRuntime('),source.indexOf("app.post('/api/mapping/runtime'")),context);
  await assert.rejects(context.prepareMappingRuntime({robotKey:'fixture'},{root:'/tmp/robot',setup:'/opt/ros/jazzy/setup.bash'}),/captured script/);
  return script;
}

test('Mapping repairs interrupted dpkg before installing SLAM packages and never repairs under an active lock',async()=>{
  const script=await installScript();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'roside-mapping-dpkg-'));
  try{
    fs.writeFileSync(path.join(dir,'fuser'),'#!/bin/sh\n[ "$FUSER_BUSY" = 1 ] || exit 1\n[ "$1" = -s ] && exit 0\necho 321\n');
    fs.writeFileSync(path.join(dir,'dpkg'),'#!/bin/sh\necho dpkg:$* >> "$TRACE"\n[ "$DPKG_FAIL" = 1 ] && exit 1\nexit 0\n');
    fs.writeFileSync(path.join(dir,'apt-get'),'#!/bin/sh\necho apt-get:$* >> "$TRACE"\n');
    for(const name of ['fuser','dpkg','apt-get'])fs.chmodSync(path.join(dir,name),0o755);
    const trace=path.join(dir,'trace');
    const run=extra=>spawnSync('bash',['-c',script],{env:{...process.env,PATH:dir+':'+process.env.PATH,TRACE:trace,...extra},encoding:'utf8'});
    const repaired=run({});
    assert.equal(repaired.status,0,repaired.stderr);
    assert.deepEqual(fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>line.split(':')[0]),['dpkg','apt-get']);
    assert.match(repaired.stdout,/ROSIDE_APT_STAGE=repairing_dpkg/);
    fs.rmSync(trace);
    const busy=run({FUSER_BUSY:'1'});
    assert.equal(busy.status,73);
    assert.match(busy.stderr,/ROSIDE_APT_BUSY/);
    assert.equal(fs.existsSync(trace),false,'an active lock must prevent dpkg and apt-get');
    const broken=run({DPKG_FAIL:'1'});
    assert.notEqual(broken.status,0);
    assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').length,1,'apt-get must not run when dpkg repair fails');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
