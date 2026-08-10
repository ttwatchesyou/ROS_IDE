// ══ DASHBOARD — stats, nodes, processes ══
let dashLoading = false;
let dashInterval = null;

async function loadDashboard(forceProjectScan = false) {
  if (!sessionId) return;
  if (dashLoading) return;
  dashLoading = true;
  const buttons = ['btn-refresh-status'].map(id=>document.getElementById(id)).filter(Boolean);
  buttons.forEach(btn=>{ btn.disabled=true; btn.innerHTML='<span class="spin-icon">↻</span> กำลังอัปเดต…'; });

  try {
    // ดึงทั้ง ROS graph (nodes/topics) และ OS processes ที่เจาะจงกับ workspace ของ sim นี้
    // (backend กรองเฉพาะ root ของ sim → ไม่ปน node ของ sim อื่น และไม่ใช่แค่ grep "~/ros2_ws" ที่จับไม่ได้)
    const res = await API('/api/dashboard', { sessionId, forceProjectScan });

    if (!res.ok) {
      if (typeof sbMsg === 'function') sbMsg('Dashboard error: ' + res.error, 3000);
      return;
    }

    res.processes = res.processes || [];
    renderDashboard(res);
  } catch(e) {
    if (typeof sbMsg === 'function') sbMsg('Dashboard error: ' + e.message, 3000);
  } finally {
    dashLoading = false;
    buttons.forEach(btn=>{ btn.disabled=false; btn.textContent='↻ อัปเดต'; });
  }
}

