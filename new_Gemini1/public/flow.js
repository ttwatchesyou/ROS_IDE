// ═════════════════════════════════════════════════════════════════
//  FLOW EDITOR — Phase 3 (Full Logic Implementation)
//  ออกแบบให้ใช้งานง่ายและถูก Logic ของ ROS2 TF สำหรับนักเรียน
//  ** 📱 รองรับการสัมผัส (Touch Screen / Tablet) เต็มรูปแบบ **
// ═════════════════════════════════════════════════════════════════

const FLOW = {
  nodes: [],
  edges: [],
  selected: null,
  dragging: null,
  connecting: null,
  pan: {x:0, y:0},
  zoom: 1,
  panning: false,
  panStart: {x:0, y:0, px:0, py:0},
  nextId: 1,
  pkg: null,
  pkgLang: 'py',
  flowInited: false,
  dragType: null,
  canvasMode: 'general', // 'general' | 'tf' | 'odom' | 'navigation'
};
window.FLOW=FLOW;

function isFlowFileSelected() {
  const pkg = document.getElementById('flow-pkg-sel')?.value;
  const file = document.getElementById('flow-file-sel')?.value;
  return !!(pkg && file && file !== '_new');
}

const FLOW_TYPES = {
  publisher: {
    label:'Publisher', emoji:'📢', cls:'fn-pub', portCls:'pub',
    hint:'Send data to topic — connect line from Timer or Math',
    defaultProps:{icon:'📢', topic:'/cmd_vel', msgType:'geometry_msgs/Twist', qos:'10'},
    ports:{inp:[{id:'data',label:'data in',top:'50%'}]},
    genCode: n => [
      `# Publisher: ${n.props.topic}`,
      `self.pub_${safeName(n.props.topic)} = self.create_publisher(`,
      `    ${n.props.msgType.split('/').pop()}, '${n.props.topic}', ${n.props.qos})`,
    ].join('\n'),
  },
  subscriber: {
    label:'Subscriber', emoji:'📥', cls:'fn-sub', portCls:'sub',
    hint:'Receive data from topic',
    defaultProps:{icon:'📥', topic:'/scan', msgType:'sensor_msgs/LaserScan', qos:'10'},
    ports:{out:[{id:'msg',label:'msg →',top:'50%'}]},
    genCode: n => [
      `# Subscriber: ${n.props.topic}`,
      `self.sub_${safeName(n.props.topic)} = self.create_subscription(`,
      `    ${n.props.msgType.split('/').pop()}, '${n.props.topic}',`,
      `    self.cb_${safeName(n.props.topic)}, ${n.props.qos})`,
    ].join('\n'),
  },
  timer: {
    label:'Timer', emoji:'⏱', cls:'fn-timer', portCls:'timer',
    hint:'Call callback every X seconds',
    defaultProps:{icon:'⏱', period:'0.1', callback:'loop'},
    ports:{out:[{id:'tick',label:'tick',top:'50%'}]},
    genCode: n => [
      `# Timer ${Math.round(1/parseFloat(n.props.period)||10)} Hz`,
      `self.timer_${n.props.callback} = self.create_timer(`,
      `    ${n.props.period}, self.${n.props.callback})`,
    ].join('\n'),
  },
  service: {
    label:'Service', emoji:'⚙', cls:'fn-srv', portCls:'generic',
    hint:'Receive request and respond',
    defaultProps:{icon:'⚙', name:'/reset', srvType:'std_srvs/SetBool'},
    ports:{out:[{id:'resp',label:'response',top:'50%'}]},
    genCode: n => [
      `# Service Server: ${n.props.name}`,
      `self.srv_${safeName(n.props.name)} = self.create_service(`,
      `    ${n.props.srvType.split('/').pop()}, '${n.props.name}',`,
      `    self.handle_${safeName(n.props.name)})`,
    ].join('\n'),
  },
  condition: {
    label:'If Condition', emoji:'🔀', cls:'fn-if', portCls:'if',
    hint:'Check condition True/False',
    defaultProps:{icon:'🔀', condition:'value < 0.5', varName:'value'},
    ports:{inp:[{id:'in',label:'in',top:'50%'}], out:[{id:'true',label:'True',top:'35%'},{id:'false',label:'False',top:'65%'}]},
    genCode: n => [
      `# Condition: ${n.props.condition}`,
      `if ${n.props.condition}:`,
      `    pass  # True branch`,
      `else:`,
      `    pass  # False branch`,
    ].join('\n'),
  },
  math: {
    label:'Math', emoji:'🔢', cls:'fn-math', portCls:'math',
    hint:'Calculate value according to formula',
    defaultProps:{icon:'🔢', formula:'speed = dist * 0.5', output:'speed'},
    ports:{inp:[{id:'in',label:'in',top:'50%'}], out:[{id:'out',label:'result',top:'50%'}]},
    genCode: n => [
      `# Math: ${n.props.formula}`,
      `${n.props.formula}`,
    ].join('\n'),
  },
  variable: {
    label:'Number / Variable', emoji:'#️⃣', cls:'fn-math', portCls:'generic',
    hint:'ตั้งค่าตัวเลขหรือค่าคงที่ เพื่อส่งให้โหนดอื่น',
    defaultProps:{icon:'#️⃣', varName:'my_var', value:'0.0'},
    ports:{out:[{id:'val',label:'value →',top:'50%'}]},
    genCode: n => {
      const lines = [
        `# Variable: ${n.props.varName}`,
        `self.${safeName(n.props.varName)} = ${n.props.value}`
      ];
      FLOW.edges.filter(e => e.from === n.id).forEach(e => {
         lines.push(`self._mem_${e.to}_${e.toPort} = self.${safeName(n.props.varName)}`)
      });
      return lines.join('\n'); 
    },
  },
  logger: {
    label:'Logger', emoji:'📋', cls:'fn-log', portCls:'generic',
    hint:'Print values to terminal (use {value} to show incoming data)',
    defaultProps:{icon:'📋', message:"f'Value: {value}'", level:'info'},
    ports:{inp:[{id:'in',label:'in',top:'50%'}]},
    genCode: n => {
      let lmsg = n.props.message || "f'Value: {value}'";
      if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
      return [
        `# Logger`,
        `value = "data_from_upstream_node"`,
        `self.get_logger().${n.props.level}(${lmsg})`,
      ].join('\n');
    },
  },
  param: {
    label:'Parameter', emoji:'🎛', cls:'fn-param', portCls:'generic',
    hint:'Value adjustable at runtime without recompiling',
    defaultProps:{icon:'🎛', name:'max_speed', default:'1.0', type:'float'},
    ports:{out:[{id:'val',label:'value',top:'50%'}]},
    genCode: n => [
      `# Parameter: ${n.props.name}`,
      `self.declare_parameter('${n.props.name}', ${n.props.default})`,
      `self.${safeName(n.props.name)} = self.get_parameter('${n.props.name}').value`,
    ].join('\n'),
  },
  python_code: {
    label:'Python Code', emoji:'🐍', cls:'fn-code', portCls:'code',
    hint:'เขียน Python เฉพาะงานได้ตรงนี้ — รับค่าในตัวแปร value และส่งออกด้วย result',
    defaultProps:{icon:'🐍', title:'Custom logic', code:'result = value\n# เขียน Python เพิ่มได้ที่นี่'},
    ports:{inp:[{id:'value',label:'value in',top:'50%'}],out:[{id:'result',label:'result',top:'50%'}]},
    genCode:n=>`# ${n.props.title||'Custom Python'}\n${n.props.code||'result = value'}`,
  },

  tf_broadcaster: {
    label:'TF Broadcaster', emoji:'📡', cls:'fn-pub', portCls:'tf',
    hint:'Broadcast TF transforms — drag TF Frame nodes and connect to this',
    defaultProps:{icon:'📡', timer_period:'0.05'},
    ports:{inp:[{id:'frames',label:'frames',top:'50%'}]},
    genCode: n => [
      `# TF Broadcaster`,
      `self.tf_timer = self.create_timer(${n.props.timer_period}, self.broadcast_transforms)`,
    ].join('\n'),
  },
  tf_frame: {
    label:'TF Frame', emoji:'🔗', cls:'fn-srv', portCls:'tf',
    hint:'A coordinate frame in the TF tree — set position (x,y,z) and rotation (roll,pitch,yaw)',
    defaultProps:{
      icon:'🔗', frame_id:'base_link', child_frame_id:'laser_link',
      x:'0.0', y:'0.0', z:'0.1', roll:'0.0', pitch:'0.0', yaw:'0.0',
    },
    ports:{
      inp:[{id:'parent',label:'parent',top:'50%'}],
      out:[{id:'child',label:'child →',top:'50%'}],
    },
    genCode: n => [
      `# Dynamic TF Frame: ${n.props.frame_id} → ${n.props.child_frame_id}`,
    ].join('\n'),
  },
  tf_static: {
    label:'Static TF', emoji:'📌', cls:'fn-param', portCls:'tf',
    hint:'Static transform that never changes — for fixed sensors like camera, LiDAR',
    defaultProps:{
      icon:'📌', frame_id:'base_link', child_frame_id:'camera_link',
      x:'0.0', y:'0.0', z:'0.3', roll:'0.0', pitch:'0.0', yaw:'0.0',
    },
    ports:{
      inp:[{id:'parent',label:'parent',top:'50%'}],
      out:[{id:'child',label:'child →',top:'50%'}],
    },
    genCode: n => [
      `# Static TF Frame: ${n.props.frame_id} → ${n.props.child_frame_id}`,
    ].join('\n'),
  },
};

const EDGE_COLORS = {
  pub:'#4f8ef7', sub:'#3ecf8e', timer:'#f5a623',
  if:'#f06767', math:'#38b2ac', tf:'#9f7aea', code:'#2bb7da', generic:'#9da3c0',
};

function safeName(s){ return s.replace(/[^a-zA-Z0-9_]/g,'_').replace(/^_+/,''); }

function flowSwitchPalTab(tabId) {
  document.querySelectorAll('.pal-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.pal-tab-content').forEach(el => el.classList.remove('active'));
  document.getElementById('ptab-' + tabId)?.classList.add('active');
  document.getElementById('pcont-' + tabId)?.classList.add('active');
}

function flowFillPalette(){
  const scroll = document.getElementById('sb-flow');
  if(!scroll || scroll.dataset.filled) return;
  scroll.dataset.filled='1';
  
  const BLOCKS = [
    {type:'publisher', color:'#4f8ef7', cls:'pb-pub', label:'📤 ส่งข้อมูล', hint:'ส่งข้อมูลออกไปยัง ROS 2 topic'},
    {type:'subscriber',color:'#3ecf8e', cls:'pb-sub', label:'📥 รับข้อมูล',hint:'รับข้อมูลจาก ROS 2 topic เช่น /scan หรือ /odom'},
    {type:'timer',     color:'#f5a623', cls:'pb-timer',label:'⏰ ทำซ้ำ', hint:'สั่งให้โปรแกรมทำงานซ้ำตามเวลาที่กำหนด'},
    {type:'service',   color:'#9f7aea', cls:'pb-srv', label:'🔔 รับคำขอ', hint:'รอรับคำขอจาก ROS 2 service'},
  ];
  const LOGIC = [
    {type:'condition', color:'#f06767', cls:'pb-if',  label:'🔀 ถ้า...แล้ว...', hint:'ตรวจเงื่อนไขแบบ if/else'},
    {type:'math',      color:'#38b2ac', cls:'pb-math',label:'🧮 คำนวณ', hint:'คำนวณค่าด้วยสูตร'},
    {type:'variable',  color:'#9da3c0', cls:'pb-math',label:'#️⃣ ตัวเลข', hint:'กำหนดค่าคงที่หรือตัวเลข'},
    {type:'logger',    color:'#6b7090', cls:'pb-log', label:'💬 แสดงข้อความ', hint:'แสดงค่าใน Terminal เพื่อตรวจผลงาน'},
    {type:'param',     color:'#e67e22', cls:'pb-param',label:'🎚️ ค่าปรับแต่ง',hint:'ค่าที่เปลี่ยนได้ขณะใช้งาน'},
    {type:'python_code',color:'#2bb7da',cls:'pb-code', label:'🐍 เขียน Python',hint:'รับค่าด้วย value แล้วส่งคำตอบออกด้วย result'},
  ];
  
  const mkBlock = b => `
    <div class="pal-block ${b.cls}" draggable="true"
      ondragstart="palDragStart(event,'${b.type}')"
      onclick="palClick('${b.type}')"
      onmouseenter="palShowTooltip(event,'${escH(b.hint)}')"
      onmouseleave="palHideTooltip()">
      <span class="pal-dot" style="background:${b.color}"></span>${b.label}
    </div>`;

  const mkPresetBlock = (b, preset) => {
    const pStr = encodeURIComponent(JSON.stringify(preset));
    return `<div class="pal-block ${b.cls}" draggable="true"
      ondragstart="palDragStart(event,'${b.type}','${pStr}')"
      onclick="palClick('${b.type}','${pStr}')"
      onmouseenter="palShowTooltip(event,'${escH(b.hint)}')"
      onmouseleave="palHideTooltip()">
      <span class="pal-dot" style="background:${b.color}"></span>${b.label}
    </div>`;
  };

  const mkSection = (title, content, defaultOpen = true) => `
    <div class="pal-section" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;"
         onclick="const c=this.nextElementSibling; const a=this.querySelector('.chevron'); if(c.style.display==='none'){c.style.display='block';a.textContent='▾'}else{c.style.display='none';a.textContent='▸'}">
      <span>${title}</span>
      <span class="chevron" style="font-size:14px; opacity:0.6">${defaultOpen ? '▾' : '▸'}</span>
    </div>
    <div class="pal-group-content" style="display:${defaultOpen ? 'block' : 'none'}; padding-bottom: 2px;">
      ${content}
    </div>
  `;

  const tabsHtml = `
    <style>
      .pal-tabs { display: flex; background: var(--bg1); border-bottom: 1px solid var(--brd); position: sticky; top: 0; z-index: 10; }
      .pal-tab { flex: 1; text-align: center; padding: 10px 2px; font-size: 11px; font-weight: 600; color: var(--dim); cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; white-space: nowrap; user-select: none; }
      .pal-tab:hover { color: var(--txt); background: var(--bg2); }
      .pal-tab.active { color: var(--acc); border-bottom-color: var(--acc); background: var(--adim); }
      .pal-tab-content { display: none; padding-bottom: 10px; }
      .pal-tab-content.active { display: block; }
    </style>
    <div style="padding:11px 12px 7px"><strong style="display:block;font-size:12px;color:var(--txt)">🧩 กล่องคำสั่ง</strong><small style="color:var(--dim);font-size:9px">แตะหนึ่งครั้งเพื่อเพิ่มลงพื้นที่ทำงาน</small></div>
    <div class="pal-tabs">
      <div id="ptab-basic" class="pal-tab active" onclick="flowSwitchPalTab('basic')">เริ่มง่าย</div>
      <div id="ptab-tf" class="pal-tab" onclick="flowSwitchPalTab('tf')">ตำแหน่ง</div>
      <div id="ptab-odom" class="pal-tab" onclick="flowSwitchPalTab('odom')">ล้อ</div>
      <div id="ptab-others" class="pal-tab" onclick="flowSwitchPalTab('others')">ขั้นสูง</div>
    </div>
  `;

  const basicContent = `
    <div id="pcont-basic" class="pal-tab-content active">
      ${mkSection('1 · เริ่มจากตรงนี้', BLOCKS.filter(block=>['timer','subscriber'].includes(block.type)).map(mkBlock).join(''))}
      ${mkSection('2 · ให้หุ่นคิด', LOGIC.filter(block=>block.type==='python_code').map(mkBlock).join(''))}
      ${mkSection('3 · ดูหรือส่งคำตอบ', [...BLOCKS.filter(block=>block.type==='publisher'),...LOGIC.filter(block=>block.type==='logger')].map(mkBlock).join(''))}
      <div id="lib-pal-basic" hidden></div>
    </div>
  `;

  const tfContent = `
    <div id="pcont-tf" class="pal-tab-content">
      ${mkSection('🔗 TF Transform', 
        mkBlock({type:'tf_broadcaster', color:'#9f7aea', cls:'pb-srv', label:'📡 TF Broadcaster', hint:'Broadcasts all TF frames — add this once, then connect TF Frame nodes'}) +
        mkPresetBlock({type:'tf_frame', color:'#9f7aea', cls:'pb-srv', label:'🔗 TF Frame (Dynamic)', hint:'เฟรมพิกัดที่สามารถขยับได้ เช่น ล้อหุ่นยนต์'}, {icon:'🔗', child_frame_id:'moving_link'}) +
        mkPresetBlock({type:'tf_static', color:'#e67e22', cls:'pb-param', label:'📌 TF Static (Fixed)', hint:'เฟรมยึดติดตายตัว สำหรับเซนเซอร์ที่ไม่ได้ขยับ'}, {icon:'📌', child_frame_id:'camera_link', z:'0.2'})
      )}
      ${mkSection('🤖 Robot Parts (Presets)', 
        mkPresetBlock({type:'tf_frame', color:'#9f7aea', cls:'pb-srv', label:'🔄 Wheel (ล้อ)', hint:'ล้อหมุนได้ (Dynamic TF)'}, {icon:'🔄', child_frame_id:'wheel_link'}) +
        mkPresetBlock({type:'tf_static', color:'#e67e22', cls:'pb-param', label:'📷 Camera (กล้อง)', hint:'กล้องติดตายตัว (Static TF)'}, {icon:'📷', child_frame_id:'camera_link', z:'0.2'}) +
        mkPresetBlock({type:'tf_static', color:'#e67e22', cls:'pb-param', label:'📡 LiDAR (เลเซอร์)', hint:'เซนเซอร์เลเซอร์ (Static TF)'}, {icon:'📡', child_frame_id:'laser_link', z:'0.15'}) +
        mkPresetBlock({type:'tf_static', color:'#e67e22', cls:'pb-param', label:'📻 IMU (ความเร่ง)', hint:'เซนเซอร์ IMU (Static TF)'}, {icon:'📻', child_frame_id:'imu_link', z:'0.05'})
      )}
      ${mkSection('🧩 Custom (TF)', '<div id="lib-pal-tf"></div>', false)}
    </div>
  `;

  const odomContent = `
    <div id="pcont-odom" class="pal-tab-content">
      ${mkSection('🚗 Odometry', 
        mkPresetBlock({type:'subscriber', color:'#3ecf8e', cls:'pb-sub', label:'📍 Left Encoder (L)', hint:'รับค่า Encoder ล้อซ้าย (Int32/Int64)'}, {icon:'📍', topic:'/encoder_left', msgType:'std_msgs/Int64'}) +
        mkPresetBlock({type:'subscriber', color:'#3ecf8e', cls:'pb-sub', label:'📍 Right Encoder (R)', hint:'รับค่า Encoder ล้อขวา (Int32/Int64)'}, {icon:'📍', topic:'/encoder_right', msgType:'std_msgs/Int64'}) +
        mkPresetBlock({type:'publisher', color:'#4f8ef7', cls:'pb-pub', label:'🏎️ Cmd Vel Pub', hint:'ส่งความเร็วสั่งล้อหุ่นยนต์ (Twist)'}, {icon:'🏎️', topic:'/cmd_vel', msgType:'geometry_msgs/Twist'}) +
        mkPresetBlock({type:'publisher', color:'#4f8ef7', cls:'pb-pub', label:'🗺️ Odom Pub', hint:'ส่งค่าพิกัด Odometry ของหุ่นยนต์'}, {icon:'🗺️', topic:'/odom', msgType:'nav_msgs/Odometry'})
      )}
      ${mkSection('🧩 Custom (Odom & Kinematics)', '<div id="lib-pal-odom"></div>', true)}
    </div>
  `;

  const othersContent = `
    <div id="pcont-others" class="pal-tab-content">
      ${mkSection('🧠 Logic เพิ่มเติม', [...BLOCKS.filter(block=>block.type==='service'),...LOGIC.filter(block=>!['python_code','logger'].includes(block.type))].map(mkBlock).join(''), false)}
      ${mkSection('🛠️ Block ที่สร้างเอง', '<div style="display:flex;gap:5px;padding:5px 8px 9px"><button class="flow-btn" onclick="libOpenCreator()">＋ สร้าง Block</button><button class="flow-btn" onclick="libImportBlock()">นำเข้า</button></div><div id="lib-pal-others"></div>', false)}
    </div>
  `;

  // เติม <div style="height:120px;"></div> ให้เลื่อนจนสุดบน iPad ได้โดยไม่ถูกแถบบัง
  scroll.innerHTML = tabsHtml + basicContent + tfContent + odomContent + othersContent + `<div style="height:120px;"></div>`;

  libLoadAll();
  libRenderPalette();
}

