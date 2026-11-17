// ══ AUTH GUARD ══
// ตรวจสอบ token จาก localStorage ก่อนโหลดหน้า IDE
// ไม่ทำ async verify เพื่อป้องกัน redirect loop
(function(){
  const token = getAuthToken();
  if(!token){
    // ไม่มี token → ไปหน้า login ทันที
    window.location.replace('/');
    throw new Error('Not authenticated');
  }

  // โหลด session ที่บันทึกไว้จากหน้า robots
  const savedSession   = localStorage.getItem('ros2ide_session');
  const savedRobotId   = localStorage.getItem('ros2ide_robotid');
  const savedRosInfo   = localStorage.getItem('ros2ide_rosinfo');
  const savedWorkspace = localStorage.getItem('ros2ide_workspace');
  const savedUsername  = localStorage.getItem('ros2ide_username');
  const savedRobotName = localStorage.getItem('ros2ide_robotname');
  const savedRobotKey  = localStorage.getItem('ros2ide_robotkey');
  const savedIsSim     = localStorage.getItem('ros2ide_is_sim');

  if(savedSession){
    window._restoredSession = {
      sessionId: savedSession,
      robotId:   savedRobotId,
      rosInfo:   savedRosInfo ? JSON.parse(savedRosInfo) : null,
      workspace: savedWorkspace || '~/ros2_ws',
      username:  savedUsername  || 'ubuntu',
      robotName: savedRobotName || 'Robot',
      robotKey:  savedRobotKey || '',
      isSim:     savedIsSim === 'true',
    };
  }
})();

// ══ CORE APPLICATION LOGIC ══
// อาศัยตัวแปรหลักจาก common.js (sessionId, wsPath, rosInfo, API, etc.)

let connectionMode = 'ssh';
let _connTimeouts = []; 
let robotPresenceSocket=null,robotPresenceTimer=null,robotPresenceReconnect=null,robotPresenceEnabled=false;
const SIMULATION_PAGES = new Set(['map', 'playground']);
const WIZARD_RETURN_SAVE_TARGETS={editor:'#btn-save',flow:'#btn-flow-save',transformation:'#tf-right-panel .tf-save-action',map:'#map3d-save','3dcomp':'#dc-save-component'};

function updateRobotPresence(count,reconnecting=false){
  const badge=document.getElementById('robot-presence');if(!badge)return;
  const value=Math.max(0,Number(count)||0);badge.classList.toggle('reconnecting',reconnecting);
  const label=reconnecting?'กำลังต่อ…':`${value} ออนไลน์`;badge.querySelector('span').textContent=label;
  badge.title=reconnecting?'กำลังเชื่อมระบบนับผู้ใช้ใหม่':`มีผู้ใช้ ${value} คนกำลังเปิดหุ่นยนต์ตัวนี้`;
}

function stopRobotPresence(){
  robotPresenceEnabled=false;if(robotPresenceTimer)clearInterval(robotPresenceTimer);if(robotPresenceReconnect)clearTimeout(robotPresenceReconnect);
  robotPresenceTimer=robotPresenceReconnect=null;if(robotPresenceSocket){robotPresenceSocket.onclose=null;try{robotPresenceSocket.close();}catch{}}robotPresenceSocket=null;updateRobotPresence(0);
}

function startRobotPresence(){
  if(!sessionId||isSimWorkspace){stopRobotPresence();return;}
  if(robotPresenceSocket&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(robotPresenceSocket.readyState))return;
  robotPresenceEnabled=true;updateRobotPresence(0,true);
  const protocol=location.protocol==='https:'?'wss:':'ws:',socket=new WebSocket(`${protocol}//${location.host}/ws/robot-status`,['ros2ide',getAuthToken()]);robotPresenceSocket=socket;
  const watch=()=>socket.readyState===WebSocket.OPEN&&socket.send(JSON.stringify({type:'watch',sessionId}));
  socket.onopen=()=>{watch();if(robotPresenceTimer)clearInterval(robotPresenceTimer);robotPresenceTimer=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'heartbeat',sessionId}));},15000);};
  socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}const key=localStorage.getItem('ros2ide_robotkey');if(message.type==='presence'&&(!key||message.robot_key===key))updateRobotPresence(message.onlineUsers,false);};
  socket.onclose=()=>{if(robotPresenceTimer)clearInterval(robotPresenceTimer);robotPresenceTimer=null;if(robotPresenceSocket===socket)robotPresenceSocket=null;if(robotPresenceEnabled){updateRobotPresence(0,true);robotPresenceReconnect=setTimeout(startRobotPresence,1000);}};
  socket.onerror=()=>{};
}

function positionWorkspaceWizardReturn(page){
  const button=document.getElementById('workspace-wizard-return'),pages=document.getElementById('pages');
  if(!button||!pages)return;
  button.parentElement?.classList.remove('wizard-save-dock-host');
  if(button.parentElement!==pages)pages.appendChild(button);
  button.classList.remove('docked','playground-header-action','terminal-header-action');button.hidden=page==='dashboard';
  if(button.hidden)return;
  if(page==='playground'){
    const actions=document.querySelector('#page-playground .pg-head-actions');
    if(actions){actions.appendChild(button);button.classList.add('docked','playground-header-action');return;}
  }
  if(page==='terminal'){
    const actions=document.querySelector('#page-terminal .term-head-actions');
    if(actions){actions.appendChild(button);button.classList.add('docked','terminal-header-action');return;}
  }
  const selector=WIZARD_RETURN_SAVE_TARGETS[page],save=selector?document.querySelector(selector):null;
  if(!save||save.closest('.pg-mode-hidden'))return;
  save.parentElement?.classList.add('wizard-save-dock-host');
  save.insertAdjacentElement('afterend',button);button.classList.add('docked');
}

function applySimulationVisibility(){
  if(typeof document === 'undefined') return;
  const simulationEnabled = isSimWorkspace === true;
  document.documentElement.classList.toggle('simulation-mode', simulationEnabled);
  document.documentElement.classList.toggle('real-robot-mode', !simulationEnabled);
  document.querySelectorAll('[data-simulation-only]').forEach(element=>{
    element.hidden = !simulationEnabled;
    element.setAttribute('aria-hidden', String(!simulationEnabled));
  });
  document.querySelectorAll('[data-real-only]').forEach(element=>{
    element.hidden = simulationEnabled;
    element.setAttribute('aria-hidden', String(simulationEnabled));
  });
  const exportButton = document.getElementById('btn-nav-export');
  if(exportButton) exportButton.disabled = !simulationEnabled || !sessionId;
  if(!simulationEnabled && [...SIMULATION_PAGES].some(page=>document.getElementById('page-'+page)?.classList.contains('show'))){
    switchPage('dashboard');
  }
}

// ══ PAGE SWITCH ══
function switchPage(p){
  if(p==='terminal'&&!terminalPlanAccess){
    p='dashboard';
    if(terminalPlanAccessResolved&&typeof sbMsg==='function') sbMsg('Terminal สำหรับสมาชิกแพลนชำระเงินและ Admin',2800);
  }
  if(!isSimWorkspace && SIMULATION_PAGES.has(p)){
    p='dashboard';
    if(typeof sbMsg==='function') sbMsg('เครื่องมือนี้ใช้เฉพาะระบบ Simulation',2800);
  }
  document.querySelectorAll('.page').forEach(el=>el.classList.remove('show'));
  document.querySelectorAll('.mnav').forEach(el=>el.classList.remove('active'));
  document.getElementById('btn-wizard')?.classList.toggle('active',p==='dashboard');
  document.getElementById('btn-status')?.classList.toggle('active',p==='status');
  document.getElementById('page-'+p)?.classList.add('show');
  document.getElementById('nav-'+p)?.classList.add('active');
  positionWorkspaceWizardReturn(p);
  if(typeof pageGuidePageChanged==='function') pageGuidePageChanged(p);

  const sbNormal = document.getElementById('sb-normal');
  const sbFlow   = document.getElementById('sb-flow');
  if(p==='flow'){
    if(sbNormal) sbNormal.style.display='none';
    if(sbFlow){  sbFlow.style.display='block'; if(typeof flowFillPalette==='function') flowFillPalette(); }
  } else {
    if(sbNormal) sbNormal.style.display='';
    if(sbFlow)   sbFlow.style.display='none';
  }

  if(p==='terminal') setTimeout(()=>{ if(typeof termFitActive==='function') termFitActive(); },80);
  if(p==='monitor')  { setTimeout(()=>{ if(typeof monGraphRedraw==='function') monGraphRedraw(); },100); }
  if(p==='rviz')     { if(typeof rvizUseDesktopLayout==='function') rvizUseDesktopLayout(); setTimeout(()=>{ if(typeof rvizResize==='function') rvizResize(); if(typeof rviz3d!=='undefined'&&!rviz3d.renderer&&typeof initRviz==='function') initRviz(); },100); }
  else if(p==='playground'){ setTimeout(()=>{if(typeof initRobotPlayground==='function')initRobotPlayground();},60); }
  else { if(typeof rvizTeleopStop==='function') rvizTeleopStop(); }   // ออกจากหน้า RViz/Playground → หยุดส่ง cmd_vel (หุ่นไม่วิ่งต่อ)
  if(p==='transformation'){ setTimeout(()=>{ if(typeof initTransformation==='function') initTransformation(); if(typeof tfResize==='function') tfResize(); },100); }
  if(p==='3dcomp'){ setTimeout(()=>{ if(typeof init3DComponent==='function') init3DComponent(); if(typeof dcResize==='function') dcResize(); },100); }
  if(p==='map'){ setTimeout(()=>{ if(typeof initMapEditor==='function') initMapEditor(); },100); }
  if(p==='lidar'){ setTimeout(()=>{ if(typeof initLidarSetup==='function') initLidarSetup(); },80); }
  else if(typeof stopLidarScan==='function') stopLidarScan();
  // Wizard และ Status ใช้ข้อมูลชุดเดียวกัน; หน้า Status อัปเดต ROS graph แบบ live
  if(p==='dashboard'||p==='status'){ if(typeof startDashAutoRefresh==='function') startDashAutoRefresh(); }
  else { if(typeof stopDashAutoRefresh==='function') stopDashAutoRefresh(); }
}

