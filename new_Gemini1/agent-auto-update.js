'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const crypto=require('node:crypto');

const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
function newer(candidate,current){
  const parse=value=>/^\d+\.\d+\.\d+$/.test(value)?value.split('.').map(Number):null;
  const a=parse(candidate),b=parse(current);
  if(!a||!b)return false;
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
function rosSetup(){
  const dirs=fs.readdirSync('/opt/ros').filter(name=>fs.existsSync(path.join('/opt/ros',name,'setup.bash')));
  const selected=process.env.ROS_DISTRO&&dirs.includes(process.env.ROS_DISTRO)?process.env.ROS_DISTRO:dirs.sort().at(-1);
  if(!selected)throw Error('ROS 2 setup.bash is required for automatic updates');
  return path.join('/opt/ros',selected,'setup.bash');
}
const defaultPreflight=setup=>new Promise((resolve,reject)=>execFile('/bin/bash',['-lc',`source ${quote(setup)} && python3 -c 'import rclpy, std_msgs.msg, geometry_msgs.msg'`],{timeout:10000},error=>error?reject(Error('ROS 2 Python interlock unavailable: '+error.message)):resolve()));
function createAutoUpdater({config,configPath,version,fetchImpl=fetch,run=execFile,preflight=defaultPreflight,setupPath=rosSetup,intervalMs=300000}){
  const file=path.join(path.dirname(configPath),'auto-update-attempt.json');
  let timer=null,checking=false,active=false,lastError='',latest=null;
  const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return{};}};
  const save=value=>{fs.writeFileSync(file+'.pending',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.pending',file);};
  function status(){const record=read();return{active:active||['starting','waiting_safe','installing'].includes(record.stage),latestVersion:latest?.version||null,releaseNotes:latest?.notes||[],stage:record.stage||'idle',error:record.error||lastError||'',attemptedVersion:record.version||null};}
  async function check(runtimeStatus){
    if(checking||status().active||!config.auto_update_topic)return;
    checking=true;
    try{
      const cloud=new URL(config.cloud_url);
      if(!['wss:','https:'].includes(cloud.protocol)&&!['localhost','127.0.0.1','::1'].includes(cloud.hostname))throw Error('Auto update requires an HTTPS Cloud URL');
      const origin=cloud.origin.replace(/^ws/,'http');
      const response=await fetchImpl(origin+'/agent-release.json',{signal:AbortSignal.timeout(8000),cache:'no-store'});
      if(!response.ok)throw Error('Release check returned HTTP '+response.status);
      const info=await response.json();
      if(!/^[a-f0-9]{64}$/.test(info.sha256)||!/^\d+\.\d+\.\d+$/.test(info.version))throw Error('Invalid release metadata');
      latest={version:info.version,notes:Array.isArray(info.notes)?info.notes.filter(x=>typeof x==='string').slice(0,10):[]};
      if(newer(version,info.version)||info.version===version&&info.sha256===config.release_sha256)return;
      const state=runtimeStatus();
      if(state.busy||state.terminals||state.autoUpdate?.active)return;
      const prior=read();if(prior.sha256===info.sha256&&prior.stage!=='deferred')return;
      const setup=setupPath();await preflight(setup);
      const recheck=runtimeStatus();if(!config.auto_update_topic||recheck.busy||recheck.terminals||recheck.autoUpdate?.active)return;
      // A separate systemd unit survives Agent restart. The subscriber in that
      // unit must observe a stable, fresh motor interlock before installer start.
      const command=`set -e; source ${quote(setup)}; exec python3 ${quote(path.join(__dirname,'agent-safe-update.py'))} ${quote(config.auto_update_topic)} ${quote(path.join(__dirname,'agent-install.sh'))} ${quote(origin)} ${quote(info.sha256)} ${quote(info.version)} ${quote(file)}`;
      save({version:info.version,sha256:info.sha256,stage:'starting',at:new Date().toISOString()});active=true;
      await new Promise((resolve,reject)=>run('systemd-run',['--user','--unit=ros2ide-agent-auto-update-'+crypto.randomBytes(4).toString('hex'),'/bin/bash','-lc',command],{timeout:15000},(error,stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve(stdout)));
      active=false;
    }catch(error){lastError=error.message;if(active){const previous=read();save({...previous,stage:'failed',error:lastError});}active=false;}
    finally{checking=false;}
  }
  function start(runtimeStatus){timer=setInterval(()=>void check(runtimeStatus),intervalMs);timer.unref?.();setTimeout(()=>void check(runtimeStatus),20000).unref?.();}
  function stop(){clearInterval(timer);}
  return{check,start,stop,status};
}
module.exports={createAutoUpdater,newer};