let _palTooltipEl = null;
function palShowTooltip(e, text){
  if(!_palTooltipEl){
    _palTooltipEl = document.createElement('div');
    _palTooltipEl.id = 'pal-tooltip';
    _palTooltipEl.style.cssText = `position:fixed;z-index:9999;max-width:260px;padding:8px 12px;
      background:var(--bg2);border:1px solid var(--brdh);border-radius:8px;
      font-size:11px;line-height:1.6;color:var(--txt);pointer-events:none;
      box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:opacity .15s`;
    document.body.appendChild(_palTooltipEl);
  }
  _palTooltipEl.textContent = text;
  _palTooltipEl.style.opacity = '1';
  const rect = e.currentTarget.getBoundingClientRect();
  _palTooltipEl.style.left = (rect.right + 8) + 'px';
  _palTooltipEl.style.top  = rect.top + 'px';
  setTimeout(()=>{
    const tr = _palTooltipEl.getBoundingClientRect();
    if(tr.right > window.innerWidth - 10){
      _palTooltipEl.style.left = (rect.left) + 'px';
      _palTooltipEl.style.top  = (rect.bottom + 4) + 'px';
    }
  },0);
}
function palHideTooltip(){
  if(_palTooltipEl) _palTooltipEl.style.opacity = '0';
}

function flowSetCanvasState(enabled, msgTitle, msgSub){
  const wrap = document.getElementById('flow-canvas-wrap');
  const empty = document.getElementById('flow-empty');
  const nodes = document.getElementById('flow-nodes');
  const svg = document.getElementById('flow-svg');
  
  if(!enabled){
    if(wrap) { wrap.style.pointerEvents='none'; }
    if(nodes) nodes.style.display = 'none';
    if(svg) svg.style.display = 'none';
    
    if(empty) {
      empty.style.display='flex';
      empty.innerHTML = `<div class="flow-empty-icon" style="font-size:54px;opacity:.35">🤖</div>
                         <div class="flow-empty-text" style="font-size:16px;color:var(--txt);margin-top:10px;font-weight:900">${msgTitle || ''}</div>
                         <div class="flow-empty-sub" style="font-size:11px;color:var(--dim);margin-top:4px">${msgSub || ''}</div>`;
    }
    flowRenderInspector(); 
  } else {
    if(wrap) { wrap.style.pointerEvents='auto'; }
    if(nodes) nodes.style.display = 'block';
    if(svg) svg.style.display = 'block';
    
    if(empty && FLOW.nodes.length === 0){
      empty.style.display='flex';
      empty.innerHTML = `<div class="flow-empty-icon" style="font-size:54px;opacity:.3">🧩</div>
                         <div class="flow-empty-text" style="font-size:16px;color:var(--txt);margin-top:10px;font-weight:900">แตะกล่องคำสั่งทางซ้ายได้เลย</div>
                         <div class="flow-empty-sub" style="font-size:11px;color:var(--dim);margin-top:4px">ลองเริ่มด้วย ⏰ ทำซ้ำ → 🐍 เขียน Python → 💬 แสดงข้อความ</div>`;
    } else if(empty) {
      empty.style.display='none';
    }
  }
}

// ── Touch Handlers สำหรับพื้นหลัง Canvas (Pan & Zoom) ──
let _pinchStartDistFlow = null;
function canvasTouchStart(e) {
  if(e.target.closest('.fnode')||e.target.closest('.fport')||e.target.closest('.edge-del-btn')) return;
  e.preventDefault();
  
  if (e.touches.length === 1) {
    FLOW.panning = true;
    FLOW.panStart = {x: e.touches[0].clientX, y: e.touches[0].clientY, px: FLOW.pan.x, py: FLOW.pan.y};
    FLOW.selected = null;
    document.querySelectorAll('.fnode.selected').forEach(el=>el.classList.remove('selected'));
    flowRenderInspector();
  } else if (e.touches.length === 2) {
    FLOW.panning = false;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _pinchStartDistFlow = Math.hypot(dx, dy);
  }
}

function canvasTouchMove(e) {
  if(e.target.closest('.fnode')||e.target.closest('.fport')||e.target.closest('.edge-del-btn')) return;
  e.preventDefault();

  if (FLOW.panning && e.touches.length === 1) {
    FLOW.pan.x = FLOW.panStart.px + (e.touches[0].clientX - FLOW.panStart.x);
    FLOW.pan.y = FLOW.panStart.py + (e.touches[0].clientY - FLOW.panStart.y);
    document.getElementById('flow-nodes').style.transform = `translate(${FLOW.pan.x}px,${FLOW.pan.y}px) scale(${FLOW.zoom})`;
    flowRenderEdges();
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    
    if (_pinchStartDistFlow) {
      const zoomDelta = dist / _pinchStartDistFlow;
      FLOW.zoom = Math.min(2, Math.max(0.3, FLOW.zoom * zoomDelta));
      _pinchStartDistFlow = dist;
      document.getElementById('flow-nodes').style.transform = `translate(${FLOW.pan.x}px,${FLOW.pan.y}px) scale(${FLOW.zoom})`;
      flowRenderEdges();
    }
  }
}

function canvasTouchEnd(e) {
  FLOW.panning = false;
  _pinchStartDistFlow = null;
}

function initFlow(){
  if(!FLOW.flowInited){
    FLOW.flowInited=true;
    flowLoad();
    
    // Inject Tablet CSS Fixes (จัดเรียงจอสำหรับ Tablet ให้ Inspector อยู่ด้านล่าง + แก้ Scroll)
    if(!document.getElementById('flow-tablet-css')) {
      const style = document.createElement('style');
      style.id = 'flow-tablet-css';
      style.innerHTML = `
        /* Smooth scrolling for touch devices & Fix iOS Safari bottom bar cutoff */
        #insp-scroll, #sb-scroll, .modal-box, .insp-preview, #flow-code-preview, #run-pkg-scroll, #run-exe-scroll {
          -webkit-overflow-scrolling: touch;
        }
        /* Mobile & Portrait Tablet Layout */
        @media (max-width: 850px) {
          #flow-body { flex-direction: column !important; }
          #flow-inspector { width: 100% !important; border-left: none !important; border-top: 1px solid var(--brd); height: 45%; flex-shrink: 0; }
          #flow-canvas-wrap { flex: 1; min-height: 30%; }
        }
      `;
      document.head.appendChild(style);
    }

    // Binding Touch events for Canvas
    const wrap = document.getElementById('flow-canvas-wrap');
    if(wrap && !wrap.dataset.touchbound) {
      wrap.dataset.touchbound = '1';
      wrap.addEventListener('touchstart', canvasTouchStart, {passive: false});
      wrap.addEventListener('touchmove', canvasTouchMove, {passive: false});
      wrap.addEventListener('touchend', canvasTouchEnd);
      wrap.addEventListener('touchcancel', canvasTouchEnd);
    }
  }
  flowRender();
  
  const pkgSel = document.getElementById('flow-pkg-sel');
  if (pkgSel && !document.getElementById('btn-flow-wizard-main')) {
     const wizBtn = document.createElement('button');
     wizBtn.id = 'btn-flow-wizard-main';
     wizBtn.className = 'flow-btn primary';
     wizBtn.style.cssText = 'padding:4px 12px; font-size:11px; background:var(--adim); color:var(--acc); border:1px solid var(--abrd); font-weight:600; margin-left:6px;';
     wizBtn.innerHTML = '✦ Package Wizard';
     wizBtn.onclick = flowOpenWizard;
     pkgSel.parentNode.insertBefore(wizBtn, pkgSel.nextSibling);
     const oldBtn = pkgSel.parentNode.querySelector('button[title="สร้าง package ใหม่"]');
     if(oldBtn) oldBtn.style.display = 'none';
  }
  
  const pkg = pkgSel?.value;
  const file = document.getElementById('flow-file-sel')?.value;
  if(!pkg) flowSetCanvasState(false, 'กรุณาเลือก Package', 'เลือก Package ที่เมนูด้านบนเพื่อเริ่มต้นทำงาน');
  else if(!file || file === '_new') flowSetCanvasState(false, 'กรุณาเลือก File', `เลือกไฟล์ใน ${pkg} หรือสร้างไฟล์ใหม่`);
  else flowSetCanvasState(true);
}

let palDragTypeGlobal = null;
let palDragPresetGlobal = null;

function palDragStart(e, type, presetStr=''){
  palDragTypeGlobal = type;
  palDragPresetGlobal = presetStr ? JSON.parse(decodeURIComponent(presetStr)) : null;
  e.dataTransfer.setData('flow-type', type);
  e.dataTransfer.setData('flow-preset', presetStr);
  e.dataTransfer.effectAllowed = 'copy';
}

function palClick(type, presetStr=''){
  if(!isFlowFileSelected()) {
    alert('กรุณาเลือก Package และ File ก่อนเริ่มทำงาน');
    return;
  }
  const wrap = document.getElementById('flow-canvas-wrap');
  const cx = (wrap.offsetWidth/2  - FLOW.pan.x) / FLOW.zoom;
  const cy = (wrap.offsetHeight/2 - FLOW.pan.y) / FLOW.zoom;
  const preset = presetStr ? JSON.parse(decodeURIComponent(presetStr)) : null;
  flowAddNode(type, cx - 80, cy - 60, preset);
}

function canvasDrop(e){
  e.preventDefault();
  if(!isFlowFileSelected()) return;

  const type = e.dataTransfer.getData('flow-type') || palDragTypeGlobal;
  const presetStr = e.dataTransfer.getData('flow-preset');
  let preset = palDragPresetGlobal;
  if(presetStr) preset = JSON.parse(decodeURIComponent(presetStr));
  
  if(!type) return;
  const wrap = document.getElementById('flow-canvas-wrap');
  const rect = wrap.getBoundingClientRect();
  const x = (e.clientX - rect.left - FLOW.pan.x) / FLOW.zoom;
  const y = (e.clientY - rect.top  - FLOW.pan.y) / FLOW.zoom;
  flowAddNode(type, x - 80, y - 40, preset);
  
  palDragTypeGlobal = null;
  palDragPresetGlobal = null;
}

function flowAddNode(type, x, y, preset=null){
  const def = FLOW_TYPES[type];
  if(!def) return;
  const id = 'n' + (FLOW.nextId++);
  
  const node = {
    id, type, x, y,
    props: {...def.defaultProps, ...(preset||{})}, 
    label: def.label,
  };
  FLOW.nodes.push(node);
  flowSetCanvasState(true);
  flowRender();
  flowSelectNode(id);
  flowSave();
}

function flowRender(){
  flowRenderNodes();
  flowRenderEdges();
}

function flowRenderNodes(){
  const container = document.getElementById('flow-nodes');
  container.style.transform = `translate(${FLOW.pan.x}px,${FLOW.pan.y}px) scale(${FLOW.zoom})`;

  container.querySelectorAll('.fnode').forEach(el=>{
    if(!FLOW.nodes.find(n=>n.id===el.dataset.id)) el.remove();
  });

  FLOW.nodes.forEach(node=>{
    let el = container.querySelector(`[data-id="${node.id}"]`);
    if(!el){
      el = flowCreateNodeEl(node);
      container.appendChild(el);
    }
    el.style.left = node.x+'px';
    el.style.top  = node.y+'px';
    el.classList.toggle('selected', node.id===FLOW.selected);
    const bodyEl = el.querySelector('.fnode-props-container');
    if(bodyEl) bodyEl.innerHTML = flowNodeBody(node);
  });
}

function flowNodeBody(node){
  const props = node.props;
  return Object.entries(props).map(([k,v])=>
    (k !== 'icon' && k !== 'tab' && !k.startsWith('_lib')) ? `<div class="fnode-prop">
      <span class="fnode-prop-key">${k}:</span>
      <span class="fnode-prop-val" title="${escH(String(v))}">${escH(String(v))}</span>
    </div>` : ''
  ).join('');
}

function flowCreateNodeEl(node){
  const def = FLOW_TYPES[node.type];
  const el = document.createElement('div');
  el.className = `fnode ${def.cls}`;
  el.dataset.id = node.id;
  
  const icon = node.props.icon || def.emoji;
  const ports = def.ports||{};
  const inCount = ports.inp ? ports.inp.length : 0;
  const outCount = ports.out ? ports.out.length : 0;
  
  const maxPorts = Math.max(inCount, outCount);
  const headerHeight = 36;
  const portSpacing = 26; 
  const portStart = headerHeight + 14; 
  
  const portSpace = maxPorts > 0 ? (maxPorts * portSpacing) : 0;
  const paddingTop = Math.max(6, portSpace + 6);

  el.innerHTML = `
    <div class="fnode-head">
      <span class="fnode-emoji">${icon}</span>
      <span>${def.label}</span>
    </div>
    <div class="fnode-body" style="padding-top: ${paddingTop}px;">
      <div class="fnode-props-container">${flowNodeBody(node)}</div>
    </div>`;

  // Attach mouse and touch events
  if(ports.out) ports.out.forEach((p,i)=>{
    const topPx = portStart + (i * portSpacing);
    const port = document.createElement('div');
    port.className = `fport out ${def.portCls}`;
    port.style.top = `${topPx}px`;
    port.dataset.nodeId=node.id; port.dataset.portId=p.id; port.dataset.dir='out';
    port.title = p.label||'output';
    port.addEventListener('mousedown', portMouseDown);
    port.addEventListener('touchstart', portMouseDown, {passive: false}); // Touch support
    el.appendChild(port);

    const lbl = document.createElement('div');
    lbl.textContent = p.label || p.id;
    lbl.style.cssText = `position:absolute; right:12px; top:${topPx}px; transform:translateY(-50%); 
      font-size:10px; color:var(--txt); font-family:var(--mono); pointer-events:none; 
      background:transparent; white-space:nowrap; z-index:5; font-weight:600; opacity:0.8;`;
    el.appendChild(lbl);
  });
  
  if(ports.inp) ports.inp.forEach((p,i)=>{
    const topPx = portStart + (i * portSpacing);
    const port = document.createElement('div');
    port.className = `fport inp ${def.portCls}`;
    port.style.top = `${topPx}px`;
    port.dataset.nodeId=node.id; port.dataset.portId=p.id; port.dataset.dir='inp';
    port.title = p.label||'input';
    port.addEventListener('mousedown', portMouseDown);
    port.addEventListener('touchstart', portMouseDown, {passive: false}); // Touch support
    el.appendChild(port);

    const lbl = document.createElement('div');
    lbl.textContent = p.label || p.id;
    lbl.style.cssText = `position:absolute; left:12px; top:${topPx}px; transform:translateY(-50%); 
      font-size:10px; color:var(--txt); font-family:var(--mono); pointer-events:none; 
      background:transparent; white-space:nowrap; z-index:5; font-weight:600; opacity:0.8;`;
    el.appendChild(lbl);
  });

  el.addEventListener('mousedown', nodeMouseDown);
  el.addEventListener('touchstart', nodeMouseDown, {passive: false}); // Touch support
  return el;
}

