// ══ COMMON — shared state & utilities ══
let sessionId = null;
let wsPath = '~/ros2_ws';
let currentPath = null;
let openTabs = [];
let activeTab = null;
let authMode = 'password';
let nfType = 'py';
let rosInfo = null;
let isSimWorkspace = localStorage.getItem('ros2ide_is_sim') === 'true';
let treeState = {};
let terminalPlanAccess = false;
let terminalPlanAccessResolved = false;

// API wrapper
const apiRequest = (path, body, timeoutMs=0) => {
  const token = getAuthToken();
  const controller=timeoutMs?new AbortController():null;
  const timer=controller?setTimeout(()=>controller.abort(),timeoutMs):null;
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
    },
    body: JSON.stringify(body),
    ...(controller?{signal:controller.signal}:{})
  }).then(async r => {
    const raw = await r.text();
    if (r.status === 401) {
      clearAuthSession();
      window.location.replace('/');
      throw new Error('Session expired');
    }
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      const contentType = r.headers && r.headers.get ? (r.headers.get('content-type') || '') : '';
      const error = new Error(
        `Server ตอบกลับไม่ถูกต้อง (${r.status || 'unknown'}${contentType ? ', ' + contentType : ''}) กรุณารีสตาร์ต server แล้วลองใหม่`
      );
      error.status = r.status;
      error.code = 'INVALID_API_RESPONSE';
      throw error;
    }
    return data;
  }).finally(()=>{if(timer)clearTimeout(timer);});
};

// All MapSim entry points (Save, Playground, Navigation) use the same queue.
// Short requests poll job state; waiting for other users never holds an HTTP
// connection open for the duration of a build.
const SIM_QUEUED_PATHS=new Set(['/api/sim/run-mapsim','/api/sim/save-slam-map','/api/sim/apply-map']);
const API=(path,body,options)=>SIM_QUEUED_PATHS.has(path)&&body?.async!==true
  ? runQueuedMapsim(body,{...options,path}) : apiRequest(path,body);

function mapsimJobMessage(job) {
  if(job.phase==='waiting'||job.state==='queued')return `⏳ รอคิวงาน Simulation · ลำดับที่ ${job.position}`;
  if(job.phase==='save')return '💾 ถึงคิวแล้ว · กำลังบันทึกแผนที่ SLAM';
  return ({prepare:'⏳ กำลังเตรียมสนาม',build:'🔨 ถึงคิวแล้ว · กำลัง Build สนาม',stop:'⏳ กำลังเตรียมเปิดสนามใหม่',start:'▶️ กำลังเปิด Simulation',verify:'⏳ กำลังตรวจความพร้อมของสนาม',succeeded:'✅ สนามพร้อมใช้งานแล้ว'})[job.state==='succeeded'?'succeeded':job.phase]||'⏳ กำลังดำเนินการ';
}

async function runQueuedMapsim(body,{onProgress,onAccepted,isCurrent,path='/api/sim/run-mapsim'}={}) {
  const submitted=await apiRequest(path,{...body,async:true},15000);
  if(!submitted?.ok||!submitted.job)return submitted;
  if(onAccepted)onAccepted(submitted);
  let job=submitted.job,failures=0,lastMessage='';
  while(true){
    if(isCurrent&&!isCurrent())return {ok:false,error:'เปลี่ยน Simulation แล้ว'};
    const message=mapsimJobMessage(job);
    if(message!==lastMessage){
      if(onProgress)onProgress(message,job);else if(typeof sbMsg==='function')sbMsg(message,4000);
      lastMessage=message;
    }
    if(job.state==='succeeded'||job.state==='failed')return job.result;
    await new Promise(resolve=>setTimeout(resolve,2000));
    try{
      const response=await apiRequest('/api/sim/mapsim-job',{sessionId:body.sessionId,jobId:job.id},15000);
      if(!response?.ok)return response;
      job=response.job;failures=0;
    }catch(error){
      if(++failures>=5)throw new Error('ติดตามคิวไม่ได้ชั่วคราว งานอาจยังดำเนินการอยู่ กรุณาลองบันทึกอีกครั้งเพื่อติดตามงานเดิม');
      if(onProgress)onProgress('⏳ การเชื่อมต่อขัดข้องชั่วคราว กำลังเชื่อมต่อเพื่อติดตามคิวอีกครั้ง',job);
      lastMessage='';
    }
  }
}

function applyTerminalPlanAccess(membership) {
  terminalPlanAccess = Boolean(membership && membership.planCode !== 'free');
  terminalPlanAccessResolved = true;
  const menu = document.getElementById('terminal-menu');
  if (menu) {
    menu.hidden = !terminalPlanAccess;
    menu.setAttribute('aria-hidden', String(!terminalPlanAccess));
  }
  if (!terminalPlanAccess && document.getElementById('page-terminal')?.classList.contains('show')) {
    switchPage('dashboard');
  }
}

async function loadTerminalPlanAccess() {
  try {
    const response = await fetch('/api/auth/me', {headers: authHeaders()});
    if (response.status === 401) {
      clearAuthSession();
      window.location.replace('/');
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load membership');
    applyTerminalPlanAccess(result.membership);
  } catch (error) {
    terminalPlanAccessResolved = true;
    const menu = document.getElementById('terminal-menu');
    if (menu) menu.hidden = true;
    console.warn('[MEMBERSHIP] Unable to determine Terminal access:', error.message);
  }
}

async function appLogout() {
  try { await API('/api/auth/logout', {}); } catch (_) {}
  clearAuthSession();
  window.location.replace('/');
}

// HTML escape
function escH(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Encode untrusted text before placing it inside an inline event-handler string.
// Prefer addEventListener for new code; this helper keeps legacy templates safe.
function encArg(s) {
  return encodeURIComponent(String(s ?? '')).replace(/'/g, '%27');
}

// Base64 key for tree node IDs
function b64k(s) {
  try {
    return btoa(encodeURIComponent(s))
      .replace(/=/g, '')
      .replace(/\+/g, '_')
      .replace(/\//g, '-');
  } catch (e) {
    return Math.random().toString(36).slice(2);
  }
}

// Status bar message
function sbMsg(text, timeout = 3000) {
  const el = document.getElementById('sb-msg');
  if (!el) return;
  el.textContent = text;
  if (timeout) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, timeout);
}
