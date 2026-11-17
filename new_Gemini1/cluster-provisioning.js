'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {Client} = require('ssh2');

const jobs = new Map();
const binary = path.join(__dirname, 'dist', 'roside-cluster-worker');
const installer = path.join(__dirname, 'cluster-worker-install.sh');
const validHost = value => typeof value === 'string' && (net.isIP(value) || (/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value) && !value.endsWith('.')));
const validRoot = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..');
const validUrl = value => {try {const url = new URL(value); return url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost','127.0.0.1','::1'].includes(url.hostname));} catch {return false;}};
const secureRequest = req => req.secure || ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const fail = (status, message) => Object.assign(new Error(message), {status});
function validateTarget(body) {
  const host = String(body.host || '').trim(), port = Number(body.port ?? 22), username = String(body.username || '').trim();
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) throw fail(400, 'Invalid SSH host, port, or username');
  return {host, port, username};
}
function scanHost(host, port) {
  return new Promise((resolve, reject) => execFile('ssh-keyscan', ['-T','5','-p',String(port),'-t','ed25519,ecdsa,rsa',host], {timeout:12000,maxBuffer:65536}, (error,stdout) => {
    const keys = [...new Map(stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 3 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)/.test(fields[1])) return null;
      const digest = crypto.createHash('sha256').update(Buffer.from(fields[2], 'base64')).digest();
      return [digest.toString('hex'), {type:fields[1],fingerprint:'SHA256:'+digest.toString('base64').replace(/=+$/,''),hash:digest.toString('hex')}];
    }).filter(Boolean))].map(([,value])=>value);
    if (!keys.length) reject(fail(502, 'SSH host key unavailable; check host and port')); else resolve(keys);
  }));
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function connect(target, password, fingerprints) {
  return new Promise((resolve,reject) => {
    const client = new Client();
    let settled = false;
    client.once('ready', () => {settled=true; resolve(client);});
    client.once('error', error => {if(!settled){settled=true;reject(error);}});
    client.connect({...target,password,hostHash:'sha256',hostVerifier:key=>fingerprints.includes(key),readyTimeout:15000,tryKeyboard:false});
  });
}
function command(client, text, input, timeout=120000) {
  return new Promise((resolve,reject) => {
    client.exec(text, (error,stream) => {
      if(error) return reject(error);
      let output='', done=false;
      const timer=setTimeout(()=>{if(!done){stream.close();reject(fail(504,'Remote command timed out'));}},timeout);
      for(const channel of [stream,stream.stderr]) channel.on('data', chunk=>{output=(output+chunk.toString()).slice(-6000);});
      stream.once('close',code=>{done=true;clearTimeout(timer);if(code===0)resolve(output);else reject(fail(502,`Remote command failed (${code}): ${output.slice(-1200)}`));});
      if(input)stream.end(input+'\n');else stream.end();
    });
  });
}
function sftpFor(client) {return new Promise((resolve,reject)=>client.sftp((error,sftp)=>error?reject(error):resolve(sftp)));}
function upload(sftp, local, remote, mode, onProgress) {
  return new Promise((resolve,reject)=>{
    const source=fs.createReadStream(local),dest=sftp.createWriteStream(remote,{mode});
    let complete=false;
    const finish=error=>{if(complete)return;complete=true;error?reject(error):resolve();};
    source.on('data',chunk=>onProgress(chunk.length));source.once('error',finish);dest.once('error',finish);dest.once('close',()=>finish());source.pipe(dest);
  });
}
async function run(job, options) {
  const {target,password,sudoPassword,fingerprints,config}=options;
  let client,remoteDir;
  const set=(stage,progress)=>{job.stage=stage;job.progress=progress;job.updatedAt=new Date().toISOString();};
  try {
    set('กำลังเชื่อมต่อ SSH',5);
    client=await connect(target,password,fingerprints);
    remoteDir='/tmp/roside-cluster-'+crypto.randomBytes(12).toString('hex');
    await command(client,`mkdir -m 700 -- ${quote(remoteDir)}`);
    set('กำลังส่ง Worker ไปเครื่องปลายทาง',10);
    const sftp=await sftpFor(client),size=fs.statSync(binary).size;
    let sent=0;
    await upload(sftp,binary,remoteDir+'/roside-cluster-worker',0o700,bytes=>{sent+=bytes;set('กำลังส่ง Worker ไปเครื่องปลายทาง',Math.min(80,10+Math.round(sent/size*70)));});
    await upload(sftp,installer,remoteDir+'/install.sh',0o700,()=>{});
    const configPath=remoteDir+'/config.json';
    await new Promise((resolve,reject)=>{const stream=sftp.createWriteStream(configPath,{mode:0o600});stream.once('error',reject);stream.once('close',resolve);stream.end(JSON.stringify(config)+'\n');});
    set('กำลังติดตั้งและเริ่มบริการ',85);
    const shell=`cd ${quote(remoteDir)} && ${target.username==='root'?'bash install.sh':"sudo -S -p '' bash install.sh"}`;
    await command(client,shell,target.username==='root'?null:sudoPassword,180000);
    set('ติดตั้งสำเร็จ รอ Worker เชื่อมต่อ',100);
    job.status='success';
  } catch(error) {
    job.status='error';job.stage='ติดตั้งไม่สำเร็จ';
    job.error=String(error.message||error).replaceAll(password,'[redacted]').replaceAll(sudoPassword||'\u0000','[redacted]').slice(0,1400);
  } finally {
    if(client){if(remoteDir)await command(client,`rm -rf -- ${quote(remoteDir)}`).catch(()=>{});client.end();}
    job.updatedAt=new Date().toISOString();
    setTimeout(()=>jobs.delete(job.id),30*60*1000).unref();
  }
}
function mountClusterProvisioning(app,{db,auth}) {
  const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(error){res.status(error.status||500).json({ok:false,error:error.message});}};
  const admin=(req,res)=>{if(req.user.role!=='admin'){res.status(403).json({ok:false,error:'Master admin only'});return false;}return true;};
  app.post('/api/clusters/ssh-key',auth,wrap(async(req,res)=>{
    if(!admin(req,res))return;
    const {host,port}=validateTarget({...req.body,username:'root'});
    res.json({ok:true,keys:await scanHost(host,port)});
  }));
  app.post('/api/clusters/:id/provision',auth,wrap(async(req,res)=>{
    if(!admin(req,res))return;
    if(!secureRequest(req))throw fail(403,'Use HTTPS to send the SSH password');
    const id=Number(req.params.id),body=req.body||{};
    if(!Number.isSafeInteger(id)||id<1)throw fail(400,'Invalid cluster');
    const [[cluster]]=await db.query('SELECT id,kind,enabled,cluster_key,secret_hash FROM clusters WHERE id=?',[id]);
    if(!cluster||cluster.kind!=='worker'||!cluster.enabled)throw fail(409,'Worker Cluster unavailable');
    const target=validateTarget(body),password=body.password,sudoPassword=target.username==='root'?undefined:(body.sudoPassword||body.password);
    if(typeof password!=='string'||!password||password.length>1024||typeof sudoPassword==='string'&&sudoPassword.length>1024)throw fail(400,'SSH password is required');
    if(!Array.isArray(body.fingerprints)||!body.fingerprints.length||body.fingerprints.length>8||body.fingerprints.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))throw fail(400,'Confirm the SSH host fingerprint first');
    if(!validUrl(body.masterUrl)||!validRoot(body.workspaceRoot))throw fail(400,'Invalid Master URL or shared workspace path');
    if(typeof body.secret!=='string'||body.secret.length<20)throw fail(400,'Worker key unavailable; rotate it first');
    const actual=crypto.createHash('sha256').update(body.secret).digest(),expected=Buffer.from(cluster.secret_hash||'','hex');
    if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))throw fail(403,'Worker key does not match this Cluster');
    if(!fs.existsSync(binary))throw fail(503,'Worker binary has not been built on Master');
    if([...jobs.values()].some(job=>job.clusterId===id&&job.status==='running'))throw fail(409,'Installation already running for this Cluster');
    const job={id:crypto.randomUUID(),clusterId:id,status:'running',stage:'กำลังเตรียมติดตั้ง',progress:0,updatedAt:new Date().toISOString()};
    jobs.set(job.id,job);
    const options={target,password,sudoPassword,fingerprints:body.fingerprints,config:{master_url:body.masterUrl,cluster_key:cluster.cluster_key,cluster_secret:body.secret,workspace_root:body.workspaceRoot}};
    delete body.password;delete body.sudoPassword;delete body.secret;
    run(job,options);
    res.status(202).json({ok:true,job});
  }));
  app.get('/api/clusters/:id/provision/:jobId',auth,wrap(async(req,res)=>{
    if(!admin(req,res))return;
    const job=jobs.get(req.params.jobId);
    if(!job||job.clusterId!==Number(req.params.id))throw fail(404,'Installation job not found');
    res.json({ok:true,job});
  }));
}
module.exports={mountClusterProvisioning,validateTarget,validRoot,validUrl};
