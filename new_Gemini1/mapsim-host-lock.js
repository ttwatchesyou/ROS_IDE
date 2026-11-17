'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');

// flock is released by the kernel if the helper/server dies. Its stdin stays
// open only for the duration of the worker, so no stale PID lease can deadlock
// future builds. Both PM2 servers use this same path.
async function acquireMapsimHostLock(file,{waitSeconds=1800,isTurn}={}) {
  const deadline=Date.now()+waitSeconds*1000;
  while(isTurn&&!isTurn()){
    if(Date.now()>=deadline)throw new Error('รอคิวของเซิร์ฟเวอร์เกินเวลาที่กำหนด กรุณาลองใหม่');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});
  return new Promise((resolve,reject)=>{
    const child=spawn('flock',['-x','-w',String(waitSeconds),file,'sh','-c','printf "READY\\n"; cat >/dev/null'],{detached:true,stdio:['pipe','pipe','pipe']});
    // Subscribe immediately: the helper may exit before the worker releases it.
    const exited=new Promise(done=>{child.once('exit',done);child.once('error',done);});
    let acquired=false,output='',errors='';
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-1000);});
    child.stdin.on('error',()=>{});
    child.on('error',reject);
    child.on('exit',code=>{if(!acquired)reject(new Error(`ไม่สามารถจองคิวของเซิร์ฟเวอร์ (${code}): ${errors}`));});
    child.stdout.on('data',chunk=>{
      output+=chunk;
      if(!acquired&&output.includes('READY\n')){
        acquired=true;
        let released=false;
        resolve(async()=>{
          if(!released){released=true;child.stdin.end();}
          const force=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);
          force.unref?.();
          try{await exited;}finally{clearTimeout(force);}
        });
      }
    });
  });
}
module.exports={acquireMapsimHostLock};
