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
  // ค่าจาก connection เป็นข้อมูลหลัก: หุ่นยนต์จริงต้องไม่ถูกตีความเป็น Sim
  // แม้ workspace จะมีแพ็กเกจจำลองหลงเหลืออยู่ก็ตาม
  isSimWorkspace = typeof d.isSim === 'boolean' ? d.isSim : simFromProject;
  localStorage.setItem('ros2ide_is_sim', String(isSimWorkspace));
  if(typeof applySimulationVisibility === 'function') applySimulationVisibility();
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
  hardware:   { icon:'🔌', name:'ออกแบบและเชื่อมฮาร์ดแวร์', tech:'Hardware Builder', desc:'อ่านฐานล้อและมิติจาก Robot Model/ODOM แล้วเลือกบอร์ด MCU, driver และอุปกรณ์จริงให้ตรงกับแบบ', requirements:['บันทึก Robot Model, TF และ ODOM ให้เรียบร้อย','ตรวจ wiring diagram ของ STM32F103C8T6 ที่สร้างจากแบบ','สร้าง config และ firmware template ลง workspace'], page:null, hardwareBuilder:true, action:'เปิด Hardware Builder' },
  pid:        { icon:'🎛️', name:'จูนระบบหุ่นยนต์', tech:'Wheel PID Tuning', desc:'เชื่อมต่อ Controller ตรวจ Serial protocol จริง จูน PID แยกล้อ และทดสอบเดินหน้าอย่างปลอดภัย', requirements:['เลือก COM port และต้องได้รับ RPM/ODOM/PID จากบอร์ดตาม protocol','จูน Kp, Ki และ Kd แยกล้อซ้าย/ขวา','ทดสอบเดินหน้าแบบกดค้าง แล้วบันทึกค่าลง ROS bridge'], page:null, robotTune:true, action:'เปิดหน้าจูนหุ่นยนต์' },
  custom_package:{ icon:'🐍', name:'สร้างโปรแกรมหุ่นยนต์', tech:'Custom Python Package', desc:'ประกอบ ROS 2 node ด้วยบล็อก แล้วใส่ Python Code Block สำหรับตรรกะเฉพาะของหุ่นยนต์', requirements:['สร้าง ament_python package และ executable','เพิ่ม Python Code Block อย่างน้อยหนึ่งบล็อก','Generate, Save & Build จน package ทำงานได้'], page:'flow', action:'เปิด Flow Editor' },
  urdf:       { icon:'🤖', name:'ประกอบหุ่น', tech:'Robot Model · TF · Odometry', desc:'ประกอบตัวรถ ล้อ และเซนเซอร์ พร้อมกำหนดความสัมพันธ์ของชิ้นส่วนและระบบคำนวณตำแหน่งจากล้อให้ครบในขั้นตอนเดียว', requirements:['สร้างและบันทึก Robot Model พร้อมล้อและเซนเซอร์','กำหนด TF ให้ทุกชิ้นส่วนเชื่อมต่อกันตั้งแต่ฐานหุ่นถึงเซนเซอร์','ตั้งค่า ODOM จาก Encoder ให้ส่ง /odom และ odom → base_link ได้ถูกต้อง'], explanation:[{icon:'🧱',title:'ประกอบอะไร',text:'กำหนดรูปร่าง ฐานรถ ล้อ Encoder และเซนเซอร์ให้ตรงกับหุ่นยนต์จริง'},{icon:'🧭',title:'เชื่อมอย่างไร',text:'ตั้ง parent frame ตำแหน่งและทิศทางของทุกชิ้นส่วน เพื่อให้ TF tree เชื่อมต่อครบ'},{icon:'📍',title:'รู้ตำแหน่งได้อย่างไร',text:'ตั้งค่าล้อและ Encoder สำหรับคำนวณ Odometry ให้หุ่นยนต์รู้ระยะทางและมุมที่เคลื่อนที่'}], page:'transformation', action:'ไปประกอบและตั้งค่าหุ่น' },
  tf:         { icon:'🧭', name:'เชื่อมชิ้นส่วน', tech:'TF / Frames', desc:'บอกหุ่นยนต์ว่าแต่ละชิ้นส่วนอยู่ตรงไหนและหันไปทางใด', requirements:['เชื่อมพิกัด map ไปยัง odom','เชื่อม odom ไปยังฐานหุ่นยนต์','เชื่อมฐานไปยังเซนเซอร์ทุกตัว'], page:'transformation', action:'ไปเชื่อมชิ้นส่วน' },
  control:    { icon:'🎮', name:'ฝึกบังคับหุ่น', tech:'Motion Control', desc:'เปลี่ยนคำสั่งเดินหน้าและเลี้ยวให้เป็นการหมุนของล้อ', requirements:['รับคำสั่งความเร็วจาก /cmd_vel','คำนวณความเร็วของล้อแต่ละข้าง','ส่งคำสั่งไปยังมอเตอร์หรือระบบจำลอง'], page:'playground', playgroundMode:'control', action:'ไปฝึกขับหุ่น', simulationOnly:true },
  odom:       { icon:'📍', name:'จำเส้นทาง', tech:'Odometry', desc:'ช่วยให้หุ่นยนต์รู้ว่าตัวเองเดินไปไกลและหันไปทางไหนแล้ว', requirements:['ส่งตำแหน่งผ่าน /odom','กำหนด odom และ base_link ให้ถูกต้อง','ส่งการเชื่อมต่อ odom → base_link'], page:'transformation', action:'ไปตั้งค่าการเดินทาง' },
  lidar:      { icon:'📡', name:'ติดตั้งและทดสอบ LIDAR', tech:'2D LaserScan', desc:'เลือกรุ่น ติดตั้ง ROS 2 driver ลง workspace และดูข้อมูลสแกนรอบตัวแบบ 2D', requirements:['เลือกยี่ห้อและรุ่นให้ตรงกับอุปกรณ์จริง','ติดตั้ง driver package ลงโฟลเดอร์ src ของ workspace','เปิด driver แล้วตรวจ LaserScan จาก /scan บนกราฟ 2D'], page:'lidar', action:'เปิด LIDAR Setup' },
  mapping:    { icon:'🗺️', name:'วาดแผนที่', tech:'Mapping / SLAM', desc:'เปลี่ยนสิ่งที่เซนเซอร์มองเห็นให้กลายเป็นแผนที่', requirements:['เตรียม /scan, /tf และ /odom ให้พร้อม','ใช้ SLAM ช่วยสำรวจพื้นที่','ส่งแผนที่ผ่าน /map'], page:'playground', playgroundMode:'mapping', action:'ไปวาดแผนที่', simulationOnly:true },
  navigation: { icon:'🏁', name:'ออกผจญภัย', tech:'Autonomous Navigation', desc:'ให้หุ่นยนต์คิดเส้นทางและเดินไปถึงเป้าหมายด้วยตัวเอง', requirements:['เตรียม Nav2 และแผนที่','ตรวจ localization และ TF ให้ครบ','ส่งเป้าหมายแล้วทดสอบการหลบสิ่งกีดขวาง'], page:'playground', playgroundMode:'navigation', action:'ไปออกผจญภัย', simulationOnly:true },
  imu:        { icon:'🧭', name:'รับรู้การเอียงและหมุน', tech:'IMU', desc:'อ่านความเร่งและอัตราการหมุนเพื่อช่วยให้ตำแหน่งของหุ่นยนต์นิ่งขึ้น', requirements:['ส่ง sensor_msgs/Imu ผ่าน /imu','กำหนด frame และ covariance ให้ถูกต้อง','ตรวจทิศแกนและกรอง bias/noise'], page:null, action:'ตรวจหลักฐานใน workspace' },
  camera:     { icon:'📷', name:'ติดตั้งกล้อง', tech:'Camera (เสริม)', desc:'เพิ่มภาพและ CameraInfo สำหรับงานมองเห็น ตรวจสอบ หรือควบคุมระยะไกล', requirements:['ส่ง Image และ CameraInfo','ตั้ง frame และ calibration ของกล้อง','ตรวจอัตราเฟรมและ latency'], page:null, action:'ตรวจหลักฐานใน workspace' },
  diagnostics:{ icon:'🩺', name:'ตรวจสุขภาพระบบ', tech:'Diagnostics', desc:'รายงานแบตเตอรี่ มอเตอร์ เซนเซอร์ และการสื่อสารก่อนปัญหาจะทำให้หุ่นหยุด', requirements:['ส่ง diagnostic_msgs หรือใช้ diagnostic_updater','กำหนดระดับ OK/WARN/ERROR','ตรวจ timeout อุณหภูมิ แบตเตอรี่ และการเชื่อมต่อ'], page:null, action:'ตรวจหลักฐานใน workspace' },
  calibration:{ icon:'🎯', name:'ปรับเทียบเซนเซอร์', tech:'Calibration', desc:'ปรับค่ากล้อง IMU ล้อ และตำแหน่งเซนเซอร์ให้ข้อมูลตรงกับโลกจริง', requirements:['มีไฟล์หรือโหนด calibration','ตรวจ wheel radius และ wheel separation','บันทึกค่า offset/covariance ที่ทดสอบแล้ว'], page:null, action:'ตรวจหลักฐานใน workspace' },
  localization:{ icon:'📌', name:'ระบุตำแหน่ง', tech:'Localization', desc:'รวม odometry, IMU และแผนที่เพื่อให้หุ่นรู้ตำแหน่งอย่างต่อเนื่อง', requirements:['ตั้ง EKF/UKF หรือ AMCL','ตรวจ map → odom → base_link','ทดสอบ recovery เมื่อค่าตำแหน่งคลาดเคลื่อน'], page:null, action:'ตรวจหลักฐานใน workspace' },
  perception: { icon:'👁️', name:'การมองเห็นและตรวจจับ', tech:'Perception (เสริม)', desc:'แปลงภาพหรือ point cloud เป็นวัตถุ บุคคล ป้าย หรือพื้นที่ที่หุ่นเข้าใจได้', requirements:['มี pipeline Image/PointCloud2','เผยแพร่ผลตรวจจับพร้อม frame และเวลา','กำหนด confidence และพฤติกรรมเมื่อไม่พบวัตถุ'], page:null, action:'ตรวจหลักฐานใน workspace' },
  manipulation:{ icon:'🦾', name:'ควบคุมแขนกล', tech:'Manipulation (เสริม)', desc:'วางแผนและควบคุมแขน ข้อต่อ หรือ gripper สำหรับหยิบจับชิ้นงาน', requirements:['ตั้ง joint trajectory หรือ MoveIt','กำหนด joint limits และ collision model','มีวิธีหยุดและ recover เมื่อหยิบจับล้มเหลว'], page:null, action:'ตรวจหลักฐานใน workspace' },
  automation: { icon:'🧠', name:'จัดลำดับภารกิจ', tech:'Behavior / Lifecycle', desc:'จัดสถานะและลำดับงานหลายขั้นให้หุ่นทำภารกิจซ้ำได้และฟื้นตัวได้', requirements:['มี task server, behavior tree หรือ state machine','จัด lifecycle/startup ของ node','กำหนด timeout, retry และ safe fallback'], page:null, action:'ตรวจหลักฐานใน workspace' },
  deployment: { icon:'🚀', name:'พร้อมใช้งานหน้างาน', tech:'Deployment', desc:'ทำให้ระบบเริ่มเอง ตรวจสุขภาพ และกู้คืนได้เมื่อเปิดหุ่นยนต์ในสถานที่จริง', requirements:['มี launch สำหรับระบบครบชุด','ตั้ง auto-start/respawn หรือ container','มี health check, log และคู่มือ shutdown ที่ปลอดภัย'], page:null, action:'ตรวจหลักฐานใน workspace' },
};

