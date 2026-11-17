'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {validRoot,validUrl}=require('./cluster-provisioning');

const PAIR_TTL=30*60*1000;
const pairs=new Map();
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function revokeClusterCodes(clusterId){for(const [hash,pair] of pairs)if(pair.clusterId===Number(clusterId))pairs.delete(hash);}
const secure=req=>req.secure||['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const error=(status,message)=>Object.assign(new Error(message),{status});
function pairFromCode(code){
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(code))return null;
  const pair=pairs.get(digest(code));
  if(!pair)return null;
  if(pair.expiresAt<Date.now()){pairs.delete(digest(code));return null;}
  return pair;
}
function prepareMasterWorkspace(id,workspace){
  const group=`roside-cluster-${id}`;
  const exportFile=`/etc/exports.d/roside-cluster-${id}.exports`;
  let exports;
  try{exports=fs.readFileSync(exportFile,'utf8');}catch{throw error(503,'Master ยังไม่ได้เปิดแชร์โฟลเดอร์ Sim ของ Cluster นี้');}
  if(!exports.split(/\r?\n/).some(line=>line.startsWith(`${workspace} `)))throw error(503,'Master แชร์โฟลเดอร์ Sim ไม่ตรงกับ Cluster นี้');
  try{
    execFileSync('getent',['group',group],{stdio:'ignore',timeout:5000});
    execFileSync('systemctl',['is-active','--quiet','nfs-server'],{stdio:'ignore',timeout:5000});
    for(let dir=workspace;dir!==path.dirname(dir);dir=path.dirname(dir)){
      if(fs.statSync(dir).uid!==process.getuid())continue;
      execFileSync('setfacl',['-m',`g:${group}:${dir===workspace?'rwx':'--x'}`,dir],{stdio:'ignore',timeout:5000});
      if(dir===workspace)execFileSync('setfacl',['-m',`d:g:${group}:rwx`,dir],{stdio:'ignore',timeout:5000});
    }
  }catch{throw error(503,'Master ยังตั้งค่า NFS หรือสิทธิ์โฟลเดอร์ Sim ไม่ครบ');}
}
function mountClusterBootstrap(app,{db,auth,clusterBus,prepareWorkspace=prepareMasterWorkspace}){
  const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(err){res.status(err.status||500).json({ok:false,error:err.message});}};
  app.get('/api/cluster-bootstrap/bootstrap.sh',(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.type('text/x-shellscript');res.sendFile(path.join(__dirname,'cluster-bootstrap.sh'));
  });
  app.get('/api/cluster-bootstrap/install.sh',(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.type('text/x-shellscript');res.sendFile(path.join(__dirname,'cluster-worker-install.sh'));
  });
  app.post('/api/clusters/:id/bootstrap',auth,wrap(async(req,res)=>{
    if(req.user.role!=='admin')throw error(403,'Master admin only');
    if(!secure(req))throw error(403,'Use HTTPS to create an install code');
    const id=Number(req.params.id),{masterUrl,workspaceRoot,secret}=req.body||{};
    if(!Number.isSafeInteger(id)||id<1||id>15000||!validUrl(masterUrl)||!validRoot(workspaceRoot))throw error(400,'Invalid Worker settings');
    const [[cluster]]=await db.query('SELECT id,cluster_key,secret_hash,kind,enabled FROM clusters WHERE id=?',[id]);
    if(!cluster||cluster.kind!=='worker'||!cluster.enabled)throw error(409,'Worker Cluster unavailable');
    const binary=path.join(__dirname,'dist','roside-cluster-worker');
    if(!fs.existsSync(binary))throw error(503,'Worker binary unavailable');
    const masterHost=new URL(masterUrl).hostname;
    if(masterHost.includes(':'))throw error(400,'Use a hostname or IPv4 address for the Master URL');
    const masterWorkspace=path.join(__dirname,'sim_ws',`CL-${id}`);
    fs.mkdirSync(masterWorkspace,{recursive:true});
    prepareWorkspace(id,masterWorkspace);
    let workerSecret=secret;
    if(workerSecret===undefined){
      if(clusterBus?.connected(id))throw error(409,'Worker is already online; disconnect it before creating a replacement install code');
      workerSecret=crypto.randomBytes(32).toString('base64url');
      await db.query('UPDATE clusters SET secret_hash=? WHERE id=?',[digest(workerSecret),id]);
    }else{
      if(typeof workerSecret!=='string'||workerSecret.length<20)throw error(400,'Worker key is invalid');
      const expected=Buffer.from(cluster.secret_hash||'','hex'),actual=crypto.createHash('sha256').update(workerSecret).digest();
      if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))throw error(403,'Worker key does not match this Cluster');
    }
    revokeClusterCodes(id);
    for(const [hash,pair] of pairs)if(pair.expiresAt<Date.now())pairs.delete(hash);
    const code=crypto.randomBytes(18).toString('base64url'),expiresAt=Date.now()+PAIR_TTL;
    pairs.set(digest(code),{clusterId:id,expiresAt,config:{master_url:masterUrl,cluster_key:cluster.cluster_key,cluster_secret:workerSecret,workspace_root:workspaceRoot,workspace_gid:40000+id,nfs_source:`${masterHost}:${masterWorkspace}`}});
    res.setHeader('Cache-Control','no-store');res.json({ok:true,code,expiresAt});
  }));
  app.post('/api/cluster-bootstrap/config',wrap(async(req,res)=>{
    if(!secure(req))throw error(403,'Use HTTPS for Worker setup');
    const pair=pairFromCode(req.body?.code);
    if(!pair)throw error(403,'Install code expired or invalid');
    res.setHeader('Cache-Control','no-store');res.json(pair.config);
  }));
  app.get('/api/cluster-bootstrap/worker',wrap(async(req,res)=>{
    if(!secure(req))throw error(403,'Use HTTPS for Worker download');
    const header=String(req.headers.authorization||''),pair=header.startsWith('Pair ')?pairFromCode(header.slice(5)):null;
    if(!pair)throw error(403,'Install code expired or invalid');
    const binary=path.join(__dirname,'dist','roside-cluster-worker');
    if(!fs.existsSync(binary))throw error(503,'Worker binary unavailable');
    res.setHeader('Cache-Control','no-store');res.download(binary,'roside-cluster-worker');
  }));
}
module.exports={mountClusterBootstrap,revokeClusterCodes};
