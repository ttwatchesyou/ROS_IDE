'use strict';
const runtimePath=['agent-runtime.js','../agent-runtime.js'].map(file=>require('path').join(__dirname,file)).find(file=>require('fs').existsSync(file));
if(runtimePath){
  require(runtimePath).start().catch(error=>{console.error('[AGENT]',error.message);process.exitCode=1;});
}else{
const WebSocket=require('ws');
const pty=require('node-pty');
const fs=require('fs').promises;
const path=require('path');
const os=require('os');
const{exec}=require('child_process');

const CONFIG_FILE=path.join(os.homedir(),'.ros2ide','config.json');
async function loadConfig(){
  try{const raw=await fs.readFile(CONFIG_FILE,'utf8');return JSON.parse(raw);}
  catch{return{robot_key:process.env.ROBOT_KEY||'UNREGISTERED',cloud_url:process.env.CLOUD_URL||'ws://localhost:3001/ws/agent'};}
}

let ws=null,reconnMs=500,reconnecting=false;
const terminals=new Map();
const ptyOutputBuffers=new Map();
let ptyFlushTimer=null;

function resolvePath(p=''){
  if(p.startsWith('~/'))return path.join(os.homedir(),p.slice(2));
  if(p==='~')return os.homedir(); return p;
}
function send(obj){if(ws&&ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>8*1024*1024){ws.terminate();return;}ws.send(JSON.stringify(obj));}}
function flushPtyOutput(){
  ptyFlushTimer=null;
  for(const[termId,data]of ptyOutputBuffers){ptyOutputBuffers.delete(termId);send({type:'pty_output',termId,data:Buffer.from(data).toString('base64')});}
}
function queuePtyOutput(termId,data){
  const next=(ptyOutputBuffers.get(termId)||'')+data;ptyOutputBuffers.set(termId,next);
  if(Buffer.byteLength(next)>64*1024)return flushPtyOutput();
  if(!ptyFlushTimer)ptyFlushTimer=setTimeout(flushPtyOutput,4);
}
function closeTerminals(){
  if(ptyFlushTimer){clearTimeout(ptyFlushTimer);ptyFlushTimer=null;}ptyOutputBuffers.clear();
  terminals.forEach((_,id)=>killPty(id));
}

async function connect(){
  if(reconnecting)return; reconnecting=true;
  const cfg=await loadConfig();
  console.log(`[AGENT] Connecting to ${cfg.cloud_url} ...`);
  ws=new WebSocket(cfg.cloud_url,{perMessageDeflate:false,handshakeTimeout:10000});
  ws.on('open',()=>{console.log(`[AGENT] ✅ Connected (Key: ${cfg.robot_key})`);reconnMs=500;reconnecting=false;ws._socket?.setNoDelay(true);ws._socket?.setKeepAlive(true,30000);send({type:'auth',robotKey:cfg.robot_key,username:os.userInfo().username});});
  ws.on('message',raw=>{let msg;try{msg=JSON.parse(raw);}catch{return;}handleMsg(msg);});
  ws.on('close',code=>{reconnecting=false;closeTerminals();const delay=Math.round(reconnMs*(.85+Math.random()*.3));console.log(`[AGENT] ❌ Retry in ${delay/1000}s`);setTimeout(connect,delay);reconnMs=Math.min(reconnMs*1.7,30000);});
  ws.on('error',err=>{console.error('[AGENT]',err.message);reconnecting=false;ws.terminate();});
}

async function handleMsg(msg){
  switch(msg.type){
    case 'auth_ok': console.log('[AGENT] 🔑 Auth OK:',msg.robotName||'registered'); break;
    case 'auth_pending': console.log('[AGENT] ⏳',msg.message); break;
    case 'request':{const{reqId,action,payload}=msg;try{const d=await handleAction(action,payload);send({type:'response',reqId,ok:true,data:d});}catch(e){send({type:'response',reqId,ok:false,error:e.message});}break;}
    case 'pty_init': startPty(msg.termId,msg.cols||120,msg.rows||30); break;
    case 'pty_input':{const t=terminals.get(msg.termId);if(t)t.write(msg.data);break;}
    case 'pty_resize':{const t=terminals.get(msg.termId);if(t)t.resize(msg.cols||120,msg.rows||30);break;}
    case 'pty_close': killPty(msg.termId); break;
  }
}

async function handleAction(action,payload={}){
  if(action==='exec'){return new Promise((resolve,reject)=>{const child=exec(payload.command,{shell:'/bin/bash',timeout:Math.min(payload.timeout||30000,300000),maxBuffer:4*1024*1024});let stdout='',stderr='';child.stdout?.on('data',d=>stdout+=d);child.stderr?.on('data',d=>stderr+=d);child.on('close',code=>resolve({stdout:stdout.trim(),stderr:stderr.trim(),code}));child.on('error',reject);});}
  const rp=resolvePath(payload.path||'');
  switch(action){
    case 'fs_list':{const e=await fs.readdir(rp,{withFileTypes:true});const items=[];for(const f of e){try{const s=await fs.stat(path.join(rp,f.name));items.push({name:f.name,isDir:f.isDirectory(),size:s.size,mtime:s.mtimeMs/1000});}catch{}}return{items};}
    case 'fs_read': return{content:await fs.readFile(rp,'utf8')};
    case 'fs_write': await fs.mkdir(path.dirname(rp),{recursive:true});await fs.writeFile(rp,payload.content??'','utf8');return{};
    case 'fs_mkdir': await fs.mkdir(rp,{recursive:true});return{};
    case 'fs_rename': await fs.rename(resolvePath(payload.from||''),resolvePath(payload.to||''));return{};
    case 'fs_delete': await fs.rm(rp,{recursive:!!payload.isDir,force:true});return{};
    default: throw new Error('Unknown action: '+action);
  }
}

function startPty(termId,cols=120,rows=30){
  if(terminals.has(termId))return;
  const p=pty.spawn(process.env.SHELL||'/bin/bash',['-i'],{name:'xterm-256color',cols,rows,cwd:os.homedir(),env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'}});
  p.onData(data=>queuePtyOutput(termId,data));
  p.onExit(({exitCode})=>{terminals.delete(termId);send({type:'pty_closed',termId});console.log(`[AGENT] PTY closed: ${termId} (${exitCode})`);});
  terminals.set(termId,p);
  console.log(`[AGENT] PTY: ${termId} (${cols}x${rows})`);
}
function killPty(id){const t=terminals.get(id);if(t){try{t.kill();}catch{}terminals.delete(id);}}

process.on('SIGINT',()=>{closeTerminals();if(ws)ws.close();process.exit(0);});
process.on('SIGTERM',()=>{closeTerminals();if(ws)ws.close();process.exit(0);});

connect();
}
