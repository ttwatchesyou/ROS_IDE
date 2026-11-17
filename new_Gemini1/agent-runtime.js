'use strict';
// Optional v2.1 runtime. The single-file legacy Agent remains a valid fallback.
const fs=require('node:fs/promises');
const fss=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const http=require('node:http');
const {exec,execFile,spawn}=require('node:child_process');
const net=require('node:net');
const {PtyOutputBatcher}=require('./pty-output-batcher');
const VERSION='2.4.24';
const CAPABILITIES=['local-ide','control-mode-v1','command-freshness-v1','file-revision-v1','library-v1','lan-route-v1','local-handoff-v1','auto-update-v1'];
const revision=content=>crypto.createHash('sha256').update(content).digest('hex');
const resolvePath=value=>value==='~'?os.homedir():value.startsWith('~/')?path.join(os.homedir(),value.slice(2)):value;

function createRuntime({pty,config={},onStatus=()=>{},persistMode=()=>{},persistSafety=()=>{},autoState=()=>({})}){
  const links=new Set(),locks=new Map();
  let mode=config.active_mode==='local'?'local':'online',epoch=crypto.randomUUID(),busy=0,commandToken=crypto.randomBytes(12).toString('hex');
  let networkCache=null;
  function networkStatus(){const now=performance.now();if(!networkCache||now>=networkCache.expiresAt){const interfaces=lanInterfaces();networkCache={expiresAt:now+1000,interfaces,urls:interfaces.map(item=>`http://${item.address}:${config.local_port||3080}/`)};}return networkCache;}
  const tickets=new Map([[commandToken,performance.now()]]);
  const status=()=>({version:VERSION,releaseSha256:config.release_sha256||null,capabilities:CAPABILITIES,mode,epoch,commandToken,busy,terminals:[...links].reduce((n,l)=>n+l.terminals.size,0),autoUpdate:{enabled:!!config.auto_update_topic,topic:config.auto_update_topic||'',...autoState()},localPort:config.local_port||3080,localEnabled:config.local_enabled!==false,localHost:config.local_host||'0.0.0.0',localUrls:networkStatus().urls,lanInterfaces:networkStatus().interfaces});
  function pulse(){const now=performance.now();for(const[token,time]of tickets)if(now-time>1500)tickets.delete(token);commandToken=crypto.randomBytes(12).toString('hex');tickets.set(commandToken,now);announce(true);}
  function announce(compact=false){const snapshot=status(),now=performance.now(),stamp=JSON.stringify({...snapshot,commandToken:undefined});for(const link of links){const full=!compact||link.statusStamp!==stamp||now-link.lastFullStatus>=5000;link.send({type:'agent_status',...(full?snapshot:{mode:snapshot.mode,epoch:snapshot.epoch,commandToken:snapshot.commandToken,localUrls:snapshot.localUrls})});if(full){link.statusStamp=stamp;link.lastFullStatus=now;}}onStatus(snapshot);}
  function link(kind,send){const l={kind,send,terminals:new Map(),closed:false,output:new PtyOutputBatcher(send),statusStamp:null,lastFullStatus:-Infinity};links.add(l);return l;}
  function close(l){l.closed=true;for(const id of [...l.terminals.keys()])kill(l,id);l.output.clear();links.delete(l);}
  function kill(l,id){const terminal=l.terminals.get(id);if(terminal){try{terminal.kill();}catch{}l.terminals.delete(id);}}
  function guard(l,msg){
    if(l.closed)throw new Error('Connection closed');
    if(l.kind!==mode)throw new Error(`Robot is in ${mode.toUpperCase()} mode. Close running tools and explicitly select ${l.kind.toUpperCase()} mode first.`);
    if(msg.epoch!==undefined&&msg.epoch!==epoch)throw new Error('Stale control session; refresh connection status');
  }
  async function exclusive(key,fn){
    const previous=locks.get(key)||Promise.resolve();
    const next=previous.catch(()=>{}).then(fn);locks.set(key,next);
    try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}
  }
  async function action(l,name,payload={},msg={}){
    if(name==='agent_status')return status();
    if(name==='auto_update_config'){
      guard(l,msg);
      if(busy||[...links].some(link=>link.terminals.size))throw new Error('Close active tools before changing update safety settings');
      const topic=String(payload.topic||'');
      if(topic&&!/^\/[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*$/.test(topic))throw new Error('Use an absolute ROS topic name, for example /robot/update_safe');
      persistSafety(topic);return status();
    }
    if(autoState().active)throw new Error('Agent update is in progress; commands are temporarily blocked');
    if(name==='local_handoff'){
      if(l.kind!=='online'||l.closed)throw new Error('Cloud Agent link required');
      const {ticket,sudoPassword,username}=payload;
      if(!/^[A-Za-z0-9_-]{43}$/.test(ticket||'')||typeof sudoPassword!=='string'||sudoPassword.length>4096||typeof username!=='string'||username.length>120)throw new Error('Invalid local handoff');
      if(config.local_enabled===false)throw new Error('Local IDE is disabled');
      const response=await fetch(`http://127.0.0.1:${config.local_port||3080}/api/local/handoff/prepare`,{
        method:'POST',headers:{'Content-Type':'application/json','x-local-agent-secret':config.local_secret},
        body:JSON.stringify({ticket,sudoPassword,username}),signal:AbortSignal.timeout(3000),
      });
      if(!response.ok)throw new Error('Local IDE could not prepare handoff');
      return {ready:true};
    }
    if(name==='lan_probe'){
      const address=String(payload.address||'').replace(/^::ffff:/,'');
      const {sameSubnet}=require('./lan-routing');
      if(net.isIP(address)!==4||!lanInterfaces().some(entry=>sameSubnet(address,entry)))return {reachable:false};
      const ping=await new Promise(resolve=>execFile('ping',['-n','-c','1','-W','1',address],{timeout:1800},(error,stdout)=>{const latency=Number(String(stdout||'').match(/time[=<]([\d.]+)/)?.[1]);resolve({reachable:!error,latencyMs:Number.isFinite(latency)?latency:null});}));
      if(!ping.reachable)return {reachable:false};
      const ready=await new Promise(resolve=>{
        const request=http.get({hostname:'127.0.0.1',port:config.local_port||3080,path:'/api/local/info',timeout:1200},response=>{
          let body='';response.on('data',chunk=>{body+=chunk;if(body.length>1024)request.destroy();});
          response.on('end',()=>{try{resolve(response.statusCode===200&&JSON.parse(body).local===true);}catch{resolve(false);}});
        });
        request.on('timeout',()=>request.destroy());request.on('error',()=>resolve(false));
      });
      return {reachable:ready,latencyMs:ping.latencyMs};
    }
    if(name==='control_select'){
      if(autoState().active)throw new Error('Agent update is in progress');
      if(payload.confirm!==true||payload.mode!==l.kind)throw new Error('Explicit confirmation for this connection is required');
      if(mode!==l.kind){
        if(busy||[...links].some(link=>link.terminals.size))throw new Error('Close terminals, monitoring and control tools; wait for builds before switching mode');
        // Persist synchronously before switching: a reboot must not silently choose Cloud.
        persistMode(l.kind);mode=l.kind;epoch=crypto.randomUUID();tickets.clear();pulse();
      }
      return status();
    }
    guard(l,msg);busy++;
    try{
      if(name==='exec')return await new Promise((resolve,reject)=>{
        if(typeof payload.command!=='string')return reject(new Error('Invalid command'));
        exec(payload.command,{shell:'/bin/bash',timeout:Math.max(1,Math.min(Number(payload.timeout)||30000,300000)),maxBuffer:4*1024*1024},(error,stdout,stderr)=>{
          // Like legacy Agent, nonzero shell exit is data; spawn failure is error.
          if(error&&typeof error.code==='string'&&!error.killed)return reject(error);
          resolve({stdout:stdout.trim(),stderr:stderr.trim(),code:error?(typeof error.code==='number'?error.code:1):0});
        });
      });
      const rp=resolvePath(String(payload.path||''));
      switch(name){
        case 'fs_list':{const entries=await fs.readdir(rp,{withFileTypes:true}),items=[];for(const item of entries){try{const stat=await fs.stat(path.join(rp,item.name));items.push({name:item.name,isDir:stat.isDirectory(),size:stat.size,mtime:stat.mtimeMs/1000});}catch{}}return{items};}
        case 'fs_read':{const content=await fs.readFile(rp,'utf8');return{content,revision:revision(content)};}
        case 'fs_write':return await exclusive(path.resolve(rp),async()=>{
          if(payload.ifRevision!==undefined){let current=null;try{current=revision(await fs.readFile(rp));}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==payload.ifRevision)throw new Error('FILE_CONFLICT: file changed on robot; reload or save your changes to another file');}
          const content=String(payload.content??'');await fs.mkdir(path.dirname(rp),{recursive:true});await fs.writeFile(rp,content,'utf8');return{revision:revision(content)};
        });
        case 'fs_mkdir':await fs.mkdir(rp,{recursive:true});return{};
        case 'fs_rename':await fs.rename(resolvePath(payload.from),resolvePath(payload.to));return{};
        case 'fs_delete':await fs.rm(rp,{recursive:!!payload.isDir,force:true});return{};
        case 'library_read':{const file=path.join(config.data_dir||path.join(os.homedir(),'.ros2ide'),'components.json');try{const content=await fs.readFile(file,'utf8');return{items:JSON.parse(content),revision:revision(content)};}catch(e){if(e.code==='ENOENT')return{items:[],revision:null};throw e;}}
        case 'library_write':{
          if(!Array.isArray(payload.items)||JSON.stringify(payload.items).length>5*1024*1024)throw new Error('Invalid component library');
          const file=path.join(config.data_dir||path.join(os.homedir(),'.ros2ide'),'components.json');
          return await exclusive(file,async()=>{
            let current=null;try{current=revision(await fs.readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
            if(payload.ifRevision!==current)throw new Error('FILE_CONFLICT: component library changed; download robot library before saving');
            const content=JSON.stringify(payload.items);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.pending';await fs.writeFile(temp,content,{mode:0o600});await fs.rename(temp,file);return{revision:revision(content)};
          });
        }
        default:throw new Error('Unknown action: '+name);
      }
    }finally{busy--;}
  }
  async function handle(l,msg){
    if(msg.type==='request'){
      try{l.send({type:'response',reqId:msg.reqId,ok:true,data:await action(l,msg.action,msg.payload,msg)});}
      catch(e){l.send({type:'response',reqId:msg.reqId,ok:false,error:e.message});}
      return;
    }
    if(!String(msg.type).startsWith('pty_'))return;
    // Closing a terminal is always permitted, even after a lost connection.
    if(msg.type==='pty_close'){kill(l,msg.termId);return;}
    try{
      guard(l,msg);
      if(autoState().active)throw new Error('Agent update is in progress');
      const id=String(msg.termId||'');if(!/^[a-zA-Z0-9_-]{1,150}$/.test(id))throw new Error('Invalid terminal ID');
      const dimension=(v,fallback)=>Math.max(2,Math.min(500,Math.trunc(Number(v)||fallback)));
      if(msg.type==='pty_init'){
        if(l.terminals.has(id))return;
        const terminal=pty.spawn(process.env.SHELL||'/bin/bash',['-i'],{name:'xterm-256color',cols:dimension(msg.cols,120),rows:dimension(msg.rows,30),cwd:os.homedir(),env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'}});
        l.terminals.set(id,terminal);
        terminal.onData(data=>{if(!l.closed)l.output.write(id,data);});
        terminal.onExit(()=>{l.output.flushTerm(id);l.terminals.delete(id);l.send({type:'pty_closed',termId:id});});
      }else if(msg.type==='pty_input'&&typeof msg.data==='string'){
        // Robot-issued tickets bound queued control input age without synchronized clocks.
        if(/^(tune|mapping|navigation)_/.test(id)&&(!tickets.has(msg.commandToken)||performance.now()-tickets.get(msg.commandToken)>1500))throw new Error('Stale control input rejected; reconnect the control tool');
        l.terminals.get(id)?.write(msg.data);
      }
      else if(msg.type==='pty_resize')l.terminals.get(id)?.resize(dimension(msg.cols,120),dimension(msg.rows,30));
    }catch(error){kill(l,msg.termId);l.send({type:'pty_output',termId:msg.termId,data:Buffer.from('\r\n'+error.message+'\r\n').toString('base64')});l.send({type:'pty_closed',termId:msg.termId});}
  }
  return{link,close,handle,action,status,pulse};
}
function lanInterfaces(){return Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal).map(i=>({address:i.address,netmask:i.netmask}));}
function localUrls(port){return lanInterfaces().map(i=>`http://${i.address}:${port}/`);}

async function start(){
  const configPath=process.env.ROSIDE_AGENT_CONFIG||path.join(os.homedir(),'.ros2ide','config.json');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  config.data_dir=path.dirname(configPath);config.local_port=Number(config.local_port)||3080;
  if(!Number.isInteger(config.local_port)||config.local_port<1||config.local_port>65535)throw new Error('Invalid local_port');
  if(!config.local_secret){config.local_secret=crypto.randomBytes(32).toString('base64url');await fs.writeFile(configPath,JSON.stringify(config,null,2),{mode:0o600});await fs.chmod(configPath,0o600);}
  const accessFile=path.join(config.data_dir,'local-access.txt');
  await fs.writeFile(accessFile,`ROSIDE Local: ${localUrls(config.local_port).join(' or ')}\nOpen from the Cloud robot page for automatic Local access. A browser on this robot may open Local directly.\nUse only on a trusted isolated LAN; HTTP is not encrypted.\n`,{mode:0o600});
  await fs.chmod(accessFile,0o600);
  function saveConfig(changes){const next={...config,...changes};fss.writeFileSync(configPath+'.pending',JSON.stringify(next,null,2),{mode:0o600});fss.renameSync(configPath+'.pending',configPath);Object.assign(config,next);}
  const autoUpdater=require('./agent-auto-update').createAutoUpdater({config,configPath,version:VERSION});
  const WebSocket=require('ws'),runtime=createRuntime({pty:require(require.resolve('node-pty',{paths:[__dirname,path.join(__dirname,'agent')]})),config,persistMode:mode=>saveConfig({active_mode:mode}),persistSafety:topic=>saveConfig({auto_update_topic:topic}),autoState:()=>autoUpdater.status()});
  autoUpdater.start(()=>runtime.status());
  let stopping=false,localChild=null,restartTimer=null;
  const sockets=new Set(),timers=new Set();
  function connect(kind,url){
    if(stopping)return;
    let socket;try{socket=new WebSocket(url,{perMessageDeflate:false,handshakeTimeout:10000});}catch(e){console.error('[AGENT]',kind,e.message);return;}
    sockets.add(socket);
    const send=obj=>{if(socket.readyState===WebSocket.OPEN){if(socket.bufferedAmount>8*1024*1024)return socket.terminate();socket.send(JSON.stringify(obj));}};
    const link=runtime.link(kind,send);
    socket.on('open',()=>{socket._socket?.setNoDelay(true);send({type:'auth',robotKey:config.robot_key,username:os.userInfo().username,...runtime.status(),...(kind==='local'?{localSecret:config.local_secret}:{})});});
    socket.on('message',raw=>{let message;try{message=JSON.parse(raw);}catch{return;}
      if(kind==='online'&&message.type==='auth_ok'&&typeof message.workspace==='string'&&message.workspace.length<4096){
        // Persist canonical robot workspace; the Local broker reads it on connection.
        try{if(config.workspace!==message.workspace)saveConfig({workspace:message.workspace});}catch(e){console.error('[AGENT] Config:',e.message);}
      }
      runtime.handle(link,message).catch(e=>console.error('[AGENT]',e.message));});
    socket.on('close',()=>{runtime.close(link);sockets.delete(socket);if(!stopping){const timer=setTimeout(()=>{timers.delete(timer);connect(kind,url);},2000+Math.random()*1000);timers.add(timer);}});
    socket.on('error',()=>socket.terminate());
  }
  function startLocal(){
    if(stopping||config.local_enabled===false)return;
    localChild=spawn(process.execPath,[path.join(__dirname,'server.js')],{cwd:__dirname,stdio:'inherit',env:{...process.env,ROSIDE_LOCAL_CONFIG:configPath,PORT:String(config.local_port),PUBLIC_URL:'',ENC_KEY:crypto.randomBytes(32).toString('hex'),AUTH_TOKEN_SECRET:crypto.randomBytes(32).toString('hex')}});
    localChild.on('exit',()=>{localChild=null;if(!stopping)restartTimer=setTimeout(startLocal,3000);});
  }
  startLocal();
  if(config.local_enabled!==false)connect('local',`ws://127.0.0.1:${config.local_port}/ws/agent`);
  if(config.cloud_url)connect('online',config.cloud_url);
  const pulseTimer=setInterval(()=>runtime.pulse(),250);
  console.log(`[AGENT ${VERSION}] Local access instructions: ${accessFile}`);
  const stop=()=>{stopping=true;autoUpdater.stop();clearInterval(pulseTimer);for(const timer of timers)clearTimeout(timer);clearTimeout(restartTimer);for(const socket of sockets)socket.terminate();localChild?.kill('SIGTERM');setTimeout(()=>process.exit(0),1000).unref();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  return{runtime,stop};
}
module.exports={VERSION,CAPABILITIES,createRuntime,revision,start,localUrls,lanInterfaces};