// Simulation needs a saved field before Motion Control can start MapSim, so
// prepare the LiDAR environment first and only then teach manual driving.
const SIMULATION_WIZARD_ORDER = ['urdf','lidar','control','mapping','navigation'];
// Real navigation commissioning order: design first, then hardware/PID,
// motion and sensors, state estimation, mapping, and finally Nav2.
const REAL_ROBOT_WIZARD_ORDER = ['urdf','lidar','hardware','pid','control','mapping','navigation'];
const REAL_ROBOT_OPTIONAL_ORDER = [];
function getActiveWizardOrder(){ return isSimWorkspace ? SIMULATION_WIZARD_ORDER : REAL_ROBOT_WIZARD_ORDER; }
function getOptionalWizardOrder(){ return isSimWorkspace ? [] : REAL_ROBOT_OPTIONAL_ORDER; }
let agvCapabilityState = {};
let selectedAgvStep = null;

function applyAgvWizardDependencies(capabilities, simulationEnabled = isSimWorkspace) {
  if (!simulationEnabled) {
    const designReady=['urdf','lidar'].every(id=>capabilities.find(item=>item.id===id)?.detected===true);
    const hardware=capabilities.find(capability=>capability.id==='hardware');
    if(hardware&&!designReady){
      hardware.sourceDetected=hardware.detected===true;
      hardware.detected=false;
      hardware.dependencyBlocked=true;
      hardware.dependencyMessage='ทำ Robot Model, TF, ODOM และติดตั้ง LIDAR ให้สำเร็จก่อน ระบบจึงจะอ่านแบบและสร้าง wiring ได้';
    }
    const block=(id,requirements,message)=>{
      const capability=capabilities.find(item=>item.id===id);if(!capability)return;
      if(requirements.some(required=>capabilities.find(item=>item.id===required)?.detected!==true)){
        capability.sourceDetected=capability.detected===true;
        capability.detected=false;
        capability.dependencyBlocked=true;
        capability.dependencyMessage=message;
      }
    };
    const pid=capabilities.find(capability=>capability.id==='pid');
    if(pid&&pid.tuneVerified!==true){pid.sourceDetected=pid.detected===true;pid.detected=false;pid.resultCheck=true;pid.validationMessage='ยังไม่ได้เชื่อมต่อและยืนยัน Serial protocol จากบอร์ดในหน้าจูนหุ่นยนต์';}
    const mapping=capabilities.find(capability=>capability.id==='mapping');
    if(mapping&&mapping.mappingVerified!==true){mapping.sourceDetected=mapping.detected===true;mapping.detected=false;mapping.resultCheck=true;mapping.validationMessage='ยังไม่ได้บันทึกแผนที่จริงเป็น PGM + YAML ในหน้าเก็บแผนที่ SLAM';}
    block('lidar',['urdf'],'ประกอบหุ่นและตั้งค่า Robot Model, TF และ ODOM ให้ครบก่อนติดตั้งและทดสอบ LIDAR');
    block('pid',['hardware'],'สร้าง Firmware และเชื่อมต่อ Hardware ให้เสร็จก่อนเริ่มจูนค่า PID ของมอเตอร์');
    block('custom_package',['hardware'],'สร้าง Hardware config ให้เสร็จก่อนสร้าง Custom Python Package สำหรับหุ่นยนต์');
    block('control',['hardware','pid'],'เชื่อมต่อ Hardware และจูนค่า PID หรือทดสอบโหมด Open-loop ให้ผ่านก่อนเปิดหน้าฝึกบังคับหุ่น');
    block('mapping',['control','lidar'],'เตรียม Motion Control และ LiDAR ให้พร้อมก่อนสร้างแผนที่');
    block('navigation',['pid','mapping'],'ต้องทดสอบโหมดควบคุมมอเตอร์และสร้างแผนที่ก่อนเริ่ม Autonomous Navigation');
    return capabilities;
  }
  const lidar = capabilities.find(capability=>capability.id==='lidar');
  const control = capabilities.find(capability=>capability.id==='control');
  for(const id of ['mapping','navigation']) {
    const capability=capabilities.find(item=>item.id===id);
    if(!capability)continue;
    const verifiedAction=capability.wizardActionCheck===true&&capability.progressVersion===2&&capability.mapFolderExists===true;
    if(!verifiedAction) {
      capability.sourceDetected=capability.detected===true;
      capability.detected=false;
      capability.resultCheck=true;
      capability.validationMessage=id==='mapping'
        ? 'ยังไม่ผ่าน — ต้องกด Save Map ใน Robot Playground และต้องมีโฟลเดอร์ maps/<ชื่อแผนที่>'
        : 'ยังไม่ผ่าน — ต้อง Save Map ก่อน แล้วเข้าโหมด Navigation และกดเริ่ม Navigation';
    }
  }
  if (control && !lidar?.detected) {
    control.sourceDetected = control.detected === true;
    control.detected = false;
    control.dependencyBlocked = true;
    control.dependencyMessage = 'ต้องสร้างและบันทึกสนามให้ LiDAR พร้อมใช้งานก่อน จึงจะผ่านด่านฝึกบังคับหุ่น';
  }
  return capabilities;
}

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
  if (!isSimWorkspace && id === 'control') {
    return {
      ...base,
      requirements: ['เลือก COM port และเชื่อมต่อ Controller', 'บังคับด้วยปุ่มหรือคีย์บอร์ดพร้อมปรับความเร็ว', 'ตรวจตำแหน่ง ODOM และข้อมูล LiDAR แบบสดในหน้าเดียว'],
      page: null,
      action: 'เปิดหน้าฝึกบังคับหุ่น',
      simulationOnly: false,
      realTeleop: true,
    };
  }
  if (!isSimWorkspace && id === 'mapping') {
    return {
      ...base,
      desc: 'ขับหุ่นยนต์จริงเพื่อให้ SLAM สะสมแผนที่จาก LiDAR และ ODOM แล้วบันทึกเป็น PGM + YAML',
      requirements: ['เปิด Controller, LiDAR และ SLAM Toolbox', 'ปรับความเร็วแล้วขับสำรวจ พร้อมเลือกเปิด/ปิดชั้นข้อมูล', 'ตรวจ /map, /scan และ /odom แล้วบันทึกแผนที่'],
      page: null,
      action: 'เปิดหน้าเก็บแผนที่ SLAM',
      simulationOnly: false,
      realMapping: true,
    };
  }
  if (!isSimWorkspace && id === 'navigation') {
    return {
      ...base,
      desc: 'ใช้ Saved Map จากหน้า Mapping เพื่อระบุตำแหน่ง วางแผนเส้นทาง และสั่งหุ่นยนต์จริงไปยังจุดหมายด้วย Nav2',
      requirements: ['เลือก Saved Map, Controller และ LiDAR ชุดเดิม', 'ตั้ง Initial Pose ให้ตรงกับตำแหน่งจริงของหุ่น', 'คลิก Goal แล้วตรวจ Path, AMCL และสถานะ NavigateToPose'],
      page: null,
      action: 'เปิดหน้าทดสอบ Nav2',
      simulationOnly: false,
      realNavigation: true,
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
  const requiredOrder = getActiveWizardOrder();
  const optionalOrder = getOptionalWizardOrder();
  if (!grid || !title || !meta || !note) return;

  if (!project || project.ok === false) {
    title.textContent = 'ยังเปิดแผนที่ภารกิจไม่ได้';
    meta.textContent = project?.error || 'ยังไม่มีข้อมูลจาก workspace';
    note.textContent = 'ลองเชื่อมต่อหุ่นยนต์ แล้วกด “เช็กภารกิจของฉัน” อีกครั้งนะ';
    if(progress) progress.style.width='0%';
    if(progressBar) progressBar.setAttribute('aria-valuenow','0');
    if(progressPercent) progressPercent.textContent='0%';
    if(missionCount) missionCount.textContent=`0 / ${requiredOrder.length} สำเร็จ`;
    if(coachFace) coachFace.textContent='🤔';
    if(detail) detail.classList.remove('show');
    closeAgvMission();
    grid.innerHTML = '<div class="empty-state">🔌 เชื่อมต่อหุ่นยนต์เพื่อเริ่มภารกิจ</div>';
    return;
  }

  const scanned = Array.isArray(project.capabilities) ? project.capabilities : [];
  const byId = Object.fromEntries(scanned.map(capability=>[capability.id,capability]));
  const assemblyParts=['urdf','tf','odom'].map(id=>byId[id]||{id,detected:false,count:0,files:[]});
  byId.urdf={
    ...assemblyParts[0],
    id:'urdf',
    detected:assemblyParts.every(part=>part.detected===true),
    count:assemblyParts.reduce((sum,part)=>sum+(Number(part.count)||0),0),
    files:[...new Set(assemblyParts.flatMap(part=>Array.isArray(part.files)?part.files:[]))],
    assemblyParts:Object.fromEntries(assemblyParts.map(part=>[part.id,part.detected===true])),
  };
  const capabilities = applyAgvWizardDependencies(
    [...requiredOrder,...optionalOrder].map(id=>({ ...(byId[id]||{id,detected:false,count:0,files:[]}),optional:optionalOrder.includes(id) }))
  );
  agvCapabilityState = Object.fromEntries(capabilities.map(capability=>[capability.id,capability]));
  const requiredCapabilities = capabilities.filter(capability=>!capability.optional);
  const found = requiredCapabilities.filter(capability => capability.detected).length;
  const optionalFound = capabilities.filter(capability=>capability.optional&&capability.detected).length;
  const packageText = `${project.packageCount || 0} แพ็กเกจ`;
  const fileText = `${project.fileCount || 0} ไฟล์โปรแกรม`;
  const languageText = project.languages?.length ? project.languages.join(' + ') : 'ไม่พบภาษาโปรแกรม';
  const percent = Math.round(found/requiredCapabilities.length*100);
  title.textContent = found === requiredCapabilities.length ? 'เยี่ยมมาก! หุ่นยนต์พร้อมออกเดินทางแล้ว' : `ผ่านแล้ว ${found} จาก ${requiredCapabilities.length} ด่าน`;
  meta.textContent = `${packageText} · ${fileText} · ${languageText}`;
  const nextMissing = requiredCapabilities.find(capability=>!capability.detected);
  note.textContent = project.truncated
    ? 'โปรเจกต์มีขนาดใหญ่ ผลลัพธ์นี้มาจากไฟล์ส่วนแรกที่สแกนได้'
    : nextMissing ? `ด่านต่อไปคือ “${getAgvCapabilityMeta(nextMissing.id).name}” ลองเลือกการ์ดเพื่อดูคำใบ้ได้เลย` : `ครบทั้ง ${requiredCapabilities.length} ด่านแล้ว! ถึงเวลาทดสอบหุ่นยนต์ทั้งระบบ 🎉`;
  if(progress) progress.style.width=`${percent}%`;
  if(progressBar) progressBar.setAttribute('aria-valuenow',String(percent));
  if(progressPercent) progressPercent.textContent=`${percent}%`;
  if(missionCount) missionCount.textContent=`${found} / ${requiredCapabilities.length} สำเร็จ${optionalOrder.length?` · เสริม ${optionalFound}/${optionalOrder.length}`:''}`;
  if(coachFace) coachFace.textContent=found===requiredCapabilities.length?'🥳':found>=Math.ceil(requiredCapabilities.length/2)?'😎':found>0?'😊':'🧑‍🚀';

  if (!capabilities.length) {
    grid.innerHTML = '<div class="empty-state">ไม่พบ source code ในโฟลเดอร์ src</div>';
    return;
  }
  grid.innerHTML = capabilities.map((capability,index) => {
    const info = getAgvCapabilityMeta(capability.id);
    const files = Array.isArray(capability.files) ? capability.files : [];
    const evidenceCount = Number.isFinite(Number(capability.count)) ? Math.max(0, Math.floor(Number(capability.count))) : files.length;
    const isNext = nextMissing?.id === capability.id;
    const cardStatus = capability.detected ? 'ผ่านด่านแล้ว' : capability.optional ? 'ภารกิจเสริม' : capability.dependencyBlocked ? 'รอขั้นตอนก่อนหน้า' : isNext ? 'ภารกิจถัดไป' : 'รอทำภารกิจ';
    const evidence = capability.dependencyBlocked
      ? `<div>🔒 ${escH(capability.dependencyMessage)}</div>`
      : (capability.mapCheck || capability.resultCheck) && (isSimWorkspace || capability.id==='pid')
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
      <div class="capability-badge">${capability.detected ? '⭐ สำเร็จ' : capability.optional ? '➕ ไม่บังคับ' : capability.dependencyBlocked ? '🔒 ทำด่านก่อนหน้า' : isNext ? 'เริ่มด่านนี้' : 'ยังไม่ผ่าน'}</div>
    </div>`;
  }).join('');
}

let agvMissionTrigger = null;

function activateAgvWizardStep(id) {
  openAgvWizardStep(id);
}

function openAgvWizardStep(id) {
  if(![...getActiveWizardOrder(),...getOptionalWizardOrder()].includes(id)) return;
  selectedAgvStep=id;
  const capability=agvCapabilityState[id]||{id,detected:false,count:0,files:[]};
  const info=getAgvCapabilityMeta(id);
  document.querySelectorAll('.agv-step-card').forEach(card=>card.classList.toggle('selected',card.dataset.agvStep===id));
  const detail=document.getElementById('agv-wizard-detail');
  const modal=document.getElementById('agv-mission-modal');
  if(!detail||!modal) return;
  agvMissionTrigger = document.activeElement;
  const files=Array.isArray(capability.files)?capability.files:[];
  const dependencyBlocked=capability.dependencyBlocked===true;
  const explanation = Array.isArray(info.explanation) && info.explanation.length
    ? `<div class="agv-explanation-grid">${info.explanation.map(item=>`<div class="agv-explanation-card"><span>${escH(item.icon)}</span><div><strong>${escH(item.title)}</strong><p>${escH(item.text)}</p></div></div>`).join('')}</div>`
    : '';
  const action = dependencyBlocked
    ? '<button type="button" class="agv-action-btn pending" disabled><span class="agv-action-icon">🔒</span><span class="agv-action-copy"><small>ทำขั้นตอนก่อนหน้าให้เสร็จก่อน</small><strong>ยังเปิดเครื่องมือนี้ไม่ได้</strong></span><span class="agv-action-arrow">•</span></button>'
    : info.simulationOnly && !isSimWorkspace
    ? ''
    : info.page || info.realTeleop || info.realMapping || info.realNavigation || info.hardwareBuilder || info.robotTune
    ? `<button type="button" class="agv-action-btn" onclick="goToAgvTool('${id}')"><span class="agv-action-icon">${info.realTeleop?'🎮':info.realMapping?'🗺️':info.realNavigation?'🏁':info.hardwareBuilder?'🔌':info.robotTune?'🎛️':'🧩'}</span><span class="agv-action-copy"><small>${info.realTeleop?'ควบคุมหุ่นยนต์จริง':info.realMapping?'เก็บแผนที่จากหุ่นยนต์จริง':info.realNavigation?'นำทางบน Saved Map':info.hardwareBuilder?'ออกแบบก่อนเขียนโค้ด':info.robotTune?'จูนจากข้อมูลบอร์ดจริง':'เปิดเครื่องมือประจำด่าน'}</small><strong>${escH(info.action)}</strong></span><span class="agv-action-arrow">→</span></button>`
    : '<button type="button" class="agv-action-btn pending" disabled><span class="agv-action-icon">🛠️</span><span class="agv-action-copy"><small>เครื่องมือประจำด่าน</small><strong>กำลังเตรียมพร้อม</strong></span><span class="agv-action-arrow">•</span></button>';
  detail.innerHTML=`<div class="agv-detail-head"><div><div class="agv-detail-status${capability.detected?' done':''}">${capability.detected?'✓ ผ่านภารกิจแล้ว':dependencyBlocked?'🔒 รอขั้นตอนก่อนหน้า':'★ เป้าหมายของด่านนี้'}</div><div class="agv-detail-title">${escH(info.icon)} ${escH(info.name)} <span style="color:var(--dim);font:500 11px var(--mono)">· ${escH(info.tech||'')}</span></div><div class="agv-detail-text">${escH(info.desc)}</div></div>${action}</div>${explanation}<ul class="agv-detail-list">${info.requirements.map(item=>`<li>${escH(item)}</li>`).join('')}</ul><div class="agv-evidence">${dependencyBlocked?`🔒 ${escH(capability.dependencyMessage)}`:(capability.mapCheck||capability.resultCheck)&&(isSimWorkspace||capability.id==='pid')?`${capability.detected?'✓':'💡'} ${escH(capability.validationMessage||'ยังไม่พบไฟล์ผลลัพธ์ของภารกิจ')}`:files.length?`🔎 สิ่งที่ระบบค้นพบ: ${files.map(escH).join(' · ')}`:'💡 ยังไม่พบหลักฐานในโปรเจกต์ ลองทำตามรายการด้านบนทีละข้อ'}</div>`;
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

async function goToAgvTool(id) {
  const info=getAgvCapabilityMeta(id);
  if(info?.hardwareBuilder && !isSimWorkspace){
    closeAgvMission();
    window.location.assign('/hardware');
    return;
  }
  if(info?.robotTune && !isSimWorkspace){
    closeAgvMission();
    window.location.assign('/tune');
    return;
  }
  if(info?.realTeleop && !isSimWorkspace){
    closeAgvMission();
    openRealRobotTeleop();
    return;
  }
  if(info?.realMapping && !isSimWorkspace){
    closeAgvMission();
    window.location.assign('/mapping');
    return;
  }
  if(info?.realNavigation && !isSimWorkspace){
    closeAgvMission();
    window.location.assign('/navigation');
    return;
  }
  if(id==='lidar'&&!isSimWorkspace){
    closeAgvMission();
    window.switchPage('lidar');
    if(typeof initLidarSetup==='function')setTimeout(()=>initLidarSetup(),60);
    return;
  }
  if(!info?.page || (info.simulationOnly && !isSimWorkspace)) return;
  closeAgvMission();
  if(info.page==='playground'&&typeof playgroundOpenMode==='function'){
    playgroundOpenMode(info.playgroundMode);
    return;
  }
  window.switchPage(info.page);
  if(info.page==='transformation'&&typeof initTransformation==='function')initTransformation();
  if(info.page==='map'&&typeof initMapEditor==='function') setTimeout(()=>initMapEditor(),120);
  if(id==='odom'&&typeof tfOpenOdom==='function') setTimeout(()=>tfOpenOdom(),180);
}

const HARDWARE_DRIVES={
  diff2:{name:'2WD Differential',motors:2,kinematics:'differential',driverBoards:1,icon:'🛞'},
  diff4:{name:'4WD Differential',motors:4,kinematics:'differential_4wd',driverBoards:2,icon:'🚙'},
  mecanum4:{name:'4WD Mecanum',motors:4,kinematics:'mecanum',driverBoards:2,icon:'✣'},
};
const HARDWARE_ACCESSORIES={
  mpu6050:{name:'MPU6050 IMU',connections:[['VCC','3V3'],['GND','GND'],['SCL','PB6'],['SDA','PB7']],color:'#9f7aea'},
  bno055:{name:'BNO055 IMU',connections:[['VIN','3V3'],['GND','GND'],['SCL','PB6'],['SDA','PB7']],color:'#c96ee8'},
  hcsr04:{name:'HC-SR04',connections:[['VCC','5V'],['GND','GND'],['TRIG','PB0'],['ECHO','PB1 via divider']],color:'#38b2ac'},
  servo:{name:'Servo',connections:[['V+','External 5V'],['GND','GND'],['PWM','PB9']],color:'#f5a623'},
  rplidar:{name:'RPLIDAR A1',connections:[['USB','Host computer'],['PORT','/dev/ttyUSB0']],color:'#3ecf8e'},
};
let hardwareStep=0;
let hardwareDrive='diff2';
let hardwareBuilderTrigger=null;
let hardwareRobotDesign=null;

function hardwareStorageKey(){return `roside_hardware_config_${localStorage.getItem('ros2ide_robotid')||'default'}`;}

function hardwareSelectedAccessories(){
  return [...document.querySelectorAll('#hardware-builder-modal .hardware-accessory input:checked')].map(input=>input.value);
}

function hardwareMotorConnections(){
  const driver=document.getElementById('hardware-motor-driver')?.value||'tb6612';
  const pins=[
    ['Motor L / M1',driver==='tb6612'?'AIN1 PB12 · AIN2 PB13 · PWM PA8':'IN1 PB12 · IN2 PB13 · ENA PA8'],
    ['Motor R / M2',driver==='tb6612'?'BIN1 PB14 · BIN2 PB15 · PWM PA9':'IN3 PB14 · IN4 PB15 · ENB PA9'],
    ['Encoder L / M1','A PA0 · B PA1'],['Encoder R / M2','A PA2 · B PA3'],
  ];
  if(HARDWARE_DRIVES[hardwareDrive].motors===4)pins.push(
    ['Motor RL / M3','IN1 PB3 · IN2 PB4 · PWM PA6'],['Motor RR / M4','IN1 PB5 · IN2 PB8 · PWM PA7'],
    ['Encoder RL / M3','A PA4 · B PA5'],['Encoder RR / M4','A PB10 · B PB11']
  );
  pins.push(['Driver power','VM → Motor battery · VCC → 3V3 · GND ร่วม']);
  return pins;
}

function hardwareSelectDrive(id){
  if(!HARDWARE_DRIVES[id])return;
  hardwareDrive=id;
  document.querySelectorAll('#hardware-drive-choices .hardware-choice').forEach(button=>button.classList.toggle('selected',button.dataset.drive===id));
  hardwareRenderWiring();
  hardwareRefreshReview();
}

function hardwareAccessoryChanged(input){
  if(input.checked&&(input.value==='mpu6050'||input.value==='bno055')){
    document.querySelectorAll('#hardware-builder-modal .hardware-accessory input').forEach(other=>{
      if(other!==input&&(other.value==='mpu6050'||other.value==='bno055'))other.checked=false;
    });
  }
  hardwareRenderWiring();
  hardwareRefreshReview();
}

function hardwareRenderWiring(){
  const root=document.getElementById('hardware-wiring-diagram');
  if(!root)return;
  const motor=hardwareMotorConnections();
  const accessories=hardwareSelectedAccessories();
  const deviceRows=[...motor.map((item,index)=>({name:item[0],pins:item[1],color:index<2?'#4f8ef7':'#38b2ac'})),...accessories.map(id=>({name:HARDWARE_ACCESSORIES[id].name,pins:HARDWARE_ACCESSORIES[id].connections.map(pair=>pair.join(' → ')).join(' · '),color:HARDWARE_ACCESSORIES[id].color}))];
  const midpoint=Math.ceil(deviceRows.length/2);
  const renderDevices=items=>`<div class="wiring-devices">${items.map(item=>`<div class="wiring-device" style="--wire:${item.color}"><b>${escH(item.name)}</b><code>${escH(item.pins)}</code></div>`).join('')}</div>`;
  const usedPins=[...new Set(deviceRows.flatMap(item=>(item.pins.match(/P[A-C]\d+/g)||[])))];
  const pinLabels=usedPins.slice(0,10).map((pin,index)=>`<span class="board-pin ${index%2?'right':'left'}" style="top:${42+index*24}px">${escH(pin)}</span>`).join('');
  root.innerHTML=`<div class="wiring-canvas">${renderDevices(deviceRows.slice(0,midpoint))}<div class="stm32-board"><span class="board-usb"></span>${pinLabels}<strong>STM32F103C8T6</strong><small>BLUE PILL · 3.3V LOGIC</small></div>${renderDevices(deviceRows.slice(midpoint))}</div><table class="wiring-table"><thead><tr><th>อุปกรณ์</th><th>ต่อเข้าขา STM32 / Power</th></tr></thead><tbody>${deviceRows.map(item=>`<tr><td>${escH(item.name)}</td><td><code>${escH(item.pins)}</code></td></tr>`).join('')}</tbody></table>`;
  const status=document.getElementById('hardware-pin-status');
  if(status)status.textContent=`${usedPins.length} GPIO · ไม่มี pin ซ้ำ`;
}

function hardwareConfig(){
  if(!hardwareRobotDesign)throw new Error('ยังไม่ได้อ่าน Robot Config');
  const wheelDiameter=hardwareRobotDesign.wheelDiameterMm;
  const wheelTrack=hardwareRobotDesign.wheelTrackMm;
  const accessories=hardwareSelectedAccessories();
  return {version:1,source:'sim_robot_tf/tf_model.json + sim_robot_odom/odom_config.json',robotDesign:{...hardwareRobotDesign},board:'stm32f103c8t6',boardLabel:'STM32F103C8T6 Blue Pill',drive:hardwareDrive,driveLabel:HARDWARE_DRIVES[hardwareDrive].name,kinematics:HARDWARE_DRIVES[hardwareDrive].kinematics,motorCount:HARDWARE_DRIVES[hardwareDrive].motors,motorDriver:document.getElementById('hardware-motor-driver')?.value||'tb6612',wheelDiameterMm:wheelDiameter,wheelTrackMm:wheelTrack,accessories,pinMap:hardwareMotorConnections(),accessoryPinMap:Object.fromEntries(accessories.map(id=>[id,HARDWARE_ACCESSORIES[id].connections])),updatedAt:new Date().toISOString()};
}

function hardwareRefreshReview(){
  const root=document.getElementById('hardware-review');
  if(!root)return;
  const config=hardwareConfig(),accessories=config.accessories.map(id=>HARDWARE_ACCESSORIES[id].name).join(', ')||'ไม่มี';
  root.innerHTML=`<div class="hardware-summary-card"><h4>${HARDWARE_DRIVES[config.drive].icon} โครงสร้างและ ODOM</h4><div class="hardware-summary-list"><div><span>Drive</span><b>${escH(config.driveLabel)}</b></div><div><span>มอเตอร์</span><b>${config.motorCount} ตัว</b></div><div><span>ล้อ</span><b>${config.wheelDiameterMm} mm</b></div><div><span>Wheel track</span><b>${config.wheelTrackMm} mm</b></div><div><span>Kinematics</span><b>${escH(config.kinematics)}</b></div></div></div><div class="hardware-summary-card"><h4>🔌 Controller และ Sensor</h4><div class="hardware-summary-list"><div><span>MCU</span><b>STM32F103C8T6</b></div><div><span>Driver</span><b>${escH(config.motorDriver.toUpperCase())} × ${HARDWARE_DRIVES[config.drive].driverBoards}</b></div><div><span>อุปกรณ์เสริม</span><b>${escH(accessories)}</b></div><div><span>Transport</span><b>USB Serial 115200</b></div></div></div><div class="hardware-output">ไฟล์ที่จะสร้าง<br>├─ .roside/hardware.json &nbsp;← source of truth สำหรับ TF / ODOM<br>└─ src/roside_stm32_base/firmware/<br>&nbsp;&nbsp;&nbsp;├─ platformio.ini<br>&nbsp;&nbsp;&nbsp;├─ src/main.cpp &nbsp;← pin + motor scaffold ตามฐานล้อ<br>&nbsp;&nbsp;&nbsp;└─ README.md &nbsp;← wiring และขั้นตอน flash</div>`;
}

function hardwareSetStep(step){
  hardwareStep=Math.max(0,Math.min(2,step));
  document.querySelectorAll('#hardware-builder-modal [data-hardware-step]').forEach(el=>el.classList.toggle('active',Number(el.dataset.hardwareStep)===hardwareStep));
  document.querySelectorAll('#hardware-builder-modal [data-hardware-page]').forEach(el=>el.classList.toggle('active',Number(el.dataset.hardwarePage)===hardwareStep));
  const back=document.getElementById('hardware-back'),next=document.getElementById('hardware-next');
  if(back)back.disabled=hardwareStep===0;
  if(next){next.textContent=hardwareStep===0?'ต่อบอร์ดและเลือก Sensor →':hardwareStep===1?'ตรวจสอบก่อนสร้างไฟล์ →':'⚡ สร้าง Config + Firmware';next.onclick=hardwareStep===2?hardwareGenerateFiles:()=>hardwareMoveStep(1);}
  if(hardwareStep===1)hardwareRenderWiring();
  if(hardwareStep===2)hardwareRefreshReview();
}

function hardwareMoveStep(delta){hardwareSetStep(hardwareStep+delta);}

function hardwarePopulateConfig(config){
  if(!config)return;
  const driver=document.getElementById('hardware-motor-driver');
  if(driver&&['tb6612','l298n'].includes(config.motorDriver))driver.value=config.motorDriver;
  const selected=new Set(Array.isArray(config.accessories)?config.accessories:[]);
  document.querySelectorAll('#hardware-builder-modal .hardware-accessory input').forEach(input=>{input.checked=selected.has(input.value);});
}

function hardwareLoadStoredConfig(){
  try{hardwarePopulateConfig(JSON.parse(localStorage.getItem(hardwareStorageKey())||'null'));}catch(_){ }
}

async function hardwareGetSavedConfig(){
  try{
    const cached=JSON.parse(localStorage.getItem(hardwareStorageKey())||'null');
    if(cached&&HARDWARE_DRIVES[cached.drive])return cached;
  }catch(_){ }
  if(!sessionId)return null;
  const path=`${String(wsPath||'~/ros2_ws').replace(/\/$/,'')}/.roside/hardware.json`;
  const result=await API('/api/files/read',{sessionId,path}).catch(()=>null);
  if(!result?.ok)return null;
  try{const config=JSON.parse(result.content);if(!HARDWARE_DRIVES[config.drive])return null;localStorage.setItem(hardwareStorageKey(),JSON.stringify(config));return config;}catch(_){return null;}
}

async function hardwareLoadRobotDesign(){
  const source=document.getElementById('hardware-robot-source'),next=document.getElementById('hardware-next');
  hardwareRobotDesign=null;if(next)next.disabled=true;
  const root=String(wsPath||'~/ros2_ws').replace(/\/$/,'');
  try{
    if(!sessionId)throw new Error('กรุณาเชื่อมต่อหุ่นยนต์ก่อน');
    const [modelResult,odomResult]=await Promise.all([
      API('/api/files/read',{sessionId,path:`${root}/src/sim_robot_tf/tf_model.json`}),
      API('/api/files/read',{sessionId,path:`${root}/src/sim_robot_odom/odom_config.json`}),
    ]);
    if(!modelResult?.ok)throw new Error('ยังไม่พบ Robot Model — กลับไปประกอบตัวหุ่นและกดบันทึก');
    if(!odomResult?.ok)throw new Error('ยังไม่พบ ODOM config — กลับไปด่านจำเส้นทางและกดบันทึก');
    const model=JSON.parse(modelResult.content),odom=JSON.parse(odomResult.content),wheels=Array.isArray(odom.wheels)?odom.wheels:[];
    if(!Array.isArray(model)||!model.length||!wheels.length)throw new Error('Robot Config ยังไม่มีข้อมูลล้อที่สมบูรณ์');
    const pattern=String(odom.pattern||''),motorCount=wheels.length;
    const drive=pattern==='differential'&&motorCount===2?'diff2':pattern==='skid'&&motorCount===4?'diff4':pattern==='mecanum'&&motorCount===4?'mecanum4':null;
    if(!drive)throw new Error(`ฐานล้อ ${pattern||'unknown'} จำนวน ${motorCount} ล้อ ยังไม่มี STM32 template กรุณาติดต่อ Admin เพื่อเพิ่ม template`);
    const radii=wheels.map(w=>Number(w.radius)).filter(value=>Number.isFinite(value)&&value>0);
    const wheelDiameterMm=Math.round((radii.reduce((sum,value)=>sum+value,0)/radii.length)*2000);
    const wheelTrackMm=Math.round(Math.max(...wheels.map(w=>Math.abs(Number(w.y)||0)))*2000);
    if(!wheelDiameterMm||!wheelTrackMm)throw new Error('ขนาดล้อหรือระยะ track ใน ODOM ไม่ถูกต้อง');
    const types=new Set(model.map(component=>component.type));
    hardwareRobotDesign={drive,pattern,motorCount,wheelDiameterMm,wheelTrackMm,hasImu:types.has('imu'),hasLidar:types.has('lidar'),componentCount:model.length};
    hardwareSelectDrive(drive);
    for(const input of document.querySelectorAll('#hardware-builder-modal .hardware-accessory input')){
      if(input.value==='mpu6050'||input.value==='bno055'){input.disabled=!hardwareRobotDesign.hasImu;if(!hardwareRobotDesign.hasImu)input.checked=false;}
      if(input.value==='rplidar'){input.disabled=!hardwareRobotDesign.hasLidar;input.checked=hardwareRobotDesign.hasLidar;}
    }
    if(hardwareRobotDesign.hasImu&&!document.querySelector('#hardware-builder-modal .hardware-accessory input[value="mpu6050"]:checked,#hardware-builder-modal .hardware-accessory input[value="bno055"]:checked'))document.querySelector('#hardware-builder-modal .hardware-accessory input[value="mpu6050"]').checked=true;
    if(source)source.innerHTML=`<div class="hardware-summary-card"><h4>${HARDWARE_DRIVES[drive].icon} ฐานล้อจาก Robot Model</h4><div class="hardware-summary-list"><div><span>รูปแบบ</span><b>${escH(HARDWARE_DRIVES[drive].name)}</b></div><div><span>ล้อ / มอเตอร์</span><b>${motorCount} ตัว</b></div><div><span>ชิ้นส่วนใน TF</span><b>${model.length} ชิ้น</b></div></div></div><div class="hardware-summary-card"><h4>📍 ค่าจาก ODOM</h4><div class="hardware-summary-list"><div><span>Wheel diameter</span><b>${wheelDiameterMm} mm</b></div><div><span>Wheel track</span><b>${wheelTrackMm} mm</b></div><div><span>Sensor ในแบบ</span><b>${[types.has('imu')?'IMU':'',types.has('lidar')?'LiDAR':''].filter(Boolean).join(' + ')||'ไม่มี'}</b></div></div></div>`;
    if(next)next.disabled=false;hardwareRenderWiring();hardwareRefreshReview();return true;
  }catch(error){
    if(source)source.innerHTML=`<div class="hardware-summary-card"><h4>⚠️ ยังเปิด Hardware Builder ไม่ได้</h4><div class="hardware-summary-list"><span>${escH(error.message)}</span></div><button type="button" class="btn" style="margin-top:12px" onclick="closeHardwareBuilder();switchPage('transformation');initTransformation()">กลับไป Robot Config →</button></div>`;
    return false;
  }
}

async function openHardwareBuilder(){
  const modal=document.getElementById('hardware-builder-modal');if(!modal)return;
  hardwareBuilderTrigger=document.activeElement;hardwareLoadStoredConfig();hardwareSetStep(0);hardwareRenderWiring();
  document.getElementById('hardware-save-status').textContent='';
  modal.classList.remove('hidden');requestAnimationFrame(()=>modal.classList.add('open'));document.getElementById('hardware-builder-close')?.focus();
  const config=await hardwareGetSavedConfig();if(config)hardwarePopulateConfig(config);
  await hardwareLoadRobotDesign();
}

function closeHardwareBuilder(){
  const modal=document.getElementById('hardware-builder-modal');if(!modal||modal.classList.contains('hidden'))return;
  modal.classList.remove('open');modal.classList.add('hidden');if(hardwareBuilderTrigger?.focus)hardwareBuilderTrigger.focus();hardwareBuilderTrigger=null;
}

function hardwareFirmwareSource(config){
  const motorPins=config.motorCount===2
    ? [['LEFT','PB12','PB13','PA8'],['RIGHT','PB14','PB15','PA9']]
    : [['FRONT_LEFT','PB12','PB13','PA8'],['FRONT_RIGHT','PB14','PB15','PA9'],['REAR_LEFT','PB3','PB4','PA6'],['REAR_RIGHT','PB5','PB8','PA7']];
  const declarations=motorPins.map((pins,index)=>`constexpr MotorPin MOTOR_${index+1} = {${pins[1]}, ${pins[2]}, ${pins[3]}, "${pins[0]}"};`).join('\n');
  const init=motorPins.map((_,index)=>`  initMotor(MOTOR_${index+1});`).join('\n');
  const stop=motorPins.map((_,index)=>`  setMotor(MOTOR_${index+1}, 0);`).join('\n');
  const accessories=new Set(config.accessories||[]),usesI2c=accessories.has('mpu6050')||accessories.has('bno055');
  const accessoryDeclarations=[
    accessories.has('mpu6050')?'constexpr uint8_t IMU_I2C_ADDRESS = 0x68; // MPU6050 on PB6 SCL / PB7 SDA':'',
    accessories.has('bno055')?'constexpr uint8_t IMU_I2C_ADDRESS = 0x28; // BNO055 on PB6 SCL / PB7 SDA':'',
    accessories.has('hcsr04')?'constexpr uint32_t ULTRASONIC_TRIG = PB0;\nconstexpr uint32_t ULTRASONIC_ECHO = PB1; // 5V echo MUST pass through divider':'',
    accessories.has('servo')?'constexpr uint32_t SERVO_PWM = PB9; // Servo uses an external 5V supply':'',
  ].filter(Boolean).join('\n');
  const accessoryInit=[usesI2c?'  Wire.begin();':'',accessories.has('hcsr04')?'  pinMode(ULTRASONIC_TRIG,OUTPUT); pinMode(ULTRASONIC_ECHO,INPUT);':'',accessories.has('servo')?'  pinMode(SERVO_PWM,OUTPUT); analogWrite(SERVO_PWM,0);':''].filter(Boolean).join('\n');
  return `// Generated by Mecha Rayong Hardware Builder\n// Board: STM32F103C8T6 | Drive: ${config.driveLabel}\n// ROS transport scaffold: USB Serial (ready to replace with micro_ros)\n#include <Arduino.h>\n${usesI2c?'#include <Wire.h>\n':''}\nstruct MotorPin { uint32_t in1, in2, pwm; const char* name; };\n${declarations}\n${accessoryDeclarations}\nconstexpr float WHEEL_DIAMETER_M = ${(config.wheelDiameterMm/1000).toFixed(4)}f;\nconstexpr float WHEEL_TRACK_M = ${(config.wheelTrackMm/1000).toFixed(4)}f;\nconstexpr uint32_t COMMAND_TIMEOUT_MS = 300;\nuint32_t lastCommandAt = 0;\n\nvoid initMotor(const MotorPin &m){ pinMode(m.in1,OUTPUT); pinMode(m.in2,OUTPUT); pinMode(m.pwm,OUTPUT); digitalWrite(m.in1,LOW); digitalWrite(m.in2,LOW); analogWrite(m.pwm,0); }\nvoid setMotor(const MotorPin &m,int value){ value=constrain(value,-255,255); digitalWrite(m.in1,value>0); digitalWrite(m.in2,value<0); analogWrite(m.pwm,abs(value)); }\nvoid stopAll(){\n${stop}\n}\nvoid setup(){\n  Serial.begin(115200);\n${init}\n${accessoryInit}\n  stopAll(); // Safety: motors stay disabled until a valid command arrives\n  Serial.println("ROSIDE_STM32_READY ${config.drive}");\n}\nvoid loop(){\n  // Initial protocol: send \"M <m1> <m2>${config.motorCount===4?' <m3> <m4>':''}\" with values -255..255.\n  // Replace this parser with micro_ros /cmd_vel after validating motor direction.\n  if(Serial.available()){\n    const String line=Serial.readStringUntil('\\n');\n    int v[4]={0,0,0,0};\n    const int count=sscanf(line.c_str(),"M %d %d %d %d",&v[0],&v[1],&v[2],&v[3]);\n    if(count>=${config.motorCount}){\n${motorPins.map((_,index)=>`      setMotor(MOTOR_${index+1},v[${index}]);`).join('\n')}\n      lastCommandAt=millis();\n    }\n  }\n  if(millis()-lastCommandAt>COMMAND_TIMEOUT_MS)stopAll();\n}\n`;
}

function hardwareReadme(config){
  const accessories=config.accessories.map(id=>`- ${HARDWARE_ACCESSORIES[id].name}: ${HARDWARE_ACCESSORIES[id].connections.map(pair=>pair.join(' -> ')).join(', ')}`).join('\n')||'- No optional sensor selected';
  return `# STM32F103C8T6 robot base\n\nGenerated from Hardware Builder for **${config.driveLabel}**.\n\n## Mechanical configuration\n\n- Wheel diameter: ${config.wheelDiameterMm} mm\n- Wheel track: ${config.wheelTrackMm} mm\n- Motor driver: ${config.motorDriver.toUpperCase()} x ${HARDWARE_DRIVES[config.drive].driverBoards}\n- Kinematics: ${config.kinematics}\n\n## Optional devices\n\n${accessories}\n\n## Safety before power-on\n\n1. STM32 GPIO is 3.3V only; use a divider for HC-SR04 ECHO.\n2. Use a separate motor supply and connect every GND together.\n3. Lift wheels off the floor for the first direction test.\n4. Flash with PlatformIO: \`pio run -t upload\`.\n\nThe initial firmware accepts serial motor commands and stops after 300 ms without a valid command. Integrate micro_ros only after every motor direction and encoder has been verified.\n`;
}

async function hardwareGenerateFiles(){
  const status=document.getElementById('hardware-save-status'),button=document.getElementById('hardware-next');
  if(!sessionId){if(status){status.className='hardware-save-status error';status.textContent='กรุณาเชื่อมต่อหุ่นยนต์ก่อนสร้างไฟล์';}return;}
  const config=hardwareConfig(),base=`${String(wsPath||'~/ros2_ws').replace(/\/$/,'')}/src/roside_stm32_base/firmware`;
  if(button)button.disabled=true;if(status){status.className='hardware-save-status';status.textContent='กำลังสร้าง config, pin map และ firmware template…';}
  try{
    for(const path of [`${String(wsPath||'~/ros2_ws').replace(/\/$/,'')}/.roside`,`${base}/src`]){const result=await API('/api/files/mkdir',{sessionId,path});if(!result?.ok)throw new Error(result?.error||`สร้าง ${path} ไม่สำเร็จ`);}
    const platformio='[env:bluepill_f103c8]\nplatform = ststm32\nboard = bluepill_f103c8\nframework = arduino\nupload_protocol = stlink\nmonitor_speed = 115200\n';
    const files=[
      [`${String(wsPath||'~/ros2_ws').replace(/\/$/,'')}/.roside/hardware.json`,JSON.stringify(config,null,2)+'\n'],
      [`${base}/platformio.ini`,platformio],[`${base}/src/main.cpp`,hardwareFirmwareSource(config)],[`${base}/README.md`,hardwareReadme(config)],
    ];
    for(const [path,content] of files){const result=await API('/api/files/write',{sessionId,path,content});if(!result?.ok)throw new Error(result?.error||`เขียน ${path} ไม่สำเร็จ`);}
    localStorage.setItem(hardwareStorageKey(),JSON.stringify(config));
    if(status){status.className='hardware-save-status ok';status.textContent='✓ สร้าง Hardware config และ firmware template แล้ว — พร้อมใช้เป็นฐานสำหรับ TF และ ODOM';}
    if(typeof loadTree==='function')loadTree(wsPath,'file-tree',0);
    if(typeof loadDashboard==='function')setTimeout(()=>loadDashboard(true),500);
  }catch(error){if(status){status.className='hardware-save-status error';status.textContent='สร้างไฟล์ไม่สำเร็จ: '+error.message;}}
  finally{if(button)button.disabled=false;}
}

let realTeleopBound=false,realTeleopTrigger=null,realControllerSocket=null,realLidarSocket=null,realControllerConnected=false,realLidarRunning=false,realDriveTimer=null;
let realDriveKeys=new Set(),realDriveHardware={},realOdom={x:0,y:0,yaw:0,vx:0,vy:0,wz:0},realOdomTrail=[],realDriveScan=null;

function realTeleopUpdateStatus(message,live=false){
  const status=document.getElementById('real-teleop-status');
  if(status){status.textContent=message;status.classList.toggle('live',live);}
}

function realTeleopApplySpeed(){
  const linear=Math.max(.05,Math.min(.8,Number(document.getElementById('real-teleop-linear')?.value)||.2));
  const angular=Math.max(.2,Math.min(2,Number(document.getElementById('real-teleop-angular')?.value)||.8));
  const linearLabel=document.getElementById('real-teleop-linear-value');
  const angularLabel=document.getElementById('real-teleop-angular-value');
  if(linearLabel)linearLabel.textContent=linear.toFixed(2)+' m/s';
  if(angularLabel)angularLabel.textContent=angular.toFixed(2)+' rad/s';
  if(realDriveKeys.size)realTeleopSendDrive();
}

function realTeleopStop(message='หุ่นยนต์หยุดแล้ว — พร้อมรับคำสั่ง'){
  realDriveKeys.clear();document.querySelectorAll('#real-teleop-modal .real-teleop-btn.on').forEach(button=>button.classList.remove('on'));
  realTeleopSendSerial('S');
  realTeleopUpdateStatus(message,false);
}

function realTeleopSetState(id,message,live=false){const node=document.getElementById(id);if(node){node.textContent=message;node.classList.toggle('live',live);}}
function realTeleopSendSerial(command){if(realControllerSocket?.readyState===WebSocket.OPEN)realControllerSocket.send(JSON.stringify({type:'command',command,motorCount:Number(realDriveHardware.motorCount)||2}));}
function realTeleopSendDrive(){
  if(!realControllerConnected)return realTeleopUpdateStatus('กรุณาเชื่อมต่อ Controller ก่อน',false);
  const linear=Math.max(.05,Math.min(.8,Number(document.getElementById('real-teleop-linear')?.value)||.2)),angular=Math.max(.2,Math.min(2,Number(document.getElementById('real-teleop-angular')?.value)||.8));
  const vx=(realDriveKeys.has('fwd')?linear:0)-(realDriveKeys.has('back')?linear:0),wz=(realDriveKeys.has('left')?angular:0)-(realDriveKeys.has('right')?angular:0);
  realTeleopSendSerial(`V ${vx.toFixed(4)} 0 ${wz.toFixed(4)}`);
}
function realTeleopSetDirection(direction,active){
  if(active)realDriveKeys.add(direction);else realDriveKeys.delete(direction);
  document.querySelectorAll(`#real-teleop-modal .real-teleop-btn[data-dir="${direction}"]`).forEach(button=>button.classList.toggle('on',active));
  if(realDriveKeys.size){realTeleopSendDrive();if(!realDriveTimer)realDriveTimer=setInterval(realTeleopSendDrive,100);realTeleopUpdateStatus('กำลังส่งคำสั่งความเร็วไปยัง Controller',true);}
  else{if(realDriveTimer)clearInterval(realDriveTimer);realDriveTimer=null;realTeleopStop('ปล่อยปุ่มแล้ว — หุ่นยนต์หยุด');}
}

async function realTeleopLoadHardware(){
  try{const root=String(wsPath||'~/ros2_ws').replace(/\/$/,'');const result=await API('/api/files/read',{sessionId,path:`${root}/.roside/hardware.json`});if(result?.ok)realDriveHardware=JSON.parse(result.content);}catch(_){realDriveHardware={};}
  const baud=document.getElementById('real-controller-baud');if(baud)baud.value=realDriveHardware.baudRate||115200;
}
async function realTeleopRefreshPorts(){
  if(!sessionId)return;realTeleopSetState('real-controller-state','กำลังค้นหา COM port…');
  try{const result=await API('/api/serial/ports',{sessionId});if(!result?.ok)throw new Error(result?.error||'ค้นหา COM port ไม่สำเร็จ');const ports=(result.ports||[]).filter(item=>item.path);
    for(const [id,preferred] of [['real-controller-port',realDriveHardware.serialPort],['real-lidar-port',null]]){const select=document.getElementById(id);if(!select)continue;const previous=select.value;select.innerHTML=ports.length?'':'<option value="">ไม่พบ COM port</option>';for(const port of ports)select.add(new Option(`${port.accessible===false?'○':'●'} ${port.path} · ${port.label||port.path}`,port.path));select.value=ports.some(port=>port.path===(previous||preferred))?(previous||preferred):(ports.find(port=>port.accessible!==false)?.path||ports[0]?.path||'');}
    realTeleopSetState('real-controller-state',ports.length?`พบ ${ports.length} COM port · เลือกพอร์ต Controller แล้วกดเชื่อมต่อ`:'ไม่พบ COM port',false);realTeleopLidarModelChanged(false);
  }catch(error){realTeleopSetState('real-controller-state',error.message,false);}
}
async function realTeleopToggleController(){
  if(realControllerConnected||realControllerSocket){realTeleopStop();try{realControllerSocket?.close();}catch(_){}realControllerSocket=null;realControllerConnected=false;document.getElementById('real-controller-connect').textContent='เชื่อมต่อ Controller';realTeleopSetState('real-controller-state','ตัดการเชื่อมต่อแล้ว');return;}
  const port=document.getElementById('real-controller-port')?.value,baud=Math.trunc(Number(document.getElementById('real-controller-baud')?.value)),motorCount=Math.max(1,Math.min(8,Math.trunc(Number(realDriveHardware.motorCount)||2)));if(!port)return realTeleopSetState('real-controller-state','กรุณาเลือก COM port');
  realTeleopSetState('real-controller-state','กำลังเตรียมสิทธิ์และเปิดพอร์ต…');const prepared=await API('/api/serial/prepare',{sessionId,port}).catch(error=>({ok:false,error:error.message}));if(!prepared?.ok)return realTeleopSetState('real-controller-state',prepared?.error||'เตรียม COM port ไม่สำเร็จ');
  const proto=location.protocol==='https:'?'wss:':'ws:',socket=new WebSocket(`${proto}//${location.host}/ws/controller-tune`,['ros2ide',getAuthToken()]);realControllerSocket=socket;
  socket.onopen=()=>socket.send(JSON.stringify({type:'start',sessionId,port,baud,motorCount}));
  socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch(_){return;}if(message.type==='error')return realTeleopSetState('real-controller-state',message.message||'Controller error');if(message.type!=='telemetry')return;const data=message.data||{};if(data.event==='port_open'){realControllerConnected=true;document.getElementById('real-controller-connect').textContent='ตัดการเชื่อมต่อ';realTeleopSetState('real-controller-state',`${port} @ ${baud} · CONNECTED`,true);realTeleopUpdateStatus('พร้อมบังคับด้วยปุ่มหรือคีย์บอร์ด',true);}else if(data.event==='frame'&&data.kind==='ODOM'&&data.values?.length===6){[realOdom.x,realOdom.y,realOdom.yaw,realOdom.vx,realOdom.vy,realOdom.wz]=data.values;realOdomTrail.push({x:realOdom.x,y:realOdom.y});if(realOdomTrail.length>1500)realOdomTrail.shift();realTeleopUpdateOdom();realTeleopDrawMap();}else if(data.event==='frame'&&data.kind==='RPM'){document.getElementById('real-rpm-state').textContent=`${data.values.length/2} Motors`;}};
  socket.onclose=()=>{if(realControllerSocket===socket)realControllerSocket=null;realControllerConnected=false;realTeleopStop('Controller หลุด — สั่งหยุดแล้ว');document.getElementById('real-controller-connect').textContent='เชื่อมต่อ Controller';realTeleopSetState('real-controller-state','DISCONNECTED');};socket.onerror=()=>realTeleopSetState('real-controller-state','เชื่อมต่อ Controller ไม่สำเร็จ');
}
function realTeleopUpdateOdom(){for(const [id,value,unit] of [['real-odom-x',realOdom.x,'m'],['real-odom-y',realOdom.y,'m'],['real-odom-yaw',realOdom.yaw*180/Math.PI,'°'],['real-odom-vx',realOdom.vx,'m/s'],['real-odom-wz',realOdom.wz,'rad/s']]){const node=document.getElementById(id);if(node)node.textContent=`${Number(value).toFixed(2)} ${unit}`;}}
function realTeleopResetOdom(){realTeleopSendSerial('Z');realOdom={x:0,y:0,yaw:0,vx:0,vy:0,wz:0};realOdomTrail=[];realTeleopUpdateOdom();realTeleopDrawMap();}
function realTeleopInitLidarModels(){const select=document.getElementById('real-lidar-model');if(!select||select.options.length)return;for(const item of (typeof LIDAR_MODELS==='undefined'?[]:LIDAR_MODELS))select.add(new Option(`${item.brand} · ${item.name}`,item.id));if(typeof lidarSelected==='string')select.value=lidarSelected;realTeleopLidarModelChanged(false);}
function realTeleopLidarModelChanged(forcePort=true){const model=(typeof LIDAR_MODELS==='undefined'?[]:LIDAR_MODELS).find(item=>item.id===document.getElementById('real-lidar-model')?.value);const port=document.getElementById('real-lidar-port');if(model&&port&&forcePort&&[...port.options].some(option=>option.value===model.port))port.value=model.port;}
async function realTeleopToggleLidar(){
  if(realLidarRunning){realTeleopCloseLidarStream();const modelId=document.getElementById('real-lidar-model')?.value,port=document.getElementById('real-lidar-port')?.value;await API('/api/lidar/driver',{sessionId,modelId,port,action:'stop'}).catch(()=>null);realTeleopSetState('real-lidar-state','LiDAR หยุดแล้ว');return;}
  const modelId=document.getElementById('real-lidar-model')?.value,model=(typeof LIDAR_MODELS==='undefined'?[]:LIDAR_MODELS).find(item=>item.id===modelId),port=document.getElementById('real-lidar-port')?.value||model?.port;if(!model)return realTeleopSetState('real-lidar-state','กรุณาเลือกรุ่น LiDAR');if(realControllerConnected&&port===document.getElementById('real-controller-port')?.value)return realTeleopSetState('real-lidar-state','Controller และ LiDAR ต้องใช้คนละ COM port');realTeleopSetState('real-lidar-state','กำลังเปิด Driver และ /scan…');
  const result=await API('/api/lidar/driver',{sessionId,modelId,port,baud:Number(model.baud)||undefined,action:'start'}).catch(error=>({ok:false,error:error.message}));if(!result?.ok)return realTeleopSetState('real-lidar-state',result?.error||'เปิด LiDAR ไม่สำเร็จ');
  const proto=location.protocol==='https:'?'wss:':'ws:',socket=new WebSocket(`${proto}//${location.host}/ws/lidar`,['ros2ide',getAuthToken()]);realLidarSocket=socket;realLidarRunning=true;document.getElementById('real-lidar-connect').textContent='ปิด LiDAR';socket.onopen=()=>socket.send(JSON.stringify({type:'start',sessionId}));socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch(_){return;}if(message.type==='scan'){realDriveScan=message.data;const count=message.data?.ranges?.filter(Number.isFinite).length||0;document.getElementById('real-map-lidar').textContent=`LiDAR: ${count} points`;realTeleopSetState('real-lidar-state',`LIVE /scan · ${Number(message.data?.hz||0).toFixed(1)} Hz`,true);realTeleopDrawMap();}else if(message.type==='error')realTeleopSetState('real-lidar-state',message.message||'LiDAR stream error');};socket.onclose=()=>{if(realLidarSocket===socket)realTeleopCloseLidarStream();};
}
function realTeleopCloseLidarStream(){try{realLidarSocket?.close();}catch(_){}realLidarSocket=null;realLidarRunning=false;const button=document.getElementById('real-lidar-connect');if(button)button.textContent='เปิด LiDAR';}
function realTeleopDrawMap(){
  const canvas=document.getElementById('real-teleop-map');if(!canvas)return;const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),w=Math.max(320,rect.width),h=Math.max(360,rect.height);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b1220';ctx.fillRect(0,0,w,h);
  const points=[...realOdomTrail,{x:realOdom.x,y:realOdom.y}],scanExtent=(realDriveScan?.ranges||[]).reduce((max,value)=>Number.isFinite(value)&&value>0?Math.max(max,value):max,0),extent=Math.max(2,...points.flatMap(p=>[Math.abs(p.x),Math.abs(p.y)]),scanExtent),scale=Math.min(w,h)*.42/extent,cx=w/2,cy=h/2;ctx.strokeStyle='#20314a';ctx.lineWidth=1;for(let m=-Math.ceil(extent);m<=Math.ceil(extent);m++){ctx.beginPath();ctx.moveTo(cx+m*scale,0);ctx.lineTo(cx+m*scale,h);ctx.stroke();ctx.beginPath();ctx.moveTo(0,cy-m*scale);ctx.lineTo(w,cy-m*scale);ctx.stroke();}
  if(realOdomTrail.length){ctx.strokeStyle='#4f8ef7';ctx.lineWidth=2;ctx.beginPath();realOdomTrail.forEach((p,i)=>{const x=cx+p.x*scale,y=cy-p.y*scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
  if(realDriveScan?.ranges?.length){ctx.fillStyle='#3ecf8e';const start=Number(realDriveScan.angleMin)||-Math.PI,inc=Number(realDriveScan.angleIncrement)||Math.PI*2/realDriveScan.ranges.length;for(let i=0;i<realDriveScan.ranges.length;i+=Math.max(1,Math.floor(realDriveScan.ranges.length/720))){const r=realDriveScan.ranges[i];if(!Number.isFinite(r)||r<=0||r>extent)continue;const a=realOdom.yaw+start+i*inc,x=cx+(realOdom.x+Math.cos(a)*r)*scale,y=cy-(realOdom.y+Math.sin(a)*r)*scale;ctx.fillRect(x-1,y-1,2,2);}}
  ctx.save();ctx.translate(cx+realOdom.x*scale,cy-realOdom.y*scale);ctx.rotate(-realOdom.yaw);ctx.fillStyle='#ffb653';ctx.beginPath();ctx.moveTo(14,0);ctx.lineTo(-9,-8);ctx.lineTo(-9,8);ctx.closePath();ctx.fill();ctx.restore();const label=document.getElementById('real-map-scale');if(label)label.textContent=`ODOM path · ±${extent.toFixed(1)} m`;
}

function realTeleopBind(){
  if(realTeleopBound)return;
  realTeleopBound=true;
  document.querySelectorAll('#real-teleop-modal .real-teleop-btn[data-dir]').forEach(button=>{
    const direction=button.dataset.dir;
    let heldPointer=null;
    const down=event=>{
      event.preventDefault();
      if(!sessionId||isSimWorkspace)return realTeleopStop('ยังไม่ได้เชื่อมต่อหุ่นยนต์จริง');
      heldPointer=event.pointerId;
      try{button.setPointerCapture(event.pointerId);}catch(_){ }
      realTeleopSetDirection(direction,true);
      realTeleopUpdateStatus('กำลังส่งคำสั่ง /cmd_vel — ปล่อยปุ่มเพื่อหยุด',true);
    };
    const up=event=>{
      if(heldPointer===null)return;
      event.preventDefault();
      heldPointer=null;
      realTeleopSetDirection(direction,false);
      realTeleopUpdateStatus('ปล่อยปุ่มแล้ว — หุ่นยนต์หยุด',false);
    };
    button.addEventListener('pointerdown',down);
    button.addEventListener('pointerup',up);
    button.addEventListener('pointercancel',up);
    button.addEventListener('lostpointercapture',up);
    button.addEventListener('contextmenu',event=>event.preventDefault());
  });
  window.addEventListener('blur',()=>{
    if(!document.getElementById('real-teleop-modal')?.classList.contains('hidden'))realTeleopStop('หน้าต่างไม่ได้โฟกัส — สั่งหยุดอัตโนมัติ');
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&!document.getElementById('real-teleop-modal')?.classList.contains('hidden'))realTeleopStop('เปลี่ยนหน้าจอ — สั่งหยุดอัตโนมัติ');
  });
  const keyDirections={w:'fwd',arrowup:'fwd',s:'back',arrowdown:'back',a:'left',arrowleft:'left',d:'right',arrowright:'right'};
  window.addEventListener('keydown',event=>{
    if(document.getElementById('real-teleop-modal')?.classList.contains('hidden'))return;
    const active=document.activeElement;
    if(active&&/INPUT|SELECT|TEXTAREA/.test(active.tagName))return;
    if(event.code==='Space'){
      event.preventDefault();
      realTeleopStop('กด Space — หุ่นยนต์หยุดทันที');
      return;
    }
    const direction=keyDirections[String(event.key).toLowerCase()];
    if(!direction||event.repeat)return;
    event.preventDefault();
    realTeleopSetDirection(direction,true);
    realTeleopUpdateStatus('กำลังควบคุมด้วยคีย์บอร์ด — ปล่อยปุ่มเพื่อหยุด',true);
  });
  window.addEventListener('keyup',event=>{
    if(document.getElementById('real-teleop-modal')?.classList.contains('hidden'))return;
    const direction=keyDirections[String(event.key).toLowerCase()];
    if(!direction)return;
    event.preventDefault();
    realTeleopSetDirection(direction,false);
  });
}

function openRealRobotTeleop(){
  if(isSimWorkspace)return;
  if(!sessionId){if(typeof sbMsg==='function')sbMsg('กรุณาเชื่อมต่อหุ่นยนต์จริงก่อน',2800);return;}
  realTeleopTrigger=document.activeElement;
  realTeleopBind();
  realTeleopApplySpeed();
  realTeleopStop('เชื่อมต่อ Controller ก่อนเริ่มขับ');
  const modal=document.getElementById('real-teleop-modal');
  modal?.classList.remove('hidden');
  requestAnimationFrame(()=>modal?.classList.add('open'));
  realTeleopInitLidarModels();realTeleopLoadHardware().then(realTeleopRefreshPorts);realTeleopDrawMap();
  document.getElementById('real-teleop-stop')?.focus();
}

function closeRealRobotTeleop(){
  realTeleopStop('ปิดรีโมตแล้ว — หุ่นยนต์หยุด');
  const stopLidar=realLidarRunning,modelId=document.getElementById('real-lidar-model')?.value,port=document.getElementById('real-lidar-port')?.value;
  try{realControllerSocket?.close();}catch(_){}realControllerSocket=null;realControllerConnected=false;realTeleopCloseLidarStream();if(stopLidar&&modelId)API('/api/lidar/driver',{sessionId,modelId,port,action:'stop'}).catch(()=>null);
  const modal=document.getElementById('real-teleop-modal');
  modal?.classList.remove('open');
  modal?.classList.add('hidden');
  if(realTeleopTrigger?.focus)realTeleopTrigger.focus();
  realTeleopTrigger=null;
}

document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!document.getElementById('hardware-builder-modal')?.classList.contains('hidden'))closeHardwareBuilder();
  else if(event.key==='Escape'&&!document.getElementById('real-teleop-modal')?.classList.contains('hidden'))closeRealRobotTeleop();
  else if(event.key==='Escape'&&!document.getElementById('agv-mission-modal')?.classList.contains('hidden'))closeAgvMission();
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
    if (name === '/sim_robot_mapsim' || name === 'sim_robot_mapsim') {
      const stopped = await API('/api/kill-node', { sessionId, pkg:'sim_robot_mapsim', exe:'mapsim' });
      if (!stopped?.ok || stopped.stillUp) throw new Error(stopped?.error || 'MapSim ยังทำงานอยู่');
      if (typeof sbMsg === 'function') sbMsg('✅ หยุด MapSim แล้ว', 2000);
      setTimeout(() => loadDashboard(), 1000);
      return;
    }
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
