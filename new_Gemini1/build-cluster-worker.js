'use strict';
// Package the worker as a Node single executable. Run on the same Ubuntu CPU
// architecture as the target machine; only the binary and config go there.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const output=path.resolve(process.argv[2]||path.join(__dirname,'dist','roside-cluster-worker'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'roside-cluster-sea-'));
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8'});if(result.status!==0)throw Error(`${command} failed: ${result.stderr||result.stdout}`);return result.stdout;}
try{
  const blob=path.join(temp,'worker.blob');
  fs.writeFileSync(path.join(temp,'sea.json'),JSON.stringify({main:path.join(__dirname,'cluster-worker.js'),output:blob,disableExperimentalSEAWarning:true}));
  run(process.execPath,['--experimental-sea-config',path.join(temp,'sea.json')]);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.copyFileSync(process.execPath,output);
  run(path.join(__dirname,'node_modules','.bin','postject'),[output,'NODE_SEA_BLOB',blob,'--sentinel-fuse','NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
  fs.chmodSync(output,0o755);
  if(!run(output,['--worker-version']).includes('ROSIDE Cluster Worker 1.1.0'))throw Error('Worker binary did not start its bundled application');
  console.log(output);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