function returnToRosWizard(){
  switchPage('dashboard');
  if(typeof loadDashboard==='function')loadDashboard(true);
}

// ══ MODAL & AUTH ══
const openModal=id=>document.getElementById(id).classList.remove('hidden');
const closeModal=id=>document.getElementById(id).classList.add('hidden');
function openConnModal(){document.getElementById('conn-err').style.display='none';openModal('modal-conn');}

function setConnMode(m) {
  connectionMode = m;
  document.getElementById('conn-m-ssh')?.classList.toggle('active', m === 'ssh');
  document.getElementById('conn-m-loc')?.classList.toggle('active', m === 'local');
  const sshFields = document.getElementById('ssh-fields');
  if(sshFields) sshFields.style.display = m === 'ssh' ? 'block' : 'none';
}

function setAuth(m){
  authMode=m;
  document.getElementById('auth-pw-div').classList.toggle('hidden',m!=='password');
  document.getElementById('auth-key-div').classList.toggle('hidden',m!=='key');
  document.getElementById('auth-pb').classList.toggle('active',m==='password');
  document.getElementById('auth-kb').classList.toggle('active',m==='key');
}

function selNft(el,t){
  document.querySelectorAll('.nft').forEach(e=>e.classList.remove('sel'));
  el.classList.add('sel');nfType=t;
}

if(typeof document !== 'undefined'){
  document.querySelectorAll('.overlay').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)el.classList.add('hidden');}));
}

// ══ CONNECT ══
async function doConnect(){
  _connTimeouts.forEach(clearTimeout);
  _connTimeouts = [];

  const pairingCode = document.getElementById('c-host')?.value.trim() || 'localhost';
  const ws0 = document.getElementById('c-ws')?.value.trim() || '~/ros2_ws';
  const port = document.getElementById('c-port')?.value.trim() || '22';
  const user = document.getElementById('c-user')?.value.trim() || '';
  const pass = document.getElementById('c-pass')?.value || '';
  const key = document.getElementById('c-key')?.value.trim() || '';

  wsPath = ws0; 

  const errEl = document.getElementById('conn-err');
  if(errEl) errEl.style.display = 'none';
  const btn = document.getElementById('btn-connect');
  if(btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }

  const steps=[[200,15,'Initializing...'],[500,35,'Connecting...'],[800,55,'Handshake...'],[1100,75,'Authenticating...'],[1400,90,'Detecting ROS...']];
  const prog = document.getElementById('prog');
  const stat = document.getElementById('conn-stat');
  
  steps.forEach(([d,p,m]) => {
    _connTimeouts.push(setTimeout(() => {
      if(prog) prog.style.width = p + '%';
      if(stat) stat.textContent = m;
    }, d));
  });

  const body = { 
    mode: connectionMode, 
    robotId: pairingCode,
    host: pairingCode, 
    port, 
    username: user 
  };
  
  if (connectionMode === 'ssh') {
    if(typeof authMode!=='undefined'&&authMode==='key'&&key) body.privateKey=key;
    else body.password=pass;
  }

  try{
    const res = await API('/api/connect', body);
    
    _connTimeouts.forEach(clearTimeout);
    _connTimeouts = [];

    if(prog) prog.style.width='100%';
    
    if(!res.ok || res.error){
      if(stat) stat.textContent = 'เชื่อมต่อล้มเหลว';
      if(errEl) { errEl.textContent = res.error || 'Unknown error'; errEl.style.display='block'; }
      if(btn) { btn.disabled = false; btn.textContent = 'Connect'; }
      return;
    }
    
    sessionId = res.sessionId;
    rosInfo = res.rosInfo;
    isSimWorkspace = res.isSim === true;
    localStorage.setItem('ros2ide_session',res.sessionId);
    if(res.robotId)localStorage.setItem('ros2ide_robotid',String(res.robotId));
    localStorage.setItem('ros2ide_rosinfo',JSON.stringify(res.rosInfo||{}));
    localStorage.setItem('ros2ide_workspace',res.workspace||wsPath);
    localStorage.setItem('ros2ide_username',res.username||user);
    localStorage.setItem('ros2ide_robotname',res.robotName||pairingCode);
    localStorage.setItem('ros2ide_robotkey',res.robotKey||'');
    localStorage.setItem('ros2ide_is_sim', String(isSimWorkspace));
    updateRobotPresence(res.onlineUsers||0);
    if(stat) stat.textContent = 'Connected!';

    closeModal('modal-conn');
    void onConnected(res.robotName||res.host||'Robot',res.username||user,res.rosInfo);
    if(btn) { btn.disabled=false; btn.textContent='Connect'; }
    if(prog) prog.style.width='0';
    if(stat) stat.textContent='พร้อมเชื่อมต่อ';

  } catch(e) {
    _connTimeouts.forEach(clearTimeout);
    if(stat) stat.textContent = 'Error';
    if(errEl) { errEl.textContent = 'ไม่สามารถเชื่อมต่อ bridge server ได้:\n' + e.message; errEl.style.display='block'; }
    if(btn) { btn.disabled=false; btn.textContent='Connect'; }
  }
}

async function onConnected(host,user,ri){
  rosInfo=ri;
  document.getElementById('disp-host').value=host;
  const robotInfoIcon=document.getElementById('robot-info-icon');
  if(robotInfoIcon){robotInfoIcon.title=`หุ่นยนต์: ${host}`;robotInfoIcon.setAttribute('aria-label',`หุ่นยนต์ ${host}`);}
  const connectionBadge=document.getElementById('badge-conn');
  connectionBadge.innerHTML='<span class="dot dg"></span>';
  connectionBadge.className='top-icon-action connection-state online';
  connectionBadge.title='เชื่อมต่อแล้ว';
  connectionBadge.setAttribute('aria-label','เชื่อมต่อแล้ว');
  document.getElementById('badge-user').textContent=`${user}@${host}`;
  document.getElementById('badge-user').classList.remove('hidden');
  
  // Show Disconnect, hide Connect
  const btnDisc = document.getElementById('btn-disc');
  if(btnDisc){ btnDisc.disabled=false; btnDisc.style.display=''; }
  const btnBuild = document.getElementById('btn-build');
  if(btnBuild) btnBuild.disabled=false;
  ['ab-wizard','ab-source','ab-run','btn-refresh-status','btn-nav-export'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.disabled=false;
  });
  applySimulationVisibility();
  startRobotPresence();
  
  document.getElementById('sb-conn').textContent=`${user}@${host}`;
  document.getElementById('sb-ros').textContent=`${ri.distro} (ROS${ri.version})`;
  document.getElementById('term-badge').innerHTML='<span class="dot dg"></span>Connected';
  document.getElementById('term-badge').className='badge bg';
  
  const dsub = document.getElementById('dash-ros-sub');
  const runtimeParts = [ri.distro, ri.version ? `ROS${ri.version}` : '', ri.os, ri.pythonVersion].filter(Boolean);
  const dashRuntime = document.getElementById('dash-runtime');
  if(dashRuntime) dashRuntime.textContent=runtimeParts.length ? `🤖 ${runtimeParts.join(' · ')}` : '🤖 เชื่อมต่อหุ่นยนต์แล้ว';
  if(dsub && !dsub.textContent) dsub.textContent='ผ่านภารกิจทั้ง 7 ด่าน แล้วพาหุ่นยนต์ออกสำรวจโลก';
  const ssub = document.getElementById('status-ros-sub');
  if(ssub) ssub.textContent=runtimeParts.length ? runtimeParts.join(' · ') : 'สถานะการทำงานของหุ่นยนต์แบบเรียลไทม์';

  if(typeof openTermWs==='function') openTermWs(user,host);
  
  // 🔥 บังคับสร้างโฟลเดอร์ src ให้อัตโนมัติ ป้องกัน Error ENOENT ตอนสแกนไฟล์ครั้งแรก
  await API('/api/exec', { sessionId, command: `mkdir -p ${wsPath}/src` });
  
  if(typeof loadTree==='function') await loadTree(wsPath,'file-tree',0);
  if(typeof sbMsg==='function') sbMsg(`Connected · ROS ${ri.distro}`,4000);
  
  const mbtn=document.getElementById('btn-mon-refresh');
  if(mbtn) mbtn.disabled=false;
  ['btn-run-refresh','btn-run-buildall'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.disabled=false;
  });
  
  if (typeof flowLoadPackages === 'function') flowLoadPackages();
  if (typeof flowRefreshTopics === 'function') flowRefreshTopics();
  if (typeof loadDashboard === 'function') loadDashboard();
  if (typeof loadTopics === 'function') loadTopics();
}