function renderDashboard(d) {
  const ri = d.rosInfo || rosInfo || { distro: '—', version: '—' };
  const projectWorkspace = String(d.project?.workspace || '');
  const projectPackages = Array.isArray(d.project?.packages) ? d.project.packages : [];
  const simFromProject = /(?:^|[\\/])sim_ws[\\/]SIM-/i.test(projectWorkspace)
    || projectPackages.some(packageName => /^sim_robot_(?:tf|odom|mapsim)$/.test(packageName))
    || d.project?.capabilities?.some(capability => capability.id === 'lidar' && capability.mapCheck === true);
  isSimWorkspace = typeof d.isSim === 'boolean' ? (d.isSim || simFromProject) : simFromProject;
  localStorage.setItem('ros2ide_is_sim', String(isSimWorkspace));
  d.nodes = Array.isArray(d.nodes) ? d.nodes : [];
  d.topics = Array.isArray(d.topics) ? d.topics : [];
  d.processes = Array.isArray(d.processes) ? d.processes : [];
  
  // stat cards
  document.getElementById('dc-nodes').textContent = d.nodes.length;
  document.getElementById('dc-topics').textContent = d.topics.length;
  
  const cpu = Math.round(d.cpu || 0);
  document.getElementById('dc-cpu').textContent = cpu + '%';
  document.getElementById('dc-cpu').style.color = cpu > 80 ? 'var(--red)' : cpu > 50 ? 'var(--amb)' : 'var(--grn)';
  document.getElementById('cpu-bar').style.width = cpu + '%';
  document.getElementById('cpu-bar').className = 'bar-fill ' + (cpu > 80 ? 'bar-r' : cpu > 50 ? 'bar-a' : 'bar-g');
  
  const memPct = d.memTotal > 0 ? Math.round(d.memUsed / d.memTotal * 100) : 0;
  document.getElementById('dc-mem').textContent = d.memUsed + 'MB';
  document.getElementById('dc-mem-sub').textContent = `${d.memUsed}MB / ${d.memTotal}MB (${memPct}%)`;
  document.getElementById('mem-bar').style.width = memPct + '%';
  document.getElementById('mem-bar').className = 'bar-fill ' + (memPct > 85 ? 'bar-r' : memPct > 60 ? 'bar-a' : 'bar-g');
  
  document.getElementById('dc-distro').textContent = ri.distro;
  document.getElementById('dc-ros-ver').textContent = `ROS${ri.version}`;
  if (d.disk) {
    document.getElementById('dc-disk').textContent = d.disk.used;
    document.getElementById('dc-disk-sub').textContent = `${d.disk.total} (${d.disk.pct})`;
    const dpct = parseInt(d.disk.pct) || 0;
    document.getElementById('disk-bar').style.width = dpct + '%';
  }
  document.getElementById('dc-uptime').textContent = d.uptime || '—';
  document.getElementById('dc-os').textContent = ri.os || '—';
  renderRobotHealth({ cpu, memPct, nodeCount: d.nodes.length, processCount: d.processes.length });
  renderProjectCapabilities(d.project);

  const nc = document.getElementById('node-cnt');
  if (nc) {
    if (d.nodes.length > 0) { nc.textContent = d.nodes.length; nc.classList.remove('hidden'); }
    else nc.classList.add('hidden');
  }

  // ── 1. แทรกส่วน RUNNING PROCESSES (OS Level) เข้ามาแทนที่ปุ่ม Kill เดิม ──
  let procSection = document.getElementById('process-section');
  if (!procSection) {
      procSection = document.createElement('div');
      procSection.id = 'process-section';
      procSection.className = 'status-section';
      const gridNode = document.getElementById('nodes-grid');
      const nodesSection = gridNode.parentNode;
      nodesSection.parentNode.insertBefore(procSection, nodesSection);
  }

  procSection.innerHTML = `
    <div class="section-title"><span class="status-section-icon">🎮</span><span class="status-section-name">โปรแกรมที่กำลังทำงาน</span><span class="badge bx status-section-name">${d.processes.length}</span><span class="status-section-help">ปิดเฉพาะโปรแกรมที่ไม่ต้องการใช้</span><span></span></div>
    <div class="nodes-grid">
       ${d.processes && d.processes.length > 0 ? d.processes.map(p => `
          <div class="node-card" style="border-color:rgba(245,166,35,.3)">
             <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 8px;">
                <div class="node-name" style="margin-bottom:0; color:var(--amb)"><span class="node-dot" style="background:var(--amb)"></span>PID: ${p.pid}</div>
                <button class="btn status-card-kill" onclick="killPID('${p.pid}')" aria-label="ปิดโปรแกรม PID ${p.pid}">■ ปิดโปรแกรม</button>
             </div>
             <div style="font-family:var(--mono);font-size:10px;color:var(--mt);word-break:break-all;line-height:1.4;">${escH(p.cmd)}</div>
          </div>
       `).join('') : '<div class="empty-state"><span class="status-empty-icon">💤</span>ยังไม่มีโปรแกรม ROS ทำงานอยู่</div>'}
    </div>
  `;

  // ── 2. ส่วน RUNNING NODES เดิม (ลบปุ่ม Kill ออก เพราะเราไป Kill ที่ PID แทนแล้ว) ──
  const grid = document.getElementById('nodes-grid');
  if (d.nodes.length === 0) {
    grid.innerHTML = '<div class="empty-state"><span class="status-empty-icon">🌙</span>ยังไม่พบ ROS node — ลองเปิดโปรแกรมหุ่นยนต์แล้วอัปเดตอีกครั้ง</div>';
  } else {
    grid.innerHTML = d.nodes.map(n => `
      <div class="node-card" onclick="inspectNode(decodeURIComponent('${encArg(n.name)}'))">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 8px;">
          <div class="node-name" style="margin-bottom:0;"><span class="node-dot"></span>${escH(n.name)}</div>
          <button class="btn status-card-kill" onclick="event.stopPropagation(); killNode(decodeURIComponent('${encArg(n.name)}'))" aria-label="หยุด node ${escH(n.name)}">■ หยุด</button>
        </div>
        ${n.publishers.length ? `<div class="node-section">Publishes</div>` + n.publishers.map(p => `<div class="node-topic">${escH(p)}</div>`).join('') : ''}
        ${n.subscribers.length ? `<div class="node-section" style="margin-top:6px">Subscribes</div>` + n.subscribers.map(s => `<div class="node-topic">${escH(s)}</div>`).join('') : ''}
      </div>`).join('');
  }

  const lu = document.getElementById('dash-last-update');
  if (lu) lu.textContent = 'เช็กล่าสุด ' + new Date(d.timestamp).toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit' });
  const slu = document.getElementById('status-last-update');
  if (slu) slu.textContent = 'ล่าสุด ' + new Date(d.timestamp).toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function renderRobotHealth({ cpu, memPct, nodeCount, processCount }) {
  const box = document.getElementById('status-health');
  const face = document.getElementById('status-health-face');
  const title = document.getElementById('status-health-title');
  const detail = document.getElementById('status-health-detail');
  if (!box || !face || !title || !detail) return;

  let level = 'good';
  let icon = '😊';
  let heading = 'หุ่นยนต์แข็งแรงดี!';
  let message = `${nodeCount} nodes และ ${processCount} โปรแกรมกำลังทำงาน`;
  if (cpu > 80 || memPct > 85) {
    level = 'danger'; icon = '🥵'; heading = 'หุ่นยนต์กำลังทำงานหนัก';
    message = 'ควรหยุดโปรแกรมที่ไม่ใช้ เพื่อลดภาระของระบบ';
  } else if (cpu > 50 || memPct > 60) {
    level = 'warning'; icon = '🙂'; heading = 'หุ่นยนต์ทำงานค่อนข้างหนัก';
    message = 'ยังทำงานได้ แต่ควรสังเกตแถบพลังสมองและความจำ';
  } else if (nodeCount === 0 && processCount === 0) {
    level = 'warning'; icon = '😴'; heading = 'หุ่นยนต์กำลังพักอยู่';
    message = 'เปิดโปรแกรม ROS แล้วกลับมาดูการทำงานได้เลย';
  }
  box.className = `status-health${level === 'good' ? '' : ` ${level}`}`;
  face.textContent = icon;
  title.textContent = heading;
  detail.textContent = message;
}

const PROJECT_CAPABILITY_META = {
  urdf:       { icon:'🤖', name:'ประกอบตัวหุ่น', tech:'Robot Model', desc:'สร้างรูปร่าง ตัวรถ ล้อ และเซนเซอร์ให้หุ่นยนต์ของเรา', requirements:['มีแบบหุ่นยนต์ .urdf หรือ .xacro','ตั้งชื่อส่วนหลักและข้อต่อให้ครบ','ส่งแบบหุ่นผ่าน robot_description'], page:'transformation', action:'ไปประกอบหุ่น' },
  tf:         { icon:'🧭', name:'เชื่อมชิ้นส่วน', tech:'TF / Frames', desc:'บอกหุ่นยนต์ว่าแต่ละชิ้นส่วนอยู่ตรงไหนและหันไปทางใด', requirements:['เชื่อมพิกัด map ไปยัง odom','เชื่อม odom ไปยังฐานหุ่นยนต์','เชื่อมฐานไปยังเซนเซอร์ทุกตัว'], page:'transformation', action:'ไปเชื่อมชิ้นส่วน' },
  control:    { icon:'🎮', name:'ฝึกบังคับหุ่น', tech:'Motion Control', desc:'เปลี่ยนคำสั่งเดินหน้าและเลี้ยวให้เป็นการหมุนของล้อ', requirements:['รับคำสั่งความเร็วจาก /cmd_vel','คำนวณความเร็วของล้อแต่ละข้าง','ส่งคำสั่งไปยังมอเตอร์หรือระบบจำลอง'], page:null, action:'กำลังพัฒนา' },
  odom:       { icon:'📍', name:'จำเส้นทาง', tech:'Odometry', desc:'ช่วยให้หุ่นยนต์รู้ว่าตัวเองเดินไปไกลและหันไปทางไหนแล้ว', requirements:['ส่งตำแหน่งผ่าน /odom','กำหนด odom และ base_link ให้ถูกต้อง','ส่งการเชื่อมต่อ odom → base_link'], page:'transformation', action:'ไปตั้งค่าการเดินทาง' },
  lidar:      { icon:'📡', name:'เปิดตาเรดาร์', tech:'LiDAR', desc:'ให้หุ่นยนต์มองเห็นกำแพงและสิ่งกีดขวางรอบตัว', requirements:['ส่งข้อมูล LaserScan ผ่าน /scan','เชื่อมตำแหน่ง LiDAR ใน TF tree','กำหนดระยะและมุมสแกนให้เหมาะสม'], page:null, action:'กำลังพัฒนา' },
  mapping:    { icon:'🗺️', name:'วาดแผนที่', tech:'Mapping / SLAM', desc:'เปลี่ยนสิ่งที่เซนเซอร์มองเห็นให้กลายเป็นแผนที่', requirements:['เตรียม /scan, /tf และ /odom ให้พร้อม','ใช้ SLAM ช่วยสำรวจพื้นที่','ส่งแผนที่ผ่าน /map'], page:null, action:'กำลังพัฒนา' },
  navigation: { icon:'🏁', name:'ออกผจญภัย', tech:'Autonomous Navigation', desc:'ให้หุ่นยนต์คิดเส้นทางและเดินไปถึงเป้าหมายด้วยตัวเอง', requirements:['เตรียม Nav2 และแผนที่','ตรวจ localization และ TF ให้ครบ','ส่งเป้าหมายแล้วทดสอบการหลบสิ่งกีดขวาง'], page:null, action:'กำลังพัฒนา' },
};

const AGV_WIZARD_ORDER = ['urdf','tf','odom','control','lidar','mapping','navigation'];
let agvCapabilityState = {};
let selectedAgvStep = null;

function getAgvCapabilityMeta(id) {
  const base = PROJECT_CAPABILITY_META[id];
  if (!base) return { icon:'•', name:id, tech:'', desc:'ความสามารถของ ROS project', requirements:[], page:null, action:'กำลังพัฒนา' };
  if (id === 'lidar' && isSimWorkspace) {
    return {
      ...base,
      name: 'สร้างสนามให้ LiDAR',
      tech: 'LiDAR + Map Editor',
      desc: 'วาดกำแพงและพื้นที่จำลองให้เซนเซอร์มองเห็น แล้วเตรียมแผนที่สำหรับให้หุ่นยนต์ออกเดิน',
      requirements: ['เลือกยี่ห้อและรุ่น LiDAR ที่ต้องการเตรียมไว้', 'วาดกำแพง ขอบเขตห้อง และจุดเริ่มของหุ่นยนต์', 'บันทึกแผนที่แล้ว Apply to Sim เพื่อทดสอบการสแกน'],
      explanation: [
        { icon:'✏️', title:'ทำอะไร', text:'สร้างสนามจำลอง กำหนดกำแพง ขอบเขต และจุดเริ่มของหุ่นยนต์' },
        { icon:'💡', title:'ทำไมต้องทำ', text:'LiDAR ต้องมีสิ่งกีดขวางให้แสงเลเซอร์กระทบ ระบบจึงจำลองระยะรอบตัวได้' },
        { icon:'🎯', title:'ทำแล้วได้อะไร', text:'ได้ไฟล์ map.json สำหรับทดสอบ /scan และการเดินของหุ่นยนต์ใน Sim' },
      ],
      page: 'map',
      action: 'เปิด Map Editor',
    };
  }
  return base;
}

function renderProjectCapabilities(project) {
  const grid = document.getElementById('project-capabilities-grid');
  const title = document.getElementById('project-summary-title');
  const meta = document.getElementById('project-summary-meta');
  const note = document.getElementById('project-scan-note');
  const progress = document.getElementById('agv-progress-fill');
  const progressBar = progress?.parentElement;
  const progressPercent = document.getElementById('agv-progress-percent');
  const missionCount = document.getElementById('agv-mission-count');
  const coachFace = document.getElementById('agv-coach-face');
  const detail = document.getElementById('agv-wizard-detail');
  if (!grid || !title || !meta || !note) return;

  if (!project || project.ok === false) {
    title.textContent = 'ยังเปิดแผนที่ภารกิจไม่ได้';
    meta.textContent = project?.error || 'ยังไม่มีข้อมูลจาก workspace';
    note.textContent = 'ลองเชื่อมต่อหุ่นยนต์ แล้วกด “เช็กภารกิจของฉัน” อีกครั้งนะ';
    if(progress) progress.style.width='0%';
    if(progressBar) progressBar.setAttribute('aria-valuenow','0');
    if(progressPercent) progressPercent.textContent='0%';
    if(missionCount) missionCount.textContent='0 / 7 สำเร็จ';
    if(coachFace) coachFace.textContent='🤔';
    if(detail) detail.classList.remove('show');
    closeAgvMission();
    grid.innerHTML = '<div class="empty-state">🔌 เชื่อมต่อหุ่นยนต์เพื่อเริ่มภารกิจ</div>';
    return;
  }

  const scanned = Array.isArray(project.capabilities) ? project.capabilities : [];
  const byId = Object.fromEntries(scanned.map(capability=>[capability.id,capability]));
  const capabilities = AGV_WIZARD_ORDER.map(id=>byId[id]||{id,detected:false,count:0,files:[]});
  agvCapabilityState = Object.fromEntries(capabilities.map(capability=>[capability.id,capability]));
  const found = capabilities.filter(capability => capability.detected).length;
  const packageText = `${project.packageCount || 0} แพ็กเกจ`;
  const fileText = `${project.fileCount || 0} ไฟล์โปรแกรม`;
  const languageText = project.languages?.length ? project.languages.join(' + ') : 'ไม่พบภาษาโปรแกรม';
  const percent = Math.round(found/capabilities.length*100);
  title.textContent = found === capabilities.length ? 'เยี่ยมมาก! หุ่นยนต์พร้อมออกเดินทางแล้ว' : `ผ่านแล้ว ${found} จาก ${capabilities.length} ด่าน`;
  meta.textContent = `${packageText} · ${fileText} · ${languageText}`;
  const nextMissing = capabilities.find(capability=>!capability.detected);
  note.textContent = project.truncated
    ? 'โปรเจกต์มีขนาดใหญ่ ผลลัพธ์นี้มาจากไฟล์ส่วนแรกที่สแกนได้'
    : nextMissing ? `ด่านต่อไปคือ “${getAgvCapabilityMeta(nextMissing.id).name}” ลองเลือกการ์ดเพื่อดูคำใบ้ได้เลย` : 'ครบทั้ง 7 ด่านแล้ว! ถึงเวลาทดสอบหุ่นยนต์ทั้งระบบ 🎉';
  if(progress) progress.style.width=`${percent}%`;
  if(progressBar) progressBar.setAttribute('aria-valuenow',String(percent));
  if(progressPercent) progressPercent.textContent=`${percent}%`;
  if(missionCount) missionCount.textContent=`${found} / ${capabilities.length} สำเร็จ`;
  if(coachFace) coachFace.textContent=found===capabilities.length?'🥳':found>=4?'😎':found>0?'😊':'🧑‍🚀';

  if (!capabilities.length) {
    grid.innerHTML = '<div class="empty-state">ไม่พบ source code ในโฟลเดอร์ src</div>';
    return;
  }
  grid.innerHTML = capabilities.map((capability,index) => {
    const info = getAgvCapabilityMeta(capability.id);
    const files = Array.isArray(capability.files) ? capability.files : [];
    const evidenceCount = Number.isFinite(Number(capability.count)) ? Math.max(0, Math.floor(Number(capability.count))) : files.length;
    const isNext = nextMissing?.id === capability.id;
    const cardStatus = capability.detected ? 'ผ่านด่านแล้ว' : isNext ? 'ภารกิจถัดไป' : 'รอทำภารกิจ';
    const evidence = capability.mapCheck
      ? `<div>${capability.detected ? '🗺️' : '💡'} ${escH(capability.validationMessage || 'เปิด Map Editor เพื่อสร้าง map.json')}</div>`
      : files.length ? `<div title="${files.map(escH).join(' · ')}">🔎 พบหลักฐาน ${evidenceCount} จุด</div>` : '<div>💡 เลือกเพื่อดูคำใบ้</div>';
    return `<div class="capability-card agv-step-card${capability.detected ? ' detected' : ''}${isNext?' next-mission':''}${selectedAgvStep===capability.id?' selected':''}" data-agv-step="${capability.id}" role="button" tabindex="0" onclick="activateAgvWizardStep('${capability.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();activateAgvWizardStep('${capability.id}')}" aria-label="ด่าน ${index+1} ${escH(info.name)} ${cardStatus}">
      <div class="capability-top">
        <div class="agv-step-number">${capability.detected?'✓':index+1}</div>
        <div class="capability-icon">${escH(info.icon)}</div>
        <div class="capability-name">${escH(info.name)}<div style="font:500 9px var(--mono);color:var(--dim);margin-top:3px">${escH(info.tech||'')}</div></div>
      </div>
      <div class="agv-card-status">${cardStatus}</div>
      <div class="capability-desc">${escH(info.desc)}</div>
      <div class="capability-files">${evidence}</div>
      <div class="capability-badge">${capability.detected ? '⭐ สำเร็จ' : isNext ? 'เริ่มด่านนี้' : 'ยังไม่ผ่าน'}</div>
    </div>`;
  }).join('');
}

let agvMissionTrigger = null;

function activateAgvWizardStep(id) {
  openAgvWizardStep(id);
}

function openAgvWizardStep(id) {
  if(!AGV_WIZARD_ORDER.includes(id)) return;
  selectedAgvStep=id;
  const capability=agvCapabilityState[id]||{id,detected:false,count:0,files:[]};
  const info=getAgvCapabilityMeta(id);
  document.querySelectorAll('.agv-step-card').forEach(card=>card.classList.toggle('selected',card.dataset.agvStep===id));
  const detail=document.getElementById('agv-wizard-detail');
  const modal=document.getElementById('agv-mission-modal');
  if(!detail||!modal) return;
  agvMissionTrigger = document.activeElement;
  const files=Array.isArray(capability.files)?capability.files:[];
  const explanation = Array.isArray(info.explanation) && info.explanation.length
    ? `<div class="agv-explanation-grid">${info.explanation.map(item=>`<div class="agv-explanation-card"><span>${escH(item.icon)}</span><div><strong>${escH(item.title)}</strong><p>${escH(item.text)}</p></div></div>`).join('')}</div>`
    : '';
  const action = info.page
    ? `<button type="button" class="agv-action-btn" onclick="goToAgvTool('${id}')"><span class="agv-action-icon">🧩</span><span class="agv-action-copy"><small>เปิดเครื่องมือประจำด่าน</small><strong>${escH(info.action)}</strong></span><span class="agv-action-arrow">→</span></button>`
    : '<button type="button" class="agv-action-btn pending" disabled><span class="agv-action-icon">🛠️</span><span class="agv-action-copy"><small>เครื่องมือประจำด่าน</small><strong>กำลังเตรียมพร้อม</strong></span><span class="agv-action-arrow">•</span></button>';
  detail.innerHTML=`<div class="agv-detail-head"><div><div class="agv-detail-status${capability.detected?' done':''}">${capability.detected?'✓ ผ่านภารกิจแล้ว':'★ เป้าหมายของด่านนี้'}</div><div class="agv-detail-title">${escH(info.icon)} ${escH(info.name)} <span style="color:var(--dim);font:500 11px var(--mono)">· ${escH(info.tech||'')}</span></div><div class="agv-detail-text">${escH(info.desc)}</div></div>${action}</div>${explanation}<ul class="agv-detail-list">${info.requirements.map(item=>`<li>${escH(item)}</li>`).join('')}</ul><div class="agv-evidence">${capability.mapCheck?`${capability.detected?'🗺️':'💡'} ${escH(capability.validationMessage||'เปิด Map Editor เพื่อสร้าง map.json')}`:files.length?`🔎 สิ่งที่ระบบค้นพบ: ${files.map(escH).join(' · ')}`:'💡 ยังไม่พบหลักฐานในโปรเจกต์ ลองทำตามรายการด้านบนทีละข้อ'}</div>`;
  detail.classList.add('show');
  modal.classList.remove('hidden');
  requestAnimationFrame(()=>modal.classList.add('open'));
  document.getElementById('agv-mission-close')?.focus();
}

function closeAgvMission() {
  const modal=document.getElementById('agv-mission-modal');
  if(!modal||modal.classList.contains('hidden')) return;
  modal.classList.remove('open');
  modal.classList.add('hidden');
  if(agvMissionTrigger?.focus) agvMissionTrigger.focus();
  agvMissionTrigger=null;
}

function goToAgvTool(id) {
  const info=getAgvCapabilityMeta(id);
  if(!info?.page) return;
  closeAgvMission();
  window.switchPage(info.page);
  if(info.page==='transformation'&&typeof initTransformation==='function') initTransformation();
  if(info.page==='map'&&typeof initMapEditor==='function') setTimeout(()=>initMapEditor(),120);
  if(id==='odom'&&typeof tfOpenOdom==='function') setTimeout(()=>tfOpenOdom(),180);
}

document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!document.getElementById('agv-mission-modal')?.classList.contains('hidden')) closeAgvMission();
});

