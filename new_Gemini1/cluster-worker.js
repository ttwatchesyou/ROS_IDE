'use strict';
// This file stays on Master. Ship its Node single-executable build to Ubuntu
// workers; never copy the Cloud server, database, or simulation source tree.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');

function createWorker(config,{WebSocketImpl=WebSocket}={}){
  if(!/^CL-[A-Za-z0-9_-]{20,60}$/.test(config.cluster_key||'')||typeof config.cluster_secret!=='string'||config.cluster_secret.length<32)throw Error('Invalid Cluster credentials');
  const endpoint=new URL(config.master_url);
  if(endpoint.protocol!=='wss:'&&!(endpoint.protocol==='ws:'&&['localhost','127.0.0.1','::1'].includes(endpoint.hostname)))throw Error('Master requires WSS');
  endpoint.pathname='/ws/cluster';endpoint.search='';endpoint.hash='';
  const mount=path.resolve(config.workspace_root||'');
  if(!path.isAbsolute(config.workspace_root||'')||!fs.existsSync(mount))throw Error('Cluster workspace mount is missing');
  const mountReal=fs.realpathSync(mount);
  const jobs=new Map(),terminals=new Map(),processGroups=new Set();
  let ws=null,clusterId=null,stopped=false,lastAck=Date.now(),retryTimer=null;
  let previousCpu=null;
  function hostMetrics(){
    const cpu=os.cpus().reduce((sum,core)=>({idle:sum.idle+core.times.idle,total:sum.total+Object.values(core.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
    const before=previousCpu;previousCpu=cpu;
    const cpuPercent=before&&cpu.total>before.total?Math.max(0,Math.min(100,100*(1-(cpu.idle-before.idle)/(cpu.total-before.total)))):null;
    const memory=fs.readFileSync('/proc/meminfo','utf8');
    const value=name=>Number(memory.match(new RegExp('^'+name+':\\s+(\\d+)','m'))?.[1]||0);
    const total=value('MemTotal'),available=value('MemAvailable');
    return {cpuPercent:cpuPercent===null?null:Math.round(cpuPercent*10)/10,memUsedMb:Math.round((total-available)/1024),memTotalMb:Math.round(total/1024)};
  }
  const send=value=>{if(ws?.readyState===WebSocketImpl.OPEN)ws.send(JSON.stringify(value));};
  const groupAlive=pid=>{try{process.kill(-pid,0);return true;}catch{return false;}};
  const stopGroup=pid=>{if(!pid||!groupAlive(pid))return;try{process.kill(-pid,'SIGTERM');}catch{}const timer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{}},1500);timer.unref?.();};
  const stopChild=child=>{if(child?.pid)stopGroup(child.pid);};
  function stopAll(){for(const pid of processGroups)stopGroup(pid);processGroups.clear();jobs.clear();for(const child of terminals.values())stopChild(child);terminals.clear();}
  function placement(payload){
    const key=String(payload.robotKey||'');
    if(!clusterId||!new RegExp(`^SIM-C${clusterId}-[A-Za-z0-9_-]{16,80}$`).test(key))throw Error('Simulation is not assigned to this Cluster');
    const masterRoot=String(payload.masterRoot||'');
    if(!masterRoot.endsWith(`/CL-${clusterId}/${key}`)||!path.isAbsolute(masterRoot))throw Error('Invalid Master workspace');
    const root=path.join(mount,key);
    if(!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw Error('Simulation workspace is not mounted');
    if(fs.realpathSync(root)!==path.join(mountReal,key))throw Error('Simulation workspace escapes Cluster mount');
    return{key,root,masterRoot,translate:value=>String(value||'').replaceAll(masterRoot,root)};
  }
  function environment(payload,place){
    const domain=Number(payload.domain);
    if(!Number.isInteger(domain)||domain<1||domain>230)throw Error('Invalid ROS domain');
    const env={...process.env,HOME:place.root,TERM:'xterm-256color',ROS_DOMAIN_ID:String(domain),ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST'};
    delete env.ROS_LOCALHOST_ONLY;
    return env;
  }
  async function handle(action,payload){
    if(action==='host_status'){
      const place=placement(payload),disk=fs.statfsSync(place.root),used=(disk.blocks-disk.bfree)*disk.bsize,total=disk.blocks*disk.bsize;
      const uptime=Math.floor(os.uptime()/60),memoryTotal=Math.round(os.totalmem()/1048576),memoryUsed=Math.round((os.totalmem()-os.freemem())/1048576);
      const stdout=`CPU=0.0\nMEM=${memoryUsed} ${memoryTotal}\nDISK=${(used/1073741824).toFixed(1)}G ${(total/1073741824).toFixed(1)}G ${Math.round(used/Math.max(1,total)*100)}%\nUPTIME=up ${uptime} minutes\n`;
      const processes=[];
      for(const pid of fs.readdirSync('/proc').filter(value=>/^\d+$/.test(value))){
        try{const cwd=fs.readlinkSync(`/proc/${pid}/cwd`);if(cwd!==place.root&&!cwd.startsWith(place.root+path.sep))continue;const command=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').replace(/\0/g,' ').trim();if(command)processes.push(`${pid} ${command}`);}catch{}
      }
      return{stdout,processes:{stdout:processes.join('\n')}};
    }
    const place=placement(payload),env=environment(payload,place);
    if(action==='exec'){
      const command=place.translate(payload.command),timeout=Math.min(Math.max(Number(payload.timeout)||30000,1000),300000);
      if(command.length>200000)throw Error('Command too large');
      return await new Promise(resolve=>{
        const child=spawn('bash',['-lc',command],{cwd:place.root,env,detached:true,stdio:['ignore','pipe','pipe']});
        jobs.set(child.pid,child);if(child.pid)processGroups.add(child.pid);let stdout='',stderr='',finished=false;
        const finish=(code,error)=>{if(finished)return;finished=true;clearTimeout(timer);jobs.delete(child.pid);if(!groupAlive(child.pid))processGroups.delete(child.pid);resolve({stdout:stdout.trim(),stderr:(stderr||error||'').trim(),code:typeof code==='number'?code:1});};
        child.stdout.on('data',data=>{stdout+=data;if(stdout.length>20*1024*1024)stopChild(child);});
        child.stderr.on('data',data=>{stderr+=data;if(stderr.length>20*1024*1024)stopChild(child);});
        child.once('exit',code=>finish(code));child.once('error',error=>finish(1,error.message));
        const timer=setTimeout(()=>{stopChild(child);finish(124,'Simulation command timed out');},timeout);
        timer.unref?.();
      });
    }
    if(action==='launch'){
      const command=place.translate(payload.command),log=place.translate(payload.log||'');
      if(command.length>200000||!log.startsWith(place.root+path.sep))throw Error('Invalid launch request');
      fs.mkdirSync(path.dirname(log),{recursive:true});const fd=fs.openSync(log,'a');
      let child;try{child=spawn('bash',['-lc',command],{cwd:place.root,env,detached:true,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}
      child.once('exit',()=>{jobs.delete(child.pid);if(!groupAlive(child.pid))processGroups.delete(child.pid);});child.once('error',()=>{jobs.delete(child.pid);if(!groupAlive(child.pid))processGroups.delete(child.pid);});jobs.set(child.pid,child);if(child.pid)processGroups.add(child.pid);child.unref();
      return{pid:child.pid};
    }
    const termId=String(payload.termId||'');if(!/^[A-Za-z0-9_-]{8,100}$/.test(termId))throw Error('Invalid terminal');
    const token=place.key+':'+termId;
    if(action==='pty_init'){
      if(terminals.has(token))return{ok:true};
      const child=spawn('script',['-qefc','bash -i','/dev/null'],{cwd:place.root,env,detached:true,stdio:['pipe','pipe','pipe']});
      terminals.set(token,child);
      const output=data=>send({type:'pty_output',robotKey:place.key,termId,data:String(data)});
      child.stdout.on('data',output);child.stderr.on('data',output);
      child.once('exit',()=>{terminals.delete(token);send({type:'pty_closed',robotKey:place.key,termId});});
      child.once('error',error=>{terminals.delete(token);send({type:'pty_closed',robotKey:place.key,termId,error:error.message});});
      return{ok:true};
    }
    if(action==='pty_input'){const child=terminals.get(token);if(!child)throw Error('Terminal closed');child.stdin.write(place.translate(String(payload.data||'')).slice(0,65536));return{ok:true};}
    if(action==='pty_resize')return{ok:true};
    if(action==='pty_close'){const child=terminals.get(token);if(child)stopChild(child);terminals.delete(token);return{ok:true};}
    throw Error('Unsupported action');
  }
  function connect(){
    if(stopped)return;
    ws=new WebSocketImpl(endpoint.href);lastAck=Date.now();clusterId=null;
    ws.addEventListener('open',()=>send({type:'cluster_auth',clusterKey:config.cluster_key,secret:config.cluster_secret,hostname:os.hostname(),version:'1.1.0',metrics:hostMetrics()}));
    ws.addEventListener('message',async event=>{
      let message;try{message=JSON.parse(String(event.data));}catch{return;}
      if(message.type==='cluster_auth_ok'){clusterId=Number(message.clusterId);lastAck=Date.now();return;}
      if(message.type==='heartbeat_ack'){lastAck=Date.now();return;}
      if(message.type!=='command'||!clusterId)return;
      try{const result=await handle(message.action,message.payload||{});send({type:'reply',id:message.id,ok:true,result});}
      catch(error){send({type:'reply',id:message.id,ok:false,error:error.message});}
    });
    ws.addEventListener('close',()=>{clusterId=null;stopAll();if(!stopped)retryTimer=setTimeout(connect,5000);});
    ws.addEventListener('error',()=>{});
  }
  const heartbeat=setInterval(()=>{for(const pid of processGroups)if(!groupAlive(pid))processGroups.delete(pid);if(ws?.readyState===WebSocketImpl.OPEN&&clusterId){if(Date.now()-lastAck>30000){ws.close();return;}send({type:'heartbeat',metrics:hostMetrics()});}},10000);
  function start(){connect();}
  function stop(){stopped=true;clearInterval(heartbeat);clearTimeout(retryTimer);stopAll();ws?.close();}
  return{start,stop,handle,placement};
}
if(require.main===module||require('node:sea').isSea()){
  if(process.argv.includes('--worker-version')||process.argv.includes('--version')){console.log('ROSIDE Cluster Worker 1.1.0');process.exit(0);}
  const configPath=process.env.ROSIDE_CLUSTER_CONFIG||path.join(os.homedir(),'.config','roside-cluster','config.json');
  const worker=createWorker(JSON.parse(fs.readFileSync(configPath,'utf8')));worker.start();
  process.once('SIGTERM',()=>worker.stop());process.once('SIGINT',()=>worker.stop());
}
module.exports={createWorker};