async function robotSelectionDestination(){
  const response=await fetch('/api/local/info',{cache:'no-store',signal:AbortSignal.timeout(2500)});
  if(!response.ok)return '/robots';
  const info=await response.json();
  if(info.local!==true)return '/robots';
  let target;try{target=new URL(info.cloudUrl);}catch{throw new Error('หุ่นยนต์ยังไม่ได้ตั้ง URL ของ Cloud');}
  if(!['http:','https:'].includes(target.protocol)||target.pathname!=='/robots'||target.username||target.password)throw new Error('URL ของ Cloud ไม่ถูกต้อง');
  return target.href;
}

async function doDisconnect(){
  const disconnectButton=document.getElementById('btn-disc');
  if(disconnectButton?.disabled)return;
  if(disconnectButton)disconnectButton.disabled=true;
  let destination;
  try{
    destination=await robotSelectionDestination();
    if(sessionId){const result=await API('/api/disconnect',{sessionId});if(!result?.ok)throw new Error(result?.error||'ตัดการเชื่อมต่อไม่สำเร็จ');}
  }catch(error){
    if(disconnectButton)disconnectButton.disabled=false;
    if(typeof sbMsg==='function')sbMsg(error.message||'ไม่สามารถกลับไปหน้าเลือกหุ่นยนต์ได้',5000);
    return;
  }
  stopRobotPresence();
  sessionId=null; rosInfo=null; isSimWorkspace=false;
  applySimulationVisibility();
  if(typeof window.termWs!=='undefined'&&window.termWs){window.termWs.close();window.termWs=null;}
  if(typeof window.dashInterval !== 'undefined' && window.dashInterval){clearInterval(window.dashInterval);window.dashInterval=null;}
  
  document.getElementById('disp-host').value='';
  const robotInfoIcon=document.getElementById('robot-info-icon');
  if(robotInfoIcon){robotInfoIcon.title='ยังไม่ได้เชื่อมต่อหุ่นยนต์';robotInfoIcon.setAttribute('aria-label','ยังไม่ได้เชื่อมต่อหุ่นยนต์');}
  const connectionBadge=document.getElementById('badge-conn');
  connectionBadge.innerHTML='<span class="dot dr"></span>';
  connectionBadge.className='top-icon-action connection-state';
  connectionBadge.title='ยังไม่ได้เชื่อมต่อ';
  connectionBadge.setAttribute('aria-label','ยังไม่ได้เชื่อมต่อ');
  document.getElementById('badge-user').classList.add('hidden');
  document.getElementById('btn-build').disabled=true;
  document.getElementById('btn-disc').disabled=true;
  document.getElementById('sb-conn').textContent='Not connected';
  document.getElementById('sb-ros').textContent='—';
  document.getElementById('term-badge').innerHTML='<span class="dot dr"></span>Not connected';
  document.getElementById('term-badge').className='badge br';
  document.getElementById('file-tree').innerHTML='<div class="ti" style="color:var(--dim);font-size:11px;padding-left:14px">เชื่อมต่อระบบก่อน</div>';
  
  ['ab-wizard','ab-source','ab-run','btn-refresh-status','btn-run-refresh','btn-run-buildall','btn-nav-export'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.disabled=true;
  });
  if(typeof window.RUN !== 'undefined') { window.RUN.packages=[]; window.RUN.selected=null; }
  // Clear localStorage session and go back to robot selection
  localStorage.removeItem('ros2ide_session');
  localStorage.removeItem('ros2ide_robotid');
  localStorage.removeItem('ros2ide_rosinfo');
  localStorage.removeItem('ros2ide_workspace');
  localStorage.removeItem('ros2ide_username');
  localStorage.removeItem('ros2ide_robotname');
  localStorage.removeItem('ros2ide_robotkey');
  localStorage.removeItem('ros2ide_is_sim');
  // Redirect to robots page
  window.location.replace(destination);
}

// ══ FILE TREE ══
async function loadTree(dirPath,containerId,depth){
  const el=document.getElementById(containerId);
  if(!el)return;
  el.innerHTML=`<div class="ti loading" style="color:var(--dim);font-size:11px;padding-left:${14+depth*14}px">Loading...</div>`;
  const res=await API('/api/files/list',{sessionId,path:dirPath});
  if(!res.ok){el.innerHTML=`<div class="ti" style="color:var(--red);font-size:11px;padding-left:14px">${escH(res.error)}</div>`;return;}
  
  // 🔥 ป้องกัน Error: res.items is not iterable (กรณี Server ส่งข้อมูลรูปแบบต่างๆ มา)
  let items = Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);

  let html='';
  for(const item of items){
    const fp=dirPath.replace(/\/$/,'')+'/'+item.name;
    const ind=14+depth*14;
    if(item.isDir){
      const exp=treeState[fp]??false;
      const ek=b64k(fp);
      html+=`<div class="ti" style="padding-left:${ind}px" id="dir-${ek}" onclick="toggleDir(decodeURIComponent('${encArg(fp)}'),${ind})" oncontextmenu="showCtxMenu(event,decodeURIComponent('${encArg(fp)}'),true)"><span style="font-size:11px;opacity:.5">${exp?'▾':'▸'}</span><span style="font-size:11px;opacity:.4;margin-left:2px">📁</span><span>${escH(item.name)}</span></div><div id="ch-${ek}">${exp?`<div class="ti loading" style="padding-left:${ind+14}px">Loading...</div>`:''}</div>`;
    }else{
      const ext=item.name.split('.').pop().toLowerCase();
      const fc={'py':'fpy','cpp':'fcp','h':'fcp','hpp':'fcp','xml':'fxm','cmake':'fmk','txt':'fmk','yaml':'fmk','yml':'fmk','launch':'fpy','sh':'fmk'}[ext]||'';
      const ft={'py':'py','cpp':'c++','h':'h','hpp':'hpp','xml':'xml','cmake':'mk','launch':'py','yaml':'yml','yml':'yml','sh':'sh'}[ext]||(ext.slice(0,3)||'?');
      html+=`<div class="ti" style="padding-left:${ind}px" onclick="if(typeof openFilePath==='function')openFilePath(decodeURIComponent('${encArg(fp)}'))" oncontextmenu="showCtxMenu(event,decodeURIComponent('${encArg(fp)}'),false)" id="ft-${b64k(fp)}"><span class="fi ${fc}">${escH(ft)}</span><span>${escH(item.name)}</span></div>`;
    }
  }
  el.innerHTML=html||`<div class="ti" style="color:var(--dim);font-size:11px;padding-left:${14+depth*14}px">(empty)</div>`;
  
  // 🔥 แก้ไขจุดพัง: ใช้ items (ตัวแปรที่ถูกตรวจสอบแล้ว) แทน res.items
  for(const item of items) if(item.isDir && treeState[dirPath.replace(/\/$/,'')+'/'+item.name])
    await loadDirCh(dirPath.replace(/\/$/,'')+'/'+item.name,depth+1);
}

async function toggleDir(fp,indent){
  const ek=b64k(fp);
  const dirEl=document.getElementById('dir-'+ek);
  const arrow=dirEl?.querySelector('span');
  const exp=treeState[fp]??false;
  treeState[fp]=!exp;
  if(!exp){arrow&&(arrow.textContent='▾');await loadDirCh(fp,Math.round((indent-14)/14)+1);}
  else{arrow&&(arrow.textContent='▸');const c=document.getElementById('ch-'+ek);if(c)c.innerHTML='';}
}

async function loadDirCh(fp,depth){
  const ek=b64k(fp);
  const cel=document.getElementById('ch-'+ek);
  if(!cel)return;
  cel.innerHTML=`<div class="ti loading" style="color:var(--dim);font-size:11px;padding-left:${14+depth*14}px">Loading...</div>`;
  const res=await API('/api/files/list',{sessionId,path:fp});
  if(!res.ok){cel.innerHTML='';return;}

  // 🔥 ป้องกัน Error: res.items is not iterable
  let items = Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);

  let html='';
  for(const item of items){
    const fp2=fp+'/'+item.name;
    const ind=14+depth*14;
    if(item.isDir){
      const exp2=treeState[fp2]??false;
      const ek2=b64k(fp2);
      html+=`<div class="ti" style="padding-left:${ind}px" id="dir-${ek2}" onclick="toggleDir(decodeURIComponent('${encArg(fp2)}'),${ind})" oncontextmenu="showCtxMenu(event,decodeURIComponent('${encArg(fp2)}'),true)"><span style="font-size:11px;opacity:.5">${exp2?'▾':'▸'}</span><span style="font-size:11px;opacity:.4;margin-left:2px">📁</span><span>${escH(item.name)}</span></div><div id="ch-${ek2}"></div>`;
    }else{
      const ext=item.name.split('.').pop().toLowerCase();
      const fc={'py':'fpy','cpp':'fcp','h':'fcp','hpp':'fcp','xml':'fxm','cmake':'fmk','txt':'fmk','yaml':'fmk','yml':'fmk','launch':'fpy','sh':'fmk'}[ext]||'';
      const ft={'py':'py','cpp':'c++','h':'h','hpp':'hpp','xml':'xml','cmake':'mk','launch':'py','yaml':'yml','yml':'yml','sh':'sh'}[ext]||(ext.slice(0,3)||'?');
      html+=`<div class="ti" style="padding-left:${ind}px" onclick="if(typeof openFilePath==='function')openFilePath(decodeURIComponent('${encArg(fp2)}'))" oncontextmenu="showCtxMenu(event,decodeURIComponent('${encArg(fp2)}'),false)" id="ft-${b64k(fp2)}"><span class="fi ${fc}">${escH(ft)}</span><span>${escH(item.name)}</span></div>`;
    }
  }
  cel.innerHTML=html||'';
}