// ── Node Dragging (Mouse & Touch) ──
function nodeMouseDown(e){
  if(e.target.classList.contains('fport')) return;
  const isTouch = e.type === 'touchstart';
  if(!isTouch && e.button !== 0) return; // Only left click for mouse

  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget;
  const id = el.dataset.id;
  flowSelectNode(id);
  const node = FLOW.nodes.find(n=>n.id===id);
  if(!node) return;

  const toCanvas = (sx,sy) => ({
    x: (sx - FLOW.pan.x) / FLOW.zoom,
    y: (sy - FLOW.pan.y) / FLOW.zoom,
  });

  const clientX = isTouch ? e.touches[0].clientX : e.clientX;
  const clientY = isTouch ? e.touches[0].clientY : e.clientY;

  const canvasStart = toCanvas(clientX, clientY);
  const origX = node.x;
  const origY = node.y;

  const onMove = e2 => {
    if(isTouch) e2.preventDefault();
    const cx = isTouch ? e2.touches[0].clientX : e2.clientX;
    const cy = isTouch ? e2.touches[0].clientY : e2.clientY;
    
    const canvasCur = toCanvas(cx, cy);
    node.x = origX + (canvasCur.x - canvasStart.x);
    node.y = origY + (canvasCur.y - canvasStart.y);
    el.style.left = node.x + 'px';
    el.style.top  = node.y + 'px';
    flowRenderEdges();
  };

  const onUp = () => {
    document.removeEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
    document.removeEventListener(isTouch ? 'touchend' : 'mouseup',  onUp);
    if(isTouch) document.removeEventListener('touchcancel', onUp);
    flowSave();
  };

  document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove, isTouch ? {passive:false} : false);
  document.addEventListener(isTouch ? 'touchend' : 'mouseup',  onUp);
  if(isTouch) document.addEventListener('touchcancel', onUp);
}

// ── Port Dragging & Connecting (Mouse & Touch) ──
function portMouseDown(e){
  e.preventDefault();
  e.stopPropagation();
  
  const isTouch = e.type === 'touchstart';
  const clientX = isTouch ? e.touches[0].clientX : e.clientX;
  const clientY = isTouch ? e.touches[0].clientY : e.clientY;

  const port = e.currentTarget;
  const nodeId=port.dataset.nodeId, portId=port.dataset.portId, dir=port.dataset.dir;

  if(dir==='inp'){
    FLOW.edges=FLOW.edges.filter(ed=>!(ed.to===nodeId&&ed.toPort===portId));
    flowRenderEdges();
    return;
  }

  const wrap=document.getElementById('flow-canvas-wrap');
  const rect=wrap.getBoundingClientRect();
  const svg=document.getElementById('flow-svg');

  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  const nodeDef = FLOW.nodes.find(n=>n.id===nodeId);
  const typeDef = FLOW_TYPES[nodeDef?.type||'publisher'];
  const col = EDGE_COLORS[typeDef?.portCls] || '#9da3c0';
  path.setAttribute('class','fedge');
  path.setAttribute('stroke',col);
  path.style.color=col;
  path.style.pointerEvents = 'none'; // Critical for touch elementFromPoint
  svg.appendChild(path);
  FLOW.connecting={fromNodeId:nodeId, fromPort:portId, pathEl:path, col, portCls: typeDef?.portCls};

  function getPortPos(nId, pId, pDir){
    const el=document.querySelector(`[data-id="${nId}"] [data-port-id="${pId}"]`);
    if(!el) return null;
    const nr=el.getBoundingClientRect();
    return {x:(nr.left+nr.width/2-rect.left), y:(nr.top+nr.height/2-rect.top)};
  }

  const fromPos=getPortPos(nodeId,portId,'out');
  if(!fromPos){svg.removeChild(path);FLOW.connecting=null;return;}

  const onMove = e2 => {
    if(isTouch) e2.preventDefault();
    if(!FLOW.connecting) return;
    
    const cx = isTouch ? e2.touches[0].clientX : e2.clientX;
    const cy = isTouch ? e2.touches[0].clientY : e2.clientY;

    const mx=cx-rect.left, my=cy-rect.top;
    path.setAttribute('d',bezier(fromPos.x,fromPos.y,mx,my));

    document.querySelectorAll('.fport.inp').forEach(p=>{
      const toNodeId = p.dataset.nodeId;
      const toNode = FLOW.nodes.find(n => n.id === toNodeId);
      const toPortCls = FLOW_TYPES[toNode?.type]?.portCls || '';
      const fromPortCls = FLOW.connecting.portCls;
      
      const isCompatible = (fromPortCls === 'tf') === (toPortCls === 'tf');
      if(!isCompatible) {
          p.classList.remove('hover');
          return;
      }

      const pr=p.getBoundingClientRect();
      const px=pr.left+pr.width/2-rect.left, py=pr.top+pr.height/2-rect.top;
      // เพิ่มรัศมีการดูด (snap) ให้กว้างขึ้นสำหรับนิ้วมือ (touch)
      p.classList.toggle('hover', Math.hypot(mx-px,my-py) < (isTouch ? 35 : 18));
    });
  };

  const onUp = e2 => {
    document.removeEventListener(isTouch ? 'touchmove' : 'mousemove',onMove);
    document.removeEventListener(isTouch ? 'touchend' : 'mouseup',onUp);
    if(isTouch) document.removeEventListener('touchcancel',onUp);
    
    let upX = clientX, upY = clientY;
    if (!isTouch) {
       upX = e2.clientX; upY = e2.clientY;
    } else if (e2.changedTouches && e2.changedTouches.length > 0) {
       upX = e2.changedTouches[0].clientX; upY = e2.changedTouches[0].clientY;
    }

    let target = document.elementFromPoint(upX, upY);
    
    // สำหรับ Touch หากนิ้วบังเป้าหมาย ให้เช็คจากสถานะ .hover แทน
    if(isTouch) {
        const hovered = document.querySelector('.fport.inp.hover');
        if(hovered) target = hovered;
    }
    
    document.querySelectorAll('.fport.hover').forEach(p=>p.classList.remove('hover'));

    if(target?.classList.contains('fport')&&target.dataset.dir==='inp'){
      const toNodeId=target.dataset.nodeId, toPortId=target.dataset.portId;

      const toNode = FLOW.nodes.find(n => n.id === toNodeId);
      const toPortCls = FLOW_TYPES[toNode?.type]?.portCls || '';
      const fromPortCls = FLOW.connecting.portCls;
      const isCompatible = (fromPortCls === 'tf') === (toPortCls === 'tf');

      if(toNodeId!==nodeId && isCompatible){

        if(FLOW.connecting.portCls === 'tf' && toPortId === 'parent'){
          FLOW.edges = FLOW.edges.filter(ed => !(ed.to === toNodeId && ed.toPort === 'parent'));
          const fromNode = FLOW.nodes.find(n=>n.id===nodeId);
          const toNode = FLOW.nodes.find(n=>n.id===toNodeId);
          if(fromNode && toNode) {
            toNode.props.frame_id = fromNode.props.child_frame_id || 'base_link'; 
            const bodyEl = document.querySelector(`[data-id="${toNodeId}"] .fnode-props-container`);
            if(bodyEl) bodyEl.innerHTML = flowNodeBody(toNode);
          }
        } else {
          FLOW.edges=FLOW.edges.filter(ed=>!(ed.to===toNodeId&&ed.toPort===toPortId));
        }

        FLOW.edges.push({
          id:'e'+(FLOW.nextId++),
          from:nodeId,fromPort:portId,
          to:toNodeId,toPort:toPortId,
        });
        flowSave();
      } else if (!isCompatible) {
        sbMsg('เชื่อมต่อไม่ได้: TF Node ต้องเชื่อมต่อกับ TF ด้วยกันเท่านั้น', 3000);
      }
    }
    if(svg.contains(path)) svg.removeChild(path);
    FLOW.connecting=null;
    flowRenderEdges();
  };
  
  document.addEventListener(isTouch ? 'touchmove' : 'mousemove',onMove, isTouch ? {passive:false} : false);
  document.addEventListener(isTouch ? 'touchend' : 'mouseup',onUp);
  if(isTouch) document.addEventListener('touchcancel',onUp);
}

function bezier(x1,y1,x2,y2){
  const dx=Math.abs(x2-x1)*0.5;
  return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
}

function flowRenderEdges(){
  const svg=document.getElementById('flow-svg');
  const wrap=document.getElementById('flow-canvas-wrap');
  const rect=wrap.getBoundingClientRect();

  svg.querySelectorAll('.fedge-g').forEach(el=>el.remove());

  FLOW.edges.forEach(edge=>{
    const fromEl=document.querySelector(`[data-id="${edge.from}"] [data-port-id="${edge.fromPort}"][data-dir="out"]`);
    const toEl  =document.querySelector(`[data-id="${edge.to}"]   [data-port-id="${edge.toPort}"][data-dir="inp"]`);
    if(!fromEl||!toEl) return;

    const fr=fromEl.getBoundingClientRect();
    const tr=toEl.getBoundingClientRect();
    const x1=fr.left+fr.width/2-rect.left, y1=fr.top+fr.height/2-rect.top;
    const x2=tr.left+tr.width/2-rect.left, y2=tr.top+tr.height/2-rect.top;

    const def=FLOW_TYPES[FLOW.nodes.find(n=>n.id===edge.from)?.type];
    const col=EDGE_COLORS[def?.portCls]||'#9da3c0';

    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    g.className.baseVal='fedge-g';

    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('class','fedge');
    path.setAttribute('stroke',col);
    path.style.color=col;
    path.setAttribute('d',bezier(x1,y1,x2,y2));

    const hit=document.createElementNS('http://www.w3.org/2000/svg','path');
    hit.setAttribute('d',bezier(x1,y1,x2,y2));
    hit.setAttribute('stroke','transparent');
    hit.setAttribute('stroke-width','25'); // เพิ่มพื้นที่กดลบสำหรับนิ้ว 
    hit.setAttribute('fill','none');
    hit.style.cursor='pointer';

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    const delG = document.createElementNS('http://www.w3.org/2000/svg','g');
    delG.setAttribute('class', 'edge-del-btn');
    delG.style.opacity = '0';
    delG.style.transition = 'opacity 0.15s, transform 0.15s';
    delG.style.transformOrigin = `${midX}px ${midY}px`; 
    delG.style.cursor = 'pointer';

    const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
    circle.setAttribute('cx', midX);
    circle.setAttribute('cy', midY);
    circle.setAttribute('r', '12'); // ขยายให้กดลบง่ายขึ้นในมือถือ
    circle.setAttribute('fill', '#f06767'); 
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1.5');

    const cross = document.createElementNS('http://www.w3.org/2000/svg','path');
    const s = 4; 
    cross.setAttribute('d', `M${midX-s},${midY-s} L${midX+s},${midY+s} M${midX+s},${midY-s} L${midX-s},${midY+s}`);
    cross.setAttribute('stroke', '#fff');
    cross.setAttribute('stroke-width', '2.5');
    cross.setAttribute('stroke-linecap', 'round');
    cross.setAttribute('pointer-events', 'none');

    delG.appendChild(circle);
    delG.appendChild(cross);

    g.addEventListener('mouseenter', () => {
      path.setAttribute('stroke-width', '4');
      delG.style.opacity = '1';
    });
    g.addEventListener('mouseleave', () => {
      path.setAttribute('stroke-width', '2.5');
      delG.style.opacity = '0';
      delG.style.transform = 'scale(1)';
    });
    delG.addEventListener('mouseenter', () => { delG.style.transform = 'scale(1.2)'; });
    delG.addEventListener('mouseleave', () => { delG.style.transform = 'scale(1)'; });

    const deleteAction = (e) => {
      e.stopPropagation();
      FLOW.edges = FLOW.edges.filter(e => e.id !== edge.id);
      flowRenderEdges();
      flowSave();
    };

    delG.addEventListener('click', deleteAction);
    delG.addEventListener('touchstart', deleteAction, {passive: false}); // รองรับทัชที่ปุ่ม ✕
    hit.addEventListener('click', deleteAction);

    g.appendChild(path);
    g.appendChild(hit);
    g.appendChild(delG);
    svg.appendChild(g);
  });
}

function flowSelectNode(id){
  FLOW.selected=id;
  document.querySelectorAll('.fnode').forEach(el=>el.classList.toggle('selected',el.dataset.id===id));
  flowRenderInspector();
}

function flowDisplayMsgType(type){return String(type||'').replace('/msg/','/').replace('/srv/','/');}
function flowSelectTopic(nodeId,topicName){
  const node=FLOW.nodes.find(item=>item.id===nodeId);if(!node)return;
  let selected=String(topicName||'');
  if(selected==='__custom__')selected=String(prompt('ชื่อ Topic ใหม่ เช่น /robot/speed',node.props.topic||'/my_topic')||'').trim();
  if(!selected){flowRenderInspector();return;}
  node.props.topic=selected;
  const topic=(window._cachedTopics||[]).find(item=>item.name===selected);if(topic?.type)node.props.msgType=flowDisplayMsgType(topic.type);
  const propsEl=document.querySelector(`[data-id="${nodeId}"] .fnode-props-container`);if(propsEl)propsEl.innerHTML=flowNodeBody(node);
  flowRenderInspector();flowSave();
}

function flowRenderInspector(){
  const el=document.getElementById('insp-content');
  if(!isFlowFileSelected()) {
    el.innerHTML='<div style="color:var(--dim);font-size:12px;text-align:center;padding:28px 10px">📦 เลือก Package และไฟล์ก่อน<br><small>หรือกด “สร้าง Custom Package” ด้านบน</small></div>';
    return;
  }
  
  const node=FLOW.nodes.find(n=>n.id===FLOW.selected);
  if(!node){
    el.innerHTML='<div style="color:var(--dim);font-size:12px;text-align:center;padding:28px 10px">👈 แตะ Block ที่วางไว้<br><small>แล้วตั้งค่าได้ตรงนี้</small></div>';
    return;
  }
  const def=FLOW_TYPES[node.type];
  const propFields=Object.entries(node.props).map(([k,v])=>{
    if(k.startsWith('_lib') || k === 'tab') return '';

    if(k === 'icon'){
      const icons = ['📢','📥','⏱','⚙','🔀','🔢','📋','🎛','📡','🔗','📌','🔄','📷','📻','📍','🏎️','🗺️','🚗','🎯','🛑','⭐','⚡','🔧','🧩','🤖','🚀','#️⃣','🧮','🚙'];
      if(v && !icons.includes(v)) icons.unshift(v); 
      return `<div class="insp-field">
        <div class="insp-label">Icon (ไอคอน)</div>
        <select class="insp-select" style="font-size:14px; padding:4px;" onchange="flowUpdateProp('${node.id}','${k}',this.value)">
          ${icons.map(i=>`<option value="${i}" ${v===i?'selected':''}>${i}</option>`).join('')}
        </select>
      </div>`;
    }

    const isMulti = String(v).length>40 || k==='formula'||k==='condition'||k==='message'||k==='code';
    if(isMulti){
      return `<div class="insp-field">
        <div class="insp-label">${k==='code'?'Python code · input: value · output: result':k}</div>
        <textarea class="insp-code" style="${k==='code'?'min-height:190px':''}" onkeydown="if(event.key==='Tab'){event.preventDefault();const s=this.selectionStart;this.setRangeText('    ',s,this.selectionEnd,'end')}" onchange="flowUpdateProp('${node.id}','${k}',this.value)">${escH(String(v))}</textarea>
      </div>`;
    }
    if(k==='level'){
      return `<div class="insp-field">
        <div class="insp-label">${k}</div>
        <select class="insp-select" onchange="flowUpdateProp('${node.id}','${k}',this.value)">
          ${['debug','info','warn','error'].map(l=>`<option${v===l?' selected':''}>${l}</option>`).join('')}
        </select>
      </div>`;
    }
    if(k==='topic'){
      const topics=window._cachedTopics||[],groups=new Map();for(const topic of topics){const type=topic.type||'ไม่ทราบชนิด';if(!groups.has(type))groups.set(type,[]);groups.get(type).push(topic);}
      const known=topics.some(topic=>topic.name===String(v));
      const topicOptions=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([type,items])=>`<optgroup label="${escH(flowDisplayMsgType(type))}">${items.sort((a,b)=>a.name.localeCompare(b.name)).map(topic=>`<option value="${escH(topic.name)}" ${topic.name===v?'selected':''}>${escH(topic.name)}</option>`).join('')}</optgroup>`).join('');
      return `<div class="insp-field">
        <div class="insp-label">Topic ที่ต้องการใช้</div>
        <select class="insp-select" onchange="flowSelectTopic('${node.id}',this.value)">
          ${!known?`<option value="${escH(String(v))}" selected>${escH(String(v))} · กำหนดเอง</option>`:''}
          <option value="">— เลือก Topic จากหุ่นยนต์ —</option>${topicOptions}<option value="__custom__">＋ พิมพ์ Topic ใหม่…</option>
        </select>
        <small class="topic-combo-note">จัดกลุ่มตาม Message Type · เลือกแล้วชนิดข้อมูลจะเปลี่ยนให้อัตโนมัติ</small>
      </div>`;
    }

    if(k==='msgType' || k==='srvType'){
      const isSrv = k === 'srvType';
      const commonMsgs = [
        'std_msgs/String', 'std_msgs/Bool', 'std_msgs/Int32', 'std_msgs/Int64', 'std_msgs/Float32', 'std_msgs/Float64',
        'geometry_msgs/Twist', 'geometry_msgs/Pose', 'geometry_msgs/PoseStamped',
        'sensor_msgs/LaserScan', 'sensor_msgs/Image', 'sensor_msgs/Imu',
        'nav_msgs/Odometry', 'nav_msgs/Path'
      ];
      const commonSrvs = [
        'std_srvs/SetBool', 'std_srvs/Trigger', 'std_srvs/Empty'
      ];
      const baseList = isSrv ? commonSrvs : commonMsgs;
      const customList = window._customMsgTypes || [];
      const fullList = [...new Set([...baseList, ...customList])];
      
      if(v && !fullList.includes(String(v))) fullList.push(String(v));

      const options = fullList.map(m => `<option value="${escH(m)}" ${v===m?'selected':''}>${escH(m)}</option>`).join('');
      
      return `<div class="insp-field">
        <div class="insp-label">${k}</div>
        <select class="insp-select" onchange="if(this.value==='_custom_'){ flowCustomTypeDialog('${node.id}', '${k}'); } else { flowUpdateProp('${node.id}','${k}',this.value); }">
          ${options}
          <option value="_custom_" style="color:var(--acc);font-weight:bold;">+ เพิ่ม Type ใหม่... (Custom)</option>
        </select>
      </div>`;
    }

    return `<div class="insp-field">
      <div class="insp-label">${k}</div>
      <input class="insp-input" value="${escH(String(v))}" onchange="flowUpdateProp('${node.id}','${k}',this.value)"/>
    </div>`;
  }).join('');

  let codePreview='';
  try{ codePreview=def.genCode(node); }catch(e){ codePreview=''; }
  
  const icon = node.props.icon || def.emoji;

  // เติม <div style="padding-bottom:120px;"> ให้เลื่อนจนสุดบน iPad ได้โดยไม่ถูกแถบบัง
  el.innerHTML=`
    <div style="padding-bottom: 120px;">
      <div class="insp-title">${icon} ${def.label}</div>
      <div style="font-size:10px;color:var(--dim);margin-bottom:10px;line-height:1.5">${def.hint}</div>
      <div class="insp-sep"></div>
      <div class="insp-group"><div class="insp-group-title">⚙️ ตั้งค่า BLOCK</div>${propFields}</div>
      ${node.type.startsWith('lib_') ? libInspectorExtras(node, def) : ''}
      <div class="insp-sep"></div>
      <div class="insp-group"><div class="insp-group-title">🐍 ตัวอย่าง PYTHON ที่จะสร้าง</div><div class="insp-preview"><span class="pc"># Python snippet</span>\n${escH(codePreview)}</div></div>
      <div class="insp-sep"></div>
      <button class="insp-del" onclick="flowDeleteNode(decodeURIComponent('${encArg(node.id)}'))">🗑 Delete this node</button>
    </div>`;
}