function inspectNode(name) {
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
  switchPage('terminal');
  setTimeout(() => termWs.send(JSON.stringify({ type: 'data', data: `ros2 node info ${name}\n` })), 100);
}

// ══ KILL NODE by ROS node name (ros2 node kill) ══
// ฆ่า node ที่เลือกด้วยชื่อ (ทำงานใน ROS_DOMAIN_ID ของ sim นี้ → ถูกตัว ไม่ไปฆ่า sim อื่น)
async function killNode(name) {
  if (!confirm(`Kill node ${name} ใช่หรือไม่?`)) return;
  if (typeof sbMsg === 'function') sbMsg(`Killing ${name}...`);
  const src = (typeof rosInfo !== 'undefined' && rosInfo?.setupBash) || '/opt/ros/humble/setup.bash';
  try {
    await API('/api/exec', {
      sessionId,
      command: `bash -lc "source ${src} 2>/dev/null; ros2 daemon start 2>/dev/null; ros2 node kill ${name} 2>&1; true"`,
      timeout: 6000
    }).catch(() => {});
    // ตรวจสอบว่า node หายไปจริง
    const v = await API('/api/exec', {
      sessionId,
      command: `bash -lc "source ${src} 2>/dev/null; ros2 node list 2>/dev/null | grep -c '${name}'"`,
      timeout: 6000
    }).catch(() => ({ ok: false }));
    if (v.ok && parseInt((v.stdout || '').trim()) > 0) {
      if (typeof sbMsg === 'function') sbMsg(`⚠ ไม่สามารถฆ่า ${name} ได้ ลอง Kill PID ด้านล่าง`, 4000);
    } else if (typeof sbMsg === 'function') {
      sbMsg(`✅ Killed ${name}`, 2000);
    }
  } catch (e) {
    if (typeof sbMsg === 'function') sbMsg(`Error: ${e.message}`, 3000);
  }
  setTimeout(() => loadDashboard(), 1000);
}