async function refreshTree(){await loadTree(wsPath,'file-tree',0);}

// ══ NEW FILE / DIR ══
function newFileDialog(){
  if(!sessionId){alert('เชื่อมต่อระบบก่อน');return;}
  window._ctxNewFileDir=null;
  document.getElementById('nf-name').value='';
  document.getElementById('nf-name').placeholder='my_node.py';
  document.getElementById('nf-err').style.display='none';
  openModal('modal-nf');
}

async function doNewFile(){
  const rawName=document.getElementById('nf-name').value.trim();
  const errEl=document.getElementById('nf-err');
  if(!rawName){errEl.textContent='กรุณากรอกชื่อไฟล์';errEl.style.display='block';return;}
  const baseDir=window._ctxNewFileDir||wsPath;
  const fp=rawName.startsWith('/')?rawName:baseDir+'/'+rawName;
  const templates={
    py:`#!/usr/bin/env python3\nimport rclpy\nfrom rclpy.node import Node\n\n\nclass MyNode(Node):\n    def __init__(self):\n        super().__init__('my_node')\n        self.get_logger().info('Node started!')\n\n\ndef main(args=None):\n    rclpy.init(args=args)\n    node = MyNode()\n    rclpy.spin(node)\n    rclpy.shutdown()\n\n\nif __name__ == '__main__':\n    main()\n`,
    cpp:`#include "rclcpp/rclcpp.hpp"\n\nclass MyNode : public rclcpp::Node {\npublic:\n    MyNode() : Node("my_node") {\n        RCLCPP_INFO(get_logger(), "Node started!");\n    }\n};\n\nint main(int argc, char** argv) {\n    rclcpp::init(argc, argv);\n    rclcpp::spin(std::make_shared<MyNode>());\n    rclcpp::shutdown();\n    return 0;\n}\n`,
    xml:`<?xml version="1.0"?>\n<package format="3">\n  <name>my_package</name>\n  <version>0.1.0</version>\n  <description>My ROS2 Package</description>\n  <maintainer email="dev@robot.local">Developer</maintainer>\n  <license>Apache-2.0</license>\n  <depend>rclpy</depend>\n  <export><build_type>ament_python</build_type></export>\n</package>\n`,
    launch:`from launch import LaunchDescription\nfrom launch_ros.actions import Node\n\ndef generate_launch_description():\n    return LaunchDescription([\n        Node(package='my_package', executable='my_node', name='my_node'),\n    ])\n`,
    yaml:`# ROS2 Parameters\nmy_node:\n  ros__parameters:\n    param1: value1\n    param2: 42\n`,
    txt:'',
  };
  const res=await API('/api/files/write',{sessionId,path:fp,content:templates[nfType]||''});
  if(!res.ok){errEl.textContent='Error: '+res.error;errEl.style.display='block';return;}
  closeModal('modal-nf');
  await refreshTree();
  if(typeof openFilePath==='function') await openFilePath(fp);
}

function newDirDialog(){
  if(!sessionId){alert('เชื่อมต่อระบบก่อน');return;}
  window._ctxNewDirBase=null;
  document.getElementById('nd-name').value='';
  document.getElementById('nd-name').placeholder='new_folder';
  document.getElementById('nd-err').style.display='none';
  openModal('modal-nd');
}

async function doNewDir(){
  const rawName=document.getElementById('nd-name').value.trim();
  const errEl=document.getElementById('nd-err');
  if(!rawName){errEl.textContent='กรุณากรอกชื่อ';errEl.style.display='block';return;}
  const dirBase=window._ctxNewDirBase||wsPath;
  const dp=rawName.startsWith('/')?rawName:dirBase+'/'+rawName;
  const res=await API('/api/files/mkdir',{sessionId,path:dp});
  if(!res.ok){errEl.textContent='Error: '+res.error;errEl.style.display='block';return;}
  closeModal('modal-nd');
  await refreshTree();
  sbMsg('Created: '+dp,2000);
}

function showPath(){if(!currentPath)return;document.getElementById('path-disp').textContent=currentPath;openModal('modal-path');}

// ══════════════════════════════════════════════════════════════════
//  PACKAGE WIZARD — Phase 4
// ══════════════════════════════════════════════════════════════════
let wizState = {
  step: 0,
  lang: 'py',
  pkgName: '',
  nodeName: '',
  deps: new Set(['rclpy','geometry_msgs']),
  template: 'publisher',
};

const DEPS_PY = [
  {id:'rclpy',        name:'rclpy',         desc:'Python ROS2 client', must:true},
  {id:'rclcpp',       name:'rclcpp',        desc:'C++ ROS2 client'},
  {id:'std_msgs',     name:'std_msgs',      desc:'String, Int, Bool, Float'},
  {id:'geometry_msgs',name:'geometry_msgs', desc:'Twist, Pose, Vector3'},
  {id:'sensor_msgs',  name:'sensor_msgs',   desc:'LaserScan, Image, Imu'},
  {id:'nav_msgs',     name:'nav_msgs',      desc:'Odometry, Path, Map'},
  {id:'nav2_msgs',    name:'nav2_msgs',     desc:'Navigation2 actions'},
  {id:'tf2_ros',      name:'tf2_ros',       desc:'Transform frames'},
  {id:'cv_bridge',    name:'cv_bridge',     desc:'Image ↔ OpenCV'},
  {id:'action_msgs',  name:'action_msgs',   desc:'Action server/client'},
  {id:'std_srvs',     name:'std_srvs',      desc:'SetBool, Trigger, Empty'},
  {id:'lifecycle_msgs',name:'lifecycle_msgs',desc:'Lifecycle node msgs'},
];

const DEPS_CPP = [
  {id:'rclcpp',       name:'rclcpp',        desc:'C++ ROS2 client', must:true},
  {id:'rclpy',        name:'rclpy',         desc:'Python ROS2 client'},
  {id:'std_msgs',     name:'std_msgs',      desc:'String, Int, Bool, Float'},
  {id:'geometry_msgs',name:'geometry_msgs', desc:'Twist, Pose, Vector3'},
  {id:'sensor_msgs',  name:'sensor_msgs',   desc:'LaserScan, Image, Imu'},
  {id:'nav_msgs',     name:'nav_msgs',      desc:'Odometry, Path, Map'},
  {id:'tf2_ros',      name:'tf2_ros',       desc:'Transform frames'},
  {id:'cv_bridge',    name:'cv_bridge',     desc:'Image ↔ OpenCV'},
  {id:'std_srvs',     name:'std_srvs',      desc:'SetBool, Trigger, Empty'},
  {id:'rclcpp_action',name:'rclcpp_action', desc:'Action server/client'},
  {id:'pluginlib',    name:'pluginlib',      desc:'Plugin system'},
  {id:'lifecycle',    name:'rclcpp_lifecycle',desc:'Lifecycle node'},
];

const TEMPLATES = {
  py: [
    {id:'publisher',   icon:'📢', title:'Publisher Node',    desc:'สร้าง node ที่ publish topic ตาม timer'},
    {id:'subscriber',  icon:'📥', title:'Subscriber Node',   desc:'รับ topic เข้ามา เหมาะกับ sensor callback'},
    {id:'pub_sub',     icon:'🔄', title:'Pub + Sub',          desc:'ทั้ง publisher และ subscriber ในตัวเดียว'},
    {id:'service_srv', icon:'⚙️', title:'Service Server',     desc:'ให้บริการ service ฝั่ง server'},
    {id:'lifecycle',   icon:'♻️', title:'Lifecycle Node',     desc:'Node ที่มี state machine (configure/activate)'},
    {id:'action_srv',  icon:'🎯', title:'Action Server',      desc:'Long-running task พร้อม feedback'},
  ],
  cpp: [
    {id:'publisher',   icon:'📢', title:'Publisher Node',    desc:'Publish topic via timer'},
    {id:'subscriber',  icon:'📥', title:'Subscriber Node',   desc:'Subscribe topic callback'},
    {id:'pub_sub',     icon:'🔄', title:'Pub + Sub',          desc:'Publisher + Subscriber รวมในคลาสเดียว'},
    {id:'component',   icon:'🧩', title:'Composable Node',   desc:'Node ที่ load เป็น component ได้'},
    {id:'lifecycle',   icon:'♻️', title:'Lifecycle Node',     desc:'rclcpp_lifecycle::LifecycleNode'},
    {id:'service_srv', icon:'⚙️', title:'Service Server',     desc:'Service server'},
  ],
};

const DEP_HINTS = {
  rclpy:        'Python ROS2 client library — จำเป็นสำหรับทุก Python node',
  rclcpp:       'C++ ROS2 client library — จำเป็นสำหรับทุก C++ node',
  geometry_msgs:'ใช้กับ /cmd_vel (Twist), pose estimation, transforms',
  sensor_msgs:  'LaserScan สำหรับ LiDAR, Image สำหรับกล้อง, Imu สำหรับ IMU sensor',
  nav_msgs:     'Odometry สำหรับ pose ของหุ่นยนต์, OccupancyGrid สำหรับ map',
  tf2_ros:      'จัดการ coordinate frames',
  cv_bridge:    'แปลง ROS Image ↔ OpenCV Mat',
  nav2_msgs:    'Navigation2 goals, waypoints',
  std_msgs:     'ข้อความพื้นฐาน String, Int32, Float64, Bool',
};