function flowUpdateProp(nodeId, key, val){
  const node=FLOW.nodes.find(n=>n.id===nodeId);
  if(!node) return;
  node.props[key]=val;
  
  const propsEl=document.querySelector(`[data-id="${nodeId}"] .fnode-props-container`);
  if(propsEl) propsEl.innerHTML=flowNodeBody(node);
  
  if(key === 'icon') {
    const headEmoji = document.querySelector(`[data-id="${nodeId}"] .fnode-emoji`);
    if(headEmoji) headEmoji.textContent = val || FLOW_TYPES[node.type].emoji;
  }
  
  flowRenderInspector();
  flowSave();
}

function flowDeleteNode(id){
  FLOW.nodes=FLOW.nodes.filter(n=>n.id!==id);
  FLOW.edges=FLOW.edges.filter(e=>e.from!==id&&e.to!==id);
  document.querySelector(`[data-id="${id}"]`)?.remove();
  FLOW.selected=null;
  flowRenderInspector();
  flowRenderEdges();
  flowSetCanvasState(true);
  flowSave();
}

function canvasPanStart(e){
  if(e.target.closest('.fnode')||e.target.closest('.fport')||e.target.closest('.edge-del-btn')) return;
  if(e.button === 2){
    e.preventDefault();
    FLOW.selected = null;
    showCanvasProperties();
    return;
  }
  FLOW.panning=true;
  FLOW.panStart={x:e.clientX,y:e.clientY,px:FLOW.pan.x,py:FLOW.pan.y};
  FLOW.selected=null;
  document.querySelectorAll('.fnode.selected').forEach(el=>el.classList.remove('selected'));
  flowRenderInspector();

  const onMove=e2=>{
    if(!FLOW.panning) return;
    FLOW.pan.x=FLOW.panStart.px+(e2.clientX-FLOW.panStart.x);
    FLOW.pan.y=FLOW.panStart.py+(e2.clientY-FLOW.panStart.y);
    document.getElementById('flow-nodes').style.transform=
      `translate(${FLOW.pan.x}px,${FLOW.pan.y}px) scale(${FLOW.zoom})`;
    flowRenderEdges();
  };
  const onUp=()=>{
    FLOW.panning=false;
    document.removeEventListener('mousemove',onMove);
    document.removeEventListener('mouseup',onUp);
  };
  document.addEventListener('mousemove',onMove);
  document.addEventListener('mouseup',onUp);
}

function showCanvasProperties(){
  const el = document.getElementById('insp-content');
  if(!el) return;
  el.innerHTML = `
    <div class="insp-title">⚙ Canvas Properties</div>
    <div class="insp-sep"></div>
    <div class="insp-field">
      <div class="insp-label">Flow Mode</div>
      <select class="insp-select" onchange="FLOW.canvasMode=this.value;showCanvasProperties()" value="${FLOW.canvasMode}">
        <option value="general" ${FLOW.canvasMode==='general'?'selected':''}>🤖 General (Pub/Sub/Timer)</option>
        <option value="tf" ${FLOW.canvasMode==='tf'?'selected':''}>🔗 TF Transform Tree</option>
        <option value="odom" ${FLOW.canvasMode==='odom'?'selected':''}>🚗 Odometry / Navigation</option>
        <option value="sensor" ${FLOW.canvasMode==='sensor'?'selected':''}>📡 Sensor Processing</option>
      </select>
      <div style="font-size:10px;color:var(--dim);margin-top:4px;line-height:1.5">
        ${FLOW.canvasMode==='general' ? 'Standard ROS2 node — Publisher, Subscriber, Timer, Service' :
          FLOW.canvasMode==='tf' ? 'TF tree mode — drag TF Frame blocks to build your robot coordinate tree' :
          FLOW.canvasMode==='odom' ? 'Odometry mode — subscribe odom, compute transforms, publish cmd_vel' :
          'Sensor pipeline — subscribe sensor data, process, and publish results'}
      </div>
    </div>
    <div class="insp-sep"></div>
    <div class="insp-field">
      <div class="insp-label">Canvas Stats</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--mt);line-height:1.8">
        Nodes: ${FLOW.nodes.length}<br>
        Connections: ${FLOW.edges.length}<br>
        Zoom: ${(FLOW.zoom*100).toFixed(0)}%<br>
        Pan: (${FLOW.pan.x.toFixed(0)}, ${FLOW.pan.y.toFixed(0)})
      </div>
    </div>
    <div class="insp-sep"></div>
    <div style="font-size:10px;color:var(--dim);line-height:1.6">
      <b>Tip:</b> Right-click empty canvas to see this panel.<br>
      Left-click a node to edit its properties.
    </div>`;
}

function canvasZoom(e){
  e.preventDefault();
  const delta=e.deltaY>0?0.9:1.1;
  FLOW.zoom=Math.min(2,Math.max(0.3,FLOW.zoom*delta));
  document.getElementById('flow-nodes').style.transform=
    `translate(${FLOW.pan.x}px,${FLOW.pan.y}px) scale(${FLOW.zoom})`;
  flowRenderEdges();
}

function flowAutoLayout(){
  if(!isFlowFileSelected()) return;
  if(FLOW.nodes.length===0) return;
  const cols=Math.ceil(Math.sqrt(FLOW.nodes.length));
  const W=200,H=160,padX=60,padY=40;
  FLOW.nodes.forEach((n,i)=>{
    n.x=padX+(i%cols)*(W+padX);
    n.y=padY+Math.floor(i/cols)*(H+padY);
  });
  FLOW.pan={x:40,y:40};
  flowRender();
  flowSave();
}

function flowClear(){
  if(!isFlowFileSelected()) return;
  if(FLOW.nodes.length>0&&!confirm('Clear entire canvas?')) return;
  flowClearCanvas();
  flowSave();
}

function flowSave(){
  try{
    localStorage.setItem('ros2ide_flow',JSON.stringify({
      nodes:FLOW.nodes,edges:FLOW.edges,nextId:FLOW.nextId,pan:FLOW.pan,zoom:FLOW.zoom
    }));
  }catch(e){}
}

function flowLoad(){
  FLOW.nodes=[]; FLOW.edges=[]; FLOW.pan={x:40,y:40}; FLOW.zoom=1;
}

async function flowLoadTopics(){
  if(!sessionId||!rosInfo) return;
  const r=await API('/api/exec',{sessionId,
    command:`bash -lc "source ${rosInfo.setupBash} 2>/dev/null && ros2 topic list -t 2>/dev/null"`,
    timeout:6000});
  const lines=(r.stdout||'').split('\n').filter(Boolean);
  window._cachedTopics = lines.map(line=>{
    const m=line.match(/^(\S+)\s+\[(.+)\]$/);
    return m ? {name:m[1], type:m[2]} : {name:line.trim(), type:''};
  });
  if(FLOW.selected) flowRenderInspector();
}

function flowRefreshTopics(){
  flowLoadTopics();
  if(window._topicRefreshTimer) clearInterval(window._topicRefreshTimer);
  window._topicRefreshTimer = setInterval(flowLoadTopics, 15000);
}

function palDragTopicStart(e,name,type){
  palDragTypeGlobal='subscriber';
  e.dataTransfer.setData('flow-type','subscriber');
  e.dataTransfer.setData('flow-topic',name);
  e.dataTransfer.setData('flow-topic-type',type);
  e.dataTransfer.effectAllowed='copy';
}

function palAddTopic(name,type){
  if(!isFlowFileSelected()) {
    alert('กรุณาเลือก Package และ File ก่อนครับ');
    return;
  }
  const wrap=document.getElementById('flow-canvas-wrap');
  const cx=(wrap.offsetWidth/2-FLOW.pan.x)/FLOW.zoom;
  const cy=(wrap.offsetHeight/2-FLOW.pan.y)/FLOW.zoom;
  const node={
    id:'n'+(FLOW.nextId++),type:'subscriber',x:cx-80,y:cy-60,
    props:{topic:name,msgType:type||'sensor_msgs/LaserScan',qos:'10'},
  };
  FLOW.nodes.push(node);
  flowSetCanvasState(true);
  flowRender();flowSelectNode(node.id);flowSave();
}

function flowChangePkg(){
  const val=document.getElementById('flow-pkg-sel').value;
  FLOW.pkg=val||null;
  const exeEl=document.getElementById('flow-exe-name');
  if(exeEl&&!exeEl.value&&val) exeEl.placeholder=val+'_node';
  const fileSel=document.getElementById('flow-file-sel');
  const newFileBtn=document.getElementById('btn-flow-newfile');
  if(!val){
    if(fileSel){fileSel.innerHTML='<option value="">— Select file —</option>';fileSel.disabled=true;}
    if(newFileBtn) newFileBtn.disabled=true;
    document.getElementById('btn-flow-save').disabled=true;
    flowHint('');
    flowClearCanvas();
    flowSetCanvasState(false, 'กรุณาเลือก Package', 'เลือก Package ที่เมนูด้านบนเพื่อเริ่มต้นทำงาน');
    return;
  }
  if(newFileBtn) newFileBtn.disabled=false;
  flowLoadFiles(val);
  flowClearCanvas();
  flowSetCanvasState(false, 'กรุณาเลือก File', `เลือกไฟล์ใน ${val} หรือสร้างไฟล์ใหม่`);
  flowHint('Package: '+val+' — Select file to save flow or create new');
}

async function flowLoadFiles(pkg){
  if(!sessionId||!pkg) return;
  const pkgPath=wsPath+'/src/'+pkg+'/'+pkg;
  const r=await API('/api/files/list',{sessionId,path:pkgPath});
  const sel=document.getElementById('flow-file-sel');
  if(!sel) return;
  sel.disabled=false;
  if(!r.ok){
    sel.innerHTML='<option value="_new">+ Create new file</option>';
    return;
  }
  const pyFiles=r.items.filter(i=>!i.isDir&&i.name.endsWith('.py')&&i.name!=='__init__.py');
  const flowFiles=new Set(r.items.filter(i=>i.name.endsWith('.flow.json')).map(i=>i.name.replace('.flow.json','.py')));
  sel.innerHTML='<option value="">— Select file —</option>'+
    pyFiles.map(f=>`<option value="${escH(f.name)}">${flowFiles.has(f.name)?'✦ ':''}${escH(f.name)}</option>`).join('')+
    '<option value="_new">+ Create new file...</option>';
}

async function flowChangeFile(){
  const sel=document.getElementById('flow-file-sel');
  const val=sel?.value;
  if(val==='_new'){ flowNewFileDialog(); sel.value=''; return; }

  if(!val){
    flowClearCanvas();
    document.getElementById('btn-flow-save').disabled=true;
    flowHint('');
    flowSetCanvasState(false, 'กรุณาเลือก File', `เลือกไฟล์ใน ${FLOW.pkg} หรือสร้างไฟล์ใหม่`);
    return;
  }

  const exeEl=document.getElementById('flow-exe-name');
  if(exeEl) exeEl.value=val.replace(/\.py$/,'');
  
  if(sessionId && FLOW.pkg){
    const flowJsonPath=`${wsPath}/src/${FLOW.pkg}/${FLOW.pkg}/${val.replace(/\.py$/,'')}.flow.json`;
    flowHint('⏳ Loading flow...');
    const r=await API('/api/files/read',{sessionId,path:flowJsonPath});
    if(r.ok){
      try{
        const data=JSON.parse(r.content);
        FLOW.nodes=data.nodes||[];
        FLOW.edges=data.edges||[];
        FLOW.nextId=data.nextId||1;
        FLOW.pan=data.pan||{x:40,y:40};
        FLOW.zoom=data.zoom||1;
        flowSetCanvasState(true);
        flowRender();
        flowHint('✓ Loaded flow from '+val.replace('.py','')+'.flow.json ('+FLOW.nodes.length+' nodes)');
      }catch(e){
        flowHint('⚠ Could not read flow JSON — empty canvas');
        flowClearCanvas();
        flowSetCanvasState(true);
      }
    } else {
      flowClearCanvas();
      flowSetCanvasState(true);
      flowHint('New file: '+val+' — Place blocks on canvas then press Save & Build');
    }
  }
  document.getElementById('btn-flow-save').disabled=false;
}

function flowClearCanvas(){
  FLOW.nodes=[]; FLOW.edges=[]; FLOW.selected=null; FLOW.nextId=1;
  document.getElementById('flow-nodes').innerHTML='';
  document.getElementById('flow-svg').querySelectorAll('.fedge-g').forEach(el=>el.remove());
  flowRenderInspector();
  
  if(isFlowFileSelected()) flowSetCanvasState(true);
}

function flowExeChanged(){
  const val=document.getElementById('flow-exe-name')?.value?.trim();
  if(val) flowHint('ros2 run '+(FLOW.pkg||'<pkg>')+' '+val);
}

function flowHint(msg){
  const el=document.getElementById('flow-status-hint');
  if(!el) return;
  el.textContent=msg;
  el.style.display=msg?'block':'none';
}

function flowNewFileDialog(){
  if(!FLOW.pkg){alert('Please select package first');return false;}
  const name=prompt('New file name (without .py):','my_node');
  if(!name||!name.trim()) return false;
  const clean=name.trim().replace(/\.py$/,'').replace(/[^\w]/g,'_');
  
  const sel=document.getElementById('flow-file-sel');
  
  // เช็คชื่อไฟล์ซ้ำ
  const existingOptions = Array.from(sel.options).map(o => o.value);
  if (existingOptions.includes(clean + '.py')) {
    alert('ชื่อไฟล์ "' + clean + '.py" มีอยู่แล้วใน Package นี้ กรุณาใช้ชื่ออื่น');
    return false;
  }

  const opt=document.createElement('option');
  opt.value=clean+'.py'; opt.textContent=clean+'.py';
  sel.insertBefore(opt, sel.querySelector('[value="_new"]'));
  sel.value=clean+'.py';
  
  const exeEl=document.getElementById('flow-exe-name');
  if(exeEl) exeEl.value=clean; // บังคับเปลี่ยนชื่อ Exe ให้ตรงกับไฟล์เสมอ
  
  document.getElementById('btn-flow-save').disabled=false;
  
  flowClearCanvas();
  flowSetCanvasState(true);
  flowHint('Will create new file: '+clean+'.py — Press Save & Build when ready');
  return true;
}

function flowOpenWizard(){
  FLOW._afterWizard=true;
  openWizard();
}

function flowOpenQuickPackage(){
  const status=document.getElementById('flow-quick-status');if(status){status.className='flow-quick-status';status.textContent='';}
  openModal('modal-flow-quick-package');setTimeout(()=>document.getElementById('flow-quick-pkg')?.focus(),50);
}

