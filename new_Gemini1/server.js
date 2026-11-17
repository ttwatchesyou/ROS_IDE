'use strict';
const express  = require('express');
const http     = require('http');
const WebSocket= require('ws');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const mysql    = require('mysql2/promise');
const fs_node  = require('fs');
const {PtyJsonStream}=require('./pty-json-stream');
const {ReadRequestCache}=require('./read-request-cache');
const {RequestAdmission}=require('./request-admission');
const { execFile } = require('child_process');
const { createSimAgent, isSim, clusterIdForSim, writeTfPackage, writeOdomPackage, writeMapsimPackage, genMapsimFiles, wsRoot, toAbs } = require('./sim');
const { buildProjectScanScript, parseProjectScanOutput, scanLocalProject, inspectSimulationMissionArtifacts, readSimulationWizardProgress, resetSimulationWizardAfterFieldChange, completeSimulationWizardMapping, completeSimulationWizardNavigation } = require('./project-scanner');
const { writeNavigationPackage, writeProjectInstaller } = require('./navigation-export');
const { mapsimReadinessScript, mapsimStartCommand } = require('./mapsim-runtime');
const { MapsimQueue } = require('./mapsim-queue');
const { acquireMapsimHostLock } = require('./mapsim-host-lock');
const { getSimHostStatus,scopedSimProcesses } = require('./sim-host-status');
// Agent releases run this server in Local mode and intentionally do not ship
// Cloud Cluster administration or Worker source files.
const {ensureClusterSchema,mountClusterManagement}=process.env.ROSIDE_LOCAL_CONFIG?{}:require('./cluster-management');
const {revokeClusterCodes}=process.env.ROSIDE_LOCAL_CONFIG?{}:require('./cluster-bootstrap');
const {ClusterWorkerBus}=process.env.ROSIDE_LOCAL_CONFIG?{}:require('./cluster-worker-bus');
const { MapsimJobStore } = require('./mapsim-job-store');
const { buildRealSystemProbeCommand, parseRealSystemProbeOutput, buildRealSystemInstallCommand } = require('./real-robot-system');
const {routeForClient,browserAddress,localCandidateUrls}=require('./lan-routing');
const NavigationSettings=require('./public/navigation-settings');
const navigationRequests=new Set();
const localRuntime=process.env.ROSIDE_LOCAL_CONFIG?require('./local-runtime').createLocalRuntime(process.env.ROSIDE_LOCAL_CONFIG):null;
let agentManagement=null;
let clusterManagement=null;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
const PORT   = process.env.PORT || 3001;
const localEnvironment=(()=>{if(localRuntime)return{};try{return Object.fromEntries(fs_node.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')&&line.includes('=')).map(line=>{const at=line.indexOf('='),key=line.slice(0,at),raw=line.slice(at+1).trim(),value=((raw.startsWith('"')&&raw.endsWith('"'))||(raw.startsWith("'")&&raw.endsWith("'")))?raw.slice(1,-1):raw;return[key,value];}));}catch{return{};}})();
const configValue=name=>process.env[name]||localEnvironment[name]||'';
// Enable only while troubleshooting; normal SSO redirects without exposing the code in the catalog UI.
const SHOW_SSO_DEBUG_KEY = process.env.SHOW_SSO_DEBUG_KEY === 'true';
const BILLING_PLANS=Object.freeze({
  free:{code:'free',name:'Free',price:0,currency:'thb',interval:'free',stripePriceId:''},
  pro_monthly:{code:'pro_monthly',name:'Pro รายเดือน',price:99,currency:'thb',interval:'month',stripePriceId:configValue('STRIPE_PRICE_PRO_MONTHLY')},
  pro_yearly:{code:'pro_yearly',name:'Pro รายปี',price:999,currency:'thb',interval:'year',stripePriceId:configValue('STRIPE_PRICE_PRO_YEARLY')},
  pro_lifetime:{code:'pro_lifetime',name:'Pro ตลอดชีพ',price:9999,currency:'thb',interval:'lifetime',stripePriceId:configValue('STRIPE_PRICE_PRO_LIFETIME')},
});
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length) return cb(null, false);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
}));
// Stripe signature verification requires the original bytes, before express.json mutates them.
if(!localRuntime)app.post('/api/billing/webhook',express.raw({type:'application/json',limit:'1mb'}),stripeWebhook);
app.use('/api/system-images',express.json({limit:'8kb'}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));
// Keep HTML uncached because it carries the current entry points. JS/CSS may
// be stored but must revalidate, allowing cheap 304 responses without risking
// an old ROSIDE client after deployment.
app.use((req,res,next)=>{
  if(/\.html$/.test(req.path||''))res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
  else if(/\.(?:js|css|map)$/.test(req.path||''))res.setHeader('Cache-Control','public, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options','nosniff');
  // YouTube embeds require the parent origin as referrer for client identification.
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https: data: blob:; connect-src 'self' ws: wss:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  index:false,etag:true,lastModified:true,maxAge:'1h',
  setHeaders(res,file){
    if(/\.html$/.test(file))res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
    else if(/\.(?:js|css|map)$/.test(file))res.setHeader('Cache-Control','public, no-cache, must-revalidate');
  },
}));

const db = localRuntime?{query:async()=>{throw new Error('Cloud database is disabled in Local mode');},end:async()=>{}}:mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '-Palamad007',
  database: process.env.DB_NAME || 'ros2ide',
  waitForConnections: true, connectionLimit: 10,
});
const clusterBus=localRuntime?null:new ClusterWorkerBus({db,WebSocket});

// In-memory
const agents       = new Map(); // robot_key → { ws, lastSeen }
const sessions     = new Map(); // sessionId → { robotKey, robotDbId, rosInfo, workspace, username, userId }
const simLeaseTokens=new Map(); // robot key -> Master-issued active capacity lease
const pendingReqs  = new Map();
const agentAdmission=new RequestAdmission({maxTotal:Math.max(16,Number(process.env.AGENT_MAX_PENDING)||1024),maxPerRobot:Math.max(8,Number(process.env.AGENT_MAX_PENDING_PER_ROBOT)||64),maxExecPerRobot:Math.max(2,Number(process.env.AGENT_MAX_EXEC_PER_ROBOT)||8)});
const webSockets   = new Map();
const rvizBuffers  = new Map(); // term id -> incremental PTY JSON decoder
const runtimeProbeCache=new ReadRequestCache({ttlMs:1000});
const monSockets   = new Map();
const statusSubs   = new Set();
const loginAttempts= new Map();
const supportChatLastPost = new Map();
const supportChatPresence = new Map();
const projectScanCache = new Map(); // canonical robot key -> shared scan promise
const robotProgressCache = new Map(); // robot key -> { expiresAt, promise, value }
const mapsimJobStore=new MapsimJobStore(path.join(__dirname,'sim_ws','.runtime-leases','map-jobs'));
const mapsimQueue = new MapsimQueue({store:mapsimJobStore,acquire:job=>acquireMapsimHostLock(path.join(__dirname,'sim_ws','.runtime-leases','mapsim-build.lock'),{isTurn:()=>mapsimJobStore.isFirst(job.id)})});
const applicationLaunchTickets = new Map(); // one-time SSO code -> { user, applicationId, expiresAt }
const activeSessionReservations = new Map(); // user id -> Set<robot db id> while connection is opening
const sessionOpenPromises = new Map(); // user id + robot id -> one coalesced session creation
const dashboardRuntimeCache = new Map(); // robot key -> short-lived/in-flight ROS status snapshot
const authSessionCache = new Map(); // opaque auth session id -> in-flight user lookup only
const membershipCache = new Map(); // user id -> short-lived/in-flight billing lookup
const applicationCatalogCache = new Map(); // admin/public -> short-lived application catalog
const simRvizStreams = new Map(); // simulation + topics -> one shared ROS bridge and latest state
const simRvizStreamsByTerm = new Map(); // PTY term id -> shared simulation stream
const robotPresenceSockets = new Map(); // robot key -> Map<user id, Set<status websocket>>
const robotControlLeases = new Map(); // robot key -> one session's sensor stream and exclusive motor-control stream
const robotRuntimeOperations = new Map(); // robot key -> in-flight start/stop, before a control stream exists
const realSystemInstallJobs = new Map(); // physical robot key -> shared prerequisite installation
const statusAccessGenerations = new Map();
const robotAccessGenerations = new Map();
const robotProgressQueue=[];
let activeRobotProgressJobs=0;

const ROBOT_PROGRESS_CONCURRENCY=Math.max(1,Math.min(4,Number(process.env.ROBOT_PROGRESS_CONCURRENCY)||2));
const SIM_SESSION_IDLE_MS=Math.max(2*60*1000,Number(process.env.SIM_SESSION_IDLE_MS)||15*60*1000);
const CONTROLLED_STREAM_PATHS=new Set(['/ws/lidar','/ws/controller-tune','/ws/mapping','/ws/navigation']);
const MEMBERSHIP_CACHE_MS=Math.max(1000,Number(process.env.MEMBERSHIP_CACHE_MS)||30000);
const APPLICATION_CATALOG_CACHE_MS=Math.max(1000,Number(process.env.APPLICATION_CATALOG_CACHE_MS)||30000);
const SIM_RVIZ_IDLE_CACHE_MS=Math.max(1000,Number(process.env.SIM_RVIZ_IDLE_CACHE_MS)||15000);
const SIM_RVIZ_CLIENT_BACKPRESSURE=Math.max(64*1024,Number(process.env.SIM_RVIZ_CLIENT_BACKPRESSURE)||512*1024);

const mkId = () => crypto.randomBytes(32).toString('hex');
// สร้าง sim agent ถ้ายังไม่มี + แจ้ง status ให้ frontend เปิดปุ่ม Open IDE ได้
function ensureSim(k){
  if(localRuntime)throw new Error('Simulation is disabled in Local mode');
  if (!agents.has(k)) {
    const clusterId=clusterIdForSim(k);
    if(clusterId!==1&&!clusterBus.connected(clusterId))throw Object.assign(new Error('Ubuntu Cluster is offline'),{status:503});
    // Fake SIM agents must enter the exact same PTY parser as physical agents.
    // Sending their PTY bytes straight to the browser leaves RViz with the
    // agent-level `pty_output` protocol instead of the browser `data` protocol.
    const remote=clusterId===1?null:{request:(action,payload,timeout)=>clusterBus.request(clusterId,action,payload,timeout),onPty:(key,handler)=>clusterBus.onPty(key,handler)};
    agents.set(k, createSimAgent(k, { pendingReqs, monSockets, webSockets, WebSocket, forwardPtyMessage:routeAgentPtyMessage,remote }));
    broadcastStatus(k, true);
  }
}

function liveSession(session,now=Date.now()){
  return Boolean(session&&(!session.expiresAt||session.expiresAt>now));
}

const robotAccessGenerationKey=(userId,robotId)=>`${userId}:${robotId}`;
function robotAccessGeneration(userId,robotId){return robotAccessGenerations.get(robotAccessGenerationKey(userId,robotId))||0;}
function bumpRobotAccessGeneration(userId,robotId){const key=robotAccessGenerationKey(userId,robotId);robotAccessGenerations.set(key,(robotAccessGenerations.get(key)||0)+1);}

function releaseSimRuntimeIfUnused(robotKey){
  if(!isSim(robotKey)||[...sessions.values()].some(session=>session.robotKey===robotKey&&liveSession(session)))return false;
  const agent=agents.get(robotKey);
  if(!agent?._sim)return false;
  try{agent.ws.close();}catch{}
  agents.delete(robotKey);dashboardRuntimeCache.delete(robotKey);
  if(simLeaseTokens.has(robotKey))setTimeout(async()=>{
    if([...sessions.values()].some(session=>session.robotKey===robotKey&&liveSession(session)))return;
    await releaseSimLease(robotKey);
  },2000).unref?.();
  return true;
}
async function releaseSimLease(robotKey){
  const entry=simLeaseTokens.get(robotKey);if(!entry)return;
  try{await db.query('DELETE FROM cluster_sim_leases WHERE robot_id=? AND lease_token=?',[entry.robotId,entry.token]);if(simLeaseTokens.get(robotKey)===entry)simLeaseTokens.delete(robotKey);}
  catch(error){console.error('[CLUSTER] Cannot release Sim capacity:',error.message);}
}
async function acquireSimLease(robot){
  const clusterId=Number(robot.cluster_id||1),existing=simLeaseTokens.get(robot.robot_key);
  let created=null;
  const connection=await db.getConnection();
  try{
    await connection.beginTransaction();
    const [[cluster]]=await connection.query('SELECT id,enabled,max_sims FROM clusters WHERE id=? FOR UPDATE',[clusterId]);
    if(!cluster?.enabled)throw Object.assign(new Error('Cluster is disabled'),{status:409});
    await connection.query('DELETE FROM cluster_sim_leases WHERE cluster_id=? AND expires_at<=NOW()',[clusterId]);
    const [rows]=await connection.query('SELECT lease_token FROM cluster_sim_leases WHERE robot_id=?',[robot.id]);
    if(rows.length&&rows[0].lease_token!==existing?.token)throw Object.assign(new Error('Sim is already running on another Master process'),{status:409});
    if(!rows.length){
      const [[usage]]=await connection.query('SELECT COUNT(*) active FROM cluster_sim_leases WHERE cluster_id=?',[clusterId]);
      if(usage.active>=cluster.max_sims)throw Object.assign(new Error('Cluster Sim capacity reached'),{status:409,code:'CLUSTER_SIM_LIMIT'});
      const token=crypto.randomBytes(24).toString('hex');
      await connection.query('INSERT INTO cluster_sim_leases(robot_id,cluster_id,lease_token,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 90 SECOND))',[robot.id,clusterId,token]);
      created={robotId:robot.id,clusterId,token};
    }else await connection.query('UPDATE cluster_sim_leases SET expires_at=DATE_ADD(NOW(),INTERVAL 90 SECOND) WHERE robot_id=? AND lease_token=?',[robot.id,existing.token]);
    await connection.commit();
    if(created)simLeaseTokens.set(robot.robot_key,created);
  }catch(error){await connection.rollback().catch(()=>{});throw error;}
  finally{connection.release();}
}
if(clusterBus){
  clusterBus.onConnect=async clusterId=>{
    revokeClusterCodes(clusterId);
    try{const [robots]=await db.query('SELECT robot_key FROM robots WHERE cluster_id=?',[clusterId]);for(const robot of robots)broadcastStatus(robot.robot_key,true);}
    catch(error){console.error('[CLUSTER] Could not broadcast Worker status:',error.message);}
  };
  clusterBus.onDisconnect=clusterId=>{
    for(const [key,agent] of agents){
      if(!agent?._sim||clusterIdForSim(key)!==clusterId)continue;
      for(const [sessionId,session] of sessions)if(session.robotKey===key){
        sessions.delete(sessionId);
        closeOperationalSockets(session.userId,key,'Cluster disconnected');
        closeRobotPresence(session.userId,key);
      }
      try{agent.ws.close();}catch{}
      agents.delete(key);dashboardRuntimeCache.delete(key);
      releaseSimLease(key);
      broadcastStatus(key,false);
    }
    db.query('SELECT robot_key FROM robots WHERE cluster_id=?',[clusterId]).then(([robots])=>{for(const robot of robots)broadcastStatus(robot.robot_key,false);}).catch(()=>{});
  };
  setInterval(async()=>{
    for(const [key,entry] of simLeaseTokens){
      if(!agents.has(key)){await releaseSimLease(key);continue;}
      try{
        const [result]=await db.query('UPDATE cluster_sim_leases SET expires_at=DATE_ADD(NOW(),INTERVAL 90 SECOND) WHERE robot_id=? AND lease_token=?',[entry.robotId,entry.token]);
        if(!result.affectedRows){clusterBus.onDisconnect(entry.clusterId);clusterBus.disconnect(entry.clusterId);}
      }catch(error){console.error('[CLUSTER] Sim lease renewal failed:',error.message);}
    }
  },30000).unref?.();
}
// SIM robot ถือว่า online เสมอ (ไม่ต้องมี agent เชื่อมจริง) + สร้าง agent ทันทีเพื่อให้ขึ้นใน status snapshot
const robotOnline = k => {
  if (isSim(k)) return clusterIdForSim(k)===1||Boolean(clusterBus?.connected(clusterIdForSim(k)));
  return agents.has(k) && agents.get(k).ws.readyState === WebSocket.OPEN;
};

// Encrypt/decrypt. PM2 instances do not all use `node --env-file`, so read only
// the two secrets from the local, git-ignored .env as a stable fallback.
function localSecret(name){
  return localEnvironment[name]||'';
}
const localEncSecret=localSecret('ENC_KEY');
const encSecret = process.env.ENC_KEY || localEncSecret || crypto.randomBytes(32).toString('hex');
if (!process.env.ENC_KEY&&!localEncSecret) console.warn('[SECURITY] ENC_KEY is not set; encrypted values cannot be recovered after restart');
const ENC_KEY = crypto.createHash('sha256').update(encSecret).digest();
const configuredAuthSecret=process.env.AUTH_TOKEN_SECRET||localSecret('AUTH_TOKEN_SECRET');
const authSecret = configuredAuthSecret || encSecret;
if (!configuredAuthSecret) console.warn('[SECURITY] AUTH_TOKEN_SECRET is not set; using ENC_KEY for signed login tokens');
function encrypt(t){
  if(!t)return'';
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv);
  const body=Buffer.concat([c.update(String(t),'utf8'),c.final()]);
  return ['gcm',iv.toString('hex'),c.getAuthTag().toString('hex'),body.toString('hex')].join(':');
}
function decrypt(t){
  if(!t)return'';
  try{
    const [version,ivHex,tagHex,bodyHex]=String(t).split(':');if(version!=='gcm'||!ivHex||!tagHex||!bodyHex)return'';
    const decipher=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(ivHex,'hex'));decipher.setAuthTag(Buffer.from(tagHex,'hex'));
    return Buffer.concat([decipher.update(Buffer.from(bodyHex,'hex')),decipher.final()]).toString('utf8');
  }catch{return'';}
}
function encryptedUserReference(userId, sessionId){
  return encrypt(JSON.stringify({user_id:Number(userId),sid:sessionId}));
}

function stripeConfigured(){return Boolean(configValue('STRIPE_SECRET_KEY')&&configValue('STRIPE_WEBHOOK_SECRET'));}
async function stripeRequest(method,endpoint,body){
  const secretKey=configValue('STRIPE_SECRET_KEY');
  if(!secretKey)throw Object.assign(new Error('ระบบชำระเงินยังไม่เปิดใช้งาน'),{status:503});
  const response=await fetch(`https://api.stripe.com/v1${endpoint}`,{method,headers:{Authorization:`Bearer ${secretKey}`,...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams(body):undefined,signal:AbortSignal.timeout(10000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(result.error?.message||'Stripe request failed'),{status:502});
  return result;
}
function verifyStripeEvent(raw,signature){
  const secret=configValue('STRIPE_WEBHOOK_SECRET');if(!secret)throw new Error('Stripe webhook is not configured');
  const fields=String(signature||'').split(',').map(v=>v.split('=')).reduce((out,[key,value])=>{if(key&&value)(out[key]||(out[key]=[])).push(value);return out;},{}),timestamp=Number(fields.t?.[0]);
  if(!timestamp||Math.abs(Date.now()/1000-timestamp)>300)throw new Error('Stripe signature timestamp is invalid');
  const expected=crypto.createHmac('sha256',secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  if(!(fields.v1||[]).some(value=>{try{return value.length===expected.length&&crypto.timingSafeEqual(Buffer.from(value),Buffer.from(expected));}catch{return false;}}))throw new Error('Stripe signature is invalid');
  return JSON.parse(raw.toString('utf8'));
}
function stripePeriodEnd(subscription){
  const values=[subscription?.current_period_end,...(subscription?.items?.data||[]).map(item=>item.current_period_end)].map(Number).filter(Number.isFinite);
  return values.length?new Date(Math.max(...values)*1000):null;
}
function stripeSubscriptionId(object){return object?.subscription||object?.parent?.subscription_details?.subscription||null;}
async function activateMembership({userId,planCode,customerId=null,subscriptionId=null,startsAt=new Date(),expiresAt=null,status='active'}){
  if(!userId||!BILLING_PLANS[planCode]||planCode==='free')return;
  await db.query(`INSERT INTO user_subscriptions(user_id,plan_code,status,provider,provider_customer_id,provider_subscription_id,starts_at,expires_at)
    VALUES(?,?,?,'stripe',?,?,?,?) ON DUPLICATE KEY UPDATE plan_code=VALUES(plan_code),status=VALUES(status),provider='stripe',provider_customer_id=COALESCE(VALUES(provider_customer_id),provider_customer_id),provider_subscription_id=COALESCE(VALUES(provider_subscription_id),provider_subscription_id),starts_at=VALUES(starts_at),expires_at=VALUES(expires_at),updated_at=NOW()`,[userId,planCode,status,customerId,subscriptionId,startsAt,expiresAt]);
  membershipCache.delete(Number(userId));
}
async function handleStripeEvent(event){
  const object=event.data?.object||{};
  if((event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded')&&(object.payment_status==='paid'||object.mode==='subscription')){
    const userId=Number(object.metadata?.user_id||object.client_reference_id),planCode=object.metadata?.plan_code;
    let expiresAt=null;
    if(object.subscription){const subscription=await stripeRequest('GET',`/subscriptions/${encodeURIComponent(object.subscription)}`);expiresAt=stripePeriodEnd(subscription);}
    await activateMembership({userId,planCode,customerId:object.customer||null,subscriptionId:object.subscription||null,expiresAt});
  }else if(event.type==='invoice.paid'&&stripeSubscriptionId(object)){
    const subscriptionId=stripeSubscriptionId(object),subscription=await stripeRequest('GET',`/subscriptions/${encodeURIComponent(subscriptionId)}`),expiresAt=stripePeriodEnd(subscription);
    await db.query("UPDATE user_subscriptions SET status='active',expires_at=?,updated_at=NOW() WHERE provider_subscription_id=?",[expiresAt,subscriptionId]);
  }else if(event.type==='invoice.payment_failed'&&stripeSubscriptionId(object)){
    await db.query("UPDATE user_subscriptions SET status='past_due',updated_at=NOW() WHERE provider_subscription_id=?",[stripeSubscriptionId(object)]);
  }else if(event.type==='customer.subscription.deleted'){
    await db.query("UPDATE user_subscriptions SET status='canceled',expires_at=COALESCE(expires_at,NOW()),updated_at=NOW() WHERE provider_subscription_id=?",[object.id]);
  }else if(event.type==='customer.subscription.updated'){
    const status=['active','trialing'].includes(object.status)?'active':object.status,expiresAt=stripePeriodEnd(object);
    await db.query('UPDATE user_subscriptions SET status=?,expires_at=?,updated_at=NOW() WHERE provider_subscription_id=?',[status,expiresAt,object.id]);
  }
  // Subscription events are rare. Clearing this small cache avoids serving a
  // stale entitlement when Stripe addressed the row by subscription id rather
  // than by user id.
  membershipCache.clear();
}
async function stripeWebhook(req,res){
  try{
    const event=verifyStripeEvent(req.body,req.headers['stripe-signature']);
    const[result]=await db.query("INSERT IGNORE INTO payment_events(provider,event_id,event_type,status) VALUES('stripe',?,?,'processing')",[event.id,event.type]);
    if(!result.affectedRows)return res.json({received:true,duplicate:true});
    try{await handleStripeEvent(event);await db.query("UPDATE payment_events SET status='processed',processed_at=NOW() WHERE provider='stripe' AND event_id=?",[event.id]);}
    catch(error){await db.query("DELETE FROM payment_events WHERE provider='stripe' AND event_id=?",[event.id]);throw error;}
    res.json({received:true});
  }catch(error){console.error('[BILLING WEBHOOK]',error.message);res.status(400).json({received:false,error:'Invalid webhook'});}
}

async function getMembership(user,connection=db){
  if(localRuntime)return localRuntime.membership;
  if(user.role==='admin')return{planCode:'admin',name:'Admin',isPro:true,isUnlimited:true,status:'active',startsAt:null,expiresAt:null};
  const load=async()=>{
    const[rows]=await connection.query("SELECT plan_code,status,starts_at,expires_at,provider FROM user_subscriptions WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1",[user.id]);
    if(!rows.length)return{planCode:'free',name:'Free',isPro:false,isUnlimited:false,status:'active',startsAt:null,expiresAt:null};
    const row=rows[0],plan=BILLING_PLANS[row.plan_code]||BILLING_PLANS.free;
    return{planCode:row.plan_code,name:plan.name,isPro:true,isUnlimited:true,status:row.status,startsAt:row.starts_at,expiresAt:row.expires_at,provider:row.provider};
  };
  // A transaction must observe its own database snapshot. Only cache normal
  // pool reads; quota checks using a dedicated transaction bypass this cache.
  if(connection!==db)return load();
  const key=Number(user.id),now=Date.now(),cached=membershipCache.get(key);
  if(cached&&cached.expiresAt>now)return cached.promise;
  const promise=load(),entry={expiresAt:Number.POSITIVE_INFINITY,promise};membershipCache.set(key,entry);
  promise.then(value=>{
    if(membershipCache.get(key)!==entry)return;
    const planExpiry=value.expiresAt?new Date(value.expiresAt).getTime():Number.POSITIVE_INFINITY;
    entry.expiresAt=Math.max(now+1000,Math.min(Date.now()+MEMBERSHIP_CACHE_MS,Number.isFinite(planExpiry)?planExpiry:Infinity));
  },()=>{if(membershipCache.get(key)===entry)membershipCache.delete(key);});
  return promise;
}

function agentReq(robot_key, action, payload, ms=15000,{maintenance=false}={}){
  if(!maintenance&&action!=='agent_status'&&agentManagement?.busy(robot_key))return Promise.reject(new Error('กำลังอัปเดต Agent ระบบพักคำขอใหม่ชั่วคราว'));
  // SIM: สร้าง fake agent ถ้ายังไม่มี (robot จำลองไม่ได้เชื่อมผ่าน /ws/agent จริง)
  if(isSim(robot_key) && !agents.has(robot_key))
    ensureSim(robot_key);
  return new Promise((resolve,reject)=>{
    const ag=agents.get(robot_key);
    if(!ag||ag.ws.readyState!==WebSocket.OPEN) return reject(new Error('Robot offline'));
    let release;try{release=agentAdmission.enter(robot_key,action);}catch(error){return reject(error);}
    ag.lastSeen=Date.now();
    const reqId=mkId(), t=setTimeout(()=>{pendingReqs.delete(reqId);release();reject(new Error('Timeout'));},ms);
    const callback=resp=>{clearTimeout(t);release();resp.ok?resolve(resp.data):reject(new Error(resp.error||'Robot request failed'));};
    callback.robotKey=robot_key;
    pendingReqs.set(reqId,callback);
    try{ag.ws.send(JSON.stringify({type:'request',reqId,action,payload}));}
    catch(e){clearTimeout(t);pendingReqs.delete(reqId);release();reject(e);}
  });
}

// Auth middleware
function signAuthToken(user, sessionId, expiresAt){
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const header=encode({alg:'HS256',typ:'JWT'});
  // Keep identity out of browser-readable JWT claims. The opaque sid is
  // resolved to a user only by the server-side sessions table.
  const payload=encode({sid:sessionId,iat:Math.floor(Date.now()/1000),exp:Math.floor(expiresAt.getTime()/1000)});
  const signature=crypto.createHmac('sha256',authSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
function verifyAuthToken(token){
  try{
    const parts=String(token||'').split('.');
    if(parts.length!==3)return null;
    const expected=crypto.createHmac('sha256',authSecret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual=Buffer.from(parts[2],'base64url');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;
    const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    if(header.alg!=='HS256'||!payload.sid||payload.exp<=Math.floor(Date.now()/1000))return null;
    return payload;
  }catch{return null;}
}
function requestAuthToken(req){
  const legacy=req.headers['x-auth-token'];
  const authorization=String(req.headers.authorization||'');
  const bearer=/^Bearer\s+(.+)$/i.exec(authorization);
  return String(legacy||(bearer&&bearer[1])||'');
}
async function tokenUser(token){
  if(localRuntime)return localRuntime.tokenUser(token);
  if(!token) return null;
  const payload=verifyAuthToken(token);
  const sessionId=payload?.sid||token; // accept pre-JWT sessions until they expire
  const now=Date.now(),cached=authSessionCache.get(sessionId);
  if(cached&&cached.expiresAt>now)return cached.promise;
  const promise=db.query('SELECT s.user_id,u.username,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>NOW()',[sessionId]).then(([rows])=>{
    if(!rows.length)return null;
    return{id:rows[0].user_id,username:rows[0].username,role:rows[0].role,sessionId};
  });
  // Coalesce only simultaneous requests. Removing the entry immediately after
  // the query preserves the original session-revocation semantics exactly.
  const entry={expiresAt:Number.POSITIVE_INFINITY,promise};authSessionCache.set(sessionId,entry);
  promise.then(()=>{if(authSessionCache.get(sessionId)===entry)authSessionCache.delete(sessionId);},()=>{if(authSessionCache.get(sessionId)===entry)authSessionCache.delete(sessionId);});
  return promise;
}
function webSocketAuthToken(protocolHeader){
  return String(protocolHeader||'').split(',').map(value=>value.trim()).find(value=>value&&value!=='ros2ide')||'';
}
async function auth(req,res,next){
  const token=requestAuthToken(req);
  if(!token) return res.status(401).json({ok:false,error:'Unauthorized'});
  try{
    const user=await tokenUser(token);
    if(!user) return res.status(401).json({ok:false,error:'Session expired'});
    req.user={id:user.id,username:user.username,role:user.role};
    req.authSessionId=user.sessionId;
    next();
  }catch(e){res.status(500).json({ok:false,error:e.message});}
}
function adminOnly(req,res,next){
  if(req.user?.role!=='admin') return res.status(403).json({ok:false,error:'Admin only'});
  next();
}

function validApplicationUrl(value){
  if(typeof value!=='string'||!value.trim()||value.length>2048||value.includes('\\'))return false;
  if(value.startsWith('/')&&!value.startsWith('//'))return true;
  try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}
}
function applicationSlug(name){
  const base=String(name||'application').normalize('NFKD').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase().slice(0,60)||'application';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}
function applicationInput(body){
  const name=String(body.name||'').trim(),redirect_url=String(body.redirect_url||'').trim();
  if(!name||name.length>128)throw Object.assign(new Error('Name is required (maximum 128 characters)'),{status:400});
  if(!validApplicationUrl(redirect_url))throw Object.assign(new Error('Redirect URL must be /path or an http(s) URL'),{status:400});
  const icon=String(body.icon||'🚀').trim()||'🚀';
  if(icon.length>2048)throw Object.assign(new Error('Logo URL is too long'),{status:400});
  if(/^\/uploads\/application-icons\/app-[0-9]+-[a-f0-9]{16}\.(?:png|jpg|webp|gif)$/.test(icon)){
    // Server-managed image pasted through the application editor.
  }else if(/^https?:\/\//i.test(icon)){
    try{if(new URL(icon).protocol!=='https:')throw new Error();}catch{throw Object.assign(new Error('Logo image URL must use https://'),{status:400});}
  }else if(icon.length>16)throw Object.assign(new Error('Emoji logo must be 16 characters or fewer'),{status:400});
  const session_mode=body.session_mode==='ticket'?'ticket':'none';
  return{name,description:String(body.description||'').trim().slice(0,512),category:String(body.category||'Application').trim().slice(0,100)||'Application',icon,redirect_url,session_mode,enabled:body.enabled===false||body.enabled===0?0:1,sort_order:Number.isInteger(Number(body.sort_order))?Math.max(-9999,Math.min(9999,Number(body.sort_order))):0};
}

const APPLICATION_ICON_DIR=path.join(__dirname,'public','uploads','application-icons');
function decodeApplicationIcon(dataUrl){
  const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl||''));
  if(!match)throw Object.assign(new Error('รองรับเฉพาะรูป PNG, JPEG, WebP หรือ GIF'),{status:400});
  const data=Buffer.from(match[2],'base64');
  if(!data.length||data.length>5*1024*1024)throw Object.assign(new Error('รูปโลโก้ต้องมีขนาดไม่เกิน 5 MB'),{status:413});
  const signatures={
    'image/png':data.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
    'image/jpeg':data[0]===0xff&&data[1]===0xd8&&data[data.length-2]===0xff&&data[data.length-1]===0xd9,
    'image/webp':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP',
    'image/gif':['GIF87a','GIF89a'].includes(data.subarray(0,6).toString()),
  };
  if(!signatures[match[1]])throw Object.assign(new Error('ข้อมูลไฟล์รูปไม่ถูกต้อง'),{status:400});
  return{data,extension:{'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[match[1]]};
}

// Static pages
if(localRuntime)localRuntime.mount(app,{auth,requestAuthToken,sessions,createRobotSession,closeOperationalSockets,closeRobotPresence,robotOnline,inspectRobotWizardProgress,agentReq});
require('./image-tools').mountImageTools(app,{auth,getOwnedSess,isSim,agentReq,privilegedExec:(session,command,password)=>lidarSudoExec(session,command,password,90000)});
agentManagement=require('./agent-management').mountAgentManagement(app,{auth,getOwnedSess,accessibleRobot,isSim,agents,agentReq,maintenanceReq:(key,action,payload,ms)=>agentReq(key,action,payload,ms,{maintenance:true}),webSockets,monSockets,pendingReqs,localRuntime,root:__dirname,publicUrl:configValue('PUBLIC_URL')});
if(!localRuntime)clusterManagement=mountClusterManagement(app,{db,auth,sessions,closeOperationalSockets,closeRobotPresence,releaseSimRuntimeIfUnused,refreshStatusAccess,clusterBus});
app.get('/',         (_,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/cluster-admin',(_,res)=>res.sendFile(path.join(__dirname,'public','cluster-admin.html')));
app.get('/applications',(_,res)=>res.sendFile(path.join(__dirname,'public','applications.html')));
app.get('/robots',   (_,res)=>res.sendFile(path.join(__dirname,'public','robots.html')));
app.get('/app',      (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/hardware', (_,res)=>res.sendFile(path.join(__dirname,'public','hardware.html')));
app.get('/tune', (_,res)=>res.sendFile(path.join(__dirname,'public','tune.html')));
app.get('/mapping', (_,res)=>res.sendFile(path.join(__dirname,'public','mapping.html')));
app.get('/navigation', (_,res)=>res.sendFile(path.join(__dirname,'public','navigation.html')));
app.get('/register', (_,res)=>res.sendFile(path.join(__dirname,'public','register.html')));
app.get('/install.sh',(_,res)=>{
  const proto=String(_.headers['x-forwarded-proto']||_.protocol||'http').split(',')[0].trim();
  const url=(process.env.PUBLIC_URL||`${proto}://${_.headers.host}`).replace(/\/$/,'');
  let s=fs_node.readFileSync(path.join(__dirname,'install.sh'),'utf8');
  s=s.replaceAll('__CLOUD_URL__',url);
  res.setHeader('Content-Type','text/plain'); res.send(s);
});
app.get('/agent-download',(_,res)=>res.sendFile(path.join(__dirname,'agent.js')));
app.get('/api/health',(_,res)=>res.json({ok:true,service:'ros2ide',version:'5.0.0'}));
app.get('/api/client-network',auth,(req,res)=>{
  const browserIp=browserAddress(req.socket.remoteAddress,req.headers['x-forwarded-for'],configValue('TRUST_PROXY')==='true',Number(configValue('TRUST_PROXY_HOPS')||1));
  res.json({ok:true,browserIp:browserIp||null});
});

// ── Auth API ─────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Missing credentials' });
  const ip=String(req.ip||req.socket.remoteAddress||'unknown'), now=Date.now();
  const recent=(loginAttempts.get(ip)||[]).filter(t=>now-t<15*60*1000);
  if(recent.length>=10) return res.status(429).json({ok:false,error:'Too many login attempts; try again later'});
  recent.push(now);loginAttempts.set(ip,recent);
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password))) return res.json({ ok: false, error: 'Invalid credentials' });
    const sessionId = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)', [sessionId, rows[0].id, exp]);
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [rows[0].id]);
    loginAttempts.delete(ip);
    const user={id:rows[0].id,username:rows[0].username,role:rows[0].role};
    const token=signAuthToken(user,sessionId,exp);
    res.json({ok:true,token,sessionId:token,encryptedUserId:encryptedUserReference(user.id,sessionId),user});
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') return res.status(403).json({ok:false,error:'Registration is disabled; ask an administrator to create an account'});
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Missing fields' });
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) return res.status(400).json({ok:false,error:'Username must be 3-64 letters, numbers, dot, dash or underscore'});
  if (password.length < 12) return res.status(400).json({ ok: false, error: 'Password must be at least 12 characters' });

  try {
    const [checkUser] = await db.query('SELECT 1 FROM users WHERE username = ?', [username]);
    if (checkUser.length) return res.status(409).json({ ok: false, error: 'Username already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const [user] = await db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    await db.query("INSERT INTO cluster_user_access(cluster_id,user_id,role) VALUES(1,?,'user')",[user.insertId]);
    const sessionId = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [sessionId, user.insertId, exp]);

    const loginUser={id:user.insertId,username,role:'user'};
    const token=signAuthToken(loginUser,sessionId,exp);
    res.json({ok:true,token,sessionId:token,encryptedUserId:encryptedUserReference(loginUser.id,sessionId),user:loginUser});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  await db.query('DELETE FROM sessions WHERE token=?',[req.authSessionId]).catch(()=>{});
  authSessionCache.delete(req.authSessionId);
  res.json({ok:true});
});
app.get('/api/auth/me',auth,async(req,res)=>{
  try{
    res.json({ok:true,user:req.user,membership:await getMembership(req.user),encryptedUserId:encryptedUserReference(req.user.id,req.authSessionId)});
  }catch(error){
    res.status(500).json({ok:false,error:error.message});
  }
});

// ── Shared support chat ─────────────────────────────────────
// Everyone in ROS2IDE sees the same room. Usernames and roles always come
// from the authenticated session, never from text supplied by the browser.
app.get('/api/support-chat/messages',auth,async(req,res)=>{
  try{
    const after=Math.max(0,Number.parseInt(req.query.after,10)||0);
    const sql=`SELECT m.id,u.username,u.role,m.message,m.created_at AS createdAt
      FROM support_chat_messages m JOIN users u ON u.id=m.user_id
      ${after?'WHERE m.id>?':''} ORDER BY m.id ${after?'ASC':'DESC'} LIMIT 100`;
    const[rows]=await db.query(sql,after?[after]:[]);
    if(!after)rows.reverse();
    res.json({ok:true,messages:rows,currentUser:req.user.username,isAdmin:req.user.role==='admin'});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/support-chat/messages',auth,async(req,res)=>{
  try{
    const message=String(req.body?.message||'').trim();
    if(!message)return res.status(400).json({ok:false,error:'กรุณาพิมพ์ข้อความ'});
    if(message.length>1000)return res.status(400).json({ok:false,error:'ข้อความยาวเกิน 1,000 ตัวอักษร'});
    const now=Date.now(),last=supportChatLastPost.get(req.user.id)||0;
    if(now-last<800)return res.status(429).json({ok:false,error:'กรุณารอสักครู่ก่อนส่งข้อความถัดไป'});
    supportChatLastPost.set(req.user.id,now);
    const[result]=await db.query('INSERT INTO support_chat_messages(user_id,message) VALUES(?,?)',[req.user.id,message]);
    const[rows]=await db.query(`SELECT m.id,u.username,u.role,m.message,m.created_at AS createdAt
      FROM support_chat_messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`,[result.insertId]);
    res.status(201).json({ok:true,message:rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/support-chat/presence',auth,(req,res)=>{
  const page=String(req.body?.page||'ROS').trim().slice(0,64)||'ROS';
  supportChatPresence.set(req.user.id,{userId:req.user.id,username:req.user.username,role:req.user.role,page,lastSeen:Date.now()});
  res.json({ok:true});
});

app.get('/api/support-chat/presence',auth,adminOnly,(req,res)=>{
  const now=Date.now(),users=[];
  for(const[userId,presence]of supportChatPresence){
    if(now-presence.lastSeen>60000){supportChatPresence.delete(userId);continue;}
    users.push({...presence,lastSeen:new Date(presence.lastSeen).toISOString()});
  }
  users.sort((a,b)=>(a.role==='admin'?0:1)-(b.role==='admin'?0:1)||a.username.localeCompare(b.username));
  res.json({ok:true,users});
});

// ── Membership & Billing API ────────────────────────────────
app.get('/api/billing/plans',auth,async(req,res)=>{
  try{
    const membership=await getMembership(req.user);
    const plans=Object.values(BILLING_PLANS).map(({stripePriceId,...plan})=>({...plan,features:plan.code==='free'?['Simulation 2 ตัว','หุ่นยนต์จริง 2 ตัว']:['Simulation ไม่จำกัด','หุ่นยนต์จริงไม่จำกัด']}));
    res.json({ok:true,plans,membership,payment:{provider:'stripe',configured:stripeConfigured(),methods:['card','promptpay'],note:'PromptPay ใช้ชำระครั้งเดียว; รายเดือนและรายปีใช้บัตรสำหรับต่ออายุอัตโนมัติ'}});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/billing/checkout',auth,async(req,res)=>{
  try{
    const plan=BILLING_PLANS[String(req.body?.planCode||'')];
    if(!plan||plan.code==='free')return res.status(400).json({ok:false,error:'แพ็กเกจไม่ถูกต้อง'});
    if(req.user.role==='admin')return res.status(400).json({ok:false,error:'บัญชี Admin ได้สิทธิ์ไม่จำกัดอยู่แล้ว'});
    if(!stripeConfigured())return res.status(503).json({ok:false,error:'ระบบรับชำระเงินยังไม่เปิดใช้งาน กรุณาติดต่อผู้ดูแล'});
    const base=(configValue('BILLING_PUBLIC_URL')||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');
    const recurring=plan.interval==='month'||plan.interval==='year';
    const body={mode:recurring?'subscription':'payment',success_url:`${base}/applications?billing=success`,cancel_url:`${base}/applications?billing=cancel`,client_reference_id:String(req.user.id),'metadata[user_id]':String(req.user.id),'metadata[plan_code]':plan.code,'line_items[0][quantity]':'1'};
    if(plan.stripePriceId)body['line_items[0][price]']=plan.stripePriceId;
    else{
      body['line_items[0][price_data][currency]']='thb';body['line_items[0][price_data][unit_amount]']=String(plan.price*100);body['line_items[0][price_data][product_data][name]']=`Mecha Rayong ${plan.name}`;
      if(recurring)body['line_items[0][price_data][recurring][interval]']=plan.interval;
    }
    if(recurring){body['payment_method_types[0]']='card';body['subscription_data[metadata][user_id]']=String(req.user.id);body['subscription_data[metadata][plan_code]']=plan.code;}
    else{body['payment_method_types[0]']='card';body['payment_method_types[1]']='promptpay';}
    const session=await stripeRequest('POST','/checkout/sessions',body);
    res.json({ok:true,url:session.url});
  }catch(error){res.status(error.status||500).json({ok:false,error:error.message});}
});

// ── Applications API ─────────────────────────────────────────
function getApplicationCatalog(isAdmin){
  const key=isAdmin?'admin':'public',now=Date.now(),cached=applicationCatalogCache.get(key);
  if(cached&&cached.expiresAt>now)return cached.promise;
  const where=isAdmin?'':'WHERE enabled=1';
  const promise=db.query(`SELECT id,slug,name,description,category,icon,redirect_url,session_mode,enabled,sort_order,created_at,updated_at FROM applications ${where} ORDER BY sort_order ASC, created_at ASC, id ASC`).then(([rows])=>rows);
  const entry={expiresAt:Number.POSITIVE_INFINITY,promise};applicationCatalogCache.set(key,entry);
  promise.then(()=>{if(applicationCatalogCache.get(key)===entry)entry.expiresAt=Date.now()+APPLICATION_CATALOG_CACHE_MS;},()=>{if(applicationCatalogCache.get(key)===entry)applicationCatalogCache.delete(key);});
  return promise;
}

app.get('/api/applications',auth,async(req,res)=>{
  try{
    const rows=await getApplicationCatalog(req.user.role==='admin');
    res.json({ok:true,applications:rows,isAdmin:req.user.role==='admin',membership:await getMembership(req.user)});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/applications/icon-upload',auth,adminOnly,async(req,res)=>{
  try{
    const{data,extension}=decodeApplicationIcon(req.body?.dataUrl);
    await fs_node.promises.mkdir(APPLICATION_ICON_DIR,{recursive:true});
    const filename=`app-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
    await fs_node.promises.writeFile(path.join(APPLICATION_ICON_DIR,filename),data,{flag:'wx'});
    res.status(201).json({ok:true,url:`/uploads/application-icons/${filename}`});
  }catch(error){res.status(error.status||500).json({ok:false,error:error.message});}
});

app.post('/api/applications',auth,adminOnly,async(req,res)=>{
  try{
    const a=applicationInput(req.body);
    const[result]=await db.query('INSERT INTO applications(slug,name,description,category,icon,redirect_url,session_mode,enabled,sort_order,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',[applicationSlug(a.name),a.name,a.description,a.category,a.icon,a.redirect_url,a.session_mode,a.enabled,a.sort_order,req.user.id]);
    applicationCatalogCache.clear();
    res.status(201).json({ok:true,id:result.insertId});
  }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
});

app.put('/api/applications/:id',auth,adminOnly,async(req,res)=>{
  try{
    const a=applicationInput(req.body);
    const[result]=await db.query('UPDATE applications SET name=?,description=?,category=?,icon=?,redirect_url=?,session_mode=?,enabled=?,sort_order=? WHERE id=?',[a.name,a.description,a.category,a.icon,a.redirect_url,a.session_mode,a.enabled,a.sort_order,req.params.id]);
    if(!result.affectedRows)return res.status(404).json({ok:false,error:'Application not found'});
    applicationCatalogCache.clear();
    res.json({ok:true});
  }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
});

app.delete('/api/applications/:id',auth,adminOnly,async(req,res)=>{
  try{
    const[result]=await db.query('DELETE FROM applications WHERE id=?',[req.params.id]);
    if(!result.affectedRows)return res.status(404).json({ok:false,error:'Application not found'});
    applicationCatalogCache.clear();
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/applications/:id/launch',auth,async(req,res)=>{
  try{
    const[rows]=await db.query('SELECT id,redirect_url,session_mode FROM applications WHERE id=? AND enabled=1',[req.params.id]);
    if(!rows.length)return res.status(404).json({ok:false,error:'Application not found or disabled'});
    const application=rows[0];
    if(!validApplicationUrl(application.redirect_url))return res.status(400).json({ok:false,error:'Application redirect URL is invalid'});
    let redirectUrl=application.redirect_url;
    // A loopback callback is convenient in the Applications configuration,
    // but would point to the visitor's own machine when the platform is opened
    // through a LAN/Tailscale address. Keep the configured app port/path and
    // dynamically use the hostname through which this SSO request arrived.
    if(/^https?:\/\//i.test(redirectUrl)){
      const parsedCallback=new URL(redirectUrl);
      if(['localhost','127.0.0.1','::1'].includes(parsedCallback.hostname)&&!['localhost','127.0.0.1','::1'].includes(req.hostname)){
        parsedCallback.hostname=req.hostname;
        redirectUrl=parsedCallback.toString();
      }
    }
    let ssoCode=null;
    if(application.session_mode==='ticket'||SHOW_SSO_DEBUG_KEY){
      const code=crypto.randomBytes(32).toString('base64url');
      applicationLaunchTickets.set(code,{user:{id:req.user.id,username:req.user.username,role:req.user.role},applicationId:application.id,expiresAt:Date.now()+60_000});
      const parsed=new URL(redirectUrl,`${req.protocol}://${req.get('host')}`);
      parsed.searchParams.set('sso_code',code);
      redirectUrl=redirectUrl.startsWith('/')?parsed.pathname+parsed.search+parsed.hash:parsed.toString();
      ssoCode=code;
    }
    res.json({ok:true,redirectUrl,sessionMode:application.session_mode,ssoCode:SHOW_SSO_DEBUG_KEY?ssoCode:null,ssoExpiresIn:60});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// External applications exchange the short-lived code from the redirect on their backend.
app.post('/api/application-sessions/exchange',async(req,res)=>{
  const code=typeof req.body?.code==='string'?req.body.code:'';
  const ticket=applicationLaunchTickets.get(code);
  if(code)applicationLaunchTickets.delete(code); // consume once, including expired attempts
  if(!ticket||ticket.expiresAt<Date.now())return res.status(401).json({ok:false,error:'Invalid or expired SSO code'});
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,user:ticket.user,applicationId:ticket.applicationId});
});

// ── Robots API ───────────────────────────────────────────────
const SIMULATION_WIZARD_ORDER=['urdf','lidar','control','mapping','navigation'];
const REAL_ROBOT_WIZARD_ORDER=['system','urdf','lidar','hardware','pid','control','mapping','navigation'];
// Keep mission numbers stable; tuning (mission 4) is no longer a required gate.
const REAL_ROBOT_REQUIRED_ORDER=REAL_ROBOT_WIZARD_ORDER.filter(id=>id!=='pid');
const REAL_ROBOT_OPTIONAL_ORDER=[];
const ROBOT_LIMITS=Object.freeze({simulation:2,real:2,activeConnections:2});

async function getUserRobotQuota(user,connection=db){
  const[rows]=await connection.query("SELECT COALESCE(SUM(r.robot_key LIKE 'SIM-%'),0) simulation_count,COALESCE(SUM(r.robot_key NOT LIKE 'SIM-%'),0) real_count FROM robot_user_access rua JOIN robots r ON r.id=rua.robot_id WHERE rua.user_id=?",[user.id]);
  const activeRobotIds=new Set([...sessions.values()].filter(session=>session.userId===user.id&&(!session.expiresAt||session.expiresAt>Date.now())).map(session=>session.robotDbId));
  const used={simulation:Number(rows[0]?.simulation_count)||0,real:Number(rows[0]?.real_count)||0,activeConnections:activeRobotIds.size};
  const membership=await getMembership(user,connection),isUnlimited=membership.isUnlimited===true;
  return {
    limits:{simulation:isUnlimited?null:ROBOT_LIMITS.simulation,real:isUnlimited?null:ROBOT_LIMITS.real,activeConnections:ROBOT_LIMITS.activeConnections},
    unlimited:{simulation:isUnlimited,real:isUnlimited,activeConnections:false},
    used,
    remaining:{simulation:isUnlimited?null:Math.max(0,ROBOT_LIMITS.simulation-used.simulation),real:isUnlimited?null:Math.max(0,ROBOT_LIMITS.real-used.real),activeConnections:Math.max(0,ROBOT_LIMITS.activeConnections-used.activeConnections)},membership,
  };
}

async function accessibleRobot(user,robotId,connection=db){
  if(localRuntime)return Number(robotId)===1&&user.id===1?localRuntime.robot:null;
  if(user.role==='admin'){
    const[rows]=await connection.query('SELECT r.* FROM robots r WHERE r.id=?',[robotId]);
    return rows[0]||null;
  }
  const[rows]=await connection.query("SELECT r.*,rua.alias access_alias FROM robots r JOIN robot_user_access rua ON rua.robot_id=r.id AND rua.user_id=? LEFT JOIN cluster_user_access cua ON cua.cluster_id=r.cluster_id AND cua.user_id=? LEFT JOIN clusters c ON c.id=r.cluster_id WHERE r.id=? AND (r.robot_key NOT LIKE 'SIM-%' OR (cua.user_id IS NOT NULL AND c.enabled=1))",[user.id,user.id,robotId]);
  return rows[0]||null;
}

function summarizeRobotWizard(capabilities,simulation){
  const byId=Object.fromEntries((capabilities||[]).map(capability=>[capability.id,{...capability}]));
  byId.urdf={...(byId.urdf||{id:'urdf'}),detected:['urdf','tf','odom'].every(id=>byId[id]?.detected===true)};
  if(simulation&&byId.control&&!byId.lidar?.detected){
    byId.control.detected=false;
    byId.control.dependencyBlocked=true;
  }
  if(!simulation){
    const block=(id,requirements)=>{if(byId[id]&&requirements.some(required=>byId[required]?.detected!==true)){byId[id].detected=false;byId[id].dependencyBlocked=true;}};
    if(byId.pid&&byId.pid.tuneVerified!==true)byId.pid.detected=false;
    if(byId.mapping&&byId.mapping.mappingVerified!==true)byId.mapping.detected=false;
    block('urdf',['system']);
    block('lidar',['urdf']);
    block('hardware',['urdf','lidar']);
    block('pid',['hardware']);
    block('custom_package',['hardware']);
    block('control',['hardware']);
    block('mapping',['control','lidar']);
    block('navigation',['mapping']);
  }
  const order=simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_REQUIRED_ORDER;
  const optionalOrder=simulation?[]:REAL_ROBOT_OPTIONAL_ORDER;
  const completed=order.filter(id=>byId[id]?.detected===true).length;
  const optionalCompleted=optionalOrder.filter(id=>byId[id]?.detected===true).length;
  return {available:true,completed,total:order.length,percent:Math.round(completed/order.length*100),next:order.find(id=>!byId[id]?.detected)||null,optionalCompleted,optionalTotal:optionalOrder.length,checkedAt:Date.now()};
}

async function inspectRealRobotSystem(robotKey){
  const result=await agentReq(robotKey,'exec',{command:buildRealSystemProbeCommand(),timeout:10000},12000);
  if(result.code!==0)throw new Error([result.stdout,result.stderr].filter(Boolean).join('\n').trim()||'ตรวจสอบระบบหุ่นยนต์ไม่สำเร็จ');
  return parseRealSystemProbeOutput(result.stdout);
}

function syncRealRobotRosInfo(robotKey,system){
  const check=system?.systemCheck;
  if(!check?.targetDistro||!check.rosInstalled)return null;
  const rosInfo={distro:check.targetDistro,setupBash:check.setupBash,version:'2'};
  const agent=agents.get(robotKey);
  if(agent){agent.rosInfo=rosInfo;agent.rosInfoPromise=null;}
  for(const active of sessions.values())if(active.robotKey===robotKey)active.rosInfo=rosInfo;
  return rosInfo;
}

function pumpRobotProgressQueue(){
  while(activeRobotProgressJobs<ROBOT_PROGRESS_CONCURRENCY&&robotProgressQueue.length){
    const job=robotProgressQueue.shift();activeRobotProgressJobs++;
    setImmediate(()=>Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{activeRobotProgressJobs--;pumpRobotProgressQueue();}));
  }
}

function enqueueRobotProgress(task){
  if(robotProgressQueue.length>=256)return Promise.reject(new Error('คิวตรวจความคืบหน้าเต็ม กรุณารอสักครู่'));
  return new Promise((resolve,reject)=>{robotProgressQueue.push({task,resolve,reject});pumpRobotProgressQueue();});
}

function scanLocalProjectAsync(workspace){
  return new Promise((resolve,reject)=>execFile('python3',['-c',buildProjectScanScript(workspace)],{timeout:15000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message).trim())):resolve({stdout})));
}

function inspectRobotWizardProgress(robot){
  const cached=robotProgressCache.get(robot.robot_key);
  if(cached&&cached.expiresAt>Date.now())return cached.promise;
  const simulation=isSim(robot.robot_key);
  const entry={expiresAt:Number.POSITIVE_INFINITY,promise:null,value:null};
  const promise=enqueueRobotProgress(async()=>{
    const order=simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_REQUIRED_ORDER;
    if(!simulation&&!robotOnline(robot.robot_key))return {available:false,completed:0,total:order.length,percent:0,reason:'offline'};
    const workspace=simulation?wsRoot(robot.robot_key):(robot.workspace||'~/ros2_ws');
    const result=simulation?await scanLocalProjectAsync(workspace):await agentReq(robot.robot_key,'exec',{command:`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(buildProjectScanScript(workspace),'utf8').toString('base64')}'))"`,timeout:15000});
    const summary=parseProjectScanOutput(result.stdout);
    if(simulation){
      const replacements=[inspectSimMapCapability(robot.robot_key),...inspectSimulationMissionArtifacts(workspace)];
      for(const capability of replacements){const index=summary.capabilities.findIndex(item=>item.id===capability.id);if(index>=0)summary.capabilities[index]=capability;else summary.capabilities.push(capability);}
    }else{
      summary.capabilities.push(await inspectRealRobotSystem(robot.robot_key));
    }
    return summarizeRobotWizard(summary.capabilities,simulation);
  }).catch(error=>({available:false,completed:0,total:(simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_REQUIRED_ORDER).length,percent:0,reason:error.message||'scan_failed'}));
  entry.promise=promise;robotProgressCache.set(robot.robot_key,entry);
  promise.then(value=>{entry.value=value;entry.expiresAt=Date.now()+30000;});
  return promise;
}

function robotWizardProgressView(robot){
  const simulation=isSim(robot.robot_key),order=simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_REQUIRED_ORDER;
  if(!simulation&&!robotOnline(robot.robot_key))return {available:false,pending:false,completed:0,total:order.length,percent:0,reason:'offline'};
  inspectRobotWizardProgress(robot);
  const entry=robotProgressCache.get(robot.robot_key);
  return entry?.value||{available:false,pending:true,completed:0,total:order.length,percent:0,reason:'scanning'};
}

function robotOnlineUserCount(robotKey){
  const users=robotPresenceSockets.get(robotKey);if(!users)return 0;
  let count=0;
  for(const sockets of users.values())if([...sockets].some(socket=>socket.readyState===WebSocket.OPEN))count++;
  return count;
}

app.get('/api/robots',auth,async(req,res)=>{
  try{
    // A physical robot is canonical in robots; user access lives in robot_user_access.
    let rows;
    if(req.user.role==='admin'){
      [rows]=await db.query('SELECT r.*,u.username as added_by_name,(SELECT connected_at FROM robot_connections rc WHERE rc.robot_id=r.id ORDER BY rc.id DESC LIMIT 1) as last_connected FROM robots r LEFT JOIN users u ON r.added_by=u.id ORDER BY r.created_at DESC, r.id DESC');
    } else {
      [rows]=await db.query("SELECT r.*,rua.alias access_alias,u.username as added_by_name,(SELECT connected_at FROM robot_connections rc WHERE rc.robot_id=r.id ORDER BY rc.id DESC LIMIT 1) as last_connected FROM robot_user_access rua JOIN robots r ON r.id=rua.robot_id LEFT JOIN users u ON r.added_by=u.id LEFT JOIN cluster_user_access cua ON cua.cluster_id=r.cluster_id AND cua.user_id=rua.user_id LEFT JOIN clusters c ON c.id=r.cluster_id WHERE rua.user_id=? AND (r.robot_key NOT LIKE 'SIM-%' OR (cua.user_id IS NOT NULL AND c.enabled=1)) ORDER BY rua.created_at DESC, r.id DESC",[req.user.id]);
    }
    const activeByRobot=new Map();
    for(const[sessionId,session]of sessions)if(session.userId===req.user.id&&(!session.expiresAt||session.expiresAt>Date.now()))activeByRobot.set(session.robotDbId,sessionId);
    const robots=rows.map(robot=>{
      const isOwner=Number(robot.added_by)===Number(req.user.id),canonicalName=robot.name;
      return {...robot,name:robot.access_alias||canonicalName,canonicalName,ssh_pass:undefined,isOwner,isOwn:req.user.role==='admin'?isOwner:true,canManage:req.user.role==='admin'||isOwner,online:robotOnline(robot.robot_key),agentVersion:agents.get(robot.robot_key)?.version||robot.agent_version||null,onlineUsers:robotOnlineUserCount(robot.robot_key),connected:activeByRobot.has(robot.id),wizardProgress:robotWizardProgressView(robot)};
    });
    res.json({ok:true,robots,quota:await getUserRobotQuota(req.user),isAdmin:req.user.role==='admin'});
  }catch(e){res.json({ok:false,error:e.message});}
});

// Route physical IDE traffic before opening a Cloud session. The Cloud only
// recommends Local after the robot confirms that it can reach this client.
app.post('/api/robots/:id/route',auth,async(req,res)=>{
  try{
    const preview=req.body?.preview===true;
    const robot=await accessibleRobot(req.user,Number(req.params.id));
    if(!robot)return res.status(404).json({ok:false,error:'Robot not found'});
    if(isSim(robot.robot_key))return res.json({ok:true,route:'cloud',simulation:true});
    const address=browserAddress(req.socket.remoteAddress,req.headers['x-forwarded-for'],configValue('TRUST_PROXY')==='true',Number(configValue('TRUST_PROXY_HOPS')||1));
    const agent=agents.get(robot.robot_key);
    if(!agent?.capabilities?.includes('lan-route-v1')){
      if(!preview&&agent?.capabilities?.includes('control-mode-v1')){
        const oldStatus=await agentReq(robot.robot_key,'agent_status',{},3000);
        if(oldStatus.mode==='local'){
          try{await agentReq(robot.robot_key,'control_select',{mode:'online',confirm:true},3000);}
          catch(error){return res.status(409).json({ok:false,error:`หุ่นยนต์ยังใช้ Local และมีงานค้าง: ${error.message}`});}
        }
      }
      return res.json({ok:true,route:'cloud',reason:'agent_update_required',browserIp:address||null});
    }
    // This is the browser connection's address, never the Cloud host's LAN IP.
    // Only a trusted loopback proxy may supply X-Forwarded-For.
    const status=await agentReq(robot.robot_key,'agent_status',{},3000);
    const lanInterfaces=status.localHost==='0.0.0.0'?status.lanInterfaces:status.lanInterfaces?.filter(entry=>entry.address===status.localHost);
    const localUrls=status.localEnabled?localCandidateUrls(lanInterfaces,Number(status.localPort)):[];
    const preferredLocalUrl=String(req.body?.preferredLocalUrl||'');
    if(preferredLocalUrl){
      if(preview||!localUrls.includes(preferredLocalUrl))return res.status(400).json({ok:false,error:'URL Local นี้ไม่ใช่ที่อยู่ของ Agent'});
      if(!agent.capabilities.includes('local-handoff-v1'))return res.status(409).json({ok:false,error:'Agent ต้องอัปเดตก่อนเข้า Local'});
      // An explicit URL click is proof of the user's choice, not proof of LAN
      // reachability. Cloud proxies can hide the browser's private LAN address.
      const ticket=crypto.randomBytes(32).toString('base64url');
      await agentReq(robot.robot_key,'local_handoff',{ticket,sudoPassword:decrypt(robot.ssh_pass),username:req.user.username},5000);
      return res.json({ok:true,route:'local',localUrl:preferredLocalUrl,handoff:ticket,manual:true,lanVerified:false,browserIp:address||null});
    }
    const localUrl=status.localEnabled&&address?routeForClient(address,lanInterfaces,Number(status.localPort)):null;
    let localFailure='lan_probe_failed';
    if(localUrl){
      const sameHost=address===new URL(localUrl).hostname;
      const probe=await agentReq(robot.robot_key,'lan_probe',{address},3000);
      // Older Agents reject Tailnet peers when their VPN interface has a /32
      // mask. Check those peers once through the Agent until it is updated.
      const legacyTailnetPeer=routeForClient(address,[{address:new URL(localUrl).hostname,netmask:'255.255.255.255'}],Number(status.localPort))===localUrl;
      const legacyProbeNeeded=!probe.reachable&&status.mode==='online'&&/^2\.4\.[0-5]$/.test(status.version||'')&&(sameHost||legacyTailnetPeer);
      const legacyProbeReady=legacyProbeNeeded&&await agentReq(robot.robot_key,'exec',{
        command:`ping -n -c 1 -W 1 ${address} >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:${Number(status.localPort)}/api/local/info >/dev/null 2>&1`,timeout:4000,
      },5000).then(result=>result.code===0).catch(()=>false);
      if(probe.reachable||legacyProbeReady){
        localFailure='local_handoff_unavailable';
        const route={ok:true,route:'local',localUrl,localUrls,browserIp:address,agentIp:new URL(localUrl).hostname,ping:'reachable',pingMs:Number.isFinite(probe.latencyMs)?probe.latencyMs:null,sameHost};
        if(preview)return res.json(agent.capabilities.includes('local-handoff-v1')?route:{ok:true,route:'cloud',reason:'local_handoff_unavailable',browserIp:address,localUrls});
        if(agent.capabilities.includes('local-handoff-v1')){
          const ticket=crypto.randomBytes(32).toString('base64url');
          try{
            await agentReq(robot.robot_key,'local_handoff',{ticket,sudoPassword:decrypt(robot.ssh_pass),username:req.user.username},5000);
            return res.json({...route,handoff:ticket});
          }catch(error){console.warn('[LOCAL HANDOFF]',robot.robot_key,error.message);}
        }
        // Do not send the browser to a Local login page when the Agent still
        // lacks the one-time handoff protocol; use Cloud until it is updated.
      }
    }
    // A click to open this robot authorizes choosing the reachable route.
    // The Agent refuses a mode change while any terminal or operation is busy.
    if(!preview&&status.mode==='local'){
      try{await agentReq(robot.robot_key,'control_select',{mode:'online',confirm:true},3000);}
      catch(error){return res.status(409).json({ok:false,error:`หุ่นยนต์ยังใช้ Local และมีงานค้าง: ${error.message}`});}
    }
    res.json({ok:true,route:'cloud',reason:localUrl?localFailure:address?'different_network':'browser_ip_unavailable',browserIp:address||null,localUrls});
  }catch(error){res.json({ok:true,route:'cloud',reason:'agent_unavailable'});}
});

app.post('/api/robots/progress',auth,async(req,res)=>{
  try{
    const ids=[...new Set((Array.isArray(req.body?.robotIds)?req.body.robotIds:[]).map(Number).filter(Number.isInteger).filter(id=>id>0))].slice(0,250);
    if(!ids.length)return res.json({ok:true,robots:[]});
    const marks=ids.map(()=>'?').join(','),params=req.user.role==='admin'?ids:[req.user.id,...ids];
    const sql=req.user.role==='admin'?`SELECT r.* FROM robots r WHERE r.id IN (${marks})`:`SELECT r.* FROM robot_user_access rua JOIN robots r ON r.id=rua.robot_id LEFT JOIN cluster_user_access cua ON cua.cluster_id=r.cluster_id AND cua.user_id=rua.user_id LEFT JOIN clusters c ON c.id=r.cluster_id WHERE rua.user_id=? AND r.id IN (${marks}) AND (r.robot_key NOT LIKE 'SIM-%' OR (cua.user_id IS NOT NULL AND c.enabled=1))`;
    const[rows]=await db.query(sql,params);
    res.json({ok:true,robots:rows.map(robot=>({id:robot.id,online:robotOnline(robot.robot_key),onlineUsers:robotOnlineUserCount(robot.robot_key),wizardProgress:robotWizardProgressView(robot)}))});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/robots',auth,async(req,res)=>{
  const{robot_key,name,ssh_user,ssh_pass,workspace,description}=req.body;
  if(!robot_key||!name) return res.status(400).json({ok:false,error:'robot_key and name required'});
  if((/^sim-/i.test(String(robot_key))&&!String(robot_key).startsWith('SIM-'))||String(robot_key).length>80||!/^(SIM-)?[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(robot_key)) return res.status(400).json({ok:false,error:'Invalid robot key'});
  let connection,transaction=false,committed=false;
  const userLock=`roside_robot_quota_${req.user.id}`;
  const keyLock=`roside_robot_${crypto.createHash('sha256').update(String(robot_key).toLowerCase()).digest('hex').slice(0,32)}`;
  const heldLocks=[];
  try{
    connection=await db.getConnection();
    for(const lockName of [userLock,keyLock]){
      const[[lock]]=await connection.query('SELECT GET_LOCK(?,5) acquired',[lockName]);
      if(Number(lock?.acquired)!==1)return res.status(503).json({ok:false,error:'ระบบกำลังบันทึกหุ่นยนต์รายการอื่น กรุณาลองใหม่'});
      heldLocks.push(lockName);
    }
    await connection.beginTransaction();transaction=true;
    const[existing]=await connection.query('SELECT * FROM robots WHERE robot_key=? FOR UPDATE',[robot_key]);
    const existingRobot=existing[0]||null,canonicalRobotKey=existingRobot?.robot_key||robot_key,simulation=isSim(canonicalRobotKey),kind=simulation?'simulation':'real';
    let simClusterId=null;
    if(simulation){
      simClusterId=Number(req.body.clusterId||1);
      if(!Number.isSafeInteger(simClusterId)||simClusterId<=0)return res.status(400).json({ok:false,error:'Invalid Cluster'});
      if(clusterIdForSim(robot_key)!==simClusterId||simClusterId===1&&/^SIM-C\d+-/.test(robot_key))return res.status(400).json({ok:false,error:'Sim key does not match Cluster'});
      const [allowed]=await connection.query(req.user.role==='admin'
        ?'SELECT id FROM clusters WHERE id=? AND enabled=1 FOR UPDATE'
        :'SELECT c.id FROM clusters c JOIN cluster_user_access a ON a.cluster_id=c.id AND a.user_id=? WHERE c.id=? AND c.enabled=1 FOR UPDATE',req.user.role==='admin'?[simClusterId]:[req.user.id,simClusterId]);
      if(!allowed.length)return res.status(403).json({ok:false,error:'Cluster unavailable or access denied'});
      if(simClusterId!==1&&!clusterBus.connected(simClusterId))return res.status(503).json({ok:false,error:'Ubuntu Cluster is offline'});
    }
    if(existingRobot&&simulation)return res.status(409).json({ok:false,code:'SIMULATION_KEY_EXISTS',error:'Simulation key นี้ถูกใช้แล้ว กรุณาสร้าง Simulation ตัวใหม่'});
    if(existingRobot){
      const[access]=await connection.query('SELECT 1 FROM robot_user_access WHERE robot_id=? AND user_id=?',[existingRobot.id,req.user.id]);
      if(access.length)return res.status(409).json({ok:false,code:'ROBOT_ALREADY_ADDED',error:'หุ่นยนต์ตัวนี้อยู่ในทีมของคุณแล้ว'});
    }
    const membership=await getMembership(req.user,connection);
    if(!membership.isUnlimited){
      const[countRows]=await connection.query("SELECT COALESCE(SUM(r.robot_key LIKE 'SIM-%'),0) simulation_count,COALESCE(SUM(r.robot_key NOT LIKE 'SIM-%'),0) real_count FROM robot_user_access rua JOIN robots r ON r.id=rua.robot_id WHERE rua.user_id=?",[req.user.id]);
      const count=Number(countRows[0]?.[kind+'_count'])||0;
      if(count>=ROBOT_LIMITS[kind]){const quota=await getUserRobotQuota(req.user,connection);return res.status(409).json({ok:false,code:simulation?'SIMULATION_LIMIT_REACHED':'REAL_ROBOT_LIMIT_REACHED',error:simulation?'ผู้ใช้สร้าง Simulation ได้สูงสุด 2 ตัว กรุณาลบตัวเดิมก่อนสร้างใหม่':'ผู้ใช้เพิ่มหุ่นยนต์จริงได้สูงสุด 2 ตัว กรุณาลบตัวเดิมก่อนเพิ่มใหม่',quota});}
    }
    let robotId,attached=false;
    if(existingRobot){
      robotId=existingRobot.id;attached=true;
      await connection.query('INSERT INTO robot_user_access(robot_id,user_id,alias) VALUES(?,?,?)',[robotId,req.user.id,name||null]);
    }else{
      const[r]=await connection.query('INSERT INTO robots(robot_key,name,ssh_user,ssh_pass,workspace,description,added_by,cluster_id)VALUES(?,?,?,?,?,?,?,?)',[robot_key,name,ssh_user||'ubuntu',encrypt(ssh_pass||''),workspace||'~/ros2_ws',description||'',req.user.id,simClusterId]);
      robotId=r.insertId;
      await connection.query('INSERT INTO robot_user_access(robot_id,user_id,alias) VALUES(?,?,NULL)',[robotId,req.user.id]);
    }
    await connection.commit();committed=true;
    refreshStatusAccess(req.user.id);
    if(!attached)for(const adminId of new Set([...statusSubs].filter(socket=>socket.user?.role==='admin').map(socket=>Number(socket.user.id))))refreshStatusAccess(adminId);
    res.json({ok:true,id:robotId,attached,quota:await getUserRobotQuota(req.user,connection)});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
  finally{if(connection){if(transaction&&!committed)await connection.rollback().catch(()=>{});for(const lockName of heldLocks.reverse())await connection.query('SELECT RELEASE_LOCK(?)',[lockName]).catch(()=>{});connection.release();}}
});

app.put('/api/robots/:id',auth,async(req,res)=>{
  const{name,ssh_user,ssh_pass,workspace,description}=req.body;
  try{
    const robot=await accessibleRobot(req.user,Number(req.params.id));
    if(!robot) return res.status(404).json({ok:false,error:'Not found'});
    const canManage=req.user.role==='admin'||Number(robot.added_by)===Number(req.user.id);
    if(!canManage){
      await db.query('UPDATE robot_user_access SET alias=? WHERE robot_id=? AND user_id=?',[String(name||robot.name).trim().slice(0,128)||robot.name,robot.id,req.user.id]);
      return res.json({ok:true,aliasOnly:true});
    }
    const enc=ssh_pass?encrypt(ssh_pass):robot.ssh_pass;
    await db.query('UPDATE robots SET name=?,ssh_user=?,ssh_pass=?,workspace=?,description=? WHERE id=?',[name||robot.name,ssh_user||robot.ssh_user,enc,workspace||robot.workspace,description??robot.description,robot.id]);
    robotProgressCache.delete(robot.robot_key);
    res.json({ok:true,aliasOnly:false});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.delete('/api/robots/:id',auth,async(req,res)=>{
  let connection,transaction=false,committed=false,lockName='';
  try{
    const robotId=Number(req.params.id),visible=await accessibleRobot(req.user,robotId);
    if(!visible)return res.status(404).json({ok:false,error:'Not found'});
    lockName=`roside_robot_${crypto.createHash('sha256').update(String(visible.robot_key).toLowerCase()).digest('hex').slice(0,32)}`;
    connection=await db.getConnection();
    const[[lock]]=await connection.query('SELECT GET_LOCK(?,5) acquired',[lockName]);
    if(Number(lock?.acquired)!==1)return res.status(503).json({ok:false,error:'ระบบกำลังแก้ไขหุ่นยนต์ตัวนี้ กรุณาลองใหม่'});
    await connection.beginTransaction();transaction=true;
    await connection.query('SELECT id FROM robots WHERE id=? FOR UPDATE',[robotId]);
    const robot=await accessibleRobot(req.user,robotId,connection);
    if(!robot)return res.status(404).json({ok:false,error:'Not found'});
    const[accessRows]=await connection.query('SELECT user_id FROM robot_user_access WHERE robot_id=? ORDER BY created_at ASC,user_id ASC FOR UPDATE',[robot.id]);
    const owner=Number(robot.added_by)===Number(req.user.id),others=accessRows.filter(row=>Number(row.user_id)!==Number(req.user.id));
    if(req.user.role!=='admin'&&(!owner||others.length)){
      if(owner&&others.length){await connection.query('UPDATE robots SET added_by=? WHERE id=?',[others[0].user_id,robot.id]);await connection.query('UPDATE robot_user_access SET alias=NULL WHERE robot_id=? AND user_id=?',[robot.id,others[0].user_id]);}
      await connection.query('DELETE FROM robot_user_access WHERE robot_id=? AND user_id=?',[robot.id,req.user.id]);
      await connection.query('UPDATE robot_connections SET disconnected_at=COALESCE(disconnected_at,NOW()) WHERE robot_id=? AND user_id=?',[robot.id,req.user.id]);
      await connection.commit();committed=true;
      bumpRobotAccessGeneration(req.user.id,robot.id);
      for(const[sessionId,session]of sessions)if(session.robotDbId===robot.id&&session.userId===req.user.id){sessions.delete(sessionId);closeOperationalSockets(session.userId,session.robotKey,'Robot access removed');}
      closeRobotPresence(req.user.id,robot.robot_key);refreshStatusAccess(req.user.id);releaseSimRuntimeIfUnused(robot.robot_key);
      return res.json({ok:true,detached:true,ownershipTransferred:owner&&others.length>0});
    }
    const affectedUserIds=accessRows.map(row=>Number(row.user_id));
    await connection.query('DELETE FROM robots WHERE id=?',[robot.id]);
    await connection.commit();committed=true;
    affectedUserIds.forEach(userId=>bumpRobotAccessGeneration(userId,robot.id));
    for(const[sessionId,session]of sessions)if(session.robotDbId===robot.id){sessions.delete(sessionId);closeOperationalSockets(session.userId,session.robotKey,'Robot removed');}
    failAgentWork(robot.robot_key,'Robot removed');
    const agent=agents.get(robot.robot_key);agents.delete(robot.robot_key);if(agent)try{agent.ws.close();}catch{}
    broadcastStatus(robot.robot_key,false);robotProgressCache.delete(robot.robot_key);dashboardRuntimeCache.delete(robot.robot_key);projectScanCache.delete(robot.robot_key);closeRobotPresence(null,robot.robot_key);
    new Set([...affectedUserIds,...[...statusSubs].filter(socket=>socket.user?.role==='admin').map(socket=>Number(socket.user.id))]).forEach(refreshStatusAccess);
    return res.json({ok:true,detached:false});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
  finally{if(connection){if(transaction&&!committed)await connection.rollback().catch(()=>{});if(lockName)await connection.query('SELECT RELEASE_LOCK(?)',[lockName]).catch(()=>{});connection.release();}}
});

// ── IDE Connect/Disconnect ───────────────────────────────────
async function robotRosInfo(robot){
  const agent=agents.get(robot.robot_key);
  if(agent?.rosInfo)return agent.rosInfo;
  if(agent?.rosInfoPromise)return agent.rosInfoPromise;
  const promise=agentReq(robot.robot_key,'exec',{command:`bash -lc 'setup=$(ls /opt/ros/*/setup.bash 2>/dev/null | head -1); [ -n "$setup" ] && source "$setup" 2>/dev/null; echo ROS_DISTRO=\${ROS_DISTRO:-unknown}; echo SETUP=\${setup:-/opt/ros/humble/setup.bash}'`,timeout:3500},4500)
    .then(data=>{const distro=data.stdout.match(/ROS_DISTRO=(\S+)/),setup=data.stdout.match(/SETUP=(\S+)/);return{distro:distro?.[1]||'unknown',setupBash:setup?.[1]||'/opt/ros/humble/setup.bash',version:'2'};})
    .catch(()=>({distro:'unknown',setupBash:'/opt/ros/humble/setup.bash',version:'2'}));
  if(agent)agent.rosInfoPromise=promise;
  const info=await promise;
  if(agent){agent.rosInfo=info;agent.rosInfoPromise=null;}
  return info;
}

async function createRobotSessionInternal(robot,user,{recordConnection=true}={}){
  if(localRuntime)recordConnection=false;
  const accessGeneration=robotAccessGeneration(user.id,robot.id);
  if(isSim(robot.robot_key)&&clusterIdForSim(robot.robot_key)===1&&user.role!=='admin'&&process.env.ALLOW_UNSANDBOXED_SIM!=='true'){
    const error=new Error('Student simulation is disabled until an isolated runtime is configured');error.status=503;throw error;
  }
  if(isSim(robot.robot_key)){
    const clusterId=Number(robot.cluster_id||1);
    if(clusterId!==1&&!clusterBus.connected(clusterId))throw Object.assign(new Error('Ubuntu Cluster is offline'),{status:503});
    await acquireSimLease(robot);
    try{if(!agents.has(robot.robot_key))ensureSim(robot.robot_key);}
    catch(error){await releaseSimLease(robot.robot_key);throw error;}
  }
  const ag=agents.get(robot.robot_key);
  if(!ag||ag.ws.readyState!==WebSocket.OPEN){const error=new Error('Robot offline');error.status=503;throw error;}
  for(const[existingId,existing]of sessions)if(existing.userId===user.id&&existing.robotDbId===robot.id&&liveSession(existing)){if(existing.sudoPassword===undefined)existing.sudoPassword=decrypt(robot.ssh_pass);existing.lastSeen=Date.now();return{ok:true,sessionId:existingId,robotId:robot.id,robotKey:robot.robot_key,rosInfo:existing.rosInfo,workspace:existing.workspace,username:existing.username,robotName:robot.access_alias||robot.name,isSim:isSim(robot.robot_key),onlineUsers:robotOnlineUserCount(robot.robot_key),reused:true};}
  const activeRobotIds=new Set([...sessions.values()].filter(session=>session.userId===user.id&&(!session.expiresAt||session.expiresAt>Date.now())).map(session=>session.robotDbId));
  const reservations=activeSessionReservations.get(user.id)||new Set();
  reservations.forEach(robotId=>activeRobotIds.add(robotId));
  if(!activeRobotIds.has(robot.id)&&activeRobotIds.size>=ROBOT_LIMITS.activeConnections){releaseSimRuntimeIfUnused(robot.robot_key);const error=new Error('เชื่อมต่อหุ่นยนต์พร้อมกันได้สูงสุด 2 ตัว กรุณาตัดการเชื่อมต่อตัวที่ไม่ใช้ก่อน');error.status=409;error.code='ACTIVE_ROBOT_LIMIT_REACHED';throw error;}
  reservations.add(robot.id);activeSessionReservations.set(user.id,reservations);
  const sessionId=mkId();
  try{
    const rosInfo=await robotRosInfo(robot),now=Date.now();
    const currentRobot=await accessibleRobot(user,robot.id);
    if(!currentRobot){const error=new Error('Robot access was removed while connecting');error.status=403;throw error;}
    let connectionId=null;
    if(recordConnection){const[result]=await db.query('INSERT INTO robot_connections(robot_id,user_id)VALUES(?,?)',[robot.id,user.id]);connectionId=result.insertId;}
    if(robotAccessGeneration(user.id,robot.id)!==accessGeneration){if(connectionId)await db.query('UPDATE robot_connections SET disconnected_at=NOW() WHERE id=?',[connectionId]).catch(()=>{});const error=new Error('Robot access was removed while connecting');error.status=403;throw error;}
    sessions.set(sessionId,{robotKey:currentRobot.robot_key,robotDbId:currentRobot.id,rosInfo,workspace:currentRobot.workspace,username:currentRobot.ssh_user,sudoPassword:decrypt(currentRobot.ssh_pass),userId:user.id,connectionId,lastSeen:now,expiresAt:now+24*60*60*1000});
    return{ok:true,sessionId,robotId:robot.id,robotKey:robot.robot_key,rosInfo,workspace:robot.workspace,username:robot.ssh_user,robotName:robot.access_alias||robot.name,isSim:isSim(robot.robot_key),onlineUsers:robotOnlineUserCount(robot.robot_key)};
  }catch(error){releaseSimRuntimeIfUnused(robot.robot_key);throw error;}
  finally{reservations.delete(robot.id);if(!reservations.size)activeSessionReservations.delete(user.id);}
}

async function createRobotSession(robot,user,options={}){
  const key=`${user.id}:${robot.id}`,opening=sessionOpenPromises.get(key);
  if(opening)return opening;
  const promise=createRobotSessionInternal(robot,user,options);
  sessionOpenPromises.set(key,promise);
  try{return await promise;}
  finally{if(sessionOpenPromises.get(key)===promise)sessionOpenPromises.delete(key);}
}

app.post('/api/connect',auth,async(req,res)=>{
  const{robotId}=req.body;
  try{
    const robot=await accessibleRobot(req.user,Number(robotId));
    if(!robot) return res.status(404).json({ok:false,error:'Robot not found'});
    res.json(await createRobotSession(robot,req.user));
  }catch(e){res.status(e.status||200).json({ok:false,code:e.code,error:e.message});}
});

app.post('/api/robots/:id/disconnect',auth,async(req,res)=>{
  try{
    const robotId=Number(req.params.id),robot=await accessibleRobot(req.user,robotId);
    if(!robot)return res.status(404).json({ok:false,error:'Robot not found'});
    let disconnected=0;
    for(const[sessionId,session]of sessions)if(session.userId===req.user.id&&session.robotDbId===robotId){sessions.delete(sessionId);closeOperationalSockets(session.userId,session.robotKey,'Session disconnected');disconnected++;}
    await db.query('UPDATE robot_connections SET disconnected_at=NOW() WHERE robot_id=? AND user_id=? AND disconnected_at IS NULL',[robotId,req.user.id]);
    closeRobotPresence(req.user.id,robot.robot_key);releaseSimRuntimeIfUnused(robot.robot_key);
    res.json({ok:true,disconnected,quota:await getUserRobotQuota(req.user)});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/session/restore',auth,async(req,res)=>{
  try{
    const old=sessions.get(req.body.sessionId);
    let robotId=null;
    if(old&&old.userId===req.user.id&&(!old.expiresAt||old.expiresAt>Date.now()))robotId=old.robotDbId;
    else if(/^\d+$/.test(String(req.body.robotId||'')))robotId=Number(req.body.robotId);
    if(!robotId){
      const[recent]=await db.query('SELECT robot_id FROM robot_connections WHERE user_id=? AND disconnected_at IS NULL ORDER BY id DESC LIMIT 1',[req.user.id]);
      robotId=recent[0]?.robot_id;
    }
    if(!robotId)return res.status(404).json({ok:false,error:'No robot session to restore'});
    const robot=await accessibleRobot(req.user,robotId);
    if(!robot)return res.status(404).json({ok:false,error:'Robot not found'});
    if(old&&old.userId===req.user.id&&old.robotDbId===robot.id&&robotOnline(robot.robot_key)){
      old.lastSeen=Date.now();old.expiresAt=Date.now()+24*60*60*1000;
      return res.json({ok:true,sessionId:req.body.sessionId,robotId:robot.id,robotKey:robot.robot_key,rosInfo:old.rosInfo,workspace:old.workspace,username:old.username,robotName:robot.access_alias||robot.name,isSim:isSim(robot.robot_key),onlineUsers:robotOnlineUserCount(robot.robot_key),restored:true});
    }
    res.json({...await createRobotSession(robot,req.user),restored:false});
  }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
});

app.post('/api/disconnect',auth,async(req,res)=>{
  const sess=sessions.get(req.body.sessionId);
  if(sess && sess.userId!==req.user.id) return res.status(403).json({ok:false,error:'Forbidden'});
  if(sess){sessions.delete(req.body.sessionId);closeOperationalSockets(sess.userId,sess.robotKey,'Session disconnected');closeRobotPresence(req.user.id,sess.robotKey);await db.query('UPDATE robot_connections SET disconnected_at=NOW() WHERE robot_id=? AND user_id=? AND disconnected_at IS NULL',[sess.robotDbId,req.user.id]).catch(()=>{});releaseSimRuntimeIfUnused(sess.robotKey);}
  res.json({ok:true});
});

// ── FS/Exec API ──────────────────────────────────────────────
function getSess(req){return sessions.get(req.body.sessionId||req.query.sessionId);}
function getOwnedSess(req){const s=getSess(req);if(s&&req.user&&s.userId===req.user.id&&liveSession(s)){s.lastSeen=Date.now();return s;}return null;}
async function fsOp(req,res,action){
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey)&&!['fs_read','fs_list'].includes(action)){
    const root=wsRoot(s.robotKey),mapFile=path.join(root,'map.json');
    const touchesMap=[req.body.path,req.body.from,req.body.to].filter(value=>typeof value==='string').some(value=>{
      const target=toAbs(root,'',value),relative=path.relative(target,mapFile);
      return target===mapFile||(!relative.startsWith('..')&&!path.isAbsolute(relative));
    });
    if(touchesMap&&mapsimQueue.busy(s.robotKey))return res.status(409).json({ok:false,error:'สนามนี้มีงานอยู่ในคิว กรุณารอให้เสร็จก่อนแก้ไขไฟล์แผนที่'});
  }
  try{const d=await agentReq(s.robotKey,action,req.body);if(action!=='fs_list'&&action!=='fs_read')invalidateProjectScan(s);res.json({ok:true,...d});}
  catch(e){res.json({ok:false,error:e.message});}
}
app.post('/api/files/list',  auth,(q,r)=>fsOp(q,r,'fs_list'));
app.post('/api/files/read',  auth,(q,r)=>fsOp(q,r,'fs_read'));
app.post('/api/files/write', auth,(q,r)=>fsOp(q,r,'fs_write'));
app.post('/api/files/mkdir', auth,(q,r)=>fsOp(q,r,'fs_mkdir'));
app.post('/api/files/rename',auth,(q,r)=>fsOp(q,r,'fs_rename'));
app.post('/api/files/delete',auth,(q,r)=>fsOp(q,r,'fs_delete'));

// ── Save Transformation TF as a `sim_robot_tf` ROS2 package in the workspace ──
// Creates the package if it does not exist, otherwise overwrites (edits) it.
// files: { 'package.xml':'...', 'urdf/robot.urdf':'...', ... }  relative to the package dir.
async function saveGeneratedRobotPackage(s, packageName, files) {
  if (isSim(s.robotKey)) {
    if (packageName === 'sim_robot_tf') return writeTfPackage(s.robotKey, files);
    if (packageName === 'sim_robot_odom') return writeOdomPackage(s.robotKey, files);
    throw new Error('Unsupported generated robot package');
  }
  const base = (s.workspace || '~/ros2_ws').replace(/\/$/, '');
  const written = [];
  for (const [rel, content] of Object.entries(files || {})) {
    const normalized = path.posix.normalize(String(rel || '')).replace(/^\.\//, '');
    if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error('Invalid generated package path: ' + rel);
    }
    await agentReq(s.robotKey, 'fs_write', {
      path: `${base}/src/${packageName}/${normalized}`,
      content: content ?? '',
    });
    written.push(normalized);
  }
  return { created:false, written, pkgDir:`src/${packageName}` };
}
function invalidateRobotProgress(session){if(session?.robotKey)robotProgressCache.delete(session.robotKey);}
function invalidateProjectScan(sessionOrKey){
  const key=typeof sessionOrKey==='string'?(sessions.get(sessionOrKey)?.robotKey||sessionOrKey):sessionOrKey?.robotKey;
  if(key)projectScanCache.delete(key);
}

app.post('/api/sim/save-tf-package', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  try {
    const out = await saveGeneratedRobotPackage(s, 'sim_robot_tf', req.body.files || {});
    invalidateProjectScan(s);
    invalidateRobotProgress(s);
    res.json({ ok:true, sim:isSim(s.robotKey), ...out });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// ── Save Transformation Odometry as a `sim_robot_odom` ROS2 package in the workspace ──
// แพ็กเกจแยกจาก sim_robot_tf: โหนด wheel_odom (คำนวณ /odom จากล้อจริง) + config
// Creates the package if it does not exist, otherwise overwrites (edits) it.
// files: { 'package.xml':'...', 'sim_robot_odom/odom.py':'...', ... }  relative to the package dir.
app.post('/api/sim/save-odom-package', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  try {
    const out = await saveGeneratedRobotPackage(s, 'sim_robot_odom', req.body.files || {});
    invalidateProjectScan(s);
    invalidateRobotProgress(s);
    res.json({ ok:true, sim:isSim(s.robotKey), ...out });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// Supported 2D LiDAR drivers. The browser sends only this stable model id;
// repositories and destination folders stay server-controlled.
const REAL_LIDAR_CATALOG=Object.freeze({
  rplidar_a1:{brand:'SLAMTEC',model:'RPLIDAR A1/A1M8',repository:'https://github.com/Slamtec/sllidar_ros2.git',folder:'sllidar_ros2',packageName:'sllidar_ros2',launchPackage:'sllidar_ros2',launchFile:'sllidar_a1_launch.py',port:'/dev/ttyUSB0',baud:115200},
  rplidar_a2:{brand:'SLAMTEC',model:'RPLIDAR A2M8',repository:'https://github.com/Slamtec/sllidar_ros2.git',folder:'sllidar_ros2',packageName:'sllidar_ros2',launchPackage:'sllidar_ros2',launchFile:'sllidar_a2m8_launch.py',port:'/dev/ttyUSB0',baud:115200},
  rplidar_c1:{brand:'SLAMTEC',model:'RPLIDAR C1',repository:'https://github.com/Slamtec/sllidar_ros2.git',folder:'sllidar_ros2',packageName:'sllidar_ros2',launchPackage:'sllidar_ros2',launchFile:'sllidar_c1_launch.py',port:'/dev/ttyUSB0',baud:460800},
  rplidar_s2:{brand:'SLAMTEC',model:'RPLIDAR S2',repository:'https://github.com/Slamtec/sllidar_ros2.git',folder:'sllidar_ros2',packageName:'sllidar_ros2',launchPackage:'sllidar_ros2',launchFile:'sllidar_s2_launch.py',port:'/dev/ttyUSB0',baud:1000000},
  ydlidar_x4:{brand:'YDLIDAR',model:'X4',repository:'https://github.com/YDLIDAR/ydlidar_ros2.git',folder:'ydlidar_ros2',packageName:'ydlidar',launchPackage:'ydlidar',launchFile:'ydlidar_launch.py',port:'/dev/ttyUSB0',baud:128000,sampleRate:5,reversion:false},
  ydlidar_g4:{brand:'YDLIDAR',model:'G4',repository:'https://github.com/YDLIDAR/ydlidar_ros2.git',folder:'ydlidar_ros2',packageName:'ydlidar',launchPackage:'ydlidar',launchFile:'ydlidar_launch.py',port:'/dev/ttyUSB0',baud:230400,sampleRate:9,reversion:true},
  ldlidar_ld06:{brand:'LDROBOT',model:'LD06',repository:'https://github.com/ldrobotSensorTeam/ldlidar_stl_ros2.git',folder:'ldlidar_stl_ros2',packageName:'ldlidar_stl_ros2',launchPackage:'ldlidar_stl_ros2',launchFile:'ld06.launch.py',port:'/dev/ttyUSB0',baud:230400},
  ldlidar_ld19:{brand:'LDROBOT',model:'LD19',repository:'https://github.com/ldrobotSensorTeam/ldlidar_stl_ros2.git',folder:'ldlidar_stl_ros2',packageName:'ldlidar_stl_ros2',launchPackage:'ldlidar_stl_ros2',launchFile:'ld19.launch.py',port:'/dev/ttyUSB0',baud:230400},
  hokuyo_ust10lx:{brand:'Hokuyo',model:'UST-10LX',repository:'https://github.com/Hokuyo-aut/urg_node2.git',folder:'urg_node2',packageName:'urg_node2',launchPackage:'urg_node2',launchFile:'urg_node2.launch.py',port:'192.168.0.10',baud:null},
});
const shellQuote=value=>`'${String(value).replace(/'/g,`'\\''`)}'`;
const remoteShellPath=value=>String(value)==='~'?'"$HOME"':String(value).startsWith('~/')?`"$HOME"/${shellQuote(String(value).slice(2))}`:shellQuote(value);

function selectedLidarPort(requested,device){
  const value=String(requested||device.port||'').trim();
  if(device.port.includes('.'))return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)?value:device.port;
  // USB LiDARs must never silently fall back to the board UART (ttyAMA/ttyTHS).
  // A UART can be opened successfully while talking to no LiDAR, which produces a misleading SDK timeout.
  return /^\/dev\/(?:tty(?:USB|ACM)\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/.test(value)?value:device.port;
}
function selectedLidarBaud(requested,device){
  if(device.baud===null)return null;
  const value=Number(requested);return Number.isInteger(value)&&value>=1200&&value<=4000000?value:device.baud;
}
function selectedLidarFrame(requested){
  const frame=String(requested||'laser_frame').trim();
  if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(frame))throw new Error('ชื่อ LiDAR TF frame ไม่ถูกต้อง');
  return frame;
}
function connectedLidarFrame(comps,requested){
  const frame=selectedLidarFrame(requested),nodes=Array.isArray(comps)?comps:[];
  if(!nodes.length)return frame;
  const byName=new Map(nodes.map(node=>[node.name,node]));
  const base=nodes.find(node=>node.type==='base')?.name||'base_link';
  const connected=name=>{
    const seen=new Set();let node=byName.get(name);
    while(node&&node.name!==base&&!seen.has(node.name)){seen.add(node.name);node=byName.get(node.parent);}
    return !!node&&node.name===base;
  };
  if(connected(frame))return frame;
  const candidates=nodes.filter(node=>node.type==='lidar'&&connected(node.name)).map(node=>node.name);
  if(candidates.length===1)return selectedLidarFrame(candidates[0]);
  throw new Error(candidates.length
    ?`LiDAR frame ${frame} ไม่เชื่อมถึง ${base} · เลือกเฟรม LiDAR ในหน้า TF: ${candidates.join(', ')}`
    :`LiDAR frame ${frame} ไม่เชื่อมถึง ${base} และไม่พบ LiDAR frame ที่เชื่อมต่อในโมเดล TF`);
}
function lidarTfLaunchCommands(comps,frameId){
  const frame=selectedLidarFrame(frameId),byName=new Map((Array.isArray(comps)?comps:[]).map(c=>[c.name,c]));
  const base=[...byName.values()].find(c=>c.type==='base')?.name||'base_link';
  if(!byName.size)return [`ros2 run tf2_ros static_transform_publisher --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 --frame-id ${shellQuote(base)} --child-frame-id ${shellQuote(frame)}`];
  const path=[],seen=new Set();let node=byName.get(frame);
  while(node&&node.name!==base&&!seen.has(node.name)){seen.add(node.name);path.unshift(node);node=byName.get(node.parent);}
  if(!node||node.name!==base)throw new Error(`LiDAR frame ${frame} ไม่เชื่อมถึง ${base} ในโมเดล TF`);
  return path.map(c=>{
    const values=[c.pos?.x,c.pos?.y,c.pos?.z,c.rpy?.r,c.rpy?.p,c.rpy?.y].map(Number);
    if(values.some(n=>!Number.isFinite(n))||!/^[A-Za-z][A-Za-z0-9_]*$/.test(c.parent)||!/^[A-Za-z][A-Za-z0-9_]*$/.test(c.name))throw new Error('ข้อมูล LiDAR TF ไม่ถูกต้อง');
    const [x,y,z,r,p,yaw]=values;
    return `ros2 run tf2_ros static_transform_publisher --x ${x} --y ${y} --z ${z} --yaw ${yaw*Math.PI/180} --pitch ${p*Math.PI/180} --roll ${r*Math.PI/180} --frame-id ${shellQuote(c.parent)} --child-frame-id ${shellQuote(c.name)}`;
  });
}
function lidarDirectLaunchCommand(device,port,baud,frameId='laser_frame'){
  const frame=shellQuote(selectedLidarFrame(frameId));
  if(device.brand==='YDLIDAR')return `ros2 run ${shellQuote(device.packageName)} ydlidar_node --ros-args -p port:=${shellQuote(port)} -p baudrate:=${Number(baud)} -p frame_id:=${frame}`;
  if(device.brand==='LDROBOT')return `ros2 run ldlidar_stl_ros2 ldlidar_stl_ros2_node --ros-args -p product_name:=${shellQuote(device.model.includes('LD19')?'LDLiDAR_LD19':'LDLiDAR_LD06')} -p topic_name:=scan -p frame_id:=${frame} -p port_name:=${shellQuote(port)} -p port_baudrate:=${Number(baud)}`;
  if(device.port.includes('.'))return `ros2 launch roside_lidar_setup lidar.launch.py ip_address:=${shellQuote(port)} frame_id:=${frame}`;
  if(device.launchFile==='sllidar_c1_launch.py')return `ros2 run sllidar_ros2 sllidar_node --ros-args -p channel_type:=serial -p serial_port:=${shellQuote(port)} -p serial_baudrate:=${Number(baud)} -p frame_id:=${frame} -p scan_mode:=Standard -p angle_compensate:=true`;
  return `ros2 launch ${shellQuote(device.launchPackage)} ${shellQuote(device.launchFile)} serial_port:=${shellQuote(port)} serial_baudrate:=${Number(baud)} frame_id:=${frame}`;
}

async function ensureSllidarChannelFix(s,paths,lidarModelId){
  if(!String(lidarModelId).startsWith('rplidar_'))return'';
  const sdkFile=`${paths.root}/src/sllidar_ros2/sdk/src/sl_async_transceiver.cpp`,marker=`${paths.root}/.roside/sllidar-channel-fix-v1`;
  const command=`set -eo pipefail
sdk_file=${remoteShellPath(sdkFile)}
marker=${remoteShellPath(marker)}
if [ -f "$marker" ] && ! grep -Fq 'Result<nullptr_t> ans = SL_RESULT_OK;' "$sdk_file" 2>/dev/null; then echo ROSIDE_SLLIDAR_CHANNEL_FIX=ready; exit 0; fi
test -f "$sdk_file" || { echo ROSIDE_SLLIDAR_CHANNEL_FIX=source-missing; exit 44; }
if grep -Fq 'Result<nullptr_t> ans = SL_RESULT_OK;' "$sdk_file"; then
  sed -i 's/^[[:space:]]*Result<nullptr_t> ans = SL_RESULT_OK;/        ans = RESULT_OK;/' "$sdk_file"
  echo ROSIDE_SLLIDAR_CHANNEL_FIX=patched
fi
grep -Fq 'Result<nullptr_t> ans = SL_RESULT_OK;' "$sdk_file" && { echo ROSIDE_SLLIDAR_CHANNEL_FIX=patch-failed; exit 45; }
source ${remoteShellPath(paths.setup)} 2>/dev/null
cd ${remoteShellPath(paths.root)}
layout=; [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = merged ] && layout=--merge-install
colcon build $layout --symlink-install --packages-select sllidar_ros2
mkdir -p ${remoteShellPath(paths.root+'/.roside')}
touch "$marker"
echo ROSIDE_SLLIDAR_CHANNEL_FIX=rebuilt`;
  const result=await agentReq(s.robotKey,'exec',{command,timeout:180000},185000),output=[result.stdout,result.stderr].filter(Boolean).join('\n').trim();
  if(result.code!==0){const error=new Error(output.slice(-8000)||'ซ่อมและ rebuild SLLidar driver ไม่สำเร็จ');error.stage='repair-lidar-driver';throw error;}
  return output.slice(-6000);
}

function lidarSerialPreflightCommand(port,baud){
  if(!SERIAL_DEVICE_PATTERN.test(String(port))||!Number.isInteger(Number(baud)))return'echo ROSIDE_SERIAL_PREFLIGHT=skipped';
  const python="import serial,sys; p=sys.argv[1]; b=int(sys.argv[2]);\ntry:\n s=serial.Serial(p,b,timeout=.2); print('ROSIDE_SERIAL_PREFLIGHT=ok port=%s baud=%d'%(p,b)); s.close()\nexcept Exception as e:\n print('ROSIDE_SERIAL_PREFLIGHT=failed type=%s detail=%s'%(type(e).__name__,str(e))); sys.exit(1)";
  return `serial_ok=0; for serial_try in 1 2; do if python3 -c ${shellQuote(python)} ${shellQuote(port)} ${Number(baud)}; then serial_ok=1; break; fi; echo ROSIDE_SERIAL_HOLDERS_BEGIN; fuser -v ${shellQuote(port)} 2>&1 || true; echo ROSIDE_SERIAL_HOLDERS_END; fuser -k ${shellQuote(port)} 2>/dev/null || true; sleep 2; done; [ "$serial_ok" -eq 1 ] || { echo ROSIDE_SERIAL_PREFLIGHT_GIVEUP; exit 53; }; sleep 1`;
}

async function resetRobotUsbSerial(session,port,password='',mode='interface'){
  if(!SERIAL_DEVICE_PATTERN.test(String(port)))throw Object.assign(new Error('COM port LiDAR ไม่ถูกต้อง จึงไม่รีเซ็ต USB'),{stage:'usb-reset'});
  if(!['interface','device'].includes(mode))throw Object.assign(new Error('รูปแบบการรีเซ็ต USB ไม่ถูกต้อง'),{stage:'usb-reset'});
  const script=`set -euo pipefail
trap 'rc=$?; echo "ROSIDE_USB_RESET=failed mode=$reset_mode line=$LINENO rc=$rc" >&2; exit $rc' ERR
requested=${shellQuote(port)}
reset_mode=${shellQuote(mode)}
real_port=$(readlink -f -- "$requested")
case "$real_port" in /dev/ttyUSB[0-9]*) ;; *) echo "ROSIDE_USB_RESET=refused real_port=$real_port" >&2; exit 61;; esac
tty_name=\${real_port#/dev/}
tty_path=$(readlink -f "/sys/class/tty/$tty_name/device")
iface_path=$(dirname "$tty_path")
iface=$(basename "$iface_path")
[[ "$iface" =~ ^[0-9]+-[0-9]+([.][0-9]+)*:[0-9]+[.][0-9]+$ ]] || { echo "ROSIDE_USB_RESET=refused interface=$iface" >&2; exit 62; }
driver_path=$(readlink -f "$iface_path/driver")
driver=$(basename "$driver_path")
case "$driver" in cp210x|ch341|ftdi_sio|usbserial) ;; *) echo "ROSIDE_USB_RESET=refused driver=$driver" >&2; exit 63;; esac
usb_device=\${iface%%:*}
[[ "$usb_device" =~ ^[0-9]+-[0-9]+([.][0-9]+)*$ ]] || { echo "ROSIDE_USB_RESET=refused usb_device=$usb_device" >&2; exit 64; }
if [ "$reset_mode" = device ]; then
  busnum=$(cat "/sys/bus/usb/devices/$usb_device/busnum")
  devnum=$(cat "/sys/bus/usb/devices/$usb_device/devnum")
  usb_node=$(printf '/dev/bus/usb/%03d/%03d' "$busnum" "$devnum")
  test -c "$usb_node"
  echo "ROSIDE_USB_RESET=begin mode=$reset_mode port=$real_port interface=$iface usb_device=$usb_device driver=$driver usb_node=$usb_node"
  python3 - "$usb_node" <<'ROSIDE_USBDEVFS'
import fcntl, os, sys
fd=os.open(sys.argv[1],os.O_WRONLY)
try: fcntl.ioctl(fd,21780,0)
finally: os.close(fd)
ROSIDE_USBDEVFS
else
  reset_path=$driver_path
  reset_target=$iface
  test -w "$reset_path/unbind" -a -w "$reset_path/bind"
  echo "ROSIDE_USB_RESET=begin mode=$reset_mode port=$real_port interface=$iface usb_device=$usb_device driver=$driver"
  printf '%s' "$reset_target" > "$reset_path/unbind"
  sleep 2
  printf '%s' "$reset_target" > "$reset_path/bind"
fi
sleep 3
udevadm settle --timeout=8 2>/dev/null || true
for wait_port in 1 2 3 4 5 6 7 8; do [ -c "$real_port" ] && break; sleep 1; done
test -c "$real_port"
echo "ROSIDE_USB_RESET=ready mode=$reset_mode port=$real_port interface=$iface usb_device=$usb_device driver=$driver"`;
  try{
    const result=await lidarSudoExec(session,script,password,25000);
    await ensureRobotSerialAccess(session,port,password);
    return [result.stdout,result.stderr].filter(Boolean).join('\n').trim();
  }catch(error){error.stage='usb-reset';throw error;}
}

async function restoreDetachedUsbSerial(session,port,password=''){
  if(!/^\/dev\/ttyUSB\d+$/.test(String(port)))return'';
  const present=await agentReq(session.robotKey,'exec',{command:`test -c ${shellQuote(port)}`,timeout:3000},5000).catch(()=>({code:1}));
  if(present.code===0)return'';
  const script=`set -euo pipefail
mapfile -t candidates < <(
  for vendor_file in /sys/bus/usb/devices/*/idVendor; do
    [ "$(cat "$vendor_file" 2>/dev/null)" = 10c4 ] || continue
    candidate=$(readlink -f "$(dirname "$vendor_file")")
    attached=0
    for tty_link in /sys/class/tty/ttyUSB*/device; do
      [ -e "$tty_link" ] || continue
      tty_path=$(readlink -f "$tty_link")
      case "$tty_path" in "$candidate"/*) attached=1;; esac
    done
    [ "$attached" -eq 0 ] && printf '%s\\n' "$candidate"
  done
)
[ "\${#candidates[@]}" -eq 1 ] || { echo "ROSIDE_USB_RESTORE=refused detached_silicon_labs_candidates=\${#candidates[@]}" >&2; exit 65; }
device_path=\${candidates[0]}
usb_device=$(basename "$device_path")
[[ "$usb_device" =~ ^[0-9]+-[0-9]+([.][0-9]+)*$ ]] || exit 66
echo "ROSIDE_USB_RESTORE=begin usb_device=$usb_device"
if [ ! -L "$device_path/driver" ]; then printf '%s' "$usb_device" > /sys/bus/usb/drivers/usb/bind; sleep 3; fi
for iface_path in /sys/bus/usb/devices/$usb_device:*; do
  [ -d "$iface_path" ] || continue
  [ -L "$iface_path/driver" ] && continue
  iface=$(basename "$iface_path")
  printf '%s' "$iface" > /sys/bus/usb-serial/drivers/cp210x/bind 2>/dev/null || true
done
udevadm settle --timeout=8 2>/dev/null || true
for wait_port in 1 2 3 4 5 6 7 8; do [ -c ${shellQuote(port)} ] && break; sleep 1; done
test -c ${shellQuote(port)}
echo "ROSIDE_USB_RESTORE=ready usb_device=$usb_device port=${String(port)}"`;
  try{const result=await lidarSudoExec(session,script,password,25000);return[result.stdout,result.stderr].filter(Boolean).join('\n').trim();}
  catch(error){error.stage='usb-restore';throw error;}
}

async function runLidarStartWithUsbRecovery(session,{command,port,password='',logPath,execTimeout,requestTimeout}){
  let started=await agentReq(session.robotKey,'exec',{command,timeout:execTimeout},requestTimeout),recoveryOutput='';
  if(started.code!==53)return{started,recoveryOutput};
  const readDiagnostic=()=>agentReq(session.robotKey,'exec',{command:`tail -120 ${remoteShellPath(logPath)} 2>&1 || true`,timeout:4000},6000).catch(()=>({stdout:'',stderr:''}));
  const diagnostic=await readDiagnostic();
  const firstOutput=[started.stdout,started.stderr,diagnostic.stdout,diagnostic.stderr].filter(Boolean).join('\n');
  if(!/(?:Errno 5|Input\/output error)/i.test(firstOutput))return{started:{...started,stdout:firstOutput},recoveryOutput};
  recoveryOutput=await resetRobotUsbSerial(session,port,password,'interface');
  started=await agentReq(session.robotKey,'exec',{command,timeout:execTimeout},requestTimeout);
  if(started.code===53){
    const afterInterface=await readDiagnostic(),interfaceOutput=[started.stdout,started.stderr,afterInterface.stdout,afterInterface.stderr].filter(Boolean).join('\n');
    if(/(?:Errno 5|Input\/output error)/i.test(interfaceOutput)){
      const deviceRecovery=await resetRobotUsbSerial(session,port,password,'device');
      recoveryOutput=[recoveryOutput,deviceRecovery].filter(Boolean).join('\n');
      started=await agentReq(session.robotKey,'exec',{command,timeout:execTimeout},requestTimeout);
    }else started={...started,stdout:interfaceOutput};
  }
  return{started:{...started,stdout:[recoveryOutput,started.stdout].filter(Boolean).join('\n')},recoveryOutput};
}

async function lidarSudoExec(s,command,password,timeout=180000){
  const probe=await agentReq(s.robotKey,'exec',{command:'sudo -n true >/dev/null 2>&1',timeout:5000},7000).catch(()=>({code:1}));
  const checked=result=>{
    if(result.code===0)return result;
    const detail=[result.stdout,result.stderr].filter(Boolean).join('\n').trim(),authFailed=/incorrect password|sorry, try again|authentication failure/i.test(detail),timedOut=result.code==null;
    const message=authFailed?'รหัส sudo ไม่ถูกต้อง กรุณากรอกใหม่':timedOut?`คำสั่งติดตั้งใช้เวลานานเกิน ${Math.round(timeout/60000)} นาที กรุณากดเริ่มอีกครั้ง ระบบจะติดตั้งต่อจากไฟล์ที่ดาวน์โหลดไว้`:(detail.slice(-6000)||'คำสั่ง sudo ไม่สำเร็จ');
    const error=new Error(message);error.requiresSudo=authFailed;error.commandTimedOut=timedOut;throw error;
  };
  if(probe.code===0)return checked(await agentReq(s.robotKey,'exec',{command:`sudo -n bash -lc ${shellQuote(command)}`,timeout},timeout+5000));
  const secret=String(password||s.sudoPassword||'');
  if(!secret||secret.includes('\n')||secret.length>256){
    const error=new Error('เครื่องหุ่นยนต์ต้องใช้รหัส sudo กรุณากรอกรหัส sudo แล้วกด Build ใหม่');error.requiresSudo=true;throw error;
  }
  const token=crypto.randomBytes(18).toString('hex'),fifo=`$HOME/.roside/sudo/${token}.pipe`,fifoPath=`~/.roside/sudo/${token}.pipe`;
  await agentReq(s.robotKey,'exec',{command:`install -d -m 700 "$HOME/.roside/sudo" && rm -f "${fifo}" && mkfifo -m 600 "${fifo}"`,timeout:5000},7000);
  try{
    const elevated=agentReq(s.robotKey,'exec',{command:`sudo -S -p '' bash -lc ${shellQuote(command)} < "${fifo}"; rc=$?; rm -f "${fifo}"; exit $rc`,timeout},timeout+5000);
    const [,result]=await Promise.all([agentReq(s.robotKey,'fs_write',{path:fifoPath,content:secret+'\n'},10000),elevated]);
    return checked(result);
  }finally{
    agentReq(s.robotKey,'exec',{command:`rm -f "${fifo}"`,timeout:3000},5000).catch(()=>{});
  }
}

const SERIAL_DEVICE_PATTERN=/^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|serial\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/;
async function ensureRobotSerialAccess(session,port,password=''){
  if(!SERIAL_DEVICE_PATTERN.test(String(port)))throw Object.assign(new Error('COM port ไม่ถูกต้อง'),{status:400});
  const inspected=await agentReq(session.robotKey,'exec',{command:`if [ ! -c ${shellQuote(port)} ]; then echo MISSING; else id -un; [ -r ${shellQuote(port)} ] && [ -w ${shellQuote(port)} ] && echo READY || echo PERMISSION; fi`,timeout:5000},7000);
  const lines=String(inspected.stdout||'').trim().split(/\r?\n/).filter(Boolean);
  if(lines[0]==='MISSING')throw Object.assign(new Error(`ไม่พบ ${port} · USB: ตรวจสาย; GPIO UART: ตรวจการเปิด UART/overlay และ reboot ที่เครื่อง Robot (Pi 5 GPIO14/15 ใช้ UART0 ไม่ใช่ debug UART)`),{status:404,portState:'missing'});
  const agentUser=lines[0]||'',state=lines.at(-1)||'';
  if(state==='READY')return{ok:true,port,portState:'ready',repaired:false};
  if(!/^[a-z_][a-z0-9_-]{0,31}$/i.test(agentUser))throw Object.assign(new Error('ตรวจสอบชื่อผู้ใช้ Agent ไม่สำเร็จ'),{status:500,portState:'permission'});
  const rulePath='/etc/udev/rules.d/70-roside-serial.rules';
  const permissionScript=`set -e
getent group dialout >/dev/null || groupadd --system dialout
usermod -aG dialout ${shellQuote(agentUser)}
cat > ${shellQuote(rulePath)} <<'ROSIDE_UDEV'
KERNEL=="ttyUSB[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyACM[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyAMA[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyTHS[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyS[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="rfcomm[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
ROSIDE_UDEV
udevadm control --reload-rules >/dev/null 2>&1 || true
chgrp dialout ${shellQuote(port)}
chmod 660 ${shellQuote(port)}
if command -v setfacl >/dev/null 2>&1; then setfacl -m ${shellQuote(`u:${agentUser}:rw`)} ${shellQuote(port)}; else chmod 666 ${shellQuote(port)}; fi`;
  try{await lidarSudoExec(session,permissionScript,password,30000);}
  catch(error){error.portState='permission';throw error;}
  const verified=await agentReq(session.robotKey,'exec',{command:`[ -r ${shellQuote(port)} ] && [ -w ${shellQuote(port)} ] && echo READY || echo PERMISSION`,timeout:5000},7000);
  if(!/^READY$/m.test(String(verified.stdout||'')))throw Object.assign(new Error(`แก้สิทธิ์ ${port} แล้วแต่ Agent ยังเปิดพอร์ตไม่ได้`),{status:500,portState:'permission'});
  return{ok:true,port,portState:'ready',repaired:true,user:agentUser,rule:rulePath};
}

function lidarSetupFiles(modelId,device,frameId='laser_frame'){
  const frame=selectedLidarFrame(frameId);
  const selection={modelId,brand:device.brand,model:device.model,driverPackage:device.packageName,repository:device.repository,port:device.port,baud:device.baud,topic:'/scan',frameId:frame,savedAt:new Date().toISOString()};
  const args=device.port.includes('.')?`{'ip_address':'${device.port}','frame_id':'${frame}'}.items()`:`{'serial_port':'${device.port}','frame_id':'${frame}'${device.baud?`, 'serial_baudrate':'${device.baud}'`:''}}.items()`;
  const launchBody=device.brand==='YDLIDAR'
    ? `from launch_ros.actions import Node\n\ndef generate_launch_description():\n    driver = Node(package='ydlidar', executable='ydlidar_node', name='ydlidar_node', output='screen', parameters=[{'port':'${device.port}','frame_id':'${frame}','baudrate':${device.baud},'samp_rate':${device.sampleRate},'resolution_fixed':True,'singleChannel':False,'auto_reconnect':True,'reversion':${device.reversion?'True':'False'},'isToFLidar':False,'range_min':0.01,'range_max':32.0}])\n    return LaunchDescription([driver])\n`
    : device.brand==='LDROBOT'
    ? `from launch_ros.actions import Node\n\ndef generate_launch_description():\n    driver = Node(package='ldlidar_stl_ros2', executable='ldlidar_stl_ros2_node', name='${device.model}', output='screen', parameters=[{'product_name':'LDLiDAR_${device.model}','topic_name':'scan','frame_id':'${frame}','port_name':'${device.port}','port_baudrate':${device.baud}}])\n    return LaunchDescription([driver])\n`
    : device.brand==='Hokuyo'
    ? `import os, yaml\nfrom ament_index_python.packages import get_package_share_directory\nfrom launch.actions import DeclareLaunchArgument, EmitEvent, RegisterEventHandler\nfrom launch.event_handlers import OnProcessStart\nfrom launch.events import matches_action\nfrom launch.substitutions import LaunchConfiguration\nfrom launch_ros.actions import LifecycleNode\nfrom launch_ros.event_handlers import OnStateTransition\nfrom launch_ros.events.lifecycle import ChangeState\nfrom lifecycle_msgs.msg import Transition\n\ndef generate_launch_description():\n    path = os.path.join(get_package_share_directory('urg_node2'), 'config', 'params_ether.yaml')\n    with open(path) as source: params = yaml.safe_load(source)['urg_node2']['ros__parameters']\n    params.update({'ip_address': LaunchConfiguration('ip_address'), 'frame_id': LaunchConfiguration('frame_id')})\n    driver = LifecycleNode(package='urg_node2', executable='urg_node2_node', name='urg_node2', output='screen', parameters=[params])\n    configure = RegisterEventHandler(OnProcessStart(target_action=driver, on_start=[EmitEvent(event=ChangeState(lifecycle_node_matcher=matches_action(driver), transition_id=Transition.TRANSITION_CONFIGURE))]))\n    activate = RegisterEventHandler(OnStateTransition(target_lifecycle_node=driver, start_state='configuring', goal_state='inactive', entities=[EmitEvent(event=ChangeState(lifecycle_node_matcher=matches_action(driver), transition_id=Transition.TRANSITION_ACTIVATE))]))\n    return LaunchDescription([DeclareLaunchArgument('ip_address',default_value='${device.port}'), DeclareLaunchArgument('frame_id',default_value='${frame}'), driver, configure, activate])\n`
    : `from launch.actions import IncludeLaunchDescription\nfrom launch.launch_description_sources import PythonLaunchDescriptionSource\nfrom launch_ros.substitutions import FindPackageShare\nfrom pathlib import Path\n\ndef generate_launch_description():\n    source = PythonLaunchDescriptionSource(str(Path(FindPackageShare('${device.launchPackage}').find('${device.launchPackage}')) / 'launch' / '${device.launchFile}'))\n    return LaunchDescription([IncludeLaunchDescription(source, launch_arguments=${args})])\n`;
  return {
    'package.xml':`<?xml version="1.0"?><package format="3"><name>roside_lidar_setup</name><version>0.1.0</version><description>LiDAR setup generated by ROSIDE for ${device.brand} ${device.model}; publishes sensor_msgs/msg/LaserScan on /scan.</description><maintainer email="robot@roside.local">ROSIDE</maintainer><license>MIT</license><buildtool_depend>ament_cmake</buildtool_depend><exec_depend>${device.launchPackage}</exec_depend><exec_depend>launch</exec_depend><exec_depend>launch_ros</exec_depend><exec_depend>lifecycle_msgs</exec_depend><exec_depend>python3-yaml</exec_depend><exec_depend>sensor_msgs</exec_depend><export><build_type>ament_cmake</build_type></export></package>`,
    'CMakeLists.txt':'cmake_minimum_required(VERSION 3.8)\nproject(roside_lidar_setup)\nfind_package(ament_cmake REQUIRED)\ninstall(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})\nament_package()\n',
    'config/selected_lidar.json':JSON.stringify(selection,null,2)+'\n',
    'launch/lidar.launch.py':`# Generated by ROSIDE LiDAR Setup\nfrom launch import LaunchDescription\n${launchBody}`,
    'README.md':`# ${device.brand} ${device.model}\n\nGenerated by ROSIDE. Driver source: ${device.repository}\n\nBuild from the workspace root with \`rosdep install --from-paths src --ignore-src -r -y && colcon build --symlink-install\`. Then run \`ros2 launch roside_lidar_setup lidar.launch.py\` and verify \`/scan\`.\n`,
  };
}

app.post('/api/lidar/frame',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'LiDAR frame ใช้สำหรับหุ่นยนต์จริง'});
  let frameId;try{frameId=selectedLidarFrame(req.body.frameId);}catch(error){return res.status(400).json({ok:false,error:error.message});}
  try{
    const root=(s.workspace||'~/ros2_ws').replace(/\/$/,'');
    try{
      const modelFile=await agentReq(s.robotKey,'fs_read',{path:`${root}/src/sim_robot_tf/tf_model.json`});
      frameId=connectedLidarFrame(JSON.parse(modelFile.content||'[]'),frameId);
    }catch(error){if(/LiDAR frame|LiDAR TF/.test(error.message||''))throw error;}
    const configPath=`${root}/src/roside_lidar_setup/config/selected_lidar.json`;
    const file=await agentReq(s.robotKey,'fs_read',{path:configPath});
    const selection=JSON.parse(file.content||'{}');
    if(!REAL_LIDAR_CATALOG[selection.modelId])return res.status(404).json({ok:false,error:'ยังไม่ได้ติดตั้ง LiDAR driver'});
    selection.frameId=frameId;selection.savedAt=new Date().toISOString();
    await agentReq(s.robotKey,'fs_write',{path:configPath,content:JSON.stringify(selection,null,2)+'\n'});
    return res.json({ok:true,frameId});
  }catch(error){return res.status(500).json({ok:false,error:error.message});}
});

async function buildRealLidar(s,modelId,device,requestedPort,requestedBaud,sudoPassword=''){
  const root=(s.workspace||'~/ros2_ws').replace(/\/$/,''),setup=s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
  const reportedDistro=String(s.rosInfo?.distro||'').trim().toLowerCase(),setupDistro=String(setup).match(/\/opt\/ros\/([^/]+)\//)?.[1]||'';
  const distro=(reportedDistro&&reportedDistro!=='unknown'?reportedDistro:setupDistro||'humble').replace(/[^A-Za-z0-9_-]/g,'')||'humble';
  const configured={...device,port:selectedLidarPort(requestedPort,device),baud:selectedLidarBaud(requestedBaud,device)};
  await saveGeneratedRobotPackage(s,'roside_lidar_setup',lidarSetupFiles(modelId,configured));
  const privilegedToolsScript=`set -eo pipefail
export DEBIAN_FRONTEND=noninteractive
packages=(git build-essential cmake python3-pip python3-venv python3-rosdep python3-colcon-common-extensions)
missing=()
for package in "\${packages[@]}"; do dpkg-query -W -f='\${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing+=("$package"); done
if [ "\${#missing[@]}" -gt 0 ]; then apt-get update; apt-get install -y "\${missing[@]}"; fi
if [ ! -f /etc/ros/rosdep/sources.list.d/20-default.list ]; then rosdep init; fi`;
  let privileged;
  try{privileged=await lidarSudoExec(s,privilegedToolsScript,sudoPassword,180000);}
  catch(error){error.stage='tools';throw error;}
  const toolsScript=`set -eo pipefail
export PATH="$HOME/.local/bin:$PATH"
source ${remoteShellPath(setup)} 2>/dev/null
for tool in git cmake g++ python3 colcon rosdep; do command -v "$tool" >/dev/null 2>&1 || { echo "ไม่พบ build tool: $tool" >&2; exit 21; }; done`;
  const dependencyScript=`set -eo pipefail
export PATH="$HOME/.local/bin:$PATH"
source ${remoteShellPath(setup)} 2>/dev/null
export ROS_DISTRO="${distro}" ROS_PYTHON_VERSION=3 PYTHONWARNINGS="ignore::DeprecationWarning"
rosdep update
cd ${remoteShellPath(root)}
rosdep install --from-paths ${shellQuote('src/'+device.folder)} src/roside_lidar_setup --ignore-src -r -y --rosdistro "${distro}"`;
  const buildScript=`set -eo pipefail
export PATH="$HOME/.local/bin:$PATH"
source ${remoteShellPath(setup)} 2>/dev/null
cd ${remoteShellPath(root)}
colcon build --symlink-install --packages-up-to ${shellQuote(device.packageName)} roside_lidar_setup
test -f install/setup.bash || { echo 'Build จบแต่ไม่พบ install/setup.bash' >&2; exit 23; }
source install/setup.bash
ros2 pkg prefix ${shellQuote(device.packageName)}
ros2 pkg prefix roside_lidar_setup`;
  const logs=[],privilegedLog=[privileged.stdout,privileged.stderr].filter(Boolean).join('\n').trim();if(privilegedLog)logs.push(`[sudo tools]\n${privilegedLog}`);
  for(const task of [{stage:'tools',command:toolsScript},{stage:'dependencies',command:dependencyScript},{stage:'build',command:buildScript}]){
    const result=await agentReq(s.robotKey,'exec',{command:task.command,timeout:120000},125000),combined=[result.stdout,result.stderr].filter(Boolean).join('\n').trim();
    if(combined)logs.push(`[${task.stage}]\n${combined}`);
    if(result.code!==0){const error=new Error(combined.slice(-6000)||`${task.stage} ไม่สำเร็จ`);error.stage=task.stage;throw error;}
  }
  invalidateRobotProgress(s);
  return {ok:true,port:configured.port,output:logs.join('\n\n').slice(-10000),packageName:device.packageName,workspace:root};
}

app.post('/api/lidar/status',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'หน้าติดตั้ง LiDAR ใช้สำหรับหุ่นยนต์จริง'});
  const modelId=String(req.body.modelId||''),device=REAL_LIDAR_CATALOG[modelId];
  if(!device)return res.status(400).json({ok:false,error:'ไม่รองรับรุ่น LiDAR ที่เลือก'});
  try{
    const root=(s.workspace||'~/ros2_ws').replace(/\/$/,''),payload=Buffer.from(JSON.stringify({root,folder:device.folder,packageName:device.packageName,defaultPort:device.port})).toString('base64');
    const python=`import base64,glob,json,os,subprocess\ncfg=json.loads(base64.b64decode('${payload}'))\nroot=os.path.expanduser(cfg['root'])\ndriver=os.path.join(root,'src',cfg['folder'])\ninstalled=os.path.isfile(os.path.join(driver,'package.xml')) or os.path.isdir(os.path.join(driver,'.git'))\npackage_built=any(os.path.isdir(p) for p in [os.path.join(root,'install','share',cfg['packageName']),os.path.join(root,'install',cfg['packageName'],'share',cfg['packageName'])])\nbuilt=os.path.isfile(os.path.join(root,'install','setup.bash')) and package_built\nselection={}\ntry:\n selection=json.load(open(os.path.join(root,'src','roside_lidar_setup','config','selected_lidar.json'),encoding='utf-8'))\nexcept (OSError,ValueError): pass\nbyid={}\nfor link in glob.glob('/dev/serial/by-id/*'):\n try: byid[os.path.realpath(link)]=os.path.basename(link)\n except OSError: pass\nports=[]\nfor port in sorted(set(glob.glob('/dev/ttyUSB*')+glob.glob('/dev/ttyACM*')+glob.glob('/dev/ttyAMA*'))):\n ports.append({'path':port,'label':byid.get(os.path.realpath(port),os.path.basename(port)),'connected':os.path.exists(port)})\nif '.' in cfg['defaultPort']:\n connected=subprocess.run(['ping','-c','1','-W','1',cfg['defaultPort']],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0\n ports=[{'path':cfg['defaultPort'],'label':'Ethernet '+cfg['defaultPort'],'connected':connected}]\nprint('ROSIDE_LIDAR_STATUS='+json.dumps({'installed':installed,'built':built,'driverDir':'src/'+cfg['folder'],'ports':ports,'savedSelection':selection},separators=(',',':')))\n`;
    const encoded=Buffer.from(python).toString('base64'),result=await agentReq(s.robotKey,'exec',{command:`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`,timeout:10000},15000);
    const marker=(result.stdout||'').match(/ROSIDE_LIDAR_STATUS=(\{.*\})/);if(!marker)throw new Error(result.stderr||'ตรวจสอบ LIDAR package ไม่สำเร็จ');
    const status=JSON.parse(marker[1]);
    if(!device.port.includes('.'))status.ports=await discoverRobotSerialPorts(s);
    res.json({ok:true,modelId,workspace:root,...status});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/lidar/build',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'Build LIDAR ใช้สำหรับหุ่นยนต์จริง'});
  const modelId=String(req.body.modelId||''),device=REAL_LIDAR_CATALOG[modelId];if(!device)return res.status(400).json({ok:false,error:'ไม่รองรับรุ่น LiDAR ที่เลือก'});
  try{const result=await buildRealLidar(s,modelId,device,req.body.port,req.body.baud,req.body.sudoPassword);invalidateProjectScan(s);res.json(result);}
  catch(error){res.status(500).json({ok:false,stage:error.stage||'build',error:error.message,requiresSudo:!!error.requiresSudo});}
});

app.post('/api/lidar/install',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'หน้าติดตั้ง LiDAR ใช้สำหรับหุ่นยนต์จริง'});
  const modelId=String(req.body.modelId||''),device=REAL_LIDAR_CATALOG[modelId];
  if(!device)return res.status(400).json({ok:false,error:'ไม่รองรับรุ่น LiDAR ที่เลือก'});
  try{
    const root=(s.workspace||'~/ros2_ws').replace(/\/$/,''),destination=`${root}/src/${device.folder}`;
    const command=`set -e; mkdir -p ${remoteShellPath(root+'/src')}; if [ -d ${remoteShellPath(destination+'/.git')} ]; then echo DRIVER_ALREADY_PRESENT; elif [ -e ${remoteShellPath(destination)} ]; then echo 'ปลายทางมีอยู่แล้วแต่ไม่ใช่ git repository' >&2; exit 17; else git clone --depth 1 --recursive ${shellQuote(device.repository)} ${remoteShellPath(destination)}; fi`;
    const cloned=await agentReq(s.robotKey,'exec',{command,timeout:120000},125000);
    if(cloned.code!==0)return res.status(500).json({ok:false,error:(cloned.stderr||cloned.stdout||'ติดตั้ง driver ไม่สำเร็จ').slice(-4000)});
    const port=selectedLidarPort(req.body.port,device),setup=await saveGeneratedRobotPackage(s,'roside_lidar_setup',lidarSetupFiles(modelId,{...device,port},req.body.frameId));
    const build=await buildRealLidar(s,modelId,device,port,req.body.baud,req.body.sudoPassword);
    invalidateProjectScan(s);invalidateRobotProgress(s);
    res.json({ok:true,alreadyPresent:/DRIVER_ALREADY_PRESENT/.test(cloned.stdout||''),workspace:root,driverDir:`src/${device.folder}`,setupDir:setup.pkgDir,model:{id:modelId,brand:device.brand,name:device.model},build});
  }catch(error){res.status(500).json({ok:false,stage:error.stage||'install',error:error.message,requiresSudo:!!error.requiresSudo});}
});

function parseLaserScan(text){
  const number=name=>{const match=String(text).match(new RegExp(`(?:^|\\n)${name}:\\s*([-+0-9.eE]+)`));return match?Number(match[1]):null;};
  const block=String(text).match(/(?:^|\n)ranges:\s*\n([\s\S]*?)(?=\n(?:intensities|header|---):|$)/);
  const ranges=block?(block[1].match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?|\.inf|nan/gi)||[]).map(value=>Number(value)).slice(0,4000):[];
  return {angleMin:number('angle_min'),angleMax:number('angle_max'),angleIncrement:number('angle_increment'),rangeMin:number('range_min'),rangeMax:number('range_max'),ranges};
}

function lidarRuntimePaths(s){
  const root=(s.workspace||'~/ros2_ws').replace(/\/$/,'');
  return {root,setup:s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',runtime:'~/.roside/lidar-runtime',pid:'~/.roside/lidar-runtime/driver.pid',log:'~/.roside/lidar-runtime/driver.log',platformLog:'~/.roside/lidar-runtime/platform.log'};
}

app.post('/api/lidar/driver',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'LIDAR driver ใช้สำหรับหุ่นยนต์จริง'});
  const modelId=String(req.body.modelId||''),device=REAL_LIDAR_CATALOG[modelId],action=String(req.body.action||'status');
  if(!device)return res.status(400).json({ok:false,error:'ไม่รองรับรุ่น LiDAR ที่เลือก'});
  if(!['start','stop','status'].includes(action))return res.status(400).json({ok:false,error:'คำสั่ง LIDAR driver ไม่ถูกต้อง'});
  const conflict=realRuntimeConflict(s,req.body.sessionId,'/ws/lidar',action);if(conflict)return res.status(409).json({ok:false,code:'ROBOT_BUSY',error:conflict});
  let frameId;try{frameId=selectedLidarFrame(req.body.frameId);}catch(error){return res.status(400).json({ok:false,error:error.message});}
  const port=selectedLidarPort(req.body.port,device),baud=selectedLidarBaud(req.body.baud,device),paths=lidarRuntimePaths(s);
  let launchCommand=lidarDirectLaunchCommand(device,port,baud,frameId);
  const sourceCommand=`source ${remoteShellPath(paths.setup)} || { echo 'ไม่สามารถ source ROS setup: ${String(paths.setup).replace(/'/g,'')}'; exit 33; }; source ${remoteShellPath(paths.root+'/install/setup.bash')} || { echo 'ไม่สามารถ source workspace setup: ${String(paths.root).replace(/'/g,'')}/install/setup.bash'; exit 34; }`;
  const stopCommand=`pid=$(cat ${remoteShellPath(paths.pid)} 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; sleep 1; fi; rm -f ${remoteShellPath(paths.pid)}`;
  let forceDialout=false,runtimeRepairOutput='',currentStage=action;
  const trace=async(message,{reset=false}={})=>{
    const record=String(message).replace(/[\r\n]+/g,' ');
    await agentReq(s.robotKey,'exec',{command:`mkdir -p ${remoteShellPath(paths.runtime)}; printf '%s %s\\n' "$(date -Is)" ${shellQuote(record)} ${reset?'>':'>>'} ${remoteShellPath(paths.platformLog)}`,timeout:4000},6000).catch(()=>{});
  };
  const operation=reserveRuntimeOperation(s,req.body.sessionId,'/ws/lidar',action,port);
  try{
    if(action==='start'){
      currentStage='request';await trace(`START model=${modelId} port=${port} baud=${baud}`,{reset:true});
      currentStage='lidar-tf';
      let tfModel=[];
      try{
        const modelFile=await agentReq(s.robotKey,'fs_read',{path:`${paths.root}/src/sim_robot_tf/tf_model.json`});
        tfModel=JSON.parse(modelFile.content||'[]');
      }catch(error){if(error instanceof SyntaxError)throw error;}
      const requestedFrame=frameId;
      frameId=connectedLidarFrame(tfModel,frameId);
      const tfCommands=lidarTfLaunchCommands(tfModel,frameId);
      launchCommand=lidarDirectLaunchCommand(device,port,baud,frameId);
      if(frameId!==requestedFrame){
        await trace(`TF frame corrected ${requestedFrame} -> ${frameId}`);
        try{
          const configPath=`${paths.root}/src/roside_lidar_setup/config/selected_lidar.json`;
          const selectionFile=await agentReq(s.robotKey,'fs_read',{path:configPath});
          const selection=JSON.parse(selectionFile.content||'{}');
          if(selection.modelId===modelId){selection.frameId=frameId;selection.savedAt=new Date().toISOString();await agentReq(s.robotKey,'fs_write',{path:configPath,content:JSON.stringify(selection,null,2)+'\n'});}
        }catch(_){}
      }
      currentStage='prepare-driver';await trace('STAGE prepare-driver begin');
      const repairBuildCommand=`set -eo pipefail
export PATH="$HOME/.local/bin:$PATH"
source ${remoteShellPath(paths.setup)}
cd ${remoteShellPath(paths.root)}
needs_build=0
test -f install/setup.bash || needs_build=1
if [ "$needs_build" = 0 ]; then source install/setup.bash; ros2 pkg prefix ${shellQuote(device.packageName)} >/dev/null 2>&1 || needs_build=1; fi
if [ "$needs_build" = 1 ]; then echo '[AUTO REPAIR] Driver ยังไม่พร้อมใช้งาน กำลัง Build เฉพาะ LIDAR package'; colcon build --symlink-install --packages-up-to ${shellQuote(device.packageName)}; fi
test -f install/setup.bash || { echo 'ซ่อม Build แล้วแต่ยังไม่พบ install/setup.bash' >&2; exit 32; }
source install/setup.bash
echo DRIVER_PREFIX=$(ros2 pkg prefix ${shellQuote(device.packageName)})`;
      const repaired=await agentReq(s.robotKey,'exec',{command:repairBuildCommand,timeout:120000},125000);runtimeRepairOutput=[repaired.stdout,repaired.stderr].filter(Boolean).join('\n').trim();
      if(repaired.code!==0)throw Object.assign(new Error(`เตรียม LIDAR Driver ไม่สำเร็จ (exit=${repaired.code})`),{stage:'build'});
      await trace('STAGE prepare-driver ready');currentStage='repair-driver';
      const channelRepair=await ensureSllidarChannelFix(s,paths,modelId);runtimeRepairOutput=[runtimeRepairOutput,channelRepair].filter(Boolean).join('\n');
      await trace('STAGE repair-driver ready');currentStage='serial-access';
      if(!device.port.includes('.')){
        const restored=await restoreDetachedUsbSerial(s,port,req.body.sudoPassword);if(restored)runtimeRepairOutput=[runtimeRepairOutput,restored].filter(Boolean).join('\n');
        const access=await ensureRobotSerialAccess(s,port,req.body.sudoPassword);forceDialout=access.repaired===true;
      }
      await trace(`STAGE serial-access ready forceDialout=${forceDialout}`);currentStage='cleanup-driver';
      const runner=`set -eo pipefail; ${sourceCommand}; ${tfCommands.map(command=>command+' &').join(' ')} exec ${launchCommand}`;
      const launchRunner=forceDialout?`exec sg dialout -c ${shellQuote(`exec bash -lc ${shellQuote(runner)}`)}`:runner;
      const staleLidarPattern="'^([^[:space:]]*/)?(sllidar_node|ydlidar_node|ldlidar[^[:space:]]*node|urg_node2)([[:space:]]|$)|^([^[:space:]]*/)?(python3([.][0-9]+)?[[:space:]]+)?([^[:space:]]*/)?ros2[[:space:]]+(run|launch)[[:space:]]+(sllidar_ros2|roside_lidar_setup|ydlidar|ldlidar_stl_ros2|urg_node2)([[:space:]]|$)'";
      const conflictingRuntimeStop=`for pid_file in ${remoteShellPath('~/.roside/mapping-runtime/lidar.pid')} ${remoteShellPath('~/.roside/navigation-runtime/lidar.pid')}; do old_pid=$(cat "$pid_file" 2>/dev/null || true); if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then kill -- -"$old_pid" 2>/dev/null || kill "$old_pid" 2>/dev/null || true; fi; rm -f "$pid_file"; done; pkill -TERM -f ${staleLidarPattern} 2>/dev/null || true; sleep 1; pkill -KILL -f ${staleLidarPattern} 2>/dev/null || true; fuser -k ${shellQuote(port)} 2>/dev/null || true; sleep 2`;
      // Run stale-process cleanup in a separate shell. If cleanup and launch are
      // concatenated, `pkill -f [s]llidar_node` also matches that shell's own
      // command line (which already contains the upcoming sllidar_node launch)
      // and kills the request before driver.log is created.
      await trace('STAGE cleanup-driver begin');
      const cleaned=await agentReq(s.robotKey,'exec',{command:conflictingRuntimeStop,timeout:10000},12000);
      if(cleaned.code!==0){runtimeRepairOutput+='\n'+[cleaned.stdout,cleaned.stderr].filter(Boolean).join('\n');throw new Error(`หยุด LiDAR process เดิมไม่สำเร็จ (exit=${cleaned.code})`);}
      await trace('STAGE cleanup-driver ready');currentStage='launch-driver';
      const serialPreflight=lidarSerialPreflightCommand(port,baud);
      const startCommand=`set -e -o pipefail; mkdir -p ${remoteShellPath(paths.runtime)}; ${stopCommand}; : > ${remoteShellPath(paths.log)}; ( ${serialPreflight} ) >> ${remoteShellPath(paths.log)} 2>&1 || { rc=$?; tail -100 ${remoteShellPath(paths.log)} 2>&1 || true; exit $rc; }; nohup setsid bash -lc ${shellQuote(launchRunner)} >> ${remoteShellPath(paths.log)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(paths.pid)}; sleep 3`;
      await trace(`STAGE launch-driver begin command=${launchCommand}`);
      const {started}=await runLidarStartWithUsbRecovery(s,{command:startCommand,port,password:req.body.sudoPassword,logPath:paths.log,execTimeout:25000,requestTimeout:28000});
      if(started.code!==0){await trace(`FAILED launch-driver code=${started.code}`);const failedLog=await agentReq(s.robotKey,'exec',{command:`echo ROSIDE_PLATFORM_LOG; tail -120 ${remoteShellPath(paths.platformLog)} 2>&1 || true; echo ROSIDE_DRIVER_LOG; tail -120 ${remoteShellPath(paths.log)} 2>&1 || true`,timeout:4000},6000).catch(()=>({stdout:'',stderr:''})),failureOutput=[started.stdout,started.stderr,failedLog.stdout,failedLog.stderr].filter(Boolean).join('\n').trim();return res.status(500).json({ok:false,error:'เปิด LiDAR driver ไม่สำเร็จ',stage:'launch-driver',output:failureOutput.slice(-10000),command:launchCommand});}
      await trace(`STAGE launch-driver command-returned code=${started.code}`);currentStage='verify-driver';
    }else if(action==='stop'){
      await agentReq(s.robotKey,'exec',{command:stopCommand,timeout:7000},9000);
    }
    const portCheck=device.port.includes('.')
      ? `ping -c 1 -W 1 ${shellQuote(port)} >/dev/null 2>&1 && echo ROSIDE_PORT=connected || echo ROSIDE_PORT=missing`
      : `if [ ! -e ${shellQuote(port)} ]; then echo ROSIDE_PORT=missing; elif { [ -r ${shellQuote(port)} ] && [ -w ${shellQuote(port)} ]; } || { [ "$(stat -c %G ${shellQuote(port)} 2>/dev/null)" = dialout ] && id -nG "$(id -un)" | tr ' ' '\n' | grep -qx dialout; }; then echo ROSIDE_PORT=connected; else echo ROSIDE_PORT=permission; fi; ls -l ${shellQuote(port)} 2>&1 || true`;
    const readinessWait=action==='start'?`for ready_try in 1 2 3 4 5; do timeout 1 ros2 topic list 2>/dev/null | grep -qx /scan && break; pid=$(cat ${remoteShellPath(paths.pid)} 2>/dev/null || true); [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || break; sleep 1; done`:':';
    // Diagnostics must still reach the logs when sourcing ROS/workspace fails.
    const diagnosticSource=`source ${remoteShellPath(paths.setup)} || true; source ${remoteShellPath(paths.root+'/install/setup.bash')} || true`;
    const diagnosticCommand=`${diagnosticSource}; ${readinessWait}; ${portCheck}; pid=$(cat ${remoteShellPath(paths.pid)} 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then echo ROSIDE_PROCESS=running; else echo ROSIDE_PROCESS=stopped; fi; echo ROSIDE_TOPICS_BEGIN; timeout 4 ros2 topic list -t 2>&1 || true; echo ROSIDE_TOPICS_END; echo ROSIDE_INFO_BEGIN; timeout 4 ros2 topic info /scan -v 2>&1 || true; echo ROSIDE_INFO_END; echo ROSIDE_LOG_BEGIN; if [ -f ${remoteShellPath(paths.log)} ]; then echo ROSIDE_LOG_STATE=present; tail -120 ${remoteShellPath(paths.log)} 2>&1 || true; else echo ROSIDE_LOG_STATE=missing; echo 'ไม่พบ Driver log — ตรวจขั้นตอนก่อน launch ใน Platform log'; fi; echo ROSIDE_LOG_END; echo ROSIDE_PLATFORM_LOG_BEGIN; if [ -f ${remoteShellPath(paths.platformLog)} ]; then tail -120 ${remoteShellPath(paths.platformLog)} 2>&1 || true; else echo 'ยังไม่มี Platform launch log'; fi; echo ROSIDE_PLATFORM_LOG_END`;
    const checked=await agentReq(s.robotKey,'exec',{command:diagnosticCommand,timeout:25000},28000),diagnosticOutput=[checked.stdout,checked.stderr].filter(Boolean).join('\n').trim(),output=[runtimeRepairOutput,diagnosticOutput].filter(Boolean).join('\n\n');
    const section=name=>diagnosticOutput.match(new RegExp(`ROSIDE_${name}_BEGIN\\n([\\s\\S]*?)\\nROSIDE_${name}_END`))?.[1]?.trim()||'';
    const portState=diagnosticOutput.match(/ROSIDE_PORT=(connected|permission|missing)/)?.[1]||'missing',processRunning=/ROSIDE_PROCESS=running/.test(diagnosticOutput),topics=section('TOPICS'),info=section('INFO'),rawLog=section('LOG'),platformLog=section('PLATFORM_LOG'),logState=rawLog.match(/ROSIDE_LOG_STATE=(present|missing)/)?.[1]||'missing',log=rawLog.replace(/^ROSIDE_LOG_STATE=(?:present|missing)\s*/,'').trim(),topicReady=/(?:^|\n)\/scan(?:\s|$)/m.test(topics);
    const hints=[];
    if(portState==='missing')hints.push(`ไม่พบ ${port} — ตรวจสาย USB, ไฟเลี้ยง และเลือก COM port ใหม่`);
    if(portState==='permission')hints.push(`ไม่มีสิทธิ์อ่าน/เขียน ${port} — เพิ่มผู้ใช้เข้า group dialout แล้ว login ใหม่`);
    if(!processRunning&&action==='status'&&logState==='missing')hints.push('ไม่พบ Driver ที่ทำงานหรือ Driver log — ตรวจ Platform log แล้วกด “เปิด Driver + ทดสอบ”');
    else if(!processRunning&&action!=='stop')hints.push('Driver หยุดทำงาน — ดู Driver log ด้านล่าง');
    if(processRunning&&!topicReady)hints.push('Driver ทำงานแต่ยังไม่มี /scan — ตรวจรุ่น, baud rate และ launch arguments');
    if(/80008004/.test(log)&&portState!=='connected')hints.unshift('SLAMTEC error 80008004: Driver เปิด serial port ไม่ได้ ระบบต้องแก้สิทธิ์พอร์ตก่อน');
    if(/80008004/.test(log)&&portState==='connected')hints.unshift('SLAMTEC error 80008004: ตรวจว่าสายไม่ถูกโปรแกรมอื่นใช้งาน และรุ่น/baud rate ตรงกับอุปกรณ์');
    const payload={action,port,baud,frameId,portState,processRunning,topicReady,topics,topicInfo:info,logState,log,platformLog,output,commands:{launch:launchCommand,topic:'ros2 topic echo --once /scan sensor_msgs/msg/LaserScan --qos-reliability best_effort'},hints};
    if(action==='start'&&!processRunning){await trace('FAILED verify-driver process=stopped');return res.status(500).json({ok:false,...payload,stage:'launch-driver',error:'LiDAR driver เริ่มแล้วหยุดทำงานทันที — ตรวจรุ่น, baudrate และ Driver log'});}
    if(action==='start'&&!topicReady){await trace('FAILED verify-driver topic=/scan-missing');return res.status(500).json({ok:false,...payload,stage:'wait-scan',error:'LiDAR driver ทำงานอยู่ แต่ยังไม่พบ publisher ของ /scan — ตรวจรุ่นและ baudrate'});}
    if(action==='start')await trace('READY process=running topic=/scan');
    res.json({ok:true,...payload});
  }catch(error){
    await trace(`FAILED stage=${currentStage} error=${error.message}`);
    const diagnostic=await agentReq(s.robotKey,'exec',{command:`echo ROSIDE_PLATFORM_LOG; tail -120 ${remoteShellPath(paths.platformLog)} 2>&1 || true; echo ROSIDE_DRIVER_LOG; tail -120 ${remoteShellPath(paths.log)} 2>&1 || true`,timeout:5000},7000).catch(diagnosticError=>({stdout:'',stderr:`อ่าน log จาก Agent ไม่สำเร็จ: ${diagnosticError.message}`}));
    res.status(500).json({ok:false,error:error.message,stage:error.stage||currentStage,command:launchCommand,portState:error.portState,requiresSudo:!!error.requiresSudo,output:[runtimeRepairOutput,diagnostic.stdout,diagnostic.stderr].filter(Boolean).join('\n\n').slice(-12000)});
  }finally{releaseRuntimeOperation(s.robotKey,operation);}
});

app.post('/api/lidar/scan',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'Live LiDAR ใช้สำหรับหุ่นยนต์จริง'});
  try{
    const setup=s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',root=(s.workspace||'~/ros2_ws').replace(/\/$/,'');
    const command=`source ${remoteShellPath(setup)} 2>/dev/null && source ${remoteShellPath(root+'/install/setup.bash')} 2>/dev/null || true; timeout 4 ros2 topic echo --once /scan sensor_msgs/msg/LaserScan --qos-reliability best_effort`;
    const out=await agentReq(s.robotKey,'exec',{command,timeout:7000},9000),scan=parseLaserScan(out.stdout||'');
    if(out.code!==0||!scan.ranges.length){
      const paths=lidarRuntimePaths(s),logResult=await agentReq(s.robotKey,'exec',{command:`tail -80 ${remoteShellPath(paths.log)} 2>&1 || true`,timeout:4000},6000).catch(()=>({stdout:''}));
      return res.json({ok:true,live:false,topic:'/scan',error:'ยังไม่ได้รับ LaserScan จาก /scan',command:'ros2 topic echo --once /scan sensor_msgs/msg/LaserScan --qos-reliability best_effort',output:[out.stdout,out.stderr,logResult.stdout].filter(Boolean).join('\n').trim().slice(-8000)});
    }
    res.json({ok:true,live:true,topic:'/scan',receivedAt:Date.now(),command:'ros2 topic echo --once /scan sensor_msgs/msg/LaserScan --qos-reliability best_effort',...scan});
  }catch(error){res.json({ok:false,live:false,error:error.message});}
});

function mappingRuntimePaths(s){
  const root=(s.workspace||'~/ros2_ws').replace(/\/$/,'');
  return {root,setup:s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',runtime:'~/.roside/mapping-runtime',pid:'~/.roside/mapping-runtime/slam.pid',log:'~/.roside/mapping-runtime/slam.log',lidarPid:'~/.roside/mapping-runtime/lidar.pid',lidarLog:'~/.roside/mapping-runtime/lidar.log'};
}

function rosDistroForSession(s,setupPath=''){
  const reported=String(s.rosInfo?.distro||'').trim().toLowerCase();
  const fromSetup=String(setupPath||s.rosInfo?.setupBash||'').match(/\/opt\/ros\/([^/]+)\/setup\.bash$/)?.[1]?.toLowerCase()||'';
  const usable=value=>/^[a-z][a-z0-9_-]*$/.test(value)&&!['unknown','undefined','null','none'].includes(value);
  return usable(reported)?reported:usable(fromSetup)?fromSetup:'humble';
}

function mappingSourceCommand(paths){
  const install=`${paths.root}/install`;
  return `source ${remoteShellPath(paths.setup)} 2>/dev/null
source ${remoteShellPath(install+'/setup.bash')} 2>/dev/null || true
export AMENT_PREFIX_PATH=${remoteShellPath(install+'/roside_controller_bridge')}:${remoteShellPath(install+'/roside_lidar_setup')}:"\${AMENT_PREFIX_PATH:-}"
for local_setup in ${remoteShellPath(install+'/roside_controller_bridge/local_setup.bash')} ${remoteShellPath(install+'/roside_lidar_setup/local_setup.bash')}; do [ -f "$local_setup" ] && source "$local_setup"; done`;
}

async function prepareMappingRuntime(s,paths,sudoPassword='',requestedControllerPort='',requestedLidarPort='',options={}){
  const setupOnly=`source ${remoteShellPath(paths.setup)} 2>/dev/null`;
  const workspaceSource=mappingSourceCommand(paths);
  const distro=rosDistroForSession(s,paths.setup);
  const requireSlam=options.requireSlam!==false;
  const logs=[];
  const slamCheck=requireSlam?await agentReq(s.robotKey,'exec',{command:`${workspaceSource}; ros2 pkg prefix slam_toolbox >/dev/null 2>&1 && ros2 pkg prefix nav2_map_server >/dev/null 2>&1`,timeout:7000},9000):{code:0};
  if(requireSlam&&slamCheck.code!==0){
    const packages=[`ros-${distro}-slam-toolbox`,`ros-${distro}-nav2-map-server`];
    let installed;try{installed=await lidarSudoExec(s,`set -eo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v fuser >/dev/null 2>&1; then
  for lock in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock; do
    if fuser -s "$lock" 2>/dev/null; then
      holder=$(fuser "$lock" 2>/dev/null | tr -d ' ')
      echo "ROSIDE_APT_BUSY lock=$lock pid=$holder" >&2
      ps -p "$holder" -o pid=,etime=,cmd= 2>/dev/null || true
      exit 73
    fi
  done
fi
echo ROSIDE_APT_STAGE=repairing_dpkg
dpkg --configure -a
echo ROSIDE_APT_STAGE=waiting_for_lock
apt-get -o DPkg::Lock::Timeout=120 install -y ${packages.map(shellQuote).join(' ')}`,sudoPassword,295000);}catch(error){
      error.stage='install';
      if(/ROSIDE_APT_BUSY|Could not get lock|Unable to acquire (?:the )?dpkg.*lock|locked by another process|is another process using it/i.test(error.message)){
        error.message='APT ของเครื่องหุ่นยนต์กำลังติดตั้งโปรแกรมอื่นอยู่ กรุณารอให้โปรเซสนั้นจบแล้วกดเริ่มอีกครั้ง\n'+error.message;
        error.requiresSudo=false;error.aptBusy=true;
      }
      throw error;
    }
    const output=[installed.stdout,installed.stderr].filter(Boolean).join('\n').trim();if(output)logs.push('[install slam_toolbox]\n'+output.slice(-5000));
  }
  const probe=await agentReq(s.robotKey,'exec',{command:`${workspaceSource}; for package in roside_controller_bridge roside_lidar_setup; do ros2 pkg prefix "$package" >/dev/null 2>&1 || echo "$package"; done`,timeout:8000},10000);
  const missing=String(probe.stdout||'').split(/\r?\n/).map(value=>value.trim()).filter(value=>['roside_controller_bridge','roside_lidar_setup'].includes(value));
  if(missing.length){
    const sourceCheck=await agentReq(s.robotKey,'exec',{command:missing.map(packageName=>`test -f ${remoteShellPath(paths.root+`/src/${packageName}/package.xml`)} || { echo 'ไม่พบ source package: ${packageName}' >&2; exit 41; }`).join('; '),timeout:6000},8000);
    if(sourceCheck.code!==0){const error=new Error([sourceCheck.stdout,sourceCheck.stderr].filter(Boolean).join('\n').trim()||'ยังไม่ได้สร้าง Hardware หรือ LiDAR package');error.stage='source';throw error;}
    const build=`set -eo pipefail
export PATH="$HOME/.local/bin:$PATH"
${setupOnly}
cd ${remoteShellPath(paths.root)}
layout=; [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = merged ] && layout=--merge-install
colcon build $layout --symlink-install --packages-select ${missing.map(shellQuote).join(' ')}
source install/setup.bash 2>/dev/null || true
for local_setup in ${remoteShellPath(paths.root+'/install/roside_controller_bridge/local_setup.bash')} ${remoteShellPath(paths.root+'/install/roside_lidar_setup/local_setup.bash')}; do if [ -f "$local_setup" ]; then source "$local_setup"; fi; done
true`;
    const built=await agentReq(s.robotKey,'exec',{command:build,timeout:180000},185000),output=[built.stdout,built.stderr].filter(Boolean).join('\n').trim();if(output)logs.push('[build workspace]\n'+output.slice(-7000));
    if(built.code!==0){const error=new Error(output||'Build แพ็กเกจสำหรับ SLAM ไม่สำเร็จ');error.stage='build';throw error;}
  }
  const bridgeMarker=`${paths.root}/install/roside_controller_bridge/share/ament_index/resource_index/packages/roside_controller_bridge`;
  const markerCheck=await agentReq(s.robotKey,'exec',{command:`test -f ${remoteShellPath(bridgeMarker)}`,timeout:5000},7000);
  if(markerCheck.code!==0){
    await agentReq(s.robotKey,'fs_write',{path:`${paths.root}/src/roside_controller_bridge/resource/roside_controller_bridge`,content:''});
    await agentReq(s.robotKey,'fs_write',{path:bridgeMarker,content:''});
    logs.push('[repair ament index]\nสร้าง marker ของ roside_controller_bridge สำหรับ isolated install แล้ว');
  }
  const requiredPackages=requireSlam?'roside_controller_bridge roside_lidar_setup slam_toolbox nav2_map_server':'roside_controller_bridge roside_lidar_setup';
  const verified=await agentReq(s.robotKey,'exec',{command:`${workspaceSource}
set +e
failed=0
for package in ${requiredPackages}; do
  prefix=$(ros2 pkg prefix "$package" 2>/dev/null)
  if [ -n "$prefix" ]; then echo "$package=$prefix"; else echo "MISSING=$package"; failed=1; fi
done
if [ "$failed" -ne 0 ]; then
  echo ROSIDE_INSTALL_LAYOUT=$(cat ${remoteShellPath(paths.root+'/install/.colcon_install_layout')} 2>/dev/null || echo unknown)
  find ${remoteShellPath(paths.root+'/install')} -maxdepth 5 -path '*/resource_index/packages/*' -name 'roside_*' -print 2>/dev/null | head -30
  exit 42
fi`,timeout:10000},13000);
  if(verified.code!==0){const error=new Error([verified.stdout,verified.stderr].filter(Boolean).join('\n').trim()||'ตรวจแพ็กเกจ SLAM ไม่ผ่าน');error.stage='verify';throw error;}
  logs.push('[verify]\n'+String(verified.stdout||'').trim());
  let controllerPort='',controllerBaud=115200,pidCommand='',lidarModelId='',runtimeLidarPort='',runtimeLidarBaud=null,runtimeLidarFrame='laser_frame';
  const requestedLidarModelId=String(options.lidarModelId||'').trim();
  if(requestedLidarModelId&&!REAL_LIDAR_CATALOG[requestedLidarModelId]){const error=new Error('ไม่รองรับรุ่น LiDAR ที่เลือก');error.stage='lidar-model';throw error;}
  try{
    const hardwareFile=await agentReq(s.robotKey,'fs_read',{path:`${paths.root}/.roside/hardware.json`}),hardware=JSON.parse(hardwareFile.content||'{}');controllerPort=SERIAL_DEVICE_PATTERN.test(String(requestedControllerPort||''))?String(requestedControllerPort):String(hardware.serialPort||'');controllerBaud=Number.isInteger(Number(hardware.baudRate))?Number(hardware.baudRate):115200;const pidSides=[hardware.pid?.left,hardware.pid?.right];if(hardware.pidControl!==false&&pidSides.every(side=>side&&['kp','ki','kd'].every(gain=>Number.isFinite(Number(side[gain])))))pidCommand='P '+pidSides.flatMap(side=>[side.kp,side.ki,side.kd]).join(' ');
    try{const lidarFile=await agentReq(s.robotKey,'fs_read',{path:`${paths.root}/src/roside_lidar_setup/config/selected_lidar.json`}),selection=JSON.parse(lidarFile.content||'{}'),selectedModelId=requestedLidarModelId||String(selection.modelId||''),device=REAL_LIDAR_CATALOG[selectedModelId];lidarModelId=selectedModelId;if(device){runtimeLidarPort=selectedLidarPort(requestedLidarPort||selection.port,device);runtimeLidarBaud=selectedLidarBaud(requestedLidarModelId?device.baud:selection.baud,device);runtimeLidarFrame=selectedLidarFrame(options.lidarFrameId||selection.frameId);if(requestedLidarModelId){const savedSelection={modelId:selectedModelId,brand:device.brand,model:device.model,driverPackage:device.packageName,repository:device.repository,port:runtimeLidarPort,baud:runtimeLidarBaud,topic:'/scan',frameId:runtimeLidarFrame,savedAt:new Date().toISOString()};await agentReq(s.robotKey,'fs_write',{path:`${paths.root}/src/roside_lidar_setup/config/selected_lidar.json`,content:JSON.stringify(savedSelection,null,2)+'\n'});logs.push(`[lidar model]\n${device.model} · ${device.launchFile} · ${runtimeLidarBaud} baud`);}}}catch(error){if(requestedLidarModelId)throw error;}
    if(controllerPort&&controllerPort===runtimeLidarPort){const error=new Error(`Controller และ LiDAR ถูกเลือกเป็นพอร์ตเดียวกัน ${runtimeLidarPort}`);error.stage='controller-port';throw error;}
    if(SERIAL_DEVICE_PATTERN.test(controllerPort)){
      const access=await ensureRobotSerialAccess(s,controllerPort,sudoPassword);logs.push(`[controller serial]\n${controllerPort} พร้อมใช้${access.repaired?' · ซ่อมสิทธิ์แล้ว':''}`);
    }
    if(SERIAL_DEVICE_PATTERN.test(runtimeLidarPort)){const restored=await restoreDetachedUsbSerial(s,runtimeLidarPort,sudoPassword);if(restored)logs.push(`[lidar usb restore]\n${restored}`);const access=await ensureRobotSerialAccess(s,runtimeLidarPort,sudoPassword);logs.push(`[lidar serial]\n${runtimeLidarPort} พร้อมใช้${access.repaired?' · ซ่อมสิทธิ์แล้ว':''}`);}
  }catch(error){
    if(error?.stage)throw error;
    if(error?.status||/Permission|COM port|serial/i.test(error.message||'')){error.stage='controller-port';throw error;}
    logs.push('[controller serial]\nไม่พบ hardware.json · ใช้ค่าจาก controller.yaml');
  }
  let lidarTfCommands;
  try{
    const modelFile=await agentReq(s.robotKey,'fs_read',{path:`${paths.root}/src/sim_robot_tf/tf_model.json`});
    const tfModel=JSON.parse(modelFile.content||'[]'),requestedFrame=runtimeLidarFrame;
    runtimeLidarFrame=connectedLidarFrame(tfModel,runtimeLidarFrame);
    lidarTfCommands=lidarTfLaunchCommands(tfModel,runtimeLidarFrame);
    if(runtimeLidarFrame!==requestedFrame&&REAL_LIDAR_CATALOG[lidarModelId]){
      const configPath=`${paths.root}/src/roside_lidar_setup/config/selected_lidar.json`;
      const selectionFile=await agentReq(s.robotKey,'fs_read',{path:configPath});
      const selection=JSON.parse(selectionFile.content||'{}');
      selection.frameId=runtimeLidarFrame;selection.savedAt=new Date().toISOString();
      await agentReq(s.robotKey,'fs_write',{path:configPath,content:JSON.stringify(selection,null,2)+'\n'});
      logs.push(`[lidar TF] corrected ${requestedFrame} -> ${runtimeLidarFrame}`);
    }
  }catch(error){
    if(/LiDAR frame|LiDAR TF/.test(error.message||'')){error.stage='lidar-tf';throw error;}
    if(runtimeLidarFrame!=='laser_frame'){const missing=new Error(`ไม่พบโมเดล TF ที่บันทึกบนหุ่นยนต์สำหรับเฟรม ${runtimeLidarFrame} กรุณาบันทึกหน้า TF ก่อนเริ่มภารกิจ`);missing.stage='lidar-tf';throw missing;}
    lidarTfCommands=lidarTfLaunchCommands([],runtimeLidarFrame);
  }
  return {output:logs.join('\n\n'),controllerPort,controllerBaud,pidCommand,lidarModelId,lidarPort:runtimeLidarPort,lidarBaud:runtimeLidarBaud,lidarFrameId:runtimeLidarFrame,lidarTfCommands};
}

app.post('/api/mapping/runtime',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'หน้าเก็บแผนที่จริงไม่รองรับ Sim'});
  const action=String(req.body.action||'status');if(!['start','stop','status'].includes(action))return res.status(400).json({ok:false,error:'คำสั่ง SLAM ไม่ถูกต้อง'});
  if(action==='status'&&robotRuntimeOperations.has(s.robotKey))return res.json({ok:true,action,...mappingOperationStatus(s,req.body.sessionId)});
  const conflict=realRuntimeConflict(s,req.body.sessionId,'/ws/mapping',action);if(conflict)return res.status(409).json({ok:false,code:'ROBOT_BUSY',error:conflict});
  const p=mappingRuntimePaths(s);let preparation='',controllerPort='',controllerBaud=115200,pidCommand='',runtimeLidarPort='';
  const stop=`for pid_file in ${remoteShellPath(p.pid)} ${remoteShellPath(p.lidarPid)}; do pid=$(cat "$pid_file" 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; fi; rm -f "$pid_file"; done; sleep 1`;
  const operation=reserveRuntimeOperation(s,req.body.sessionId,'/ws/mapping',action);
  try{
    if(action==='stop')await agentReq(s.robotKey,'exec',{command:stop,timeout:8000},10000);
    if(action==='start'){
      const source=mappingSourceCommand(p);
      const prepared=await prepareMappingRuntime(s,p,req.body.sudoPassword,req.body.controllerPort,req.body.lidarPort,{lidarModelId:req.body.lidarModelId}),driverRepair=await ensureSllidarChannelFix(s,p,prepared.lidarModelId);preparation=[prepared.output,driverRepair].filter(Boolean).join('\n\n');controllerPort=prepared.controllerPort;controllerBaud=prepared.controllerBaud;pidCommand=prepared.pidCommand||'';runtimeLidarPort=prepared.lidarPort;
      const slamParams=`slam_toolbox:
  ros__parameters:
    solver_plugin: solver_plugins::CeresSolver
    ceres_linear_solver: SPARSE_NORMAL_CHOLESKY
    ceres_preconditioner: SCHUR_JACOBI
    ceres_trust_strategy: LEVENBERG_MARQUARDT
    ceres_dogleg_type: TRADITIONAL_DOGLEG
    ceres_loss_function: None
    odom_frame: odom
    map_frame: map
    base_frame: base_link
    scan_topic: /scan
    use_map_saver: true
    mode: mapping
    resolution: 0.05
    max_laser_range: 20.0
    minimum_time_interval: 0.15
    transform_publish_period: 0.05
    map_update_interval: 1.0
    minimum_travel_distance: 0.05
    minimum_travel_heading: 0.05
    throttle_scans: 1
    transform_timeout: 0.3
    tf_buffer_duration: 30.0
    enable_interactive_mode: false
`;
      const slamParamsPath=`${p.runtime}/mapper_params.yaml`;
      await agentReq(s.robotKey,'fs_write',{path:slamParamsPath,content:slamParams});
      const lidarDevice=REAL_LIDAR_CATALOG[prepared.lidarModelId],lidarLaunch=lidarDevice?lidarDirectLaunchCommand(lidarDevice,prepared.lidarPort,prepared.lidarBaud,prepared.lidarFrameId):'ros2 launch roside_lidar_setup lidar.launch.py';
      const sharedLidar=lidarRuntimePaths(s),sharedLidarStop=`lpid=$(cat ${remoteShellPath(sharedLidar.pid)} 2>/dev/null || true); if [[ "$lpid" =~ ^[0-9]+$ ]] && kill -0 "$lpid" 2>/dev/null; then kill -- -"$lpid" 2>/dev/null || kill "$lpid" 2>/dev/null || true; fi; rm -f ${remoteShellPath(sharedLidar.pid)}`;
      const staleLidarPattern="'^([^[:space:]]*/)?(sllidar_node|ydlidar_node|ldlidar[^[:space:]]*node|urg_node2)([[:space:]]|$)|^([^[:space:]]*/)?(python3([.][0-9]+)?[[:space:]]+)?([^[:space:]]*/)?ros2[[:space:]]+(run|launch)[[:space:]]+(sllidar_ros2|roside_lidar_setup|ydlidar|ldlidar_stl_ros2|urg_node2)([[:space:]]|$)'";
      const lidarPortCleanup=SERIAL_DEVICE_PATTERN.test(prepared.lidarPort)?`if command -v fuser >/dev/null 2>&1; then fuser -k ${shellQuote(prepared.lidarPort)} 2>/dev/null || true; fi`:'';
      const staleCleanup=`pkill -TERM -f '[r]os2 launch roside_controller_bridge controller_bridge.launch.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch slam_toolbox online_async_launch.py' 2>/dev/null || true; pkill -TERM -f '[c]ontroller_bridge.py --ros-args' 2>/dev/null || true; pkill -TERM -f '[_]roside_mapping_controller.py' 2>/dev/null || true; pkill -TERM -f '[_]roside_mapping_live.py' 2>/dev/null || true; pkill -TERM -f '[r]oside_odom_bootstrap' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch nav2_bringup bringup_launch.py' 2>/dev/null || true; pkill -TERM -f '[_]roside_navigation_live.py' 2>/dev/null || true; pkill -TERM -f ${staleLidarPattern} 2>/dev/null || true; sleep 1; pkill -KILL -f ${staleLidarPattern} 2>/dev/null || true`;
      await agentReq(s.robotKey,'exec',{command:`${stop}; ${sharedLidarStop}; ${staleCleanup}; ${lidarPortCleanup}; sleep 2; echo ROSIDE_MAPPING_LIDAR_CLEANUP_BEGIN; ps -eo pid,cmd | grep -E 'sllidar|ydlidar|ldlidar|urg_node2|roside_lidar_setup' | grep -v grep || true; echo ROSIDE_MAPPING_LIDAR_CLEANUP_END`,timeout:12000},15000);
      const lidarRunner=`set -eo pipefail; ${source}; exec ${lidarLaunch}`;
      const runner=`${source}; ${prepared.lidarTfCommands.map(command=>command+' &').join(' ')} timeout 8s ros2 run tf2_ros static_transform_publisher --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 --frame-id odom --child-frame-id base_link --ros-args -r __node:=roside_odom_bootstrap & exec ros2 launch slam_toolbox online_async_launch.py slam_params_file:=${remoteShellPath(slamParamsPath)} use_sim_time:=false`;
      const serialPreflight=lidarSerialPreflightCommand(prepared.lidarPort,prepared.lidarBaud);
      const command=`mkdir -p ${remoteShellPath(p.runtime)}; : > ${remoteShellPath(p.log)}; { echo ROSIDE_MAPPING_LIDAR_ATTEMPT=$(date +%s); echo ROSIDE_LIDAR_CONFIG model=${shellQuote(prepared.lidarModelId||'unknown')} port=${shellQuote(prepared.lidarPort||'unknown')} baud=${shellQuote(prepared.lidarBaud??'unknown')}; udevadm info --query=property --name=${shellQuote(prepared.lidarPort)} 2>/dev/null | grep -E '^(ID_VENDOR|ID_MODEL|ID_SERIAL|ID_USB|DEVPATH)=' || true; } > ${remoteShellPath(p.lidarLog)}; ( ${serialPreflight} ) >> ${remoteShellPath(p.lidarLog)} 2>&1 || { rc=$?; tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true; exit $rc; }; nohup setsid bash -lc ${shellQuote(lidarRunner)} >> ${remoteShellPath(p.lidarLog)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(p.lidarPid)}; sleep 3; lidar_pid=$(cat ${remoteShellPath(p.lidarPid)} 2>/dev/null || true); if ! [[ "$lidar_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$lidar_pid" 2>/dev/null; then echo ROSIDE_MAPPING_LIDAR_START_FAILED; tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true; exit 51; fi; ${source}; scan_ok=0; for i in 1 2 3; do if ! kill -0 "$lidar_pid" 2>/dev/null; then echo ROSIDE_MAPPING_LIDAR_DIED_BEFORE_SCAN; tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true; exit 52; fi; if timeout 5s ros2 topic echo --once /scan --qos-reliability best_effort >/dev/null 2>&1; then scan_ok=$((scan_ok+1)); fi; sleep 1; done; if [ "$scan_ok" -lt 2 ]; then echo "ROSIDE_MAPPING_SCAN_WAIT_FAILED count=$scan_ok"; timeout 3s ros2 topic info /scan 2>&1 || true; tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true; kill -- -"$lidar_pid" 2>/dev/null || kill "$lidar_pid" 2>/dev/null || true; exit 52; fi; nohup setsid bash -lc ${shellQuote(runner)} > ${remoteShellPath(p.log)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(p.pid)}; sleep 5`;
      const {started}=await runLidarStartWithUsbRecovery(s,{command,port:prepared.lidarPort,password:req.body.sudoPassword,logPath:p.lidarLog,execTimeout:45000,requestTimeout:48000});if(started.code!==0){let output=[started.stdout,started.stderr].filter(Boolean).join('\n');if(started.code===53&&!/ROSIDE_SERIAL_PREFLIGHT=failed/.test(output)){const diagnostic=await agentReq(s.robotKey,'exec',{command:`tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true`,timeout:4000},6000).catch(()=>({stdout:''}));output=[output,diagnostic.stdout,diagnostic.stderr].filter(Boolean).join('\n');}const lidarFailed=/ROSIDE_MAPPING_(?:LIDAR|SCAN)_/.test(output)||[51,52,53].includes(started.code),deviceInfoFailed=/80008004/.test(output)&&!/cannot bind to the specified serial port/i.test(output),config=`${prepared.lidarModelId||'ไม่ทราบรุ่น'} @ ${prepared.lidarBaud??'ไม่ทราบ baud'} · ${prepared.lidarPort||'ไม่ทราบพอร์ต'}`,serialError=output.match(/ROSIDE_SERIAL_PREFLIGHT=failed[^\n]*/)?.[0]||'',lidarError=serialError?`ระบบเปิดพอร์ต LiDAR ไม่ได้หลังรีเซ็ต USB แล้ว (${config}) · ${serialError}`:deviceInfoFailed?`เปิด serial ได้ แต่ LiDAR ไม่ตอบ DeviceInfo (80008004 · ${config}) · ตรวจฉลากรุ่นบนตัว LiDAR ให้ตรงกับรายการ ถ้ารุ่นถูกแล้วให้ถอด USB/ไฟ 10 วินาทีแล้วเสียบใหม่`:`LiDAR ยังไม่ส่ง /scan (${config}) กรุณาตรวจรุ่น LiDAR, baudrate, พอร์ต USB และไฟเลี้ยง`;return res.status(500).json({ok:false,error:lidarFailed?lidarError:'เปิด SLAM ไม่สำเร็จ',stage:lidarFailed?'launch-lidar':'launch-slam',output:output.slice(-10000)});}
    }
    const inspect=`pid=$(cat ${remoteShellPath(p.pid)} 2>/dev/null || true); [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo ROSIDE_PROCESS=running || echo ROSIDE_PROCESS=stopped; lidar_pid=$(cat ${remoteShellPath(p.lidarPid)} 2>/dev/null || true); [[ "$lidar_pid" =~ ^[0-9]+$ ]] && kill -0 "$lidar_pid" 2>/dev/null && echo ROSIDE_LIDAR=running || echo ROSIDE_LIDAR=stopped; source ${remoteShellPath(p.setup)} 2>/dev/null; source ${remoteShellPath(p.root+'/install/setup.bash')} 2>/dev/null || true; echo ROSIDE_TOPICS_BEGIN; timeout 4 ros2 topic list 2>/dev/null || true; echo ROSIDE_TOPICS_END; echo ROSIDE_LIDAR_LOG_BEGIN; tail -100 ${remoteShellPath(p.lidarLog)} 2>/dev/null || true; echo ROSIDE_LIDAR_LOG_END; echo ROSIDE_LOG_BEGIN; tail -80 ${remoteShellPath(p.log)} 2>/dev/null || true; echo ROSIDE_LOG_END`;
    const loadProbe=()=>agentReq(s.robotKey,'exec',{command:inspect,timeout:10000},13000),out=await (action==='status'?runtimeProbeCache.get(s.robotKey+'\0'+(s.workspace||'~/ros2_ws')+'\0mapping',loadProbe):loadProbe()),text=[out.stdout,out.stderr].filter(Boolean).join('\n'),topics=text.match(/ROSIDE_TOPICS_BEGIN\n([\s\S]*?)\nROSIDE_TOPICS_END/)?.[1]||'',lidarLog=text.match(/ROSIDE_LIDAR_LOG_BEGIN\n([\s\S]*?)\nROSIDE_LIDAR_LOG_END/)?.[1]||'',log=text.match(/ROSIDE_LOG_BEGIN\n([\s\S]*?)\nROSIDE_LOG_END/)?.[1]||'',processRunning=/ROSIDE_PROCESS=running/.test(text),lidarRunning=/ROSIDE_LIDAR=running/.test(text),scanReady=/(?:^|\n)\/scan(?:\s|$)/m.test(topics);
    if(action==='start'&&!lidarRunning)return res.status(500).json({ok:false,error:'LiDAR driver หยุดทำงานระหว่างเริ่ม Mapping',stage:'launch-lidar',output:lidarLog.slice(-8000)});
    if(action==='start'&&!scanReady)return res.status(500).json({ok:false,error:'LiDAR รันอยู่แต่ยังไม่มีข้อมูล /scan',stage:'launch-lidar',output:lidarLog.slice(-8000)});
    if(action==='start'&&!processRunning)return res.status(500).json({ok:false,error:'โปรเซส SLAM หยุดทำงานระหว่างเริ่มระบบ',stage:'launch-slam',output:log.slice(-8000)});
    res.json({ok:true,action,controllerPort,controllerBaud,pidCommand,runtimeLidarPort,processRunning,lidarRunning,mapReady:/(?:^|\n)\/map(?:\s|$)/m.test(topics),scanReady,odomReady:/(?:^|\n)\/odom(?:\s|$)/m.test(topics),topics,lidarLog,log,...(action==='status'?mappingOperationStatus(s,req.body.sessionId):{}),...(typeof preparation==='string'?{preparation}: {})});
  }catch(error){res.status(error.aptBusy?409:500).json({ok:false,error:error.message,stage:error.stage,requiresSudo:!!error.requiresSudo,aptBusy:!!error.aptBusy});}
  finally{releaseRuntimeOperation(s.robotKey,operation);}
});

app.post('/api/mapping/save',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  const mapName=String(req.body.mapName||'').trim();if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'ชื่อแผนที่ใช้ A-Z, a-z, 0-9, _ หรือ - ไม่เกิน 40 ตัว'});
  const p=mappingRuntimePaths(s),folder=`${p.root}/maps/${mapName}`;
  try{
    const command=`set -eo pipefail; source ${remoteShellPath(p.setup)}; source ${remoteShellPath(p.root+'/install/setup.bash')} 2>/dev/null||true; mkdir -p ${remoteShellPath(folder)}; timeout --signal=TERM 18s ros2 run nav2_map_server map_saver_cli -f ${remoteShellPath(folder+'/map')} --ros-args -p save_map_timeout:=10.0; test -s ${remoteShellPath(folder+'/map.yaml')}; test -s ${remoteShellPath(folder+'/map.pgm')} -o -s ${remoteShellPath(folder+'/map.png')}`;
    const out=await agentReq(s.robotKey,'exec',{command,timeout:20000},23000);if(out.code!==0){const output=[out.stdout,out.stderr].filter(Boolean).join('\n').slice(-8000),timedOut=out.code===124;return res.status(500).json({ok:false,error:timedOut?'หมดเวลารอบันทึกแผนที่ ตรวจว่า SLAM ยังทำงานและ /map มีข้อมูล':'บันทึกแผนที่ไม่สำเร็จ ตรวจว่า /map มีข้อมูลและติดตั้ง nav2_map_server แล้ว',output});}
    await agentReq(s.robotKey,'fs_write',{path:`${p.root}/.roside/mapping_result.json`,content:JSON.stringify({version:1,mapName,savedAt:new Date().toISOString(),yaml:`maps/${mapName}/map.yaml`,image:`maps/${mapName}/map.pgm`},null,2)+'\n'});
    invalidateProjectScan(s);invalidateRobotProgress(s);
    res.json({ok:true,mapName,folder:`maps/${mapName}`,yaml:`maps/${mapName}/map.yaml`,output:[out.stdout,out.stderr].filter(Boolean).join('\n')});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/mapping/check',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  const mapName=String(req.body.mapName||'').trim();if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'กรุณาระบุชื่อแผนที่ที่ถูกต้อง'});
  const p=mappingRuntimePaths(s),folder=`${p.root}/maps/${mapName}`,yamlPath=`${folder}/map.yaml`;
  const checks=[];
  try{
    const yamlResult=await agentReq(s.robotKey,'fs_read',{path:yamlPath});
    const yaml=String(yamlResult.content||'');
    checks.push({id:'yaml',ok:yaml.trim().length>0,label:'ไฟล์ map.yaml',detail:yaml.trim().length?'พบไฟล์และมีข้อมูล':'ไฟล์ว่าง'});
    const scalar=key=>yaml.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`,'m'))?.[1]?.replace(/^['"]|['"]$/g,'').trim()||'';
    const image=scalar('image'),resolution=Number(scalar('resolution')),originText=scalar('origin'),originValues=(originText.match(/-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g)||[]).map(Number);
    const imageSafe=/^[A-Za-z0-9_.-]+\.(?:pgm|png)$/i.test(image);
    let imageExists=false;
    if(imageSafe){const imageCheck=await agentReq(s.robotKey,'exec',{command:`test -s ${remoteShellPath(folder+'/'+image)}`,timeout:5000},7000);imageExists=imageCheck.code===0;}
    checks.push({id:'image',ok:imageSafe&&imageExists,label:'ไฟล์ภาพแผนที่',detail:!image?'ไม่มีค่า image ใน YAML':!imageSafe?'ชื่อหรือชนิดไฟล์ image ไม่ถูกต้อง':imageExists?image:'ไม่พบไฟล์ '+image});
    checks.push({id:'resolution',ok:Number.isFinite(resolution)&&resolution>0,label:'Resolution',detail:Number.isFinite(resolution)&&resolution>0?`${resolution} เมตร/เซลล์`:'ค่า resolution ต้องมากกว่า 0'});
    checks.push({id:'origin',ok:originValues.length===3&&originValues.every(Number.isFinite),label:'Map origin',detail:originValues.length===3?`[${originValues.join(', ')}]`:'origin ต้องมีค่า [x, y, yaw]'});
    const mode=scalar('mode').toLowerCase(),modeReady=['trinary','scale','raw'].includes(mode);
    checks.push({id:'mode',ok:modeReady,label:'Map mode',detail:modeReady?mode:'mode ต้องเป็น trinary, scale หรือ raw'});
    const negate=Number(scalar('negate')),occupied=Number(scalar('occupied_thresh')),free=Number(scalar('free_thresh'));
    const thresholdsReady=(negate===0||negate===1)&&Number.isFinite(occupied)&&Number.isFinite(free)&&free>=0&&occupied<=1&&free<occupied;
    checks.push({id:'thresholds',ok:thresholdsReady,label:'Occupancy parameters',detail:thresholdsReady?`negate=${negate}, free=${free}, occupied=${occupied}`:'ต้องมี negate, free_thresh และ occupied_thresh ที่ถูกต้อง'});
    return res.json({ok:true,ready:checks.every(check=>check.ok),mapName,yaml:`maps/${mapName}/map.yaml`,checks});
  }catch(error){
    checks.push({id:'yaml',ok:false,label:'ไฟล์ map.yaml',detail:'ไม่พบหรืออ่านไฟล์ไม่ได้'});
    return res.json({ok:true,ready:false,mapName,yaml:`maps/${mapName}/map.yaml`,checks,error:error.message});
  }
});

function navigationRuntimePaths(s){const root=(s.workspace||'~/ros2_ws').replace(/\/$/,'');return{root,setup:s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',runtime:'~/.roside/navigation-runtime',pid:'~/.roside/navigation-runtime/nav2.pid',log:'~/.roside/navigation-runtime/nav2.log',lidarPid:'~/.roside/navigation-runtime/lidar.pid',lidarLog:'~/.roside/navigation-runtime/lidar.log'};}

const NAV2_INSTALL_JOB={script:'/tmp/roside-nav2-install.sh',pid:'/tmp/roside-nav2-install.pid',log:'/tmp/roside-nav2-install.log',status:'/tmp/roside-nav2-install.status'};
async function navigationInstallStatus(s){
  const f=NAV2_INSTALL_JOB,setup=s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
  const command=`pid=$(cat ${shellQuote(f.pid)} 2>/dev/null || true)
job_running=false
if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then job_running=true; fi
if pgrep -f '[r]oside-nav2-install.sh|[a]pt-get .*ros-[a-z0-9_-]+-nav2-(bringup|amcl)' >/dev/null 2>&1; then job_running=true; fi
$job_running && echo ROSIDE_NAV2_INSTALL=running || echo ROSIDE_NAV2_INSTALL=stopped
echo ROSIDE_NAV2_STATUS=$(cat ${shellQuote(f.status)} 2>/dev/null || echo IDLE)
source ${shellQuote(setup)} 2>/dev/null || true
if ros2 pkg prefix nav2_bringup >/dev/null 2>&1 && ros2 pkg prefix nav2_amcl >/dev/null 2>&1; then echo ROSIDE_NAV2_PACKAGES=ready; else echo ROSIDE_NAV2_PACKAGES=missing; fi
echo ROSIDE_NAV2_LOG_BEGIN
tail -80 ${shellQuote(f.log)} 2>/dev/null || true`;
  const out=await agentReq(s.robotKey,'exec',{command,timeout:7000},9000),text=[out.stdout,out.stderr].filter(Boolean).join('\n'),status=text.match(/ROSIDE_NAV2_STATUS=([^\n]+)/)?.[1]?.trim()||'IDLE',installing=/ROSIDE_NAV2_INSTALL=running/.test(text),packagesReady=/ROSIDE_NAV2_PACKAGES=ready/.test(text),installLog=(text.split('ROSIDE_NAV2_LOG_BEGIN\n')[1]||'').slice(-8000),errorLines=installLog.split(/\r?\n/).filter(line=>/(^|\s)(E:|Err:|error:|failed|no space left|unmet dependencies|dpkg was interrupted)/i.test(line));
  const timeoutMessage=status==='FAILED:124'?'การดาวน์โหลดเกินเวลาเดิม 15 นาที กรุณากดเริ่มอีกครั้ง ระบบจะดาวน์โหลดต่อจาก cache ที่มีอยู่':'';
  return{installing,installStatus:status,packagesReady,installReady:!installing&&packagesReady,installFailed:!installing&&!packagesReady&&/^FAILED/.test(status),installLog,installError:(errorLines.slice(-6).join('\n').slice(-1800)||timeoutMessage)};
}
async function startNavigationInstall(s,distro,password,setup){
  const f=NAV2_INSTALL_JOB,script=`#!/bin/bash
set -euo pipefail
status=${shellQuote(f.status)}
log=${shellQuote(f.log)}
finish(){ rc=$?; if [ "$rc" -eq 0 ]; then echo READY > "$status"; else echo "FAILED:$rc" > "$status"; fi; chmod 644 "$status" "$log" 2>/dev/null || true; }
trap finish EXIT
echo RUNNING > "$status"
export DEBIAN_FRONTEND=noninteractive
if command -v fuser >/dev/null 2>&1 && fuser -s /var/lib/dpkg/lock-frontend; then
  for holder in $(fuser /var/lib/dpkg/lock-frontend 2>/dev/null); do
    holder_age=$(ps -p "$holder" -o etimes= 2>/dev/null | tr -d ' ')
    holder_cmd=$(ps -p "$holder" -o args= 2>/dev/null || true)
    case "$holder_cmd" in
      *"ros-${distro}-navigation2"*|*"ros-${distro}-nav2-bringup"*)
        if [ "\${holder_age:-0}" -ge 120 ] 2>/dev/null; then
          echo "[recover] stopping orphan APT pid=$holder age=\${holder_age}s"
          kill -INT "$holder" 2>/dev/null || true
        fi
      ;;
    esac
  done
  for wait_step in $(seq 1 30); do fuser -s /var/lib/dpkg/lock-frontend || break; sleep 2; done
fi
if command -v fuser >/dev/null 2>&1 && fuser -s /var/lib/dpkg/lock-frontend; then echo '[wait] another APT process still owns the lock'; exit 73; fi
echo '[repair] dpkg --configure -a'
dpkg --configure -a
echo '[install] nav2_bringup + nav2_amcl'
timeout --signal=INT --kill-after=30s 3600s apt-get -q --no-install-recommends -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 install -y ros-${distro}-nav2-bringup ros-${distro}-nav2-amcl
source ${shellQuote(setup)}
ros2 pkg prefix nav2_bringup
ros2 pkg prefix nav2_amcl
echo '[ready] Nav2 packages installed'
`;
  const encoded=Buffer.from(script).toString('base64'),launch=`printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(f.script)}; chmod 700 ${shellQuote(f.script)}; : > ${shellQuote(f.log)}; echo STARTING > ${shellQuote(f.status)}; chmod 644 ${shellQuote(f.log)} ${shellQuote(f.status)}; nohup bash ${shellQuote(f.script)} > ${shellQuote(f.log)} 2>&1 < /dev/null & echo $! > ${shellQuote(f.pid)}`;
  await lidarSudoExec(s,launch,password,15000);
  return navigationInstallStatus(s);
}

app.post('/api/navigation/maps',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});const p=navigationRuntimePaths(s);
  try{const out=await agentReq(s.robotKey,'exec',{command:`find ${remoteShellPath(p.root+'/maps')} -mindepth 2 -maxdepth 2 -type f -name map.yaml -printf '%h\\n' 2>/dev/null | sed 's#/$##' | awk -F/ '{print $NF}' | grep -E '^[A-Za-z0-9_-]{1,40}$' | sort -u`,timeout:6000},8000);let latest='';try{const f=await agentReq(s.robotKey,'fs_read',{path:`${p.root}/.roside/mapping_result.json`});latest=String(JSON.parse(f.content||'{}').mapName||'');}catch{}const names=String(out.stdout||'').split(/\r?\n/).filter(Boolean);res.json({ok:true,maps:names.map(name=>({name,latest:name===latest}))});}catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/navigation/map-data',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  const mapName=String(req.body.mapName||'').trim();if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'ชื่อ Saved Map ไม่ถูกต้อง'});
  const p=navigationRuntimePaths(s),yaml=`${p.root}/maps/${mapName}/map.yaml`;
  const script=`import ast,json,math,os,re,sys
yaml_path=sys.argv[1]
folder=os.path.realpath(os.path.dirname(yaml_path))
cfg={}
with open(yaml_path,'r',encoding='utf-8') as f:
 for raw in f:
  line=raw.split('#',1)[0].strip()
  if ':' in line:
   k,v=line.split(':',1); v=v.strip()
   if len(v)>=2 and v[:1] in (chr(34),chr(39)) and v[-1:]==v[:1]: v=v[1:-1]
   cfg[k.strip()]=v
image=cfg.get('image','map.pgm')
image_path=os.path.realpath(os.path.join(folder,image))
if os.path.commonpath([folder,image_path])!=folder: raise ValueError('map image path escapes folder')
raw=open(image_path,'rb').read(); pos=[0]
def token():
 n=len(raw)
 while pos[0]<n:
  if raw[pos[0]]==35:
   while pos[0]<n and raw[pos[0]] not in (10,13): pos[0]+=1
  elif raw[pos[0]] in b' \\t\\r\\n': pos[0]+=1
  else: break
 start=pos[0]
 while pos[0]<n and raw[pos[0]] not in b' \\t\\r\\n#': pos[0]+=1
 if start==pos[0]: raise ValueError('invalid PGM header')
 return raw[start:pos[0]].decode('ascii')
magic=token(); width=int(token()); height=int(token()); maxval=int(token())
if magic not in ('P5','P2') or width<1 or height<1 or maxval<1: raise ValueError('unsupported PGM')
if magic=='P5':
 while pos[0]<len(raw) and raw[pos[0]] in b' \\t\\r\\n': pos[0]+=1
 size=width*height
 if maxval<256: pixels=list(raw[pos[0]:pos[0]+size])
 else:
  block=raw[pos[0]:pos[0]+size*2]; pixels=[(block[i]<<8)|block[i+1] for i in range(0,len(block),2)]
else: pixels=[int(token()) for _ in range(width*height)]
if len(pixels)!=width*height: raise ValueError('PGM pixel data is incomplete')
resolution=float(cfg.get('resolution','0.05'))
origin=[float(x) for x in re.findall(r'-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?',cfg.get('origin','[0,0,0]'))]
if len(origin)<2: raise ValueError('invalid map origin')
negate=int(float(cfg.get('negate','0'))); occupied=float(cfg.get('occupied_thresh','0.65')); free=float(cfg.get('free_thresh','0.196'))
step=max(1,int(math.ceil(max(width,height)/360.0))); data=[]
for gy in range(0,height,step):
 iy=height-1-gy
 for x in range(0,width,step):
  value=pixels[iy*width+x]/maxval; probability=value if negate else 1.0-value
  data.append(100 if probability>occupied else 0 if probability<free else -1)
out={'width':(width+step-1)//step,'height':(height+step-1)//step,'resolution':resolution*step,'originX':origin[0],'originY':origin[1],'data':data,'name':sys.argv[2]}
print(json.dumps(out,separators=(',',':')))`;
  try{
    const encoded=Buffer.from(script).toString('base64'),command=`python3 -c "import base64;exec(base64.b64decode('${encoded}'))" ${remoteShellPath(yaml)} ${shellQuote(mapName)}`;
    const out=await agentReq(s.robotKey,'exec',{command,timeout:10000},13000);if(out.code!==0)throw Error([out.stdout,out.stderr].filter(Boolean).join('\n').slice(-3000)||'อ่าน Saved Map ไม่สำเร็จ');
    const map=JSON.parse(String(out.stdout||'').trim());return res.json({ok:true,map,source:'saved-map-files'});
  }catch(error){return res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/navigation/runtime',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'หน้า Nav2 จริงไม่รองรับ Sim'});
  const conflict=realRuntimeConflict(s,req.body.sessionId,'/ws/navigation',req.body.action);if(conflict)return res.status(409).json({ok:false,code:'ROBOT_BUSY',error:conflict});
  const action=String(req.body.action||'status'),mapName=String(req.body.mapName||'');if(!['start','stop','status','install-status'].includes(action))return res.status(400).json({ok:false,error:'คำสั่ง Nav2 ไม่ถูกต้อง'});const p=navigationRuntimePaths(s),mapping=mappingRuntimePaths(s),sharedLidar=lidarRuntimePaths(s),source=mappingSourceCommand(mapping);let controllerPort='',controllerBaud=115200,pidCommand='',runtimeLidarPort='',preparation='';
  if(action==='status'&&robotRuntimeOperations.has(s.robotKey))return res.json({ok:true,action,...mappingOperationStatus(s,req.body.sessionId,'/ws/navigation')});
  const stop=`for pid_file in ${remoteShellPath(p.pid)} ${remoteShellPath(p.lidarPid)}; do pid=$(cat "$pid_file" 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; fi; rm -f "$pid_file"; done; sleep 1`;
  const operation=reserveRuntimeOperation(s,req.body.sessionId,'/ws/navigation',action);
  try{
    if(action==='install-status')return res.json({ok:true,...await navigationInstallStatus(s)});
    if(action==='stop')await agentReq(s.robotKey,'exec',{command:`${stop}; pkill -TERM -f '[_]roside_navigation_live.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch roside_controller_bridge controller_bridge.launch.py' 2>/dev/null || true; pkill -TERM -f '[c]ontroller_bridge.py --ros-args' 2>/dev/null || true`,timeout:9000},11000);
    if(action==='start'){
      if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'กรุณาเลือก Saved Map'});const yaml=`${p.root}/maps/${mapName}/map.yaml`,requestedSpeed=Number(req.body.speed),requestedTurn=Number(req.body.turn),navMaxSpeed=Number.isFinite(requestedSpeed)&&requestedSpeed>=.05&&requestedSpeed<=10?requestedSpeed:2,navMaxTurn=Number.isFinite(requestedTurn)&&requestedTurn>=.1&&requestedTurn<=10?requestedTurn:2;
      const exists=await agentReq(s.robotKey,'exec',{command:`test -s ${remoteShellPath(yaml)}`,timeout:5000},7000);if(exists.code!==0)return res.status(400).json({ok:false,error:`ไม่พบ Saved Map maps/${mapName}/map.yaml กรุณาบันทึกจากหน้า Mapping ก่อน`});
      const prepared=await prepareMappingRuntime(s,mapping,req.body.sudoPassword,req.body.controllerPort,req.body.lidarPort,{requireSlam:false,lidarModelId:req.body.lidarModelId}),driverRepair=await ensureSllidarChannelFix(s,mapping,prepared.lidarModelId);preparation=[prepared.output,driverRepair].filter(Boolean).join('\n\n');controllerPort=prepared.controllerPort;controllerBaud=prepared.controllerBaud;pidCommand=prepared.pidCommand||'';runtimeLidarPort=prepared.lidarPort;
      const distro=rosDistroForSession(s,p.setup);const navCheck=await agentReq(s.robotKey,'exec',{command:`${source}; ros2 pkg prefix nav2_bringup >/dev/null 2>&1 && ros2 pkg prefix nav2_amcl >/dev/null 2>&1`,timeout:7000},9000);
      if(navCheck.code!==0){const install=await navigationInstallStatus(s);if(!install.installing){await startNavigationInstall(s,distro,req.body.sudoPassword,p.setup);}return res.status(202).json({ok:true,...await navigationInstallStatus(s),installing:true,stage:'install-nav2',message:'กำลังติดตั้ง Nav2 เบื้องหลัง'});}
      const lidarDevice=REAL_LIDAR_CATALOG[prepared.lidarModelId],lidarLaunch=lidarDevice?lidarDirectLaunchCommand(lidarDevice,prepared.lidarPort,prepared.lidarBaud,prepared.lidarFrameId):'ros2 launch roside_lidar_setup lidar.launch.py';
      const mappingStop=`mpid=$(cat ${remoteShellPath(mapping.pid)} 2>/dev/null || true); if [[ "$mpid" =~ ^[0-9]+$ ]] && kill -0 "$mpid" 2>/dev/null; then kill -- -"$mpid" 2>/dev/null || true; fi; rm -f ${remoteShellPath(mapping.pid)}`;
      const sharedLidarStop=`lpid=$(cat ${remoteShellPath(sharedLidar.pid)} 2>/dev/null || true); if [[ "$lpid" =~ ^[0-9]+$ ]] && kill -0 "$lpid" 2>/dev/null; then kill -- -"$lpid" 2>/dev/null || kill "$lpid" 2>/dev/null || true; fi; rm -f ${remoteShellPath(sharedLidar.pid)}`;
      const lidarPortCleanup=SERIAL_DEVICE_PATTERN.test(prepared.lidarPort)?`if command -v fuser >/dev/null 2>&1; then fuser -k ${shellQuote(prepared.lidarPort)} 2>/dev/null || true; fi`:'',controllerPortCleanup=SERIAL_DEVICE_PATTERN.test(prepared.controllerPort)?`if command -v fuser >/dev/null 2>&1; then fuser -k ${shellQuote(prepared.controllerPort)} 2>/dev/null || true; fi`:'';
      const staleLidarPattern="'^([^[:space:]]*/)?(sllidar_node|ydlidar_node|ldlidar[^[:space:]]*node|urg_node2)([[:space:]]|$)|^([^[:space:]]*/)?(python3([.][0-9]+)?[[:space:]]+)?([^[:space:]]*/)?ros2[[:space:]]+(run|launch)[[:space:]]+(sllidar_ros2|roside_lidar_setup|ydlidar|ldlidar_stl_ros2|urg_node2)([[:space:]]|$)'";
      const staleNavigationPattern="'[c]ontroller_server|[p]lanner_server|[b]t_navigator|[b]ehavior_server|[v]elocity_smoother|[w]aypoint_follower|[a]mcl|[m]ap_server|[l]ifecycle_manager'";
      const cleanup=`echo ROSIDE_OLD_NAV_NODES_BEGIN; ps -eo pid,cmd | grep -E '[r]oside_navigation_live|[c]ontroller_bridge|[c]ontroller_server|[p]lanner_server|[b]t_navigator|[b]ehavior_server|[v]elocity_smoother|[w]aypoint_follower|[a]mcl|[m]ap_server|[l]ifecycle_manager' || true; echo ROSIDE_OLD_NAV_NODES_END; ${stop}; ${mappingStop}; ${sharedLidarStop}; pkill -TERM -f '[r]os2 launch roside_controller_bridge controller_bridge.launch.py' 2>/dev/null || true; pkill -TERM -f '[c]ontroller_bridge.py --ros-args' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch slam_toolbox' 2>/dev/null || true; pkill -TERM -f '[_]roside_mapping_live.py' 2>/dev/null || true; pkill -TERM -f '[_]roside_navigation_live.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch nav2_bringup bringup_launch.py' 2>/dev/null || true; pkill -TERM -f ${staleNavigationPattern} 2>/dev/null || true; pkill -TERM -f ${staleLidarPattern} 2>/dev/null || true; sleep 1; pkill -KILL -f '[c]ontroller_bridge.py --ros-args' 2>/dev/null || true; pkill -KILL -f '[_]roside_navigation_live.py' 2>/dev/null || true; pkill -KILL -f ${staleNavigationPattern} 2>/dev/null || true; pkill -KILL -f ${staleLidarPattern} 2>/dev/null || true; ${controllerPortCleanup}; ${lidarPortCleanup}; sleep 1; echo ROSIDE_NAV_CLEANUP_REMAINING_BEGIN; ps -eo pid,cmd | grep -E '[r]oside_navigation_live|[c]ontroller_bridge|[c]ontroller_server|[p]lanner_server|[b]t_navigator|[b]ehavior_server|[v]elocity_smoother|[w]aypoint_follower|[a]mcl|[m]ap_server|[l]ifecycle_manager' || true; echo ROSIDE_NAV_CLEANUP_REMAINING_END; echo ROSIDE_LIDAR_CLEANUP_BEGIN; ps -eo pid,cmd | grep -E '[s]llidar|[y]dlidar|[l]dlidar|[u]rg_node2|[r]oside_lidar_setup' || true; echo ROSIDE_LIDAR_CLEANUP_END`;
      await agentReq(s.robotKey,'exec',{command:cleanup,timeout:10000},13000);
      const navParams=`${p.runtime}/nav2_params.yaml`,defaultParams=`$(ros2 pkg prefix nav2_bringup)/share/nav2_bringup/params/nav2_params.yaml`,navMaxSpeedYaml=navMaxSpeed.toFixed(6),navMaxTurnYaml=navMaxTurn.toFixed(6);
      const lidarRunner=`set -eo pipefail; ${source}; exec ${lidarLaunch}`;
      const runner=`${source}; default_params=${defaultParams}; test -s "$default_params"; sed 's/base_footprint/base_link/g' "$default_params" > ${remoteShellPath(navParams)}; sed -E -i 's#^([[:space:]]*(max_vel_x|max_speed_xy|desired_linear_vel):).*#\\1 ${navMaxSpeedYaml}#; s#^([[:space:]]*(max_vel_theta|rotate_to_heading_angular_vel):).*#\\1 ${navMaxTurnYaml}#; s#^([[:space:]]*max_velocity:).*#\\1 [${navMaxSpeedYaml}, 0.0, ${navMaxTurnYaml}]#; s#^([[:space:]]*min_velocity:).*#\\1 [-${navMaxSpeedYaml}, 0.0, -${navMaxTurnYaml}]#' ${remoteShellPath(navParams)}; ${prepared.lidarTfCommands.map(command=>command+' &').join(' ')} exec ros2 launch nav2_bringup bringup_launch.py map:=${remoteShellPath(yaml)} params_file:=${remoteShellPath(navParams)} use_sim_time:=false autostart:=true`;
      const serialPreflight=lidarSerialPreflightCommand(prepared.lidarPort,prepared.lidarBaud);
      const command=`mkdir -p ${remoteShellPath(p.runtime)}; : > ${remoteShellPath(p.log)}; { echo ROSIDE_LIDAR_ATTEMPT=$(date +%s); echo ROSIDE_LIDAR_CONFIG model=${shellQuote(prepared.lidarModelId||'unknown')} port=${shellQuote(prepared.lidarPort||'unknown')} baud=${shellQuote(prepared.lidarBaud??'unknown')}; udevadm info --query=property --name=${shellQuote(prepared.lidarPort)} 2>/dev/null | grep -E '^(ID_VENDOR|ID_MODEL|ID_SERIAL|ID_USB|DEVPATH)=' || true; } > ${remoteShellPath(p.lidarLog)}; ( ${serialPreflight} ) >> ${remoteShellPath(p.lidarLog)} 2>&1 || { rc=$?; tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true; exit $rc; }; nohup setsid bash -lc ${shellQuote(lidarRunner)} >> ${remoteShellPath(p.lidarLog)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(p.lidarPid)}; sleep 2; lidar_pid=$(cat ${remoteShellPath(p.lidarPid)} 2>/dev/null || true); if ! [[ "$lidar_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$lidar_pid" 2>/dev/null; then echo 'ROSIDE_LIDAR_START_FAILED'; tail -80 ${remoteShellPath(p.lidarLog)} 2>&1 || true; exit 51; fi; ${source}; if ! timeout 4s ros2 topic echo --once /scan --qos-reliability best_effort >/dev/null 2>&1; then echo 'ROSIDE_SCAN_WAIT_FAILED count=0'; timeout 2s ros2 topic info /scan 2>&1 || true; tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true; kill -- -"$lidar_pid" 2>/dev/null || kill "$lidar_pid" 2>/dev/null || true; exit 52; fi; nohup setsid bash -lc ${shellQuote(runner)} > ${remoteShellPath(p.log)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(p.pid)}; sleep 2`;
      const {started}=await runLidarStartWithUsbRecovery(s,{command,port:prepared.lidarPort,password:req.body.sudoPassword,logPath:p.lidarLog,execTimeout:30000,requestTimeout:33000});if(started.code!==0){let output=[started.stdout,started.stderr].filter(Boolean).join('\n');if(started.code===53&&!/ROSIDE_SERIAL_PREFLIGHT=failed/.test(output)){const diagnostic=await agentReq(s.robotKey,'exec',{command:`tail -100 ${remoteShellPath(p.lidarLog)} 2>&1 || true`,timeout:4000},6000).catch(()=>({stdout:''}));output=[output,diagnostic.stdout,diagnostic.stderr].filter(Boolean).join('\n');}const lidarFailed=/ROSIDE_(?:LIDAR|SCAN)_/.test(output)||[51,52,53].includes(started.code),deviceInfoFailed=/80008004/.test(output)&&!/cannot bind to the specified serial port/i.test(output),config=`${prepared.lidarModelId||'ไม่ทราบรุ่น'} @ ${prepared.lidarBaud??'ไม่ทราบ baud'} · ${prepared.lidarPort||'ไม่ทราบพอร์ต'}`,serialError=output.match(/ROSIDE_SERIAL_PREFLIGHT=failed[^\n]*/)?.[0]||'',lidarError=serialError?`ระบบเปิดพอร์ต LiDAR ไม่ได้หลังรีเซ็ต USB แล้ว (${config}) · ${serialError}`:deviceInfoFailed?`เปิด serial ได้ แต่ LiDAR ไม่ตอบ DeviceInfo (80008004 · ${config}) · ตรวจฉลากรุ่นบนตัว LiDAR ให้ตรงกับรายการ ถ้ารุ่นถูกแล้วให้ถอด USB/ไฟ 10 วินาทีแล้วเสียบใหม่`:`LiDAR ยังไม่ส่ง /scan (${config}) กรุณาตรวจรุ่น LiDAR, baudrate, พอร์ต USB และไฟเลี้ยง`;return res.status(500).json({ok:false,error:lidarFailed?lidarError:'เปิด Nav2 ไม่สำเร็จ',stage:lidarFailed?'launch-lidar':undefined,output:output.slice(-10000)});}
    }
    const inspect=`pid=$(cat ${remoteShellPath(p.pid)} 2>/dev/null || true); [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo ROSIDE_PROCESS=running || echo ROSIDE_PROCESS=stopped; lidar_pid=$(cat ${remoteShellPath(p.lidarPid)} 2>/dev/null || true); [[ "$lidar_pid" =~ ^[0-9]+$ ]] && kill -0 "$lidar_pid" 2>/dev/null && echo ROSIDE_LIDAR=running || echo ROSIDE_LIDAR=stopped; ${source}; echo ROSIDE_SCAN_TOPICS=$(timeout 3s ros2 topic list 2>/dev/null | grep -E '(^|/)scan(_raw)?$|scan' | paste -sd, -); echo ROSIDE_SCAN_INFO_BEGIN; timeout 3s ros2 topic info /scan 2>&1 || true; echo ROSIDE_SCAN_INFO_END; echo ROSIDE_LIDAR_LOG_BEGIN; tail -100 ${remoteShellPath(p.lidarLog)} 2>/dev/null || true; echo ROSIDE_LIDAR_LOG_END; echo ROSIDE_NAV_LOG_BEGIN; tail -100 ${remoteShellPath(p.log)} 2>/dev/null || true; echo ROSIDE_NAV_LOG_END; echo ROSIDE_BRIDGE_LOG_BEGIN; tail -40 ${remoteShellPath(p.runtime+'/bridge.log')} 2>/dev/null || true; echo ROSIDE_BRIDGE_LOG_END`;const loadProbe=()=>agentReq(s.robotKey,'exec',{command:inspect,timeout:9000},11000),out=await (action==='status'?runtimeProbeCache.get(s.robotKey+'\0'+(s.workspace||'~/ros2_ws')+'\0navigation',loadProbe):loadProbe()),text=[out.stdout,out.stderr].filter(Boolean).join('\n'),processRunning=/ROSIDE_PROCESS=running/.test(text),lidarRunning=/ROSIDE_LIDAR=running/.test(text),lidarLog=text.match(/ROSIDE_LIDAR_LOG_BEGIN\n([\s\S]*?)\nROSIDE_LIDAR_LOG_END/)?.[1]?.trim()||'',scanTopics=(text.match(/ROSIDE_SCAN_TOPICS=([^\n]*)/)?.[1]||'').split(',').filter(Boolean),scanInfo=text.match(/ROSIDE_SCAN_INFO_BEGIN\n([\s\S]*?)\nROSIDE_SCAN_INFO_END/)?.[1]?.trim()||'',scanPublisherCount=Number(scanInfo.match(/Publisher count:\s*(\d+)/)?.[1]||0),scanTopicPresent=scanPublisherCount>0||scanTopics.includes('/scan');if(action==='start'&&!lidarRunning)return res.status(500).json({ok:false,error:'LiDAR driver หยุดทำงานระหว่างเริ่มระบบ',stage:'launch-lidar',output:lidarLog.slice(-8000)});if(action==='start'&&!processRunning)return res.status(500).json({ok:false,error:'โปรเซส Nav2 หยุดทำงานระหว่างเริ่มระบบ',stage:'launch-nav2',output:text.slice(-8000)});res.json({ok:true,action,controllerPort,controllerBaud,pidCommand,runtimeLidarPort,processRunning,lidarRunning,lidarLog,scanTopics,scanInfo,scanPublisherCount,scanTopicPresent,log:text,preparation,...(action==='status'?mappingOperationStatus(s,req.body.sessionId,'/ws/navigation'):{})});
  }catch(error){res.status(error.aptBusy?409:500).json({ok:false,error:error.message,stage:error.stage,aptBusy:!!error.aptBusy,requiresSudo:!!error.requiresSudo});}
  finally{releaseRuntimeOperation(s.robotKey,operation);}
});

// Robot Config's primary Save action uses one request so TF/model and wheel
// odometry follow the same flow and the UI receives one authoritative result.
app.post('/api/sim/save-robot-config', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  try {
    const tfFiles = req.body.tfFiles || {};
    const odomFiles = req.body.odomFiles || null;
    if (!tfFiles['package.xml'] || !tfFiles['urdf/robot.urdf'] || !tfFiles['tf_model.json']) {
      return res.status(400).json({ ok:false, error:'Robot Config is missing TF, URDF model, or editable model data' });
    }
    const tf = await saveGeneratedRobotPackage(s, 'sim_robot_tf', tfFiles);
    const odom = odomFiles ? await saveGeneratedRobotPackage(s, 'sim_robot_odom', odomFiles) : null;
    invalidateProjectScan(s);
    invalidateRobotProgress(s);
    res.json({ ok:true, sim:isSim(s.robotKey), tf, odom });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// ── Apply a map (walls/bounds/start) to the running Sim ──
// เขียน ~/map.json ลง workspace ของ sim แล้วรีสตาร์ท backend (dummy) ให้โหลดแผนที่ใหม่
// ใช้ร่วมกับหน้า Map Editor (public/map.js)
app.post('/api/sim/apply-map', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  if (!isSim(s.robotKey)) return res.json({ ok:false, error:'Available for Sim only' });
  try {
    const validationError = validateSimMapData(req.body.map);
    if (validationError) return res.status(400).json({ ok:false, error:validationError });
    const ag = agents.get(s.robotKey);
    if (!ag || typeof ag.respawnBackend !== 'function') return res.json({ ok:false, error:'Sim not ready' });
    const fingerprint='apply:'+crypto.createHash('sha256').update(JSON.stringify(req.body.map)).digest('hex');
    const job=mapsimQueue.enqueue(s.robotKey,fingerprint,async update=>{
      if(agents.get(s.robotKey)!==ag)return {ok:false,error:'Simulation disconnected'};
      update('start');await ag.respawnBackend(req.body.map);
      resetSimulationWizardAfterFieldChange(wsRoot(s.robotKey));invalidateProjectScan(s);invalidateRobotProgress(s);
      return {ok:true};
    });
    if(req.body.async===true)return res.status(202).json({ok:true,job:mapsimQueue.status(job)});
    res.json(await job.done);
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// ── Generate sim_robot_mapsim package from current map ───────────────────────
// แพ็กเกจ Python ROS2 สำหรับแผนที่จำลอง (map editor):
//   - mapsim.py       : โหนด Python ที่ publish /map + /scan + TF tree + ตอบ /cmd_vel
//   - launch file     : ROS2 Python launch (launch/map_editor.launch.py)
// ใช้ร่วมกับหน้า Map Editor — เรียกอัตโนมัติเมื่อกด Save
app.post('/api/sim/generate-mapsim-package', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  if (!isSim(s.robotKey)) return res.json({ ok:false, error:'Available for Sim only' });
  try {
    const mapCapability=inspectSimMapCapability(s.robotKey);
    if(!mapCapability.detected) return res.status(400).json({ok:false,error:mapCapability.validationMessage});
    const out = writeMapsimPackage(s.robotKey, genMapsimFiles());
    invalidateProjectScan(s);
    res.json({ ok:true, created:out.created, written:out.written, pkgDir:out.pkgDir });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// Build and run the generated MapSim package after Map Editor saves map.json.
// The process lives inside this simulation workspace, so Node Status can list
// and stop it through /api/kill-node without affecting another robot.
app.post('/api/sim/run-mapsim', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  if (!isSim(s.robotKey)) return res.json({ ok:false, error:'Available for Sim only' });
  const map=req.body.map;
  if(map!==undefined){const error=validateSimMapData(map);if(error)return res.status(400).json({ok:false,error});}
  const agent=agents.get(s.robotKey);
  try{
    const fingerprint=map===undefined?'launch':crypto.createHash('sha256').update(JSON.stringify(map)).digest('hex');
    const job=mapsimQueue.enqueue(s.robotKey,fingerprint,async update=>{
      if(sessions.get(req.body.sessionId)!==s||agents.get(s.robotKey)!==agent||!agent||!liveSession(s))return {ok:false,error:'Simulation ถูกตัดการเชื่อมต่อ กรุณาเชื่อมต่อแล้วบันทึกใหม่'};
      if(map!==undefined){
        if(typeof agent.applyMapWithoutRestart!=='function')return {ok:false,error:'Simulation ไม่พร้อม กรุณาเชื่อมต่อใหม่'};
        await agent.applyMapWithoutRestart(map);
        resetSimulationWizardAfterFieldChange(wsRoot(s.robotKey));invalidateRobotProgress(s);
      }
      return runMapsimJob(s,update);
    },{prepare:()=>{
      if(map!==undefined){
        const target=path.join(wsRoot(s.robotKey),'map.json'),pending=target+'.pending';
        fs_node.mkdirSync(path.dirname(target),{recursive:true});fs_node.writeFileSync(pending,JSON.stringify(map));fs_node.renameSync(pending,target);
        invalidateProjectScan(s);
      }
    }});
    if(req.body.async===true)return res.status(202).json({ok:true,saved:map!==undefined,job:mapsimQueue.status(job)});
    const result=await job.done;
    return res.status(result.ok?200:500).json(result);
  }catch(error){return res.status(409).json({ok:false,error:error.message});}
});

app.post('/api/sim/mapsim-job',auth,(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  const job=mapsimQueue.get(String(req.body.jobId||''));
  if(!job||job.key!==s.robotKey)return res.status(404).json({ok:false,error:'ไม่พบงานในคิว (เซิร์ฟเวอร์อาจรีสตาร์ต) กรุณาบันทึกใหม่'});
  res.json({ok:true,job:mapsimQueue.status(job)});
});

async function runMapsimJob(s,update) {
  // Keep all expensive phases inside the queue worker.
  let phase='prepare';
  try {
    const mapCapability = inspectSimMapCapability(s.robotKey);
    if (!mapCapability.detected) return { ok:false, error:mapCapability.validationMessage };
    const root = wsRoot(s.robotKey);
    const mapsimFiles=genMapsimFiles();
    const sourceHash=crypto.createHash('sha256').update(Object.keys(mapsimFiles).sort().map(name=>`${name}\0${mapsimFiles[name]}\0`).join('')).digest('hex');
    const buildMarker=path.join(root,'tmp','_mapsim_build.sha256');
    const installedExecutables=[path.join(root,'install','sim_robot_mapsim','lib','sim_robot_mapsim','mapsim'),path.join(root,'install','lib','sim_robot_mapsim','mapsim')];
    let buildCached=false;
    try{buildCached=fs_node.readFileSync(buildMarker,'utf8').trim()===sourceHash&&installedExecutables.some(file=>fs_node.existsSync(file));}catch{}
    const buildReused=buildCached;
    writeMapsimPackage(s.robotKey,mapsimFiles);
    const setup = s.rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const pidFile = path.join(root, 'tmp', '_mapsim.pid');
    const logFile = path.join(root, 'tmp', '_mapsim.log');
    const workspaceSetup = path.join(root, 'install', 'setup.bash');
    const fail = (phase, result, fallback) => {
      const detail = [result?.stderr, result?.stdout].filter(Boolean).join('\n').trim().slice(-6000);
      console.error(`[MapSim] ${phase} failed for ${s.robotKey}:`, detail || fallback);
      return { ok:false, phase, error:fallback, details:detail, log:'~/tmp/_mapsim.log' };
    };

    // Build separately so a failed build cannot be hidden by the later node check.
    const buildCommand = [
      'set -e',
      `source ${quote(setup)} 2>/dev/null`,
      `cd ${quote(root)}`,
      'export CMAKE_BUILD_PARALLEL_LEVEL=1 MAKEFLAGS=-j1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1',
      `if [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = "merged" ]; then nice -n 10 colcon build --merge-install --executor sequential --parallel-workers 1 --packages-select sim_robot_mapsim; else nice -n 10 colcon build --executor sequential --parallel-workers 1 --packages-select sim_robot_mapsim; fi`,
    ].join('; ');
    if(!buildCached){
      phase='build';
      update(phase);
      const buildResult = await agentReq(s.robotKey, 'exec', { command:buildCommand, timeout:120000 }, 125000);
      if (buildResult.code !== 0) return fail('build', buildResult, 'Build MapSim ไม่สำเร็จ');
      try{fs_node.mkdirSync(path.dirname(buildMarker),{recursive:true});fs_node.writeFileSync(buildMarker,sourceHash);buildCached=true;}catch{}
    }

    // MapSim must be the only kinematic owner of /tf, /odom and /scan.
    // The default simulator publishes the same frames; leaving it alive makes
    // RViz alternate between two base_link poses (stacked models + jitter).
    // Stop only known simulation backends inside this workspace. [x] patterns
    // keep pkill from matching the shell which executes this command.
    const stopCommand = [
      `if [ -f ${quote(pidFile)} ]; then kill -9 "$(cat ${quote(pidFile)})" 2>/dev/null || true; fi`,
      `pkill -9 -f ${quote(root + '/install/.*/[m]apsim')} 2>/dev/null || true`,
      `pkill -9 -f ${quote(root + '/.*_sim_state_pub[.]py')} 2>/dev/null || true`,
      `pkill -9 -f ${quote(root + '/.*[w]heel_odom')} 2>/dev/null || true`,
      `mkdir -p ${quote(path.dirname(pidFile))}`,
      `rm -f ${quote(pidFile)}`,
    ].join('; ');
    phase='stop';
    update(phase);
    const stopResult=await agentReq(s.robotKey, 'exec', { command:stopCommand, timeout:8000 }, 10000);
    if(stopResult.code!==0)return fail('stop',stopResult,'หยุด MapSim เดิมไม่สำเร็จ');

    const startCommand = mapsimStartCommand({setup, workspaceSetup, pidFile, logFile});
    phase='start';
    update(phase);
    const startResult = await agentReq(s.robotKey, 'exec', { command:startCommand, timeout:10000 }, 12000);
    if (startResult.code !== 0) return fail('start', startResult, 'เริ่ม MapSim ไม่สำเร็จ');

    phase='verify';
    update(phase);
    const verifyCommand = [
      `source ${quote(setup)} 2>/dev/null`,
      `kill -0 "$(cat ${quote(pidFile)} 2>/dev/null)" 2>/dev/null || exit 41`,
      `timeout --signal=TERM --kill-after=2s 25s python3 -c ${quote(mapsimReadinessScript())}`,
    ].join('; ');
    const verifyResult = await agentReq(s.robotKey, 'exec', { command:verifyCommand, timeout:30000 }, 35000);
    const running = verifyResult.code === 0 && /(^|\n)\/sim_robot_mapsim($|\n)/.test(verifyResult.stdout || '');
    if (!running) {
      const logResult = await agentReq(s.robotKey, 'exec', { command:`tail -80 ${quote(logFile)} 2>/dev/null`, timeout:5000 }, 7000).catch(() => ({ stdout:'' }));
      return fail('verify', { stderr:verifyResult.stderr, stdout:[verifyResult.stdout,logResult.stdout].filter(Boolean).join('\n') }, 'MapSim ยังไม่พร้อมภายในเวลาที่กำหนด');
    }
    invalidateProjectScan(s);
    return { ok:true, running:true, buildCached:buildReused, node:'/sim_robot_mapsim', pkg:'sim_robot_mapsim', exe:'mapsim', log:'~/tmp/_mapsim.log' };
  } catch (e) {
    const labels={prepare:'เตรียม MapSim',build:'Build MapSim',stop:'หยุด MapSim เดิม',start:'เปิด MapSim',verify:'ตรวจความพร้อม MapSim'};
    return {ok:false,phase,error:e.message==='Timeout'?`${labels[phase]} ใช้เวลานานเกินกำหนด — ไฟล์แผนที่ยังบันทึกอยู่`:e.message,log:'~/tmp/_mapsim.log'};
  }
}

// Configure the in-process Navigation controller without spawning multiple
// `ros2 param set` CLI processes. MapSim watches this file and writes an ack.
app.post('/api/sim/navigation-parameters',auth,(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  try{
    let config={};
    try{config=JSON.parse(fs_node.readFileSync(path.join(wsRoot(s.robotKey),'tmp','_nav_config.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const values=Object.fromEntries(Object.entries(NavigationSettings.fields).map(([name,field])=>[name,config[field.ros]]));
    res.json({ok:true,parameters:NavigationSettings.normalize(values)});
  }catch(error){res.status(500).json({ok:false,error:'อ่านพารามิเตอร์ไม่สำเร็จ: '+error.message});}
});
app.post('/api/sim/configure-navigation',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  if(navigationRequests.has(s.robotKey))return res.status(409).json({ok:false,error:'กำลังส่งคำสั่ง Navigation กรุณารอสักครู่'});
  navigationRequests.add(s.robotKey);
  const parameters=NavigationSettings.normalize(req.body);
  const config={id:crypto.randomBytes(12).toString('hex'),nav_enabled:true,...NavigationSettings.rosConfig(parameters)};
  try{
    const root=wsRoot(s.robotKey),tmp=path.join(root,'tmp'),target=path.join(tmp,'_nav_config.json'),pending=target+'.pending',ackPath=path.join(tmp,'_nav_config_ack.json');
    fs_node.mkdirSync(tmp,{recursive:true});fs_node.writeFileSync(pending,JSON.stringify(config));fs_node.renameSync(pending,target);
    let ack=null;
    for(let attempt=0;attempt<50;attempt++){
      await new Promise(resolve=>setTimeout(resolve,60));
      try{const candidate=JSON.parse(fs_node.readFileSync(ackPath,'utf8'));if(candidate.id===config.id){ack=candidate;break;}}catch{}
    }
    if(!ack)return res.status(504).json({ok:false,error:'Navigation controller ไม่ตอบรับการตั้งค่าภายใน 3 วินาที',log:'~/tmp/_mapsim.log'});
    if(!ack.ok)return res.status(422).json({ok:false,error:ack.error||'Navigation controller ปฏิเสธการตั้งค่า'});
    res.json({ok:true,config,parameters});
  }catch(error){res.status(500).json({ok:false,error:'ตั้งค่า Navigation ไม่สำเร็จ: '+error.message});}
  finally{navigationRequests.delete(s.robotKey);}
});

// Saved-map catalog and readiness checks for the kid-friendly Navigation mode.
app.post('/api/sim/navigation-readiness', auth, async (req, res) => {
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  try{
    const root=wsRoot(s.robotKey),mapsRoot=path.join(root,'maps');
    const names=fs_node.existsSync(mapsRoot)?fs_node.readdirSync(mapsRoot,{withFileTypes:true}).filter(item=>item.isDirectory()&&/^[A-Za-z0-9_-]{1,40}$/.test(item.name)).map(item=>item.name).sort():[];
    const maps=names.map(name=>{
      const dir=path.join(mapsRoot,name),files={pgm:fs_node.existsSync(path.join(dir,'map.pgm')),yaml:fs_node.existsSync(path.join(dir,'map.yaml')),json:fs_node.existsSync(path.join(dir,'map.json'))};
      let explored=null,updatedAt=null;
      try{const data=JSON.parse(fs_node.readFileSync(path.join(dir,'map.json'),'utf8'));if(Array.isArray(data.data)&&data.data.length)explored=Math.round(data.data.filter(value=>value>=0).length/data.data.length*100);updatedAt=fs_node.statSync(path.join(dir,'map.yaml')).mtime.toISOString();}catch{}
      return{name,files,ready:files.pgm&&files.yaml&&files.json,explored,updatedAt};
    });
    const selected=String(req.body.mapName||'');const selectedMap=maps.find(map=>map.name===selected)||null;
    let runtime={checked:false,node:false,topics:[]};
    if(req.body.checkRuntime){
      const setup=s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',workspaceSetup=path.join(root,'install','setup.bash'),quote=value=>`'${String(value).replace(/'/g,`'\\''`)}'`;
      const checked=await agentReq(s.robotKey,'exec',{command:`source ${quote(setup)} 2>/dev/null; source ${quote(workspaceSetup)} 2>/dev/null; echo __NODES__; ros2 node list 2>/dev/null; echo __TOPICS__; ros2 topic list 2>/dev/null`,timeout:8000},10000).catch(()=>({stdout:''}));
      const output=checked.stdout||'',topicText=output.split('__TOPICS__')[1]||'';runtime={checked:true,node:output.split('__TOPICS__')[0].includes('/sim_robot_mapsim'),topics:topicText.split(/\s+/).filter(Boolean)};
    }
    const requiredTopics=['/map','/scan','/tf','/odom','/goal_pose','/plan'],topicsReady=requiredTopics.every(topic=>runtime.topics.includes(topic));
    const checks=[
      {id:'saved_map',label:'มีแผนที่ที่บันทึกแล้ว',state:maps.some(map=>map.ready)?'ready':'error',detail:maps.length?'พบ '+maps.length+' แผนที่':'กลับไปโหมดเก็บแผนที่แล้วกด Save Map'},
      {id:'selected_map',label:'เลือกแผนที่สำหรับ Navigation',state:selectedMap?.ready?'ready':'error',detail:selectedMap?.ready?selectedMap.name:'กรุณาเลือกแผนที่จากรายการ'},
      {id:'mapsim',label:'Navigation controller',state:fs_node.existsSync(path.join(root,'src','sim_robot_mapsim','package.xml'))?'ready':'auto',detail:'ระบบจะ build และเปิด /sim_robot_mapsim ให้อัตโนมัติ'},
      {id:'robot_model',label:'Robot Model และ TF',state:fs_node.existsSync(path.join(root,'src','sim_robot_tf','urdf','robot.urdf'))?'ready':'warning',detail:fs_node.existsSync(path.join(root,'src','sim_robot_tf','urdf','robot.urdf'))?'พบโมเดลจาก Robot Config':'ยังไม่มี Robot Config — ใช้โมเดลสำรองได้'},
      {id:'runtime',label:'Navigation node',state:runtime.checked?(runtime.node?'ready':'error'):'auto',detail:runtime.node?'/sim_robot_mapsim กำลังทำงาน':'ระบบจะ build และเริ่ม node ให้อัตโนมัติ'},
      {id:'topics',label:'ROS Topics ที่ต้องใช้',state:runtime.checked?(topicsReady?'ready':'error'):'auto',detail:topicsReady?'พบ /map, /scan, /tf, /odom, /goal_pose และ /plan ครบ':'Topics จะเปิดเมื่อกดเริ่ม Navigation'},
    ];
    res.json({ok:true,maps,selectedMap,ready:Boolean(selectedMap?.ready)&&(!runtime.checked||(runtime.node&&topicsReady)),mapReady:Boolean(selectedMap?.ready),runtime,checks,commands:['ros2 run sim_robot_mapsim mapsim','ros2 topic pub /goal_pose geometry_msgs/msg/PoseStamped ...']});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/sim/select-navigation-map', auth, (req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  const mapName=String(req.body.mapName||'').trim();if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'กรุณาเลือกแผนที่ที่ถูกต้อง'});
  try{
    const root=wsRoot(s.robotKey),dir=path.join(root,'maps',mapName);
    for(const file of ['map.pgm','map.yaml','map.json'])if(!fs_node.existsSync(path.join(dir,file)))return res.status(400).json({ok:false,error:`แผนที่ ${mapName} ขาดไฟล์ ${file}`});
    fs_node.mkdirSync(path.join(root,'tmp'),{recursive:true});fs_node.writeFileSync(path.join(root,'tmp','_nav_map_selection'),mapName);
    res.json({ok:true,mapName,yaml:`~/maps/${mapName}/map.yaml`});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

// Reliable browser-to-MapSim goal handoff. A one-shot ROS CLI publisher can
// exit before DDS discovery on slower machines, so MapSim acknowledges this
// workspace-scoped command file before the UI reports success.
app.post('/api/sim/navigation-goal', auth, async (req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  const cancel=req.body.cancel===true,x=cancel?0:Number(req.body.x),y=cancel?0:Number(req.body.y),yaw=cancel?0:Number(req.body.yaw||0);
  if(![x,y,yaw].every(Number.isFinite)||Math.abs(x)>10000||Math.abs(y)>10000)return res.status(400).json({ok:false,error:'พิกัดจุดหมายไม่ถูกต้อง'});
  if(navigationRequests.has(s.robotKey))return res.status(409).json({ok:false,error:'กำลังส่งคำสั่ง Navigation กรุณารอสักครู่'});
  navigationRequests.add(s.robotKey);
  try{
    const root=wsRoot(s.robotKey),tmpDir=path.join(root,'tmp'),id=crypto.randomBytes(12).toString('hex');
    const goalPath=path.join(tmpDir,'_nav_goal.json'),pendingPath=path.join(tmpDir,`_nav_goal.${id}.tmp`),ackPath=path.join(tmpDir,'_nav_goal_ack.json');
    fs_node.mkdirSync(tmpDir,{recursive:true});fs_node.writeFileSync(pendingPath,JSON.stringify({id,x,y,yaw,cancel,createdAt:Date.now()}));fs_node.renameSync(pendingPath,goalPath);
    let ack=null;
    for(let attempt=0;attempt<100;attempt++){
      await new Promise(resolve=>setTimeout(resolve,50));
      try{const candidate=JSON.parse(fs_node.readFileSync(ackPath,'utf8'));if(candidate.id===id){ack=candidate;break;}}catch{}
    }
    if(!ack)return res.status(504).json({ok:false,error:'Navigation controller ไม่ตอบรับ Goal กรุณากดเริ่ม Navigation ใหม่'});
    if(!ack.accepted)return res.status(422).json({ok:false,error:ack.error||'ไม่พบเส้นทางไปยังจุดหมายบน Saved Map'});
    invalidateProjectScan(s);
    res.json({ok:true,accepted:true,id,x,y,yaw});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
  finally{navigationRequests.delete(s.robotKey);}
});

// This action is called only after Robot Playground has successfully started
// the Navigation runtime and passed its readiness check.
app.post('/api/sim/start-navigation-mission',auth,(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  const mapName=String(req.body.mapName||'');
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'ข้อมูลภารกิจ Navigation ไม่ถูกต้อง'});
  try{
    const root=wsRoot(s.robotKey),mapping=readSimulationWizardProgress(root).completed.mapping;
    if(!mapping?.completedAt||mapping.mapName!==mapName)return res.status(409).json({ok:false,error:'ต้องกด Save Map ใน Robot Playground ก่อนเริ่มภารกิจ Navigation'});
    try{if(!fs_node.statSync(path.join(root,'maps',mapName)).isDirectory())throw new Error('not a directory');}
    catch{return res.status(409).json({ok:false,error:`ยังไม่พบโฟลเดอร์ maps/${mapName} กรุณากด Save Map ใหม่`});}
    completeSimulationWizardNavigation(root,mapName);invalidateProjectScan(s);invalidateRobotProgress(s);
    res.json({ok:true,completed:true,mapName});
  }catch(error){res.status(409).json({ok:false,error:'บันทึกการเริ่ม Navigation ไม่สำเร็จ: '+error.message});}
});

// Save the progressively discovered /slam_map as a Nav2-compatible PGM/YAML
// and build the generated sim_robot_nav_map package for immediate reuse.
function cleanupStaleSimMapBuilds(root){
  let removed=0;
  for(const parentName of ['build','install']){
    const parent=path.join(root,parentName);let entries=[];
    try{entries=fs_node.readdirSync(parent,{withFileTypes:true});}catch{continue;}
    for(const entry of entries){
      if(!entry.isDirectory()||!/^sim_robot_nav_map[.]stale[.]\d+$/.test(entry.name))continue;
      fs_node.rmSync(path.join(parent,entry.name),{recursive:true,force:true});removed++;
    }
  }
  return removed;
}

app.post('/api/sim/save-slam-map', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  if (!isSim(s.robotKey)) return res.status(400).json({ ok:false, error:'Available for Sim only' });
  const mapName = String(req.body.mapName || 'slam_map').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(mapName)) return res.status(400).json({ ok:false, error:'ชื่อแผนที่ใช้ได้เฉพาะ a-z, 0-9, _ และ -' });
  try{
    const agent=agents.get(s.robotKey);
    const job=mapsimQueue.enqueue(s.robotKey,'slam:'+mapName,async update=>{
      if(sessions.get(req.body.sessionId)!==s||agents.get(s.robotKey)!==agent||!agent)return {ok:false,error:'Simulation disconnected'};
      return saveSlamMapJob(s,mapName,update);
    });
    if(req.body.async===true)return res.status(202).json({ok:true,job:mapsimQueue.status(job)});
    const result=await job.done;return res.status(result.ok?200:500).json(result);
  }catch(error){return res.status(409).json({ok:false,error:error.message});}
});

async function saveSlamMapJob(s,mapName,update){
  try {
    update('save');
    const root = wsRoot(s.robotKey);
    const setup = s.rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const workspaceSetup = path.join(root, 'install', 'setup.bash');
    const nameFile = path.join(root, 'tmp', '_slam_map_name');
    const serviceCommand = [
      'set -e',
      `mkdir -p ${quote(path.dirname(nameFile))}`,
      `printf '%s' ${quote(mapName)} > ${quote(nameFile)}`,
      `source ${quote(setup)} 2>/dev/null`,
      `source ${quote(workspaceSetup)} 2>/dev/null`,
      `ros2 service call /save_slam_map std_srvs/srv/Trigger '{}'`,
    ].join('; ');
    const saved = await agentReq(s.robotKey, 'exec', { command:serviceCommand, timeout:20000 }, 23000);
    if (saved.code !== 0 || !/success=True/.test((saved.stdout || '') + (saved.stderr || ''))) {
      return { ok:false, error:[saved.stderr,saved.stdout].filter(Boolean).join('\n').trim() || 'บันทึก SLAM map ไม่สำเร็จ' };
    }
    const packageDir = path.join(root, 'src', 'sim_robot_nav_map');
    const verifyCommand = `test -s ${quote(path.join(root,'maps',mapName,'map.pgm'))} && test -s ${quote(path.join(root,'maps',mapName,'map.yaml'))} && test -s ${quote(path.join(packageDir,'package.xml'))}`;
    const verified = await agentReq(s.robotKey, 'exec', { command:verifyCommand, timeout:5000 }, 7000);
    if (verified.code !== 0) return { ok:false, error:'สร้างไฟล์ Map/Package ไม่ครบ' };
    const buildCommand = [
      'set -e', `source ${quote(setup)} 2>/dev/null`, `cd ${quote(root)}`,
      // Archive once only when a legacy ament_cmake cache is actually present.
      // Moving a healthy ament_python build on every Save created hundreds of
      // `.stale.*` folders and forced an unnecessary cold rebuild.
      `if [ -f ${quote(path.join(root,'build','sim_robot_nav_map','CMakeCache.txt'))} ]; then for old in ${quote(path.join(root,'build','sim_robot_nav_map'))} ${quote(path.join(root,'install','sim_robot_nav_map'))}; do [ ! -e "$old" ] || mv "$old" "$old.stale.$(date +%s%N)"; done; fi`,
      'export CMAKE_BUILD_PARALLEL_LEVEL=1 MAKEFLAGS=-j1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1',
      `if [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = "merged" ]; then nice -n 10 colcon build --merge-install --executor sequential --parallel-workers 1 --packages-select sim_robot_nav_map; else nice -n 10 colcon build --executor sequential --parallel-workers 1 --packages-select sim_robot_nav_map; fi`,
    ].join('; ');
    update('build');
    const built = await agentReq(s.robotKey, 'exec', { command:buildCommand, timeout:120000 }, 125000);
    if (built.code !== 0) return { ok:false, error:[built.stderr,built.stdout].filter(Boolean).join('\n').trim().slice(-6000) || 'Build sim_robot_nav_map ไม่สำเร็จ' };
    const removedStaleArtifacts=cleanupStaleSimMapBuilds(root);
    completeSimulationWizardMapping(root,mapName);
    invalidateProjectScan(s);
    invalidateRobotProgress(s);
    return { ok:true, wizardCompleted:true, mapName, removedStaleArtifacts, mapDir:`~/maps/${mapName}`, packageDir:'~/src/sim_robot_nav_map', yaml:`~/maps/${mapName}/map.yaml`, launch:'ros2 launch sim_robot_nav_map map_server.launch.py' };
  } catch (e) { return { ok:false, error:e.message }; }
}

function resolveNavigationMap(root,requested=''){
  const isReady=name=>/^[A-Za-z0-9_-]{1,40}$/.test(name)&&['map.pgm','map.yaml'].every(file=>fs_node.existsSync(path.join(root,'maps',name,file)));
  if(isReady(requested))return requested;
  try{const selected=fs_node.readFileSync(path.join(root,'tmp','_nav_map_selection'),'utf8').trim();if(isReady(selected))return selected;}catch{}
  const mapsRoot=path.join(root,'maps');if(!fs_node.existsSync(mapsRoot))return'';
  return fs_node.readdirSync(mapsRoot,{withFileTypes:true}).filter(item=>item.isDirectory()&&isReady(item.name)).map(item=>({name:item.name,time:fs_node.statSync(path.join(mapsRoot,item.name,'map.yaml')).mtimeMs})).sort((a,b)=>b.time-a.time)[0]?.name||'';
}

// Entering Navigation creates the real-robot Nav2 package immediately. If a
// map was not selected yet, the newest valid saved map is used as a template.
app.post('/api/sim/prepare-navigation-package',auth,(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  try{
    const root=wsRoot(s.robotKey),mapName=resolveNavigationMap(root,String(req.body.mapName||''));
    if(!mapName)return res.status(409).json({ok:false,error:'ยังไม่มี Saved Map — เก็บและ Save Map ก่อนสร้าง Navigation package'});
    const generated=writeNavigationPackage(root,mapName,req.body.parameters||{});invalidateProjectScan(s);
    res.json({ok:true,mapName,packageName:generated.packageName,packageDir:'~/src/'+generated.packageName,parameters:generated.parameters});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

// Build the Nav2 package, then download the complete ROS workspace source:
// every src package, maps, robot config, installer and installation guide.
app.post('/api/sim/export-navigation-project',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  const mapName=String(req.body.mapName||'').trim();
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'กรุณาเลือก Saved Map ก่อน Export'});
  try{
    const root=wsRoot(s.robotKey),generated=writeNavigationPackage(root,mapName,req.body.parameters||{}),setup=s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';writeProjectInstaller(root,mapName);
    const quote=value=>`'${String(value).replace(/'/g,`'\\''`)}'`,exportsDir=path.join(root,'exports'),archive=path.join(exportsDir,`mecha_rayong_project_${mapName}.zip`);
    fs_node.mkdirSync(exportsDir,{recursive:true});if(fs_node.existsSync(archive))fs_node.unlinkSync(archive);
    const command=[
      'set -e',`source ${quote(setup)} 2>/dev/null`,`cd ${quote(root)}`,
      `if [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = "merged" ]; then colcon build --merge-install --packages-select ${generated.packageName}; else colcon build --packages-select ${generated.packageName}; fi`,
      `zip -qr ${quote(archive)} src maps install_project.sh install_lidar_driver.sh INSTALL_PROJECT.md${fs_node.existsSync(path.join(root,'map.json'))?' map.json':''} -x '*/build/*' '*/install/*' '*/log/*' '*/__pycache__/*'`,
    ].join('; ');
    const built=await agentReq(s.robotKey,'exec',{command,timeout:120000},125000);
    if(built.code!==0||!fs_node.existsSync(archive))return res.status(500).json({ok:false,error:[built.stderr,built.stdout].filter(Boolean).join('\n').trim().slice(-6000)||'สร้าง Navigation package ไม่สำเร็จ'});
    invalidateProjectScan(s);
    res.download(archive,path.basename(archive));
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/exec',auth,async(req,res)=>{
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(typeof req.body.command!=='string'||!req.body.command.trim()) return res.status(400).json({ok:false,error:'Command required'});
  const requestedTimeout=Number(req.body.timeout),timeout=Number.isFinite(requestedTimeout)?Math.max(1000,Math.min(300000,Math.trunc(requestedTimeout))):15000;
  try{const d=await agentReq(s.robotKey,'exec',{command:req.body.command,timeout},timeout+5000);res.json({ok:true,...d});}
  catch(e){res.json({ok:false,error:e.message});}
});

// One source of truth for every UI that selects a USB/UART serial device.
// Discovery runs on the Robot (not the cloud host), and returns permission
// details so a present-but-inaccessible device is never reported as missing.
async function discoverRobotSerialPorts(session,includeDiagnostics=false){
  const python=`import glob,grp,json,os,pwd,re,stat
patterns=['/dev/ttyUSB*','/dev/ttyACM*','/dev/ttyAMA*','/dev/ttyTHS*','/dev/ttyS*','/dev/rfcomm*','/dev/serial[0-9]*']
def read_text(path):
 try:
  with open(path) as f: return f.read().replace(chr(0),'').strip()
 except OSError: return ''
board=read_text('/proc/device-tree/model')
pi5='Raspberry Pi 5' in board
console_ports={os.path.realpath('/dev/'+token.split('=',1)[1].split(',')[0]) for token in read_text('/proc/cmdline').split() if token.startswith('console=')}
by_real={}
for link in glob.glob('/dev/serial/by-id/*')+glob.glob('/dev/serial[0-9]*'):
 try: by_real.setdefault(os.path.realpath(link),[]).append(link)
 except OSError: pass
paths=set()
for pattern in patterns:
 for value in glob.glob(pattern):
  try:
   if stat.S_ISCHR(os.stat(value).st_mode): paths.add(os.path.realpath(value))
  except OSError: pass
def natural(value):
 name=os.path.basename(value); families=['ttyUSB','ttyACM','ttyAMA','ttyTHS','rfcomm','ttyS']
 family=next((index for index,prefix in enumerate(families) if name.startswith(prefix)),len(families))
 return [family]+[int(part) if part.isdigit() else part.lower() for part in re.split(r'(\\d+)',name)]
ports=[]
for value in sorted(paths,key=natural):
 try:
  info=os.stat(value); aliases=sorted(by_real.get(os.path.realpath(value),[]))
  try: owner=pwd.getpwuid(info.st_uid).pw_name
  except KeyError: owner=str(info.st_uid)
  try: group=grp.getgrgid(info.st_gid).gr_name
  except KeyError: group=str(info.st_gid)
  name=os.path.basename(value)
  kind='debug-uart' if pi5 and name=='ttyAMA10' else 'uart' if re.match(r'tty(?:AMA|THS|S)[0-9]+$',name) else 'usb' if re.match(r'tty(?:USB|ACM)[0-9]+$',name) else 'serial'
  label=('Pi 5 debug UART (not GPIO14/15)' if kind=='debug-uart' else 'UART / GPIO' if kind=='uart' else name)
  if aliases: label+=' · '+', '.join(aliases)
  if value in console_ports: label+=' · Linux console: disable before controller use'
  ports.append({'path':value,'realPath':value,'stablePath':aliases[0] if aliases else '', 'aliases':aliases,'kind':kind,'consoleInUse':value in console_ports,
   'label':label,'connected':True,
   'readable':os.access(value,os.R_OK),'writable':os.access(value,os.W_OK),
   'accessible':os.access(value,os.R_OK|os.W_OK),'owner':owner,
   'group':group,'mode':oct(stat.S_IMODE(info.st_mode))})
 except OSError: pass
hint=''
if pi5 and not any(p['path']=='/dev/ttyAMA0' for p in ports):
 hint='Pi 5: ไม่พบ UART0 บน GPIO14/15 · ตรวจการเปิด UART/overlay uart0-pi5 ใน /boot/firmware/config.txt และ reboot; serial0 อาจเป็นช่อง debug ไม่ใช่ GPIO'
elif not ports:
 hint='ไม่พบ USB/UART ที่ระบบเปิดใช้งาน · หากต่อผ่าน GPIO ให้เปิด UART ใน boot config และปิด serial console ของพอร์ตที่ใช้ก่อน reboot'
print('ROSIDE_SERIAL_PORTS='+json.dumps(ports,separators=(',',':')))
print('ROSIDE_SERIAL_DIAGNOSTICS='+json.dumps({'board':board,'uartHint':hint},separators=(',',':')))`;
  const encoded=Buffer.from(python).toString('base64');
  const result=await agentReq(session.robotKey,'exec',{command:`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`,timeout:10000},15000);
  const marker=String(result.stdout||'').split(/\r?\n/).find(line=>line.startsWith('ROSIDE_SERIAL_PORTS='));
  if(result.code!==0||!marker)throw new Error(result.stderr||'Robot ไม่สามารถตรวจสอบ COM port ได้');
  const ports=JSON.parse(marker.slice('ROSIDE_SERIAL_PORTS='.length));
  const list=Array.isArray(ports)?ports:[];
  const diagnostic=String(result.stdout||'').split(/\r?\n/).find(line=>line.startsWith('ROSIDE_SERIAL_DIAGNOSTICS='));
  return includeDiagnostics?{ports:list,...(diagnostic?JSON.parse(diagnostic.slice('ROSIDE_SERIAL_DIAGNOSTICS='.length)):{})}:list;
}

app.post('/api/serial/ports',auth,async(req,res)=>{
  const session=getOwnedSess(req);if(!session)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(session.robotKey))return res.json({ok:true,ports:[]});
  try{res.json({ok:true,...await discoverRobotSerialPorts(session,true)});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/serial/prepare',auth,async(req,res)=>{
  const session=getOwnedSess(req);if(!session)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(session.robotKey))return res.status(400).json({ok:false,error:'Serial port ใช้สำหรับหุ่นยนต์จริง'});
  try{res.json(await ensureRobotSerialAccess(session,String(req.body.port||''),req.body.sudoPassword));}
  catch(error){res.status(error.status||500).json({ok:false,error:error.message,portState:error.portState||'permission',requiresSudo:!!error.requiresSudo});}
});

// ── Kill a running node by package/executable (reliable, scoped to the workspace) ──
// For SIM: kill by the real node binary path under this sim's workspace root
//          (merged layout: <root>/install/lib/<pkg>/<exe>; isolated: <root>/install/<pkg>/lib/<pkg>/<exe>).
//          This is robust because `ros2 run` does exec() so the cmdline is the binary path,
//          not "ros2 run ..." — a bare `pkill -f "ros2 run"` would never match the running process.
// For REAL robot: pkill by the binary path + ros2 node kill (ROS-native, scoped to the robot).
app.post('/api/kill-node',auth,async(req,res)=>{
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  const {pkg, exe} = req.body;
  if(!pkg||!exe) return res.json({ok:false,error:'pkg and exe required'});
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(pkg)||!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(exe)) return res.status(400).json({ok:false,error:'Invalid package or executable name'});
  try{
    if(isSim(s.robotKey)){
      const root = wsRoot(s.robotKey);
      // รูปแบบ path ของ node จริง (ros2 run ทำ exec เปลี่ยน cmdline เป็น path นี้):
      //   ament_python : <root>/install/bin/<exe> (merged) | <root>/install/<pkg>/bin/<exe> (isolated)
      //   ament_cmake  : <root>/install/lib/<pkg>/<exe> (merged) | <root>/install/<pkg>/lib/<pkg>/<exe> (isolated)
      // เจาะจงเฉพาะ sim นี้ (root ต่างกันต่อหุ่น) → ไม่ไปฆ่า node ของ sim อื่น
      // จับทั้ง binary ใน install/ (user รันผ่าน ros2 run) และ src/.../scripts/ (backend auto-spawn)
      // กัน node ซ้ำซ้อนโพสต์ /tf /odom ซ้ำกัน → rviz กระพริบ 2 ตำแหน่ง
      const pat = `${root}/(install/(lib/${pkg}/|${pkg}/lib/${pkg}/|bin/|${pkg}/bin/)|src/[^ ]*/scripts/)${exe}`;
      // ฆ่า process จริงด้วย PID (ชัวร์ 100%)
      await agentReq(s.robotKey,'exec',{command:`pkill -9 -f "${pat}" 2>/dev/null; true`,timeout:8000});
      // ตรวจสอบว่า node ตายจริง (ดูจาก process ไม่ใช่แค่ node name)
      const v = await agentReq(s.robotKey,'exec',{command:`ps -eo pid,cmd | grep -E "${pat}" | grep -v grep | wc -l`,timeout:5000}).catch(()=>({stdout:'1'}));
      const stillUp = parseInt((v.stdout||'0').trim()) > 0;
      return res.json({ok:true, killed:!stillUp, stillUp});
    } else {
      const src = s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
      await agentReq(s.robotKey,'exec',{command:`bash -lc "source ${src} 2>/dev/null; pkill -9 -f 'lib/${pkg}/${exe}' 2>/dev/null; ros2 node kill /${exe} 2>/dev/null; true"`,timeout:8000});
      return res.json({ok:true});
    }
  }catch(e){res.json({ok:false,error:e.message});}
});

function validateSimMapData(data) {
  const finiteList = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  if (!data || typeof data !== 'object') return 'ไม่พบข้อมูลแผนที่';
  if (!finiteList(data.bounds, 4) || data.bounds[0] >= data.bounds[2] || data.bounds[1] >= data.bounds[3]) return 'ขอบเขตห้องไม่ถูกต้อง';
  const [minX,minY,maxX,maxY]=data.bounds,width=maxX-minX,height=maxY-minY;
  if(data.bounds.some(value=>Math.abs(value)>10000)||width>100||height>100||Math.ceil(width/.1)*Math.ceil(height/.1)>400000)return 'แผนที่ใหญ่เกินขีดจำกัดของ Simulation';
  if (!finiteList(data.start, 2)) return 'ไม่มีจุดเริ่มหุ่นที่ถูกต้อง';
  const robotRadius=.24;
  if (data.start[0] < minX+robotRadius || data.start[0] > maxX-robotRadius || data.start[1] < minY+robotRadius || data.start[1] > maxY-robotRadius) return 'จุดเริ่มหุ่นชิดหรือนอกขอบเขตแผนที่';
  // One editable object contributes multiple collision edges (24 for a round
  // object, 16 for table legs). Keep this limit separate from the object count.
  if (!Array.isArray(data.walls) || data.walls.length>16384 || data.walls.some(wall => !finiteList(wall, 4)||wall.some(value=>Math.abs(value)>10000)||Math.hypot(wall[2]-wall[0],wall[3]-wall[1])<1e-6)) return 'ข้อมูลเส้นขอบสิ่งกีดขวางไม่ถูกต้องหรือมีจำนวนมากเกินไป';
  // Match the Python grid's expansion around walls, not just editor bounds.
  let bx=minX,by=minY,ex=maxX,ey=maxY;
  for(const [x1,y1,x2,y2] of data.walls){bx=Math.min(bx,x1-.1,x2-.1);by=Math.min(by,y1-.1,y2-.1);ex=Math.max(ex,x1+.1,x2+.1);ey=Math.max(ey,y1+.1,y2+.1);}
  if(ex-bx>100||ey-by>100||Math.ceil((ex-bx)/.1)*Math.ceil((ey-by)/.1)>400000)return 'พื้นที่จริงรวมกำแพงนอกห้องใหญ่เกินขีดจำกัดของ Simulation';
  if(data.startPose?.yaw!==undefined&&!Number.isFinite(data.startPose.yaw))return 'มุมเริ่มหุ่นไม่ถูกต้อง';
  const pointSegmentDistance=(px,py,[x1,y1,x2,y2])=>{const dx=x2-x1,dy=y2-y1,length2=dx*dx+dy*dy;if(length2<1e-12)return Math.hypot(px-x1,py-y1);const t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/length2));return Math.hypot(px-(x1+t*dx),py-(y1+t*dy));};
  if(data.walls.some(wall=>pointSegmentDistance(data.start[0],data.start[1],wall)<robotRadius))return 'จุดเริ่มหุ่นทับกำแพงหรือสิ่งกีดขวาง';
  if(data.objects!==undefined&&(!Array.isArray(data.objects)||data.objects.length>512))return 'จำนวนวัตถุในแผนที่มากเกินไป';
  return null;
}

function inspectSimMapCapability(robotKey) {
  const mapFile = path.join(wsRoot(robotKey), 'map.json');
  const base = { id:'lidar', detected:false, count:0, files:[], mapCheck:true };
  if (!fs_node.existsSync(mapFile)) return { ...base, validationMessage:'ยังไม่มี map.json — เปิด Map Editor แล้วบันทึกแผนที่' };
  try {
    if (fs_node.statSync(mapFile).size > 2 * 1024 * 1024) return { ...base, validationMessage:'map.json มีขนาดใหญ่เกิน 2 MB' };
    const data = JSON.parse(fs_node.readFileSync(mapFile, 'utf8'));
    const validationError=validateSimMapData(data);
    if(validationError) return { ...base, validationMessage:'map.json ไม่พร้อม: ' + validationError };
    return { ...base, detected:true, count:1, files:['map.json'], validationMessage:'map.json พร้อมใช้กับ Sim' };
  } catch (error) {
    return { ...base, validationMessage:'อ่าน map.json ไม่ได้: ' + error.message };
  }
}

function getProjectSummary(sessionId, session) {
  const cacheKey=session.robotKey,cached=projectScanCache.get(cacheKey);
  if(cached&&cached.expiresAt>Date.now()) return cached.promise;
  const workspace=isSim(session.robotKey)?wsRoot(session.robotKey):(session.workspace||'~/ros2_ws');
  const script64=Buffer.from(buildProjectScanScript(workspace),'utf8').toString('base64');
  const promise=agentReq(session.robotKey,'exec',{
    command:`python3 -c "import base64;exec(base64.b64decode('${script64}'))"`,
    timeout:15000,
  }).then(async result=>{
    const summary=parseProjectScanOutput(result.stdout);
    if(isSim(session.robotKey)) {
      const mapCapability=inspectSimMapCapability(session.robotKey);
      const index=summary.capabilities.findIndex(item=>item.id==='lidar');
      if(index>=0) summary.capabilities[index]=mapCapability;
      else summary.capabilities.push(mapCapability);
      for(const missionCapability of inspectSimulationMissionArtifacts(wsRoot(session.robotKey))) {
        const missionIndex=summary.capabilities.findIndex(item=>item.id===missionCapability.id);
        if(missionIndex>=0) summary.capabilities[missionIndex]=missionCapability;
        else summary.capabilities.push(missionCapability);
      }
    } else {
      const system=await inspectRealRobotSystem(session.robotKey);
      summary.capabilities.push(system);
      syncRealRobotRosInfo(session.robotKey,system);
    }
    return summary;
  }).catch(error=>({
    ok:false,
    workspace,
    error:error.message,
    fileCount:0,
    packageCount:0,
    packages:[],
    languages:[],
    capabilities:[],
  }));
  projectScanCache.set(cacheKey,{expiresAt:Date.now()+30000,promise});
  return promise;
}

async function installRealRobotSystem(session,password=''){
  const current=await inspectRealRobotSystem(session.robotKey);
  if(current.detected)return {system:current,rosInfo:syncRealRobotRosInfo(session.robotKey,current),output:'ระบบพร้อมใช้งานอยู่แล้ว ไม่ต้องติดตั้งเพิ่ม'};
  if(!current.systemCheck?.canInstallRos){
    const error=new Error(`เครื่องนี้ไม่รองรับการติดตั้ง ROS 2 อัตโนมัติ: ${current.validationMessage}`);error.status=409;throw error;
  }
  const distro=current.systemCheck.targetDistro;
  const running=realSystemInstallJobs.get(session.robotKey);
  if(running)return running;
  const job=(async()=>{
    const installed=await lidarSudoExec(session,buildRealSystemInstallCommand(distro),password,300000);
    const rosdep=await agentReq(session.robotKey,'exec',{command:`rosdep update --rosdistro ${distro}`,timeout:180000},185000).catch(error=>({stdout:'',stderr:error.message,code:1}));
    const agent=agents.get(session.robotKey);
    if(agent){delete agent.rosInfo;delete agent.rosInfoPromise;}
    projectScanCache.delete(session.robotKey);robotProgressCache.delete(session.robotKey);dashboardRuntimeCache.delete(session.robotKey);
    const system=await inspectRealRobotSystem(session.robotKey);
    const rosInfo=syncRealRobotRosInfo(session.robotKey,system);
    return {system,rosInfo,output:[installed.stdout,installed.stderr,rosdep.stdout,rosdep.stderr].filter(Boolean).join('\n').slice(-12000)};
  })();
  realSystemInstallJobs.set(session.robotKey,job);
  try{return await job;}finally{if(realSystemInstallJobs.get(session.robotKey)===job)realSystemInstallJobs.delete(session.robotKey);}
}

function getDashboardRuntime(session){
  const key=session.robotKey,now=Date.now(),cached=dashboardRuntimeCache.get(key);
  if(cached&&cached.expiresAt>now)return cached.promise;
  if(isSim(key)){
    const setup=session.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
    const graph=agentReq(key,'exec',{command:`source ${shellQuote(setup)} 2>/dev/null; echo NODES_START; timeout 3 ros2 node list 2>/dev/null || true; echo NODES_END; echo TOPICS_START; timeout 3 ros2 topic list -t 2>/dev/null || true; echo TOPICS_END`,timeout:7000},9000).catch(()=>({stdout:''}));
    const clusterId=clusterIdForSim(key);
    const hostPromise=clusterId===1?getSimHostStatus():clusterBus.request(clusterId,'host_status',{robotKey:key,masterRoot:wsRoot(key)},10000);
    const promise=Promise.all([hostPromise,graph]).then(([host,ros])=>({metrics:{stdout:host.stdout+ros.stdout},processes:clusterId===1?{stdout:scopedSimProcesses(host,wsRoot(key))}:host.processes}));
    const entry={expiresAt:Infinity,promise};dashboardRuntimeCache.set(key,entry);
    promise.then(()=>{entry.expiresAt=Date.now()+10000;},()=>{if(dashboardRuntimeCache.get(key)===entry)dashboardRuntimeCache.delete(key);});
    return promise;
  }
  const src=session.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
  const metricsPromise=agentReq(key,'exec',{command:`bash -lc "source ${src} 2>/dev/null; echo CPU=$(top -bn1|grep 'Cpu(s)'|awk '{print $2}'); echo MEM=$(free -m|awk 'NR==2{print $3\" \"$2}'); echo DISK=$(df -h /|awk 'NR==2{print $3\" \"$2\" \"$5}'); echo UPTIME=$(uptime -p); echo NODES_START; timeout 3 ros2 node list 2>/dev/null || true; echo NODES_END; echo TOPICS_START; timeout 3 ros2 topic list -t 2>/dev/null || true; echo TOPICS_END"`,timeout:7000},9000).catch(()=>({stdout:''}));
  const root=isSim(key)?wsRoot(key):(session.workspace||'~/ros2_ws'),psPat=isSim(key)?`${root}/install/`:'/install/.*/lib/',psCmd=`ps -eo pid,cmd | grep -iE "ros2 run|ros2 launch|${psPat}" | grep -vE "grep|ros2ide|api/exec|script -qec"`;
  const processesPromise=agentReq(key,'exec',{command:psCmd,timeout:4000},6000).catch(()=>({stdout:''}));
  const promise=Promise.all([metricsPromise,processesPromise]).then(([metrics,processes])=>({metrics,processes}));
  const entry={expiresAt:Number.POSITIVE_INFINITY,promise};dashboardRuntimeCache.set(key,entry);
  // The dashboard refreshes every 2.5 s. Keep a successful ROS graph snapshot
  // for 5 s so concurrent tabs share it instead of running top/ros2 probes on
  // almost every poll.
  promise.then(()=>{if(dashboardRuntimeCache.get(key)===entry)entry.expiresAt=Date.now()+5000;},()=>{if(dashboardRuntimeCache.get(key)===entry)dashboardRuntimeCache.delete(key);});
  return promise;
}

// โหลดเฉพาะผลสแกนภารกิจต่อจาก dashboard ที่ตอบสถานะระบบแบบรวดเร็ว
// ทำให้ browser รอ promise ชุดเดิม ไม่ต้องสั่ง ROS graph/metrics ซ้ำทุกครั้ง
app.post('/api/dashboard/project',auth,async(req,res)=>{
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  try{
    const project=await getProjectSummary(req.body.sessionId,s);
    res.json(project);
  }catch(error){
    res.json({ok:false,error:error.message});
  }
});

app.post('/api/real/system-check',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'ภารกิจตรวจระบบใช้สำหรับหุ่นยนต์จริงเท่านั้น'});
  try{
    if(req.body.install===true){
      const result=await installRealRobotSystem(s,req.body.sudoPassword);
      return res.json({ok:true,installed:true,...result});
    }
    const system=await inspectRealRobotSystem(s.robotKey);
    const rosInfo=syncRealRobotRosInfo(s.robotKey,system);
    projectScanCache.delete(s.robotKey);robotProgressCache.delete(s.robotKey);
    res.json({ok:true,installed:false,system,rosInfo});
  }catch(error){res.status(error.status||500).json({ok:false,error:error.message,requiresSudo:error.requiresSudo===true,commandTimedOut:error.commandTimedOut===true});}
});

app.post('/api/dashboard',auth,async(req,res)=>{
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  try{
    if(req.body.forceProjectScan===true){projectScanCache.delete(s.robotKey);dashboardRuntimeCache.delete(s.robotKey);}
    const projectPromise=getProjectSummary(req.body.sessionId,s);
    const workspace=isSim(s.robotKey)?wsRoot(s.robotKey):(s.workspace||'~/ros2_ws');
    const projectViewPromise=Promise.race([projectPromise,new Promise(resolve=>setTimeout(()=>resolve({ok:true,pending:true,workspace}),800))]);
    const [{metrics:d,processes:pr},project]=await Promise.all([getDashboardRuntime(s),projectViewPromise]);
    const o=d.stdout||'';
    const cm=o.match(/CPU=([\d.]+)/),mm=o.match(/MEM=(\d+) (\d+)/),dm=o.match(/DISK=(\S+) (\S+) (\S+)/),um=o.match(/UPTIME=(.+)/);
    const nr=o.match(/NODES_START\n([\s\S]*?)NODES_END/),tr=o.match(/TOPICS_START\n([\s\S]*?)TOPICS_END/);
    const nodes=(nr?nr[1].trim().split('\n').filter(Boolean):[]).map(n=>({name:n,publishers:[],subscribers:[]}));
    const topics=(tr?tr[1].trim().split('\n').filter(Boolean):[]).map(l=>{const m=l.match(/^(\S+)\s+\[(.+)\]$/);return m?{name:m[1],type:m[2]}:{name:l,type:''};});

    const processes=(pr.stdout||'').trim().split('\n').filter(Boolean).map(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);let cmdStr=m?m[2]:'';cmdStr=cmdStr.replace('/usr/bin/python3','python3').replace(/^.*?\/install\//,'[ws]/install/');return m?{pid:m[1],cmd:cmdStr}:null;}).filter(Boolean);
    res.json({ok:true,cpu:parseFloat(cm?.[1]||0),memUsed:parseInt(mm?.[1]||0),memTotal:parseInt(mm?.[2]||0),disk:{used:dm?.[1],total:dm?.[2],pct:dm?.[3]},uptime:um?.[1]||'',nodes,topics,processes,project,rosInfo:s.rosInfo,isSim:isSim(s.robotKey),timestamp:Date.now()});
  }catch(e){res.json({ok:false,error:e.message});}
});

const WS_TELEMETRY_BACKPRESSURE=4*1024*1024;
function sendWebSocketJson(ws,value,maxBuffered=WS_TELEMETRY_BACKPRESSURE){
  if(ws?.readyState!==WebSocket.OPEN||ws.bufferedAmount>maxBuffered)return false;
  try{ws.send(JSON.stringify(value));return true;}catch{return false;}
}

function validRvizTopic(topic){return topic==='none'||(typeof topic==='string'&&/^\/[A-Za-z0-9_/-]+$/.test(topic));}
function simRvizStreamKey(robotKey,config){
  return [robotKey,config.odom||'none',config.laser||'none',config.map||'none',config.path||'none'].join('\u0000');
}
function attachSimRvizSubscriber(stream,ws,sessionId){
  if(stream.idleTimer){clearTimeout(stream.idleTimer);stream.idleTimer=null;}
  stream.subscribers.add(ws);ws.sharedSimRvizKey=stream.key;ws.termId=stream.termId;ws.robotKey=stream.robotKey;ws.sessionId=sessionId;
  if(stream.ready){
    sendWebSocketJson(ws,{type:'ready',rosInfo:stream.rosInfo});
    if(Object.keys(stream.latest).length)sendWebSocketJson(ws,{type:'data',data:stream.latest},SIM_RVIZ_CLIENT_BACKPRESSURE);
  }
}
function markSimRvizReady(stream,rosInfo){
  if(stream.closed)return;
  stream.ready=true;stream.rosInfo=rosInfo;
  for(const socket of stream.subscribers)sendWebSocketJson(socket,{type:'ready',rosInfo});
}
function fanoutSimRvizData(stream,data){
  if(stream.closed||!data||typeof data!=='object')return;
  Object.assign(stream.latest,data);stream.updatedAt=Date.now();
  const envelope={type:'data',data};
  // Slow viewers do not build an unbounded queue. They skip intermediate
  // telemetry and receive the next state; new/reconnected viewers get the
  // merged latest snapshot immediately.
  for(const socket of stream.subscribers)sendWebSocketJson(socket,envelope,SIM_RVIZ_CLIENT_BACKPRESSURE);
}
function destroySimRvizStream(stream,{message='',closeCode=1011,closePty=true}={}){
  if(!stream||stream.closed)return;
  stream.closed=true;if(stream.idleTimer)clearTimeout(stream.idleTimer);
  simRvizStreams.delete(stream.key);simRvizStreamsByTerm.delete(stream.termId);rvizBuffers.delete(stream.termId);
  if(closePty){const agent=agents.get(stream.robotKey);if(agent?.ws?.readyState===WebSocket.OPEN)try{agent.ws.send(JSON.stringify({type:'pty_close',termId:stream.termId}));}catch{}}
  for(const socket of [...stream.subscribers]){
    socket.sharedSimRvizKey=null;socket.termId=null;
    if(message)sendWebSocketJson(socket,{type:'error',message});
    if(message)try{socket.close(closeCode,String(message).slice(0,120));}catch{}
  }
  stream.subscribers.clear();stream.latest={};
}
function detachSimRvizSubscriber(ws){
  const key=ws?.sharedSimRvizKey;if(!key)return false;
  ws.sharedSimRvizKey=null;const stream=simRvizStreams.get(key);if(!stream)return true;
  stream.subscribers.delete(ws);
  if(!stream.subscribers.size&&!stream.idleTimer){
    stream.idleTimer=setTimeout(()=>{if(!stream.subscribers.size)destroySimRvizStream(stream,{closePty:true});},SIM_RVIZ_IDLE_CACHE_MS);
    stream.idleTimer.unref?.();
  }
  return true;
}
function sharedSimRvizSockets(robotKey=null){
  const sockets=new Set();
  for(const stream of simRvizStreams.values())if(!robotKey||stream.robotKey===robotKey)for(const socket of stream.subscribers)sockets.add(socket);
  return sockets;
}

// Route PTY output from both physical and fake SIM agents through one parser.
// Operational streams print newline-delimited JSON, but a PTY can split one
// object across chunks (or combine several objects). `rvizBuffers` preserves
// incomplete objects until the next chunk. Normal terminals still receive the
// original base64 PTY protocol.
function routeAgentPtyMessage(msg){
  const termId=String(msg?.termId||'');
  if(!termId||!['pty_output','pty_closed'].includes(msg?.type))return;
  const sharedSimStream=simRvizStreamsByTerm.get(termId);
  if(msg.type==='pty_closed'){
    rvizBuffers.delete(termId);
    if(sharedSimStream){destroySimRvizStream(sharedSimStream,{message:'Simulation RViz bridge stopped',closePty:false});return;}
    if(termId.startsWith('navigation_')){
      const browser=webSockets.get(termId);
      sendWebSocketJson(browser,{type:'error',code:'NAV_BRIDGE_EXIT',message:'โปรแกรมเชื่อมต่อ Nav2 บนหุ่นหยุดทำงาน ตรวจ bridge.log เพื่อดูสาเหตุ'});
      try{browser?.close(1011,'Nav2 bridge exited');}catch{}
      return;
    }
    if(termId.startsWith('mon_')){const monitor=monSockets.get(termId);sendWebSocketJson(monitor,{type:'closed'});return;}
  }
  if(termId.startsWith('mon_')&&msg.type==='pty_output'){
    const raw=Buffer.from(String(msg.data||''),'base64').toString('utf8');
    const text=raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/[\x00-\x08\x0e-\x1f\x7f]/g,'');
    const mws=monSockets.get(termId);
    if(mws?.readyState===WebSocket.OPEN){
      if(text.includes('READY:'))sendWebSocketJson(mws,{type:'ready'});
      if(text.includes('ERR:'))sendWebSocketJson(mws,{type:'error',message:text.split('\n').find(line=>line.includes('ERR:'))||''});
      if(text.trim())sendWebSocketJson(mws,{type:'msg',data:text});
    }
    return;
  }
  const operational=/^(?:rviz_|lidar_|tune_|mapping_|navigation_)/.test(termId);
  if(operational&&msg.type==='pty_output'){
    let parser=rvizBuffers.get(termId);
    if(!parser){parser=new PtyJsonStream();rvizBuffers.set(termId,parser);}
    let extracted;
    try{extracted=parser.write(Buffer.from(String(msg.data||''),'base64'));}
    catch(error){
      rvizBuffers.delete(termId);
      if(sharedSimStream){destroySimRvizStream(sharedSimStream,{message:error.message});return;}
      sendWebSocketJson(webSockets.get(termId),{type:'error',message:'Telemetry frame ใหญ่เกินขีดจำกัด 16 MB'});return;
    }
    if(sharedSimStream){
      for(const json of extracted){try{fanoutSimRvizData(sharedSimStream,JSON.parse(json));}catch{}}
      return;
    }
    const browser=webSockets.get(termId);
    if(browser?.readyState!==WebSocket.OPEN||browser.bufferedAmount>WS_TELEMETRY_BACKPRESSURE)return;
    for(const json of extracted){
      try{
        const data=JSON.parse(json);
        const envelope=termId.startsWith('lidar_')?{type:'scan',data}:termId.startsWith('tune_')?{type:'telemetry',data}:termId.startsWith('mapping_')?{type:'mapping',data}:termId.startsWith('navigation_')?{type:'navigation',data}:{type:'data',data};
        sendWebSocketJson(browser,envelope);
      }catch{}
    }
    return;
  }
  const browser=webSockets.get(termId);
  if(browser?.readyState===WebSocket.OPEN)sendWebSocketJson(browser,msg);
}

function failAgentWork(robotKey,reason='Robot disconnected'){
  runtimeProbeCache.clear(robotKey+'\0');
  for(const[reqId,callback]of pendingReqs){
    if(callback.robotKey!==robotKey)continue;
    pendingReqs.delete(reqId);callback({ok:false,error:reason});
  }
  for(const socket of new Set(webSockets.values())){
    if(socket.robotKey!==robotKey)continue;
    sendWebSocketJson(socket,{type:'error',message:reason});
    try{socket.close(1011,reason.slice(0,120));}catch{}
  }
  for(const socket of new Set(monSockets.values())){
    if(socket.robotKey!==robotKey)continue;
    sendWebSocketJson(socket,{type:'error',message:reason});
    try{socket.close(1011,reason.slice(0,120));}catch{}
  }
  for(const stream of [...simRvizStreams.values()])if(stream.robotKey===robotKey)destroySimRvizStream(stream,{message:reason,closePty:false});
  dashboardRuntimeCache.delete(robotKey);
}

function closeOperationalSockets(userId,robotKey,reason='Session closed'){
  const candidates=new Set([...webSockets.values(),...monSockets.values(),...sharedSimRvizSockets(robotKey)]);
  for(const socket of candidates){
    if(Number(socket.user?.id)!==Number(userId)||socket.robotKey!==robotKey)continue;
    sendWebSocketJson(socket,{type:'error',message:reason});
    try{socket.close(1008,reason.slice(0,120));}catch{}
  }
}

function reserveRuntimeOperation(session,sessionId,pathname,action,port=''){
  if(!['start','stop'].includes(action))return null;
  runtimeProbeCache.clear(session.robotKey+'\0');
  // Routes check realRuntimeConflict and reserve synchronously, before any await.
  const operation={sessionId,userId:session.userId,pathname,action,port};
  robotRuntimeOperations.set(session.robotKey,operation);
  return operation;
}

function releaseRuntimeOperation(robotKey,operation){
  if(operation)runtimeProbeCache.clear(robotKey+'\0');
  if(operation&&robotRuntimeOperations.get(robotKey)===operation)robotRuntimeOperations.delete(robotKey);
}

function mappingOperationStatus(session,sessionId,pathname='/ws/mapping'){
  const pending=robotRuntimeOperations.get(session.robotKey);
  return {runtimeBusy:!!pending,runtimeAction:pending?.action||'',runtimeRetryable:!!pending&&pending.pathname===pathname&&pending.userId===session.userId&&pending.sessionId===sessionId};
}

function realRuntimeConflict(session,sessionId,pathname,action){
  if(!['start','stop'].includes(action))return '';
  const pending=robotRuntimeOperations.get(session.robotKey);
  if(pending)return `หุ่นยนต์กำลัง${pending.action==='start'?'เริ่ม':'หยุด'} ${pending.pathname.split('/').pop()} อยู่ กรุณารอคำขอเดิมเสร็จก่อน`;
  const current=robotControlLeases.get(session.robotKey);
  if(current?.ws?.readyState!==WebSocket.OPEN)return '';
  const active=Array.from(current.streams?.values()||[current.pathname]);
  const allowed=pathname==='/ws/lidar'
    ? active.every(path=>path==='/ws/lidar'||path==='/ws/controller-tune')
    : active.every(path=>path==='/ws/lidar'||(action==='stop'&&path===pathname));
  if(current.userId===session.userId&&current.sessionId===sessionId&&allowed)return '';
  return 'หุ่นยนต์มีหน้าควบคุมหรือภารกิจอื่นทำงานอยู่ กรุณาหยุดและปิดหน้าควบคุมเดิมก่อน';
}

function acquireControlLease(ws,session,pathname,config={}){
  if(!CONTROLLED_STREAM_PATHS.has(pathname))return true;
  const pending=robotRuntimeOperations.get(session.robotKey);
  // Keep teleop's separate UART Controller + USB LiDAR startup compatible.
  const companion=pending?.pathname==='/ws/lidar'&&pathname==='/ws/controller-tune'
    &&pending.userId===session.userId&&pending.sessionId===ws.sessionId&&pending.port!==String(config.port||'');
  if(pending&&!companion){
    sendWebSocketJson(ws,{type:'error',code:'ROBOT_BUSY',retryable:['/ws/mapping','/ws/navigation'].includes(pathname)&&mappingOperationStatus(session,ws.sessionId,pathname).runtimeRetryable,message:'หุ่นยนต์กำลังเริ่ม/หยุดระบบอยู่ กรุณารอคำขอเดิมเสร็จก่อน'});
    try{ws.close(1008,'Robot runtime operation in progress');}catch{}
    return false;
  }
  const current=robotControlLeases.get(session.robotKey);
  if(current?.ws?.readyState===WebSocket.OPEN&&current.ws!==ws){
    // A sensor stream may accompany one controller in the same browser session.
    // Never allow two motor-control streams (or another session) to share it.
    const streams=current.streams||new Map([[current.ws,current.pathname]]);
    const sameSession=current.userId===session.userId&&current.sessionId===ws.sessionId;
    const compatible=!Array.from(streams.values()).some(active=>active===pathname||(active!=='/ws/lidar'&&pathname!=='/ws/lidar'));
    if(sameSession&&compatible){
      streams.set(ws,pathname);current.streams=streams;ws.controlLeaseRobotKey=session.robotKey;return true;
    }
    const onlineUsers=robotOnlineUserCount(session.robotKey);
    sendWebSocketJson(ws,{type:'error',code:'ROBOT_BUSY',message:`หุ่นยนต์มีช่องควบคุมเปิดอยู่แล้ว กรุณาปิดหน้าควบคุมเดิมก่อน (${onlineUsers} คนออนไลน์)`,onlineUsers});
    try{ws.close(1008,'Robot is already under control');}catch{}
    return false;
  }
  robotControlLeases.set(session.robotKey,{ws,userId:session.userId,sessionId:ws.sessionId,pathname,streams:new Map([[ws,pathname]]),createdAt:Date.now()});
  ws.controlLeaseRobotKey=session.robotKey;
  return true;
}

function releaseControlLease(ws){
  const key=ws?.controlLeaseRobotKey;if(!key)return;
  const current=robotControlLeases.get(key);
  if(current?.streams?.delete(ws)){
    if(!current.streams.size)robotControlLeases.delete(key);
    else if(current.ws===ws){const [next,pathname]=current.streams.entries().next().value;current.ws=next;current.pathname=pathname;}
  }else if(current?.ws===ws)robotControlLeases.delete(key);
  ws.controlLeaseRobotKey=null;
}

// ── WS Upgrade ─────────────────────────────────────────────
server.on('upgrade',async(req,socket,head)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(!['/ws/agent','/ws/cluster','/ws/terminal','/ws/rviz','/ws/lidar','/ws/controller-tune','/ws/mapping','/ws/navigation','/ws/monitor','/ws/robot-status'].includes(url.pathname)) return socket.destroy();
  try {
    if(url.pathname==='/ws/cluster'&&localRuntime)return socket.destroy();
    if(localRuntime&&(!localRuntime.validHost(req)||!localRuntime.sameOrigin(req)||(url.pathname==='/ws/agent'&&!localRuntime.agentAllowed(req))))return socket.destroy();
    let user=null;
    if(url.pathname!=='/ws/agent'&&url.pathname!=='/ws/cluster'){
      const origin=String(req.headers.origin||'');
      const forwardedProto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
      const ownOrigin=localRuntime?.config.local_origin|| (process.env.PUBLIC_URL?new URL(process.env.PUBLIC_URL).origin:`${forwardedProto}://${req.headers.host}`);
      if(origin&&origin!==ownOrigin&&!allowedOrigins.includes(origin)) return socket.destroy();
      user=await tokenUser(webSocketAuthToken(req.headers['sec-websocket-protocol']));
      if(!user) return socket.destroy();
    }
    socket.setNoDelay(true);socket.setKeepAlive(true,30000);
    wss.handleUpgrade(req,socket,head,ws=>{ws.user=user;wss.emit('connection',ws,url.pathname);});
  } catch { socket.destroy(); }
});

wss.on('connection',(ws,pathname)=>{if(pathname==='/ws/cluster')clusterBus?.attach(ws);});

wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
});

// ── /ws/robot-status ─────────────────────────────────────
function broadcastStatus(robot_key,online){
  const message={type:'status',robot_key,online,agentVersion:agents.get(robot_key)?.version||null,ts:Date.now()};
  statusSubs.forEach(ws=>{if(ws.user?.role==='admin'||ws.allowedRobotKeys?.has(robot_key))sendWebSocketJson(ws,message);});
}

function broadcastRobotPresence(robotKey){
  const onlineUsers=robotOnlineUserCount(robotKey),message={type:'presence',robot_key:robotKey,onlineUsers,otherUsers:Math.max(0,onlineUsers-1),ts:Date.now()};
  statusSubs.forEach(ws=>{if(ws.user?.role==='admin'||ws.allowedRobotKeys?.has(robotKey))sendWebSocketJson(ws,message);});
}

function unregisterRobotPresence(ws,{broadcast=true}={}){
  const robotKey=ws?._presenceRobotKey,userId=ws?._presenceUserId;
  if(!robotKey||userId==null)return;
  const users=robotPresenceSockets.get(robotKey),sockets=users?.get(userId);
  sockets?.delete(ws);if(sockets&&!sockets.size)users.delete(userId);if(users&&!users.size)robotPresenceSockets.delete(robotKey);
  ws._presenceRobotKey=null;ws._presenceUserId=null;
  if(broadcast)broadcastRobotPresence(robotKey);
}

function closeRobotPresence(userId,robotKey){
  const users=robotPresenceSockets.get(robotKey);if(!users)return;
  const targets=userId==null?[...users.values()]:[users.get(userId)].filter(Boolean);
  for(const sockets of targets)for(const socket of [...sockets])unregisterRobotPresence(socket,{broadcast:false});
  broadcastRobotPresence(robotKey);
}

async function refreshStatusAccess(userId){
  const sockets=[...statusSubs].filter(socket=>Number(socket.user?.id)===Number(userId));if(!sockets.length)return;
  const generation=(statusAccessGenerations.get(userId)||0)+1;statusAccessGenerations.set(userId,generation);
  const query=sockets[0].user?.role==='admin'?['SELECT robot_key FROM robots',[]]:["SELECT r.robot_key FROM robot_user_access rua JOIN robots r ON r.id=rua.robot_id LEFT JOIN cluster_user_access cua ON cua.cluster_id=r.cluster_id AND cua.user_id=rua.user_id LEFT JOIN clusters c ON c.id=r.cluster_id WHERE rua.user_id=? AND (r.robot_key NOT LIKE 'SIM-%' OR (cua.user_id IS NOT NULL AND c.enabled=1))",[userId]];
  try{
    const[rows]=localRuntime?[[localRuntime.robot]]:await db.query(query[0],query[1]);if(statusAccessGenerations.get(userId)!==generation)return;
    const allowed=new Set(rows.map(row=>row.robot_key)),status={},presence={};for(const row of rows){status[row.robot_key]=robotOnline(row.robot_key)?'online':'offline';presence[row.robot_key]=robotOnlineUserCount(row.robot_key);}
    for(const socket of sockets)if(socket.readyState===WebSocket.OPEN){socket.allowedRobotKeys=new Set(allowed);sendWebSocketJson(socket,{type:'snapshot',status,presence});}
  }catch{}
}

wss.on('connection',(ws,pathname)=>{
  if(pathname!=='/ws/robot-status') return;
  statusSubs.add(ws);ws.allowedRobotKeys=new Set();refreshStatusAccess(ws.user.id);
  ws.on('message',raw=>{
    let message;try{message=JSON.parse(raw);}catch{return;}
    if(message.type!=='watch'&&message.type!=='heartbeat')return;
    const session=sessions.get(message.sessionId);
    if(!session||session.userId!==ws.user?.id||!liveSession(session)){ws.send(JSON.stringify({type:'presence_error',error:'Session not found or forbidden'}));return;}
    session.lastSeen=Date.now();session.expiresAt=Date.now()+24*60*60*1000;
    if(ws._presenceRobotKey!==session.robotKey||ws._presenceUserId!==session.userId){
      unregisterRobotPresence(ws);
      const users=robotPresenceSockets.get(session.robotKey)||new Map(),sockets=users.get(session.userId)||new Set();
      sockets.add(ws);users.set(session.userId,sockets);robotPresenceSockets.set(session.robotKey,users);
      ws._presenceRobotKey=session.robotKey;ws._presenceUserId=session.userId;ws.allowedRobotKeys?.add(session.robotKey);
      broadcastRobotPresence(session.robotKey);
    }else if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'presence',robot_key:session.robotKey,onlineUsers:robotOnlineUserCount(session.robotKey),otherUsers:Math.max(0,robotOnlineUserCount(session.robotKey)-1),ts:Date.now()}));
  });
  ws.on('close',()=>{statusSubs.delete(ws);unregisterRobotPresence(ws);});
});

// ── /ws/monitor ──────────────────────────────────────────
wss.on('connection',(ws,pathname)=>{
  if(pathname!=='/ws/monitor') return;
  let monTermId=null,monRobotKey=null;
  ws.on('message',async raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(ws.sessionId){const active=sessions.get(ws.sessionId);if(!active||active.userId!==ws.user?.id||!liveSession(active)){sendWebSocketJson(ws,{type:'error',message:'Session expired or revoked'});try{ws.close(1008,'Session expired or revoked');}catch{}return;}active.lastSeen=Date.now();}
    if(msg.type==='subscribe'){
      const sess=sessions.get(msg.sessionId);
      if(!sess||sess.userId!==ws.user?.id||!liveSession(sess)){ws.send(JSON.stringify({type:'error',message:'Session not found or forbidden'}));return;}
      if(agentManagement?.busy(sess.robotKey)){ws.send(JSON.stringify({type:'error',message:'กำลังอัปเดต Agent กรุณาเปิดเครื่องมือใหม่เมื่อเสร็จ'}));ws.close(1008,'Agent updating');return;}
      sess.lastSeen=Date.now();ws.sessionId=msg.sessionId;
      const ag=agents.get(sess.robotKey);
      if(!ag||ag.ws.readyState!==WebSocket.OPEN){ws.send(JSON.stringify({type:'error',message:'Robot offline'}));return;}
      monRobotKey=sess.robotKey;ws.robotKey=sess.robotKey;
      if(monTermId){ag.ws.send(JSON.stringify({type:'pty_close',termId:monTermId}));monSockets.delete(monTermId);}
      monTermId='mon_'+mkId(); monSockets.set(monTermId,ws);
      const src=sess.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
      const topic=msg.topic;
      if(typeof topic!=='string'||!/^\/[A-Za-z0-9_/-]+$/.test(topic)){ws.send(JSON.stringify({type:'error',message:'Invalid topic'}));return;}
      const py=["import rclpy,sys,yaml,time","from rosidl_runtime_py.utilities import get_message","from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy","BE=QoSProfile(depth=5,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)","rclpy.init()","n=rclpy.create_node('ros2ide_monitor')","MsgClass=None","deadline=time.time()+5.0","while time.time()<deadline and MsgClass is None:"," infos=n.get_topic_names_and_types()",` " matches=[t for t in infos if t[0]=='${topic}']`," if matches:","  try:","   mtype=matches[0][1][0]","   MsgClass=get_message(mtype)","   print('READY:'+mtype,flush=True)","  except Exception as e:","   print('ERR:'+str(e),flush=True); break"," else:","  rclpy.spin_once(n,timeout_sec=0.2)","if MsgClass is None:"," print('ERR:Cannot find topic',flush=True)"," n.destroy_node(); rclpy.shutdown(); sys.exit(1)","def cb(msg):"," try:","  import rosidl_runtime_py","  d=rosidl_runtime_py.message_to_ordereddict(msg)","  print('---',flush=True)","  print(yaml.dump(d,default_flow_style=False).rstrip(),flush=True)"," except Exception as e:","  print('ERR:'+str(e),flush=True)",`"n.create_subscription(MsgClass,'${topic}',cb,BE)"`,"try:"," rclpy.spin(n)","except: pass","n.destroy_node()","rclpy.shutdown()"].join('\n');
      const monitorPath=`/tmp/_mon_${monTermId.slice(4,20)}.py`,monitorSource=py.replace("rclpy.create_node('ros2ide_monitor')",`rclpy.create_node('ros2ide_monitor_${monTermId.slice(4,16)}')`);
      agentReq(sess.robotKey,'fs_write',{path:monitorPath,content:monitorSource}).then(()=>{
        ag.ws.send(JSON.stringify({type:'pty_init',termId:monTermId}));
        ag.ws.send(JSON.stringify({type:'pty_input',termId:monTermId,data:`source ${remoteShellPath(src)} 2>/dev/null; ROSIDE_MONITOR_TOPIC=${shellQuote(topic)} python3 -u ${shellQuote(monitorPath)}\n`}));
      }).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
    } else if(msg.type==='unsubscribe'){
      if(monTermId){const ag=agents.get(monRobotKey);if(ag)ag.ws.send(JSON.stringify({type:'pty_close',termId:monTermId}));monSockets.delete(monTermId);monTermId=null;}
      ws.send(JSON.stringify({type:'closed'}));
    }
  });
  ws.on('close',()=>{if(monTermId){const ag=agents.get(monRobotKey);if(ag)ag.ws.send(JSON.stringify({type:'pty_close',termId:monTermId}));monSockets.delete(monTermId);}});
});

// ── Main WS handler (agent + terminal + rviz) ────────────
wss.on('connection',(ws,pathname)=>{
  if(!['/ws/agent','/ws/terminal','/ws/rviz','/ws/lidar','/ws/controller-tune','/ws/mapping','/ws/navigation'].includes(pathname)) return;
  let connId=null;
  let authorizedAgent=false,authenticatingAgent=false;
  const agentAuthTimer=pathname==='/ws/agent'?setTimeout(()=>{if(!authorizedAgent)try{ws.close(1008,'Agent authentication timeout');}catch{}},10000):null;
  agentAuthTimer?.unref?.();

  ws.on('message',message=>{
    let msg;try{msg=JSON.parse(message);}catch{return;}
    if(ws.sessionId){const active=sessions.get(ws.sessionId);if(!active||active.userId!==ws.user?.id||!liveSession(active)){sendWebSocketJson(ws,{type:'error',message:'Session expired or revoked'});try{ws.close(1008,'Session expired or revoked');}catch{}return;}active.lastSeen=Date.now();}

    if(pathname==='/ws/agent'){
      if(msg.type==='auth'){
        if(authorizedAgent||authenticatingAgent){ws.send(JSON.stringify({type:'auth_error',message:'Agent is already authenticating'}));return ws.close(1008,'Duplicate authentication');}
        const requestedKey=msg.robotKey||msg.robotId||'';authenticatingAgent=true;
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(requestedKey)){ws.send(JSON.stringify({type:'auth_error',message:'Invalid robot key'}));return ws.close();}
        (localRuntime?Promise.resolve([[requestedKey===localRuntime.robot.robot_key&&localRuntime.matches(msg.localSecret)?localRuntime.robot:null].filter(Boolean)]):db.query('SELECT * FROM robots WHERE robot_key=?',[requestedKey])).then(([rows])=>{
          if(!rows.length){ws.send(JSON.stringify({type:'auth_pending',message:'Robot key is not registered'}));return ws.close();}
          const rk=rows[0].robot_key;clearTimeout(agentAuthTimer);
          const old=agents.get(rk);if(old&&old.ws!==ws){failAgentWork(rk,'Robot agent reconnected');try{old.ws.close(4001,'Replaced by a new agent connection');}catch{}}
          connId=rk;authorizedAgent=true;agents.set(rk,{ws,lastSeen:Date.now(),connectedAt:Date.now(),version:typeof msg.version==='string'?msg.version.slice(0,32):null,capabilities:Array.isArray(msg.capabilities)?msg.capabilities.filter(v=>typeof v==='string').slice(0,20):[],epoch:msg.epoch,commandToken:msg.commandToken,mode:msg.mode||'online'});broadcastStatus(rk,true);
          if(!isSim(rk)&&agents.get(rk).version)db.query('UPDATE robots SET agent_version=? WHERE robot_key=?',[agents.get(rk).version,rk]).catch(error=>console.error('[AGENT] Cannot save version:',error.message));
          // Optional metadata only: legacy Agents and every Sim retain their wire protocol.
          if(!isSim(rk)&&agents.get(rk).capabilities.includes('control-mode-v1')){
            const send=ws.send.bind(ws);
            ws.send=(data,...args)=>{try{const packet=JSON.parse(String(data));if(packet.type==='request'||String(packet.type).startsWith('pty_')){packet.epoch=agents.get(rk)?.epoch;if(packet.type==='pty_input')packet.commandToken=agents.get(rk)?.commandToken;data=JSON.stringify(packet);}}catch{}return send(data,...args);};
          }
          ws.send(JSON.stringify({type:'auth_ok',robotName:rows[0].name,...(!isSim(rk)&&agents.get(rk).capabilities.includes('local-ide')?{workspace:rows[0].workspace||'~/ros2_ws'}:{})}));
          robotRosInfo(rows[0]).catch(()=>{});
          console.log(`[CLOUD] 🤖 Agent: ${rows[0].name}`);
        }).catch(()=>ws.close());
      }
      else if(authorizedAgent&&msg.type==='response'){const cb=pendingReqs.get(msg.reqId);if(cb){cb(msg);pendingReqs.delete(msg.reqId);}}
      else if(authorizedAgent&&msg.type==='agent_status'){const ag=agents.get(connId);if(ag&&ag.ws===ws){ag.mode=msg.mode;ag.epoch=msg.epoch;ag.commandToken=msg.commandToken;ag.localUrls=msg.localUrls;}}
      else if(authorizedAgent&&(msg.type==='pty_output'||msg.type==='pty_closed'))routeAgentPtyMessage(msg);
    }
    else if(pathname==='/ws/terminal'||pathname==='/ws/rviz'||pathname==='/ws/lidar'||pathname==='/ws/controller-tune'||pathname==='/ws/mapping'||pathname==='/ws/navigation'){
      if(msg.type==='init'||msg.type==='start'){
        if(ws.termId){sendWebSocketJson(ws,{type:'error',message:'Stream is already initialized'});try{ws.close(1008,'Duplicate stream initialization');}catch{}return;}
        const sess=sessions.get(msg.sessionId);
        if(!sess||sess.userId!==ws.user?.id||!liveSession(sess)){ws.send(JSON.stringify({type:'error',message:'Session not found or forbidden'}));return;}
        if(agentManagement?.busy(sess.robotKey)){ws.send(JSON.stringify({type:'error',message:'กำลังอัปเดต Agent กรุณาเปิดเครื่องมือใหม่เมื่อเสร็จ'}));ws.close(1008,'Agent updating');return;}
        sess.lastSeen=Date.now();ws.sessionId=msg.sessionId;
        const ag=agents.get(sess.robotKey);
        if(!ag||ag.ws.readyState!==WebSocket.OPEN){ws.send(JSON.stringify({type:'error',message:'Robot offline'}));return;}
        const rvizTopics=pathname==='/ws/rviz'?{odom:msg.odom||'none',laser:msg.laser||'none',map:msg.map||'none',path:msg.path||'none'}:null;
        if(rvizTopics&&!Object.values(rvizTopics).every(validRvizTopic)){sendWebSocketJson(ws,{type:'error',message:'Invalid RViz topic'});try{ws.close(1008,'Invalid RViz topic');}catch{}return;}
        const sharedRvizKey=rvizTopics&&isSim(sess.robotKey)?simRvizStreamKey(sess.robotKey,rvizTopics):null;
        const existingSharedRviz=sharedRvizKey&&simRvizStreams.get(sharedRvizKey);
        if(existingSharedRviz&&!existingSharedRviz.closed){attachSimRvizSubscriber(existingSharedRviz,ws,msg.sessionId);return;}
        const termId=(pathname==='/ws/rviz'?'rviz_':pathname==='/ws/lidar'?'lidar_':pathname==='/ws/controller-tune'?'tune_':pathname==='/ws/mapping'?'mapping_':pathname==='/ws/navigation'?'navigation_':'term_')+mkId();
        let sharedSimRvizStream=null;
        if(sharedRvizKey){
          sharedSimRvizStream={key:sharedRvizKey,termId,robotKey:sess.robotKey,topics:rvizTopics,subscribers:new Set(),latest:{},ready:false,closed:false,idleTimer:null,updatedAt:0,rosInfo:sess.rosInfo};
          simRvizStreams.set(sharedRvizKey,sharedSimRvizStream);simRvizStreamsByTerm.set(termId,sharedSimRvizStream);attachSimRvizSubscriber(sharedSimRvizStream,ws,msg.sessionId);
        }else{connId=termId;webSockets.set(termId,ws);ws.termId=termId;ws.robotKey=sess.robotKey;}
        if(!acquireControlLease(ws,sess,pathname,msg)){if(sharedSimRvizStream)destroySimRvizStream(sharedSimRvizStream,{closePty:false});else webSockets.delete(termId);connId=null;ws.termId=null;return;}
        ag.ws.send(JSON.stringify({type:'pty_init',termId,cols:msg.cols||120,rows:msg.rows||30}));
        const rejectStreamInit=message=>{if(sharedSimRvizStream)destroySimRvizStream(sharedSimRvizStream,{message,closeCode:1008});else{sendWebSocketJson(ws,{type:'error',message});try{ws.close(1008,String(message).slice(0,120));}catch{}}};
        const src=sess.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
        if(pathname==='/ws/controller-tune'){
          const port=String(msg.port||''),baud=Math.trunc(Number(msg.baud)),requestedMotorCount=Math.trunc(Number(msg.motorCount)),motorCount=Number.isInteger(requestedMotorCount)&&requestedMotorCount>0?requestedMotorCount:2;
          if(!SERIAL_DEVICE_PATTERN.test(port)||!Number.isInteger(baud)||baud<9600||baud>3000000||!Number.isInteger(motorCount)||motorCount<1||motorCount>8){rejectStreamInit('Invalid serial configuration');return;}
          ws.motorCount=motorCount;
          const pyLines=[
            '# ros2ide_controller_tune',
            'import json,math,os,re,select,sys,time',
            'try:',
            ' import serial',
            ` ser=serial.Serial(${JSON.stringify(port)},${baud},timeout=0)`,
            ` print(json.dumps({'event':'port_open','port':${JSON.stringify(port)},'baud':${baud}},separators=(',',':')),flush=True)`,
            'except Exception as exc:',
            " denied=getattr(exc,'errno',None)==13 or '[Errno 13]' in str(exc) or 'Permission denied' in str(exc)",
            ` event='permission_denied' if denied else 'error'; out={'event':event,'message':str(exc),'port':${JSON.stringify(port)}}`,
            " if denied: out['hint']='sudo usermod -aG dialout '+os.getenv('USER','<user>')+' แล้ว logout/login หรือ reboot'",
            ` print(json.dumps(out,separators=(',',':')),flush=True); sys.exit(13 if denied else 1)`,
            `motor_count=${motorCount}`,
            "number=r'-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)'",
            "valid_command=re.compile(r'^(?:S|Z|V\\s+'+number+r'\\s+'+number+r'\\s+'+number+r'|R(?:\\s+'+number+r'){'+str(motor_count)+r'}|P(?:\\s+'+number+r'){'+str(motor_count*3)+r'})$')",
            "serial_buffer=b''",
            'serial_bytes=0; serial_lines=0; serial_sample=""; next_serial_status=time.monotonic()+3',
            'def emit(event,**values):',
            " if event=='frame' and any(not math.isfinite(v) for v in values.get('values',[])): event='invalid_frame'; values={'line':values.get('line','')}",
            " values['event']=event; values['receivedAt']=int(time.time()*1000); print(json.dumps(values,separators=(',',':')),flush=True)",
            'def parse_line(line):',
            " fields=line.replace(',', ' ').split(); kind=fields[0].upper() if fields else ''",
            ' try:',
            "  if kind=='ROSIDE_CONTROLLER_READY' and len(fields)==1: emit('frame',kind='READY',values=[],line=line)",
            "  elif kind=='RPM' and len(fields)==1+(motor_count*2): emit('frame',kind=kind,values=[float(v) for v in fields[1:]],line=line)",
            "  elif kind=='ODOM' and len(fields)==7: emit('frame',kind=kind,values=[float(v) for v in fields[1:]],line=line)",
            "  elif kind in ('GYRO','IMU') and len(fields)==4: emit('frame',kind='GYRO',values=[float(v) for v in fields[1:]],line=line)",
            "  elif kind=='PID' and len(fields)==1+(motor_count*3): emit('frame',kind=kind,values=[float(v) for v in fields[1:]],line=line)",
            "  elif re.fullmatch(r'[A-Z][A-Z0-9_]{0,23}',kind) and 1<len(fields)<=33:",
            "   values=[float(v) for v in fields[1:]]",
            "   if all(math.isfinite(v) for v in values): emit('frame',kind=kind,values=values,line=line)",
            "   else: emit('invalid_frame',line=line)",
            "  else: emit('invalid_frame',line=line)",
            " except ValueError: emit('invalid_frame',line=line)",
            'while True:',
            ' readable,_,_=select.select([sys.stdin,ser],[],[],0.05)',
            ' if sys.stdin in readable:',
            '  command=sys.stdin.readline().strip()',
            "  if valid_command.fullmatch(command): ser.write((command+'\\n').encode('ascii')); emit('command_sent',command=command)",
            ' if ser in readable or ser.in_waiting:',
            "  chunk=ser.read(ser.in_waiting or 1)",
            "  if chunk:",
            "   serial_bytes+=len(chunk)",
            "   if not serial_sample: serial_sample=chunk[:16].hex()",
            "   serial_buffer+=chunk",
            "  if len(serial_buffer)>16384: serial_buffer=serial_buffer[-8192:]",
            "  while b'\\n' in serial_buffer:",
            "   raw,serial_buffer=serial_buffer.split(b'\\n',1)",
            '   serial_lines+=1',
            "   line=raw.rstrip(b'\\r').decode('ascii',errors='replace').strip()",
            "   if line: parse_line(line)",
            ' if time.monotonic()>=next_serial_status:',
            "  emit('serial_status',bytesReceived=serial_bytes,linesReceived=serial_lines,partialBytes=len(serial_buffer),sample=serial_sample)",
            '  next_serial_status=time.monotonic()+3',
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_roside_controller_tune.py',content:pyLines.join('\n')}).then(()=>{
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:'python3 -u /tmp/_roside_controller_tune.py\n'}));
            ws.send(JSON.stringify({type:'ready',port,baud}));
          }).catch(e=>rejectStreamInit(e.message));
        } else if(pathname==='/ws/lidar'){
          const root=(sess.workspace||'~/ros2_ws').replace(/\/$/,'');
          const pyLines=[
            "# ros2ide_lidar_live",
            "import rclpy,json,math,time,collections",
            "from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy",
            "from sensor_msgs.msg import LaserScan",
            "BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)",
            "samples=collections.deque(maxlen=20)",
            "last=None",
            "def cb(m):",
            " global last",
            " now=time.monotonic(); wall=time.time()",
            " interval=(now-last) if last is not None else None; last=now; samples.append(now)",
            " hz=((len(samples)-1)/(samples[-1]-samples[0])) if len(samples)>1 and samples[-1]>samples[0] else None",
            " ranges=[float(v) if math.isfinite(v) else None for v in m.ranges]",
            " out={'frame':m.header.frame_id,'angleMin':m.angle_min,'angleMax':m.angle_max,'angleIncrement':m.angle_increment,'rangeMin':m.range_min,'rangeMax':m.range_max,'ranges':ranges,'receivedAt':int(wall*1000),'interval':interval,'hz':hz,'scanTime':float(m.scan_time)}",
            " print(json.dumps(out,separators=(',',':')),flush=True)",
            "rclpy.init()",
            "n=rclpy.create_node('ros2ide_lidar_live')",
            "n.create_subscription(LaserScan,'/scan',cb,BE)",
            "try: rclpy.spin(n)",
            "except (KeyboardInterrupt,Exception): pass",
            "n.destroy_node(); rclpy.shutdown()",
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_lidar_live.py',content:pyLines.join('\n')}).then(()=>{
            const setup=`source ${remoteShellPath(src)} 2>/dev/null; source ${remoteShellPath(root+'/install/setup.bash')} 2>/dev/null || true; python3 -u /tmp/_lidar_live.py\n`;
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:setup}));
            ws.send(JSON.stringify({type:'ready',topic:'/scan'}));
          }).catch(e=>rejectStreamInit(e.message));
        } else if(pathname==='/ws/mapping'){
          const root=(sess.workspace||'~/ros2_ws').replace(/\/$/,'');
          const port=String(msg.controllerPort||''),baud=Math.trunc(Number(msg.controllerBaud)),pidCommand=String(msg.pidCommand||'').trim();
          if(!SERIAL_DEVICE_PATTERN.test(port)||!Number.isInteger(baud)||baud<9600||baud>3000000||!(/^(?:|P(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)){6})$/.test(pidCommand))){rejectStreamInit('Controller COM port, baud rate หรือ PID ไม่ถูกต้อง');return;}
          const pyLines=[
            '# ros2ide_mapping_live','import json,math,select,sys,time','import rclpy,serial','from geometry_msgs.msg import TransformStamped','from nav_msgs.msg import OccupancyGrid,Odometry','from sensor_msgs.msg import LaserScan','from tf2_msgs.msg import TFMessage','from tf2_ros import TransformBroadcaster','from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy',
            'BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)','MAPQ=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)',
            `PORT=${JSON.stringify(port)}; BAUD=${baud}; PID=${JSON.stringify(pidCommand)}`,"state={'map':None,'scan':None,'odom':None,'mapTf':None,'tx':'S','ready':False,'rpm':None}",'last_cmd=0.0','serial_buf=b\'\'','try:'," ser=serial.Serial(PORT,BAUD,timeout=0); print(json.dumps({'event':'controller_connected','port':PORT,'baud':BAUD},separators=(',',':')),flush=True)",'except Exception as e:'," print(json.dumps({'event':'controller_error','message':str(e),'port':PORT},separators=(',',':')),flush=True); sys.exit(2)",'rclpy.init()','n=rclpy.create_node(\'ros2ide_mapping_live\')',"odom_pub=n.create_publisher(Odometry,'/odom',20)",'tf_pub=TransformBroadcaster(n)',
            'def map_cb(m):'," step=max(1,int(math.ceil(max(m.info.width,m.info.height)/320.0)))"," data=[int(m.data[y*m.info.width+x]) for y in range(0,m.info.height,step) for x in range(0,m.info.width,step)]"," state['map']={'width':(m.info.width+step-1)//step,'height':(m.info.height+step-1)//step,'resolution':m.info.resolution*step,'originX':m.info.origin.position.x,'originY':m.info.origin.position.y,'data':data}",
            'def scan_cb(m):',' step=max(1,len(m.ranges)//720)'," state['scan']={'frame':m.header.frame_id,'angleMin':m.angle_min,'angleIncrement':m.angle_increment*step,'rangeMin':m.range_min,'rangeMax':m.range_max,'ranges':[float(v) if math.isfinite(v) else None for v in m.ranges[::step]]}",
            'def tf_cb(m):',' for t in m.transforms:',"  if t.header.frame_id.lstrip('/')=='map' and t.child_frame_id.lstrip('/')=='odom':","   q=t.transform.rotation; state['mapTf']=(t.transform.translation.x,t.transform.translation.y,math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z)))",
            'def odom_cb(m):',' p=m.pose.pose; q=p.orientation',' x=p.position.x; y=p.position.y; yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))'," tf=state['mapTf']"," if tf is not None: x,y=tf[0]+math.cos(tf[2])*x-math.sin(tf[2])*y,tf[1]+math.sin(tf[2])*x+math.cos(tf[2])*y; yaw+=tf[2]"," state['odom']={'x':x,'y':y,'yaw':yaw}",
            'def send(command):'," ser.write((command+'\\n').encode('ascii')); state['tx']=command",
            'def serial_line(line):',' f=line.replace(\',\',\' \').split(); kind=f[0].upper() if f else \"\"',' try:',"  if kind=='ROSIDE_CONTROLLER_READY': state['ready']=True; PID and send(PID)","  elif kind=='RPM' and len(f)>=5 and (len(f)-1)%2==0: state['rpm']=[float(v) for v in f[1:]]","  elif len(f)==7 and kind=='ODOM':","   x,y,yaw,vx,vy,wz=map(float,f[1:]); now=n.get_clock().now().to_msg(); qz=math.sin(yaw/2); qw=math.cos(yaw/2); m=Odometry(); m.header.stamp=now; m.header.frame_id='odom'; m.child_frame_id='base_link'; m.pose.pose.position.x=x; m.pose.pose.position.y=y; m.pose.pose.orientation.z=qz; m.pose.pose.orientation.w=qw; m.twist.twist.linear.x=vx; m.twist.twist.linear.y=vy; m.twist.twist.angular.z=wz; odom_pub.publish(m)","   t=TransformStamped(); t.header=m.header; t.child_frame_id='base_link'; t.transform.translation.x=x; t.transform.translation.y=y; t.transform.rotation.z=qz; t.transform.rotation.w=qw; tf_pub.sendTransform(t)",' except ValueError: pass',
            "n.create_subscription(OccupancyGrid,'/map',map_cb,MAPQ)","n.create_subscription(LaserScan,'/scan',scan_cb,BE)","n.create_subscription(Odometry,'/odom',odom_cb,BE)","n.create_subscription(TFMessage,'/tf',tf_cb,BE)",'last_emit=0.0',
            'while rclpy.ok():',' rclpy.spin_once(n,timeout_sec=0.02)',' now=time.monotonic()',' if select.select([sys.stdin],[],[],0)[0]:',"  line=sys.stdin.readline().strip().split()","  if len(line)==3 and line[0]=='CMD':","   try: send('V %.4f 0 %.4f'%(float(line[1]),float(line[2]))); last_cmd=now","   except (ValueError,OSError): pass","  elif len(line)==5 and line[0]=='R':","   try:","    values=[float(value) for value in line[1:]]","    if all(math.isfinite(value) and abs(value)<=5000 for value in values): send('R '+' '.join('%.4f'%value for value in values)); last_cmd=now","   except (ValueError,OSError): pass","  elif line and line[0]=='STOP': send('S'); last_cmd=0.0",' try:',"  chunk=ser.read(ser.in_waiting or 0)",'  if chunk: serial_buf+=chunk',"  while b'\\n' in serial_buf:","   raw,serial_buf=serial_buf.split(b'\\n',1); serial_line(raw.rstrip(b'\\r').decode('ascii',errors='replace').strip())",' except OSError: pass',' if last_cmd and now-last_cmd>.35: send(\'S\'); last_cmd=0.0',' if now-last_emit>=.12:','  last_emit=now',"  print(json.dumps({'map':state['map'],'scan':state['scan'],'odom':state['odom'],'controller':{'connected':True,'port':PORT,'tx':state['tx'],'ready':state['ready'],'rpm':state['rpm']},'receivedAt':int(time.time()*1000)},separators=(',',':')),flush=True)","  state['map']=None; state['scan']=None","try: send('S'); ser.close()","except: pass",'n.destroy_node(); rclpy.shutdown()'
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_roside_mapping_live.py',content:pyLines.join('\n')}).then(()=>{
            const setup=`source ${remoteShellPath(src)} 2>/dev/null; source ${remoteShellPath(root+'/install/setup.bash')} 2>/dev/null || true; python3 -u /tmp/_roside_mapping_live.py\n`;
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:setup}));ws.send(JSON.stringify({type:'ready',controllerPort:port,baud,topics:['/map','/scan','/odom']}));
          }).catch(e=>rejectStreamInit(e.message));
        } else if(pathname==='/ws/navigation'){
          const root=(sess.workspace||'~/ros2_ws').replace(/\/$/,'');const port=String(msg.controllerPort||''),baud=Math.trunc(Number(msg.controllerBaud)),pidCommand=String(msg.pidCommand||'').trim(),maxSpeed=Number(msg.maxSpeed),maxTurn=Number(msg.maxTurn),minSpeed=Number(msg.minSpeed),minTurn=Number(msg.minTurn);
          if(!SERIAL_DEVICE_PATTERN.test(port)||!Number.isInteger(baud)||baud<9600||baud>3000000||!Number.isFinite(maxSpeed)||maxSpeed<.05||maxSpeed>10||!Number.isFinite(maxTurn)||maxTurn<.1||maxTurn>10||!Number.isFinite(minSpeed)||minSpeed<.03||minSpeed>Math.min(10,maxSpeed)||!Number.isFinite(minTurn)||minTurn<.1||minTurn>Math.min(10,maxTurn)||!(/^(?:|P(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)){6})$/.test(pidCommand))){rejectStreamInit('Controller configuration หรือแรงออกตัวไม่ถูกต้อง');return;}
          const pyLines=[
            '# ros2ide_navigation_live','import json,math,select,sys,time','import rclpy,serial','from action_msgs.msg import GoalStatus','from geometry_msgs.msg import PoseStamped,PoseWithCovarianceStamped,TransformStamped,Twist','from nav2_msgs.action import NavigateToPose,NavigateThroughPoses','from nav_msgs.msg import OccupancyGrid,Odometry,Path','from nav_msgs.srv import GetMap','from sensor_msgs.msg import LaserScan','from tf2_ros import TransformBroadcaster','from rclpy.action import ActionClient','from rclpy.parameter import Parameter','from rclpy.parameter_client import AsyncParameterClient','from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy',
            'BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)','MAPQ=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)',`PORT=${JSON.stringify(port)}; BAUD=${baud}; PID=${JSON.stringify(pidCommand)}; MAX_SPEED=${maxSpeed}; MAX_TURN=${maxTurn}; MIN_SPEED=${minSpeed}; MIN_TURN=${minTurn}`,"state={'map':None,'scan':None,'pose':None,'path':None,'tx':'S','nav':'idle','remaining':0}",'serial_buf=b\'\'','last_cmd=0.0','goal_handle=None','map_received=False','map_future=None','next_map_request=0.0',
            'def emit(**v): print(json.dumps(v,separators=(\',\',\':\')),flush=True)','try:'," ser=serial.Serial(PORT,BAUD,timeout=0); emit(event='controller_connected',port=PORT,baud=BAUD)",'except Exception as e:'," emit(event='controller_error',port=PORT,message=str(e)); sys.exit(2)",'rclpy.init()',"n=rclpy.create_node('ros2ide_navigation_live')","odom_pub=n.create_publisher(Odometry,'/odom',20)","initial_pub=n.create_publisher(PoseWithCovarianceStamped,'/initialpose',10)",'tf_pub=TransformBroadcaster(n)',"client=ActionClient(n,NavigateToPose,'navigate_to_pose')","route_client=ActionClient(n,NavigateThroughPoses,'navigate_through_poses')","map_client=n.create_client(GetMap,'/map_server/map')","controller_params=AsyncParameterClient(n,'/controller_server')","smoother_params=AsyncParameterClient(n,'/velocity_smoother')",
            'def send(c):'," ser.write((c+'\\n').encode('ascii')); state['tx']=c",'def quat(yaw): return math.sin(yaw/2),math.cos(yaw/2)',
            'def map_cb(m):',' global map_received'," step=max(1,int(math.ceil(max(m.info.width,m.info.height)/360.0)))"," data=[int(m.data[y*m.info.width+x]) for y in range(0,m.info.height,step) for x in range(0,m.info.width,step)]"," state['map']={'width':(m.info.width+step-1)//step,'height':(m.info.height+step-1)//step,'resolution':m.info.resolution*step,'originX':m.info.origin.position.x,'originY':m.info.origin.position.y,'data':data}; map_received=True",'def map_service_cb(f):',' global map_future',' map_future=None',' try: map_cb(f.result().map)',' except Exception: pass','def request_map():',' global map_future',' if not map_received and map_future is None and map_client.service_is_ready():',"  map_future=map_client.call_async(GetMap.Request()); map_future.add_done_callback(map_service_cb)",'map_timer=n.create_timer(1.0,request_map)',"emit(event='bridge_ready',map_service='/map_server/map',scan_topic='/scan')",
            'def scan_cb(m):',' step=max(1,len(m.ranges)//360)'," state['scan']={'frame':m.header.frame_id,'angleMin':m.angle_min,'angleIncrement':m.angle_increment*step,'ranges':[float(v) if math.isfinite(v) else None for v in m.ranges[::step]]}",
            'def pose_cb(m):',' p=m.pose.pose; q=p.orientation'," state['pose']={'x':p.position.x,'y':p.position.y,'yaw':math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))}",'def path_cb(m):'," step=max(1,len(m.poses)//300); state['path']=[{'x':p.pose.position.x,'y':p.pose.position.y} for p in m.poses[::step]]",'def commanded_speed(value,target):'," return math.copysign(target,value) if abs(value)>1e-5 else 0.0",'def apply_nav_speed():'," controller_params.set_parameters([Parameter('FollowPath.max_vel_x',value=float(MAX_SPEED)),Parameter('FollowPath.max_speed_xy',value=float(MAX_SPEED)),Parameter('FollowPath.desired_linear_vel',value=float(MAX_SPEED)),Parameter('FollowPath.max_vel_theta',value=float(MAX_TURN)),Parameter('FollowPath.rotate_to_heading_angular_vel',value=float(MAX_TURN))])"," smoother_params.set_parameters([Parameter('max_velocity',value=[float(MAX_SPEED),0.0,float(MAX_TURN)]),Parameter('min_velocity',value=[-float(MAX_SPEED),0.0,-float(MAX_TURN)])])",'def cmd_cb(m):'," global last_cmd"," if sequence.blocks_motion(): send('S'); last_cmd=0.0; return"," vx=commanded_speed(m.linear.x,MAX_SPEED); wz=commanded_speed(m.angular.z,MAX_TURN); send('S' if abs(vx)<1e-5 and abs(wz)<1e-5 else 'V %.4f 0 %.4f'%(vx,wz)); last_cmd=time.monotonic()",
            'def serial_line(line):',' f=line.replace(\',\',\' \').split(); kind=f[0].upper() if f else \"\"',' try:',"  if kind=='ROSIDE_CONTROLLER_READY' and PID: send(PID)","  elif kind=='ODOM' and len(f)==7:","   x,y,yaw,vx,vy,wz=map(float,f[1:]); stamp=n.get_clock().now().to_msg(); qz,qw=quat(yaw); m=Odometry(); m.header.stamp=stamp; m.header.frame_id='odom'; m.child_frame_id='base_link'; m.pose.pose.position.x=x; m.pose.pose.position.y=y; m.pose.pose.orientation.z=qz; m.pose.pose.orientation.w=qw; m.twist.twist.linear.x=vx; m.twist.twist.linear.y=vy; m.twist.twist.angular.z=wz; odom_pub.publish(m)","   t=TransformStamped(); t.header=m.header; t.child_frame_id='base_link'; t.transform.translation.x=x; t.transform.translation.y=y; t.transform.rotation.z=qz; t.transform.rotation.w=qw; tf_pub.sendTransform(t)",' except ValueError: pass',
            'def result_cb(f):'," global goal_handle; r=f.result(); state['nav']='succeeded' if r.status==GoalStatus.STATUS_SUCCEEDED else 'canceled' if r.status==GoalStatus.STATUS_CANCELED else 'aborted'; state['remaining']=0; goal_handle=None; send('S')",'def feedback_cb(f):'," state['remaining']=int(getattr(f.feedback,'number_of_poses_remaining',state['remaining']))",'def goal_response(f):'," global goal_handle; goal_handle=f.result(); state['nav']='active' if goal_handle.accepted else 'rejected'"," if goal_handle.accepted: goal_handle.get_result_async().add_done_callback(result_cb)",'def stamped_pose(x,y,yaw):'," qz,qw=quat(yaw); p=PoseStamped(); p.header.frame_id='map'; p.header.stamp=n.get_clock().now().to_msg(); p.pose.position.x=x; p.pose.position.y=y; p.pose.orientation.z=qz; p.pose.orientation.w=qw; return p",'def goal(x,y,yaw):'," g=NavigateToPose.Goal(); g.pose=stamped_pose(x,y,yaw)"," if not client.wait_for_server(timeout_sec=1.0): state['nav']='server_unavailable'; return"," state['remaining']=1; state['nav']='sending'; client.send_goal_async(g,feedback_callback=feedback_cb).add_done_callback(goal_response)",'def route(points):'," g=NavigateThroughPoses.Goal(); g.poses=[stamped_pose(float(p['x']),float(p['y']),float(p.get('yaw',0))) for p in points]"," if not g.poses or not route_client.wait_for_server(timeout_sec=1.0): state['nav']='server_unavailable'; return"," state['remaining']=len(g.poses); state['nav']='sending_route'; route_client.send_goal_async(g,feedback_callback=feedback_cb).add_done_callback(goal_response)",
            'def initial(x,y,yaw):'," qz,qw=quat(yaw); m=PoseWithCovarianceStamped(); m.header.frame_id='map'; m.pose.pose.position.x=x; m.pose.pose.position.y=y; m.pose.pose.orientation.z=qz; m.pose.pose.orientation.w=qw; m.pose.covariance[0]=.25; m.pose.covariance[7]=.25; m.pose.covariance[35]=.0685"," for _ in range(3): m.header.stamp=n.get_clock().now().to_msg(); initial_pub.publish(m)",
            fs_node.readFileSync(path.join(__dirname,'navigation-sequence.py'),'utf8'),
            'def sequence_publish(snapshot):'," state['sequence']=snapshot; state['nav']=snapshot['phase']; state['remaining']=snapshot['total']-snapshot['completed']",
            "sequence=NavigationSequence(client,NavigateToPose.Goal,stamped_pose,lambda:send('S'),sequence_publish)",
            "n.create_subscription(OccupancyGrid,'/map',map_cb,MAPQ)","n.create_subscription(LaserScan,'/scan',scan_cb,BE)","n.create_subscription(PoseWithCovarianceStamped,'/amcl_pose',pose_cb,10)","n.create_subscription(Path,'/plan',path_cb,10)","n.create_subscription(Twist,'/cmd_vel',cmd_cb,20)",'apply_nav_speed()','last_emit=0.0','while rclpy.ok():',' rclpy.spin_once(n,timeout_sec=.005)',' now=time.monotonic()',' if select.select([sys.stdin],[],[],0)[0]:',"  raw_input=sys.stdin.readline().strip(); f=raw_input.split()",'  try:',"   if len(f)==4 and f[0]=='POSE': sequence.clear(); initial(*map(float,f[1:]))","   elif len(f)==4 and f[0]=='GOAL': sequence.clear(); goal(*map(float,f[1:]))","   elif len(f)==5 and f[0]=='SPEED': MAX_SPEED,MAX_TURN,MIN_SPEED,MIN_TURN=map(float,f[1:]); apply_nav_speed(); emit(event='speed_updated',speed={'max':MAX_SPEED,'turn':MAX_TURN,'min':MIN_SPEED,'min_turn':MIN_TURN})","   elif raw_input.startswith('ROUTE '): sequence.clear(); route(json.loads(raw_input[6:]))","   elif raw_input.startswith('SEQUENCE '):","    job=json.loads(raw_input[9:])","    if goal_handle is not None or not sequence.start(job['runId'],job['points']): emit(event='sequence_error',message='A navigation goal or sequence is already active')","   elif f and f[0]=='CANCEL': sequence.cancel(); goal_handle and goal_handle.cancel_goal_async(); state['nav']='canceled'; state['remaining']=0; send('S')",'  except (ValueError,TypeError,KeyError,json.JSONDecodeError): state[\'nav\']=\'invalid_route\'',' sequence.tick()',' try:',"  chunk=ser.read(ser.in_waiting or 0)",'  if chunk: serial_buf+=chunk',"  while b'\\n' in serial_buf:","   raw,serial_buf=serial_buf.split(b'\\n',1); serial_line(raw.rstrip(b'\\r').decode('ascii',errors='replace').strip())",' except OSError: pass'," if last_cmd and now-last_cmd>.5: send('S'); last_cmd=0.0",' if now-last_emit>=.06:','  last_emit=now',"  emit(map=state['map'],scan=state['scan'],pose=state['pose'],path=state['path'],controller={'connected':True,'tx':state['tx']},nav=state['nav'],remaining=state['remaining'],sequence=state.get('sequence'),receivedAt=int(time.time()*1000)); state['map']=None; state['scan']=None; state['path']=None","try: send('S'); ser.close()","except: pass",'n.destroy_node(); rclpy.shutdown()'
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_roside_navigation_live.py',content:pyLines.join('\n')}).then(()=>{const setup=`pkill -TERM -f '[_]roside_navigation_live.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch roside_controller_bridge controller_bridge.launch.py' 2>/dev/null || true; pkill -TERM -f '[c]ontroller_bridge.py --ros-args' 2>/dev/null || true; sleep 0.4; pkill -KILL -f '[_]roside_navigation_live.py' 2>/dev/null || true; if command -v fuser >/dev/null 2>&1; then fuser -k ${shellQuote(port)} 2>/dev/null || true; fi; source ${remoteShellPath(src)} 2>/dev/null; source ${remoteShellPath(root+'/install/setup.bash')} 2>/dev/null || true; nav_script=/tmp/_roside_navigation_\$(printf live).py; mkdir -p ${remoteShellPath(navigationRuntimePaths(sess).runtime)}; exec python3 -u "$nav_script" 2> ${remoteShellPath(navigationRuntimePaths(sess).runtime+'/bridge.log')}\n`;ag.ws.send(JSON.stringify({type:'pty_input',termId,data:setup}));ws.send(JSON.stringify({type:'ready',controllerPort:port,baud,directSpeed:true,maxSpeed,maxTurn}));}).catch(e=>rejectStreamInit(e.message));
        } else if(pathname==='/ws/rviz'){
          const oTopic=rvizTopics.odom,lTopic=rvizTopics.laser,mTopic=rvizTopics.map,pTopic=rvizTopics.path;
          const pyLines=["# ros2ide_rviz_rt","import rclpy,json,sys,math,threading,time,signal","from rclpy.node import Node","from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy","BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)","ST=QoSProfile(depth=100,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)","buf={'tf':{},'odom':None,'scan':None,'tf_seen':{}}","lk=threading.Lock()","running=True","def stop(s,f): global running; running=False","signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)","class N(Node):"," def __init__(self):","  super().__init__('ros2ide_rviz_rt')","  from tf2_msgs.msg import TFMessage","  self.create_subscription(TFMessage,'/tf',self.cb_tf,BE)","  self.create_subscription(TFMessage,'/tf_static',self.cb_tf,ST)",...(oTopic!=='none'?["  from nav_msgs.msg import Odometry",`  self.create_subscription(Odometry,'${oTopic}',self.cb_od,BE)`]:[]),...(lTopic!=='none'?["  from sensor_msgs.msg import LaserScan",`  self.create_subscription(LaserScan,'${lTopic}',self.cb_sc,BE)`]:[]),["  from std_msgs.msg import String","  self._last_desc=None","  self.create_subscription(String,'/robot_description',self.cb_desc,ST)"]," def cb_tf(self,m):"," with lk:","  for t in m.transforms:","   tr,ro=t.transform.translation,t.transform.rotation","   buf['tf'][t.child_frame_id]={'frame':t.child_frame_id,'parent':t.header.frame_id,'x':tr.x,'y':tr.y,'z':tr.z,'qx':ro.x,'qy':ro.y,'qz':ro.z,'qw':ro.w}; buf['tf_seen'][t.child_frame_id]=time.time()"," def cb_od(self,m):","  p=m.pose.pose","  with lk: buf['odom']={'x':p.position.x,'y':p.position.y,'qz':p.orientation.z,'qw':p.orientation.w}"," def cb_sc(self,m):","  r=[float(v) if not(math.isinf(v) or math.isnan(v)) else 0.0 for v in m.ranges]","  st=max(1,len(r)//360)","  with lk: buf['scan']={'amin':m.angle_min,'ainc':m.angle_increment*st,'ranges':r[::st]}"," def cb_desc(self,m):","  if m.data and m.data!=self._last_desc:","   self._last_desc=m.data","   with lk: buf['desc']=m.data","rclpy.init()","n=N()","ex=rclpy.executors.SingleThreadedExecutor()","ex.add_node(n)","sys.stdout.write(json.dumps({'stream':'ready'},separators=(',',':'))+'\\n'); sys.stdout.flush()","last=time.time()","while running:"," ex.spin_once(timeout_sec=0.05)"," now=time.time()"," if now-last>=0.1:","  last=now","  with lk:","   for _k in list(buf['tf'].keys()):","    if now-buf['tf_seen'].get(_k,0)>8.0: buf['tf'].pop(_k,None); buf['tf_seen'].pop(_k,None)","   out={}","   if buf['tf']: out['tf']=list(buf['tf'].values())","   if buf['odom']: out['odom']=buf['odom']","   if buf['scan']: out['scan']=buf['scan']; buf['scan']=None","   if buf.get('desc') is not None: out['desc']=buf['desc']; buf['desc']=None","  try:","   sys.stdout.write(json.dumps(out,separators=(',',':'))+'\\n')","   sys.stdout.flush()","  except: pass","n.destroy_node(); rclpy.shutdown()"];
          pyLines.splice(0,pyLines.length,...pyLines.flat());
          const tfLockLine=pyLines.indexOf(' with lk:');if(tfLockLine>=0){pyLines[tfLockLine]='  with lk:';for(let index=tfLockLine+1;index<pyLines.length&&!pyLines[index].startsWith(' def cb_od');index++)pyLines[index]=' '+pyLines[index];}
          const bufferLine=pyLines.indexOf("buf={'tf':{},'odom':None,'scan':None,'tf_seen':{}}");
          if(bufferLine>=0)pyLines[bufferLine]="buf={'tf':{},'odom':None,'scan':None,'map':None,'map_dirty':False,'path':None,'desc':None,'desc_dirty':False,'tf_seen':{}}";
          const descriptionBuffer=pyLines.indexOf("   with lk: buf['desc']=m.data");if(descriptionBuffer>=0)pyLines[descriptionBuffer]="   with lk: buf['desc']=m.data; buf['desc_dirty']=True";
          const descriptionImport=pyLines.indexOf('  from std_msgs.msg import String'),topicSubscriptions=[];
          if(isSim(sess.robotKey)&&descriptionImport>=0)pyLines.splice(descriptionImport+1,0,"  self.create_subscription(String,'/nav_status',self.cb_nav_status,ST)");
          if(mTopic!=='none')topicSubscriptions.push('  from nav_msgs.msg import OccupancyGrid',`  self.create_subscription(OccupancyGrid,'${mTopic}',self.cb_map,ST)`);
          if(pTopic!=='none')topicSubscriptions.push('  from nav_msgs.msg import Path',`  self.create_subscription(Path,'${pTopic}',self.cb_path,BE)`);
          if(descriptionImport>=0&&topicSubscriptions.length)pyLines.splice(descriptionImport,0,...topicSubscriptions);
          const callbacks=[];
          if(isSim(sess.robotKey))callbacks.push(' def cb_nav_status(self,m):',"  try: status=json.loads(m.data)","  except (ValueError,TypeError): return","  with lk: buf['nav_status']=status");
          if(mTopic!=='none')callbacks.push(' def cb_map(self,m):','  w,h=int(m.info.width),int(m.info.height)','  step=max(1,int(math.ceil(max(w,h)/480.0))) if w and h else 1',"  data=[int(m.data[y*w+x]) for y in range(0,h,step) for x in range(0,w,step)]","  candidate={'w':(w+step-1)//step,'h':(h+step-1)//step,'res':m.info.resolution*step,'ox':m.info.origin.position.x,'oy':m.info.origin.position.y,'data':data}","  with lk:","   if candidate != buf.get('map'): buf['map']=candidate; buf['map_dirty']=True");
          if(pTopic!=='none')callbacks.push(' def cb_path(self,m):',"  step=max(1,len(m.poses)//500)","  with lk: buf['path']=[{'x':p.pose.position.x,'y':p.pose.position.y,'z':p.pose.position.z} for p in m.poses[::step]]");
          const runtimeInit=pyLines.indexOf('rclpy.init()');if(runtimeInit>=0&&callbacks.length)pyLines.splice(runtimeInit,0,...callbacks);
          const executorAdded=pyLines.indexOf("ex.add_node(n)");if(executorAdded>=0)pyLines.splice(executorAdded+1,0,"last_keyframe=0.0");
          const nowLine=pyLines.indexOf(" now=time.time()");if(nowLine>=0)pyLines.splice(nowLine+1,0," keyframe=now-last_keyframe>=2.0"," if keyframe: last_keyframe=now");
          const outputInit=pyLines.indexOf('   out={}');if(outputInit>=0)pyLines[outputInit]="   out={'stream':'ready'}";
          if(isSim(sess.robotKey)&&outputInit>=0)pyLines.splice(outputInit+1,0,"   if buf.get('nav_status') is not None: out['nav_status']=buf.pop('nav_status')");
          const scanCallback=pyLines.indexOf("  with lk: buf['scan']={'amin':m.angle_min,'ainc':m.angle_increment*st,'ranges':r[::st]}");
          if(scanCallback>=0)pyLines[scanCallback]="  with lk: buf['scan']={'frame':m.header.frame_id,'amin':m.angle_min,'ainc':m.angle_increment*st,'ranges':r[::st]}";
          const scanOutput=pyLines.indexOf("   if buf['scan']: out['scan']=buf['scan']; buf['scan']=None");
          if(scanOutput>=0)pyLines.splice(scanOutput+1,0,"   if buf.get('map') is not None and (buf.get('map_dirty') or keyframe): out['map']=buf['map']; buf['map_dirty']=False","   if buf.get('path') is not None: out['path']=buf['path']; buf['path']=None");
          const descriptionOutput=pyLines.indexOf("   if buf.get('desc') is not None: out['desc']=buf['desc']; buf['desc']=None");
          if(descriptionOutput>=0)pyLines[descriptionOutput]="   if buf.get('desc') is not None and (buf.get('desc_dirty') or keyframe): out['desc']=buf['desc']; buf['desc_dirty']=False";
          // `stream:ready` is a lightweight heartbeat as well as the startup
          // handshake.  Repeating it prevents a lost first PTY frame from
          // leaving the browser in a permanent "bridge missing" state.
          const runtimePath=`/tmp/_rviz_rt_${termId.slice(5,21)}.py`;
          agentReq(sess.robotKey,'fs_write',{path:runtimePath,content:pyLines.join('\n')}).then(()=>
            agentReq(sess.robotKey,'exec',{command:`python3 -m py_compile ${shellQuote(runtimePath)}`,timeout:5000},7000)
          ).then(compiled=>{
            if(compiled.code!==0)throw new Error(`RViz bridge compile ไม่ผ่าน: ${String(compiled.stderr||compiled.stdout||'unknown syntax error').slice(-1200)}`);
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:`source ${remoteShellPath(src)} 2>/dev/null; exec python3 -u ${shellQuote(runtimePath)}\n`}));
            if(sharedSimRvizStream)markSimRvizReady(sharedSimRvizStream,sess.rosInfo);
            else sendWebSocketJson(ws,{type:'ready',rosInfo:sess.rosInfo});
          }).catch(e=>rejectStreamInit(e.message));
        } else {
          const configuredWorkspace=String(sess.workspace||'~/ros2_ws');
          const quote=value=>`'${String(value).replace(/'/g,`'\\''`)}'`;
          const terminalSetup=`ROSIDE_WS=${quote(configuredWorkspace)}; case "$ROSIDE_WS" in '~') ROSIDE_WS="$HOME";; '~/'*) ROSIDE_WS="$HOME/\${ROSIDE_WS:2}";; esac; cd "$ROSIDE_WS" 2>/dev/null || cd "$HOME"; source ${quote(src)} 2>/dev/null; [ -f install/setup.bash ] && source install/setup.bash 2>/dev/null\n`;
          ag.ws.send(JSON.stringify({type:'pty_input',termId,data:terminalSetup}));ws.send(JSON.stringify({type:'ready',rosInfo:sess.rosInfo,workspace:configuredWorkspace}));
        }
      }
      else if(msg.type==='command'&&pathname==='/ws/controller-tune'){
        const command=String(msg.command||'').trim(),number='-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)',motorCount=Number(ws.motorCount)||0,valid=new RegExp(`^(?:S|Z|V\\s+${number}\\s+${number}\\s+${number}|R(?:\\s+${number}){${motorCount}}|P(?:\\s+${number}){${motorCount*3}})$`);
        const ag=agents.get(ws.robotKey);if(valid.test(command)&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:command+'\n'}));else ws.send(JSON.stringify({type:'error',message:'Invalid controller command'}));
      }
      else if(msg.type==='command'&&pathname==='/ws/mapping'){
        const safeCommand=require('./public/real-drive-motion').mappingCommand(msg.command);
        const ag=agents.get(ws.robotKey);if(safeCommand&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:safeCommand+'\n'}));else if(!safeCommand)ws.send(JSON.stringify({type:'error',message:'ความเร็ว Mapping ไม่ถูกต้อง'}));
      }
      else if(msg.type==='command'&&pathname==='/ws/navigation'){
        const command=String(msg.command||'').trim(),number='-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)',valid=new RegExp(`^(?:CANCEL|(?:POSE|GOAL)\\s+${number}\\s+${number}\\s+${number}|SPEED\\s+${number}\\s+${number}\\s+${number}\\s+${number})$`),speed=command.match(/^SPEED\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/),speedValid=!speed||(Number(speed[1])>=.05&&Number(speed[1])<=10&&Number(speed[2])>=.1&&Number(speed[2])<=10&&Number(speed[3])>=.03&&Number(speed[3])<=Math.min(10,Number(speed[1]))&&Number(speed[4])>=.1&&Number(speed[4])<=Math.min(10,Number(speed[2])));const ag=agents.get(ws.robotKey);if(valid.test(command)&&speedValid&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:command+'\n'}));else ws.send(JSON.stringify({type:'error',message:'Invalid Navigation command'}));
      }
      else if(msg.type==='sequence'&&pathname==='/ws/navigation'){
        const job=require('./navigation-sequence').validateSequence(msg),ag=agents.get(ws.robotKey);
        if(job&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:'SEQUENCE '+JSON.stringify(job)+'\n'}));
        else ws.send(JSON.stringify({type:'error',message:'Invalid Navigation sequence'}));
      }
      else if(msg.type==='route'&&pathname==='/ws/navigation'){
        const points=Array.isArray(msg.points)?msg.points:[],valid=points.length>0&&points.length<=50&&points.every(point=>['x','y','yaw'].every(key=>Number.isFinite(Number(point?.[key])))&&Math.abs(Number(point.x))<=10000&&Math.abs(Number(point.y))<=10000);const ag=agents.get(ws.robotKey);if(valid&&ag&&ws.termId){const safe=points.map(point=>({x:Number(point.x),y:Number(point.y),yaw:Number(point.yaw)}));ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:'ROUTE '+JSON.stringify(safe)+'\n'}));}else ws.send(JSON.stringify({type:'error',message:'Invalid Navigation route'}));
      }
      else if(msg.type==='data'){const ag=agents.get(ws.robotKey);if(ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:msg.data}));}
      else if(msg.type==='resize'){const ag=agents.get(ws.robotKey);if(ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_resize',termId:ws.termId,cols:msg.cols,rows:msg.rows}));}
    }
  });

  ws.on('close',()=>{
    if(agentAuthTimer)clearTimeout(agentAuthTimer);
    if(pathname==='/ws/agent'&&connId&&agents.get(connId)?.ws===ws){agents.delete(connId);failAgentWork(connId);broadcastStatus(connId,false);console.log(`[CLOUD] ❌ Agent disconnected: ${connId}`);}
    else if(detachSimRvizSubscriber(ws)){releaseControlLease(ws);}
    else if(connId){releaseControlLease(ws);webSockets.delete(connId);rvizBuffers.delete(connId);if(ws.robotKey){const ag=agents.get(ws.robotKey);if(ag)ag.ws.send(JSON.stringify({type:'pty_close',termId:connId}));}}
  });
});

setInterval(()=>{
  for(const ws of wss.clients){
    if(ws.isAlive===false){try{ws.terminate();}catch{}continue;}
    ws.isAlive=false;try{ws.ping();}catch{try{ws.terminate();}catch{}}
  }
},30000).unref();

setInterval(()=>{
  const now=Date.now(),released=new Set();
  for(const[id,session]of sessions){
    if(!((session.expiresAt&&session.expiresAt<now)||(isSim(session.robotKey)&&now-(session.lastSeen||0)>SIM_SESSION_IDLE_MS)))continue;
    sessions.delete(id);closeOperationalSockets(session.userId,session.robotKey,'Session expired');closeRobotPresence(session.userId,session.robotKey);released.add(session.robotKey);
    const sql=session.connectionId?'UPDATE robot_connections SET disconnected_at=COALESCE(disconnected_at,NOW()) WHERE id=?':'UPDATE robot_connections SET disconnected_at=COALESCE(disconnected_at,NOW()) WHERE robot_id=? AND user_id=? AND disconnected_at IS NULL';
    db.query(sql,session.connectionId?[session.connectionId]:[session.robotDbId,session.userId]).catch(()=>{});
  }
  released.forEach(releaseSimRuntimeIfUnused);
  for(const[code,ticket]of applicationLaunchTickets)if(ticket.expiresAt<now)applicationLaunchTickets.delete(code);
  for(const[ip,ts]of loginAttempts){const fresh=ts.filter(t=>now-t<15*60*1000);fresh.length?loginAttempts.set(ip,fresh):loginAttempts.delete(ip);}
  for(const[key,entry]of authSessionCache)if(entry.expiresAt<=now)authSessionCache.delete(key);
  for(const[key,entry]of membershipCache)if(entry.expiresAt<=now)membershipCache.delete(key);
  for(const[key,entry]of applicationCatalogCache)if(entry.expiresAt<=now)applicationCatalogCache.delete(key);
},60*1000).unref();

async function ensureDatabaseIndex(table,indexName,definition){
  const[rows]=await db.query('SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? LIMIT 1',[table,indexName]);
  if(!rows.length)await db.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${definition})`);
}

async function ensureRobotKeyColumnLength(){
  const[rows]=await db.query("SELECT character_maximum_length length FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='robots' AND column_name='robot_key' LIMIT 1");
  if(Number(rows[0]?.length||0)<80)await db.query('ALTER TABLE robots MODIFY robot_key VARCHAR(80) NOT NULL');
}

async function ensureAgentVersionColumn(){
  const[rows]=await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='robots' AND column_name='agent_version' LIMIT 1");
  if(!rows.length)await db.query('ALTER TABLE robots ADD COLUMN agent_version VARCHAR(32) NULL');
}

async function start(){
  if(localRuntime){server.listen(PORT,localRuntime.config.local_host||'0.0.0.0',()=>console.log(`[LOCAL] ROSIDE on port ${PORT}; no MySQL, no Sim runtime`));return;}
  try{
    await db.query('SELECT 1');
    await db.query('DELETE FROM sessions WHERE expires_at<=NOW()');
    await ensureRobotKeyColumnLength();
    await ensureAgentVersionColumn();
    await db.query("CREATE TABLE IF NOT EXISTS robot_user_access (robot_id INT NOT NULL,user_id INT NOT NULL,alias VARCHAR(128) NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(robot_id,user_id),INDEX idx_robot_access_user_created(user_id,created_at,robot_id),FOREIGN KEY(robot_id) REFERENCES robots(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)");
    await db.query('INSERT IGNORE INTO robot_user_access(robot_id,user_id) SELECT id,added_by FROM robots WHERE added_by IS NOT NULL');
    await ensureClusterSchema(db);
    // This deployment runs one Master process. No Sim runtime survives its
    // restart, so release leases immediately instead of blocking reconnects.
    await db.query('DELETE FROM cluster_sim_leases');
    await db.query('UPDATE robot_connections SET disconnected_at=NOW() WHERE disconnected_at IS NULL');
    await ensureDatabaseIndex('robot_connections','idx_robot_connections_robot_id','robot_id,id');
    await ensureDatabaseIndex('robot_connections','idx_robot_connections_user_open','user_id,disconnected_at,id');
    await db.query("CREATE TABLE IF NOT EXISTS user_subscriptions (id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id INT NOT NULL UNIQUE,plan_code ENUM('pro_monthly','pro_yearly','pro_lifetime') NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'active',provider VARCHAR(32) NOT NULL DEFAULT 'stripe',provider_customer_id VARCHAR(255) NULL,provider_subscription_id VARCHAR(255) NULL UNIQUE,starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at DATETIME NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)");
    await db.query("CREATE TABLE IF NOT EXISTS payment_events (id BIGINT AUTO_INCREMENT PRIMARY KEY,provider VARCHAR(32) NOT NULL,event_id VARCHAR(255) NOT NULL,event_type VARCHAR(128) NOT NULL,status VARCHAR(32) NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,processed_at DATETIME NULL,UNIQUE KEY uniq_provider_event(provider,event_id))");
    await db.query("CREATE TABLE IF NOT EXISTS support_chat_messages (id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id INT NOT NULL,message VARCHAR(1000) NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,INDEX idx_support_chat_created(created_at),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)");
    await db.query("CREATE TABLE IF NOT EXISTS applications (id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(128) NOT NULL, description VARCHAR(512) DEFAULT '', category VARCHAR(100) DEFAULT 'Application', icon VARCHAR(2048) DEFAULT '🚀', redirect_url VARCHAR(2048) NOT NULL, session_mode ENUM('none','ticket') NOT NULL DEFAULT 'none', enabled TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL)");
    await db.query("ALTER TABLE applications MODIFY icon VARCHAR(2048) NOT NULL DEFAULT '🚀'");
    await db.query("INSERT IGNORE INTO applications(slug,name,description,category,icon,redirect_url,session_mode,enabled,sort_order) VALUES('ros2-robotics','ROS2 Robotics','จัดการหุ่นยนต์ เชื่อมต่อเครื่องมือ ROS2 และเริ่มสร้างภารกิจหุ่นยนต์สุดเจ๋ง','Robotics & Coding','🤖','/robots','none',1,0)");
    await require('./build-agent-release').ensureRelease(__dirname);
    console.log('[DB] ✅ MySQL connected');
  }
  catch(e){console.error('[DB] ❌',e.message);process.exitCode=1;return;}
  server.listen(PORT,()=>{
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║   ROS2 IDE — Cloud Broker v5           ║`);
    console.log(`╠════════════════════════════════════════╣`);
    console.log(`║  Web UI : http://localhost:${PORT}          ║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
  });
  const releaseTimer=setInterval(()=>require('./build-agent-release').ensureRelease(__dirname).catch(error=>console.error('[AGENT RELEASE]',error.message)),30000);
  releaseTimer.unref?.();
}
async function shutdown(){
  agents.forEach(ag=>{try{ag.ws.close();}catch{}});
  wss.clients.forEach(ws=>{try{ws.close();}catch{}});
  server.close();
  await db.end().catch(()=>{});
}
process.once('SIGINT',()=>shutdown().finally(()=>process.exit(0)));
process.once('SIGTERM',()=>shutdown().finally(()=>process.exit(0)));
start();