// ══ Auto-refresh dashboard (ให้เห็น node ที่กำลังรันแบบ live) ══
function startDashAutoRefresh() {
  if (!sessionId) return;
  if (!dashInterval) dashInterval = setInterval(loadDashboard, 5000);
  loadDashboard();
}
function stopDashAutoRefresh() {
  if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
}
window.startDashAutoRefresh = startDashAutoRefresh;
window.stopDashAutoRefresh = stopDashAutoRefresh;

// ══ KILL BY PID (ชัวร์ 100%) ══
async function killPID(pid) {
  if (!confirm(`ต้องการบังคับปิด Process (PID: ${pid}) ถาวรใช่หรือไม่?`)) return;
  
  const btn = document.getElementById('btn-refresh-status');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin-icon">↻</span> Killing...'; }

  try {
    // ฆ่าด้วย PID แบบไม่ต้องสนใจว่าชื่อ Node คืออะไร
    await API('/api/exec', { sessionId, command: `kill -9 ${pid} 2>/dev/null`, timeout: 3000 });
    if (typeof sbMsg === 'function') sbMsg(`Killed PID ${pid} สำเร็จ ☠️`, 2000);
    
    // เคลียร์ ROS2 Daemon เพื่อให้กราฟด้านล่างอัปเดตเร็วขึ้น
    await API('/api/exec', { sessionId, command: `ros2 daemon stop`, timeout: 3000 }).catch(()=>{});
  } catch (e) {
    if (typeof sbMsg === 'function') sbMsg(`Error killing PID: ${e.message}`, 3000);
  }

  setTimeout(() => loadDashboard(), 1200);
}