function flowQuickTemplate(kind){
  const python={id:'n2',type:'python_code',x:310,y:145,props:{icon:'🐍',title:'คำสั่งของหุ่น',code:'result = value\n# เขียนคำสั่ง Python เพิ่มตรงนี้'}};
  if(kind==='blank')return{nodes:[{...python,id:'n1',x:260,y:150}],edges:[],nextId:2,pan:{x:40,y:40},zoom:1};
  if(kind==='topic')return{nodes:[
    {id:'n1',type:'subscriber',x:40,y:145,props:{icon:'📥',topic:'/input',msgType:'std_msgs/Float32',qos:'10'}},python,
    {id:'n3',type:'publisher',x:590,y:145,props:{icon:'📤',topic:'/output',msgType:'std_msgs/Float32',qos:'10'}},
  ],edges:[{from:'n1',fromPort:'msg',to:'n2',toPort:'value'},{from:'n2',fromPort:'result',to:'n3',toPort:'data'}],nextId:4,pan:{x:40,y:40},zoom:1};
  return{nodes:[
    {id:'n1',type:'timer',x:40,y:145,props:{icon:'⏰',period:'1.0',callback:'loop'}},python,
    {id:'n3',type:'logger',x:590,y:145,props:{icon:'💬',message:"f'คำตอบ: {value}'",level:'info'}},
  ],edges:[{from:'n1',fromPort:'tick',to:'n2',toPort:'value'},{from:'n2',fromPort:'result',to:'n3',toPort:'in'}],nextId:4,pan:{x:40,y:40},zoom:1};
}

async function flowCreateQuickPackage(){
  const pkg=String(document.getElementById('flow-quick-pkg')?.value||'').trim(),nodeName=String(document.getElementById('flow-quick-node')?.value||'').trim(),kind=document.querySelector('input[name="flow-quick-template"]:checked')?.value||'timer',status=document.getElementById('flow-quick-status'),button=document.getElementById('flow-quick-create');
  const valid=/^[a-z][a-z0-9_]*$/;status.className='flow-quick-status';
  if(!valid.test(pkg)){status.className+=' error';status.textContent='ชื่อ Package ต้องเป็นตัวพิมพ์เล็ก เช่น my_robot_app';return;}
  if(!valid.test(nodeName)){status.className+=' error';status.textContent='ชื่อ Node ต้องเป็นตัวพิมพ์เล็ก เช่น robot_node';return;}
  if(!sessionId){status.className+=' error';status.textContent='กรุณาเชื่อมต่อหุ่นยนต์ก่อนสร้าง Package';return;}
  button.disabled=true;button.textContent='กำลังสร้าง…';status.textContent='กำลังเตรียมโฟลเดอร์และ Block เริ่มต้น';
  try{
    const base=`${String(wsPath).replace(/\/$/,'')}/src/${pkg}`,existing=await API('/api/files/read',{sessionId,path:`${base}/package.xml`});
    if(existing?.ok)throw new Error(`Package “${pkg}” มีอยู่แล้ว กรุณาใช้ชื่อใหม่`);
    for(const path of [`${String(wsPath).replace(/\/$/,'')}/src`,base,`${base}/${pkg}`,`${base}/resource`]){const made=await API('/api/files/mkdir',{sessionId,path});if(!made?.ok)throw new Error(made?.error||`สร้าง ${path} ไม่สำเร็จ`);}
    const flow=flowQuickTemplate(kind),packageXml=`<?xml version="1.0"?>\n<package format="3">\n  <name>${pkg}</name>\n  <version>0.0.1</version>\n  <description>Custom robot program created with ROSIDE Flow Editor</description>\n  <maintainer email="student@example.com">ROSIDE Student</maintainer>\n  <license>Apache-2.0</license>\n  <exec_depend>rclpy</exec_depend>\n  <exec_depend>std_msgs</exec_depend>\n  <export><build_type>ament_python</build_type></export>\n</package>\n`,setupPy=`from setuptools import find_packages, setup\n\npackage_name = '${pkg}'\n\nsetup(\n    name=package_name,\n    version='0.0.1',\n    packages=find_packages(),\n    data_files=[\n        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),\n        ('share/' + package_name, ['package.xml']),\n    ],\n    install_requires=['setuptools'],\n    zip_safe=True,\n    entry_points={'console_scripts': ['${nodeName} = ${pkg}.${nodeName}:main']},\n)\n`,starter=`#!/usr/bin/env python3\nimport rclpy\nfrom rclpy.node import Node\n\nclass ${nodeName.split('_').map(word=>word[0].toUpperCase()+word.slice(1)).join('')}Node(Node):\n    def __init__(self):\n        super().__init__('${nodeName}')\n        self.get_logger().info('เปิด Flow Editor แล้วกดสร้างโปรแกรมเพื่ออัปเดตโค้ด')\n\ndef main(args=None):\n    rclpy.init(args=args)\n    node=${nodeName.split('_').map(word=>word[0].toUpperCase()+word.slice(1)).join('')}Node()\n    rclpy.spin(node)\n    node.destroy_node()\n    rclpy.shutdown()\n`;
    const files=[[`${base}/package.xml`,packageXml],[`${base}/setup.py`,setupPy],[`${base}/setup.cfg`,`[develop]\nscript_dir=$base/lib/${pkg}\n[install]\ninstall_scripts=$base/lib/${pkg}\n`],[`${base}/resource/${pkg}`,''],[`${base}/${pkg}/__init__.py`,''],[`${base}/${pkg}/${nodeName}.py`,starter],[`${base}/${pkg}/${nodeName}.flow.json`,JSON.stringify(flow,null,2)]];
    for(const [path,content] of files){const saved=await API('/api/files/write',{sessionId,path,content});if(!saved?.ok)throw new Error(saved?.error||`เขียน ${path} ไม่สำเร็จ`);}
    await flowLoadPackages();const pkgSelect=document.getElementById('flow-pkg-sel');pkgSelect.value=pkg;FLOW.pkg=pkg;await flowLoadFiles(pkg);const fileSelect=document.getElementById('flow-file-sel');fileSelect.value=`${nodeName}.py`;await flowChangeFile();document.getElementById('flow-exe-name').value=nodeName;
    status.className='flow-quick-status ok';status.textContent='✓ สร้าง Package แล้ว กำลังเปิดพื้นที่ต่อ Block';if(typeof refreshTree==='function')refreshTree();setTimeout(()=>closeModal('modal-flow-quick-package'),450);
  }catch(error){status.className='flow-quick-status error';status.textContent=error.message;}
  finally{button.disabled=false;button.textContent='✨ สร้างและเริ่มเขียน';}
}

function flowQuickPythonBlock(){
  if(!FLOW.pkg){flowOpenQuickPackage();return;}
  if(!isFlowFileSelected()&&!flowNewFileDialog())return;
  const wrap=document.getElementById('flow-canvas-wrap'),x=(wrap.offsetWidth/2-FLOW.pan.x)/FLOW.zoom-105,y=(wrap.offsetHeight/2-FLOW.pan.y)/FLOW.zoom-70;
  flowAddNode('python_code',x,y,{title:'Custom robot logic',code:'result = value\n# ตัวอย่าง: result = float(value) * 0.5'});
  flowHint('เลือก Python Code Block แล้วเขียนโค้ดใน Inspector ด้านขวา · input คือ value และ output คือ result');
}

function flowShowTutorial(){
  // Tutorial popup intentionally disabled: the child-friendly UI is self-guided.
}

function flowGenCode(){
  if(FLOW.nodes.length===0){alert('No nodes on canvas');return;}
  const code=flowBuildCode();
  const pre=document.getElementById('flow-code-preview');
  pre.innerHTML=syntaxHighlightPy(code);
  document.getElementById('flow-code-pkg-info').textContent=
    `Package: ${FLOW.pkg||'(not selected)'} | Nodes: ${FLOW.nodes.length} | Connections: ${FLOW.edges.length}`;
  openModal('modal-flow-code');
}