function openWizard() {
  if (!sessionId) return;
  wizState = { step:0, lang:'py', pkgName:'', nodeName:'', deps:new Set(['rclpy','geometry_msgs']), template:'publisher' };
  document.getElementById('wiz-pkgname').value = '';
  document.getElementById('wiz-nodename').value = '';
  document.getElementById('wiz-wspath').value = wsPath;
  document.getElementById('lb-py').classList.add('active');
  document.getElementById('lb-cpp').classList.remove('active');
  document.getElementById('wiz-err0').style.display = 'none';
  document.getElementById('wiz-buildlog').classList.add('hidden');
  document.getElementById('wiz-buildlog').textContent = '';
  wizRenderDeps();
  wizRenderTemplates();
  wizRenderStep();
  openModal('modal-wizard');
  setTimeout(() => document.getElementById('wiz-pkgname').focus(), 80);
}

function wizSetLang(lang) {
  wizState.lang = lang;
  if (lang === 'py') {
    wizState.deps = new Set(['rclpy','geometry_msgs']);
    document.getElementById('lb-py').classList.add('active');
    document.getElementById('lb-cpp').classList.remove('active');
  } else {
    wizState.deps = new Set(['rclcpp','geometry_msgs']);
    document.getElementById('lb-cpp').classList.add('active');
    document.getElementById('lb-py').classList.remove('active');
  }
  wizRenderDeps();
  wizRenderTemplates();
  wizUpdatePreview();
}

function wizRenderDeps() {
  const deps = wizState.lang === 'py' ? DEPS_PY : DEPS_CPP;
  const grid = document.getElementById('dep-grid');
  grid.innerHTML = deps.map(d => `
    <div class="dep-card${wizState.deps.has(d.id)?' sel':''}" 
         onclick="wizToggleDep('${d.id}',${!!d.must})" 
         title="${d.must?'Required — cannot remove':''}">
      <div class="dep-name">${d.name}</div>
      <div class="dep-desc">${d.desc}</div>
    </div>`).join('');
}

function wizToggleDep(id, must) {
  if (must) return; 
  if (wizState.deps.has(id)) wizState.deps.delete(id);
  else wizState.deps.add(id);
  wizRenderDeps();
}

function wizRenderTemplates() {
  const tpls = TEMPLATES[wizState.lang] || TEMPLATES.py;
  const grid = document.getElementById('tpl-grid');
  grid.innerHTML = tpls.map(t => `
    <div class="tpl-card${wizState.template===t.id?' sel':''}" onclick="wizSelTemplate('${t.id}')">
      <div class="tpl-title">${t.icon} ${t.title}</div>
      <div class="tpl-desc">${t.desc}</div>
    </div>`).join('');
}

function wizSelTemplate(id) {
  wizState.template = id;
  wizRenderTemplates();
  wizUpdatePreview();
}

function wizUpdatePreview() {
  wizState.pkgName = (document.getElementById('wiz-pkgname')?.value||'').trim().replace(/\s+/g,'_').replace(/[^\w]/g,'');
  wizState.nodeName = (document.getElementById('wiz-nodename')?.value||'').trim() ||
    (wizState.pkgName ? wizState.pkgName.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join('')+'Node' : 'MyNode');

  const pkg = wizState.pkgName || '<package_name>';
  const cls = wizState.nodeName || 'MyNode';
  const exe = (cls.replace(/Node$/,'').replace(/([A-Z])/g,'_$1').toLowerCase().replace(/^_/,''));

  const files = wizGetFileList(pkg, cls, exe);
  const el = document.getElementById('wiz-preview');
  if (el) {
    el.innerHTML = files.map(f =>
      `<div><span class="hi">${f.path}</span> <span class="hd">${f.note}</span></div>`
    ).join('');
  }

  const dest = document.getElementById('wiz-dest-path');
  if (dest) dest.textContent = wsPath + '/src/' + pkg + '/';
}

function wizGetFileList(pkg, cls, exe) {
  const lang = wizState.lang;
  const files = [
    {path:'package.xml',     note:'package dependencies'},
    {path:'setup.cfg',       note:'entry points'},
  ];
  if (lang === 'py') {
    files.push({path:`${pkg}/__init__.py`, note:''});
    files.push({path:`${pkg}/${exe}_node.py`, note:`${cls} — main node`});
    files.push({path:'setup.py', note:'ament_python build'});
    files.push({path:'resource/' + pkg, note:'ament resource'});
  } else {
    files.push({path:`src/${exe}_node.cpp`, note:`${cls} — main node`});
    files.push({path:`include/${pkg}/${exe}_node.hpp`, note:'header'});
    files.push({path:'CMakeLists.txt', note:'ament_cmake build'});
  }
  return files;
}

function wizRenderStep() {
  const step = wizState.step;
  for (let i = 0; i < 4; i++) {
    document.getElementById('wp'+i)?.classList.toggle('show', i===step);
    const ws = document.getElementById('ws'+i);
    if (ws) {
      ws.className = 'wiz-step ' + (i < step ? 'done' : i === step ? 'active' : 'pending');
    }
  }
  const back = document.getElementById('wiz-back');
  if (back) back.style.visibility = step > 0 ? 'visible' : 'hidden';
  const next = document.getElementById('wiz-next');
  if (next) next.textContent = step === 3 ? '✦ Create Package' : 'ถัดไป →';
  const lbl = document.getElementById('wiz-step-label');
  if (lbl) lbl.textContent = `ขั้นตอน ${step+1} จาก 4`;
  if (step === 3) wizUpdatePreview();
}

async function wizStep(dir) {
  const step = wizState.step;
  if (step === 0 && dir === 1) {
    const name = document.getElementById('wiz-pkgname').value.trim();
    const errEl = document.getElementById('wiz-err0');
    if (!name) { errEl.textContent='กรุณากรอกชื่อ package'; errEl.style.display='block'; return; }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      errEl.textContent='ชื่อต้องขึ้นต้นด้วยตัวพิมพ์เล็ก ใช้ได้แค่ a-z, 0-9, _';
      errEl.style.display='block'; return;
    }
    errEl.style.display = 'none';
    wizState.pkgName = name;
    wizState.nodeName = document.getElementById('wiz-nodename').value.trim() ||
      name.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join('')+'Node';
  }

  if (step === 3 && dir === 1) {
    await wizCreate();
    return;
  }

  wizState.step = Math.max(0, Math.min(3, step + dir));
  wizRenderStep();
}

