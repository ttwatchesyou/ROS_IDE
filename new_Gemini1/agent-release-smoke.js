'use strict';
// Run from an extracted Agent release after npm ci, before switching services.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');

async function freePort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function main(){
  await require('./agent-native-check').check(__dirname);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'roside-agent-smoke-'));
  const config=path.join(temp,'config.json');
  fs.writeFileSync(config,JSON.stringify({robot_key:'REAL-RELEASE-CHECK-1234567890',local_secret:'x'.repeat(43),cloud_url:'wss://cloud.invalid/ws/agent'}),{mode:0o600});
  let child,output='';
  try{
    const port=await freePort();
    child=spawn(process.execPath,[path.join(__dirname,'server.js')],{cwd:__dirname,env:{...process.env,ROSIDE_LOCAL_CONFIG:config,PORT:String(port)},stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data.toString()).slice(-3000);});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      if(child.exitCode!==null)break;
      try{
        const response=await fetch(`http://127.0.0.1:${port}/api/local/info`,{signal:AbortSignal.timeout(700)});
        if(response.ok&&(await response.json()).local===true){
          const assets={'/hardware':'mecanum-xy-source.js','/hardware.js':'validateMecanumXY','/transformation.js':'mecanum_xy','/mecanum-xy.js':'const MecanumXY','/mecanum-xy-source.js':'const MECANUM_XY_LIBRARIES','/dashboard.js':'realTeleopMapExtent'};
          for(const [url,marker] of Object.entries(assets)){
            const asset=await fetch(`http://127.0.0.1:${port}${url}`,{signal:AbortSignal.timeout(1000)});
            const source=await asset.text();
            if(!asset.ok||!source.includes(marker))throw new Error('Local hardware asset missing: '+url);
            if(url.endsWith('.js'))new (require('node:vm').Script)(source,{filename:url});
          }
          console.log('Agent Local release startup, Mecanum XY assets, and teleop map verified');return;
        }
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw new Error(`Agent Local server did not start from this release. ${output}`);
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(resolve,2000);timer.unref?.();child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