// ══ TOPICS (sidebar) ══
async function loadTopics() {
  if (!sessionId || !rosInfo) return;
  const res = await API('/api/exec', { sessionId, command: `bash -lc "source ${rosInfo.setupBash} 2>/dev/null && ros2 topic list -t 2>/dev/null"`, timeout: 8000 });
  const el = document.getElementById('topic-list');
  if (!res.ok || !res.stdout.trim()) {
    el.innerHTML = '<div class="ti" style="color:var(--dim);font-size:11px;padding-left:14px">ไม่พบ topics</div>';
    return;
  }
  const topics = res.stdout.trim().split('\n').filter(Boolean).map(line => {
    const m = line.match(/^(\S+)\s+\[(.+)\]$/);
    return m ? { name: m[1], type: m[2] } : { name: line.trim(), type: '' };
  });
  el.innerHTML = topics.slice(0, 15).map(t => `<div class="tr" onclick="echoTopic(decodeURIComponent('${encArg(t.name)}'))"><span class="td"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(t.name)}</span><span class="hz">echo</span></div>`).join('');
}

function echoTopic(t) {
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
  switchPage('terminal');
  setTimeout(() => termWs.send(JSON.stringify({ type: 'data', data: `ros2 topic echo ${t} --once\n` })), 100);
}

// ══ ACTIONS ══
// NOTE: quickBuild / sourceSetup ถูกย้ายไปจัดการที่ app.js (ซึ่งสร้างแท็บเฉพาะแยกจาก run ros)
// โค้ดเก่าในนี้ส่งคำสั่งผ่าน termWs ของแท็บที่ active อยู่ → build ทับแท็บที่รัน ros อยู่ จึงลบออก