async function wizCreate() {
  if (!sessionId) return;
  const pkg = wizState.pkgName;
  const cls = wizState.nodeName;
  const lang = wizState.lang;
  const deps = [...wizState.deps];
  const exe = cls.replace(/Node$/,'').replace(/([A-Z])/g,'_$1').toLowerCase().replace(/^_/,'');
  const basePath = wsPath + '/src/' + pkg;

  const logEl = document.getElementById('wiz-buildlog');
  logEl.classList.remove('hidden');
  logEl.textContent = '';

  const log = (msg, clsStyle='') => {
    logEl.innerHTML += `<span class="${clsStyle}">${escH(msg)}\n</span>`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  document.getElementById('wiz-next').disabled = true;
  document.getElementById('wiz-next').textContent = '⏳ Creating...';

  try {
    log('📁 ตรวจสอบ workspace: ' + wsPath);
    const mkSrc = await API('/api/exec', {sessionId, command: `mkdir -p "${wsPath}/src"`, timeout: 5000});
    if(mkSrc.code !== 0){
      log('  ⚠ ไม่สามารถสร้าง src/ ได้: ' + mkSrc.stderr, 'bl-err');
    } else {
      log('  ✓ workspace/src พร้อมแล้ว', 'hg');
    }

    log('📦 สร้าง package: ' + pkg);
    const files = wizGenerateFiles(pkg, cls, exe, lang, deps);

    const dirSet = new Set();
    files.forEach(f => {
      const parts = (basePath + '/' + f.path).split('/');
      parts.pop();
      dirSet.add(parts.join('/'));
    });
    dirSet.add(basePath);

    const dirs = [...dirSet].sort((a,b) => a.split('/').length - b.split('/').length);
    const mkAll = await API('/api/exec', {sessionId, command: 'mkdir -p ' + dirs.map(d => `"${d}"`).join(' '), timeout: 8000});

    if(mkAll.code !== 0){
      log('  ⚠ mkdir: ' + mkAll.stderr, 'bl-warn');
    } else {
      dirs.forEach(d => log('  📁 ' + d.replace(wsPath+'/src/','src/'), 'hg'));
    }

    let hasError = false;
    for (const f of files) {
      const fullPath = basePath + '/' + f.path;
      const r = await API('/api/files/write', {sessionId, path: fullPath, content: f.content});
      if(r.ok){
        log('  ✓ ' + f.path, 'hg');
      } else {
        log('  ✗ ' + f.path + ' — ' + (r.error||'unknown error'), 'bl-err');
        hasError = true;
      }
    }

    log('');
    if(hasError){
      log('⚠ บางไฟล์สร้างไม่ได้ ลอง build ด้วยตนเองครับ', 'bl-warn');
    } else {
      log('✅ Package "' + pkg + '" สร้างสำเร็จ!', 'hg');
    }
    log('▶ Build ด้วย: colcon build --packages-select ' + pkg, 'hd');

    document.getElementById('wiz-next').textContent = '✓ Done — Close';
    document.getElementById('wiz-next').disabled = false;
    document.getElementById('wiz-next').onclick = async () => {
      closeModal('modal-wizard');
      document.getElementById('wiz-next').onclick = () => wizStep(1);
      if(typeof window.FLOW !== 'undefined' && window.FLOW._afterWizard){
        window.FLOW._afterWizard = false;
        if(typeof flowLoadPackages === 'function') await flowLoadPackages();
        const sel = document.getElementById('flow-pkg-sel');
        if(sel){ sel.value = pkg; if(typeof flowChangePkg === 'function') flowChangePkg(); }
      }
    };

    await refreshTree();

  } catch(e) {
    log('Error: ' + e.message, 'bl-err');
    document.getElementById('wiz-next').disabled = false;
    document.getElementById('wiz-next').textContent = '↻ Retry';
  }
}

function wizGenerateFiles(pkg, cls, exe, lang, deps) {
  const files = [];
  const depsXml = deps.map(d=>`  <depend>${d}</depend>`).join('\n');
  const buildType = lang==='py' ? 'ament_python' : 'ament_cmake';

  files.push({path:'package.xml', content:
`<?xml version="1.0"?>
<?xml-model href="http://download.ros.org/schema/package_format3.xsd" schematypens="http://www.w3.org/2001/XMLSchema"?>
<package format="3">
  <name>${pkg}</name>
  <version>0.1.0</version>
  <description>ROS2 package: ${pkg}</description>
  <maintainer email="dev@robot.local">Developer</maintainer>
  <license>Apache-2.0</license>
  <buildtool_depend>ament_${lang==='py'?'python':'cmake'}</buildtool_depend>
${depsXml}
  <test_depend>ament_copyright</test_depend>
  <test_depend>ament_flake8</test_depend>
  <test_depend>ament_pep257</test_depend>
  <test_depend>python3-pytest</test_depend>
  <export>
    <build_type>${buildType}</build_type>
  </export>
</package>
`});

  if (lang === 'py') {
    files.push({path:'setup.py', content:
`from setuptools import find_packages, setup

package_name = '${pkg}'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='Developer',
    maintainer_email='dev@robot.local',
    description='ROS2 package: ${pkg}',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            '${exe}_node = ${pkg}.${exe}_node:main',
        ],
    },
)
`});
    files.push({path:'setup.cfg', content:`[develop]\nscript_dir=$base/lib/${pkg}\n[install]\ninstall_scripts=$base/lib/${pkg}\n`});
    files.push({path:'resource/' + pkg, content: ''});
    files.push({path: pkg + '/__init__.py', content: ''});
    files.push({path: pkg + '/' + exe + '_node.py', content: wizGenPyNode(cls, exe, wizState.template, deps)});

  } else {
    const findPkgs = ['rclcpp', ...deps.filter(d=>d!=='rclpy')];
    files.push({path:'CMakeLists.txt', content:
`cmake_minimum_required(VERSION 3.8)
project(${pkg})

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake REQUIRED)
${findPkgs.map(p=>`find_package(${p} REQUIRED)`).join('\n')}

add_executable(${exe}_node src/${exe}_node.cpp)
target_include_directories(${exe}_node PUBLIC
  $<BUILD_INTERFACE:\${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>)
target_compile_features(${exe}_node PUBLIC c_std_99 cxx_std_17)
ament_target_dependencies(${exe}_node
  ${findPkgs.join('\n  ')})

install(TARGETS ${exe}_node DESTINATION lib/\${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
`});
    files.push({path: 'include/' + pkg + '/' + exe + '_node.hpp', content: wizGenCppHeader(cls, exe, pkg, deps)});
    files.push({path: 'src/' + exe + '_node.cpp', content: wizGenCppNode(cls, exe, pkg, wizState.template, deps)});
  }
  return files;
}

function wizGenPyNode(cls, exe, template, deps) {
  const hasTwist = deps.includes('geometry_msgs');
  const hasScan  = deps.includes('sensor_msgs');

  const importLines = ["import rclpy", "from rclpy.node import Node"];
  if (hasTwist) importLines.push("from geometry_msgs.msg import Twist");
  if (hasScan)  importLines.push("from sensor_msgs.msg import LaserScan");

  const bodies = {
    publisher: `
class ${cls}(Node):
    def __init__(self):
        super().__init__('${exe}_node')
        self.pub_ = self.create_publisher(
            ${hasTwist?'Twist':'# TODO: change msg type'}${hasTwist?'':''},
            '/cmd_vel',
            10)
        self.timer_ = self.create_timer(0.1, self.timer_callback)
        self.get_logger().info('${cls} started')

    def timer_callback(self):
        msg = ${hasTwist?'Twist()':'# TODO'}
        ${hasTwist?`msg.linear.x = 0.0\n        msg.angular.z = 0.0\n        self.pub_.publish(msg)`:'pass'}
`,
    subscriber: `
class ${cls}(Node):
    def __init__(self):
        super().__init__('${exe}_node')
        self.sub_ = self.create_subscription(
            ${hasScan?'LaserScan':'# TODO: msg type'},
            '${hasScan?'/scan':'/topic'}',
            self.callback,
            10)
        self.get_logger().info('${cls} started')

    def callback(self, msg):
        ${hasScan?`min_dist = min(msg.ranges)\n        self.get_logger().info(f'Min dist: {min_dist:.3f}m')`:'self.get_logger().info(str(msg))'}
`,
    pub_sub: `
class ${cls}(Node):
    def __init__(self):
        super().__init__('${exe}_node')
        self.pub_ = self.create_publisher(${hasTwist?'Twist':'# MsgType'}, '/cmd_vel', 10)
        self.sub_ = self.create_subscription(
            ${hasScan?'LaserScan':'# MsgType'},
            '${hasScan?'/scan':'/input'}',
            self.callback, 10)
        self.timer_ = self.create_timer(0.1, self.timer_cb)
        self.get_logger().info('${cls} started')

    def callback(self, msg):
        # Process incoming data
        pass

    def timer_cb(self):
        ${hasTwist?`msg = Twist()\n        self.pub_.publish(msg)`:'pass'}
`,
    service_srv: `
from std_srvs.srv import SetBool

class ${cls}(Node):
    def __init__(self):
        super().__init__('${exe}_node')
        self.srv_ = self.create_service(SetBool, '/${exe}/enable', self.handle)
        self.get_logger().info('${cls} service ready')

    def handle(self, request, response):
        response.success = True
        response.message = f'Set to: {request.data}'
        return response
`,
    lifecycle: `
from rclpy.lifecycle import LifecycleNode, TransitionCallbackReturn

class ${cls}(LifecycleNode):
    def __init__(self):
        super().__init__('${exe}_node')

    def on_configure(self, state):
        self.get_logger().info('Configuring...')
        return TransitionCallbackReturn.SUCCESS

    def on_activate(self, state):
        self.get_logger().info('Activating...')
        return TransitionCallbackReturn.SUCCESS

    def on_deactivate(self, state):
        self.get_logger().info('Deactivating...')
        return TransitionCallbackReturn.SUCCESS

    def on_cleanup(self, state):
        return TransitionCallbackReturn.SUCCESS
`,
    action_srv: `
from rclpy.action import ActionServer
from action_msgs.msg import GoalStatus

class ${cls}(Node):
    def __init__(self):
        super().__init__('${exe}_node')
        # TODO: Replace SomeAction with actual action type
        # self._as = ActionServer(self, SomeAction, '/${exe}', self.execute_cb)
        self.get_logger().info('${cls} action server ready')

    async def execute_cb(self, goal_handle):
        self.get_logger().info('Executing goal...')
        # TODO: implement action
        goal_handle.succeed()
`,
  };

  const body = bodies[template] || bodies.publisher;

  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""${cls} — generated by Mecha Rayong Learing Workspace"""

${importLines.join('\n')}
${body}

def main(args=None):
    rclpy.init(args=args)
    node = ${cls}()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
`;
}

function wizGenCppHeader(cls, exe, pkg, deps) {
  const guard = (pkg + '_' + exe + '_NODE_HPP').toUpperCase();
  return `#ifndef ${guard}\n#define ${guard}\n\n#include "rclcpp/rclcpp.hpp"\n${deps.includes('geometry_msgs')?'#include "geometry_msgs/msg/twist.hpp"\n':''}${deps.includes('sensor_msgs')?'#include "sensor_msgs/msg/laser_scan.hpp"\n':''}\nnamespace ${pkg} {\n\nclass ${cls} : public rclcpp::Node {\npublic:\n  explicit ${cls}(const rclcpp::NodeOptions & options = rclcpp::NodeOptions());\n\nprivate:\n  // TODO: add publishers, subscribers, timers here\n};\n\n}  // namespace ${pkg}\n\n#endif  // ${guard}\n`;
}

function wizGenCppNode(cls, exe, pkg, template, deps) {
  const bodies = {
    publisher: `\n${pkg}::${cls}::${cls}(const rclcpp::NodeOptions & options)\n: Node("${exe}_node", options)\n{\n  pub_ = create_publisher<geometry_msgs::msg::Twist>("/cmd_vel", 10);\n  timer_ = create_wall_timer(\n    std::chrono::milliseconds(100),\n    std::bind(&${cls}::timer_cb, this));\n  RCLCPP_INFO(get_logger(), "${cls} started");\n}\n\nvoid ${pkg}::${cls}::timer_cb()\n{\n  auto msg = geometry_msgs::msg::Twist{};\n  msg.linear.x = 0.0;\n  pub_->publish(msg);\n}`,
    subscriber: `\n${pkg}::${cls}::${cls}(const rclcpp::NodeOptions & options)\n: Node("${exe}_node", options)\n{\n  sub_ = create_subscription<sensor_msgs::msg::LaserScan>(\n    "/scan", 10,\n    std::bind(&${cls}::scan_cb, this, std::placeholders::_1));\n  RCLCPP_INFO(get_logger(), "${cls} started");\n}\n\nvoid ${pkg}::${cls}::scan_cb(const sensor_msgs::msg::LaserScan::SharedPtr msg)\n{\n  auto min_it = std::min_element(msg->ranges.begin(), msg->ranges.end());\n  RCLCPP_INFO(get_logger(), "Min dist: %.3f", *min_it);\n}`,
    pub_sub: `\n${pkg}::${cls}::${cls}(const rclcpp::NodeOptions & options)\n: Node("${exe}_node", options)\n{\n  pub_  = create_publisher<geometry_msgs::msg::Twist>("/cmd_vel", 10);\n  sub_  = create_subscription<sensor_msgs::msg::LaserScan>(\n    "/scan", 10, std::bind(&${cls}::scan_cb, this, std::placeholders::_1));\n  timer_ = create_wall_timer(\n    std::chrono::milliseconds(100),\n    std::bind(&${cls}::timer_cb, this));\n}`,
    component: `\n${pkg}::${cls}::${cls}(const rclcpp::NodeOptions & options)\n: Node("${exe}_node", options)\n{\n  RCLCPP_INFO(get_logger(), "${cls} component loaded");\n}`,
    lifecycle: `\n#include "rclcpp_lifecycle/lifecycle_node.hpp"\n// Lifecycle callbacks go here`,
    service_srv: `\n${pkg}::${cls}::${cls}(const rclcpp::NodeOptions & options)\n: Node("${exe}_node", options)\n{\n  srv_ = create_service<std_srvs::srv::SetBool>(\n    "/${exe}/enable",\n    std::bind(&${cls}::handle, this, std::placeholders::_1, std::placeholders::_2));\n}`,
  };

  return `// ${cls} — generated by Mecha Rayong Learing Workspace\n#include "${pkg}/${exe}_node.hpp"\n#include <algorithm>\n\n${bodies[template] || bodies.publisher}\n\nint main(int argc, char ** argv)\n{\n  rclcpp::init(argc, argv);\n  rclcpp::spin(std::make_shared<${pkg}::${cls}>());\n  rclcpp::shutdown();\n  return 0;\n}\n\n// Register as composable component\n#include "rclcpp_components/register_node_macro.hpp"\nRCLCPP_COMPONENTS_REGISTER_NODE(${pkg}::${cls})\n`;
}

// ══ CONTEXT MENU ══
let ctxTarget = null;

function showCtxMenu(e, fp, isDir) {
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = { path: fp, isDir };

  const parentDir = fp.slice(0, fp.lastIndexOf('/'));
  const fpArg = `decodeURIComponent('${encArg(fp)}')`;
  const parentArg = `decodeURIComponent('${encArg(parentDir)}')`;
  const menu = document.getElementById('ctx-menu');
  let items = '';

  if (isDir) {
    items += menuItem('📄', 'New file here',    `ctxNewFile(${fpArg})`);
    items += menuItem('📁', 'New folder here',  `ctxNewFolder(${fpArg})`);
    items += '<div class="ctx-sep"></div>';
    items += menuItem('✏️', 'Rename',            `ctxRename(${fpArg},true)`);
    items += '<div class="ctx-sep"></div>';
    items += menuItem('🗑️', 'Delete folder',     `ctxDelete(${fpArg},true)`, true);
  } else {
    items += menuItem('✏️', 'Rename',            `ctxRename(${fpArg},false)`);
    items += menuItem('📋', 'Copy path',         `ctxCopyPath(${fpArg})`);
    items += menuItem('📂', 'Open in terminal',  `ctxOpenDir(${fpArg})`);
    items += '<div class="ctx-sep"></div>';
    items += menuItem('📄', 'New file here',    `ctxNewFile(${parentArg})`);
    items += '<div class="ctx-sep"></div>';
    items += menuItem('🗑️', 'Delete',            `ctxDelete(${fpArg},false)`, true);
  }

  menu.innerHTML = items;
  menu.style.display = 'block';

  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 200, mh = menu.offsetHeight || 220;
  let x = e.clientX, y = e.clientY;
  if (x + mw > vw) x = vw - mw - 6;
  if (y + mh > vh) y = vh - mh - 6;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function menuItem(icon, label, action, danger=false) {
  return `<div class="ctx-item${danger?' danger':''}" onclick="${action};hideCtxMenu()">
    <span class="ctx-icon">${icon}</span>${label}
  </div>`;
}

function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if(menu) menu.style.display = 'none';
  ctxTarget = null;
}

if(typeof document !== 'undefined'){
  document.addEventListener('click',  () => hideCtxMenu());
  document.addEventListener('keydown', e => { if(e.key==='Escape') hideCtxMenu(); });
}

function ctxNewFile(parentDir) {
  if (!sessionId) return;
  document.getElementById('nf-name').value = '';
  document.getElementById('nf-err').style.display = 'none';
  document.getElementById('nf-name').placeholder = parentDir + '/new_file.py';
  window._ctxNewFileDir = parentDir;
  openModal('modal-nf');
}

function ctxNewFolder(parentDir) {
  if (!sessionId) return;
  document.getElementById('nd-name').value = '';
  document.getElementById('nd-err').style.display = 'none';
  document.getElementById('nd-name').placeholder = parentDir + '/new_folder';
  window._ctxNewDirBase = parentDir;
  openModal('modal-nd');
}

function ctxRename(fp, isDir) {
  const name = fp.split('/').pop();
  document.getElementById('rename-sub').textContent = fp;
  document.getElementById('rename-input').value = name;
  document.getElementById('rename-err').style.display = 'none';
  window._renameFrom = fp;
  window._renameIsDir = isDir;
  openModal('modal-rename');
  setTimeout(() => {
    const inp = document.getElementById('rename-input');
    inp.focus();
    if (!isDir && name.includes('.')) {
      inp.setSelectionRange(0, name.lastIndexOf('.'));
    } else {
      inp.select();
    }
  }, 50);
}

async function doRename() {
  const from = window._renameFrom;
  const newName = document.getElementById('rename-input').value.trim();
  const errEl = document.getElementById('rename-err');
  if (!newName) { errEl.textContent = 'กรุณากรอกชื่อใหม่'; errEl.style.display='block'; return; }
  if (newName === from.split('/').pop()) { closeModal('modal-rename'); return; }

  if (newName.includes('/') || newName.includes('\\')) {
    errEl.textContent = 'ชื่อไม่สามารถมี / หรือ \\ ได้';
    errEl.style.display = 'block'; return;
  }

  const parentDir = from.slice(0, from.lastIndexOf('/'));
  const to = parentDir + '/' + newName;

  sbMsg('Renaming...');
  const res = await API('/api/files/rename', { sessionId, from, to });
  if (!res.ok) {
    errEl.textContent = 'Error: ' + res.error;
    errEl.style.display = 'block';
    sbMsg('');
    return;
  }

  const tabIdx = openTabs.findIndex(t => t.path === from || t.path.startsWith(from + '/'));
  if (tabIdx >= 0) {
    openTabs[tabIdx].path = openTabs[tabIdx].path.replace(from, to);
    if (activeTab === from) activeTab = to;
    currentPath = currentPath === from ? to : currentPath;
    if(typeof renderTabs === 'function') renderTabs();
  }

  closeModal('modal-rename');
  sbMsg('Renamed → ' + newName, 2500);
  await refreshTree();
}

function ctxDelete(fp, isDir) {
  document.getElementById('del-info').textContent = fp;
  document.getElementById('del-warn').textContent = isDir
    ? '⚠️ ลบโฟลเดอร์นี้และไฟล์ทั้งหมดข้างใน — ไม่สามารถกู้คืนได้'
    : '⚠️ ลบไฟล์ถาวร — ไม่สามารถกู้คืนได้';
  window._deleteTarget = { path: fp, isDir };
  openModal('modal-delete');
}

async function doDelete() {
  const { path: fp, isDir } = window._deleteTarget || {};
  if (!fp) return;

  sbMsg('Deleting...');
  let res;
  if (isDir) {
    res = await API('/api/exec', { sessionId, command: `rm -rf "${fp}"` });
    res = { ok: res.code === 0, error: res.stderr };
  } else {
    res = await API('/api/files/delete', { sessionId, path: fp, isDir: false });
  }

  if (!res.ok) { sbMsg('Delete error: ' + res.error, 3000); return; }

  openTabs = openTabs.filter(t => {
    if (t.path === fp || t.path.startsWith(fp + '/')) {
      if (activeTab === t.path) activeTab = null;
      return false;
    }
    return true;
  });
  
  if (!activeTab && openTabs.length > 0 && typeof switchToTab === 'function') {
      switchToTab(openTabs[openTabs.length-1].path);
  } else if (openTabs.length === 0) {
    document.getElementById('no-file')?.classList.remove('hidden');
    document.getElementById('ed-container')?.classList.add('hidden');
    document.getElementById('ed-foot')?.classList.add('hidden');
  }
  if(typeof renderTabs === 'function') renderTabs();

  closeModal('modal-delete');
  sbMsg('Deleted: ' + fp.split('/').pop(), 2500);
  await refreshTree();
}

function ctxCopyPath(fp) {
  if(typeof navigator!=='undefined'&&navigator.clipboard) {
    navigator.clipboard.writeText(fp).then(() => sbMsg('Copied: ' + fp, 2000)).catch(() => sbMsg(fp, 3000));
  } else {
    document.execCommand('copy');
    sbMsg('Copied: ' + fp, 2000);
  }
}

function ctxOpenDir(fp) {
  const dir = fp.slice(0, fp.lastIndexOf('/'));
  const folderName = dir.split('/').pop() || 'Terminal';
  
  // สลับไปหน้า Terminal
  switchPage('terminal');
  
  // สร้าง Tab ใหม่ พร้อมสั่ง cd ไปยังโฟลเดอร์นั้นทันที
  if (typeof termNewTab === 'function') {
    termNewTab('📂 ' + folderName, `cd ${dir} && clear`);
  }
}


// ══ QUICK COMMANDS (Run in New Tab) ══

// ฟังก์ชันช่วยเหลือสำหรับเปิด Tab ใหม่และรันคำสั่ง
window.runInNewTab = function(cmd, tabName = 'Task') {
  if (!sessionId) {
    if (typeof sbMsg === 'function') sbMsg('กรุณาเชื่อมต่อระบบก่อน', 2000);
    return;
  }
  switchPage('terminal');
  if (typeof termNewTab === 'function') {
    termNewTab(tabName, cmd);
  }
};

// ฟังก์ชันช่วย: รันคำสั่งใน "แท็บเฉพาะ" ที่ระบุชื่อ (tabLabel)
// - ถ้ามีแท็บชื่อเดียวกันเปิดอยู่แล้ว → สลับไปแท็บนั้น (ไม่เปิดใหม่) แล้วรันคำสั่ง
// - ถ้ายังไม่มี → สร้างแท็บใหม่ชื่อ tabLabel แล้วรันคำสั่ง
// ใช้เพื่อแยก build / run แต่ละอย่างออกจากกันชัดเจน (ไม่ build ทับแท็บที่รัน ros อยู่)
window.runInDedicatedTab = function(cmd, tabLabel) {
  if (!sessionId) {
    if (typeof sbMsg === 'function') sbMsg('กรุณาเชื่อมต่อระบบก่อน', 2000);
    return null;
  }
  if (typeof TERMS !== 'undefined') {
    const existing = TERMS.find(t => t.label === tabLabel);
    if (existing) {
      switchPage('terminal');
      termSwitchTab(existing.id);
      termRunInTab(existing.id, cmd);
      if (typeof sbMsg === 'function') sbMsg('ใช้แท็บเดิม: ' + tabLabel, 1500);
      return existing;
    }
  }
  switchPage('terminal');
  if (typeof termNewTab === 'function') return termNewTab(tabLabel, cmd);
  return null;
};

// 1. ปุ่ม colcon build (แถบด้านบน)
// ใช้แท็บเฉพาะชื่อ "⚙️ Build" — ถ้ามีแท็บนี้เปิดอยู่แล้ว ให้เด้งไปแท็บเดิม (ไม่เปิดใหม่) และรัน build
// ถ้ายังไม่มี ให้สร้างแท็บใหม่ชื่อ "⚙️ Build" แล้วรัน build ปกติ (แยกจากแท็บ run ros ชัดเจน)
window.quickBuild = function() {
  const ws = typeof wsPath !== 'undefined' ? wsPath : '~/ros2_ws';
  const src = (typeof rosInfo !== 'undefined' && rosInfo?.setupBash) || '/opt/ros/humble/setup.bash';
  const cmd = `cd ${ws} && source ${src} && colcon build && source install/setup.bash && echo "\\n[OK] Build done"`;
  runInDedicatedTab(cmd, '⚙️ Build');
};

// 2. ปุ่ม source setup.bash (เมนูด้านซ้าย)
window.sourceSetup = function() {
  const ws = typeof wsPath !== 'undefined' ? wsPath : '~/ros2_ws';
  runInNewTab(`cd ${ws} && source install/setup.bash`, '⟳ Source');
};


// ══ SIDEBAR RESIZE ══
if(typeof window !== 'undefined'){
  (function(){
    const STORE_KEY = 'ros2ide_sb_width';
    const MIN = 140, MAX = 520, DEFAULT = 220;

    window.addEventListener('DOMContentLoaded', () => {
      applySimulationVisibility();
      loadTerminalPlanAccess();
      // ── Apply restored session from robots page ──
      if(window._restoredSession){
        const saved = window._restoredSession;
        void (async()=>{
          const restored=await API('/api/session/restore',{sessionId:saved.sessionId,robotId:saved.robotId}).catch(()=>null);
          if(!restored?.ok){
            ['ros2ide_session','ros2ide_robotid','ros2ide_rosinfo','ros2ide_workspace','ros2ide_username','ros2ide_robotname','ros2ide_robotkey','ros2ide_is_sim'].forEach(key=>localStorage.removeItem(key));
            window.location.replace('/robots');
            return;
          }
          const rs={...saved,...restored};
          sessionId=rs.sessionId;
          rosInfo=rs.rosInfo||{distro:'humble',setupBash:'/opt/ros/humble/setup.bash',version:'2'};
          wsPath=rs.workspace||'~/ros2_ws';
          isSimWorkspace=rs.isSim===true;
          applySimulationVisibility();
          localStorage.setItem('ros2ide_session',sessionId);
          localStorage.setItem('ros2ide_robotid',String(rs.robotId));
          localStorage.setItem('ros2ide_rosinfo',JSON.stringify(rosInfo));
          localStorage.setItem('ros2ide_workspace',wsPath);
          localStorage.setItem('ros2ide_username',rs.username||'ubuntu');
          localStorage.setItem('ros2ide_robotname',rs.robotName||'Robot');
          localStorage.setItem('ros2ide_robotkey',rs.robotKey||'');
          localStorage.setItem('ros2ide_is_sim',String(isSimWorkspace));
          // เรียก onConnected เพื่อ setup UI และ Terminal ครบ
          if(typeof onConnected === 'function'){
            onConnected(rs.robotName||'robot', rs.username||'ubuntu', rosInfo);
          } else {
            // fallback: update UI manually
            const b = document.getElementById('badge-conn');
            if(b){ b.innerHTML='<span class="dot dg"></span>'; b.className='top-icon-action connection-state online'; b.title='เชื่อมต่อแล้ว'; b.setAttribute('aria-label','เชื่อมต่อแล้ว'); }
            const robotIcon = document.getElementById('robot-info-icon');
            if(robotIcon){ robotIcon.title=`หุ่นยนต์: ${rs.robotName||'robot'}`; robotIcon.setAttribute('aria-label',`หุ่นยนต์ ${rs.robotName||'robot'}`); }
            const u = document.getElementById('badge-user');
            if(u){ u.textContent=`${rs.username||'ubuntu'}@${rs.robotName||'robot'}`; u.classList.remove('hidden'); }
            ['btn-build','btn-disc'].forEach(id=>{ const el=document.getElementById(id); if(el) el.disabled=false; });
            if(typeof openTermWs==='function') openTermWs(rs.username||'ubuntu', rs.robotName||'robot');
            if(typeof loadTree==='function') loadTree(wsPath,'file-tree',0);
          }
          console.log('[APP] Session restored:',rs.sessionId,restored.restored?'reused':'renewed');
        })();
      }

      const sidebar  = document.getElementById('sidebar');
      const resizer  = document.getElementById('sb-resizer');
      if (!sidebar || !resizer) return;

      const saved = parseInt(localStorage.getItem(STORE_KEY));
      if (saved && saved >= MIN && saved <= MAX) {
        sidebar.style.width = saved + 'px';
      }

      let startX = 0, startW = 0, dragging = false;

      resizer.addEventListener('mousedown', e => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = sidebar.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const newW  = Math.min(MAX, Math.max(MIN, startW + delta));
        sidebar.style.width = newW + 'px';
      });

      document.addEventListener('mouseup', e => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(STORE_KEY, sidebar.offsetWidth);
        if (typeof window.termFit === 'function') window.termFit();
      });

      resizer.addEventListener('dblclick', () => {
        sidebar.style.width = DEFAULT + 'px';
        localStorage.setItem(STORE_KEY, DEFAULT);
        if (typeof window.termFit === 'function') window.termFit();
      });
    });
  })();
}




// ══ GLOBAL EXPORTS ══
if (typeof window !== 'undefined') {
  window.doConnect = doConnect;
  window.onConnected = onConnected;
  window.doDisconnect = doDisconnect;
  window.switchPage = switchPage;
  window.setAuth = setAuth;
  window.selNft = selNft;
  window.setConnMode = setConnMode;
  window.openConnModal = openConnModal;
  window.closeModal = closeModal;
  window.openModal = openModal;
  window.loadTree = loadTree;
  window.refreshTree = refreshTree;
  window.toggleDir = toggleDir;
  window.newFileDialog = newFileDialog;
  window.doNewFile = doNewFile;
  window.newDirDialog = newDirDialog;
  window.doNewDir = doNewDir;
  window.showPath = showPath;
  window.openWizard = openWizard;
  window.showCtxMenu = showCtxMenu;
  window.hideCtxMenu = hideCtxMenu;
  window.doRename = doRename;
  window.doDelete = doDelete;
  window.wizSetLang = wizSetLang;
  window.wizStep = wizStep;
  window.wizToggleDep = wizToggleDep;
  window.wizSelTemplate = wizSelTemplate;
  window.wizUpdatePreview = wizUpdatePreview;
  window.ctxNewFile = ctxNewFile;
  window.ctxNewFolder = ctxNewFolder;
  window.ctxRename = ctxRename;
  window.ctxDelete = ctxDelete;
  window.ctxCopyPath = ctxCopyPath;
  window.ctxOpenDir = ctxOpenDir;

  window.quickBuild = quickBuild;
  window.sourceSetup = sourceSetup;
  window.runInNewTab = runInNewTab;
}
