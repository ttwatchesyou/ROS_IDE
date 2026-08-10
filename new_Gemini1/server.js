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
const { buildProjectScanScript, parseProjectScanOutput } = require('./project-scanner');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });
const PORT   = process.env.PORT || 3000;
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
app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));
// 🧹 ห้ามแคชฝั่งเบราว์เซอร์สำหรับ js/html/css — กันโหลด rviz.js/app.js ตัวเก่าแคชไว้
//    (สาเหตุที่แก้โค้ดแล้วอาการเดิมยังอยู่ บ่อยครั้งคือเบราว์เซอร์รัน JS ตัวเก่า)
app.use((req,res,next)=>{
  if(/\.(js|html|css|map)$/.test(req.path||'')) res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
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
const projectScanCache = new Map(); // sessionId -> { expiresAt, promise }

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

// Encrypt/decrypt
const encSecret = process.env.ENC_KEY || crypto.randomBytes(32).toString('hex');
if (!process.env.ENC_KEY) console.warn('[SECURITY] ENC_KEY is not set; encrypted values cannot be recovered after restart');
const ENC_KEY = crypto.createHash('sha256').update(encSecret).digest();
function encrypt(t){
  if(!t)return'';
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv);
  const body=Buffer.concat([c.update(String(t),'utf8'),c.final()]);
  return ['gcm',iv.toString('hex'),c.getAuthTag().toString('hex'),body.toString('hex')].join(':');
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
async function tokenUser(token){
  if(!token) return null;
  const[rows]=await db.query('SELECT s.user_id,u.username,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>NOW()',[token]);
  return rows.length?{id:rows[0].user_id,username:rows[0].username,role:rows[0].role}:null;
}
async function auth(req,res,next){
  const token=req.headers['x-auth-token'];
  if(!token) return res.status(401).json({ok:false,error:'Unauthorized'});
  try{
    const user=await tokenUser(token);
    if(!user) return res.status(401).json({ok:false,error:'Session expired'});
    req.user=user;
    next();
  }catch(e){res.status(500).json({ok:false,error:e.message});}
}

// Static pages
app.get('/',         (_,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/robots',   (_,res)=>res.sendFile(path.join(__dirname,'public','robots.html')));
app.get('/app',      (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
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
    const token = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)', [token, rows[0].id, exp]);
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [rows[0].id]);
    loginAttempts.delete(ip);
    res.json({ ok: true, token, user: { id: rows[0].id, username: rows[0].username, role: rows[0].role } });
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
    const token = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.insertId, exp]);

    res.json({ ok: true, token, user: { id: user.insertId, username: username } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  await db.query('DELETE FROM sessions WHERE token=?',[req.headers['x-auth-token']]).catch(()=>{});
  res.json({ok:true});
});
app.get('/api/auth/me',auth,(req,res)=>res.json({ok:true,user:req.user}));

// ── Robots API ───────────────────────────────────────────────
app.get('/api/robots',auth,async(req,res)=>{
  try{
    // Admin เห็นหุ่นยนต์ทั้งหมด / User ธรรมดา เห็นเฉพาะตัวที่ตนเองเพิ่ม
    let rows;
    if(req.user.role==='admin'){
      [rows]=await db.query('SELECT r.*,u.username as added_by_name,(SELECT connected_at FROM robot_connections rc WHERE rc.robot_id=r.id ORDER BY rc.id DESC LIMIT 1) as last_connected FROM robots r LEFT JOIN users u ON r.added_by=u.id ORDER BY r.name');
    } else {
      [rows]=await db.query('SELECT r.*,u.username as added_by_name,(SELECT connected_at FROM robot_connections rc WHERE rc.robot_id=r.id ORDER BY rc.id DESC LIMIT 1) as last_connected FROM robots r LEFT JOIN users u ON r.added_by=u.id WHERE r.added_by=? ORDER BY r.name',[req.user.id]);
    }
    res.json({ok:true,robots:rows.map(r=>({...r,ssh_pass:undefined,online:robotOnline(r.robot_key)}))});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.post('/api/robots',auth,async(req,res)=>{
  const{robot_key,name,ssh_user,ssh_pass,workspace,description}=req.body;
  if(!robot_key||!name) return res.status(400).json({ok:false,error:'robot_key and name required'});
  if(!/^(SIM-)?[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/.test(robot_key)) return res.status(400).json({ok:false,error:'Invalid robot key'});
  try{
    const[ex]=await db.query('SELECT id FROM robots WHERE robot_key=?',[robot_key]);
    if(ex.length) return res.json({ok:false,error:'Robot key already registered'});
    const[r]=await db.query('INSERT INTO robots(robot_key,name,ssh_user,ssh_pass,workspace,description,added_by)VALUES(?,?,?,?,?,?,?)',[robot_key,name,ssh_user||'ubuntu',encrypt(ssh_pass||''),workspace||'~/ros2_ws',description||'',req.user.id]);
    res.json({ok:true,id:r.insertId});
  }catch(e){res.json({ok:false,error:e.message});}
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
    await db.query('DELETE FROM robots WHERE id=?',[req.params.id]);
    res.json({ok:true});
  }catch(e){res.json({ok:false,error:e.message});}
});

// ── IDE Connect/Disconnect ───────────────────────────────────
app.post('/api/connect',auth,async(req,res)=>{
  const{robotId}=req.body;
  try{
    const sql=req.user.role==='admin'?'SELECT * FROM robots WHERE id=?':'SELECT * FROM robots WHERE id=? AND added_by=?';
    const params=req.user.role==='admin'?[robotId]:[robotId,req.user.id];
    const[rows]=await db.query(sql,params);
    if(!rows.length) return res.json({ok:false,error:'Robot not found'});
    const robot=rows[0];
    if(isSim(robot.robot_key)&&req.user.role!=='admin'&&process.env.ALLOW_UNSANDBOXED_SIM!=='true')
      return res.status(503).json({ok:false,error:'Student simulation is disabled until an isolated runtime is configured'});
    if(isSim(robot.robot_key) && !agents.has(robot.robot_key))
      ensureSim(robot.robot_key);
    const ag=agents.get(robot.robot_key);
    if(!ag||ag.ws.readyState!==WebSocket.OPEN) return res.json({ok:false,error:'Robot offline'});
    const sessionId=mkId();
    const rosInfo=await agentReq(robot.robot_key,'exec',{command:'bash -lc "echo ROS_DISTRO=$ROS_DISTRO && echo SETUP=$(ls /opt/ros/*/setup.bash 2>/dev/null | head -1)"',timeout:5000})
      .then(d=>{const dm=d.stdout.match(/ROS_DISTRO=(\S+)/),sm=d.stdout.match(/SETUP=(\S+)/);return{distro:dm?dm[1]:'unknown',setupBash:sm?sm[1]:'/opt/ros/humble/setup.bash',version:'2'};})
      .catch(()=>({distro:'unknown',setupBash:'/opt/ros/humble/setup.bash',version:'2'}));
    sessions.set(sessionId,{robotKey:robot.robot_key,robotDbId:robot.id,rosInfo,workspace:robot.workspace,username:robot.ssh_user,userId:req.user.id,expiresAt:Date.now()+24*60*60*1000});
    await db.query('INSERT INTO robot_connections(robot_id,user_id)VALUES(?,?)',[robot.id,req.user.id]);
    res.json({ok:true,sessionId,rosInfo,workspace:robot.workspace,username:robot.ssh_user,robotName:robot.name,isSim:isSim(robot.robot_key)});
  }catch(e){res.json({ok:false,error:e.message});}
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
app.post('/api/sim/save-tf-package', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  try {
    if (isSim(s.robotKey)) {
      const out = writeTfPackage(s.robotKey, req.body.files || {});
      projectScanCache.delete(req.body.sessionId);
      return res.json({ ok:true, sim:true, ...out });
    }
    // real robot: write each file via the agent, kept inside ~/ros2_ws/src/sim_robot_tf
    const base = (s.workspace || '~/ros2_ws').replace(/\/$/, '');
    const written = [];
    for (const [rel, content] of Object.entries(req.body.files || {})) {
      await agentReq(s.robotKey, 'fs_write', { path: base + '/src/sim_robot_tf/' + rel, content: (content ?? '') });
      written.push(rel);
    }
    projectScanCache.delete(req.body.sessionId);
    res.json({ ok:true, sim:false, created:false, written, pkgDir:'src/sim_robot_tf' });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

// ── Save Transformation Odometry as a `sim_robot_odom` ROS2 package in the workspace ──
// แพ็กเกจแยกจาก sim_robot_tf: โหนด wheel_odom (คำนวณ /odom จากล้อจริง) + config
// Creates the package if it does not exist, otherwise overwrites (edits) it.
// files: { 'package.xml':'...', 'sim_robot_odom/odom.py':'...', ... }  relative to the package dir.
app.post('/api/sim/save-odom-package', auth, async (req, res) => {
  const s = getOwnedSess(req); if (!s) return res.status(403).json({ ok:false, error:'Session not found or forbidden' });
  try {
    if (isSim(s.robotKey)) {
      const out = writeOdomPackage(s.robotKey, req.body.files || {});
      projectScanCache.delete(req.body.sessionId);
      return res.json({ ok:true, sim:true, ...out });
    }
    // real robot: write each file via the agent, kept inside ~/ros2_ws/src/sim_robot_odom
    const base = (s.workspace || '~/ros2_ws').replace(/\/$/, '');
    const written = [];
    for (const [rel, content] of Object.entries(req.body.files || {})) {
      await agentReq(s.robotKey, 'fs_write', { path: base + '/src/sim_robot_odom/' + rel, content: (content ?? '') });
      written.push(rel);
    }
    projectScanCache.delete(req.body.sessionId);
    res.json({ ok:true, sim:false, created:false, written, pkgDir:'src/sim_robot_odom' });
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
    projectScanCache.delete(req.body.sessionId);
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

app.post('/api/exec',auth,async(req,res)=>{
  const s=getOwnedSess(req); if(!s) return res.status(403).json({ok:false,error:'Session not found or forbidden'});
  if(typeof req.body.command!=='string'||!req.body.command.trim()) return res.status(400).json({ok:false,error:'Command required'});
  try{const d=await agentReq(s.robotKey,'exec',{command:req.body.command,timeout:req.body.timeout});res.json({ok:true,...d});}
  catch(e){res.json({ok:false,error:e.message});}
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
  if(!['/ws/agent','/ws/terminal','/ws/rviz','/ws/monitor','/ws/robot-status'].includes(url.pathname)) return socket.destroy();
  try {
    let user=null;
    if(url.pathname!=='/ws/agent'){
      const origin=String(req.headers.origin||'');
      const forwardedProto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
      const ownOrigin=process.env.PUBLIC_URL?new URL(process.env.PUBLIC_URL).origin:`${forwardedProto}://${req.headers.host}`;
      if(origin&&origin!==ownOrigin&&!allowedOrigins.includes(origin)) return socket.destroy();
      const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim());
      user=await tokenUser(protocols.find(p=>/^[a-f0-9]{64}$/.test(p))||'');
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
  if(!['/ws/agent','/ws/terminal','/ws/rviz'].includes(pathname)) return;
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
        } else if(msg.termId?.startsWith('rviz_')&&msg.type==='pty_output'){
          const clean=Buffer.from(msg.data,'base64').toString('utf8').replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/[\x00-\x08\x0e-\x1f\x7f]/g,'');
          let buf=(rvizBuffers.get(msg.termId)||'')+clean;
          const wws=webSockets.get(msg.termId);
          let extracted=[],i=0;
          while(i<buf.length){const s0=buf.indexOf('{',i);if(s0<0){buf='';break;}let depth=0,j=s0,inStr=false,esc=false;for(;j<buf.length;j++){const ch=buf[j];if(esc){esc=false;continue;}if(ch==='\\'&&inStr){esc=true;continue;}if(ch==='"'){inStr=!inStr;continue;}if(inStr)continue;if(ch==='{')depth++;else if(ch==='}'){depth--;if(depth===0)break;}}if(depth===0&&j<buf.length){extracted.push(buf.slice(s0,j+1));i=j+1;}else{buf=buf.slice(s0);break;}}
          rvizBuffers.set(msg.termId,buf);
          if(wws?.readyState===WebSocket.OPEN)extracted.forEach(js=>{try{JSON.parse(js);wws.send(JSON.stringify({type:'data',data:js}));}catch{}});
        } else {
          const wws=webSockets.get(msg.termId);
          if(wws?.readyState===WebSocket.OPEN)wws.send(JSON.stringify(msg));
        }
      }
    }
    else if(pathname==='/ws/terminal'||pathname==='/ws/rviz'){
      if(msg.type==='init'||msg.type==='start'){
        const sess=sessions.get(msg.sessionId);
        if(sess&&sess.userId!==ws.user?.id){ws.send(JSON.stringify({type:'error',message:'Forbidden'}));return;}
        if(!sess){ws.send(JSON.stringify({type:'error',message:'Session not found'}));return;}
        const ag=agents.get(sess.robotKey);
        if(!ag||ag.ws.readyState!==WebSocket.OPEN){ws.send(JSON.stringify({type:'error',message:'Robot offline'}));return;}
        const termId=(pathname==='/ws/rviz'?'rviz_':'term_')+mkId();
        connId=termId; webSockets.set(termId,ws); ws.termId=termId; ws.robotKey=sess.robotKey;
        ag.ws.send(JSON.stringify({type:'pty_init',termId,cols:msg.cols||120,rows:msg.rows||30}));
        const src=sess.rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
        if(pathname==='/ws/rviz'){
          const oTopic=msg.odom||'none',lTopic=msg.laser||'none';
          const validTopic=t=>t==='none'||(typeof t==='string'&&/^\/[A-Za-z0-9_/-]+$/.test(t));
          if(!validTopic(oTopic)||!validTopic(lTopic)){ws.send(JSON.stringify({type:'error',message:'Invalid RViz topic'}));return;}
          const pyLines=["# ros2ide_rviz_rt","import rclpy,json,sys,math,threading,time,signal","from rclpy.node import Node","from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy","BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)","ST=QoSProfile(depth=100,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)","buf={'tf':{},'odom':None,'scan':None,'tf_seen':{}}","lk=threading.Lock()","running=True","def stop(s,f): global running; running=False","signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)","class N(Node):"," def __init__(self):","  super().__init__('ros2ide_rviz_rt')","  from tf2_msgs.msg import TFMessage","  self.create_subscription(TFMessage,'/tf',self.cb_tf,BE)","  self.create_subscription(TFMessage,'/tf_static',self.cb_tf,ST)",...(oTopic!=='none'?["  from nav_msgs.msg import Odometry",`  self.create_subscription(Odometry,'${oTopic}',self.cb_od,BE)`]:[]),...(lTopic!=='none'?["  from sensor_msgs.msg import LaserScan",`  self.create_subscription(LaserScan,'${lTopic}',self.cb_sc,BE)`]:[]),["  from std_msgs.msg import String","  self._last_desc=None","  self.create_subscription(String,'/robot_description',self.cb_desc,ST)"]," def cb_tf(self,m):"," with lk:","  for t in m.transforms:","   tr,ro=t.transform.translation,t.transform.rotation","   buf['tf'][t.child_frame_id]={'frame':t.child_frame_id,'parent':t.header.frame_id,'x':tr.x,'y':tr.y,'z':tr.z,'qx':ro.x,'qy':ro.y,'qz':ro.z,'qw':ro.w}; buf['tf_seen'][t.child_frame_id]=time.time()"," def cb_od(self,m):","  p=m.pose.pose","  with lk: buf['odom']={'x':p.position.x,'y':p.position.y,'qz':p.orientation.z,'qw':p.orientation.w}"," def cb_sc(self,m):","  r=[float(v) if not(math.isinf(v) or math.isnan(v)) else 0.0 for v in m.ranges]","  st=max(1,len(r)//360)","  with lk: buf['scan']={'amin':m.angle_min,'ainc':m.angle_increment*st,'ranges':r[::st]}"," def cb_desc(self,m):","  if m.data and m.data!=self._last_desc:","   self._last_desc=m.data","   with lk: buf['desc']=m.data","rclpy.init()","n=N()","ex=rclpy.executors.SingleThreadedExecutor()","ex.add_node(n)","last=time.time()","while running:"," ex.spin_once(timeout_sec=0.05)"," now=time.time()"," if now-last>=0.1:","  last=now","  with lk:","   for _k in list(buf['tf'].keys()):","    if now-buf['tf_seen'].get(_k,0)>8.0: buf['tf'].pop(_k,None); buf['tf_seen'].pop(_k,None)","   out={}","   if buf['tf']: out['tf']=list(buf['tf'].values())","   if buf['odom']: out['odom']=buf['odom']","   if buf['scan']: out['scan']=buf['scan']; buf['scan']=None","   if buf.get('desc') is not None: out['desc']=buf['desc']; buf['desc']=None","  try:","   sys.stdout.write(json.dumps(out,separators=(',',':'))+'\\n')","   sys.stdout.flush()","  except: pass","n.destroy_node(); rclpy.shutdown()"];
          agentReq(sess.robotKey,'fs_write',{path:'/tmp/_rviz_rt.py',content:pyLines.join('\n')}).then(()=>{
            ag.ws.send(JSON.stringify({type:'pty_input',termId,data:`pkill -f ros2ide_rviz_rt 2>/dev/null||true; source ${src} 2>/dev/null; python3 -u /tmp/_rviz_rt.py\n`}));
            ws.send(JSON.stringify({type:'ready',rosInfo:sess.rosInfo}));
          }).catch(e=>ws.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:'error',message:e.message})));
        } else {
          setTimeout(()=>{ag.ws.send(JSON.stringify({type:'pty_input',termId,data:`source ${src} 2>/dev/null\n`}));ws.send(JSON.stringify({type:'ready',rosInfo:sess.rosInfo}));},300);
        }
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

setInterval(()=>{const now=Date.now();for(const[id,s]of sessions)if(s.expiresAt&&s.expiresAt<now)sessions.delete(id);for(const[ip,ts]of loginAttempts){const fresh=ts.filter(t=>now-t<15*60*1000);fresh.length?loginAttempts.set(ip,fresh):loginAttempts.delete(ip);}},60*60*1000).unref();

async function start(){
  try{await db.query('SELECT 1');await db.query('DELETE FROM sessions WHERE expires_at<=NOW()');console.log('[DB] ✅ MySQL connected');}
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
