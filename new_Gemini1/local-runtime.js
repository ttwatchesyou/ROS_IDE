'use strict';
// Local identity is deliberately independent of MySQL/cloud membership.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
function createLocalRuntime(configPath){
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(config.robot_key)||/^sim[_-]/i.test(config.robot_key))throw new Error('Local mode requires a physical robot key');
  if(typeof config.local_secret!=='string'||config.local_secret.length<32)throw new Error('Missing local Agent secret');
  if(config.local_origin){const origin=new URL(config.local_origin);if(origin.protocol!=='https:'||origin.origin!==config.local_origin)throw new Error('local_origin must be an HTTPS origin without a path');}
  const tokens=new Map(),handoffs=new Map();
  const robot={id:1,robot_key:config.robot_key,name:config.robot_name||os.hostname(),workspace:config.workspace||'~/ros2_ws',ssh_user:os.userInfo().username,ssh_pass:'',added_by:1};
  Object.defineProperty(robot,'workspace',{enumerable:true,get(){try{return JSON.parse(fs.readFileSync(configPath,'utf8')).workspace||'~/ros2_ws';}catch{return config.workspace||'~/ros2_ws';}}});
  const user={id:1,username:'local-operator',role:'user'};
  const membership={planCode:'local',name:'Local operator',isPro:true,isUnlimited:true,status:'active'};
  function cloudRobotSelector(){
    try{
      const url=new URL(config.cloud_url);
      if(!['ws:','wss:','http:','https:'].includes(url.protocol)||url.username||url.password)return null;
      url.protocol=url.protocol==='wss:'?'https:':url.protocol==='ws:'?'http:':url.protocol;
      url.pathname='/robots';url.search='';url.hash='';
      return url.href;
    }catch{return null;}
  }
  function matches(value){const a=Buffer.from(String(value||'')),b=Buffer.from(config.local_secret);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
  function tokenUser(token){const session=tokens.get(token);if(!session)return null;if(session.expiresAt<Date.now()){tokens.delete(token);return null;}return{...user,username:session.username||user.username,sessionId:token};}
  function validHost(req){
    try{const hostname=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'');
      const allowed=new Set(['localhost','127.0.0.1','::1',os.hostname(),os.hostname()+'.local',...Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i=>i.address),...(config.local_origin?[new URL(config.local_origin).hostname]:[]),...(config.local_hosts||[])]);
      return allowed.has(hostname);
    }catch{return false;}
  }
  function sameOrigin(req){return !req.headers.origin||req.headers.origin===`http://${req.headers.host}`||(agentAllowed(req)&&config.local_origin&&req.headers.origin===config.local_origin);}
  function agentAllowed(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
  function sameMachineBrowser(req){
    if(req.headers['x-forwarded-for']||req.headers.forwarded)return false;
    const remote=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
    let host;try{host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'');}catch{return false;}
    if(['127.0.0.1','::1'].includes(remote))return ['localhost','127.0.0.1','::1'].includes(host);
    return host===remote&&Object.values(os.networkInterfaces()).flat().some(entry=>entry?.address===remote&&!entry.internal);
  }
  const guarded=(fn)=>(req,res)=>Promise.resolve(fn(req,res)).catch(error=>res.status(error.status||400).json({ok:false,error:error.message}));
  function mount(app,{auth,requestAuthToken,sessions,createRobotSession,closeOperationalSockets,closeRobotPresence,robotOnline,inspectRobotWizardProgress,agentReq}){
    // Positive allowlist: no billing, administration, catalog or Sim operations.
    app.use((req,res,next)=>{
      if(!validHost(req)||!sameOrigin(req))return res.status(403).json({ok:false,error:'Local origin not allowed'});
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      next();
    });
    app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'public','local.html')));
    // Cached Local clients still navigate to /robots when disconnecting.
    // Send them to the Cloud selector instead of looping through Local login.
    app.get('/robots',(_,res)=>{
      const destination=cloudRobotSelector();
      if(!destination)return res.status(503).send('Cloud URL is not configured');
      res.redirect(302,destination);
    });
    app.get('/applications',(_,res)=>res.redirect('/'));
    app.get('/api/local/info',(_,res)=>{
      res.json({ok:true,local:true,name:robot.name,cloudUrl:cloudRobotSelector()});
    });
    app.post('/api/local/auto',(req,res)=>{
      if(!sameMachineBrowser(req))return res.status(403).json({ok:false,error:'เปิด Local จากหน้า Cloud บนเครื่องนี้เพื่อยืนยันสิทธิ์'});
      if(tokens.size>=100)return res.status(429).json({ok:false,error:'Too many local sessions'});
      const token=crypto.randomBytes(32).toString('base64url');tokens.set(token,{expiresAt:Date.now()+12*3600000});
      res.json({ok:true,token,user});
    });
    // The Cloud grants a short-lived, single-use ticket through its authenticated
    // Agent socket. Only the Agent on this robot may prepare it over loopback.
    app.post('/api/local/handoff/prepare',(req,res)=>{
      if(!agentAllowed(req)||!matches(req.headers['x-local-agent-secret']))return res.status(403).json({ok:false,error:'Agent only'});
      const {ticket,sudoPassword,username}=req.body||{};
      if(!/^[A-Za-z0-9_-]{43}$/.test(ticket||'')||typeof sudoPassword!=='string'||sudoPassword.length>4096||typeof username!=='string'||username.length>120)return res.status(400).json({ok:false,error:'Invalid handoff'});
      const now=Date.now();for(const[key,entry]of handoffs)if(entry.expiresAt<=now)handoffs.delete(key);
      if(handoffs.size>=100)return res.status(429).json({ok:false,error:'Too many handoffs'});
      handoffs.set(crypto.createHash('sha256').update(ticket).digest('hex'),{sudoPassword,username,expiresAt:now+60000});
      res.json({ok:true});
    });
    app.post('/api/local/handoff',(req,res)=>{
      const ticket=String(req.body?.ticket||'');
      if(!/^[A-Za-z0-9_-]{43}$/.test(ticket))return res.status(401).json({ok:false,error:'Invalid handoff'});
      const key=crypto.createHash('sha256').update(ticket).digest('hex'),entry=handoffs.get(key);
      handoffs.delete(key);
      if(!entry||entry.expiresAt<=Date.now())return res.status(401).json({ok:false,error:'Handoff expired; open the robot again from Cloud'});
      if(tokens.size>=100)return res.status(429).json({ok:false,error:'Too many local sessions'});
      const token=crypto.randomBytes(32).toString('base64url');tokens.set(token,{expiresAt:Date.now()+12*3600000,sudoPassword:entry.sudoPassword,username:entry.username});
      res.json({ok:true,token,user:{...user,username:entry.username}});
    });
    app.get('/api/auth/me',auth,(req,res)=>res.json({ok:true,user:req.user,membership}));
    app.post('/api/auth/logout',auth,(req,res)=>{tokens.delete(requestAuthToken(req));closeOperationalSockets(user.id,robot.robot_key,'Local logout');res.json({ok:true});});
    const connect=guarded(async(req,res)=>{
      if(req.body.robotId&&Number(req.body.robotId)!==1)return res.status(404).json({ok:false,error:'Only the local robot is available'});
      // Pairing authorizes Local control. Switch before the session probes ROS,
      // otherwise the Agent correctly rejects that first exec in Online mode.
      await agentReq(robot.robot_key,'control_select',{mode:'local',confirm:true},3000);
      const result=await createRobotSession(robot,user,{recordConnection:false});
      result.workspace=robot.workspace;sessions.get(result.sessionId).workspace=robot.workspace;
      const localLogin=tokens.get(requestAuthToken(req));
      // A same-machine offline login must never inherit sudo from a previous Cloud
      // handoff if createRobotSession reuses the same local robot session.
      sessions.get(result.sessionId).sudoPassword=typeof localLogin?.sudoPassword==='string'?localLogin.sudoPassword:'';
      res.json(result);
    });
    app.post('/api/connect',auth,connect);app.post('/api/session/restore',auth,connect);
    app.post('/api/disconnect',auth,(req,res)=>{sessions.delete(req.body.sessionId);closeOperationalSockets(user.id,robot.robot_key,'Local disconnect');closeRobotPresence(user.id,robot.robot_key);res.json({ok:true});});
    app.get('/api/robots',auth,(_,res)=>res.json({ok:true,robots:[{...robot,online:robotOnline(robot.robot_key),isOwner:true}]}));
    app.post('/api/robots/progress',auth,guarded(async(_,res)=>res.json({ok:true,robots:[{id:1,wizardProgress:await inspectRobotWizardProgress(robot)}]})));
    const allowed=new Set(['/api/system-images/prepare','/api/health','/api/exec','/api/kill-node','/api/dashboard','/api/dashboard/project','/api/sim/save-tf-package','/api/sim/save-odom-package','/api/sim/save-robot-config',
      '/api/files/list','/api/files/read','/api/files/write','/api/files/mkdir','/api/files/rename','/api/files/delete',
      '/api/lidar/status','/api/lidar/build','/api/lidar/install','/api/lidar/driver','/api/lidar/scan','/api/mapping/runtime','/api/mapping/save','/api/mapping/check',
      '/api/navigation/maps','/api/navigation/map-data','/api/navigation/runtime','/api/serial/ports','/api/serial/prepare','/api/real/system-check',
      '/api/real/agent/status','/api/real/agent/mode','/api/real/agent/auto-update','/api/real/library/read','/api/real/library/write']);
    app.use((req,res,next)=>req.path.startsWith('/api/')&&!allowed.has(req.path)?res.status(404).json({ok:false,error:'Cloud/Simulation feature unavailable in Local mode'}):next());
  }
  return{config,robot,membership,tokenUser,matches,validHost,sameOrigin,agentAllowed,mount};
}
module.exports={createLocalRuntime};