function flowBuildCode(exeNameOverride){
  const exeN=exeNameOverride||(document.getElementById('flow-exe-name')?.value?.trim())||null;
  const baseForClass=exeN||FLOW.pkg||'MyRobot';
  const nodeClassName=baseForClass.split('_').map(w=>w?w[0].toUpperCase()+w.slice(1):'').join('')+
    (baseForClass.endsWith('Node')||baseForClass.endsWith('node')?'':'Node');
  const imports=new Set(['import rclpy','from rclpy.node import Node']);

  FLOW.nodes.forEach(n=>{
    const props=n.props;
    if(props.msgType){
      const parts=props.msgType.split('/');
      if(parts.length>=2){
        const pkg=parts[0];const msg=parts[parts.length-1];
        imports.add(`from ${pkg}.msg import ${msg}`);
      }
    }
    if(n.type==='service'){
      const t=props.srvType||'std_srvs/SetBool';
      const parts=t.split('/');
      imports.add(`from ${parts[0]}.srv import ${parts[parts.length-1]}`);
    }
  });

  const hasDynamicTF = FLOW.nodes.some(n => n.type === 'tf_frame' || n.type === 'tf_broadcaster' || FLOW_TYPES[n.type]?.portCls === 'tf');
  const hasStaticTF = FLOW.nodes.some(n => n.type === 'tf_static');
  const hasMath = FLOW.nodes.some(n => n.type === 'math' || n.type.startsWith('lib_'));
  
  if(hasDynamicTF || hasStaticTF){
    imports.add('from geometry_msgs.msg import TransformStamped');
    imports.add('import math');
  }
  if(hasDynamicTF) imports.add('from tf2_ros import TransformBroadcaster');
  if(hasStaticTF) imports.add('from tf2_ros import StaticTransformBroadcaster');
  if(hasMath) imports.add('import math');

  let tfHelper = '';
  if(hasDynamicTF || hasStaticTF){
    tfHelper = `
def quaternion_from_euler(roll, pitch, yaw):
    """Converts euler roll, pitch, yaw to quaternion"""
    import math
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)
    q = [0] * 4
    q[0] = sr * cp * cy - cr * sp * sy
    q[1] = cr * sp * cy + sr * cp * sy
    q[2] = cr * cp * sy - sr * sp * cy
    q[3] = cr * cp * cy + sr * sp * sy
    return q
`;
  }

  let tfInited = false;
  let staticTfInited = false;
  const rawInit = [];

  FLOW.nodes.forEach(n => {
    const def = FLOW_TYPES[n.type];
    if(!def) return;
    
    if(['publisher','subscriber','timer','service','param','tf_broadcaster','variable'].includes(n.type)){
      rawInit.push(def.genCode(n));
    }
    if(def.portCls === 'tf' && n.type !== 'tf_broadcaster' && n.type !== 'tf_static' && !tfInited) {
      rawInit.push(`self.tf_broadcaster = TransformBroadcaster(self)`);
      tfInited = true;
    }
    if(n.type === 'tf_frame' && !tfInited){
      rawInit.push(`self.tf_broadcaster = TransformBroadcaster(self)`);
      tfInited = true;
    }
    if(n.type === 'tf_static' && !staticTfInited){
      rawInit.push(`self.static_broadcaster = StaticTransformBroadcaster(self)`);
      staticTfInited = true;
    }
  });

  const initLines=rawInit.map(block=>{
    const lines=block.split('\n');
    return lines.map((l,i)=>{
      if(!l.trim()) return '';
      const stripped=l.trimStart();
      const origIndent=l.length-stripped.length;
      const extra=i>0&&origIndent>0?'    '.repeat(Math.min(Math.ceil(origIndent/4),2)):'';
      return '        '+extra+stripped;
    }).join('\n');
  }).join('\n\n');

  function getDownstream(fromId){
    return FLOW.edges.filter(e=>e.from===fromId).map(e=>FLOW.nodes.find(n=>n.id===e.to)).filter(Boolean);
  }
  function getUpstream(toId){
    return FLOW.edges.filter(e=>e.to===toId).map(e=>FLOW.nodes.find(n=>n.id===e.from)).filter(Boolean);
  }

  function genPythonCodeBlock(target,inputExpression='None'){
    const lines=[`        # → Python Code: ${target.props.title||'Custom logic'}`,`        try:`,`            value = ${inputExpression}`,`            result = value`];
    for(const line of String(target.props.code||'result = value').replace(/\r/g,'').split('\n'))lines.push(`            ${line}`);
    const downstream=getDownstream(target.id);
    downstream.filter(node=>node.type==='publisher').forEach(pub=>{
      const msgType=pub.props.msgType.split('/').pop();lines.push(`            out_msg = ${msgType}()`);
      if(['Bool','Int8','Int16','Int32','Int64','UInt8','UInt16','UInt32','UInt64','Float32','Float64','String'].includes(msgType))lines.push(`            out_msg.data = result`);
      else lines.push(`            # TODO: map result to ${msgType} fields`);
      lines.push(`            self.pub_${safeName(pub.props.topic)}.publish(out_msg)`);
    });
    downstream.filter(node=>node.type==='logger').forEach(logger=>{
      let message=logger.props.message||"f'Value: {value}'";if(!message.startsWith('f')&&!message.startsWith("'")&&!message.startsWith('"'))message=`f'${message}'`;
      lines.push(`            value = result`,`            self.get_logger().${logger.props.level||'info'}(${message})`);
    });
    lines.push(`        except Exception as error:`,`            self.get_logger().error(f'Python block error: {error}')`);
    return lines;
  }

  const startupLines = [];
  const startupRoots = FLOW.nodes.filter(n => {
     if (!['math', 'logger', 'publisher', 'condition','python_code'].includes(n.type) && !n.type.startsWith('lib_')) return false;
     const upstreams = getUpstream(n.id);
     const hasTriggerOrLogicUpstream = upstreams.some(up => 
         ['timer', 'subscriber', 'service', 'math', 'condition'].includes(up.type) || up.type.startsWith('lib_')
     );
     return !hasTriggerOrLogicUpstream;
  });

  if (startupRoots.length > 0) {
      startupLines.push(`\n        # ── Startup Execution ──`);
      startupRoots.forEach(target => {
          if (target.type.startsWith('lib_')) {
              startupLines.push(...genLibBlockCall(target, null, false));
          } else if (target.type === 'python_code') {
              startupLines.push(...genPythonCodeBlock(target,'None'));
          } else if (target.type === 'logger') {
              startupLines.push(`        # → Logger`);
              startupLines.push(`        value = getattr(self, '_mem_${target.id}_in', 0)`);
              let lmsg = target.props.message || '';
              if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
              startupLines.push(`        self.get_logger().${target.props.level||'info'}(${lmsg})`);
          } else if (target.type === 'math') {
              startupLines.push(`        # → Math: ${target.props.formula}`);
              startupLines.push(`        try:`);
              startupLines.push(`            value = getattr(self, '_mem_${target.id}_in', 0.0)`);
              startupLines.push(`            ${target.props.formula}`);
              const nextDown = getDownstream(target.id);
              const pubs = nextDown.filter(n=>n.type==='publisher');
              if(pubs.length > 0) {
                pubs.forEach(pub => {
                   startupLines.push(`            out_msg = ${pub.props.msgType.split('/').pop()}()`);
                   const pubMsgBase = pub.props.msgType.split('/').pop();
                   let castFn = 'float';
                   if (['Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64'].includes(pubMsgBase)) castFn = 'int';
                   else if (pubMsgBase === 'String') castFn = 'str';
                   else if (pubMsgBase === 'Bool') castFn = 'bool';

                   if (pubMsgBase !== 'Empty' && pubMsgBase !== 'empty') {
                       startupLines.push(`            out_msg.data = ${castFn}(value if 'value' in locals() else 0)`);
                   }
                   startupLines.push(`            self.pub_${safeName(pub.props.topic)}.publish(out_msg)`);
                });
              }
              const loggers = nextDown.filter(n=>n.type==='logger');
              if(loggers.length > 0) {
                loggers.forEach(logger => {
                   startupLines.push(`            # → Forward to Logger`);
                   let lmsg = logger.props.message || '';
                   if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
                   startupLines.push(`            self.get_logger().${logger.props.level||'info'}(${lmsg})`);
                });
              }
              startupLines.push(`        except Exception as e:`);
              startupLines.push(`            self.get_logger().error(f'Math Error: {e}')`);
          } else if (target.type === 'publisher') {
              startupLines.push(`        # → publish to ${target.props.topic}`);
              startupLines.push(`        msg = ${target.props.msgType.split('/').pop()}()`);
              const pubMsgBase = target.props.msgType.split('/').pop();
              if (['Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Float32', 'Float64', 'String', 'Bool'].includes(pubMsgBase)) {
                   startupLines.push(`        msg.data = getattr(self, '_mem_${target.id}_data', 0)`);
              }
              startupLines.push(`        self.pub_${safeName(target.props.topic)}.publish(msg)`);
          }
      });
  }

  let finalInitLines = initLines;
  if (startupLines.length > 0) {
      finalInitLines += '\n' + startupLines.join('\n');
  }

  function genMsgTransfer(srcType, dstType, dstVar, srcVar){
    const lines = [];
    const srcBase = srcType.split('/').pop();
    const dstBase = dstType.split('/').pop();

    if(srcType === dstType){
      lines.push(`        ${dstVar} = ${srcVar}  # forward: same type`);
      return lines;
    }

    const hasSrcData   = ['Bool','Int8','Int16','Int32','Int64','UInt8','UInt16','UInt32','UInt64','Float32','Float64','String','Byte'].includes(srcBase);
    const hasDstData   = ['Bool','Int8','Int16','Int32','Int64','UInt8','UInt16','UInt32','UInt64','Float32','Float64','String','Byte'].includes(dstBase);
    const srcIsTwist   = srcBase==='Twist'||srcBase==='TwistStamped';
    const dstIsTwist   = dstBase==='Twist'||dstBase==='TwistStamped';
    const srcIsPose    = srcBase.startsWith('Pose');
    const dstIsPose    = dstBase.startsWith('Pose');
    const srcIsOdom    = srcBase==='Odometry';

    lines.push(`        ${dstVar} = ${dstBase}()`);

    if(hasSrcData && hasDstData){
      const castFn = dstBase==='Bool' ? 'bool' : (dstBase.startsWith('Float')) ? 'float' : 'int';
      lines.push(`        ${dstVar}.data = ${castFn}(${srcVar}.data)`);
    } else if(hasSrcData && dstIsTwist){
      lines.push(`        ${dstVar}.linear.x = float(${srcVar}.data)  # map scalar → linear.x`);
    } else if(srcIsTwist && dstIsTwist){
      lines.push(`        ${dstVar}.linear  = ${srcVar}.linear`);
      lines.push(`        ${dstVar}.angular = ${srcVar}.angular`);
    } else if(srcIsOdom && dstIsTwist){
      lines.push(`        ${dstVar}.linear  = ${srcVar}.twist.twist.linear`);
      lines.push(`        ${dstVar}.angular = ${srcVar}.twist.twist.angular`);
    } else if(srcIsOdom && dstIsPose){
      lines.push(`        ${dstVar}.position    = ${srcVar}.pose.pose.position`);
      lines.push(`        ${dstVar}.orientation = ${srcVar}.pose.pose.orientation`);
    } else {
      lines.push(`        # TODO: convert data ${srcBase} → ${dstBase}`);
      lines.push(`        # Example: ${dstVar}.data = ${srcVar}.data`);
      lines.push(`        #          ${dstVar}.linear.x = ${srcVar}.linear.x`);
    }
    return lines;
  }

  function genLibBlockCall(target, incomingEdge, isFromSubscriber) {
      const lines = [];
      const libDef = FLOW_TYPES[target.type];
      const block = libDef._libBlock;
      const fnName = safeName(block.name||'custom');
      
      lines.push(`        # → Custom Node: ${block.name}`);
      lines.push(`        try:`);
      
      if (isFromSubscriber) {
          lines.push(`            val = getattr(msg, 'data', msg)`);
      }

      const inputNames = block.inputs.map(p=>p.name);
      inputNames.forEach(inName => {
          if (isFromSubscriber && incomingEdge && incomingEdge.toPort === inName) {
              lines.push(`            ${inName} = val`);
              lines.push(`            self._mem_${target.id}_${inName} = val`);
          } else {
              lines.push(`            ${inName} = getattr(self, '_mem_${target.id}_${inName}', 0.0)`);
          }
      });

      const paramVals = (block.params||[]).map(p => {
          let val = target.props[p.name];
          if(val===undefined || val==='') val = p.default;
          return String(val);
      });
      const allCallArgs = [...inputNames, ...paramVals].join(', ');

      const retArgs = block.outputs.map(p=>p.name).join(', ');
      if(retArgs) {
          lines.push(`            ${retArgs} = self.lib_${fnName}(${allCallArgs})`);
      } else {
          lines.push(`            self.lib_${fnName}(${allCallArgs})`);
      }

      const nextDown = getDownstream(target.id);
      const pubs = nextDown.filter(n=>n.type==='publisher');
      if(pubs.length > 0) {
        pubs.forEach(pub => {
           const outEdge = FLOW.edges.find(e=>e.from===target.id && e.to===pub.id);
           const outPortDef = block.outputs.find(p => p.name === (outEdge ? outEdge.fromPort : block.outputs[0]?.name));
           const outVar = outPortDef ? outPortDef.name : (block.outputs[0]?.name || '0');
           const outType = outPortDef ? (outPortDef.type || 'any') : 'any';

           lines.push(`            # → Forward to ${pub.props.topic}`);
           lines.push(`            out_msg = ${pub.props.msgType.split('/').pop()}()`);

           if(pub.props.msgType.includes('Twist') || pub.props.msgType.includes('Odometry')) {
               const pfx = pub.props.msgType.includes('Odometry') ? 'twist.twist.' : '';
               lines.push(`            out_msg.${pfx}linear.x = float(linear_x) if 'linear_x' in locals() else (float(linear_v) if 'linear_v' in locals() else 0.0)`);
               lines.push(`            out_msg.${pfx}linear.y = float(linear_y) if 'linear_y' in locals() else 0.0`);
               lines.push(`            out_msg.${pfx}angular.z = float(angular_z) if 'angular_z' in locals() else (float(angular_w) if 'angular_w' in locals() else 0.0)`);
           } else {
               const pubMsgBase = pub.props.msgType.split('/').pop();
               let castFn = '';
               let defVal = '0.0';

               if (outType !== 'any') {
                   castFn = outType;
                   if(outType === 'int') defVal = '0';
                   else if(outType === 'str') defVal = '""';
                   else if(outType === 'bool') defVal = 'False';
               } else {
                   if (['Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64'].includes(pubMsgBase)) {
                       castFn = 'int'; defVal = '0';
                   } else if (['Float32', 'Float64'].includes(pubMsgBase)) {
                       castFn = 'float'; defVal = '0.0';
                   } else if (pubMsgBase === 'String') {
                       castFn = 'str'; defVal = '""';
                   } else if (pubMsgBase === 'Bool') {
                       castFn = 'bool'; defVal = 'False';
                   }
               }

               if (pubMsgBase !== 'Empty' && pubMsgBase !== 'empty') {
                   if (castFn) {
                       lines.push(`            out_msg.data = ${castFn}(${outVar}) if '${outVar}' in locals() else ${defVal}`);
                   } else {
                       lines.push(`            out_msg.data = ${outVar} if '${outVar}' in locals() else 0`);
                   }
               }
           }
           lines.push(`            self.pub_${safeName(pub.props.topic)}.publish(out_msg)`);
        });
      }
      
      const loggers = nextDown.filter(n=>n.type==='logger');
      if(loggers.length > 0) {
        loggers.forEach(logger => {
           const outEdge = FLOW.edges.find(e=>e.from===target.id && e.to===logger.id);
           const outPortDef = block.outputs.find(p => p.name === (outEdge ? outEdge.fromPort : block.outputs[0]?.name));
           const outVar = outPortDef ? outPortDef.name : (block.outputs[0]?.name || '0');
           
           lines.push(`            # → Forward to Logger`);
           lines.push(`            value = ${outVar} if '${outVar}' in locals() else 0`);
           let lmsg = logger.props.message || '';
           if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
           lines.push(`            self.get_logger().${logger.props.level||'info'}(${lmsg})`);
        });
      }
      
      lines.push(`        except Exception as e:`);
      lines.push(`            self.get_logger().error(f'${block.name} Error: {e}')`);
      return lines;
  }

  function genSubCbBody(subNode){
    const lines=[];
    const downstream=getDownstream(subNode.id);
    if(downstream.length===0){
      lines.push(`        # TODO: process msg from ${subNode.props.topic}`);
      lines.push(`        self.get_logger().info(f'Received on ${subNode.props.topic}: {msg}')`);
      return lines;
    }
    downstream.forEach(target=>{
      if(target.type.startsWith('lib_')){
          const edge = FLOW.edges.find(e=>e.from===subNode.id && e.to===target.id);
          lines.push(...genLibBlockCall(target, edge, true));
          return;
      }
      switch(target.type){
        case 'python_code':{
          const subBase=subNode.props.msgType.split('/').pop();
          const scalar=['Bool','Int8','Int16','Int32','Int64','UInt8','UInt16','UInt32','UInt64','Float32','Float64','String'].includes(subBase);
          lines.push(...genPythonCodeBlock(target,scalar?'msg.data':'msg'));
          break;
        }
        case 'publisher':{
          lines.push(`        # → forward to topic ${target.props.topic}`);
          const transferLines = genMsgTransfer(subNode.props.msgType, target.props.msgType, 'out_msg', 'msg');
          lines.push(...transferLines);
          lines.push(`        self.pub_${safeName(target.props.topic)}.publish(out_msg)`);
          break;
        }
        case 'condition':{
          const subBase = subNode.props.msgType.split('/').pop();
          const hasData = ['Bool','Int8','Int16','Int32','Int64','UInt8','UInt16','UInt32','UInt64','Float32','Float64','String'].includes(subBase);
          lines.push(`        # → check condition: ${target.props.condition}`);
          if(hasData) lines.push(`        value = msg.data`);
          else lines.push(`        value = msg  # adjust field as needed`);
          lines.push(`        if ${target.props.condition}:`);
          lines.push(`            pass  # True branch — put logic here`);
          lines.push(`        else:`);
          lines.push(`            pass  # False branch`);
          break;
        }
        case 'logger':{
          lines.push(`        # → Forward to Logger`);
          lines.push(`        value = getattr(msg, 'data', msg)`);
          let lmsg = target.props.message || '';
          if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
          lines.push(`        self.get_logger().${target.props.level||'info'}(${lmsg})`);
          break;
        }
        case 'math':{
          const subBase = subNode.props.msgType.split('/').pop();
          const hasData = ['Int8','Int16','Int32','Int64','UInt8','UInt16','UInt32','UInt64','Float32','Float64'].includes(subBase);
          lines.push(`        # → calculate: ${target.props.formula}`);
          lines.push(`        try:`);
          if(hasData) lines.push(`            value = msg.data`);
          else lines.push(`            value = msg  # adjust field as needed`);
          lines.push(`            ${target.props.formula}`);
          
          const nextDown = getDownstream(target.id);
          const pubs = nextDown.filter(n=>n.type==='publisher');
          if(pubs.length > 0) {
            pubs.forEach(pub => {
               lines.push(`            out_msg = ${pub.props.msgType.split('/').pop()}()`);
               
               const pubMsgBase = pub.props.msgType.split('/').pop();
               let castFn = 'float';
               if (['Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64'].includes(pubMsgBase)) castFn = 'int';
               else if (pubMsgBase === 'String') castFn = 'str';
               else if (pubMsgBase === 'Bool') castFn = 'bool';

               if (pubMsgBase !== 'Empty' && pubMsgBase !== 'empty') {
                   lines.push(`            out_msg.data = ${castFn}(value)  # ส่งค่าที่คำนวณได้`);
               }
               lines.push(`            self.pub_${safeName(pub.props.topic)}.publish(out_msg)`);
            });
          }
          
          const loggers = nextDown.filter(n=>n.type==='logger');
          if(loggers.length > 0) {
            loggers.forEach(logger => {
               lines.push(`            # → Forward to Logger`);
               let lmsg = logger.props.message || '';
               if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
               lines.push(`            self.get_logger().${logger.props.level||'info'}(${lmsg})`);
            });
          }
          lines.push(`        except Exception as e:`);
          lines.push(`            self.get_logger().error(f'Math Error: {e}')`);
          break;
        }
        default:
          lines.push(`        self.get_logger().debug(f'Received on ${subNode.props.topic}: {msg}')`);
      }
    });
    return lines;
  }

  function genTimerCbBody(timerNode){
    const lines=[];
    const downstream=getDownstream(timerNode.id);
    if(downstream.length===0){
      lines.push(`        # TODO: put logic here`);
      lines.push(`        pass`);
      return lines;
    }
    downstream.forEach(target=>{
      if(target.type.startsWith('lib_')){
          const edge = FLOW.edges.find(e=>e.from===timerNode.id && e.to===target.id);
          lines.push(...genLibBlockCall(target, edge, false));
          return;
      }
      switch(target.type){
        case 'python_code':{
          lines.push(...genPythonCodeBlock(target,'None'));
          break;
        }
        case 'publisher':{
          const pubMsgType=target.props.msgType.split('/').pop();
          lines.push(`        # → publish to ${target.props.topic}`);
          lines.push(`        msg = ${pubMsgType}()`);
          lines.push(`        # TODO: set msg values as needed`);
          lines.push(`        # e.g. msg.data = 0.0  or msg.linear.x = 0.3`);
          lines.push(`        self.pub_${safeName(target.props.topic)}.publish(msg)`);
          break;
        }
        case 'logger':{
          lines.push(`        # → Forward to Logger`);
          lines.push(`        value = 'timer tick'`);
          let lmsg = target.props.message || '';
          if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
          lines.push(`        self.get_logger().${target.props.level||'info'}(${lmsg})`);
          break;
        }
        case 'math':{
          lines.push(`        # → calculate: ${target.props.formula}`);
          lines.push(`        try:`);
          lines.push(`            value = 'timer tick'`);
          lines.push(`            ${target.props.formula}`);
          
          const nextDown = getDownstream(target.id);
          const pubs = nextDown.filter(n=>n.type==='publisher');
          if(pubs.length > 0) {
            pubs.forEach(pub => {
               lines.push(`            out_msg = ${pub.props.msgType.split('/').pop()}()`);
               
               const pubMsgBase = pub.props.msgType.split('/').pop();
               let castFn = 'float';
               if (['Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64'].includes(pubMsgBase)) castFn = 'int';
               else if (pubMsgBase === 'String') castFn = 'str';
               else if (pubMsgBase === 'Bool') castFn = 'bool';

               if (pubMsgBase !== 'Empty' && pubMsgBase !== 'empty') {
                   lines.push(`            out_msg.data = ${castFn}(value)  # ส่งค่าที่คำนวณได้`);
               }
               lines.push(`            self.pub_${safeName(pub.props.topic)}.publish(out_msg)`);
            });
          }
          
          const loggers = nextDown.filter(n=>n.type==='logger');
          if(loggers.length > 0) {
            loggers.forEach(logger => {
               lines.push(`            # → Forward to Logger`);
               let lmsg = logger.props.message || '';
               if(!lmsg.startsWith('f') && !lmsg.startsWith("'") && !lmsg.startsWith('"')) lmsg = `f'${lmsg}'`;
               lines.push(`            self.get_logger().${logger.props.level||'info'}(${lmsg})`);
            });
          }
          lines.push(`        except Exception as e:`);
          lines.push(`            self.get_logger().error(f'Math Error: {e}')`);
          break;
        }
        default:
          lines.push(`        pass`);
      }
    });
    return lines;
  }

  const callbacks=FLOW.nodes.filter(n=>n.type==='subscriber').map(n=>{
    const bodyLines=genSubCbBody(n);
    return [
      '',
      `    def cb_${safeName(n.props.topic)}(self, msg):`,
      `        """Receive data from topic ${n.props.topic}"""`,
      ...bodyLines,
    ].join('\n');
  }).join('\n');

  const timerCallbacks=FLOW.nodes.filter(n=>n.type==='timer').map(n=>{
    const bodyLines=genTimerCbBody(n);
    return [
      '',
      `    def ${n.props.callback}(self):`,
      `        """Timer: runs every ${n.props.period}s (${Math.round(1/parseFloat(n.props.period)) || 10} Hz)"""`,
      ...bodyLines,
    ].join('\n');
  }).join('\n');

  const srvHandlers=FLOW.nodes.filter(n=>n.type==='service').map(n=>[
    '',
    `    def handle_${safeName(n.props.name)}(self, request, response):`,
    `        # Service handler: ${n.props.name}`,
    `        response.success = True`,
    `        response.message = 'OK'`,
    `        return response`,
  ].join('\n')).join('\n');

  // TF Method
  let tfMethod = '';
  const tfFrames = FLOW.nodes.filter(n => n.type === 'tf_frame');
  if(tfFrames.length > 0){
    tfMethod = `\n    def broadcast_transforms(self):\n        """Broadcast TF transforms"""\n        now = self.get_clock().now().to_msg()`;
    tfFrames.forEach(n => {
      const p = n.props;
      tfMethod += `\n        t = TransformStamped()\n        t.header.stamp = now\n        t.header.frame_id = '${p.frame_id}'\n        t.child_frame_id = '${p.child_frame_id}'\n        t.transform.translation.x = float(${p.x})\n        t.transform.translation.y = float(${p.y})\n        t.transform.translation.z = float(${p.z})\n        q = quaternion_from_euler(float(${p.roll}), float(${p.pitch}), float(${p.yaw}))\n        t.transform.rotation.x, t.transform.rotation.y, t.transform.rotation.z, t.transform.rotation.w = q\n        self.tf_broadcaster.sendTransform(t)\n`;
    });
  }

  // Static TF string inside __init__
  let staticTfStr = '';
  const tfStatics = FLOW.nodes.filter(n => n.type === 'tf_static');
  if(tfStatics.length > 0){
    staticTfStr = `\n        # ── Static Transforms ──\n` + tfStatics.map(n => {
      const p = n.props;
      return `        st = TransformStamped()
        st.header.stamp = self.get_clock().now().to_msg()
        st.header.frame_id = '${p.frame_id}'
        st.child_frame_id = '${p.child_frame_id}'
        st.transform.translation.x = float(${p.x})
        st.transform.translation.y = float(${p.y})
        st.transform.translation.z = float(${p.z})
        sq = quaternion_from_euler(float(${p.roll}), float(${p.pitch}), float(${p.yaw}))
        st.transform.rotation.x, st.transform.rotation.y, st.transform.rotation.z, st.transform.rotation.w = sq
        self.static_broadcaster.sendTransform(st)`;
    }).join('\n\n');
  }

  // Include generated methods from library blocks
  const usedLibTypes = new Set(FLOW.nodes.filter(n => n.type.startsWith('lib_')).map(n => n.type));
  let libMethods = '';
  usedLibTypes.forEach(type => {
      const def = FLOW_TYPES[type];
      if(def && def.genMethod) {
          libMethods += def.genMethod();
      }
  });

  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
${nodeClassName} — Generated by Mecha Rayong Learing Workspace
Package: ${FLOW.pkg||'my_package'}
Mode: ${FLOW.canvasMode}
Nodes: ${FLOW.nodes.map(n=>FLOW_TYPES[n.type]?.emoji+' '+FLOW_TYPES[n.type]?.label).join(', ')}
"""

${[...imports].join('\n')}
${tfHelper}
class ${nodeClassName}(Node):
    def __init__(self):
        super().__init__('${(FLOW.pkg||'my').replace(/-/g,'_')}_node')

        # ══ Created by Flow Editor ══
${finalInitLines}
${staticTfStr}

        self.get_logger().info('${nodeClassName} ready!')

${callbacks}
${timerCallbacks}
${srvHandlers}
${tfMethod}
${libMethods}
def main(args=None):
    rclpy.init(args=args)
    node = ${nodeClassName}()
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

function syntaxHighlightPy(code){
  return escH(code)
    .replace(/^(#.*)$/gm,'<span style="color:var(--sy-cm);font-style:italic">$1</span>')
    .replace(/\b(import|from|class|def|return|if|else|elif|for|while|pass|try|except|with|as|in|not|and|or|True|False|None|self|super|lambda|raise)\b/g,
      '<span style="color:var(--sy-kw)">$1</span>')
    .replace(/&#39;([^&#]*)&#39;/g,'<span style="color:var(--sy-str)">\'$1\'</span>')
    .replace(/&quot;([^&]*)&quot;/g,'<span style="color:var(--sy-str)">"$1"</span>');
}

function flowCopyCode(){
  const code=flowBuildCode();
  navigator.clipboard?.writeText(code).then(()=>sbMsg('Copied!',2000));
}

// ── Save file + build ──
async function flowSaveAndBuild(){
  if(!sessionId){alert('Connect SSH first');return;}
  const pkg=FLOW.pkg;
  if(!pkg){alert('Please select package first');return;}

  const fileSel=document.getElementById('flow-file-sel');
  const selectedFile=(fileSel?.value||'').trim();
  const exeName=(document.getElementById('flow-exe-name')?.value||'').trim().replace(/[^\w]/g,'_') ||
    pkg.replace(/-/g,'_')+'_flow';

  if(!selectedFile){
    alert('Please select file or create new file before Save & Build');
    return;
  }

  const code=flowBuildCode(exeName);
  const filePath=`${wsPath}/src/${pkg}/${pkg}/${selectedFile}`;

  sbMsg('Saving '+selectedFile+'...');
  const r=await API('/api/files/write',{sessionId,path:filePath,content:code});
  if(!r.ok){sbMsg('Save error: '+r.error,3000);return;}

  const flowJsonPath=`${wsPath}/src/${pkg}/${pkg}/${selectedFile.replace('.py','')}.flow.json`;
  await API('/api/files/write',{sessionId,path:flowJsonPath,
    content:JSON.stringify({nodes:FLOW.nodes,edges:FLOW.edges,nextId:FLOW.nextId,pan:FLOW.pan,zoom:FLOW.zoom},null,2)});

  const moduleName=selectedFile.replace('.py','');
  await flowUpdateSetupPy(pkg, exeName, moduleName);

  sbMsg('Building & Running...');
  closeModal('modal-flow-code');
  
  const src=rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
  // Kill only the installed executable from this workspace. A generic
  // `pkill -f exeName` can stop another user's SIM when package/executable
  // names happen to match.
  const cmd = `cd ${wsPath} && FLOW_WS="$(pwd -P)" && FLOW_BIN="$FLOW_WS/install/${pkg}/lib/${pkg}/${exeName}" && pkill -9 -f "$FLOW_BIN" 2>/dev/null || true; cd ${wsPath} && source ${src} && colcon build --packages-select ${pkg} && source install/setup.bash && echo -e "\\n[OK] Build done!" && echo "[RUN] ros2 run ${pkg} ${exeName}" && ros2 run ${pkg} ${exeName}`;
  
  // ── เช็คและเปิด Terminal Tab ใหม่สำหรับแพ็กเกจนี้ ──
  if (typeof TERMS !== 'undefined' && typeof termCloseTab === 'function' && typeof termNewTab === 'function') {
    const tabLabel = 'Flow: ' + exeName;
    const existingTab = TERMS.find(t => t.label === tabLabel);
    
    // ถ้ามี Tab ของ Flow ตัวนี้เปิดอยู่แล้ว ให้ปิดของเก่าทิ้งเพื่อรันใหม่
    if (existingTab) {
      termCloseTab(existingTab.id);
    }
    
    switchPage('terminal');
    termNewTab(tabLabel, cmd);
  } else {
    // Fallback แบบเดิม
    switchPage('terminal');
    if(termWs&&termWs.readyState===WebSocket.OPEN){
      termWs.send(JSON.stringify({type:'data', data: cmd + '\n'}));
    }
  }

  sbMsg('');
  setTimeout(refreshTree, 2000);
}

// ── Auto-update setup.py entry_points ──
async function flowUpdateSetupPy(pkg, exeName, moduleName){
  const setupPath=`${wsPath}/src/${pkg}/setup.py`;
  const r=await API('/api/files/read',{sessionId,path:setupPath});
  if(!r.ok) return; // C++ package — skip

  let src=r.content;
  
  // เช็คว่ามี entry point นี้ตรงๆ อยู่แล้วหรือไม่
  const existRegex = new RegExp(`['"]${exeName}\\s*=\\s*${pkg}\\.${moduleName}:main['"]`);
  if (existRegex.test(src)) return; // มีอยู่แล้ว ข้ามได้เลย

  // เช็คว่ามี exeName นี้อยู่แล้ว แต่ชี้ไปที่ไฟล์อื่นหรือไม่ (แก้ปัญหาบรรทัดซ้ำแบบในรูป)
  const conflictRegex = new RegExp(`['"]${exeName}\\s*=\\s*${pkg}\\.[a-zA-Z0-9_]+:main['"]`);
  if (conflictRegex.test(src)) {
    src = src.replace(conflictRegex, `'${exeName} = ${pkg}.${moduleName}:main'`);
    await API('/api/files/write',{sessionId,path:setupPath,content:src});
    sbMsg(`Updated setup.py: updated ${exeName}`, 2000);
    return;
  }

  // หาบรรทัดที่เป็น 'console_scripts': [ เพื่อแทรก entry point ใหม่เข้าไป
  const consoleScriptsRegex = /(['"]console_scripts['"]\s*:\s*\[)/;
  
  if(consoleScriptsRegex.test(src)){
    // แทรกรายชื่อไฟล์ (Executable) ใหม่ลงไปในลิสต์
    const entryLine = `\n            '${exeName} = ${pkg}.${moduleName}:main',`;
    src = src.replace(consoleScriptsRegex, `$1${entryLine}`);
    await API('/api/files/write',{sessionId,path:setupPath,content:src});
    sbMsg(`Updated setup.py: added ${exeName}`, 2000);
  } else {
    sbMsg(`⚠️ Warning: ไม่พบ console_scripts ใน setup.py กรุณาเพิ่มแบบ Manual`, 4000);
  }
}

// ── Populate package selector ──
async function flowLoadPackages(){
  if(!sessionId) return;
  const r=await API('/api/files/list',{sessionId,path:wsPath+'/src'});
  if(!r.ok) return;
  const sel=document.getElementById('flow-pkg-sel');
  const pkgs=r.items.filter(i=>i.isDir).map(i=>i.name);
  const cur=FLOW.pkg||sel?.value||'';
  sel.innerHTML='<option value="">— Select package —</option>'+
    pkgs.map(p=>`<option value="${escH(p)}"${p===cur?' selected':''}>${escH(p)}</option>`).join('');
  if(cur&&pkgs.includes(cur)) flowLoadFiles(cur);
}

const _origOnConnected=typeof onConnected==='function'?onConnected:null;

// ═════════════════════════════════════════════════════════════════
//  FLOW: Export / Import JSON
// ═════════════════════════════════════════════════════════════════
function flowExport(){
  const data={nodes:FLOW.nodes,edges:FLOW.edges,nextId:FLOW.nextId,pan:FLOW.pan,zoom:FLOW.zoom,
    version:'1.0',pkg:FLOW.pkg||'',exported:new Date().toISOString()};
  const json=JSON.stringify(data,null,2);
  const blob=new Blob([json],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(FLOW.pkg||'flow')+'_'+(document.getElementById('flow-exe-name')?.value||'nodes')+'.flow.json';
  a.click();
  URL.revokeObjectURL(a.href);
  sbMsg('Exported flow JSON',2000);
}

function flowImport(){
  if(!isFlowFileSelected()) {
    alert('กรุณาเลือก Package และ File ก่อน Import ครับ');
    return;
  }
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='.json,.flow.json';
  inp.onchange=e=>{
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        const data=JSON.parse(ev.target.result);
        if(!data.nodes) throw new Error('Invalid flow file — missing nodes');
        if(!confirm(`Import flow: ${data.nodes.length} nodes, ${(data.edges||[]).length} edges?\nCurrent canvas will be replaced`)) return;
        FLOW.nodes=data.nodes||[]; FLOW.edges=data.edges||[];
        FLOW.nextId=data.nextId||1; FLOW.pan=data.pan||{x:40,y:40}; FLOW.zoom=data.zoom||1;
        flowSetCanvasState(true);
        flowRender(); flowSave();
        sbMsg('Imported: '+data.nodes.length+' nodes',2500);
      }catch(err){ alert('Import error: '+err.message); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

// ═══════════════════════════════════════════════════════════════
//  LIB BLOCK CREATOR — Custom reusable blocks
// ═══════════════════════════════════════════════════════════════
const LIB_BLOCKS = [];
const LIB_STORAGE_KEY = 'ros2ide_lib_blocks';

function seedDefaultLibBlocks() {
  const diffDriveBlock = {
    id: 'default_diffdrive',
    name: 'Diff Drive Math',
    emoji: '🧮',
    color: '#38b2ac',
    tab: 'odom',
    description: 'คำนวณสมการ 2 ล้อ (Differential Drive) แปลง Encoder เป็นความเร็ว (v, w) สามารถแก้โค้ดเพื่อคำนวณแบบอื่นได้',
    libs: ['math'],
    params: [
      {name: 'R', default: '0.033'},
      {name: 'W', default: '0.16'},
      {name: 'TICKS', default: '4096.0'},
      {name: 'GEAR', default: '1.0'}
    ],
    code: `# คำนวณระยะทางที่ล้อหมุนได้\ndist_l = (enc_l / (TICKS * GEAR)) * (2.0 * math.pi * R)\ndist_r = (enc_r / (TICKS * GEAR)) * (2.0 * math.pi * R)\n\n# คำนวณความเร็ว Linear (v) และ Angular (w)\nlinear_v = (dist_r + dist_l) / 2.0\nangular_w = (dist_r - dist_l) / W\n`,
    inputs: [{name:'enc_l'}, {name:'enc_r'}],
    outputs: [{name:'linear_v', type:'float'}, {name:'angular_w', type:'float'}],
    numInputs: 2,
    numOutputs: 2
  };
  
  const mecanumBlock = {
    id: 'default_mecanum',
    name: 'Mecanum Drive Math',
    emoji: '🚙',
    color: '#38b2ac',
    tab: 'odom',
    description: 'คำนวณสมการ 4 ล้อ (Mecanum) แปลง Encoder เป็นความเร็ว (vx, vy, w)',
    libs: ['math'],
    params: [
      {name: 'R', default: '0.05'},
      {name: 'Lx', default: '0.2'},
      {name: 'Ly', default: '0.15'},
      {name: 'TICKS', default: '4096.0'},
      {name: 'dt', default: '0.1'}
    ],
    code: `# แปลง ticks เป็น rad/s\nw_fl = (enc_fl / TICKS) * 2 * math.pi / dt\nw_fr = (enc_fr / TICKS) * 2 * math.pi / dt\nw_rl = (enc_rl / TICKS) * 2 * math.pi / dt\nw_rr = (enc_rr / TICKS) * 2 * math.pi / dt\n\n# Forward Kinematics\nlinear_x = (w_fl + w_fr + w_rl + w_rr) * (R / 4.0)\nlinear_y = (-w_fl + w_fr + w_rl - w_rr) * (R / 4.0)\nangular_z = (-w_fl + w_fr - w_rl + w_rr) * (R / (4.0 * (Lx + Ly)))\n`,
    inputs: [{name:'enc_fl'}, {name:'enc_fr'}, {name:'enc_rl'}, {name:'enc_rr'}],
    outputs: [{name:'linear_x', type:'float'}, {name:'linear_y', type:'float'}, {name:'angular_z', type:'float'}],
    numInputs: 4,
    numOutputs: 3
  };

  libRegisterBlock(diffDriveBlock, false);
  libRegisterBlock(mecanumBlock, false);
}

function libLoadAll(){
  try{
    const raw = localStorage.getItem(LIB_STORAGE_KEY);
    if(raw) {
      const blocks = JSON.parse(raw);
      blocks.forEach(b => libRegisterBlock(b, false));
      if(!blocks.find(b=>b.id==='default_diffdrive')) seedDefaultLibBlocks();
    } else {
      seedDefaultLibBlocks();
    }
  }catch(e){ console.warn('libLoadAll error:', e); seedDefaultLibBlocks(); }
}

function libSaveAll(){
  try{ localStorage.setItem(LIB_STORAGE_KEY, JSON.stringify(LIB_BLOCKS)); }catch(e){}
}

function libRegisterBlock(block, save=true){
  if(!block.id) block.id = 'lib_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
  if(!LIB_BLOCKS.find(b=>b.id===block.id)) LIB_BLOCKS.push(block);

  const inputs  = block.inputs  || [{name:'in_0'}];
  const outputs = block.outputs || [{name:'out_0', type:'any'}];
  const params  = block.params  || [];

  const inpPorts = inputs.map((p,i) => ({
    id: p.name||`in_${i}`, label: p.name||`in_${i}`,
    top: `${(i+1) * 100 / (inputs.length+1)}%`
  }));
  const outPorts = outputs.map((p,i) => ({
    id: p.name||`out_${i}`, label: p.name||`out_${i}`,
    top: `${(i+1) * 100 / (outputs.length+1)}%`
  }));

  const defaultProps = { _libId:block.id, _libName:block.name, icon:block.emoji||'🧩' };
  params.forEach(p => { defaultProps[p.name] = p.default; });
  
  const isTf = block.tab === 'tf';

  FLOW_TYPES['lib_'+block.id] = {
    label: block.name||'Custom Block',
    emoji: block.emoji||'🧩',
    cls: isTf ? 'fn-srv' : 'fn-math',
    portCls: isTf ? 'tf' : 'math',
    hint: block.description||'Custom library block',
    defaultProps: defaultProps,
    ports: { inp:inpPorts, out:outPorts },
    genCode: n => [
      `# Lib: ${block.name}`,
      `# Deps: ${(block.libs||[]).join(', ')||'none'}`,
    ].join('\n'),
    genMethod: () => {
      const inputArgs = inputs.map(p=>p.name);
      const paramArgs = params.map(p=>p.name);
      const allArgs = [...inputArgs, ...paramArgs].join(', ');
      
      const retArgs = outputs.map(p=>p.name).join(', ');
      const fnName = safeName(block.name||'custom');
      const codeLines = (block.code||'pass').split('\n').map(l=>'        '+l).join('\n');
      return `\n    def lib_${fnName}(self${allArgs ? ', '+allArgs : ''}):\n` +
             `        """${block.description||block.name}"""\n` +
             codeLines + '\n' +
             (retArgs ? `        return ${retArgs}\n` : '');
    },
    _libBlock: block,
  };

  if(save) libSaveAll();
  libRenderPalette();
}

function libInspectorExtras(node, def){
  const block = def._libBlock;
  if(!block) return '';
  const inputs  = block.inputs  || [];
  const outputs = block.outputs || [];
  const params  = block.params  || [];
  const libs    = block.libs    || [];
  return `
    <div class="insp-sep"></div>
    <div class="insp-label">Inputs</div>
    <div style="margin-bottom:8px">
      ${inputs.length===0 ? '<span style="font-size:10px;color:var(--dim)">None</span>' :
        inputs.map(p=>`<span style="display:inline-block;background:var(--adim);color:var(--acc);
          font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:4px;margin:2px 3px 2px 0;
          border:1px solid var(--abrd)">${escH(p.name)}</span>`).join('')}
    </div>
    <div class="insp-label">Outputs</div>
    <div style="margin-bottom:8px">
      ${outputs.length===0 ? '<span style="font-size:10px;color:var(--dim)">None</span>' :
        outputs.map(p=>`<span style="display:inline-block;background:var(--gdim);color:var(--grn);
          font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:4px;margin:2px 3px 2px 0;
          border:1px solid rgba(62,207,142,.3)">${escH(p.name)} [${escH(p.type||'any')}]</span>`).join('')}
    </div>
    <div class="insp-label">Parameters (Props)</div>
    <div style="margin-bottom:8px">
      ${params.length===0 ? '<span style="font-size:10px;color:var(--dim)">None</span>' :
        params.map(p=>`<span style="display:inline-block;background:var(--adm2);color:var(--amb);
          font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:4px;margin:2px 3px 2px 0;
          border:1px solid rgba(245,166,35,.3)">${escH(p.name)}</span>`).join('')}
    </div>
    ${libs.length>0 ? `<div class="insp-label">Libraries</div>
    <div style="margin-bottom:8px;font-family:var(--mono);font-size:11px;color:var(--mt)">${escH(libs.join(', '))}</div>` : ''}
    <div class="insp-label">Python Code</div>
    <div class="insp-preview" style="max-height:100px;margin-bottom:8px">${escH(block.code||'# empty')}</div>
    <button style="width:100%;padding:6px;border-radius:6px;font-size:11px;font-weight:500;
      font-family:var(--fn);cursor:pointer;border:1px solid rgba(56,178,172,.35);
      background:rgba(56,178,172,.1);color:var(--tel);transition:all .15s;margin-bottom:4px"
      onclick="libEditBlock(decodeURIComponent('${encArg(block.id)}'))">✏️ แก้ไขโครงสร้างโค้ด Block (แก้ไขต้นฉบับ)</button>
    <button style="width:100%;padding:6px;border-radius:6px;font-size:11px;font-weight:500;
      font-family:var(--fn);cursor:pointer;border:1px solid var(--brd);
      background:var(--bg2);color:var(--mt);transition:all .15s"
      onclick="libExportSingle(decodeURIComponent('${encArg(block.id)}'))">📤 Export Block</button>`;
}

function libExportSingle(blockId){
  const block = LIB_BLOCKS.find(b=>b.id===blockId);
  if(!block) return;
  const blob = new Blob([JSON.stringify(block,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (block.name||'block').replace(/\s+/g,'_')+'.libblock.json';
  a.click(); URL.revokeObjectURL(a.href);
  sbMsg('Block exported', 2000);
}

function libRenderPalette(){
  const tabs = ['basic', 'tf', 'odom', 'others'];
  tabs.forEach(t => {
    const container = document.getElementById('lib-pal-' + t);
    if(!container) return;
    const blocks = LIB_BLOCKS.filter(b => (b.tab || 'others') === t);
    if(blocks.length === 0){
      container.innerHTML = '<div style="font-size:10px;color:var(--dim);padding:4px 12px">No custom blocks in this category</div>';
    } else {
      container.innerHTML = blocks.map(b => `
        <div class="pal-block pb-math" draggable="true"
          ondragstart="palDragStart(event,decodeURIComponent('${encArg('lib_'+b.id)}'))"
          onclick="palClick(decodeURIComponent('${encArg('lib_'+b.id)}'))"
          style="border-color:${/^#[0-9a-f]{6}$/i.test(b.color||'')?b.color:'#38b2ac'}; margin-bottom:4px;"
          title="${escH(b.description||'')}">
          <span class="pal-dot" style="background:${/^#[0-9a-f]{6}$/i.test(b.color||'')?b.color:'#38b2ac'}"></span>
          ${escH(b.emoji||'🧩')} ${escH(b.name||'Block')}
          <span style="margin-left:auto;font-size:9px;color:var(--dim);cursor:pointer;background:var(--bg2);padding:2px 4px;border-radius:4px;"
            onclick="event.stopPropagation();libEditBlock(decodeURIComponent('${encArg(b.id)}'))" title="Edit">✏️ Edit</span>
        </div>`).join('');
    }
  });
}

function libAddPort(dir, name, defVal='0.0', defType='any'){
  const listId = dir==='inp' ? 'lib-inp-list' : (dir==='out' ? 'lib-out-list' : 'lib-param-list');
  const list = document.getElementById(listId);
  if(!list) return;
  const count = list.children.length;
  const defaultName = name || (dir==='inp' ? `input_${count}` : (dir==='out' ? `output_${count}` : `param_${count}`));
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px';
  
  let extra = '';
  if(dir === 'param') {
    extra = `<input type="text" value="${escH(defVal)}" class="lib-port-def"
      style="width:60px;background:var(--bg2);border:1px solid var(--brd);color:var(--txt);
      font-family:var(--mono);font-size:12px;padding:4px;border-radius:5px;outline:none"
      placeholder="default"/>`;
  } else if (dir === 'out') {
    extra = `<select class="lib-port-type" style="background:var(--bg2);border:1px solid var(--brd);color:var(--txt);font-family:var(--mono);font-size:11px;padding:3px;border-radius:5px;outline:none">
      <option value="any" ${defType==='any'?'selected':''}>Auto</option>
      <option value="float" ${defType==='float'?'selected':''}>float</option>
      <option value="int" ${defType==='int'?'selected':''}>int</option>
      <option value="bool" ${defType==='bool'?'selected':''}>bool</option>
      <option value="str" ${defType==='str'?'selected':''}>str</option>
    </select>`;
  }

  row.innerHTML = `
    <span style="font-size:11px;color:var(--dim);width:14px;text-align:center">${count}</span>
    <input type="text" value="${escH(defaultName)}" class="lib-port-name"
      style="flex:1;background:var(--bg2);border:1px solid var(--brd);color:var(--txt);
      font-family:var(--mono);font-size:12px;padding:4px 8px;border-radius:5px;outline:none"
      placeholder="variable_name"/>
    ${extra}
    <span style="font-size:10px;color:${dir==='inp'?'var(--acc)':(dir==='out'?'var(--grn)':'var(--amb)')}">${dir==='inp'?'← inp':(dir==='out'?'→ out':'★ param')}</span>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--red);
      cursor:pointer;font-size:14px;padding:0 4px" title="Remove">×</button>`;
  list.appendChild(row);
}

function libGetPorts(dir){
  const listId = dir==='inp' ? 'lib-inp-list' : (dir==='out' ? 'lib-out-list' : 'lib-param-list');
  const list = document.getElementById(listId);
  if(!list) return [];
  return [...list.children].map(row => {
    const nameInput = row.querySelector('.lib-port-name');
    const name = nameInput ? nameInput.value.trim().replace(/[^\w]/g,'_') : '';
    const finalName = name || (dir+'_'+Math.random().toString(36).slice(2,5));
    
    let res = {name: finalName};
    
    if(dir === 'param') {
      const defInput = row.querySelector('.lib-port-def');
      if(defInput) res.default = defInput.value.trim();
    } else if (dir === 'out') {
      const typeSel = row.querySelector('.lib-port-type');
      if(typeSel) res.type = typeSel.value;
    }
    return res;
  });
}

function libOpenCreator(editId){
  const existing = editId ? LIB_BLOCKS.find(b=>b.id===editId) : null;
  const modal = document.getElementById('modal-lib-creator');
  if(!modal) return;

  document.getElementById('lib-name').value   = existing?.name||'';
  document.getElementById('lib-emoji').value   = existing?.emoji||'🧩';
  document.getElementById('lib-color').value   = existing?.color||'#38b2ac';
  document.getElementById('lib-desc').value    = existing?.description||'';
  document.getElementById('lib-libs').value    = (existing?.libs||[]).join(', ');
  document.getElementById('lib-code').value    = existing?.code||'# Python code\n# Use input variable names defined above\n# Assign results to output variable names\nout_0 = in_0';
  document.getElementById('lib-test-output').textContent = '';
  modal.dataset.editId = editId||'';

  let tabFld = document.getElementById('lib-tab');
  if(!tabFld) {
    const descFld = document.getElementById('lib-desc').parentNode;
    const newFld = document.createElement('div');
    newFld.className = 'fld';
    newFld.style.marginBottom = '14px';
    newFld.innerHTML = `
      <label>Category Tab (จัดกลุ่มให้อยู่ในหน้าไหน)</label>
      <select id="lib-tab" style="width:100%;background:var(--bg2);border:1px solid var(--brd);color:var(--txt);font-family:var(--mono);font-size:13px;padding:7px 11px;border-radius:7px;outline:none;">
        <option value="basic">เบื้องต้น (Basics)</option>
        <option value="tf">Transform (TF)</option>
        <option value="odom">Odom & Kinematics</option>
        <option value="others">อื่นๆ (Others)</option>
      </select>
    `;
    descFld.parentNode.insertBefore(newFld, descFld.nextSibling);
    tabFld = document.getElementById('lib-tab');
  }
  tabFld.value = existing?.tab || 'others';

  let paramDiv = document.getElementById('lib-param-wrap');
  if(!paramDiv) {
    const outDiv = document.getElementById('lib-out-list').parentNode;
    paramDiv = document.createElement('div');
    paramDiv.id = 'lib-param-wrap';
    paramDiv.style.marginBottom = '14px';
    paramDiv.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <label style="font-size:12px;font-weight:600;color:var(--amb)">Parameters (ค่าคงที่ที่ตั้งได้ในหน้าจอ)</label>
        <button class="btn" style="font-size:10px;padding:1px 8px" onclick="libAddPort('param')">+ Add</button>
      </div>
      <div id="lib-param-list" style="display:flex;flex-direction:column;gap:4px"></div>
    `;
    outDiv.parentNode.insertBefore(paramDiv, outDiv.nextSibling);
  }

  const inpList = document.getElementById('lib-inp-list');
  const outList = document.getElementById('lib-out-list');
  const paramList = document.getElementById('lib-param-list');
  inpList.innerHTML = ''; outList.innerHTML = ''; paramList.innerHTML = '';

  const inputs  = existing?.inputs  || [{name:'in_0'}];
  const outputs = existing?.outputs || [{name:'out_0', type:'any'}];
  const params  = existing?.params  || [];

  inputs.forEach(p => libAddPort('inp', p.name));
  outputs.forEach(p => libAddPort('out', p.name, null, p.type));
  params.forEach(p => libAddPort('param', p.name, p.default));

  openModal('modal-lib-creator');
  setTimeout(()=>document.getElementById('lib-name').focus(), 80);
}

function libEditBlock(id){ libOpenCreator(id); }

function libSaveFromModal(){
  const name   = document.getElementById('lib-name').value.trim();
  const emoji  = document.getElementById('lib-emoji').value.trim()||'🧩';
  const color  = document.getElementById('lib-color').value;
  const desc   = document.getElementById('lib-desc').value.trim();
  const libs   = document.getElementById('lib-libs').value.split(',').map(s=>s.trim()).filter(Boolean);
  const code   = document.getElementById('lib-code').value;
  const tab    = document.getElementById('lib-tab')?.value || 'others';
  const editId = document.getElementById('modal-lib-creator').dataset.editId;
  const inputs  = libGetPorts('inp');
  const outputs = libGetPorts('out');
  const params  = libGetPorts('param');

  if(!name){ alert('Please enter a block name'); return; }

  const block = {
    id: editId || ('lib_'+Date.now()),
    name, emoji, color, description:desc, libs, code,
    inputs, outputs, params, tab,
    numInputs: inputs.length, numOutputs: outputs.length,
  };

  if(editId){
    const idx = LIB_BLOCKS.findIndex(b=>b.id===editId);
    if(idx>=0) LIB_BLOCKS.splice(idx,1);
    delete FLOW_TYPES['lib_'+editId];
  }

  libRegisterBlock(block);
  closeModal('modal-lib-creator');
  sbMsg('Block "'+name+'" saved!', 2000);
}

function libDeleteBlock(){
  const editId = document.getElementById('modal-lib-creator').dataset.editId;
  if(!editId||!confirm('Delete this block permanently?')) return;
  const idx = LIB_BLOCKS.findIndex(b=>b.id===editId);
  if(idx>=0) LIB_BLOCKS.splice(idx,1);
  delete FLOW_TYPES['lib_'+editId];
  FLOW.nodes = FLOW.nodes.filter(n=>n.type!=='lib_'+editId);
  FLOW.edges = FLOW.edges.filter(e=>FLOW.nodes.find(n=>n.id===e.from)&&FLOW.nodes.find(n=>n.id===e.to));
  libSaveAll(); libRenderPalette(); flowRender();
  closeModal('modal-lib-creator');
  sbMsg('Block deleted', 2000);
}

function libExportBlock(){
  const editId = document.getElementById('modal-lib-creator').dataset.editId;
  const block = editId ? LIB_BLOCKS.find(b=>b.id===editId) : {
    name: document.getElementById('lib-name').value.trim(),
    emoji: document.getElementById('lib-emoji').value.trim(),
    color: document.getElementById('lib-color').value,
    description: document.getElementById('lib-desc').value.trim(),
    libs: document.getElementById('lib-libs').value.split(',').map(s=>s.trim()).filter(Boolean),
    code: document.getElementById('lib-code').value,
    inputs: libGetPorts('inp'), outputs: libGetPorts('out'), params: libGetPorts('param'),
    tab: document.getElementById('lib-tab')?.value || 'others',
  };
  const blob = new Blob([JSON.stringify(block,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (block.name||'block').replace(/\s+/g,'_')+'.libblock.json';
  a.click(); URL.revokeObjectURL(a.href);
  sbMsg('Block exported', 2000);
}

function libImportBlock(){
  const inp = document.createElement('input');
  inp.type='file'; inp.accept='.json,.libblock.json';
  inp.onchange = e => {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try{
        const data = JSON.parse(ev.target.result);
        if(!data.name) throw new Error('Invalid lib block file');
        data.id = 'lib_'+Date.now();
        libRegisterBlock(data);
        sbMsg('Imported: '+data.name, 2500);
      }catch(err){ alert('Import error: '+err.message); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

function libTestCode(){
  const code    = document.getElementById('lib-code').value;
  const inputs  = libGetPorts('inp');
  const outputs = libGetPorts('out');
  const params  = libGetPorts('param');
  const output  = document.getElementById('lib-test-output');

  const testVars = inputs.map((p,i) => `${p.name} = ${i+1}`).join('\n');
  const testParams = params.map((p) => `${p.name} = ${p.default}`).join('\n');
  const printSection = outputs.map(p => `print("${p.name} =", ${p.name})`).join('\n');

  const fullScript = [
    'import math',
    '# --- Test inputs and params ---',
    testVars,
    testParams,
    '',
    '# --- User code ---',
    code,
    '',
    '# --- Print results ---',
    'print("=== Results ===")',
    printSection,
    'print("=== Done ===")',
  ].join('\n');

  output.textContent = '--- Test Script ---\n' + fullScript + '\n\n';

  if(!sessionId){
    output.textContent += '(SSH not connected - copy code to test locally)\n';
    return;
  }

  output.textContent += '--- Running on robot ---\n';

  const tmpPath = '/tmp/ros2ide_libtest_' + Date.now() + '.py';
  API('/api/files/write', {sessionId, path: tmpPath, content: fullScript})
    .then(r => {
      if(!r.ok){ output.textContent += 'Error writing temp file: '+r.error+'\n'; return; }
      return API('/api/exec', {sessionId, command: `python3 ${tmpPath} && rm -f ${tmpPath}`, timeout: 10000});
    })
    .then(r => {
      if(!r) return;
      if(r.stdout) output.textContent += r.stdout + '\n';
      if(r.stderr) output.textContent += 'STDERR:\n' + r.stderr + '\n';
      if(!r.stdout && !r.stderr) output.textContent += '(no output)\n';
    })
    .catch(e => output.textContent += 'Error: '+e.message+'\n');
}

function libCodeKeydown(e){
  if(e.key === 'Tab'){
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.substring(0,start) + '    ' + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + 4;
  }
}

// ── Dynamic Modal สำหรับรับค่า Custom Type ──
function flowCustomTypeDialog(nodeId, key) {
  let modal = document.getElementById('modal-custom-type');
  if(!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-custom-type';
    modal.className = 'overlay hidden';
    modal.innerHTML = `
      <div class="modal modal-sm">
        <h2 id="mct-title">Custom Type</h2>
        <div class="fld" style="margin-top:12px">
          <label id="mct-label">กรอกชื่อ Type (เช่น custom_msgs/MyMsg)</label>
          <input id="mct-input" class="insp-input" type="text" placeholder="package_name/MessageName"/>
        </div>
        <div class="mfooter">
          <button class="btn" onclick="document.getElementById('modal-custom-type').classList.add('hidden'); flowRenderInspector();">ยกเลิก</button>
          <button class="btn btn-p" id="mct-save">เพิ่ม</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  
  const title = key === 'srvType' ? 'เพิ่ม Service Type ใหม่' : 'เพิ่ม Message Type ใหม่';
  document.getElementById('mct-title').textContent = title;
  const inp = document.getElementById('mct-input');
  inp.value = '';
  
  const saveBtn = document.getElementById('mct-save');
  saveBtn.onclick = () => {
    const val = inp.value.trim();
    if(val) {
      window._customMsgTypes = window._customMsgTypes || [];
      if(!window._customMsgTypes.includes(val)) window._customMsgTypes.push(val);
      flowUpdateProp(nodeId, key, val);
      modal.classList.add('hidden');
    }
  };
  
  inp.onkeydown = (e) => { if(e.key === 'Enter') { e.preventDefault(); saveBtn.click(); } };
  
  modal.classList.remove('hidden');
  setTimeout(() => inp.focus(), 100);
}

// ── Package Wizard: Add missing functions for full implementation ──
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
  if(typeof wizRenderDeps === 'function') wizRenderDeps();
  if(typeof wizRenderTemplates === 'function') wizRenderTemplates();
  if(typeof wizRenderStep === 'function') wizRenderStep();
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
  if(typeof wizRenderDeps === 'function') wizRenderDeps();
  if(typeof wizRenderTemplates === 'function') wizRenderTemplates();
  if(typeof wizUpdatePreview === 'function') wizUpdatePreview();
}

function wizStep(dir) {
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
    if(typeof wizCreate === 'function') wizCreate();
    return;
  }

  wizState.step = Math.max(0, Math.min(3, step + dir));
  if(typeof wizRenderStep === 'function') wizRenderStep();
}

function wizToggleDep(id, must) {
  if (must) return; 
  if (wizState.deps.has(id)) wizState.deps.delete(id);
  else wizState.deps.add(id);
  if(typeof wizRenderDeps === 'function') wizRenderDeps();
}

function wizSelTemplate(id) {
  wizState.template = id;
  if(typeof wizRenderTemplates === 'function') wizRenderTemplates();
  if(typeof wizUpdatePreview === 'function') wizUpdatePreview();
}
