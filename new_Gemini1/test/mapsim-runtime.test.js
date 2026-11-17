'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {exec}=require('node:child_process');
const {promisify}=require('node:util');
const {mapsimStartCommand}=require('../mapsim-runtime');
const run=promisify(exec);

test('MapSim launches without waiting on slow setup and keeps setup failures in its log',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mapsim launch 'test-"));
  const paths={setup:path.join(dir,'setup.bash'),workspaceSetup:path.join(dir,'workspace.bash'),pidFile:path.join(dir,'mapsim.pid'),logFile:path.join(dir,'mapsim.log')};
  fs.writeFileSync(paths.setup,'sleep 3\nprintf "SETUP_STARTED\\n"\n');
  fs.writeFileSync(paths.workspaceSetup,'printf "WORKSPACE_SETUP_FAILED\\n" >&2\nreturn 17\n');
  try{
    // A foreground source would hit this exec deadline before writing a PID.
    await run(mapsimStartCommand(paths),{shell:'/bin/bash',timeout:1500});
    const pid=Number(fs.readFileSync(paths.pidFile,'utf8'));
    assert.ok(pid>0);process.kill(pid,0);
    const deadline=Date.now()+7000;
    while(Date.now()<deadline&&!fs.readFileSync(paths.logFile,'utf8').includes('WORKSPACE_SETUP_FAILED'))await new Promise(r=>setTimeout(r,100));
    assert.match(fs.readFileSync(paths.logFile,'utf8'),/SETUP_STARTED\nWORKSPACE_SETUP_FAILED/);
  }finally{
    if(fs.existsSync(paths.pidFile)){const pid=Number(fs.readFileSync(paths.pidFile,'utf8'));if(pid>0)try{process.kill(-pid,'SIGTERM');}catch{}}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
