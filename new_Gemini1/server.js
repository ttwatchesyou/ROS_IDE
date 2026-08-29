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
const { createSimAgent, isSim, writeTfPackage, writeOdomPackage, writeMapsimPackage, genMapsimFiles, wsRoot } = require('./sim');
const { buildProjectScanScript, parseProjectScanOutput, scanLocalProject, inspectSimulationMissionArtifacts, readSimulationWizardProgress, resetSimulationWizardAfterFieldChange, completeSimulationWizardMapping, completeSimulationWizardNavigation } = require('./project-scanner');
const { writeNavigationPackage, writeProjectInstaller } = require('./navigation-export');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });
const PORT   = process.env.PORT || 3001;
const localEnvironment=(()=>{try{return Object.fromEntries(fs_node.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')&&line.includes('=')).map(line=>{const at=line.indexOf('='),key=line.slice(0,at),raw=line.slice(at+1).trim(),value=((raw.startsWith('"')&&raw.endsWith('"'))||(raw.startsWith("'")&&raw.endsWith("'")))?raw.slice(1,-1):raw;return[key,value];}));}catch{return{};}})();
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
app.post('/api/billing/webhook',express.raw({type:'application/json',limit:'1mb'}),stripeWebhook);
app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));
// 🧹 ห้ามแคชฝั่งเบราว์เซอร์สำหรับ js/html/css — กันโหลด rviz.js/app.js ตัวเก่าแคชไว้
//    (สาเหตุที่แก้โค้ดแล้วอาการเดิมยังอยู่ บ่อยครั้งคือเบราว์เซอร์รัน JS ตัวเก่า)
app.use((req,res,next)=>{
  if(/\.(js|html|css|map)$/.test(req.path||'')) res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
  res.setHeader('X-Content-Type-Options','nosniff');
  // YouTube embeds require the parent origin as referrer for client identification.
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https: data: blob:; connect-src 'self' ws: wss:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const db = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '-Palamad007',
  database: process.env.DB_NAME || 'ros2ide',
  waitForConnections: true, connectionLimit: 10,
});

// In-memory
const agents       = new Map(); // robot_key → { ws, lastSeen }
const sessions     = new Map(); // sessionId → { robotKey, robotDbId, rosInfo, workspace, username, userId }
const pendingReqs  = new Map();
const webSockets   = new Map();
const rvizBuffers  = new Map();
const monSockets   = new Map();
const statusSubs   = new Set();
const loginAttempts= new Map();
const supportChatLastPost = new Map();
const supportChatPresence = new Map();
const projectScanCache = new Map(); // sessionId -> { expiresAt, promise }
const robotProgressCache = new Map(); // robot key -> { expiresAt, promise }
const mapsimLaunches = new Set(); // robot key while MapSim build/start is in progress
const applicationLaunchTickets = new Map(); // one-time SSO code -> { user, applicationId, expiresAt }
const activeSessionReservations = new Map(); // user id -> Set<robot db id> while connection is opening

const mkId = () => crypto.randomBytes(32).toString('hex');
// สร้าง sim agent ถ้ายังไม่มี + แจ้ง status ให้ frontend เปิดปุ่ม Open IDE ได้
function ensureSim(k){
  if (!agents.has(k)) {
    agents.set(k, createSimAgent(k, { pendingReqs, monSockets, webSockets, WebSocket }));
    broadcastStatus(k, true);
  }
}
// SIM robot ถือว่า online เสมอ (ไม่ต้องมี agent เชื่อมจริง) + สร้าง agent ทันทีเพื่อให้ขึ้นใน status snapshot
const robotOnline = k => {
  if (isSim(k)) return true;
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

async function getMembership(user){
  if(user.role==='admin')return{planCode:'admin',name:'Admin',isPro:true,isUnlimited:true,status:'active',startsAt:null,expiresAt:null};
  const[rows]=await db.query("SELECT plan_code,status,starts_at,expires_at,provider FROM user_subscriptions WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1",[user.id]);
  if(!rows.length)return{planCode:'free',name:'Free',isPro:false,isUnlimited:false,status:'active',startsAt:null,expiresAt:null};
  const row=rows[0],plan=BILLING_PLANS[row.plan_code]||BILLING_PLANS.free;
  return{planCode:row.plan_code,name:plan.name,isPro:true,isUnlimited:true,status:row.status,startsAt:row.starts_at,expiresAt:row.expires_at,provider:row.provider};
}

function agentReq(robot_key, action, payload, ms=15000){
  // SIM: สร้าง fake agent ถ้ายังไม่มี (robot จำลองไม่ได้เชื่อมผ่าน /ws/agent จริง)
  if(isSim(robot_key) && !agents.has(robot_key))
    ensureSim(robot_key);
  return new Promise((resolve,reject)=>{
    const ag=agents.get(robot_key);
    if(!ag||ag.ws.readyState!==WebSocket.OPEN) return reject(new Error('Robot offline'));
    const reqId=mkId(), t=setTimeout(()=>{pendingReqs.delete(reqId);reject(new Error('Timeout'));},ms);
    pendingReqs.set(reqId,resp=>{clearTimeout(t); resp.ok?resolve(resp.data):reject(new Error(resp.error));});
    try{ag.ws.send(JSON.stringify({type:'request',reqId,action,payload}));}
    catch(e){clearTimeout(t);pendingReqs.delete(reqId);reject(e);}
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
  if(!token) return null;
  const payload=verifyAuthToken(token);
  const sessionId=payload?.sid||token; // accept pre-JWT sessions until they expire
  const[rows]=await db.query('SELECT s.user_id,u.username,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>NOW()',[sessionId]);
  if(!rows.length)return null;
  return{id:rows[0].user_id,username:rows[0].username,role:rows[0].role,sessionId};
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
app.get('/',         (_,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
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
app.get('/api/applications',auth,async(req,res)=>{
  try{
    const where=req.user.role==='admin'?'':'WHERE enabled=1';
    const[rows]=await db.query(`SELECT id,slug,name,description,category,icon,redirect_url,session_mode,enabled,sort_order,created_at,updated_at FROM applications ${where} ORDER BY sort_order ASC, created_at ASC, id ASC`);
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
    res.status(201).json({ok:true,id:result.insertId});
  }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
});

app.put('/api/applications/:id',auth,adminOnly,async(req,res)=>{
  try{
    const a=applicationInput(req.body);
    const[result]=await db.query('UPDATE applications SET name=?,description=?,category=?,icon=?,redirect_url=?,session_mode=?,enabled=?,sort_order=? WHERE id=?',[a.name,a.description,a.category,a.icon,a.redirect_url,a.session_mode,a.enabled,a.sort_order,req.params.id]);
    if(!result.affectedRows)return res.status(404).json({ok:false,error:'Application not found'});
    res.json({ok:true});
  }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
});

app.delete('/api/applications/:id',auth,adminOnly,async(req,res)=>{
  try{
    const[result]=await db.query('DELETE FROM applications WHERE id=?',[req.params.id]);
    if(!result.affectedRows)return res.status(404).json({ok:false,error:'Application not found'});
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
const REAL_ROBOT_WIZARD_ORDER=['urdf','lidar','hardware','pid','control','mapping','navigation'];
const REAL_ROBOT_OPTIONAL_ORDER=[];
const ROBOT_LIMITS=Object.freeze({simulation:2,real:2,activeConnections:2});

async function getUserRobotQuota(user){
  const[rows]=await db.query("SELECT COALESCE(SUM(robot_key LIKE 'SIM-%'),0) simulation_count,COALESCE(SUM(robot_key NOT LIKE 'SIM-%'),0) real_count FROM robots WHERE added_by=?",[user.id]);
  const activeRobotIds=new Set([...sessions.values()].filter(session=>session.userId===user.id&&(!session.expiresAt||session.expiresAt>Date.now())).map(session=>session.robotDbId));
  const used={simulation:Number(rows[0]?.simulation_count)||0,real:Number(rows[0]?.real_count)||0,activeConnections:activeRobotIds.size};
  const membership=await getMembership(user),isUnlimited=membership.isUnlimited===true;
  return {
    limits:{simulation:isUnlimited?null:ROBOT_LIMITS.simulation,real:isUnlimited?null:ROBOT_LIMITS.real,activeConnections:ROBOT_LIMITS.activeConnections},
    unlimited:{simulation:isUnlimited,real:isUnlimited,activeConnections:false},
    used,
    remaining:{simulation:isUnlimited?null:Math.max(0,ROBOT_LIMITS.simulation-used.simulation),real:isUnlimited?null:Math.max(0,ROBOT_LIMITS.real-used.real),activeConnections:Math.max(0,ROBOT_LIMITS.activeConnections-used.activeConnections)},membership,
  };
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
    block('lidar',['urdf']);
    block('hardware',['urdf','lidar']);
    block('pid',['hardware']);
    block('custom_package',['hardware']);
    block('control',['hardware','pid']);
    block('mapping',['control','lidar']);
    block('navigation',['pid','mapping']);
  }
  const order=simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_WIZARD_ORDER;
  const optionalOrder=simulation?[]:REAL_ROBOT_OPTIONAL_ORDER;
  const completed=order.filter(id=>byId[id]?.detected===true).length;
  const optionalCompleted=optionalOrder.filter(id=>byId[id]?.detected===true).length;
  return {available:true,completed,total:order.length,percent:Math.round(completed/order.length*100),next:order.find(id=>!byId[id]?.detected)||null,optionalCompleted,optionalTotal:optionalOrder.length,checkedAt:Date.now()};
}

function inspectRobotWizardProgress(robot){
  const cached=robotProgressCache.get(robot.robot_key);
  if(cached&&cached.expiresAt>Date.now())return cached.promise;
  const simulation=isSim(robot.robot_key);
  const promise=Promise.resolve().then(async()=>{
    const order=simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_WIZARD_ORDER;
    if(!simulation&&!robotOnline(robot.robot_key))return {available:false,completed:0,total:order.length,percent:0,reason:'offline'};
    const workspace=simulation?wsRoot(robot.robot_key):(robot.workspace||'~/ros2_ws');
    let summary;
    if(simulation)summary=scanLocalProject(workspace);
    else{
      const script64=Buffer.from(buildProjectScanScript(workspace),'utf8').toString('base64');
      const result=await agentReq(robot.robot_key,'exec',{command:`python3 -c "import base64;exec(base64.b64decode('${script64}'))"`,timeout:15000});
      summary=parseProjectScanOutput(result.stdout);
    }
    if(simulation){
      const replacements=[inspectSimMapCapability(robot.robot_key),...inspectSimulationMissionArtifacts(workspace)];
      for(const capability of replacements){const index=summary.capabilities.findIndex(item=>item.id===capability.id);if(index>=0)summary.capabilities[index]=capability;else summary.capabilities.push(capability);}
    }
    return summarizeRobotWizard(summary.capabilities,simulation);
  }).catch(error=>({available:false,completed:0,total:(simulation?SIMULATION_WIZARD_ORDER:REAL_ROBOT_WIZARD_ORDER).length,percent:0,reason:error.message||'scan_failed'}));
  robotProgressCache.set(robot.robot_key,{expiresAt:Date.now()+30000,promise});
  return promise;
}

app.get('/api/robots',auth,async(req,res)=>{
  try{
    // Admin เห็นหุ่นยนต์ทั้งหมด / User ธรรมดา เห็นเฉพาะตัวที่ตนเองเพิ่ม
    let rows;
    if(req.user.role==='admin'){
      [rows]=await db.query('SELECT r.*,u.username as added_by_name,(SELECT connected_at FROM robot_connections rc WHERE rc.robot_id=r.id ORDER BY rc.id DESC LIMIT 1) as last_connected FROM robots r LEFT JOIN users u ON r.added_by=u.id ORDER BY r.created_at DESC, r.id DESC');
    } else {
      [rows]=await db.query('SELECT r.*,u.username as added_by_name,(SELECT connected_at FROM robot_connections rc WHERE rc.robot_id=r.id ORDER BY rc.id DESC LIMIT 1) as last_connected FROM robots r LEFT JOIN users u ON r.added_by=u.id WHERE r.added_by=? ORDER BY r.created_at DESC, r.id DESC',[req.user.id]);
    }
    const activeByRobot=new Map();
    for(const[sessionId,session]of sessions)if(session.userId===req.user.id&&(!session.expiresAt||session.expiresAt>Date.now()))activeByRobot.set(session.robotDbId,sessionId);
    const robots=await Promise.all(rows.map(async robot=>({...robot,ssh_pass:undefined,isOwn:Number(robot.added_by)===Number(req.user.id),online:robotOnline(robot.robot_key),connected:activeByRobot.has(robot.id),wizardProgress:await inspectRobotWizardProgress(robot)})));
    res.json({ok:true,robots,quota:await getUserRobotQuota(req.user),isAdmin:req.user.role==='admin'});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.post('/api/robots',auth,async(req,res)=>{
  const{robot_key,name,ssh_user,ssh_pass,workspace,description}=req.body;
  if(!robot_key||!name) return res.status(400).json({ok:false,error:'robot_key and name required'});
  if(!/^(SIM-)?[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(robot_key)) return res.status(400).json({ok:false,error:'Invalid robot key'});
  let connection,locked=false;
  try{
    connection=await db.getConnection();
    const[[lock]]=await connection.query('SELECT GET_LOCK(?,5) acquired',[`roside_robot_quota_${req.user.id}`]);
    if(Number(lock?.acquired)!==1)return res.status(503).json({ok:false,error:'ระบบกำลังบันทึกหุ่นยนต์รายการอื่น กรุณาลองใหม่'});
    locked=true;
    const[ex]=await connection.query('SELECT id FROM robots WHERE robot_key=?',[robot_key]);
    if(ex.length)return res.json({ok:false,error:'Robot key already registered'});
    const simulation=isSim(robot_key),kind=simulation?'simulation':'real';
    const membership=await getMembership(req.user);
    if(!membership.isUnlimited){
      const[countRows]=await connection.query("SELECT COALESCE(SUM(robot_key LIKE 'SIM-%'),0) simulation_count,COALESCE(SUM(robot_key NOT LIKE 'SIM-%'),0) real_count FROM robots WHERE added_by=?",[req.user.id]);
      const count=Number(countRows[0]?.[kind+'_count'])||0;
      if(count>=ROBOT_LIMITS[kind]){const quota=await getUserRobotQuota(req.user);return res.status(409).json({ok:false,code:simulation?'SIMULATION_LIMIT_REACHED':'REAL_ROBOT_LIMIT_REACHED',error:simulation?'ผู้ใช้สร้าง Simulation ได้สูงสุด 2 ตัว กรุณาลบตัวเดิมก่อนสร้างใหม่':'ผู้ใช้เพิ่มหุ่นยนต์จริงได้สูงสุด 2 ตัว กรุณาลบตัวเดิมก่อนเพิ่มใหม่',quota});}
    }
    const[r]=await connection.query('INSERT INTO robots(robot_key,name,ssh_user,ssh_pass,workspace,description,added_by)VALUES(?,?,?,?,?,?,?)',[robot_key,name,ssh_user||'ubuntu',encrypt(ssh_pass||''),workspace||'~/ros2_ws',description||'',req.user.id]);
    res.json({ok:true,id:r.insertId,quota:await getUserRobotQuota(req.user)});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
  finally{if(connection){if(locked)await connection.query('SELECT RELEASE_LOCK(?)',[`roside_robot_quota_${req.user.id}`]).catch(()=>{});connection.release();}}
});

app.put('/api/robots/:id',auth,async(req,res)=>{
  const{name,ssh_user,ssh_pass,workspace,description}=req.body;
  try{
    const[rows]=await db.query('SELECT * FROM robots WHERE id=?',[req.params.id]);
    if(!rows.length) return res.json({ok:false,error:'Not found'});
    // User ธรรมดา แก้ไขได้แค่หุ่นยนต์ของตัวเอง
    if(req.user.role!=='admin' && rows[0].added_by!==req.user.id) return res.json({ok:false,error:'Forbidden'});
    const enc=ssh_pass?encrypt(ssh_pass):rows[0].ssh_pass;
    await db.query('UPDATE robots SET name=?,ssh_user=?,ssh_pass=?,workspace=?,description=? WHERE id=?',[name||rows[0].name,ssh_user||rows[0].ssh_user,enc,workspace||rows[0].workspace,description??rows[0].description,req.params.id]);
    res.json({ok:true});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.delete('/api/robots/:id',auth,async(req,res)=>{
  try{
    const[rows]=await db.query('SELECT robot_key,added_by FROM robots WHERE id=?',[req.params.id]);
    if(!rows.length) return res.json({ok:false,error:'Not found'});
    // User ธรรมดา ลบได้แค่หุ่นยนต์ของตัวเอง
    if(req.user.role!=='admin' && rows[0].added_by!==req.user.id) return res.json({ok:false,error:'Forbidden'});
    const ag=agents.get(rows[0].robot_key);
    if(ag){try{ag.ws.close();}catch{}agents.delete(rows[0].robot_key);}
    for(const[sessionId,session]of sessions)if(session.robotDbId===Number(req.params.id)){sessions.delete(sessionId);projectScanCache.delete(sessionId);}
    robotProgressCache.delete(rows[0].robot_key);
    await db.query('DELETE FROM robots WHERE id=?',[req.params.id]);
    res.json({ok:true});
  }catch(e){res.json({ok:false,error:e.message});}
});

// ── IDE Connect/Disconnect ───────────────────────────────────
async function createRobotSession(robot,user,{recordConnection=true}={}){
  if(isSim(robot.robot_key)&&user.role!=='admin'&&process.env.ALLOW_UNSANDBOXED_SIM!=='true'){
    const error=new Error('Student simulation is disabled until an isolated runtime is configured');error.status=503;throw error;
  }
  if(isSim(robot.robot_key)&&!agents.has(robot.robot_key))ensureSim(robot.robot_key);
  const ag=agents.get(robot.robot_key);
  if(!ag||ag.ws.readyState!==WebSocket.OPEN){const error=new Error('Robot offline');error.status=503;throw error;}
  for(const[existingId,existing]of sessions)if(existing.userId===user.id&&existing.robotDbId===robot.id&&(!existing.expiresAt||existing.expiresAt>Date.now())){if(existing.sudoPassword===undefined)existing.sudoPassword=decrypt(robot.ssh_pass);return{ok:true,sessionId:existingId,robotId:robot.id,rosInfo:existing.rosInfo,workspace:existing.workspace,username:existing.username,robotName:robot.name,isSim:isSim(robot.robot_key),reused:true};}
  const activeRobotIds=new Set([...sessions.values()].filter(session=>session.userId===user.id&&(!session.expiresAt||session.expiresAt>Date.now())).map(session=>session.robotDbId));
  const reservations=activeSessionReservations.get(user.id)||new Set();
  reservations.forEach(robotId=>activeRobotIds.add(robotId));
  if(!activeRobotIds.has(robot.id)&&activeRobotIds.size>=ROBOT_LIMITS.activeConnections){const error=new Error('เชื่อมต่อหุ่นยนต์พร้อมกันได้สูงสุด 2 ตัว กรุณาตัดการเชื่อมต่อตัวที่ไม่ใช้ก่อน');error.status=409;error.code='ACTIVE_ROBOT_LIMIT_REACHED';throw error;}
  reservations.add(robot.id);activeSessionReservations.set(user.id,reservations);
  const sessionId=mkId();
  try{
    const rosInfo=await agentReq(robot.robot_key,'exec',{command:'bash -lc "echo ROS_DISTRO=$ROS_DISTRO && echo SETUP=$(ls /opt/ros/*/setup.bash 2>/dev/null | head -1)"',timeout:5000})
      .then(d=>{const dm=d.stdout.match(/ROS_DISTRO=(\S+)/),sm=d.stdout.match(/SETUP=(\S+)/);return{distro:dm?dm[1]:'unknown',setupBash:sm?sm[1]:'/opt/ros/humble/setup.bash',version:'2'};})
      .catch(()=>({distro:'unknown',setupBash:'/opt/ros/humble/setup.bash',version:'2'}));
    sessions.set(sessionId,{robotKey:robot.robot_key,robotDbId:robot.id,rosInfo,workspace:robot.workspace,username:robot.ssh_user,sudoPassword:decrypt(robot.ssh_pass),userId:user.id,expiresAt:Date.now()+24*60*60*1000});
    if(recordConnection)await db.query('INSERT INTO robot_connections(robot_id,user_id)VALUES(?,?)',[robot.id,user.id]);
    return{ok:true,sessionId,robotId:robot.id,rosInfo,workspace:robot.workspace,username:robot.ssh_user,robotName:robot.name,isSim:isSim(robot.robot_key)};
  }finally{reservations.delete(robot.id);if(!reservations.size)activeSessionReservations.delete(user.id);}
}

app.post('/api/connect',auth,async(req,res)=>{
  const{robotId}=req.body;
  try{
    const sql=req.user.role==='admin'?'SELECT * FROM robots WHERE id=?':'SELECT * FROM robots WHERE id=? AND added_by=?';
    const params=req.user.role==='admin'?[robotId]:[robotId,req.user.id];
    const[rows]=await db.query(sql,params);
    if(!rows.length) return res.json({ok:false,error:'Robot not found'});
    const robot=rows[0];
    res.json(await createRobotSession(robot,req.user));
  }catch(e){res.status(e.status||200).json({ok:false,code:e.code,error:e.message});}
});

app.post('/api/robots/:id/disconnect',auth,async(req,res)=>{
  try{
    const robotId=Number(req.params.id),[rows]=await db.query(req.user.role==='admin'?'SELECT id FROM robots WHERE id=?':'SELECT id FROM robots WHERE id=? AND added_by=?',req.user.role==='admin'?[robotId]:[robotId,req.user.id]);
    if(!rows.length)return res.status(404).json({ok:false,error:'Robot not found'});
    let disconnected=0;
    for(const[sessionId,session]of sessions)if(session.userId===req.user.id&&session.robotDbId===robotId){sessions.delete(sessionId);projectScanCache.delete(sessionId);disconnected++;}
    await db.query('UPDATE robot_connections SET disconnected_at=NOW() WHERE robot_id=? AND user_id=? AND disconnected_at IS NULL',[robotId,req.user.id]);
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
    const sql=req.user.role==='admin'?'SELECT * FROM robots WHERE id=?':'SELECT * FROM robots WHERE id=? AND added_by=?';
    const params=req.user.role==='admin'?[robotId]:[robotId,req.user.id];
    const[rows]=await db.query(sql,params);
    if(!rows.length)return res.status(404).json({ok:false,error:'Robot not found'});
    const robot=rows[0];
    if(old&&old.userId===req.user.id&&old.robotDbId===robot.id&&robotOnline(robot.robot_key)){
      old.expiresAt=Date.now()+24*60*60*1000;
      return res.json({ok:true,sessionId:req.body.sessionId,robotId:robot.id,rosInfo:old.rosInfo,workspace:old.workspace,username:old.username,robotName:robot.name,isSim:isSim(robot.robot_key),restored:true});
    }
    res.json({...await createRobotSession(robot,req.user),restored:false});
  }catch(e){res.status(e.status||500).json({ok:false,error:e.message});}
});

app.post('/api/disconnect',auth,async(req,res)=>{
  const sess=sessions.get(req.body.sessionId);
  if(sess && sess.userId!==req.user.id) return res.status(403).json({ok:false,error:'Forbidden'});
  if(sess){sessions.delete(req.body.sessionId);projectScanCache.delete(req.body.sessionId);await db.query('UPDATE robot_connections SET disconnected_at=NOW() WHERE robot_id=? AND user_id=? AND disconnected_at IS NULL ORDER BY id DESC LIMIT 1',[sess.robotDbId,req.user.id]).catch(()=>{});}
  res.json({ok:true});
});

// ── FS/Exec API ──────────────────────────────────────────────
function getSess(req){return sessions.get(req.body.sessionId||req.query.sessionId);}
function getOwnedSess(req){const s=getSess(req);return s&&req.user&&s.userId===req.user.id?s:null;}
async function fsOp(req,res,action){
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  try{const d=await agentReq(s.robotKey,action,req.body);if(action!=='fs_list'&&action!=='fs_read')projectScanCache.delete(req.body.sessionId);res.json({ok:true,...d});}
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

app.post('/api/sim/save-tf-package', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  try {
    const out = await saveGeneratedRobotPackage(s, 'sim_robot_tf', req.body.files || {});
    projectScanCache.delete(req.body.sessionId);
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
    projectScanCache.delete(req.body.sessionId);
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
  return /^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/.test(value)?value:device.port;
}
function selectedLidarBaud(requested,device){
  if(device.baud===null)return null;
  const value=Number(requested);return Number.isInteger(value)&&value>=1200&&value<=4000000?value:device.baud;
}
function lidarDirectLaunchCommand(device,port,baud){
  if(device.brand==='YDLIDAR')return `ros2 run ${shellQuote(device.packageName)} ydlidar_node --ros-args -p port:=${shellQuote(port)} -p baudrate:=${Number(baud)}`;
  if(device.port.includes('.'))return `ros2 launch ${shellQuote(device.launchPackage)} ${shellQuote(device.launchFile)} ip_address:=${shellQuote(port)}`;
  return `ros2 launch ${shellQuote(device.launchPackage)} ${shellQuote(device.launchFile)} serial_port:=${shellQuote(port)} serial_baudrate:=${Number(baud)}`;
}

async function lidarSudoExec(s,command,password,timeout=180000){
  const probe=await agentReq(s.robotKey,'exec',{command:'sudo -n true >/dev/null 2>&1',timeout:5000},7000).catch(()=>({code:1}));
  if(probe.code===0)return agentReq(s.robotKey,'exec',{command:`sudo -n bash -lc ${shellQuote(command)}`,timeout},timeout+5000);
  const secret=String(password||s.sudoPassword||'');
  if(!secret||secret.includes('\n')||secret.length>256){
    const error=new Error('เครื่องหุ่นยนต์ต้องใช้รหัส sudo กรุณากรอกรหัส sudo แล้วกด Build ใหม่');error.requiresSudo=true;throw error;
  }
  const token=crypto.randomBytes(18).toString('hex'),fifo=`$HOME/.roside/sudo/${token}.pipe`,fifoPath=`~/.roside/sudo/${token}.pipe`;
  await agentReq(s.robotKey,'exec',{command:`install -d -m 700 "$HOME/.roside/sudo" && rm -f "${fifo}" && mkfifo -m 600 "${fifo}"`,timeout:5000},7000);
  try{
    const elevated=agentReq(s.robotKey,'exec',{command:`sudo -S -p '' bash -lc ${shellQuote(command)} < "${fifo}"; rc=$?; rm -f "${fifo}"; exit $rc`,timeout},timeout+5000);
    const [,result]=await Promise.all([agentReq(s.robotKey,'fs_write',{path:fifoPath,content:secret+'\n'},10000),elevated]);
    if(result.code!==0){
      const detail=[result.stdout,result.stderr].filter(Boolean).join('\n').trim();
      const error=new Error(/incorrect password|sorry, try again|authentication failure/i.test(detail)?'รหัส sudo ไม่ถูกต้อง กรุณากรอกใหม่':(detail.slice(-6000)||'คำสั่ง sudo ไม่สำเร็จ'));error.requiresSudo=true;throw error;
    }
    return result;
  }finally{
    agentReq(s.robotKey,'exec',{command:`rm -f "${fifo}"`,timeout:3000},5000).catch(()=>{});
  }
}

const SERIAL_DEVICE_PATTERN=/^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/;
async function ensureRobotSerialAccess(session,port,password=''){
  if(!SERIAL_DEVICE_PATTERN.test(String(port)))throw Object.assign(new Error('COM port ไม่ถูกต้อง'),{status:400});
  const inspected=await agentReq(session.robotKey,'exec',{command:`if [ ! -c ${shellQuote(port)} ]; then echo MISSING; else id -un; [ -r ${shellQuote(port)} ] && [ -w ${shellQuote(port)} ] && echo READY || echo PERMISSION; fi`,timeout:5000},7000);
  const lines=String(inspected.stdout||'').trim().split(/\r?\n/).filter(Boolean);
  if(lines[0]==='MISSING')throw Object.assign(new Error(`ไม่พบ ${port} กรุณาตรวจสาย USB`),{status:404,portState:'missing'});
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

function lidarSetupFiles(modelId,device){
  const selection={modelId,brand:device.brand,model:device.model,driverPackage:device.packageName,repository:device.repository,port:device.port,baud:device.baud,topic:'/scan',frameId:'laser_frame',savedAt:new Date().toISOString()};
  const args=device.port.includes('.')?`{'ip_address':'${device.port}'}.items()`:`{'serial_port':'${device.port}'${device.baud?`, 'serial_baudrate':'${device.baud}'`:''}}.items()`;
  const launchBody=device.brand==='YDLIDAR'
    ? `from launch_ros.actions import Node\n\ndef generate_launch_description():\n    driver = Node(package='ydlidar', executable='ydlidar_node', name='ydlidar_node', output='screen', parameters=[{'port':'${device.port}','frame_id':'laser_frame','baudrate':${device.baud},'samp_rate':${device.sampleRate},'resolution_fixed':True,'singleChannel':False,'auto_reconnect':True,'reversion':${device.reversion?'True':'False'},'isToFLidar':False,'range_min':0.01,'range_max':32.0}])\n    return LaunchDescription([driver])\n`
    : `from launch.actions import IncludeLaunchDescription\nfrom launch.launch_description_sources import PythonLaunchDescriptionSource\nfrom launch_ros.substitutions import FindPackageShare\nfrom pathlib import Path\n\ndef generate_launch_description():\n    source = PythonLaunchDescriptionSource(str(Path(FindPackageShare('${device.launchPackage}').find('${device.launchPackage}')) / 'launch' / '${device.launchFile}'))\n    return LaunchDescription([IncludeLaunchDescription(source, launch_arguments=${args})])\n`;
  return {
    'package.xml':`<?xml version="1.0"?><package format="3"><name>roside_lidar_setup</name><version>0.1.0</version><description>LiDAR setup generated by ROSIDE for ${device.brand} ${device.model}; publishes sensor_msgs/msg/LaserScan on /scan.</description><maintainer email="robot@roside.local">ROSIDE</maintainer><license>MIT</license><buildtool_depend>ament_cmake</buildtool_depend><exec_depend>${device.launchPackage}</exec_depend><exec_depend>launch</exec_depend><exec_depend>launch_ros</exec_depend><exec_depend>sensor_msgs</exec_depend><export><build_type>ament_cmake</build_type></export></package>`,
    'CMakeLists.txt':'cmake_minimum_required(VERSION 3.8)\nproject(roside_lidar_setup)\nfind_package(ament_cmake REQUIRED)\ninstall(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})\nament_package()\n',
    'config/selected_lidar.json':JSON.stringify(selection,null,2)+'\n',
    'launch/lidar.launch.py':`# Generated by ROSIDE LiDAR Setup\nfrom launch import LaunchDescription\n${launchBody}`,
    'README.md':`# ${device.brand} ${device.model}\n\nGenerated by ROSIDE. Driver source: ${device.repository}\n\nBuild from the workspace root with \`rosdep install --from-paths src --ignore-src -r -y && colcon build --symlink-install\`. Then run \`ros2 launch roside_lidar_setup lidar.launch.py\` and verify \`/scan\`.\n`,
  };
}

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
  try{const result=await buildRealLidar(s,modelId,device,req.body.port,req.body.baud,req.body.sudoPassword);projectScanCache.delete(req.body.sessionId);res.json(result);}
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
    const port=selectedLidarPort(req.body.port,device),setup=await saveGeneratedRobotPackage(s,'roside_lidar_setup',lidarSetupFiles(modelId,{...device,port}));
    const build=await buildRealLidar(s,modelId,device,port,req.body.baud,req.body.sudoPassword);
    projectScanCache.delete(req.body.sessionId);invalidateRobotProgress(s);
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
  return {root,setup:s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',runtime:'~/.roside/lidar-runtime',pid:'~/.roside/lidar-runtime/driver.pid',log:'~/.roside/lidar-runtime/driver.log'};
}

app.post('/api/lidar/driver',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'LIDAR driver ใช้สำหรับหุ่นยนต์จริง'});
  const modelId=String(req.body.modelId||''),device=REAL_LIDAR_CATALOG[modelId],action=String(req.body.action||'status');
  if(!device)return res.status(400).json({ok:false,error:'ไม่รองรับรุ่น LiDAR ที่เลือก'});
  if(!['start','stop','status'].includes(action))return res.status(400).json({ok:false,error:'คำสั่ง LIDAR driver ไม่ถูกต้อง'});
  const port=selectedLidarPort(req.body.port,device),baud=selectedLidarBaud(req.body.baud,device),paths=lidarRuntimePaths(s),launchCommand=lidarDirectLaunchCommand(device,port,baud);
  const sourceCommand=`source ${remoteShellPath(paths.setup)} || { echo 'ไม่สามารถ source ROS setup: ${String(paths.setup).replace(/'/g,'')}'; exit 33; }; source ${remoteShellPath(paths.root+'/install/setup.bash')} || { echo 'ไม่สามารถ source workspace setup: ${String(paths.root).replace(/'/g,'')}/install/setup.bash'; exit 34; }`;
  const stopCommand=`pid=$(cat ${remoteShellPath(paths.pid)} 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; sleep 1; fi; rm -f ${remoteShellPath(paths.pid)}`;
  let forceDialout=false,runtimeRepairOutput='';
  try{
    if(action==='start'){
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
      if(repaired.code!==0)return res.status(500).json({ok:false,error:'เตรียม LIDAR Driver ไม่สำเร็จ',stage:'build',output:runtimeRepairOutput.slice(-10000),command:`cd ${paths.root} && colcon build --symlink-install --packages-up-to ${device.packageName}`});
      if(!device.port.includes('.')){
        const access=await ensureRobotSerialAccess(s,port,req.body.sudoPassword);forceDialout=access.repaired===true;
      }
      const runner=`set -eo pipefail; ${sourceCommand}; exec ${launchCommand}`;
      const launchRunner=forceDialout?`exec sg dialout -c ${shellQuote(`exec bash -lc ${shellQuote(runner)}`)}`:runner;
      const startCommand=`set -o pipefail; mkdir -p ${remoteShellPath(paths.runtime)}; ${stopCommand}; : > ${remoteShellPath(paths.log)}; nohup setsid bash -lc ${shellQuote(launchRunner)} > ${remoteShellPath(paths.log)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(paths.pid)}; sleep 3`;
      const started=await agentReq(s.robotKey,'exec',{command:startCommand,timeout:10000},12000);
      if(started.code!==0)return res.status(500).json({ok:false,error:started.stderr||started.stdout||'เปิด LIDAR driver ไม่สำเร็จ',command:launchCommand});
    }else if(action==='stop'){
      await agentReq(s.robotKey,'exec',{command:stopCommand,timeout:7000},9000);
    }
    const portCheck=device.port.includes('.')
      ? `ping -c 1 -W 1 ${shellQuote(port)} >/dev/null 2>&1 && echo ROSIDE_PORT=connected || echo ROSIDE_PORT=missing`
      : `if [ ! -e ${shellQuote(port)} ]; then echo ROSIDE_PORT=missing; elif { [ -r ${shellQuote(port)} ] && [ -w ${shellQuote(port)} ]; } || { [ "$(stat -c %G ${shellQuote(port)} 2>/dev/null)" = dialout ] && id -nG "$(id -un)" | tr ' ' '\n' | grep -qx dialout; }; then echo ROSIDE_PORT=connected; else echo ROSIDE_PORT=permission; fi; ls -l ${shellQuote(port)} 2>&1 || true`;
    const diagnosticCommand=`${sourceCommand} || true; ${portCheck}; pid=$(cat ${remoteShellPath(paths.pid)} 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then echo ROSIDE_PROCESS=running; else echo ROSIDE_PROCESS=stopped; fi; echo ROSIDE_TOPICS_BEGIN; timeout 4 ros2 topic list -t 2>&1 || true; echo ROSIDE_TOPICS_END; echo ROSIDE_INFO_BEGIN; timeout 4 ros2 topic info /scan -v 2>&1 || true; echo ROSIDE_INFO_END; echo ROSIDE_LOG_BEGIN; tail -120 ${remoteShellPath(paths.log)} 2>&1 || true; echo ROSIDE_LOG_END`;
    const checked=await agentReq(s.robotKey,'exec',{command:diagnosticCommand,timeout:12000},15000),diagnosticOutput=[checked.stdout,checked.stderr].filter(Boolean).join('\n').trim(),output=[runtimeRepairOutput,diagnosticOutput].filter(Boolean).join('\n\n');
    const section=name=>diagnosticOutput.match(new RegExp(`ROSIDE_${name}_BEGIN\\n([\\s\\S]*?)\\nROSIDE_${name}_END`))?.[1]?.trim()||'';
    const portState=diagnosticOutput.match(/ROSIDE_PORT=(connected|permission|missing)/)?.[1]||'missing',processRunning=/ROSIDE_PROCESS=running/.test(diagnosticOutput),topics=section('TOPICS'),info=section('INFO'),log=section('LOG'),topicReady=/(?:^|\n)\/scan(?:\s|$)/m.test(topics);
    const hints=[];
    if(portState==='missing')hints.push(`ไม่พบ ${port} — ตรวจสาย USB, ไฟเลี้ยง และเลือก COM port ใหม่`);
    if(portState==='permission')hints.push(`ไม่มีสิทธิ์อ่าน/เขียน ${port} — เพิ่มผู้ใช้เข้า group dialout แล้ว login ใหม่`);
    if(!processRunning&&action!=='stop')hints.push('Driver หยุดทำงาน — ดู Driver log ด้านล่าง');
    if(processRunning&&!topicReady)hints.push('Driver ทำงานแต่ยังไม่มี /scan — ตรวจรุ่น, baud rate และ launch arguments');
    if(/80008004/.test(log)&&portState!=='connected')hints.unshift('SLAMTEC error 80008004: Driver เปิด serial port ไม่ได้ ระบบต้องแก้สิทธิ์พอร์ตก่อน');
    if(/80008004/.test(log)&&portState==='connected')hints.unshift('SLAMTEC error 80008004: ตรวจว่าสายไม่ถูกโปรแกรมอื่นใช้งาน และรุ่น/baud rate ตรงกับอุปกรณ์');
    res.json({ok:true,action,port,baud,portState,processRunning,topicReady,topics,topicInfo:info,log,output,commands:{launch:launchCommand,topic:'ros2 topic echo --once /scan sensor_msgs/msg/LaserScan --qos-reliability best_effort'},hints});
  }catch(error){res.status(500).json({ok:false,error:error.message,command:launchCommand,portState:error.portState,requiresSudo:!!error.requiresSudo});}
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
  return {root,setup:s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',runtime:'~/.roside/mapping-runtime',pid:'~/.roside/mapping-runtime/slam.pid',log:'~/.roside/mapping-runtime/slam.log'};
}

function mappingSourceCommand(paths){
  const install=`${paths.root}/install`;
  return `source ${remoteShellPath(paths.setup)} 2>/dev/null
source ${remoteShellPath(install+'/setup.bash')} 2>/dev/null || true
export AMENT_PREFIX_PATH=${remoteShellPath(install+'/roside_controller_bridge')}:${remoteShellPath(install+'/roside_lidar_setup')}:"\${AMENT_PREFIX_PATH:-}"
for local_setup in ${remoteShellPath(install+'/roside_controller_bridge/local_setup.bash')} ${remoteShellPath(install+'/roside_lidar_setup/local_setup.bash')}; do [ -f "$local_setup" ] && source "$local_setup"; done`;
}

async function prepareMappingRuntime(s,paths,sudoPassword='',requestedControllerPort='',requestedLidarPort=''){
  const setupOnly=`source ${remoteShellPath(paths.setup)} 2>/dev/null`;
  const workspaceSource=mappingSourceCommand(paths);
  const reportedDistro=String(s.rosInfo?.distro||'').trim().toLowerCase(),setupDistro=String(paths.setup).match(/\/opt\/ros\/([^/]+)\//)?.[1]||'';
  const distro=(reportedDistro&&reportedDistro!=='unknown'?reportedDistro:setupDistro||'humble').replace(/[^A-Za-z0-9_-]/g,'')||'humble';
  const logs=[];
  const slamCheck=await agentReq(s.robotKey,'exec',{command:`${workspaceSource}; ros2 pkg prefix slam_toolbox >/dev/null 2>&1 && ros2 pkg prefix nav2_map_server >/dev/null 2>&1`,timeout:7000},9000);
  if(slamCheck.code!==0){
    const packages=[`ros-${distro}-slam-toolbox`,`ros-${distro}-nav2-map-server`];
    let installed;try{installed=await lidarSudoExec(s,`set -eo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v fuser >/dev/null 2>&1 && fuser -s /var/lib/dpkg/lock-frontend; then
  holder=$(fuser /var/lib/dpkg/lock-frontend 2>/dev/null | tr -d ' ')
  echo "ROSIDE_APT_BUSY pid=$holder" >&2
  ps -p "$holder" -o pid=,etime=,cmd= 2>/dev/null || true
  exit 73
fi
echo ROSIDE_APT_STAGE=waiting_for_lock
apt-get -o DPkg::Lock::Timeout=15 install -y ${packages.map(shellQuote).join(' ')}`,sudoPassword,180000);}catch(error){
      error.stage='install';
      if(/ROSIDE_APT_BUSY|Could not get lock|Unable to acquire the dpkg frontend lock|is another process using it/i.test(error.message)){
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
  const verified=await agentReq(s.robotKey,'exec',{command:`${workspaceSource}
set +e
failed=0
for package in roside_controller_bridge roside_lidar_setup slam_toolbox nav2_map_server; do
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
  let controllerPort='',controllerBaud=115200,pidCommand='',lidarModelId='',runtimeLidarPort='',runtimeLidarBaud=null;
  try{
    const hardwareFile=await agentReq(s.robotKey,'fs_read',{path:`${paths.root}/.roside/hardware.json`}),hardware=JSON.parse(hardwareFile.content||'{}');controllerPort=SERIAL_DEVICE_PATTERN.test(String(requestedControllerPort||''))?String(requestedControllerPort):String(hardware.serialPort||'');controllerBaud=Number.isInteger(Number(hardware.baudRate))?Number(hardware.baudRate):115200;const pidSides=[hardware.pid?.left,hardware.pid?.right];if(hardware.pidControl!==false&&pidSides.every(side=>side&&['kp','ki','kd'].every(gain=>Number.isFinite(Number(side[gain])))))pidCommand='P '+pidSides.flatMap(side=>[side.kp,side.ki,side.kd]).join(' ');
    try{const lidarFile=await agentReq(s.robotKey,'fs_read',{path:`${paths.root}/src/roside_lidar_setup/config/selected_lidar.json`}),selection=JSON.parse(lidarFile.content||'{}'),device=REAL_LIDAR_CATALOG[String(selection.modelId||'')];lidarModelId=String(selection.modelId||'');if(device){runtimeLidarPort=selectedLidarPort(requestedLidarPort||selection.port,device);runtimeLidarBaud=selectedLidarBaud(selection.baud,device);}}catch{}
    if(controllerPort&&controllerPort===runtimeLidarPort){const error=new Error(`Controller และ LiDAR ถูกเลือกเป็นพอร์ตเดียวกัน ${runtimeLidarPort}`);error.stage='controller-port';throw error;}
    if(SERIAL_DEVICE_PATTERN.test(controllerPort)){
      const access=await ensureRobotSerialAccess(s,controllerPort,sudoPassword);logs.push(`[controller serial]\n${controllerPort} พร้อมใช้${access.repaired?' · ซ่อมสิทธิ์แล้ว':''}`);
    }
    if(SERIAL_DEVICE_PATTERN.test(runtimeLidarPort)){const access=await ensureRobotSerialAccess(s,runtimeLidarPort,sudoPassword);logs.push(`[lidar serial]\n${runtimeLidarPort} พร้อมใช้${access.repaired?' · ซ่อมสิทธิ์แล้ว':''}`);}
  }catch(error){
    if(error?.stage||error?.status||/Permission|COM port|serial/i.test(error.message||'')){error.stage='controller-port';throw error;}
    logs.push('[controller serial]\nไม่พบ hardware.json · ใช้ค่าจาก controller.yaml');
  }
  return {output:logs.join('\n\n'),controllerPort,controllerBaud,pidCommand,lidarModelId,lidarPort:runtimeLidarPort,lidarBaud:runtimeLidarBaud};
}

app.post('/api/mapping/runtime',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'หน้าเก็บแผนที่จริงไม่รองรับ Sim'});
  const action=String(req.body.action||'status');if(!['start','stop','status'].includes(action))return res.status(400).json({ok:false,error:'คำสั่ง SLAM ไม่ถูกต้อง'});
  const p=mappingRuntimePaths(s);let preparation='',controllerPort='',controllerBaud=115200,pidCommand='',runtimeLidarPort='';
  const stop=`pid=$(cat ${remoteShellPath(p.pid)} 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; sleep 1; fi; rm -f ${remoteShellPath(p.pid)}`;
  try{
    if(action==='stop')await agentReq(s.robotKey,'exec',{command:stop,timeout:8000},10000);
    if(action==='start'){
      const source=mappingSourceCommand(p);
      const prepared=await prepareMappingRuntime(s,p,req.body.sudoPassword,req.body.controllerPort,req.body.lidarPort);preparation=prepared.output;controllerPort=prepared.controllerPort;controllerBaud=prepared.controllerBaud;pidCommand=prepared.pidCommand||'';runtimeLidarPort=prepared.lidarPort;
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
      const lidarDevice=REAL_LIDAR_CATALOG[prepared.lidarModelId],lidarLaunch=lidarDevice?lidarDirectLaunchCommand(lidarDevice,prepared.lidarPort,prepared.lidarBaud):'ros2 launch roside_lidar_setup lidar.launch.py';
      const runner=`${source}; ${lidarLaunch} & ros2 run tf2_ros static_transform_publisher --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 --frame-id base_link --child-frame-id laser & (ros2 pkg prefix sim_robot_tf >/dev/null 2>&1 && ros2 launch sim_robot_tf tf_static.launch.py || true) & exec ros2 launch slam_toolbox online_async_launch.py slam_params_file:=${remoteShellPath(slamParamsPath)} use_sim_time:=false`;
      const lidarPid=remoteShellPath(lidarRuntimePaths(s).pid);
      const staleCleanup=`pkill -TERM -f '[r]os2 launch roside_controller_bridge controller_bridge.launch.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch roside_lidar_setup lidar.launch.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch slam_toolbox online_async_launch.py' 2>/dev/null || true; pkill -TERM -f '[c]ontroller_bridge.py --ros-args' 2>/dev/null || true; pkill -TERM -f '[_]roside_mapping_controller.py' 2>/dev/null || true; pkill -TERM -f '[_]roside_mapping_live.py' 2>/dev/null || true`;
      await agentReq(s.robotKey,'exec',{command:`${stop}; ${staleCleanup}; old_lidar=$(cat ${lidarPid} 2>/dev/null || true); if [[ "$old_lidar" =~ ^[0-9]+$ ]] && kill -0 "$old_lidar" 2>/dev/null; then kill -- -"$old_lidar" 2>/dev/null || true; fi; rm -f ${lidarPid}; sleep 2`,timeout:10000},13000);
      const command=`mkdir -p ${remoteShellPath(p.runtime)}; : > ${remoteShellPath(p.log)}; nohup setsid bash -lc ${shellQuote(runner)} > ${remoteShellPath(p.log)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(p.pid)}; sleep 5`;
      const started=await agentReq(s.robotKey,'exec',{command,timeout:12000},15000);if(started.code!==0)return res.status(500).json({ok:false,error:'เปิด SLAM ไม่สำเร็จ',output:[started.stdout,started.stderr].filter(Boolean).join('\n')});
    }
    const inspect=`pid=$(cat ${remoteShellPath(p.pid)} 2>/dev/null || true); [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo ROSIDE_PROCESS=running || echo ROSIDE_PROCESS=stopped; source ${remoteShellPath(p.setup)} 2>/dev/null; source ${remoteShellPath(p.root+'/install/setup.bash')} 2>/dev/null || true; echo ROSIDE_TOPICS_BEGIN; timeout 4 ros2 topic list 2>/dev/null || true; echo ROSIDE_TOPICS_END; echo ROSIDE_LOG_BEGIN; tail -80 ${remoteShellPath(p.log)} 2>/dev/null || true; echo ROSIDE_LOG_END`;
    const out=await agentReq(s.robotKey,'exec',{command:inspect,timeout:10000},13000),text=[out.stdout,out.stderr].filter(Boolean).join('\n'),topics=text.match(/ROSIDE_TOPICS_BEGIN\n([\s\S]*?)\nROSIDE_TOPICS_END/)?.[1]||'',log=text.match(/ROSIDE_LOG_BEGIN\n([\s\S]*?)\nROSIDE_LOG_END/)?.[1]||'';
    res.json({ok:true,action,controllerPort,controllerBaud,pidCommand,runtimeLidarPort,processRunning:/ROSIDE_PROCESS=running/.test(text),mapReady:/(?:^|\n)\/map(?:\s|$)/m.test(topics),scanReady:/(?:^|\n)\/scan(?:\s|$)/m.test(topics),odomReady:/(?:^|\n)\/odom(?:\s|$)/m.test(topics),topics,log,...(typeof preparation==='string'?{preparation}: {})});
  }catch(error){res.status(error.aptBusy?409:500).json({ok:false,error:error.message,stage:error.stage,requiresSudo:!!error.requiresSudo,aptBusy:!!error.aptBusy});}
});

app.post('/api/mapping/save',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  const mapName=String(req.body.mapName||'').trim();if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'ชื่อแผนที่ใช้ A-Z, a-z, 0-9, _ หรือ - ไม่เกิน 40 ตัว'});
  const p=mappingRuntimePaths(s),folder=`${p.root}/maps/${mapName}`;
  try{
    const command=`set -eo pipefail; source ${remoteShellPath(p.setup)}; source ${remoteShellPath(p.root+'/install/setup.bash')} 2>/dev/null||true; mkdir -p ${remoteShellPath(folder)}; ros2 run nav2_map_server map_saver_cli -f ${remoteShellPath(folder+'/map')}; test -f ${remoteShellPath(folder+'/map.yaml')}; test -f ${remoteShellPath(folder+'/map.pgm')} -o -f ${remoteShellPath(folder+'/map.png')}`;
    const out=await agentReq(s.robotKey,'exec',{command,timeout:30000},35000);if(out.code!==0)return res.status(500).json({ok:false,error:'บันทึกแผนที่ไม่สำเร็จ ตรวจว่า /map มีข้อมูลและติดตั้ง nav2_map_server แล้ว',output:[out.stdout,out.stderr].filter(Boolean).join('\n').slice(-8000)});
    await agentReq(s.robotKey,'fs_write',{path:`${p.root}/.roside/mapping_result.json`,content:JSON.stringify({version:1,mapName,savedAt:new Date().toISOString(),yaml:`maps/${mapName}/map.yaml`,image:`maps/${mapName}/map.pgm`},null,2)+'\n'});
    projectScanCache.delete(req.body.sessionId);invalidateRobotProgress(s);
    res.json({ok:true,mapName,folder:`maps/${mapName}`,yaml:`maps/${mapName}/map.yaml`,output:[out.stdout,out.stderr].filter(Boolean).join('\n')});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

function navigationRuntimePaths(s){const root=(s.workspace||'~/ros2_ws').replace(/\/$/,'');return{root,setup:s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash',runtime:'~/.roside/navigation-runtime',pid:'~/.roside/navigation-runtime/nav2.pid',log:'~/.roside/navigation-runtime/nav2.log'};}

app.post('/api/navigation/maps',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});const p=navigationRuntimePaths(s);
  try{const out=await agentReq(s.robotKey,'exec',{command:`find ${remoteShellPath(p.root+'/maps')} -mindepth 2 -maxdepth 2 -type f -name map.yaml -printf '%h\\n' 2>/dev/null | sed 's#/$##' | awk -F/ '{print $NF}' | grep -E '^[A-Za-z0-9_-]{1,40}$' | sort -u`,timeout:6000},8000);let latest='';try{const f=await agentReq(s.robotKey,'fs_read',{path:`${p.root}/.roside/mapping_result.json`});latest=String(JSON.parse(f.content||'{}').mapName||'');}catch{}const names=String(out.stdout||'').split(/\r?\n/).filter(Boolean);res.json({ok:true,maps:names.map(name=>({name,latest:name===latest}))});}catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post('/api/navigation/runtime',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});if(isSim(s.robotKey))return res.status(400).json({ok:false,error:'หน้า Nav2 จริงไม่รองรับ Sim'});
  const action=String(req.body.action||'status'),mapName=String(req.body.mapName||'');if(!['start','stop','status'].includes(action))return res.status(400).json({ok:false,error:'คำสั่ง Nav2 ไม่ถูกต้อง'});const p=navigationRuntimePaths(s),mapping=mappingRuntimePaths(s);let controllerPort='',controllerBaud=115200,pidCommand='',runtimeLidarPort='',preparation='';
  const stop=`pid=$(cat ${remoteShellPath(p.pid)} 2>/dev/null || true); if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; sleep 1; fi; rm -f ${remoteShellPath(p.pid)}`;
  try{
    if(action==='stop')await agentReq(s.robotKey,'exec',{command:`${stop}; pkill -TERM -f '[_]roside_navigation_live.py' 2>/dev/null || true`,timeout:9000},11000);
    if(action==='start'){
      if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))return res.status(400).json({ok:false,error:'กรุณาเลือก Saved Map'});const yaml=`${p.root}/maps/${mapName}/map.yaml`;
      const exists=await agentReq(s.robotKey,'exec',{command:`test -s ${remoteShellPath(yaml)}`,timeout:5000},7000);if(exists.code!==0)return res.status(400).json({ok:false,error:`ไม่พบ Saved Map maps/${mapName}/map.yaml กรุณาบันทึกจากหน้า Mapping ก่อน`});
      const prepared=await prepareMappingRuntime(s,mapping,req.body.sudoPassword,req.body.controllerPort,req.body.lidarPort);preparation=prepared.output;controllerPort=prepared.controllerPort;controllerBaud=prepared.controllerBaud;pidCommand=prepared.pidCommand||'';runtimeLidarPort=prepared.lidarPort;
      const source=mappingSourceCommand(mapping),distro=(String(s.rosInfo?.distro||'')||String(p.setup).match(/\/opt\/ros\/([^/]+)\//)?.[1]||'humble').replace(/[^A-Za-z0-9_-]/g,'');const navCheck=await agentReq(s.robotKey,'exec',{command:`${source}; ros2 pkg prefix nav2_bringup >/dev/null 2>&1 && ros2 pkg prefix nav2_amcl >/dev/null 2>&1`,timeout:7000},9000);
      if(navCheck.code!==0){let installed;try{installed=await lidarSudoExec(s,`export DEBIAN_FRONTEND=noninteractive\napt-get -o DPkg::Lock::Timeout=20 install -y ros-${distro}-navigation2 ros-${distro}-nav2-bringup`,req.body.sudoPassword,180000);}catch(error){error.stage='install-nav2';throw error;}preparation+='\n[install Nav2]\n'+[installed.stdout,installed.stderr].filter(Boolean).join('\n').slice(-5000);}
      const lidarDevice=REAL_LIDAR_CATALOG[prepared.lidarModelId],lidarLaunch=lidarDevice?lidarDirectLaunchCommand(lidarDevice,prepared.lidarPort,prepared.lidarBaud):'ros2 launch roside_lidar_setup lidar.launch.py';
      const mappingStop=`mpid=$(cat ${remoteShellPath(mapping.pid)} 2>/dev/null || true); if [[ "$mpid" =~ ^[0-9]+$ ]] && kill -0 "$mpid" 2>/dev/null; then kill -- -"$mpid" 2>/dev/null || true; fi; rm -f ${remoteShellPath(mapping.pid)}`;
      const cleanup=`${stop}; ${mappingStop}; pkill -TERM -f '[r]os2 launch slam_toolbox' 2>/dev/null || true; pkill -TERM -f '[_]roside_mapping_live.py' 2>/dev/null || true; pkill -TERM -f '[_]roside_navigation_live.py' 2>/dev/null || true; pkill -TERM -f '[r]os2 launch nav2_bringup bringup_launch.py' 2>/dev/null || true; sleep 2`;
      await agentReq(s.robotKey,'exec',{command:cleanup,timeout:10000},13000);
      const runner=`${source}; ${lidarLaunch} & ros2 run tf2_ros static_transform_publisher --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 --frame-id base_link --child-frame-id laser & exec ros2 launch nav2_bringup bringup_launch.py map:=${remoteShellPath(yaml)} use_sim_time:=false autostart:=true`;
      const command=`mkdir -p ${remoteShellPath(p.runtime)}; : > ${remoteShellPath(p.log)}; nohup setsid bash -lc ${shellQuote(runner)} > ${remoteShellPath(p.log)} 2>&1 < /dev/null & echo $! > ${remoteShellPath(p.pid)}; sleep 8`;
      const started=await agentReq(s.robotKey,'exec',{command,timeout:15000},18000);if(started.code!==0)return res.status(500).json({ok:false,error:'เปิด Nav2 ไม่สำเร็จ',output:[started.stdout,started.stderr].filter(Boolean).join('\n')});
    }
    const inspect=`pid=$(cat ${remoteShellPath(p.pid)} 2>/dev/null || true); [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo ROSIDE_PROCESS=running || echo ROSIDE_PROCESS=stopped; tail -100 ${remoteShellPath(p.log)} 2>/dev/null || true`;const out=await agentReq(s.robotKey,'exec',{command:inspect,timeout:7000},9000),text=[out.stdout,out.stderr].filter(Boolean).join('\n'),processRunning=/ROSIDE_PROCESS=running/.test(text);if(action==='start'&&!processRunning)return res.status(500).json({ok:false,error:'โปรเซส Nav2 หยุดทำงานระหว่างเริ่มระบบ',stage:'launch-nav2',output:text.slice(-8000)});res.json({ok:true,action,controllerPort,controllerBaud,pidCommand,runtimeLidarPort,processRunning,log:text,preparation});
  }catch(error){res.status(error.aptBusy?409:500).json({ok:false,error:error.message,stage:error.stage,aptBusy:!!error.aptBusy,requiresSudo:!!error.requiresSudo});}
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
    projectScanCache.delete(req.body.sessionId);
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
    ag.respawnBackend(req.body.map || null);
    resetSimulationWizardAfterFieldChange(wsRoot(s.robotKey));
    projectScanCache.delete(req.body.sessionId);
    invalidateRobotProgress(s);
    res.json({ ok:true });
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
    projectScanCache.delete(req.body.sessionId);
    res.json({ ok:true, created:out.created, written:out.written, pkgDir:out.pkgDir });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// Build and run the generated MapSim package after Map Editor saves map.json.
// The process lives inside this simulation workspace, so Node Status can list
// and stop it through /api/kill-node without affecting another robot.
app.post('/api/sim/run-mapsim', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  if (!isSim(s.robotKey)) return res.json({ ok:false, error:'Available for Sim only' });
  if (mapsimLaunches.has(s.robotKey)) return res.status(409).json({ok:false,error:'MapSim กำลังเริ่มทำงานอยู่ กรุณารอสักครู่'});
  mapsimLaunches.add(s.robotKey);
  try {
    const mapCapability = inspectSimMapCapability(s.robotKey);
    if (!mapCapability.detected) return res.status(400).json({ ok:false, error:mapCapability.validationMessage });
    writeMapsimPackage(s.robotKey, genMapsimFiles());
    const root = wsRoot(s.robotKey);
    const setup = s.rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const pidFile = path.join(root, 'tmp', '_mapsim.pid');
    const logFile = path.join(root, 'tmp', '_mapsim.log');
    const workspaceSetup = path.join(root, 'install', 'setup.bash');
    const fail = (phase, result, fallback) => {
      const detail = [result?.stderr, result?.stdout].filter(Boolean).join('\n').trim().slice(-6000);
      console.error(`[MapSim] ${phase} failed for ${s.robotKey}:`, detail || fallback);
      return res.status(500).json({ ok:false, phase, error:detail || fallback, log:'~/tmp/_mapsim.log' });
    };

    // Build separately so a failed build cannot be hidden by the later node check.
    const buildCommand = [
      'set -e',
      `source ${quote(setup)} 2>/dev/null`,
      `cd ${quote(root)}`,
      `if [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = "merged" ]; then colcon build --merge-install --packages-select sim_robot_mapsim; else colcon build --packages-select sim_robot_mapsim; fi`,
    ].join('; ');
    const buildResult = await agentReq(s.robotKey, 'exec', { command:buildCommand, timeout:120000 }, 125000);
    if (buildResult.code !== 0) return fail('build', buildResult, 'Build MapSim ไม่สำเร็จ');

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
    await agentReq(s.robotKey, 'exec', { command:stopCommand, timeout:8000 }, 10000);

    const startCommand = [
      'set -e',
      `source ${quote(setup)} 2>/dev/null`,
      `source ${quote(workspaceSetup)}`,
      `nohup ros2 run sim_robot_mapsim mapsim >${quote(logFile)} 2>&1 </dev/null & echo $! >${quote(pidFile)}`,
    ].join('; ');
    const startResult = await agentReq(s.robotKey, 'exec', { command:startCommand, timeout:10000 }, 12000);
    if (startResult.code !== 0) return fail('start', startResult, 'เริ่ม MapSim ไม่สำเร็จ');

    const verifyCommand = [
      `source ${quote(setup)} 2>/dev/null`,
      `source ${quote(workspaceSetup)} 2>/dev/null`,
      `for i in 1 2 3 4 5 6 7 8; do ros2 node list 2>/dev/null | grep -qx '/sim_robot_mapsim' && break; sleep 1; done`,
      `ros2 node list 2>/dev/null | grep -x '/sim_robot_mapsim'`,
    ].join('; ');
    const verifyResult = await agentReq(s.robotKey, 'exec', { command:verifyCommand, timeout:15000 }, 18000);
    const running = verifyResult.code === 0 && /(^|\n)\/sim_robot_mapsim($|\n)/.test(verifyResult.stdout || '');
    if (!running) {
      const logResult = await agentReq(s.robotKey, 'exec', { command:`tail -80 ${quote(logFile)} 2>/dev/null`, timeout:5000 }, 7000).catch(() => ({ stdout:'' }));
      return fail('verify', { stderr:verifyResult.stderr, stdout:logResult.stdout || verifyResult.stdout }, 'MapSim node เริ่มทำงานแล้วหยุดทันที');
    }
    projectScanCache.delete(req.body.sessionId);
    res.json({ ok:true, running:true, node:'/sim_robot_mapsim', pkg:'sim_robot_mapsim', exe:'mapsim', log:'~/tmp/_mapsim.log' });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  finally { mapsimLaunches.delete(s.robotKey); }
});

// Configure the in-process Navigation controller without spawning multiple
// `ros2 param set` CLI processes. MapSim watches this file and writes an ack.
app.post('/api/sim/configure-navigation',auth,async(req,res)=>{
  const s=getOwnedSess(req);if(!s)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(!isSim(s.robotKey))return res.status(400).json({ok:false,error:'Available for Sim only'});
  const number=(name,min,max,fallback)=>{const value=Number(req.body?.[name]);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;};
  const config={id:crypto.randomBytes(12).toString('hex'),nav_enabled:true,nav_max_speed:number('speed',.15,1.2,.55),nav_turn_speed:number('turn',.4,2.5,1.2),nav_obstacle_distance:number('obstacle',.3,1,.48),nav_inflation_radius:number('inflation',.1,.6,.28),nav_lookahead_distance:number('lookahead',.2,.9,.45),nav_goal_tolerance:number('tolerance',.08,.5,.2)};
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
    res.json({ok:true,config});
  }catch(error){res.status(500).json({ok:false,error:'ตั้งค่า Navigation ไม่สำเร็จ: '+error.message});}
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
  const x=Number(req.body.x),y=Number(req.body.y),yaw=Number(req.body.yaw||0);
  if(![x,y,yaw].every(Number.isFinite)||Math.abs(x)>10000||Math.abs(y)>10000)return res.status(400).json({ok:false,error:'พิกัดจุดหมายไม่ถูกต้อง'});
  try{
    const root=wsRoot(s.robotKey),tmpDir=path.join(root,'tmp'),id=crypto.randomBytes(12).toString('hex');
    const goalPath=path.join(tmpDir,'_nav_goal.json'),pendingPath=path.join(tmpDir,`_nav_goal.${id}.tmp`),ackPath=path.join(tmpDir,'_nav_goal_ack.json');
    fs_node.mkdirSync(tmpDir,{recursive:true});fs_node.writeFileSync(pendingPath,JSON.stringify({id,x,y,yaw,createdAt:Date.now()}));fs_node.renameSync(pendingPath,goalPath);
    let ack=null;
    for(let attempt=0;attempt<24;attempt++){
      await new Promise(resolve=>setTimeout(resolve,50));
      try{const candidate=JSON.parse(fs_node.readFileSync(ackPath,'utf8'));if(candidate.id===id){ack=candidate;break;}}catch{}
    }
    if(!ack)return res.status(504).json({ok:false,error:'Navigation controller ไม่ตอบรับ Goal กรุณากดเริ่ม Navigation ใหม่'});
    if(!ack.accepted)return res.status(422).json({ok:false,error:ack.error||'ไม่พบเส้นทางไปยังจุดหมายบน Saved Map'});
    projectScanCache.delete(req.body.sessionId);
    res.json({ok:true,accepted:true,id,x,y,yaw});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
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
    completeSimulationWizardNavigation(root,mapName);projectScanCache.delete(req.body.sessionId);invalidateRobotProgress(s);
    res.json({ok:true,completed:true,mapName});
  }catch(error){res.status(409).json({ok:false,error:'บันทึกการเริ่ม Navigation ไม่สำเร็จ: '+error.message});}
});

// Save the progressively discovered /slam_map as a Nav2-compatible PGM/YAML
// and build the generated sim_robot_nav_map package for immediate reuse.
app.post('/api/sim/save-slam-map', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  if (!isSim(s.robotKey)) return res.status(400).json({ ok:false, error:'Available for Sim only' });
  const mapName = String(req.body.mapName || 'slam_map').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(mapName)) return res.status(400).json({ ok:false, error:'ชื่อแผนที่ใช้ได้เฉพาะ a-z, 0-9, _ และ -' });
  try {
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
      return res.status(500).json({ ok:false, error:[saved.stderr,saved.stdout].filter(Boolean).join('\n').trim() || 'บันทึก SLAM map ไม่สำเร็จ' });
    }
    const packageDir = path.join(root, 'src', 'sim_robot_nav_map');
    const verifyCommand = `test -s ${quote(path.join(root,'maps',mapName,'map.pgm'))} && test -s ${quote(path.join(root,'maps',mapName,'map.yaml'))} && test -s ${quote(path.join(packageDir,'package.xml'))}`;
    const verified = await agentReq(s.robotKey, 'exec', { command:verifyCommand, timeout:5000 }, 7000);
    if (verified.code !== 0) return res.status(500).json({ ok:false, error:'สร้างไฟล์ Map/Package ไม่ครบ' });
    const buildCommand = [
      'set -e', `source ${quote(setup)} 2>/dev/null`, `cd ${quote(root)}`,
      // The generated package used to be ament_cmake. Archive only this
      // package's generated artifacts so existing workspaces migrate safely.
      `for old in ${quote(path.join(root,'build','sim_robot_nav_map'))} ${quote(path.join(root,'install','sim_robot_nav_map'))}; do [ ! -e "$old" ] || mv "$old" "$old.stale.$(date +%s%N)"; done`,
      `if [ "$(cat install/.colcon_install_layout 2>/dev/null || true)" = "merged" ]; then colcon build --merge-install --packages-select sim_robot_nav_map; else colcon build --packages-select sim_robot_nav_map; fi`,
    ].join('; ');
    const built = await agentReq(s.robotKey, 'exec', { command:buildCommand, timeout:120000 }, 125000);
    if (built.code !== 0) return res.status(500).json({ ok:false, error:[built.stderr,built.stdout].filter(Boolean).join('\n').trim().slice(-6000) || 'Build sim_robot_nav_map ไม่สำเร็จ' });
    completeSimulationWizardMapping(root,mapName);
    projectScanCache.delete(req.body.sessionId);
    invalidateRobotProgress(s);
    res.json({ ok:true, wizardCompleted:true, mapName, mapDir:`~/maps/${mapName}`, packageDir:'~/src/sim_robot_nav_map', yaml:`~/maps/${mapName}/map.yaml`, launch:'ros2 launch sim_robot_nav_map map_server.launch.py' });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

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
    const generated=writeNavigationPackage(root,mapName,req.body.parameters||{});projectScanCache.delete(req.body.sessionId);
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
    projectScanCache.delete(req.body.sessionId);
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
async function discoverRobotSerialPorts(session){
  const python=`import glob,grp,json,os,pwd,re,stat
patterns=['/dev/ttyUSB*','/dev/ttyACM*','/dev/ttyAMA*','/dev/ttyTHS*','/dev/rfcomm*']
by_real={}
for link in glob.glob('/dev/serial/by-id/*'):
 try: by_real.setdefault(os.path.realpath(link),[]).append(link)
 except OSError: pass
paths=set()
for pattern in patterns:
 for value in glob.glob(pattern):
  try:
   if stat.S_ISCHR(os.stat(value).st_mode): paths.add(value)
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
  ports.append({'path':value,'stablePath':aliases[0] if aliases else '', 'aliases':aliases,
   'label':os.path.basename(aliases[0]) if aliases else os.path.basename(value),'connected':True,
   'readable':os.access(value,os.R_OK),'writable':os.access(value,os.W_OK),
   'accessible':os.access(value,os.R_OK|os.W_OK),'owner':owner,
   'group':group,'mode':oct(stat.S_IMODE(info.st_mode))})
 except OSError: pass
print('ROSIDE_SERIAL_PORTS='+json.dumps(ports,separators=(',',':')))`;
  const encoded=Buffer.from(python).toString('base64');
  const result=await agentReq(session.robotKey,'exec',{command:`python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`,timeout:10000},15000);
  const marker=String(result.stdout||'').split(/\r?\n/).find(line=>line.startsWith('ROSIDE_SERIAL_PORTS='));
  if(result.code!==0||!marker)throw new Error(result.stderr||'Robot ไม่สามารถตรวจสอบ COM port ได้');
  const ports=JSON.parse(marker.slice('ROSIDE_SERIAL_PORTS='.length));
  return Array.isArray(ports)?ports:[];
}

app.post('/api/serial/ports',auth,async(req,res)=>{
  const session=getOwnedSess(req);if(!session)return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(isSim(session.robotKey))return res.json({ok:true,ports:[]});
  try{res.json({ok:true,ports:await discoverRobotSerialPorts(session)});}
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
  if (!finiteList(data.start, 2)) return 'ไม่มีจุดเริ่มหุ่นที่ถูกต้อง';
  if (data.start[0] < data.bounds[0] || data.start[0] > data.bounds[2] || data.start[1] < data.bounds[1] || data.start[1] > data.bounds[3]) return 'จุดเริ่มหุ่นอยู่นอกขอบเขตแผนที่';
  if (!Array.isArray(data.walls) || data.walls.some(wall => !finiteList(wall, 4))) return 'ข้อมูลกำแพงไม่ถูกต้อง';
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
  const cached=projectScanCache.get(sessionId);
  if(cached&&cached.expiresAt>Date.now()) return cached.promise;
  const workspace=isSim(session.robotKey)?wsRoot(session.robotKey):(session.workspace||'~/ros2_ws');
  const script64=Buffer.from(buildProjectScanScript(workspace),'utf8').toString('base64');
  const promise=agentReq(session.robotKey,'exec',{
    command:`python3 -c "import base64;exec(base64.b64decode('${script64}'))"`,
    timeout:15000,
  }).then(result=>{
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
  projectScanCache.set(sessionId,{expiresAt:Date.now()+30000,promise});
  return promise;
}

app.post('/api/dashboard',auth,async(req,res)=>{
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  try{
    if(req.body.forceProjectScan===true) projectScanCache.delete(req.body.sessionId);
    const projectPromise=getProjectSummary(req.body.sessionId,s);
    const src=s.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
    const d=await agentReq(s.robotKey,'exec',{command:`bash -lc "source ${src} 2>/dev/null; echo CPU=$(top -bn1|grep 'Cpu(s)'|awk '{print $2}'); echo MEM=$(free -m|awk 'NR==2{print $3\" \"$2}'); echo DISK=$(df -h /|awk 'NR==2{print $3\" \"$2\" \"$5}'); echo UPTIME=$(uptime -p); echo NODES_START; ros2 node list 2>/dev/null; echo NODES_END; echo TOPICS_START; ros2 topic list -t 2>/dev/null; echo TOPICS_END"`,timeout:12000});
    const o=d.stdout||'';
    const cm=o.match(/CPU=([\d.]+)/),mm=o.match(/MEM=(\d+) (\d+)/),dm=o.match(/DISK=(\S+) (\S+) (\S+)/),um=o.match(/UPTIME=(.+)/);
    const nr=o.match(/NODES_START\n([\s\S]*?)NODES_END/),tr=o.match(/TOPICS_START\n([\s\S]*?)TOPICS_END/);
    const nodes=(nr?nr[1].trim().split('\n').filter(Boolean):[]).map(n=>({name:n,publishers:[],subscribers:[]}));
    const topics=(tr?tr[1].trim().split('\n').filter(Boolean):[]).map(l=>{const m=l.match(/^(\S+)\s+\[(.+)\]$/);return m?{name:m[1],type:m[2]}:{name:l,type:''};});

    // ── OS processes scoped to THIS workspace (เฉพาะของ sim นี้ หรือ workspace จริง) ──
    // SIM: node รันจริงบน server ที่ <root>/install/... → grep เฉพาะ root นี้ จึงไม่ปน sim อื่น
    // REAL: grep colcon install tree (/install/.*/lib/) เพราะ path ใน ps ถูกขยายเป็น absolute แล้ว
    let processes=[];
    try {
      const root = isSim(s.robotKey) ? wsRoot(s.robotKey) : (s.workspace || '~/ros2_ws');
      const psPat = isSim(s.robotKey) ? `${root}/install/` : '/install/.*/lib/';
      const psCmd = `ps -eo pid,cmd | grep -iE "ros2 run|ros2 launch|${psPat}" | grep -vE "grep|ros2ide|api/exec|script -qec"`;
      const pr = await agentReq(s.robotKey,'exec',{command:psCmd,timeout:5000});
      processes = (pr.stdout||'').trim().split('\n').filter(Boolean).map(line=>{
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        let cmdStr = m ? m[2] : '';
        cmdStr = cmdStr.replace('/usr/bin/python3','python3').replace(/^.*?\/install\//,'[ws]/install/');
        return m ? { pid:m[1], cmd:cmdStr } : null;
      }).filter(Boolean);
    } catch(e) { processes=[]; }

    const project=await projectPromise;
    res.json({ok:true,cpu:parseFloat(cm?.[1]||0),memUsed:parseInt(mm?.[1]||0),memTotal:parseInt(mm?.[2]||0),disk:{used:dm?.[1],total:dm?.[2],pct:dm?.[3]},uptime:um?.[1]||'',nodes,topics,processes,project,rosInfo:s.rosInfo,isSim:isSim(s.robotKey),timestamp:Date.now()});
  }catch(e){res.json({ok:false,error:e.message});}
});

// ── WS Upgrade ─────────────────────────────────────────────
server.on('upgrade',async(req,socket,head)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(!['/ws/agent','/ws/terminal','/ws/rviz','/ws/lidar','/ws/controller-tune','/ws/mapping','/ws/navigation','/ws/monitor','/ws/robot-status'].includes(url.pathname)) return socket.destroy();
  try {
    let user=null;
    if(url.pathname!=='/ws/agent'){
      const origin=String(req.headers.origin||'');
      const forwardedProto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
      const ownOrigin=process.env.PUBLIC_URL?new URL(process.env.PUBLIC_URL).origin:`${forwardedProto}://${req.headers.host}`;
      if(origin&&origin!==ownOrigin&&!allowedOrigins.includes(origin)) return socket.destroy();
      user=await tokenUser(webSocketAuthToken(req.headers['sec-websocket-protocol']));
      if(!user) return socket.destroy();
    }
    wss.handleUpgrade(req,socket,head,ws=>{ws.user=user;wss.emit('connection',ws,url.pathname);});
  } catch { socket.destroy(); }
});

// ── /ws/robot-status ─────────────────────────────────────
function broadcastStatus(robot_key,online){
  const msg=JSON.stringify({type:'status',robot_key,online,ts:Date.now()});
  statusSubs.forEach(ws=>{if(ws.readyState===WebSocket.OPEN&&(ws.user?.role==='admin'||ws.allowedRobotKeys?.has(robot_key)))ws.send(msg);});
}
wss.on('connection',(ws,pathname)=>{
  if(pathname!=='/ws/robot-status') return;
  statusSubs.add(ws);
  const q=ws.user?.role==='admin'?['SELECT robot_key FROM robots',[]]:['SELECT robot_key FROM robots WHERE added_by=?',[ws.user.id]];
  db.query(q[0],q[1]).then(([rows])=>{
    ws.allowedRobotKeys=new Set(rows.map(r=>r.robot_key));
    const snap={};rows.forEach(r=>{snap[r.robot_key]=robotOnline(r.robot_key)?'online':'offline';});
    if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'snapshot',status:snap}));
  }).catch(()=>ws.close());
  ws.on('close',()=>statusSubs.delete(ws));
});

// ── /ws/monitor ──────────────────────────────────────────
wss.on('connection',(ws,pathname)=>{
  if(pathname!=='/ws/monitor') return;
  let monTermId=null,monRobotKey=null;
  ws.on('message',async raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(msg.type==='subscribe'){
      const sess=sessions.get(msg.sessionId);
      if(sess&&sess.userId!==ws.user?.id){ws.send(JSON.stringify({type:'error',message:'Forbidden'}));return;}
      if(!sess){ws.send(JSON.stringify({type:'error',message:'Session not found'}));return;}
      const ag=agents.get(sess.robotKey);
      if(!ag||ag.ws.readyState!==WebSocket.OPEN){ws.send(JSON.stringify({type:'error',message:'Robot offline'}));return;}
      monRobotKey=sess.robotKey;
      if(monTermId){ag.ws.send(JSON.stringify({type:'pty_close',termId:monTermId}));monSockets.delete(monTermId);}
      monTermId='mon_'+mkId(); monSockets.set(monTermId,ws);
      const src=sess.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
      const topic=msg.topic;
      if(typeof topic!=='string'||!/^\/[A-Za-z0-9_/-]+$/.test(topic)){ws.send(JSON.stringify({type:'error',message:'Invalid topic'}));return;}
      const py=["import rclpy,sys,yaml,time","from rosidl_runtime_py.utilities import get_message","from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy","BE=QoSProfile(depth=5,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)","rclpy.init()","n=rclpy.create_node('ros2ide_monitor')","MsgClass=None","deadline=time.time()+5.0","while time.time()<deadline and MsgClass is None:"," infos=n.get_topic_names_and_types()",` " matches=[t for t in infos if t[0]=='${topic}']`," if matches:","  try:","   mtype=matches[0][1][0]","   MsgClass=get_message(mtype)","   print('READY:'+mtype,flush=True)","  except Exception as e:","   print('ERR:'+str(e),flush=True); break"," else:","  rclpy.spin_once(n,timeout_sec=0.2)","if MsgClass is None:"," print('ERR:Cannot find topic',flush=True)"," n.destroy_node(); rclpy.shutdown(); sys.exit(1)","def cb(msg):"," try:","  import rosidl_runtime_py","  d=rosidl_runtime_py.message_to_ordereddict(msg)","  print('---',flush=True)","  print(yaml.dump(d,default_flow_style=False).rstrip(),flush=True)"," except Exception as e:","  print('ERR:'+str(e),flush=True)",`"n.create_subscription(MsgClass,'${topic}',cb,BE)"`,"try:"," rclpy.spin(n)","except: pass","n.destroy_node()","rclpy.shutdown()"].join('\n');
      agentReq(sess.robotKey,'fs_write',{path:'/tmp/_mon.py',content:py}).then(()=>{
        ag.ws.send(JSON.stringify({type:'pty_init',termId:monTermId}));
        setTimeout(()=>ag.ws.send(JSON.stringify({type:'pty_input',termId:monTermId,data:`source ${src} 2>/dev/null; python3 -u /tmp/_mon.py\n`})),400);
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
  let authorizedAgent=false;

  ws.on('message',message=>{
    let msg;try{msg=JSON.parse(message);}catch{return;}

    if(pathname==='/ws/agent'){
      if(msg.type==='auth'){
        const rk=msg.robotKey||msg.robotId||'';
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(rk)){ws.send(JSON.stringify({type:'auth_error',message:'Invalid robot key'}));return ws.close();}
        db.query('SELECT name FROM robots WHERE robot_key=?',[rk]).then(([rows])=>{
          if(!rows.length){ws.send(JSON.stringify({type:'auth_pending',message:'Robot key is not registered'}));return ws.close();}
          const old=agents.get(rk);if(old&&old.ws!==ws){try{old.ws.close(4001,'Replaced by a new agent connection');}catch{}}
          connId=rk;authorizedAgent=true;agents.set(rk,{ws,lastSeen:Date.now()});broadcastStatus(rk,true);
          ws.send(JSON.stringify({type:'auth_ok',robotName:rows[0].name}));
          console.log(`[CLOUD] 🤖 Agent: ${rows[0].name}`);
        }).catch(()=>ws.close());
      }
      else if(authorizedAgent&&msg.type==='response'){const cb=pendingReqs.get(msg.reqId);if(cb){cb(msg);pendingReqs.delete(msg.reqId);}}
      else if(authorizedAgent&&(msg.type==='pty_output'||msg.type==='pty_closed')){
        if(msg.termId?.startsWith('mon_')&&msg.type==='pty_output'){
          const raw=Buffer.from(msg.data,'base64').toString('utf8');
          const text=raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/[\x00-\x08\x0e-\x1f\x7f]/g,'');
          const mws=monSockets.get(msg.termId);
          if(mws?.readyState===WebSocket.OPEN){
            if(text.includes('READY:'))mws.send(JSON.stringify({type:'ready'}));
            if(text.includes('ERR:'))mws.send(JSON.stringify({type:'error',message:text.split('\n').find(l=>l.includes('ERR:'))||''}));
            if(text.trim())mws.send(JSON.stringify({type:'msg',data:text}));
          }
        } else if((msg.termId?.startsWith('rviz_')||msg.termId?.startsWith('lidar_')||msg.termId?.startsWith('tune_')||msg.termId?.startsWith('mapping_')||msg.termId?.startsWith('navigation_'))&&msg.type==='pty_output'){
          const clean=Buffer.from(msg.data,'base64').toString('utf8').replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/[\x00-\x08\x0e-\x1f\x7f]/g,'');
          let buf=(rvizBuffers.get(msg.termId)||'')+clean;
          const wws=webSockets.get(msg.termId);
          let extracted=[],i=0;
          while(i<buf.length){const s0=buf.indexOf('{',i);if(s0<0){buf='';break;}let depth=0,j=s0,inStr=false,esc=false;for(;j<buf.length;j++){const ch=buf[j];if(esc){esc=false;continue;}if(ch==='\\'&&inStr){esc=true;continue;}if(ch==='"'){inStr=!inStr;continue;}if(inStr)continue;if(ch==='{')depth++;else if(ch==='}'){depth--;if(depth===0)break;}}if(depth===0&&j<buf.length){extracted.push(buf.slice(s0,j+1));i=j+1;}else{buf=buf.slice(s0);break;}}
          rvizBuffers.set(msg.termId,buf);
          if(wws?.readyState===WebSocket.OPEN)extracted.forEach(js=>{try{const data=JSON.parse(js);wws.send(JSON.stringify(msg.termId.startsWith('lidar_')?{type:'scan',data}:msg.termId.startsWith('tune_')?{type:'telemetry',data}:msg.termId.startsWith('mapping_')?{type:'mapping',data}:msg.termId.startsWith('navigation_')?{type:'navigation',data}:{type:'data',data:js}));}catch{}});
        } else {
          const wws=webSockets.get(msg.termId);
          if(wws?.readyState===WebSocket.OPEN)wws.send(JSON.stringify(msg));
        }
      }
    }
    else if(pathname==='/ws/terminal'||pathname==='/ws/rviz'||pathname==='/ws/lidar'||pathname==='/ws/controller-tune'||pathname==='/ws/mapping'||pathname==='/ws/navigation'){
      if(msg.type==='init'||msg.type==='start'){
        const sess=sessions.get(msg.sessionId);
        if(sess&&sess.userId!==ws.user?.id){ws.send(JSON.stringify({type:'error',message:'Forbidden'}));return;}
        if(!sess){ws.send(JSON.stringify({type:'error',message:'Session not found'}));return;}
        const ag=agents.get(sess.robotKey);
        if(!ag||ag.ws.readyState!==WebSocket.OPEN){ws.send(JSON.stringify({type:'error',message:'Robot offline'}));return;}
        const termId=(pathname==='/ws/rviz'?'rviz_':pathname==='/ws/lidar'?'lidar_':pathname==='/ws/controller-tune'?'tune_':pathname==='/ws/mapping'?'mapping_':pathname==='/ws/navigation'?'navigation_':'term_')+mkId();
        connId=termId; webSockets.set(termId,ws); ws.termId=termId; ws.robotKey=sess.robotKey;
        ag.ws.send(JSON.stringify({type:'pty_init',termId,cols:msg.cols||120,rows:msg.rows||30}));
        const src=sess.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
        if(pathname==='/ws/controller-tune'){
          const port=String(msg.port||''),baud=Math.trunc(Number(msg.baud)),requestedMotorCount=Math.trunc(Number(msg.motorCount)),motorCount=Number.isInteger(requestedMotorCount)&&requestedMotorCount>0?requestedMotorCount:2;
          if(!/^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/.test(port)||!Number.isInteger(baud)||baud<9600||baud>3000000||!Number.isInteger(motorCount)||motorCount<1||motorCount>8){ws.send(JSON.stringify({type:'error',message:'Invalid serial configuration'}));return;}
          ws.motorCount=motorCount;
          const pyLines=[
            '# ros2ide_controller_tune',
            'import json,os,re,select,sys,time',
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
            'def emit(event,**values):',
            " values['event']=event; values['receivedAt']=int(time.time()*1000); print(json.dumps(values,separators=(',',':')),flush=True)",
            'def parse_line(line):',
            " fields=line.replace(',', ' ').split(); kind=fields[0].upper() if fields else ''",
            ' try:',
            "  if kind=='ROSIDE_CONTROLLER_READY' and len(fields)==1: emit('frame',kind='READY',values=[],line=line)",
            "  elif kind=='RPM' and len(fields)==1+(motor_count*2): emit('frame',kind=kind,values=[float(v) for v in fields[1:]],line=line)",
            "  elif kind=='ODOM' and len(fields)==7: emit('frame',kind=kind,values=[float(v) for v in fields[1:]],line=line)",
            "  elif kind in ('GYRO','IMU') and len(fields)==4: emit('frame',kind='GYRO',values=[float(v) for v in fields[1:]],line=line)",
            "  elif kind=='PID' and len(fields)==1+(motor_count*3): emit('frame',kind=kind,values=[float(v) for v in fields[1:]],line=line)",
            "  else: emit('invalid_frame',line=line)",
            " except ValueError: emit('invalid_frame',line=line)",
            'while True:',
            ' readable,_,_=select.select([sys.stdin,ser],[],[],0.05)',
            ' if sys.stdin in readable:',
            '  command=sys.stdin.readline().strip()',
            "  if valid_command.fullmatch(command): ser.write((command+'\\n').encode('ascii')); emit('command_sent',command=command)",
            ' if ser in readable or ser.in_waiting:',
            "  chunk=ser.read(ser.in_waiting or 1)",
            "  if chunk: serial_buffer+=chunk",
            "  if len(serial_buffer)>16384: serial_buffer=serial_buffer[-8192:]",
            "  while b'\\n' in serial_buffer:",
            "   raw,serial_buffer=serial_buffer.split(b'\\n',1)",
            "   line=raw.rstrip(b'\\r').decode('ascii',errors='replace').strip()",
            "   if line: parse_line(line)",
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_roside_controller_tune.py',content:pyLines.join('\n')}).then(()=>{
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:'python3 -u /tmp/_roside_controller_tune.py\n'}));
            ws.send(JSON.stringify({type:'ready',port,baud}));
          }).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
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
            " out={'angleMin':m.angle_min,'angleMax':m.angle_max,'angleIncrement':m.angle_increment,'rangeMin':m.range_min,'rangeMax':m.range_max,'ranges':ranges,'receivedAt':int(wall*1000),'interval':interval,'hz':hz,'scanTime':float(m.scan_time)}",
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
          }).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
        } else if(pathname==='/ws/mapping'){
          const root=(sess.workspace||'~/ros2_ws').replace(/\/$/,'');
          const port=String(msg.controllerPort||''),baud=Math.trunc(Number(msg.controllerBaud)),pidCommand=String(msg.pidCommand||'').trim();
          if(!SERIAL_DEVICE_PATTERN.test(port)||!Number.isInteger(baud)||baud<9600||baud>3000000||!(/^(?:|P(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)){6})$/.test(pidCommand))){ws.send(JSON.stringify({type:'error',message:'Controller COM port, baud rate หรือ PID ไม่ถูกต้อง'}));return;}
          const pyLines=[
            '# ros2ide_mapping_live','import json,math,select,sys,time','import rclpy,serial','from geometry_msgs.msg import TransformStamped','from nav_msgs.msg import OccupancyGrid,Odometry','from sensor_msgs.msg import LaserScan','from tf2_msgs.msg import TFMessage','from tf2_ros import TransformBroadcaster','from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy',
            'BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)','MAPQ=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)',
            `PORT=${JSON.stringify(port)}; BAUD=${baud}; PID=${JSON.stringify(pidCommand)}`,"state={'map':None,'scan':None,'odom':None,'mapTf':None,'tx':'S','ready':False,'rpm':None}",'last_cmd=0.0','serial_buf=b\'\'','try:'," ser=serial.Serial(PORT,BAUD,timeout=0); print(json.dumps({'event':'controller_connected','port':PORT,'baud':BAUD},separators=(',',':')),flush=True)",'except Exception as e:'," print(json.dumps({'event':'controller_error','message':str(e),'port':PORT},separators=(',',':')),flush=True); sys.exit(2)",'rclpy.init()','n=rclpy.create_node(\'ros2ide_mapping_live\')',"odom_pub=n.create_publisher(Odometry,'/odom',20)",'tf_pub=TransformBroadcaster(n)',
            'def map_cb(m):'," step=max(1,int(math.ceil(max(m.info.width,m.info.height)/320.0)))"," data=[int(m.data[y*m.info.width+x]) for y in range(0,m.info.height,step) for x in range(0,m.info.width,step)]"," state['map']={'width':(m.info.width+step-1)//step,'height':(m.info.height+step-1)//step,'resolution':m.info.resolution*step,'originX':m.info.origin.position.x,'originY':m.info.origin.position.y,'data':data}",
            'def scan_cb(m):',' step=max(1,len(m.ranges)//720)'," state['scan']={'angleMin':m.angle_min,'angleIncrement':m.angle_increment*step,'rangeMin':m.range_min,'rangeMax':m.range_max,'ranges':[float(v) if math.isfinite(v) else None for v in m.ranges[::step]]}",
            'def tf_cb(m):',' for t in m.transforms:',"  if t.header.frame_id.lstrip('/')=='map' and t.child_frame_id.lstrip('/')=='odom':","   q=t.transform.rotation; state['mapTf']=(t.transform.translation.x,t.transform.translation.y,math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z)))",
            'def odom_cb(m):',' p=m.pose.pose; q=p.orientation',' x=p.position.x; y=p.position.y; yaw=math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))'," tf=state['mapTf']"," if tf is not None: x,y=tf[0]+math.cos(tf[2])*x-math.sin(tf[2])*y,tf[1]+math.sin(tf[2])*x+math.cos(tf[2])*y; yaw+=tf[2]"," state['odom']={'x':x,'y':y,'yaw':yaw}",
            'def send(command):'," ser.write((command+'\\n').encode('ascii')); state['tx']=command",
            'def serial_line(line):',' f=line.replace(\',\',\' \').split(); kind=f[0].upper() if f else \"\"',' try:',"  if kind=='ROSIDE_CONTROLLER_READY': state['ready']=True; PID and send(PID)","  elif kind=='RPM' and len(f)>=5 and (len(f)-1)%2==0: state['rpm']=[float(v) for v in f[1:]]","  elif len(f)==7 and kind=='ODOM':","   x,y,yaw,vx,vy,wz=map(float,f[1:]); now=n.get_clock().now().to_msg(); qz=math.sin(yaw/2); qw=math.cos(yaw/2); m=Odometry(); m.header.stamp=now; m.header.frame_id='odom'; m.child_frame_id='base_link'; m.pose.pose.position.x=x; m.pose.pose.position.y=y; m.pose.pose.orientation.z=qz; m.pose.pose.orientation.w=qw; m.twist.twist.linear.x=vx; m.twist.twist.linear.y=vy; m.twist.twist.angular.z=wz; odom_pub.publish(m)","   t=TransformStamped(); t.header=m.header; t.child_frame_id='base_link'; t.transform.translation.x=x; t.transform.translation.y=y; t.transform.rotation.z=qz; t.transform.rotation.w=qw; tf_pub.sendTransform(t)",' except ValueError: pass',
            "n.create_subscription(OccupancyGrid,'/map',map_cb,MAPQ)","n.create_subscription(LaserScan,'/scan',scan_cb,BE)","n.create_subscription(Odometry,'/odom',odom_cb,BE)","n.create_subscription(TFMessage,'/tf',tf_cb,BE)",'last_emit=0.0',
            'while rclpy.ok():',' rclpy.spin_once(n,timeout_sec=0.02)',' now=time.monotonic()',' if select.select([sys.stdin],[],[],0)[0]:',"  line=sys.stdin.readline().strip().split()","  if len(line)==3 and line[0]=='CMD':","   try: send('V %.4f 0 %.4f'%(float(line[1]),float(line[2]))); last_cmd=now","   except (ValueError,OSError): pass","  elif line and line[0]=='STOP': send('S'); last_cmd=0.0",' try:',"  chunk=ser.read(ser.in_waiting or 0)",'  if chunk: serial_buf+=chunk',"  while b'\\n' in serial_buf:","   raw,serial_buf=serial_buf.split(b'\\n',1); serial_line(raw.rstrip(b'\\r').decode('ascii',errors='replace').strip())",' except OSError: pass',' if last_cmd and now-last_cmd>.35: send(\'S\'); last_cmd=0.0',' if now-last_emit>=.12:','  last_emit=now',"  print(json.dumps({'map':state['map'],'scan':state['scan'],'odom':state['odom'],'controller':{'connected':True,'port':PORT,'tx':state['tx'],'ready':state['ready'],'rpm':state['rpm']},'receivedAt':int(time.time()*1000)},separators=(',',':')),flush=True)","  state['map']=None; state['scan']=None","try: send('S'); ser.close()","except: pass",'n.destroy_node(); rclpy.shutdown()'
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_roside_mapping_live.py',content:pyLines.join('\n')}).then(()=>{
            const setup=`source ${remoteShellPath(src)} 2>/dev/null; source ${remoteShellPath(root+'/install/setup.bash')} 2>/dev/null || true; python3 -u /tmp/_roside_mapping_live.py\n`;
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:setup}));ws.send(JSON.stringify({type:'ready',controllerPort:port,baud,topics:['/map','/scan','/odom']}));
          }).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
        } else if(pathname==='/ws/navigation'){
          const root=(sess.workspace||'~/ros2_ws').replace(/\/$/,'');const port=String(msg.controllerPort||''),baud=Math.trunc(Number(msg.controllerBaud)),pidCommand=String(msg.pidCommand||'').trim(),maxSpeed=Number(msg.maxSpeed),maxTurn=Number(msg.maxTurn);
          if(!SERIAL_DEVICE_PATTERN.test(port)||!Number.isInteger(baud)||baud<9600||baud>3000000||!Number.isFinite(maxSpeed)||maxSpeed<.05||maxSpeed>1.5||!Number.isFinite(maxTurn)||maxTurn<.1||maxTurn>3||!(/^(?:|P(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)){6})$/.test(pidCommand))){ws.send(JSON.stringify({type:'error',message:'Controller configuration ไม่ถูกต้อง'}));return;}
          const pyLines=[
            '# ros2ide_navigation_live','import json,math,select,sys,time','import rclpy,serial','from action_msgs.msg import GoalStatus','from geometry_msgs.msg import PoseStamped,PoseWithCovarianceStamped,TransformStamped,Twist','from nav2_msgs.action import NavigateToPose,NavigateThroughPoses','from nav_msgs.msg import OccupancyGrid,Odometry,Path','from sensor_msgs.msg import LaserScan','from tf2_ros import TransformBroadcaster','from rclpy.action import ActionClient','from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy',
            'BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)','MAPQ=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)',`PORT=${JSON.stringify(port)}; BAUD=${baud}; PID=${JSON.stringify(pidCommand)}; MAX_SPEED=${maxSpeed}; MAX_TURN=${maxTurn}`,"state={'map':None,'scan':None,'pose':None,'path':None,'tx':'S','nav':'idle','remaining':0}",'serial_buf=b\'\'','last_cmd=0.0','goal_handle=None',
            'def emit(**v): print(json.dumps(v,separators=(\',\',\':\')),flush=True)','try:'," ser=serial.Serial(PORT,BAUD,timeout=0); emit(event='controller_connected',port=PORT,baud=BAUD)",'except Exception as e:'," emit(event='controller_error',port=PORT,message=str(e)); sys.exit(2)",'rclpy.init()',"n=rclpy.create_node('ros2ide_navigation_live')","odom_pub=n.create_publisher(Odometry,'/odom',20)","initial_pub=n.create_publisher(PoseWithCovarianceStamped,'/initialpose',10)",'tf_pub=TransformBroadcaster(n)',"client=ActionClient(n,NavigateToPose,'navigate_to_pose')","route_client=ActionClient(n,NavigateThroughPoses,'navigate_through_poses')",
            'def send(c):'," ser.write((c+'\\n').encode('ascii')); state['tx']=c",'def quat(yaw): return math.sin(yaw/2),math.cos(yaw/2)',
            'def map_cb(m):'," step=max(1,int(math.ceil(max(m.info.width,m.info.height)/360.0)))"," data=[int(m.data[y*m.info.width+x]) for y in range(0,m.info.height,step) for x in range(0,m.info.width,step)]"," state['map']={'width':(m.info.width+step-1)//step,'height':(m.info.height+step-1)//step,'resolution':m.info.resolution*step,'originX':m.info.origin.position.x,'originY':m.info.origin.position.y,'data':data}",
            'def scan_cb(m):',' step=max(1,len(m.ranges)//720)'," state['scan']={'angleMin':m.angle_min,'angleIncrement':m.angle_increment*step,'ranges':[float(v) if math.isfinite(v) else None for v in m.ranges[::step]]}",
            'def pose_cb(m):',' p=m.pose.pose; q=p.orientation'," state['pose']={'x':p.position.x,'y':p.position.y,'yaw':math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z))}",'def path_cb(m):'," step=max(1,len(m.poses)//300); state['path']=[{'x':p.pose.position.x,'y':p.pose.position.y} for p in m.poses[::step]]",'def cmd_cb(m):'," global last_cmd; vx=max(-MAX_SPEED,min(MAX_SPEED,m.linear.x)); wz=max(-MAX_TURN,min(MAX_TURN,m.angular.z)); send('S' if abs(vx)<1e-5 and abs(wz)<1e-5 else 'V %.4f 0 %.4f'%(vx,wz)); last_cmd=time.monotonic()",
            'def serial_line(line):',' f=line.replace(\',\',\' \').split(); kind=f[0].upper() if f else \"\"',' try:',"  if kind=='ROSIDE_CONTROLLER_READY' and PID: send(PID)","  elif kind=='ODOM' and len(f)==7:","   x,y,yaw,vx,vy,wz=map(float,f[1:]); stamp=n.get_clock().now().to_msg(); qz,qw=quat(yaw); m=Odometry(); m.header.stamp=stamp; m.header.frame_id='odom'; m.child_frame_id='base_link'; m.pose.pose.position.x=x; m.pose.pose.position.y=y; m.pose.pose.orientation.z=qz; m.pose.pose.orientation.w=qw; m.twist.twist.linear.x=vx; m.twist.twist.linear.y=vy; m.twist.twist.angular.z=wz; odom_pub.publish(m)","   t=TransformStamped(); t.header=m.header; t.child_frame_id='base_link'; t.transform.translation.x=x; t.transform.translation.y=y; t.transform.rotation.z=qz; t.transform.rotation.w=qw; tf_pub.sendTransform(t)",' except ValueError: pass',
            'def result_cb(f):'," global goal_handle; r=f.result(); state['nav']='succeeded' if r.status==GoalStatus.STATUS_SUCCEEDED else 'canceled' if r.status==GoalStatus.STATUS_CANCELED else 'aborted'; state['remaining']=0; goal_handle=None; send('S')",'def feedback_cb(f):'," state['remaining']=int(getattr(f.feedback,'number_of_poses_remaining',state['remaining']))",'def goal_response(f):'," global goal_handle; goal_handle=f.result(); state['nav']='active' if goal_handle.accepted else 'rejected'"," if goal_handle.accepted: goal_handle.get_result_async().add_done_callback(result_cb)",'def stamped_pose(x,y,yaw):'," qz,qw=quat(yaw); p=PoseStamped(); p.header.frame_id='map'; p.header.stamp=n.get_clock().now().to_msg(); p.pose.position.x=x; p.pose.position.y=y; p.pose.orientation.z=qz; p.pose.orientation.w=qw; return p",'def goal(x,y,yaw):'," g=NavigateToPose.Goal(); g.pose=stamped_pose(x,y,yaw)"," if not client.wait_for_server(timeout_sec=1.0): state['nav']='server_unavailable'; return"," state['remaining']=1; state['nav']='sending'; client.send_goal_async(g,feedback_callback=feedback_cb).add_done_callback(goal_response)",'def route(points):'," g=NavigateThroughPoses.Goal(); g.poses=[stamped_pose(float(p['x']),float(p['y']),float(p.get('yaw',0))) for p in points]"," if not g.poses or not route_client.wait_for_server(timeout_sec=1.0): state['nav']='server_unavailable'; return"," state['remaining']=len(g.poses); state['nav']='sending_route'; route_client.send_goal_async(g,feedback_callback=feedback_cb).add_done_callback(goal_response)",
            'def initial(x,y,yaw):'," qz,qw=quat(yaw); m=PoseWithCovarianceStamped(); m.header.frame_id='map'; m.header.stamp=n.get_clock().now().to_msg(); m.pose.pose.position.x=x; m.pose.pose.position.y=y; m.pose.pose.orientation.z=qz; m.pose.pose.orientation.w=qw; m.pose.covariance[0]=.25; m.pose.covariance[7]=.25; m.pose.covariance[35]=.0685; initial_pub.publish(m)",
            "n.create_subscription(OccupancyGrid,'/map',map_cb,MAPQ)","n.create_subscription(LaserScan,'/scan',scan_cb,BE)","n.create_subscription(PoseWithCovarianceStamped,'/amcl_pose',pose_cb,10)","n.create_subscription(Path,'/plan',path_cb,10)","n.create_subscription(Twist,'/cmd_vel',cmd_cb,20)",'last_emit=0.0','while rclpy.ok():',' rclpy.spin_once(n,timeout_sec=.02)',' now=time.monotonic()',' if select.select([sys.stdin],[],[],0)[0]:',"  raw_input=sys.stdin.readline().strip(); f=raw_input.split()",'  try:',"   if len(f)==4 and f[0]=='POSE': initial(*map(float,f[1:]))","   elif len(f)==4 and f[0]=='GOAL': goal(*map(float,f[1:]))","   elif raw_input.startswith('ROUTE '): route(json.loads(raw_input[6:]))","   elif f and f[0]=='CANCEL': goal_handle and goal_handle.cancel_goal_async(); state['nav']='canceled'; state['remaining']=0; send('S')",'  except (ValueError,TypeError,json.JSONDecodeError): state[\'nav\']=\'invalid_route\'',' try:',"  chunk=ser.read(ser.in_waiting or 0)",'  if chunk: serial_buf+=chunk',"  while b'\\n' in serial_buf:","   raw,serial_buf=serial_buf.split(b'\\n',1); serial_line(raw.rstrip(b'\\r').decode('ascii',errors='replace').strip())",' except OSError: pass'," if last_cmd and now-last_cmd>.5: send('S'); last_cmd=0.0",' if now-last_emit>=.12:','  last_emit=now',"  emit(map=state['map'],scan=state['scan'],pose=state['pose'],path=state['path'],controller={'connected':True,'tx':state['tx']},nav=state['nav'],remaining=state['remaining'],receivedAt=int(time.time()*1000)); state['map']=None; state['scan']=None; state['path']=None","try: send('S'); ser.close()","except: pass",'n.destroy_node(); rclpy.shutdown()'
          ];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_roside_navigation_live.py',content:pyLines.join('\n')}).then(()=>{const setup=`source ${remoteShellPath(src)} 2>/dev/null; source ${remoteShellPath(root+'/install/setup.bash')} 2>/dev/null || true; python3 -u /tmp/_roside_navigation_live.py\n`;ag.ws.send(JSON.stringify({type:'pty_input',termId,data:setup}));ws.send(JSON.stringify({type:'ready',controllerPort:port,baud}));}).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
        } else if(pathname==='/ws/rviz'){
          const oTopic=msg.odom||'none',lTopic=msg.laser||'none';
          const validTopic=t=>t==='none'||(typeof t==='string'&&/^\/[A-Za-z0-9_/-]+$/.test(t));
          if(!validTopic(oTopic)||!validTopic(lTopic)){ws.send(JSON.stringify({type:'error',message:'Invalid RViz topic'}));return;}
          const pyLines=["# ros2ide_rviz_rt","import rclpy,json,sys,math,threading,time,signal","from rclpy.node import Node","from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy","BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)","ST=QoSProfile(depth=100,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)","buf={'tf':{},'odom':None,'scan':None,'tf_seen':{}}","lk=threading.Lock()","running=True","def stop(s,f): global running; running=False","signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)","class N(Node):"," def __init__(self):","  super().__init__('ros2ide_rviz_rt')","  from tf2_msgs.msg import TFMessage","  self.create_subscription(TFMessage,'/tf',self.cb_tf,BE)","  self.create_subscription(TFMessage,'/tf_static',self.cb_tf,ST)",...(oTopic!=='none'?["  from nav_msgs.msg import Odometry",`  self.create_subscription(Odometry,'${oTopic}',self.cb_od,BE)`]:[]),...(lTopic!=='none'?["  from sensor_msgs.msg import LaserScan",`  self.create_subscription(LaserScan,'${lTopic}',self.cb_sc,BE)`]:[]),["  from std_msgs.msg import String","  self._last_desc=None","  self.create_subscription(String,'/robot_description',self.cb_desc,ST)"]," def cb_tf(self,m):"," with lk:","  for t in m.transforms:","   tr,ro=t.transform.translation,t.transform.rotation","   buf['tf'][t.child_frame_id]={'frame':t.child_frame_id,'parent':t.header.frame_id,'x':tr.x,'y':tr.y,'z':tr.z,'qx':ro.x,'qy':ro.y,'qz':ro.z,'qw':ro.w}; buf['tf_seen'][t.child_frame_id]=time.time()"," def cb_od(self,m):","  p=m.pose.pose","  with lk: buf['odom']={'x':p.position.x,'y':p.position.y,'qz':p.orientation.z,'qw':p.orientation.w}"," def cb_sc(self,m):","  r=[float(v) if not(math.isinf(v) or math.isnan(v)) else 0.0 for v in m.ranges]","  st=max(1,len(r)//360)","  with lk: buf['scan']={'amin':m.angle_min,'ainc':m.angle_increment*st,'ranges':r[::st]}"," def cb_desc(self,m):","  if m.data and m.data!=self._last_desc:","   self._last_desc=m.data","   with lk: buf['desc']=m.data","rclpy.init()","n=N()","ex=rclpy.executors.SingleThreadedExecutor()","ex.add_node(n)","last=time.time()","while running:"," ex.spin_once(timeout_sec=0.05)"," now=time.time()"," if now-last>=0.1:","  last=now","  with lk:","   for _k in list(buf['tf'].keys()):","    if now-buf['tf_seen'].get(_k,0)>8.0: buf['tf'].pop(_k,None); buf['tf_seen'].pop(_k,None)","   out={}","   if buf['tf']: out['tf']=list(buf['tf'].values())","   if buf['odom']: out['odom']=buf['odom']","   if buf['scan']: out['scan']=buf['scan']; buf['scan']=None","   if buf.get('desc') is not None: out['desc']=buf['desc']; buf['desc']=None","  try:","   sys.stdout.write(json.dumps(out,separators=(',',':'))+'\\n')","   sys.stdout.flush()","  except: pass","n.destroy_node(); rclpy.shutdown()"];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_rviz_rt.py',content:pyLines.join('\n')}).then(()=>{
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:`pkill -f ros2ide_rviz_rt 2>/dev/null||true; source ${src} 2>/dev/null; python3 -u /tmp/_rviz_rt.py\n`}));
            ws.send(JSON.stringify({type:'ready',rosInfo:sess.rosInfo}));
          }).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
        } else {
          const configuredWorkspace=String(sess.workspace||'~/ros2_ws');
          const quote=value=>`'${String(value).replace(/'/g,`'\\''`)}'`;
          const terminalSetup=`ROSIDE_WS=${quote(configuredWorkspace)}; case "$ROSIDE_WS" in '~') ROSIDE_WS="$HOME";; '~/'*) ROSIDE_WS="$HOME/\${ROSIDE_WS:2}";; esac; cd "$ROSIDE_WS" 2>/dev/null || cd "$HOME"; source ${quote(src)} 2>/dev/null; [ -f install/setup.bash ] && source install/setup.bash 2>/dev/null\n`;
          setTimeout(()=>{ag.ws.send(JSON.stringify({type:'pty_input',termId,data:terminalSetup}));ws.send(JSON.stringify({type:'ready',rosInfo:sess.rosInfo,workspace:configuredWorkspace}));},300);
        }
      }
      else if(msg.type==='command'&&pathname==='/ws/controller-tune'){
        const command=String(msg.command||'').trim(),number='-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)',motorCount=Number(ws.motorCount)||0,valid=new RegExp(`^(?:S|Z|V\\s+${number}\\s+${number}\\s+${number}|R(?:\\s+${number}){${motorCount}}|P(?:\\s+${number}){${motorCount*3}})$`);
        const ag=agents.get(ws.robotKey);if(valid.test(command)&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:command+'\n'}));else ws.send(JSON.stringify({type:'error',message:'Invalid controller command'}));
      }
      else if(msg.type==='command'&&pathname==='/ws/mapping'){
        const command=String(msg.command||'').trim(),valid=/^(?:STOP|CMD\s+-?(?:\d+(?:\.\d*)?|\.\d+)\s+-?(?:\d+(?:\.\d*)?|\.\d+))$/;
        const ag=agents.get(ws.robotKey);if(valid.test(command)&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:command+'\n'}));
      }
      else if(msg.type==='command'&&pathname==='/ws/navigation'){
        const command=String(msg.command||'').trim(),number='-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)',valid=new RegExp(`^(?:CANCEL|(?:POSE|GOAL)\\s+${number}\\s+${number}\\s+${number})$`);const ag=agents.get(ws.robotKey);if(valid.test(command)&&ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:command+'\n'}));else ws.send(JSON.stringify({type:'error',message:'Invalid Navigation command'}));
      }
      else if(msg.type==='route'&&pathname==='/ws/navigation'){
        const points=Array.isArray(msg.points)?msg.points:[],valid=points.length>0&&points.length<=50&&points.every(point=>['x','y','yaw'].every(key=>Number.isFinite(Number(point?.[key])))&&Math.abs(Number(point.x))<=10000&&Math.abs(Number(point.y))<=10000);const ag=agents.get(ws.robotKey);if(valid&&ag&&ws.termId){const safe=points.map(point=>({x:Number(point.x),y:Number(point.y),yaw:Number(point.yaw)}));ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:'ROUTE '+JSON.stringify(safe)+'\n'}));}else ws.send(JSON.stringify({type:'error',message:'Invalid Navigation route'}));
      }
      else if(msg.type==='data'){const ag=agents.get(ws.robotKey);if(ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_input',termId:ws.termId,data:msg.data}));}
      else if(msg.type==='resize'){const ag=agents.get(ws.robotKey);if(ag&&ws.termId)ag.ws.send(JSON.stringify({type:'pty_resize',termId:ws.termId,cols:msg.cols,rows:msg.rows}));}
    }
  });

  ws.on('close',()=>{
    if(pathname==='/ws/agent'&&connId&&agents.get(connId)?.ws===ws){agents.delete(connId);broadcastStatus(connId,false);console.log(`[CLOUD] ❌ Agent disconnected: ${connId}`);}
    else if(connId){webSockets.delete(connId);rvizBuffers.delete(connId);if(ws.robotKey){const ag=agents.get(ws.robotKey);if(ag)ag.ws.send(JSON.stringify({type:'pty_close',termId:connId}));}}
  });
});

setInterval(()=>{const now=Date.now();for(const[id,s]of sessions)if(s.expiresAt&&s.expiresAt<now)sessions.delete(id);for(const[code,ticket]of applicationLaunchTickets)if(ticket.expiresAt<now)applicationLaunchTickets.delete(code);for(const[ip,ts]of loginAttempts){const fresh=ts.filter(t=>now-t<15*60*1000);fresh.length?loginAttempts.set(ip,fresh):loginAttempts.delete(ip);}},60*1000).unref();

async function start(){
  try{
    await db.query('SELECT 1');
    await db.query('DELETE FROM sessions WHERE expires_at<=NOW()');
    await db.query("CREATE TABLE IF NOT EXISTS user_subscriptions (id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id INT NOT NULL UNIQUE,plan_code ENUM('pro_monthly','pro_yearly','pro_lifetime') NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'active',provider VARCHAR(32) NOT NULL DEFAULT 'stripe',provider_customer_id VARCHAR(255) NULL,provider_subscription_id VARCHAR(255) NULL UNIQUE,starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at DATETIME NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)");
    await db.query("CREATE TABLE IF NOT EXISTS payment_events (id BIGINT AUTO_INCREMENT PRIMARY KEY,provider VARCHAR(32) NOT NULL,event_id VARCHAR(255) NOT NULL,event_type VARCHAR(128) NOT NULL,status VARCHAR(32) NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,processed_at DATETIME NULL,UNIQUE KEY uniq_provider_event(provider,event_id))");
    await db.query("CREATE TABLE IF NOT EXISTS support_chat_messages (id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id INT NOT NULL,message VARCHAR(1000) NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,INDEX idx_support_chat_created(created_at),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)");
    await db.query("CREATE TABLE IF NOT EXISTS applications (id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(128) NOT NULL, description VARCHAR(512) DEFAULT '', category VARCHAR(100) DEFAULT 'Application', icon VARCHAR(2048) DEFAULT '🚀', redirect_url VARCHAR(2048) NOT NULL, session_mode ENUM('none','ticket') NOT NULL DEFAULT 'none', enabled TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL)");
    await db.query("ALTER TABLE applications MODIFY icon VARCHAR(2048) NOT NULL DEFAULT '🚀'");
    await db.query("INSERT IGNORE INTO applications(slug,name,description,category,icon,redirect_url,session_mode,enabled,sort_order) VALUES('ros2-robotics','ROS2 Robotics','จัดการหุ่นยนต์ เชื่อมต่อเครื่องมือ ROS2 และเริ่มสร้างภารกิจหุ่นยนต์สุดเจ๋ง','Robotics & Coding','🤖','/robots','none',1,0)");
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
