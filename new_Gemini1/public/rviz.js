// ═══════════════════════════════════════════════════════════════
//  RVIZ 3D — v5 (True TF Graph Implementation)
//  - Realtime: persistent Python process stream ผ่าน /api/exec
//  - Bidirectional TF: คำนวณ Fixed Frame ได้สมบูรณ์ 100% เหมือน RViz จริง
//  - ROS→Three: r2t(rx,ry,rz) = (-ry, rz, -rx)
// ═══════════════════════════════════════════════════════════════
'use strict';

// ── coord conversion ──
function r2t(rx,ry,rz){ return new THREE.Vector3(-ry,rz,-rx); }
function rq2tq(qx,qy,qz,qw){ return new THREE.Quaternion(-qy,qz,-qx,qw).normalize(); }

// ── state ──
const rviz3d={renderer:null,scene:null,camera:null,objects:{},
  msgCount:0,lastFpsT:0,robotPos:{x:0,y:0,yaw:0},
  fixedFrame:'odom',
  fixedFrameLocked:false, // true = ผู้ใช้เลือก/ตรวจพบ frame เสถียรแล้ว → ห้าม auto-jump ทับ
  worldTFs: new Map(), // เก็บพิกัดทุก Frame เทียบกับ Fixed Frame
  tfFrames:['map','odom','base_link','base_footprint','laser_frame']};
const rvizCam={theta:Math.PI/4,phi:Math.PI/3,radius:8,
  target:{x:0,y:0,z:0},drag:false,rightDrag:false,lx:0,ly:0};

let _live=false, _streamPid=null, _pingTimer=null, _pingFails=0;
let _setupBash='/opt/ros/humble/setup.bash';
const _tfStore=new Map(), _texCache=new Map();
let displayList=[], _nid=1;
const _mkId=()=>'rv'+(_nid++);

// ── dispose helper: คืน memory (geometry + material) ให้ GPU ──
// ⚠️ ระวัง texture ของ label (SpriteMaterial.map) ที่ถูกแชร์ผ่าน _texCache
//    ห้าม dispose texture เหล่านั้นเด็ดขาด (ไม่งั้น label ตัวเดียวกันจะว่างเปล่าตอนสร้างใหม่)
function _disposeObj(o){
  if(!o||!o.traverse) return;
  o.traverse(c=>{
    if(c.geometry) c.geometry.dispose();
    const m=c.material; if(!m) return;
    (Array.isArray(m)?m:[m]).forEach(mm=>{
      const isCachedLabel = mm.map && (_texCache instanceof Map) && [..._texCache.values()].includes(mm.map);
      if(mm.map && !isCachedLabel && mm.map.dispose) mm.map.dispose();
      if(mm.dispose) mm.dispose();
    });
  });
}

// ── ล้าง object ไดนามิกทั้งหมดใน scene ก่อนเริ่มสตรีมใหม่ ──
// กันของเก่า (แกน TF / โมเดลหุ่น / เส้น Odom / ลูกศร Laser) ค้างกระพิบหลังอัพเดท tf/model หรือ ปิดเปิดใหม่
function _resetVisuals(){
  if(!rviz3d.scene) return;
  displayList.forEach(d=>{
    const obj=rviz3d.objects[d.id]; if(!obj) return;
    if(d.type==='TF'||d.type==='Odometry'){
      while(obj.children.length){ const c=obj.children[0]; obj.remove(c); _disposeObj(c); }
    }
    if(d.type==='Odometry') obj._pts=[];
    if(d.type==='RobotModel'){
      while(obj.children.length){ const c=obj.children[0]; obj.remove(c); _disposeObj(c); }
      obj.userData.parsed=null;
    }
    if(d.type==='LaserScan'&&obj.geometry) obj.geometry.setDrawRange(0,0);
  });
  // dispose texture ของ label ทั้งหมด (ไม่ถูกอ้างอิงแล้วหลังลบ sprite) แล้วล้าง cache
  if(_texCache instanceof Map){ _texCache.forEach(t=>t.dispose&&t.dispose()); _texCache.clear(); }
  rviz3d.worldTFs=new Map();
}

// ── ตัดการเชื่อมต่อเมื่อ backend หาย (node ดับ / session ตาย) ──
//   ล้าง scene ทิ้ง (กันภาพ tf/โมเดลเก่าค้างหลังปิด node) แล้วกลับสู่สถานะ Connect
function _dropConnection(msg){
  if(!_live) return;
  _live=false;
  clearInterval(_pingTimer); _pingTimer=null;
  _resetVisuals();                 // ล้างแกน TF / โมเดล / เส้นทั้งหมด → ไม่ค้างภาพเก่า
  _badge('Disconnected','br','dr');
  const b=document.getElementById('btn-rviz-connect');
  if(b){b.textContent='▶ Connect';b.className='btn btn-g';}
  _ovl(msg||'Disconnected');
}

// ── msg type → display type mapping ──
const TYPE_MAP={
  'sensor_msgs/msg/LaserScan':'LaserScan',
  'sensor_msgs/LaserScan':'LaserScan',
  'nav_msgs/msg/Odometry':'Odometry',
  'nav_msgs/Odometry':'Odometry',
  'nav_msgs/msg/Path':'Path',
  'nav_msgs/Path':'Path',
  'nav_msgs/msg/OccupancyGrid':'Map',
  'nav_msgs/OccupancyGrid':'Map',
  'geometry_msgs/msg/PoseStamped':'Pose',
  'geometry_msgs/msg/PoseWithCovarianceStamped':'Pose',
  'geometry_msgs/msg/PoseArray':'PoseArray',
  'visualization_msgs/msg/Marker':'Marker',
  'visualization_msgs/msg/MarkerArray':'Marker',
  'sensor_msgs/msg/PointCloud2':'PointCloud2',
  'sensor_msgs/msg/Range':'Range',
  'tf2_msgs/msg/TFMessage':'TF',
};

// ═══════════════════════════════════════════════════════════════
//  DISPLAY TYPES
// ═══════════════════════════════════════════════════════════════
const DTYPES={
  Grid:{label:'Grid',icon:'🔲',msgType:null,def:{cellSize:1,cellCount:20,color:'#3a3a3a'},
    html:(id,p)=>`
      <div class="rp"><span>Cell Size (m)</span>
        <input type="number" value="${p.cellSize}" step="0.5" min="0.1" class="rv"
          onchange="rdP('${id}','cellSize',+this.value);_rebuildGrid('${id}')"></div>
      <div class="rp"><span>Cell Count</span>
        <input type="number" value="${p.cellCount}" min="2" class="rv"
          onchange="rdP('${id}','cellCount',+this.value);_rebuildGrid('${id}')"></div>
      <div class="rp"><span>Color</span>
        <input type="color" value="${p.color}" class="rv"
          onchange="rdP('${id}','color',this.value);_rebuildGrid('${id}')"></div>`},
  RobotModel:{label:'RobotModel',icon:'🤖',msgType:null,def:{alpha:1, baseFrame:'base_link'},
    html:(id,p)=>`
      <div class="rp"><span>Description Topic</span>
        <input type="text" value="/robot_description" class="rv" disabled
          title="ดึงโมเดลหุ่นยนต์จาก topic /robot_description (URDF) ของ package ที่รัน"></div>
      <div class="rp"><span>Status</span>
        <span id="rmstat-${id}" class="rviz-rmstat">${_robotModelStatusText}</span></div>
      <div class="rp"><span>Alpha</span>
        <input type="range" value="${p.alpha}" step="0.05" min="0" max="1" class="rv"
          oninput="rdP('${id}','alpha',+this.value);_rebuildRobotModels()"></div>
      <div class="rp"><span>Base Frame</span>
        <input type="text" value="${p.baseFrame}" class="rv"
          title="เฟรมหลักของหุ่น (ใช้เป็นจุดยึดสำรองเมื่อบาง link ไม่มี TF)"
          onchange="rdP('${id}','baseFrame',this.value);_rebuildRobotModels()"></div>`},
  TF:{label:'TF',icon:'🔗',msgType:'tf2_msgs/msg/TFMessage',def:{axesLength:0.25,showNames:true},
    html:(id,p)=>`
      <div class="rp"><span>Axes Length (m)</span>
        <input type="number" value="${p.axesLength}" step="0.05" min="0.03" class="rv"
          onchange="rdP('${id}','axesLength',+this.value)"></div>
      <div class="rp"><span>Show Names</span>
        <input type="checkbox" ${p.showNames?'checked':''} class="rv"
          onchange="rdP('${id}','showNames',this.checked)"></div>`},
  LaserScan:{label:'LaserScan',icon:'📡',msgType:'sensor_msgs/msg/LaserScan',
    def:{topic:'/scan',frameId:'laser_frame',size:0.04,color:'#ff3333',colorType:'flat',maxRange:30},
    html:(id,p)=>`
      <div class="rp"><span>Topic</span>
        <input type="text" value="${p.topic}" class="rv"
          onchange="rdP('${id}','topic',this.value)"></div>
      <div class="rp"><span>Frame ID</span>
        <input type="text" value="${p.frameId}" class="rv"
          onchange="rdP('${id}','frameId',this.value)"></div>
      <div class="rp"><span>Point Size</span>
        <input type="number" value="${p.size}" step="0.005" min="0.005" class="rv"
          onchange="rdP('${id}','size',+this.value)"></div>
      <div class="rp"><span>Color</span>
        <input type="color" value="${p.color}" class="rv"
          onchange="rdP('${id}','color',this.value)"></div>
      <div class="rp"><span>Color Mode</span>
        <select class="rv" onchange="rdP('${id}','colorType',this.value)">
          <option value="flat" ${p.colorType==='flat'?'selected':''}>Flat</option>
          <option value="range" ${p.colorType==='range'?'selected':''}>Range</option>
        </select></div>
      <div class="rp"><span>Max Range (m)</span>
        <input type="number" value="${p.maxRange}" step="1" min="1" class="rv"
          onchange="rdP('${id}','maxRange',+this.value)"></div>`},
  Odometry:{label:'Odometry',icon:'📍',msgType:'nav_msgs/msg/Odometry',
    def:{topic:'/odom',frameId:'odom',color:'#f5a623',keep:300},
    html:(id,p)=>`
      <div class="rp"><span>Topic</span>
        <input type="text" value="${p.topic}" class="rv"
          onchange="rdP('${id}','topic',this.value)"></div>
      <div class="rp"><span>Frame ID</span>
        <input type="text" value="${p.frameId}" class="rv"
          onchange="rdP('${id}','frameId',this.value)"></div>
      <div class="rp"><span>Keep</span>
        <input type="number" value="${p.keep}" step="50" min="10" class="rv"
          onchange="rdP('${id}','keep',+this.value)"></div>
      <div class="rp"><span>Color</span>
        <input type="color" value="${p.color}" class="rv"
          onchange="rdP('${id}','color',this.value)"></div>`},
};

// ═══════════════════════════════════════════════════════════════
//  DISPLAY MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function rvizAddDisplay(type,enabled=true,overrides={}){
  const def=DTYPES[type]; if(!def) return;
  const id=_mkId();
  const props=Object.assign({},def.def,overrides);
  displayList.push({id,type,enabled,props});
  _buildObj(id,type,props);
  return id;
}
function rvizRemoveDisplay(id){
  const i=displayList.findIndex(d=>d.id===id); if(i<0) return;
  const obj=rviz3d.objects[id];
  if(obj){_disposeObj(obj);rviz3d.scene?.remove(obj);delete rviz3d.objects[id];}
  displayList.splice(i,1); rvizRenderPanel();
  if(_live) _restartStream(); // restart with new topic set
}
function rdP(id,key,val){
  const d=displayList.find(d=>d.id===id); if(d) d.props[key]=val;
  if(_live&&(key==='topic')) _restartStream();
}
function rdEnable(id,en){
  const d=displayList.find(d=>d.id===id); if(!d) return;
  d.enabled=en;
  const obj=rviz3d.objects[id]; if(obj) obj.visible=en;
  if(_live) _restartStream();
}
function _rebuildGrid(id){
  const d=displayList.find(d=>d.id===id); if(!d) return;
  _buildObj(id,'Grid',d.props);
  if(rviz3d.objects[id]) rviz3d.objects[id].visible=d.enabled;
}

// ═══════════════════════════════════════════════════════════════
//  THREE FACTORY
// ═══════════════════════════════════════════════════════════════
function _buildObj(id,type,props){
  if(!rviz3d.scene||typeof THREE==='undefined') return;
  const old=rviz3d.objects[id]; if(old){ _disposeObj(old); rviz3d.scene.remove(old); }
  let obj=null;
  if(type==='Grid'){
    const sz=(props.cellSize||1)*(props.cellCount||20);
    const col=new THREE.Color(props.color||'#3a3a3a');
    obj=new THREE.GridHelper(sz,props.cellCount||20,col,col);
  } else if(type==='RobotModel'){
    obj=_mkRobotModel(props);
  } else if(type==='TF'){
    obj=new THREE.Group();
  } else if(type==='LaserScan'){
    const N=4096;
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(N*3),3));
    geo.setAttribute('color',   new THREE.BufferAttribute(new Float32Array(N*3),3));
    geo.setDrawRange(0,0);
    obj=new THREE.Points(geo,new THREE.PointsMaterial({size:props.size||0.04,vertexColors:true,sizeAttenuation:true}));
  } else if(type==='Odometry'){
    obj=new THREE.Group(); obj._pts=[];
  }
  if(obj){ obj.visible=true; rviz3d.scene.add(obj); rviz3d.objects[id]=obj; }
}

function _mkAxes(len){
  const g=new THREE.Group();
  // วาดแกนตามระบบพิกัด ROS (X=แดง, Y=เขียว, Z=น้ำเงิน) แล้วแปลงด้วย r2t เพื่อให้ตรงกับ Three.js
  [[len,0,0,0xff2020],[0,len,0,0x20ff20],[0,0,len,0x2020ff]].forEach(([x,y,z,c])=>{
    const pt = r2t(x, y, z);
    const geo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), pt]);
    g.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:c})));
  });
  return g;
}
function _mkLabel(text){
  let tex=_texCache.get(text);
  if(!tex){
    const cv=document.createElement('canvas'); cv.width=256; cv.height=56;
    const ctx=cv.getContext('2d');
    ctx.fillStyle='rgba(0,0,0,.72)';
    ctx.beginPath(); ctx.roundRect(2,6,252,44,7); ctx.fill();
    ctx.font='bold 20px monospace'; ctx.fillStyle='#fff';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text,128,28);
    tex=new THREE.CanvasTexture(cv); _texCache.set(text,tex);
  }
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true}));
  sp.scale.set(0.6,0.13,1); return sp;
}

// ══ โมเดลหุ่นยนต์ ดึงจาก topic /robot_description (URDF จาก package ที่รัน) ══
// ไม่ใช้โมเดลจำลองที่สร้างไว้ล่วงหน้า — แสดงเฉพาะสิ่งที่ package จริง publish เท่านั้น
// ถ้ายังไม่มี package ใด publish /robot_description จะไม่แสดงหุ่นยนต์เลย (ไม่มี "หุ่นจำลอง" ขึ้นมาเอง)
let _robotDesc = null;     // ข้อความ URDF ล่าสุดจาก /robot_description
let _robotDescSig = '';    // ลายเซ็นตรวจว่ามีการเปลี่ยนแปลงหรือไม่
let _robotModelStatusText = 'กำลังรอรับ /robot_description…';  // ข้อความสถานะที่แสดงในแผง RobotModel
function _setRobotModelStatus(text){
  _robotModelStatusText = text;
  displayList.filter(d=>d.type==='RobotModel').forEach(d=>{
    const el=document.getElementById('rmstat-'+d.id); if(el) el.textContent=text;
  });
}

// ── ตัวช่วยคณิตศาสตร์ TF ในพิกัด ROS (x=หน้า, y=ซ้าย, z=ขึ้น) ──
// คูณ pose (p=ตำแหน่ง, q=ควอเทอร์เนียน ROS) แบบ ROS: pa ∘ pb
function _se3Compose(pa, qa, pb, qb) {
  const v = new THREE.Vector3(pb[0], pb[1], pb[2]).applyQuaternion(new THREE.Quaternion(qa[0], qa[1], qa[2], qa[3]));
  const q = new THREE.Quaternion(qb[0], qb[1], qb[2], qb[3]).premultiply(new THREE.Quaternion(qa[0], qa[1], qa[2], qa[3]));
  return [[pa[0] + v.x, pa[1] + v.y, pa[2] + v.z], [q.x, q.y, q.z, q.w]];
}
// inverse ของ pose
function _se3Inverse(p, q) {
  const Q = new THREE.Quaternion(q[0], q[1], q[2], q[3]).conjugate();
  const v = new THREE.Vector3(-p[0], -p[1], -p[2]).applyQuaternion(Q);
  return [[v.x, v.y, v.z], [Q.x, Q.y, Q.z, Q.w]];
}
// RPY (fixed-axis ตามมาตรฐาน ROS) → ควอเทอร์เนียน ROS [x,y,z,w]
function _rpyToQuat(roll, pitch, yaw) {
  const cr = Math.cos(roll/2), sr = Math.sin(roll/2);
  const cp = Math.cos(pitch/2), sp = Math.sin(pitch/2);
  const cy = Math.cos(yaw/2), sy = Math.sin(yaw/2);
  return [
    sr*cp*cy - cr*sp*sy,   // x
    cr*sp*cy + sr*cp*sy,   // y
    cr*cp*sy - sr*sp*cy,   // z
    cr*cp*cy + sr*sp*sy,   // w
  ];
}
function _poseXYZRPY(x, y, z, roll, pitch, yaw) {
  return [[x, y, z], _rpyToQuat(roll, pitch, yaw)];
}

// ── แปลง URDF (XML) → โครงสร้างลิงก์/จอยnt์ (ทนทานต่อ XML namespace) ──
// ใช้ localName แทน querySelector เพราะ URDF จาก package จริงมักมี xmlns
// ใช้ childNodes แล้วกรอง nodeType===1 เพราะ children[] อาจข้าม text nodes
function _localChildren(el, name){
  const out=[]; if(!el) return out;
  for(const c of el.childNodes) if(c.nodeType===1 && c.localName===name) out.push(c);
  return out;
}
function _localFirst(el, name){
  if(!el) return null;
  for(const c of el.childNodes) if(c.nodeType===1 && c.localName===name) return c;
  return null;
}
function _parseURDF(urdf){
  if(!urdf || !urdf.trim()) return null;
  let doc;
  try{ doc = new DOMParser().parseFromString(urdf, 'application/xml'); }
  catch(e){ return null; }
  let robot = null;
  for (const e of (doc.children||[])) {
    if (e.localName === 'robot') { robot = e; break; }
  }
  if (!robot) return null;

  // สร้าง lookup ของ material definitions (name → {color,opacity}) ที่ระดับ robot
  const materialDefs = {};
  _localChildren(robot, 'material').forEach(matEl => {
    const matName = matEl.getAttribute('name');
    const colorEl = _localFirst(matEl, 'color');
    if(matName && colorEl){
      const rgba = (colorEl.getAttribute('rgba') || '0.7 0.7 0.7 1').split(/\s+/).map(Number);
      const r = Math.round((rgba[0]||0)*255), g = Math.round((rgba[1]||0)*255), b = Math.round((rgba[2]||0)*255);
      const a = (rgba[3]===undefined ? 1 : rgba[3]);
      materialDefs[matName] = { color:'#'+[r,g,b].map(v=>('0'+v.toString(16)).slice(-2)).join(''), opacity:a };
    }
  });

  const links = {};
  _localChildren(robot, 'link').forEach(l => {
    const name = l.getAttribute('name'); if(!name) return;
    const visuals = [];
    _localChildren(l, 'visual').forEach(v => {
      const geoEl = _localFirst(v, 'geometry');
      const oriEl = _localFirst(v, 'origin');
      let geo = null;
      if(geoEl){
        const box  = _localFirst(geoEl, 'box'), cyl  = _localFirst(geoEl, 'cylinder');
        const sph  = _localFirst(geoEl, 'sphere'), cone = _localFirst(geoEl, 'cone');
        const mesh = _localFirst(geoEl, 'mesh');
        if(box)       geo = { type:'box', size:(box.getAttribute('size')||'0.1 0.1 0.1').split(/\s+/).map(Number) };
        else if(cyl)  geo = { type:'cylinder', radius:+(cyl.getAttribute('radius')||0.05), length:+(cyl.getAttribute('length')||0.1) };
        else if(sph)  geo = { type:'sphere', radius:+(sph.getAttribute('radius')||0.05) };
        else if(cone) geo = { type:'cone', radius:+(cone.getAttribute('radius')||0.05), height:+(cone.getAttribute('height')||0.1) };
        else if(mesh){ const sc=(mesh.getAttribute('scale')||'1 1 1').split(/\s+/).map(Number); geo = { type:'mesh', scale:sc, filename:mesh.getAttribute('filename')||'' }; }
      }
      // หาสี: พยายามจาก material reference (name='...') หรือจาก color ใน material
      const matRef = _localFirst(v, 'material');
      let mat = null;
      if(matRef){
        const matName = matRef.getAttribute('name');
        if(matName && materialDefs[matName]) mat = materialDefs[matName];
        else { // material มี color อยู่ข้างในโดยตรง (ไม่ใช่ reference)
          const colorEl = _localFirst(matRef, 'color');
          if(colorEl){
            const rgba = (colorEl.getAttribute('rgba')||'0.7 0.7 0.7 1').split(/\s+/).map(Number);
            const r = Math.round((rgba[0]||0)*255), g = Math.round((rgba[1]||0)*255), b = Math.round((rgba[2]||0)*255);
            const a = (rgba[3]===undefined ? 1 : rgba[3]);
            mat = { color:'#'+[r,g,b].map(v=>('0'+v.toString(16)).slice(-2)).join(''), opacity:a };
          }
        }
      }
      if(geo) visuals.push({ origin:_parseOrigin(oriEl), geo, mat });
    });
    links[name] = { visuals };
  });
  const joints = {};
  _localChildren(robot, 'joint').forEach(j => {
    const childEl  = _localFirst(j, 'child'), parentEl = _localFirst(j, 'parent');
    const child  = childEl  && childEl.getAttribute('link');
    const parent = parentEl && parentEl.getAttribute('link');
    if(child && parent) joints[child] = { parent, origin:_parseOrigin(_localFirst(j, 'origin')) };
  });
  return { links, joints };
}
function _parseOrigin(el) {
  if (!el) return { x:0, y:0, z:0, roll:0, pitch:0, yaw:0 };
  const xyz = (el.getAttribute('xyz')||'0 0 0').split(/\s+/).map(Number);
  const rpy = (el.getAttribute('rpy')||'0 0 0').split(/\s+/).map(Number);
  return { x:xyz[0]||0, y:xyz[1]||0, z:xyz[2]||0, roll:rpy[0]||0, pitch:rpy[1]||0, yaw:rpy[2]||0 };
}
// หา root link (ลิงก์ที่ไม่มี joint ใดอ้างถึงเป็น child)
function _rootLink(parsed) {
  for (const n in parsed.links) if (!parsed.joints[n]) return n;
  return Object.keys(parsed.links)[0];
}
// หา pose ของลิงก์เทียบ root (เดินผ่าน joint จาก root มาถึงลิงก์นี้)
function _linkPose(parsed, name) {
  const chain = []; const seen = {}; let cur = name;
  while (cur && parsed.links[cur] && !seen[cur]) {
    seen[cur] = true; chain.unshift(cur);
    const jt = parsed.joints[cur]; if (!jt) break; cur = jt.parent;
  }
  let p = [0,0,0], q = [0,0,0,1];
  for (let i = 1; i < chain.length; i++) {
    const o = parsed.joints[chain[i]].origin;
    const lp = _poseXYZRPY(o.x, o.y, o.z, o.roll, o.pitch, o.yaw);
    const c = _se3Compose(p, q, lp.p, lp.q);
    p = c[0]; q = c[1];
  }
  return { p, q };
}
// สร้างเมชจาก geometry
// ⚠️ ระบบพิกัด ROS→Three ที่ใช้ในโค้ดนี้ (r2t): ROS-x→Three-Z, ROS-y→Three-X, ROS-z→Three-Y
//    ดังนั้น geometry ต้องสร้างในพิกัด Three ให้ตรงกับการแปลงนี้:
//    - box:  ขนาดแกน (ROS.x, ROS.y, ROS.z) ต้องสลับเป็น (ROS.y, ROS.z, ROS.x) = (size[1], size[2], size[0])
//    - cylinder: แกนหมุนใน URDF คือ ROS-z ซึ่งแปลงไปอยู่ Three-Y พอดี กับ THREE.CylinderGeometry
//                ที่แกนชี้ Three-Y มาตรฐาน ดังนั้น "ห้าม" หมุน geometry (เดิม rotateX(π/2) ทำให้แกนไปชี้ THREE-Z → ผิดแกน)
function _makeVisualMesh(geo, mat, alpha) {
  if (!geo) return null;
  const a = (alpha==null ? 1 : alpha);
  const baseOp = (mat && mat.opacity!=null) ? mat.opacity : 1;
  const op = baseOp * a;
  const color = (mat && mat.color) ? new THREE.Color(mat.color) : new THREE.Color(0x9aa0a6);
  const m = new THREE.MeshStandardMaterial({ color, roughness:0.7, metalness:0.1, transparent:op<1, opacity:op, side:THREE.DoubleSide });
  let mesh = null;
  if (geo.type === 'box')      mesh = new THREE.Mesh(new THREE.BoxGeometry(geo.size[1], geo.size[2], geo.size[0]), m);
  else if (geo.type === 'cylinder') { const g = new THREE.CylinderGeometry(geo.radius, geo.radius, geo.length, 24); mesh = new THREE.Mesh(g, m); }
  else if (geo.type === 'cone') { const g = new THREE.ConeGeometry(geo.radius, geo.height, 24); mesh = new THREE.Mesh(g, m); }
  else if (geo.type === 'sphere')   mesh = new THREE.Mesh(new THREE.SphereGeometry(geo.radius, 24, 16), m);
  else if (geo.type === 'mesh')     { const s = geo.scale; const g = new THREE.BoxGeometry(s[1]||0.1, s[2]||0.1, s[0]||0.1); mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color:0x6c7a89, transparent:true, opacity:0.35*a, side:THREE.DoubleSide })); }
  return mesh;
}

// ══ สร้างกลุ่มหุ่นยนต์จาก URDF — 1 กลุ่มย่อยต่อ 1 link (วางด้วย TF สดของ frame นั้น เหมือน RViz จริง) ══
// แต่ละ link เก็บชื่อ frame ไว้ที่ userData.frame แล้ว _updateRobotModel จะจับวางตาม TF ทุกเฟรม
function _mkRobotModel(props) {
  const g = new THREE.Group();
  g.userData.isRobot = true;
  if (!_robotDesc) {
    console.log('[RVIZ] _mkRobotModel: no robotDesc');
    return g;                 // ไม่มี URDF → ไม่แสดงอะไรเลย (แสดงเฉพาะ package ที่รัน)
  }
  const parsed = _parseURDF(_robotDesc);
  if (!parsed || !parsed.links || !Object.keys(parsed.links).length) {
    console.log('[RVIZ] _mkRobotModel: parse failed or empty links');
    return g;
  }
  g.userData.parsed = parsed;
  g.userData.baseFrame = (props && props.baseFrame) || 'base_link';
  const alpha = (props && props.alpha != null) ? props.alpha : 1;
  let visualCount = 0;
  for (const name in parsed.links) {
    const lg = new THREE.Group();
    lg.userData.frame = name;          // ผูกกับ TF frame ที่ชื่อเดียวกับ link (เหมือน RViz จริง)
    parsed.links[name].visuals.forEach(v => {
      if (!v.geo) return;
      const mesh = _makeVisualMesh(v.geo, v.mat, alpha);
      if (!mesh) return;
      const vg = new THREE.Group();     // ออฟเซ็ต visual origin ภายใน link frame
      vg.position.copy(r2t(v.origin.x, v.origin.y, v.origin.z));
      const q = _rpyToQuat(v.origin.roll, v.origin.pitch, v.origin.yaw);
      vg.quaternion.copy(rq2tq(q[0], q[1], q[2], q[3]));
      vg.add(mesh);
      lg.add(vg);
      visualCount++;
    });
    g.add(lg);
  }
  console.log('[RVIZ] _mkRobotModel:', Object.keys(parsed.links).length, 'links,', visualCount, 'meshes (per-link TF binding)');
  return g;
}

// สร้างโมเดลหุ่นใหม่เมื่อ URDF เปลี่ยน (รันจาก ping loop เมื่อได้รับ /robot_description ใหม่)
function _rebuildRobotModels() {
  try {
    displayList.filter(d=>d.type==='RobotModel').forEach(d=>{
      _buildObj(d.id, 'RobotModel', d.props);
      const obj = rviz3d.objects[d.id];
      console.log('[RVIZ] RobotModel built:', obj, 'children:', obj ? obj.children.length : 'none');
      if (obj) obj.visible = d.enabled;
    });
    _updateRobotModel();
  } catch (err) {
    console.error('[RVIZ] RobotModel build failed:', err);
  }
}

// รับ URDF จาก /robot_description → อัปเดตสถานะ + สร้างโมเดล
function _applyRobotDescription(urdf){
  _robotDesc = urdf;
  console.log('[RVIZ] _applyRobotDescription called, urdf length:', urdf ? urdf.length : 0);
  if(!urdf || !urdf.trim()){
    _setRobotModelStatus('⚠️ /robot_description ว่างเปล่า (package ไม่ได้โหลด URDF)');
  } else {
    let parsed=null, err=null;
    try { parsed=_parseURDF(urdf); } catch(e){ err=e; }
    if(!parsed || !parsed.links || !Object.keys(parsed.links).length){
      _setRobotModelStatus('❌ แปลง URDF ไม่ได้'+(err?': '+err.message:''));
    } else {
      let totalVisuals = 0;
      for (const name in parsed.links) totalVisuals += parsed.links[name].visuals.length;
      console.log('[RVIZ] parsed', Object.keys(parsed.links).length, 'links,', totalVisuals, 'visuals');
      _setRobotModelStatus('✅ โมเดล '+Object.keys(parsed.links).length+' ลิงก์ ('+totalVisuals+' visuals)');
    }
  }
  _rebuildRobotModels();
}

// ═══════════════════════════════════════════════════════════════
//  INIT THREE.js
// ═══════════════════════════════════════════════════════════════
function initRviz(){
  const btn=document.getElementById('btn-rviz-connect');
  if(btn) btn.disabled=!sessionId;
  if(rviz3d.renderer) return;
  if(typeof THREE!=='undefined'){_initThree();return;}
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  s.onload=_initThree; s.onerror=()=>_ovl('Cannot load Three.js');
  document.head.appendChild(s);
}
function _initThree(){
  const c=document.getElementById('rviz-3d-container'); if(!c) return;
  rviz3d.renderer=new THREE.WebGLRenderer({antialias:true});
  rviz3d.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  rviz3d.renderer.setClearColor(0x1a1a1a,1);
  rviz3d.renderer.domElement.style.cssText='position:absolute;inset:0;width:100%;height:100%;outline:none;';
  c.appendChild(rviz3d.renderer.domElement);
  rviz3d.scene=new THREE.Scene();
  const W=c.offsetWidth||800,H=c.offsetHeight||600;
  rviz3d.camera=new THREE.PerspectiveCamera(45,W/H,0.01,2000);
  rviz3d.scene.add(new THREE.AmbientLight(0xffffff,0.75));
  const dl=new THREE.DirectionalLight(0xffffff,0.6);
  dl.position.set(3,8,5); rviz3d.scene.add(dl);
  displayList=[];
  rvizAddDisplay('Grid',true,{});
  rvizAddDisplay('RobotModel',true,{});
  rvizAddDisplay('TF',true,{});
  rvizRenderPanel();
  _bindCam(c);
  new ResizeObserver(_resize).observe(c);
  (function loop(){
    requestAnimationFrame(loop);
    _camUpdate();
    rviz3d.renderer.render(rviz3d.scene,rviz3d.camera);
    const now=performance.now();
    if(now-rviz3d.lastFpsT>1000){
      const el=document.getElementById('rviz-fps');
      if(el) el.textContent=rviz3d.msgCount+' Hz';
      rviz3d.msgCount=0; rviz3d.lastFpsT=now;
    }
  })();
  rvizTeleopInit();   // ผูกแผงควบคุม cmd_vel (เรียกครั้งเดียว)
  //_ovl('Three.js ready — กด ▶ Connect');
}

// ═══════════════════════════════════════════════════════════════
//  CAMERA & TOUCH CONTROLS
// ═══════════════════════════════════════════════════════════════
function _camUpdate(){
  const c=rviz3d.camera; if(!c) return;
  const {theta,phi,radius,target}=rvizCam;
  c.position.set(
    target.x+radius*Math.sin(phi)*Math.sin(theta),
    target.y+radius*Math.cos(phi),
    target.z+radius*Math.sin(phi)*Math.cos(theta));
  c.lookAt(target.x,target.y,target.z);
}

function _bindCam(el){
  el.style.cursor = 'grab'; // Default cursor
  let _pinchStartDist = null;

  const startDrag = (x, y, isRightClick) => {
    rvizCam.drag = true;
    rvizCam.rightDrag = isRightClick;
    rvizCam.lx = x;
    rvizCam.ly = y;
    el.style.cursor = 'grabbing';
  };

  const doDrag = (x, y) => {
    if(!rvizCam.drag) return;
    const dx = x - rvizCam.lx;
    const dy = y - rvizCam.ly;
    rvizCam.lx = x; rvizCam.ly = y;

    if(rvizCam.rightDrag){
      const s = rvizCam.radius * 0.002;
      rvizCam.target.x -= dx * s; // Standard Pan (ขยับกล้องไปทางเดียวกับเมาส์)
      rvizCam.target.z -= dy * s; 
    } else {
      rvizCam.theta -= dx * 0.012; // Standard Orbit (วัตถุจะหมุนตามเมาส์)
      rvizCam.phi = Math.max(0.02, Math.min(Math.PI - 0.02, rvizCam.phi - dy * 0.012));
    }
  };

  const endDrag = () => {
    rvizCam.drag = false;
    el.style.cursor = 'grab';
    _pinchStartDist = null;
  };

  // ── MOUSE EVENTS ──
  el.addEventListener('mousedown', e => {
    startDrag(e.clientX, e.clientY, e.button === 2 || e.button === 1 || e.shiftKey);
  });
  el.addEventListener('mousemove', e => doDrag(e.clientX, e.clientY));
  ['mouseup', 'mouseleave'].forEach(ev => el.addEventListener(ev, endDrag));

  // ── TOUCH EVENTS (Tablet / Mobile) ──
  el.addEventListener('touchstart', e => {
    e.preventDefault(); // กันเด้ง หรือ scroll หน้าเว็บ
    if(e.touches.length === 1) {
      // 1 นิ้ว = Orbit (เหมือนคลิกซ้าย)
      startDrag(e.touches[0].clientX, e.touches[0].clientY, false);
    } else if(e.touches.length === 2) {
      // 2 นิ้ว = Pan & Zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      _pinchStartDist = Math.hypot(dx, dy);
      
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      startDrag(cx, cy, true); // ตั้งเป็นโหมด Pan
    }
  }, {passive: false});

  el.addEventListener('touchmove', e => {
    e.preventDefault();
    if(e.touches.length === 1) {
      doDrag(e.touches[0].clientX, e.touches[0].clientY);
    } else if(e.touches.length === 2) {
      // คำนวณระยะห่างระหว่าง 2 นิ้ว เพื่อซูม
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      
      if(_pinchStartDist) {
        const zoomDelta = _pinchStartDist / dist;
        rvizCam.radius = Math.max(0.3, Math.min(300, rvizCam.radius * zoomDelta));
        _pinchStartDist = dist; // อัปเดตระยะล่าสุด
      }
      
      // หาจุดกึ่งกลางเพื่อคำนวณ Pan ต่อ
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      doDrag(cx, cy);
    }
  }, {passive: false});

  ['touchend', 'touchcancel'].forEach(ev => el.addEventListener(ev, endDrag));

  // ── MOUSE WHEEL ZOOM ──
  el.addEventListener('wheel', e => {
    e.preventDefault();
    rvizCam.radius = Math.max(0.3, Math.min(300, rvizCam.radius * (e.deltaY > 0 ? 1.12 : 0.88)));
  }, {passive: false});

  el.addEventListener('contextmenu', e => e.preventDefault());
}

function _resize(){
  const c=document.getElementById('rviz-3d-container');
  if(!c||!rviz3d.renderer) return;
  rviz3d.renderer.setSize(c.offsetWidth,c.offsetHeight);
  if(rviz3d.camera){rviz3d.camera.aspect=c.offsetWidth/c.offsetHeight;rviz3d.camera.updateProjectionMatrix();}
}

// ═══════════════════════════════════════════════════════════════
//  CONNECT / REALTIME STREAM
// ═══════════════════════════════════════════════════════════════
async function rvizConnect(){
  if(!sessionId){
    // ไม่มสessionId (ยังไม่ได้เชื่อมต่อหุ่น/หลังลบ sim แล้วสร้างใหม่) → ห้ามเงียบ ให้แจ้งให้ reconnect ก่อน
    _ovl('ยังไม่ได้เชื่อมต่อหุ่นยนต์ — กรุณา Disconnect แล้ว Connect ใหม่ (หลังลบ/สร้าง sim) เสียก่อนเปิด RViz');
    const b=document.getElementById('btn-rviz-connect'); if(b){b.textContent='▶ Connect';b.className='btn btn-g';}
    return;
  }
  const btn=document.getElementById('btn-rviz-connect');
  if(_live){
    _live=false;
    clearInterval(_pingTimer); _pingTimer=null;
    await API('/api/exec',{sessionId,command:'PID=$(cat /tmp/_rviz_rt.pid 2>/dev/null); [ -n "$PID" ] && kill $PID 2>/dev/null; for p in $(pgrep -f "_rviz_rt[.]py" 2>/dev/null); do [ "$p" != "$$" ] && kill $p 2>/dev/null; done; rm -f /tmp/_rviz_rt.pid; true',timeout:2000}).catch(()=>{});
    if(btn){btn.textContent='▶ Connect';btn.className='btn btn-g';}
    rvizTeleopStop();   // หยุดส่ง cmd_vel ตอนตัดการเชื่อมต่อ (กันหุ่นวิ่งต่อ)
    rvizTeleopStopProcOnly();  // ฆ่า node persistent ด้วย (คืนลาดตระเวนอัตโนมัติให้หุ่น)
    _badge('Disconnected','br','dr'); _ovl('Disconnected'); return;
  }
  if(!rviz3d.renderer){initRviz();setTimeout(rvizConnect,1500);return;}
  if(typeof rosInfo!=='undefined'&&rosInfo?.setupBash) _setupBash=rosInfo.setupBash;
  if(btn){btn.textContent='⏹ Stop';btn.className='btn btn-r';}
  _badge('Connecting...','ba','da'); _ovl('');
  _live=true;
  rviz3d.fixedFrameLocked=false;   // เชื่อมต่อหุ่นใหม่ → ปลดล็อค ให้ auto-detect ทำงาน新鲜
  rviz3d.fixedFrame='odom';        // เริ่มจาก odom เสมอ (fixed frame มาตรฐาน) → กันเด้งไป base_link จากรอบก่อน
  { const el=document.getElementById('rviz-fixed-frame-display'); if(el) el.textContent='odom';
    const sel=document.getElementById('rviz-fixed-frame-sel'); if(sel) sel.value='odom'; }
  if(displayList.some(d=>d.type==='RobotModel')) _setRobotModelStatus('กำลังรอรับ /robot_description…');
  await _startStream();
  rvizTeleopEnsureNode();   // pre-spawn node ล่วงหน้า → กดปุ่มครั้งแรกตอบสนองทันที (ไม่มีดีเลย์สปาวน์)
}

async function _startStream(){
  if(!sessionId||!_live) return;
  // 🧹 ล้าง state เก่าก่อนเริ่มสตรีมใหม่ — กันของเก่ากระพิบหลังอัพเดท tf/model หรือ ปิดเปิดใหม่
  _tfStore.clear();
  _robotDesc      = null;   // ล้าง URDF เก่า กันโมเดลเก่ากลับมาแสดงหลังอัพเดท
  _robotDescSig   = null;
  _pingFails      = 0;      // รีเซ็ตตัวนับความล้มเหลวของ ping loop
  _resetVisuals();          // ล้างแกน TF / โมเดล / เส้นเก่าใน scene ทั้งหมด ก่อนเริ่มสตรีมใหม่

  const tfEnabled   = displayList.some(d=>d.type==='TF'&&d.enabled);
  const odomEnabled = displayList.some(d=>(d.type==='Odometry'||d.type==='RobotModel')&&d.enabled);
  const scanEnabled = displayList.some(d=>d.type==='LaserScan'&&d.enabled);
  const odomTopic   = displayList.find(d=>d.type==='Odometry'&&d.enabled)?.props.topic||'/odom';
  const scanTopic   = displayList.find(d=>d.type==='LaserScan'&&d.enabled)?.props.topic||'/scan';

  const pyLines=[
    "# ros2ide_rviz_rt",
    "import rclpy,json,sys,math,threading,time,signal,os",
    "from rclpy.node import Node",
    "from rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy",
    "BE=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.BEST_EFFORT,durability=QoSDurabilityPolicy.VOLATILE)",
    "ST=QoSProfile(depth=100,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)",
    "buf={'tf':{},'odom':None,'scan':None,'tf_seen':{}}",
    "lk=threading.Lock()",
    "running=True",
    "def stop(s,f): global running; running=False",
    "signal.signal(signal.SIGTERM,stop)",
    "signal.signal(signal.SIGINT,stop)",
    "class N(Node):",
    " def __init__(self):",
    "  super().__init__('ros2ide_rviz_rt')",
    ...(tfEnabled?[
      "  from tf2_msgs.msg import TFMessage",
      "  self.create_subscription(TFMessage,'/tf',self.cb_tf,BE)",
      "  self.create_subscription(TFMessage,'/tf_static',self.cb_tf,ST)",
    ]:[]),
    ...(odomEnabled?[
      "  from nav_msgs.msg import Odometry",
     `  self.create_subscription(Odometry,'${odomTopic}',self.cb_od,BE)`,
    ]:[]),
    ...(scanEnabled?[
      "  from sensor_msgs.msg import LaserScan",
     `  self.create_subscription(LaserScan,'${scanTopic}',self.cb_sc,BE)`,
    ]:[]),
    ...(true?[
      "  from std_msgs.msg import String",
      "  self._last_desc=None",
      "  self.create_subscription(String,'/robot_description',self.cb_desc,ST)",
    ]:[]),
    " def cb_tf(self,m):",
    "  with lk:",
    "   for t in m.transforms:",
    "    tr,ro=t.transform.translation,t.transform.rotation",
    "    buf['tf'][t.child_frame_id]={'frame':t.child_frame_id,'parent':t.header.frame_id,'x':tr.x,'y':tr.y,'z':tr.z,'qx':ro.x,'qy':ro.y,'qz':ro.z,'qw':ro.w}; buf['tf_seen'][t.child_frame_id]=time.time()",
    " def cb_od(self,m):",
    "  p=m.pose.pose",
    "  with lk: buf['odom']={'x':p.position.x,'y':p.position.y,'qz':p.orientation.z,'qw':p.orientation.w}",
    " def cb_sc(self,m):",
    "  r=[float(v) if not(math.isinf(v) or math.isnan(v)) else 0.0 for v in m.ranges]",
    "  st=max(1,len(r)//360)",
    "  with lk: buf['scan']={'amin':m.angle_min,'ainc':m.angle_increment*st,'ranges':r[::st]}",
    " def cb_desc(self,m):",
    "  if m.data:",
    "   with lk: buf['desc']=m.data",
    "   try: open('/tmp/_rviz_desc.urdf','w').write(m.data)",
    "   except Exception: pass",
    "rclpy.init()",
    "n=N()",
    "ex=rclpy.executors.SingleThreadedExecutor()",
    "ex.add_node(n)",
    "last=time.time()",
    "hb=0",
    "while running:",
    " ex.spin_once(timeout_sec=0.05)",
    " now=time.time()",
    " if now-last>=0.1:",
    "  last=now",
    "  hb+=1",
    "  try:",
    "   if os.path.getsize('/tmp/_rviz_out.jsonl')>5_000_000:",
    "    os.system(\"tail -n 300 /tmp/_rviz_out.jsonl > /tmp/_rviz_out.tmp 2>/dev/null && mv /tmp/_rviz_out.tmp /tmp/_rviz_out.jsonl\")",
    "  except: pass",
    "  with lk:",
    "   for _k in list(buf['tf'].keys()):",
    "    if now-buf['tf_seen'].get(_k,0)>8.0: buf['tf'].pop(_k,None); buf['tf_seen'].pop(_k,None)",
    "   out={}",
    "   if buf['tf']: out['tf']=list(buf['tf'].values())",
    "   if buf['odom']: out['odom']=buf['odom']",
    "   if buf['scan']: out['scan']=buf['scan']; buf['scan']=None",
    "   d=buf.get('desc')",
    "   if d and (d!=buf.get('_sent') or hb%8==0): out['desc']=d; buf['_sent']=d",
    "  try:",
    "   sys.stdout.write(json.dumps(out,separators=(',',':'))+'\\n')",
    "   sys.stdout.flush()",
    "  except: pass",
    "n.destroy_node()",
    "rclpy.shutdown()",
  ];

  const wRes=await API('/api/files/write',{
    sessionId, path:'/tmp/_rviz_rt.py', content:pyLines.join('\n')
  });
  if(!wRes?.ok){ _ovl('Cannot write streamer'); return; }

  await API('/api/exec',{sessionId,command:'sleep 1; true',timeout:2000}).catch(()=>{});

  // เริ่ม bridge แล้วจับ PID เก็บใน pidfile (root/tmp/_rviz_rt.pid สำหรับ SIM)
  // ⚠️ ห้ามใช้ `pkill -f "python3 -u /tmp/_rviz_rt.py"` เพราะ pattern นี้ปรากฏใน command line ของ
  //    shell ที่รันคำสั่งเอง → pkill จับคู่แล้วฆ่า shell แม่ → คำสั่ง abort แล้ว bridge ไม่รันเลย
  // 🧹 ฆ่า streamer ตัวเก่าที่ค้างอยู่ทั้งหมด (ไม่พึ่งพาไฟล์ pid เด็ดขาด)
  //   - ใช้ pgrep -f '_rviz_rt[.]py' (วงเล็บ [.] กันไม่ให้จับคู่ shell ที่รันคำสั่งนี้เอง)
  //   - กรอง [ "$p" != "$$" ] กันฆ่า shell ตัวเอง (ตามคำเตือนใน sim.js)
  //   - จำเป็นเพราะ process แบบ nohup จะรอดตายตอนปิด/รัน node ใหม่ → ถ้าไม่ฆ่าจะเขียน jsonl ปนกับตัวใหม่ → กระพิบ
  const killStale=`for p in $(pgrep -f '_rviz_rt[.]py' 2>/dev/null); do [ "$p" != "$$" ] && kill $p 2>/dev/null; done`;
  const startCmd=`source ${_setupBash} 2>/dev/null; OLD=$(cat /tmp/_rviz_rt.pid 2>/dev/null); [ -n "$OLD" ] && kill $OLD 2>/dev/null; ${killStale}; rm -f /tmp/_rviz_rt.pid /tmp/_rviz_out.jsonl /tmp/_rviz_desc.urdf; nohup python3 -u /tmp/_rviz_rt.py > /tmp/_rviz_out.jsonl 2>/dev/null & echo $! > /tmp/_rviz_rt.pid`;
  const sRes=await API('/api/exec',{sessionId,command:startCmd,timeout:3000});
  if(!sRes?.ok){ _ovl('Cannot start streamer'); return; }

  await new Promise(r=>setTimeout(r,800));

  clearInterval(_pingTimer);
  _pingTimer=setInterval(async()=>{
    if(!_live) return;
    // ── ดึง URDF จากไฟล์เฉพาะโดยตรง (กันพลาด ไม่ขึ้นกับจังหวะ tail/heartbeat) ──
    if(!_robotDescSig){
      try{
        const dr=await API('/api/exec',{sessionId,command:`cat /tmp/_rviz_desc.urdf 2>/dev/null`,timeout:2000});
        if(dr?.ok && dr.stdout && dr.stdout.trim().length>20){
          _robotDescSig=dr.stdout; _applyRobotDescription(dr.stdout);
        }
      }catch{}
    }
    try{
      const r=await API('/api/exec',{
        sessionId,
        command:`tail -n 40 /tmp/_rviz_out.jsonl 2>/dev/null`,
        timeout:2000,
      });
      if(!r?.ok||!r.stdout){
        if(++_pingFails>15) _dropConnection('เชื่อมต่อขาด — ดูเหมือน node ถูกปิด (เชื่อมต่อใหม่ได้เลย)');
        return;
      }
      _pingFails=0;
      const lines=r.stdout.trim().split('\n').filter(Boolean);
      if(!lines.length) return;
      rviz3d.msgCount++;
      // tf / odom / scan → ใช้จากบรรทัดล่าสุด (ข้อมูลสดสุด)
      const last=lines[lines.length-1];
      const s=last.indexOf('{'),e=last.lastIndexOf('}');
      if(s>=0&&e>s){
        let p; try{p=JSON.parse(last.slice(s,e+1));}catch{p=null;}
        if(p){
          if(p.tf)   _applyTF(p.tf);
          if(p.odom) _applyOdom(p.odom);
          if(p.scan) _applyScan(p.scan);
        }
      }
      // desc (/robot_description) ถูกส่งแค่ครั้งเดียวตอน URDF เปลี่ยน → สแกนย้อนหลังทุกบรรทัด
      // ห้ามใช้เฉพาะบรรทัดสุดท้าย เพราะบรรทัดนั้นมักเป็น tf/odom/scan ที่ไม่มี desc เลย
      for(let i=lines.length-1;i>=0;i--){
        const ls=lines[i]; const ds=ls.indexOf('{'),de=ls.lastIndexOf('}');
        if(ds<0||de<=ds) continue;
        let p; try{p=JSON.parse(ls.slice(ds,de+1));}catch{continue;}
        if(p.desc && p.desc!==_robotDescSig){
          _robotDescSig=p.desc; _applyRobotDescription(p.desc);
          break;
        }
      }
      _badge('Live','bg','dg');
    }catch{
      if(++_pingFails>15) _dropConnection('เชื่อมต่อขาด — ดูเหมือน node ถูกปิด (เชื่อมต่อใหม่ได้เลย)');
    }
  },150);

  _badge('Live','bg','dg');
}

async function _restartStream(){
  if(!_live) return;
  clearInterval(_pingTimer);
  await API('/api/exec',{sessionId,command:'PID=$(cat /tmp/_rviz_rt.pid 2>/dev/null); [ -n "$PID" ] && kill $PID 2>/dev/null; for p in $(pgrep -f "_rviz_rt[.]py" 2>/dev/null); do [ "$p" != "$$" ] && kill $p 2>/dev/null; done; rm -f /tmp/_rviz_rt.pid; true',timeout:1000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,300));
  await _startStream();
  rvizTeleopEnsureNode();   // pre-spawn node ใหม่หลัง restart stream (กันดีเลย์สปาวน์)
}

// ═══════════════════════════════════════════════════════════════
//  TF GRAPH SOLVER (Bidirectional BFS)
// ═══════════════════════════════════════════════════════════════
function computeTFWorld() {
  const world = new Map();
  // Fixed frame คือจุดศูนย์กลางจักรวาลของ Three.js (0,0,0) เสมอ
  world.set(rviz3d.fixedFrame, {
    pos: new THREE.Vector3(0,0,0),
    quat: new THREE.Quaternion(0,0,0,1)
  });

  // สร้างกราฟความสัมพันธ์ (ชี้ไป-กลับได้)
  const adj = new Map();
  _tfStore.forEach((t, child) => {
     const parent = t.parent;
     if(!adj.has(parent)) adj.set(parent, []);
     if(!adj.has(child)) adj.set(child, []);
     adj.get(parent).push({ neighbor: child, isChild: true, t });
     adj.get(child).push({ neighbor: parent, isChild: false, t });
  });

  // BFS ค้นหาจาก Fixed Frame กระจายออกไปรอบๆ
  const queue = [rviz3d.fixedFrame];
  while(queue.length > 0) {
     const current = queue.shift();
     const currPose = world.get(current);
     const neighbors = adj.get(current) || [];

     for(const n of neighbors) {
        if(world.has(n.neighbor)) continue; // คำนวณไปแล้ว ข้าม

        // Local Transform ROS → Three.js
        const lp = r2t(n.t.x||0, n.t.y||0, n.t.z||0);
        const lq = rq2tq(n.t.qx||0, n.t.qy||0, n.t.qz||0, n.t.qw??1);

        let nextPos = new THREE.Vector3();
        let nextQuat = new THREE.Quaternion();

        if(n.isChild) {
           // เรากำลังยืนอยู่บน Parent แล้วมองหา Child 
           // ตำแหน่ง Child = ตำแหน่ง Parent + การขยับของ Local Transform
           nextPos.copy(lp).applyQuaternion(currPose.quat).add(currPose.pos);
           nextQuat.copy(currPose.quat).multiply(lq);
        } else {
           // เรากำลังยืนอยู่บน Child แล้วมองหา Parent (เกิดกรณีที่ fixedFrame ไปเกาะอยู่ที่ล้อรถ เป็นต้น)
           // ต้อง Inverse Transform (หมุนกลับ และ ถอยหลัง)
           const invQ = lq.clone().invert();
           const invP = lp.clone().negate().applyQuaternion(invQ);
           nextPos.copy(invP).applyQuaternion(currPose.quat).add(currPose.pos);
           nextQuat.copy(currPose.quat).multiply(invQ);
        }
        
        world.set(n.neighbor, { pos: nextPos, quat: nextQuat });
        queue.push(n.neighbor);
     }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════
//  DATA → THREE.js
// ═══════════════════════════════════════════════════════════════
function _applyTF(frames){
  if(!Array.isArray(frames)||!frames.length) return;
  const now=performance.now();
  const cur=new Set();
  frames.forEach(t=>{if(t.frame){t._seen=now;_tfStore.set(t.frame,t);cur.add(t.frame);}});
  // 🧹 ไม่ลบ frame ทันทีที่ไม่อยู่ในชุดล่าสุด — เก็บตาม TTL 5 วินาที (กันกระพริบ)
  _tfStore.forEach((v,k)=>{ if(!cur.has(k) && (now-(v._seen||0))>5000) _tfStore.delete(k); });

  // 🎯 เลือก Fixed Frame อัตโนมัติแบบ RViz จริง:
  //  ทำงานเฉพาะตอนยังไม่ล็อค choice ของผู้ใช้ (fixedFrameLocked=false)
  //  ถ้า fixedFrame ปัจจุบัน "อยู่ในกราฟ TF" แล้ว → เก็บไว้ตามเดิม ห้ามเด้ง (เช่น default 'odom'
  //    แล้วหุ่นส่ง odom → หุ่นเดินหน้าได้ / Odometry วาดได้)
  //  ถ้า fixedFrame ไม่อยู่ในกราฟ (เช่น 'odom' แต่หุ่นนี้ไม่มี odom) → เลือก frame โกลบอลที่เสถียรที่สุด
  //    ลำดับ: map → odom → base_footprint (frame โลกที่หุ่นไม่ได้ขยับไปมาด้วย)
  //  ⚠️ ห้ามเลือก base_link เป็นอัตโนมัติเด็ดขาด — base_link คือตัวหุ่นเอง (อยู่ origin เสมอ)
  //     ถ้าเอา base_link เป็น fixed frame หุ่นจะดูเหมือน "ไม่เดินหน้า" และ Odometry วาดไม่ได้
  //     (นี่คือสาเหตุที่ผู้ใช้รายงาน "เด้งไป base_link ตลอด / กดเดินหน้าแล้วไม่เดิน")
  const childSet=new Set(_tfStore.keys());
  const parentSet=new Set([..._tfStore.values()].map(v=>v.parent).filter(Boolean));
  const inGraph=(f)=>childSet.has(f)||parentSet.has(f);
  if(!rviz3d.fixedFrameLocked){
    if(!inGraph(rviz3d.fixedFrame)){
      // หา frame โลกที่เสถียร (robot-independent) — ไม่เอาฐานหุ่น (base_link) เด็ดขาด
      const GLOBAL=['map','odom','base_footprint'];
      let pick=null;
      for(const g of GLOBAL){ if(inGraph(g)){ pick=g; break; } }
      if(!pick){
        // ไม่มี frame โลกเลย → เลือก "ราก" ของกราฟ (parent ที่ไม่ใช่ child ใดๆ) ที่ไม่ใช่ base_link
        for(const p of parentSet){ if(!childSet.has(p) && p!=='base_link'){ pick=p; break; } }
      }
      if(!pick){
        // กรณีสุดท้าย: หุ่นมีแค่ base_link จริงๆ → ยอมรับ base_link เพื่อให้ render ได้
        // (แต่ไม่เคย "เด้ง" มาจาก frame เสถียรอื่น)
        if(inGraph('base_link')) pick='base_link';
        else pick=[...childSet][0]||[...parentSet][0]||rviz3d.fixedFrame;
      }
      if(pick && pick!==rviz3d.fixedFrame){
        rviz3d.fixedFrame=pick;
        const el=document.getElementById('rviz-fixed-frame-display'); if(el) el.textContent=pick;
        const sel=document.getElementById('rviz-fixed-frame-sel'); if(sel) sel.value=pick;
        console.log('[RVIZ] auto fixedFrame →', pick);
      }
    }
    // ได้ frame ที่เสถียรแล้ว (อยู่ในกราฟ หรือเพิ่งสลับ) → ล็อคเพื่อไม่ให้เด้งซ้ำ
    rviz3d.fixedFrameLocked=true;
  }

  // update dropdown options
  const allF=[...new Set([...rviz3d.tfFrames,..._tfStore.keys(),
    ...[..._tfStore.values()].map(v=>v.parent).filter(Boolean)])];

  // 🛠️ แก้ปัญหากะพริบ: เช็คก่อนว่ามี Frame ใหม่เพิ่มเข้ามาหรือไม่
  if (allF.length !== rviz3d.tfFrames.length) {
    rviz3d.tfFrames = allF; 
    _renderFrameSel();
  }

  // แก้ปัญหาใจความสำคัญ: สร้างกราฟโลกใหม่
  const world = computeTFWorld();
  rviz3d.worldTFs = world; // เก็บไว้ให้ LaserScan กับ Odom ใช้ด้วย

  displayList.filter(d=>d.type==='TF'&&d.enabled).forEach(d=>{
    const grp=rviz3d.objects[d.id]; if(!grp) return;
    while(grp.children.length){ const c=grp.children[0]; grp.remove(c); _disposeObj(c); }

    const axLen=Math.max(0.03,+(d.props.axesLength)||0.25);

    // เก็บรายการ frame ที่จะวาดก่อน
    const toDraw = [];
    world.forEach((wp,frame)=>{
      toDraw.push({frame, wp});
    });

    // วาดเฉพาะ frame ที่ยัง valid และทำ opacity ตามอายุ
    toDraw.forEach(({frame, wp})=>{
      const v = _tfStore.get(frame);
      // ถ้าไม่มีใน _tfStore หรือหมดอายุ ให้ข้าม
      if (!v || v._seen===undefined || (now-(v._seen))>5000) return;

      const ag=_mkAxes(axLen);
      ag.position.copy(wp.pos); ag.quaternion.copy(wp.quat);

      // ทำ opacity ตามอายุให้ frame เก่าโปร่งแสง
      const age = now - (v._seen||0);
      if (age > 2500) {  // > 2.5 วินาที
        const opacity = Math.max(0.25, 1 - (age - 2500) / 2500);  // ลดจาก 1 -> 0.25
        ag.traverse(c => { if (c.material) c.material.opacity = opacity; });
      }
      grp.add(ag);
      if(d.props.showNames!==false){
        const sp=_mkLabel(frame);
        sp.position.set(wp.pos.x,wp.pos.y+axLen*1.4,wp.pos.z);
        sp.traverse(c => { if (c.material) c.material.opacity = (age > 2500) ? opacity : 1; });
        grp.add(sp);
      }
    });

    // Draw links between parent and child
    _tfStore.forEach((t,child)=>{
      const cw=world.get(child);
      const pw=world.get(t.parent);
      if(!cw||!pw||cw.pos.distanceTo(pw.pos)<0.0005) return;
      const geo=new THREE.BufferGeometry().setFromPoints([pw.pos.clone(),cw.pos.clone()]);
      grp.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:0xd4a017})));
    });
  });

  _updateRobotModel();
}

// วางแต่ละ link ด้วยพิกัด TF สดของ frame ชื่อเดียวกัน (เหมือน RViz จริง)
// ถ้า frame ใดไม่มีใน TF → ไล่คำนวณต่อจาก parent ผ่าน URDF joint (fallback ให้ยังแสดงได้เสมอ)
function _updateRobotModel() {
  const world = rviz3d.worldTFs || new Map();
  displayList.filter(d=>d.type==='RobotModel'&&d.enabled).forEach(d=>{
    const obj=rviz3d.objects[d.id]; if(!obj) return;
    const parsed=obj.userData.parsed; if(!parsed) return;
    // กลุ่มหุ่นอยู่ที่ origin — แต่ละ link ถือพิกัดโลกของตัวเอง (เหมือน RViz ที่วางทีละ frame)
    obj.position.set(0,0,0); obj.quaternion.identity();

    const memo=new Map();
    const IDENT={pos:new THREE.Vector3(0,0,0),quat:new THREE.Quaternion(0,0,0,1)};
    const poseOf=(name,depth)=>{
      if(memo.has(name)) return memo.get(name);
      if((depth||0)>64) return IDENT;
      let res=null;
      if(world.has(name)){
        res=world.get(name);                    // ★ ใช้ TF สดของ frame นี้ (หัวใจแบบ RViz จริง)
      }else{
        const jt=parsed.joints[name];
        if(jt){                                  // ไม่มี TF → ต่อจาก parent ด้วย URDF joint origin
          const pp=poseOf(jt.parent,(depth||0)+1);
          const o=jt.origin;
          const lp=r2t(o.x,o.y,o.z);
          const qa=_rpyToQuat(o.roll,o.pitch,o.yaw);
          const lq=rq2tq(qa[0],qa[1],qa[2],qa[3]);
          const pos=lp.clone().applyQuaternion(pp.quat).add(pp.pos);
          const quat=pp.quat.clone().multiply(lq);
          res={pos,quat};
        }
      }
      if(!res) res=world.get(d.props.baseFrame)||world.get(rviz3d.fixedFrame)||IDENT;
      memo.set(name,res); return res;
    };

    obj.children.forEach(lg=>{
      const f=lg.userData.frame; if(!f) return;
      const p=poseOf(f,0);
      lg.position.copy(p.pos);
      lg.quaternion.copy(p.quat);
    });
  });
}

function _applyOdom(o){
  // เก็บตำแหน่งหุ่นยนต์ไว้เผื่อ Fallback
  rviz3d.robotPos.x=o.x||0; rviz3d.robotPos.y=o.y||0;
  rviz3d.robotPos.yaw=2*Math.atan2(o.qz||0,o.qw??1);

  // Odometry pose in ROS coords
  const rosP = new THREE.Vector3(o.x||0, o.y||0, 0);
  const rosQ = new THREE.Quaternion(0, 0, o.qz||0, o.qw??1);

  // Convert to Three.js coords (นี่คือตำแหน่งในเฟรมของ odom)
  const tp = r2t(rosP.x, rosP.y, rosP.z);
  const tq = rq2tq(rosQ.x, rosQ.y, rosQ.z, rosQ.w);

  const px=document.getElementById('rv-pos'),py=document.getElementById('rv-yaw');
  if(px) px.textContent=`${(o.x||0).toFixed(3)}, ${(o.y||0).toFixed(3)}`;
  if(py) py.textContent=(rviz3d.robotPos.yaw*180/Math.PI).toFixed(1)+'°';

  _updateRobotModel(); // เผื่อใครรัน Odom โดดๆ แบบไม่เปิด TF

  displayList.filter(d=>d.type==='Odometry'&&d.enabled).forEach(d=>{
    const grp=rviz3d.objects[d.id]; if(!grp) return;
    if(!grp._pts) grp._pts=[];

    // แปลงพิกัด Odom ให้วิ่งตาม Fixed Frame
    const framePose = rviz3d.worldTFs?.get(d.props.frameId || 'odom');
    const wPos = framePose ? framePose.pos : new THREE.Vector3(0,0,0);
    const wQuat = framePose ? framePose.quat : new THREE.Quaternion();

    // หมุนพิกัดตามเฟรมที่รองรับมันอยู่
    const worldPt = tp.clone().applyQuaternion(wQuat).add(wPos);
    worldPt.setY(0.01); // ยกลอยเหนือ grid นิดนึง

    grp._pts.push(worldPt);
    while(grp._pts.length>(d.props.keep||300)) grp._pts.shift();

    while(grp.children.length){ const c=grp.children[0]; grp.remove(c); _disposeObj(c); }
    if(grp._pts.length>1){
      const geo=new THREE.BufferGeometry().setFromPoints(grp._pts);
      grp.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:d.props.color||'#f5a623'})));
    }
  });
}

function _applyScan(s){
  displayList.filter(d=>d.type==='LaserScan'&&d.enabled).forEach(d=>{
    const pts=rviz3d.objects[d.id]; if(!pts) return;
    const ranges=s.ranges||[]; if(!ranges.length) return;
    const p=d.props,geo=pts.geometry;
    const pos=geo.attributes.position.array,col=geo.attributes.color.array;

    // หาตำแหน่งของเซนเซอร์เทียบกับ Fixed Frame
    const framePose = rviz3d.worldTFs?.get(p.frameId || 'laser_frame');
    const wPos = framePose ? framePose.pos : new THREE.Vector3(0,0,0);
    const wQuat = framePose ? framePose.quat : new THREE.Quaternion();

    const hex=p.color||'#ff3333';
    const fr=parseInt(hex.slice(1,3),16)/255,fg=parseInt(hex.slice(3,5),16)/255,fb=parseInt(hex.slice(5,7),16)/255;
    
    const aMin=s.amin||0,aInc=s.ainc||(2*Math.PI/ranges.length),maxR=p.maxRange||30;
    let n=0;

    for(let i=0;i<ranges.length&&n<4096;i++){
      const dist=ranges[i];
      if(!isFinite(dist)||dist<0.05||dist>maxR) continue;
      const angle=aMin+i*aInc;

      // แปลงมุมและระยะทางเป็นแกน X, Y (ROS)
      const lx=dist*Math.cos(angle), ly=dist*Math.sin(angle), lz=0;
      // Convert to Three.js local
      const localPt = r2t(lx, ly, lz);
      // แปลงพิกัดสุดท้ายให้เข้ากับ Fixed Frame (วิถี RViz ของแท้)
      localPt.applyQuaternion(wQuat).add(wPos);

      pos[n*3]=localPt.x; pos[n*3+1]=localPt.y; pos[n*3+2]=localPt.z;

      if(p.colorType==='range'){
        const t=Math.min(dist/maxR,1);
        col[n*3]=1-t; col[n*3+1]=t*0.5; col[n*3+2]=t;
      } else {
        col[n*3]=fr; col[n*3+1]=fg; col[n*3+2]=fb;
      }
      n++;
    }

    geo.attributes.position.needsUpdate=true; geo.attributes.color.needsUpdate=true;
    geo.setDrawRange(0,n); pts.material.size=p.size||0.04;
    const el=document.getElementById('rv-scan-pts'); if(el) el.textContent=n;
  });
}

// ═══════════════════════════════════════════════════════════════
//  ADD DISPLAY — auto-detect from topic list
// ═══════════════════════════════════════════════════════════════
let _topicCache=[];
let _raList=[]; 
let _pendingAdd=null;

async function rvizShowAddDialog(){
  let modal=document.getElementById('rviz-add-modal');
  if(!modal){
    modal=document.createElement('div');
    modal.id='rviz-add-modal';
    modal.style.cssText=
      'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);'+
      'display:flex;align-items:center;justify-content:center;';
    modal.innerHTML=`
      <div id="rviz-add-box"
        style="background:var(--bg2);border:1px solid var(--brd);border-radius:10px;
               width:480px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;
               box-shadow:0 20px 48px rgba(0,0,0,.5)">
        <div style="display:flex;align-items:center;justify-content:space-between;
             padding:12px 18px;border-bottom:1px solid var(--brd)">
          <span style="font-size:14px;font-weight:700;color:var(--fg)">Add Display</span>
          <button onclick="rvizCloseAdd()"
            style="background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;line-height:1">✕</button>
        </div>
        <div style="display:flex;gap:6px;padding:9px 14px;border-bottom:1px solid var(--brd)">
          <input id="rviz-add-q" type="text" placeholder="🔍  Filter topics..."
            style="flex:1;background:var(--bg3);border:1px solid var(--brd);border-radius:6px;
                   padding:7px 10px;color:var(--fg);font-size:12px;outline:none"
            oninput="_raFilter(this.value)">
          <button onclick="_raFetch()" title="Refresh topic list"
            style="background:var(--bg3);border:1px solid var(--brd);border-radius:6px;
                   color:var(--acc);padding:0 10px;font-size:13px;cursor:pointer">↻</button>
        </div>
        <div id="ra-topic-list" style="flex:1;overflow-y:auto"></div>
        <div id="ra-confirm" style="display:none;border-top:1px solid var(--brd);
             padding:12px 16px;background:var(--bg)">
          <div style="font-size:11px;color:var(--dim);margin-bottom:8px">
            Display name <span style="color:var(--dim)">(optional)</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="ra-icon" style="font-size:18px"></span>
            <input id="ra-name" type="text" placeholder="ชื่อ display..."
              style="flex:1;background:var(--bg3);border:1px solid var(--brd);border-radius:6px;
                     padding:6px 10px;color:var(--fg);font-size:12px;outline:none"
              onkeydown="if(event.key==='Enter') rvizConfirmAdd()">
            <button onclick="rvizConfirmAdd()"
              style="background:var(--acc);color:#fff;border:none;border-radius:6px;
                     padding:7px 18px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">
              ＋ Add
            </button>
            <button onclick="rvizCloseAdd()"
              style="background:var(--bg3);color:var(--mt);border:1px solid var(--brd);
                     border-radius:6px;padding:7px 10px;font-size:12px;cursor:pointer">Cancel</button>
          </div>
        </div>
      </div>`;
    modal.addEventListener('click',e=>{if(e.target===modal)rvizCloseAdd();});
    document.body.appendChild(modal);
  }

  modal.style.display='flex';
  _pendingAdd=null;
  document.getElementById('ra-confirm').style.display='none';
  _raFilter('');
  _raFetch();
}

let _raFetching=false;
async function _raFetch(){
  if(_raFetching) return;
  _raFetching=true;
  const el=document.getElementById('ra-topic-list');
  if(el) el.innerHTML='<div style="padding:14px 16px;color:var(--dim);font-size:11px">⏳ Loading topics from robot...</div>';
  try{
    if(!sessionId) throw new Error('SSH not connected');
    const res=await API('/api/exec',{
      sessionId,
      command:`source ${_setupBash} 2>/dev/null; ros2 topic list -t 2>/dev/null`,
      timeout:8000,
    });
    if(!res?.ok||!res.stdout) throw new Error('ros2 topic list failed');
    const lines=res.stdout.trim().split('\n').filter(Boolean);
    _topicCache=lines.map(line=>{
      const m=line.match(/^(\S+)\s+\[(.+)\]$/);
      if(!m) return {name:line.trim(),type:'',dispType:null};
      const name=m[1], type=m[2];
      return {name, type, dispType:TYPE_MAP[type]||null};
    }).filter(t=>t.name);
    _raRender(_topicCache);
  }catch(e){
    if(el) el.innerHTML=
      `<div style="padding:14px 16px;color:var(--red);font-size:11px">❌ ${escH(String(e.message))}</div>`;
  }finally{_raFetching=false;}
}

function _raFilter(q){
  const f=q.toLowerCase();
  const filtered=_topicCache.filter(t=>
    !f||t.name.toLowerCase().includes(f)||
    t.type.toLowerCase().includes(f)||
    (t.dispType||'').toLowerCase().includes(f));
  _raRender(filtered);
}

function _raRender(topics){
  const el=document.getElementById('ra-topic-list'); if(!el) return;
  _raList=topics;
  if(!topics.length){
    el.innerHTML='<div style="padding:14px 16px;color:var(--dim);font-size:11px">No topics found</div>';
    return;
  }
  const known  =[];
  const unknown=[];
  topics.forEach((t,i)=>{ (t.dispType?known:unknown).push({t,i}); });

  const row=({t,i})=>{
    const icon=t.dispType?(DTYPES[t.dispType]?.icon||'📦'):'❓';
    const badge=t.dispType?`<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:var(--adim);color:var(--acc);flex-shrink:0">${escH(t.dispType)}</span>`:'';
    const short=t.type.split('/').pop()||t.type;
    const sel=_pendingAdd?.name===t.name;
    const btn=t.dispType?`<button data-ri="${i}" class="ra-add-btn"
        style="background:var(--acc);color:#fff;border:none;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0">+ Add</button>`:'';
    return `<div data-ri="${i}" class="ra-row"
      style="display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;
             border-bottom:1px solid rgba(255,255,255,.035);
             background:${sel?'var(--adim)':'transparent'}">
      <span style="font-size:16px;flex-shrink:0">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--fg);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-weight:${t.dispType?'500':'400'}">${escH(t.name)}</span>${badge}
        </div>
        <div style="font-size:10px;color:var(--dim);margin-top:1px">${escH(short)}</div>
      </div>${btn}
    </div>`;
  };

  let html='';
  if(known.length){
    html+=`<div style="padding:5px 16px 3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;background:var(--bg1)">Supported Topics</div>`;
    html+=known.map(row).join('');
  }
  if(unknown.length){
    html+=`<div style="padding:5px 16px 3px;font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;background:var(--bg1)">Other Topics</div>`;
    html+=unknown.map(row).join('');
  }
  el.innerHTML=html;

  el.querySelectorAll('.ra-row').forEach(div=>{
    const i=+div.dataset.ri;
    div.addEventListener('click',()=>{ const t=_raList[i]; if(t) _raSel(t.name,t.type,t.dispType); });
  });
  el.querySelectorAll('.ra-add-btn').forEach(btn=>{
    const i=+btn.dataset.ri;
    btn.addEventListener('click',e=>{ e.stopPropagation(); const t=_raList[i]; if(t) _raQuickAdd(t.name,t.type,t.dispType); });
  });
}

function _raSel(name,type,dispType){
  _pendingAdd={name,type,dispType};
  const def=DTYPES[dispType]||null;
  const panel=document.getElementById('ra-confirm');
  const iconEl=document.getElementById('ra-icon');
  const nameEl=document.getElementById('ra-name');

  if(panel) panel.style.display='flex';
  if(iconEl) iconEl.textContent=def?.icon||'📦';
  if(nameEl){
    const shortName=name.split('/').filter(Boolean).pop()||name;
    const typePart=dispType||'Display';
    nameEl.value=`${typePart} [${shortName}]`;
    setTimeout(()=>nameEl.select(),50);
  }
  _raRender(_topicCache.filter(t=>{
    const q=document.getElementById('rviz-add-q')?.value?.toLowerCase()||'';
    return !q||t.name.toLowerCase().includes(q)||t.type.toLowerCase().includes(q)||(t.dispType||'').toLowerCase().includes(q);
  }));
  panel?.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function _raQuickAdd(name,type,dispType){
  if(!dispType||!DTYPES[dispType]) return;
  const shortName=name.split('/').filter(Boolean).pop()||name;
  const displayName=dispType+' ['+shortName+']';
  const overrides={displayName};
  if(DTYPES[dispType]?.def?.topic!==undefined) overrides.topic=name;
  rvizAddDisplay(dispType,true,overrides);
  rvizRenderPanel();
  rvizCloseAdd();
  if(_live) _restartStream();
  if(typeof sbMsg==='function') sbMsg('Added: '+displayName,2000);
}

function rvizConfirmAdd(){
  if(!_pendingAdd){ return; }
  const {name, dispType} = _pendingAdd;
  const nameInput=document.getElementById('ra-name');
  const displayName=(nameInput?.value?.trim())||dispType||name;
  const type=dispType&&DTYPES[dispType] ? dispType : 'LaserScan';
  const overrides={displayName};
  if(name && DTYPES[type]?.def?.topic!==undefined) overrides.topic=name;

  rvizAddDisplay(type,true,overrides);
  rvizRenderPanel();
  rvizCloseAdd();
  if(_live) _restartStream();
  if(typeof sbMsg==='function') sbMsg('Added: '+displayName,2000);
}

function rvizCloseAdd(){
  const m=document.getElementById('rviz-add-modal'); if(m) m.style.display='none';
  _pendingAdd=null;
}
function rvizAddTopic(){rvizShowAddDialog();}

// ═══════════════════════════════════════════════════════════════
//  PANEL RENDERING
// ═══════════════════════════════════════════════════════════════
function rvizRenderPanel(){
  const el=document.getElementById('rviz-display-list'); if(!el) return;
  el.innerHTML=displayList.map(d=>{
    const def=DTYPES[d.type]||{label:d.type,icon:'📦',html:()=>''};
    const tb=d.props.topic?`<span class="rviz-topic-badge">${escH(d.props.topic)}</span>`:'';
    return `
    <div class="rviz-disp open" id="rd-${d.id}">
      <div class="rviz-disp-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="rviz-disp-arrow">▾</span>
        <input type="checkbox" ${d.enabled?'checked':''} class="rviz-cb"
          onclick="event.stopPropagation();rdEnable('${d.id}',this.checked)">
        <span class="rviz-disp-icon">${def.icon}</span>
        <span class="rviz-disp-name">${escH(d.props.displayName||def.label)}</span>${tb}
        <span class="rviz-disp-status ${d.enabled?'ds-ok':'ds-off'}" id="ds-${d.id}">${d.enabled?'●':'—'}</span>
        <button class="rviz-del-btn" onclick="event.stopPropagation();rvizRemoveDisplay('${d.id}')" title="Remove">✕</button>
      </div>
      <div class="rviz-disp-body">${def.html(d.id,d.props)}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
//  FIXED FRAME
// ═══════════════════════════════════════════════════════════════
function rvizSetFixedFrame(f){
  rviz3d.fixedFrame=f;
  rviz3d.fixedFrameLocked=true;   // ผู้ใช้เลือกเอง → ล็อค ห้าม auto-jump ทับ
  const el=document.getElementById('rviz-fixed-frame-display');
  if(el) el.textContent=f;
  const sel=document.getElementById('rviz-fixed-frame-sel'); if(sel) sel.value=f;

  // ล้างการประเมิน TF เดิมทิ้งทั้งหมด
  rvizCam.target={x:0,y:0,z:0};
  _tfStore.clear();
  _renderFrameSel();   // รีเฟรช dropdown ให้ตรงกับ choice ของผู้ใช้
}

async function rvizRefreshFrames(){
  if(!sessionId) return;
  try{
    const res=await API('/api/exec',{sessionId,
      command:`source ${_setupBash} 2>/dev/null; ros2 topic echo /tf_static --once 2>/dev/null `+
        `| grep -E 'frame_id:|child_frame_id:' | awk '{print $2}' | sort -u`,timeout:4000});
    if(res?.ok&&res.stdout){
      const frames=res.stdout.trim().split('\n').filter(f=>/^\w/.test(f));
      rviz3d.tfFrames=[...new Set([...rviz3d.tfFrames,...frames])];
      _renderFrameSel();
    }
  }catch{}
}
function _renderFrameSel(){
  const sel=document.getElementById('rviz-fixed-frame-sel'); if(!sel) return;
  const cur=rviz3d.fixedFrame;
  sel.innerHTML=rviz3d.tfFrames.map(f=>`<option value="${escH(f)}"${f===cur?' selected':''}>${escH(f)}</option>`).join('');
}

// ═══════════════════════════════════════════════════════════════
//  MISC
// ═══════════════════════════════════════════════════════════════
function rvizClear(){
  _tfStore.clear();
  displayList.forEach(d=>{
    const obj=rviz3d.objects[d.id]; if(!obj) return;
    if(d.type==='TF'||d.type==='Odometry') while(obj.children.length){ const c=obj.children[0]; obj.remove(c); _disposeObj(c); }
    if(d.type==='Odometry') obj._pts=[];
    if(d.type==='LaserScan'&&obj.geometry) obj.geometry.setDrawRange(0,0);
  });
  if(_texCache instanceof Map){ _texCache.forEach(t=>t.dispose&&t.dispose()); _texCache.clear(); }
  ['rv-scan-pts','rv-pos','rv-yaw'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='—';});
}
function rvizSetView(mode){
  if(mode==='top')      {rvizCam.phi=0.02;rvizCam.theta=0;rvizCam.radius=20;}
  else if(mode==='front'){rvizCam.phi=Math.PI/2;rvizCam.theta=0;rvizCam.radius=12;}
  else                  {rvizCam.phi=Math.PI/3;rvizCam.theta=Math.PI/4;rvizCam.radius=8;}
}
function rvizResetView(){rvizSetView('3d');rvizCam.target={x:0,y:0,z:0};}
function _ovl(msg)
{
  //const el=document.getElementById('rviz-overlay');
  /*
  if(el)
    {
      el.textContent=msg;
      el.style.display=msg?'block':'none';
    }*/
}
function _badge(txt,cls,dot){const el=document.getElementById('rviz-conn-badge');if(el){el.className='badge '+cls;el.innerHTML=`<span class="dot ${dot}"></span>${txt}`;}}
function rvizGridCellSize(v){displayList.filter(d=>d.type==='Grid').forEach(d=>{d.props.cellSize=v;_rebuildGrid(d.id)});}
function rvizGridCount(v)   {displayList.filter(d=>d.type==='Grid').forEach(d=>{d.props.cellCount=v;_rebuildGrid(d.id)});}
function rvizGridColor(h)   {displayList.filter(d=>d.type==='Grid').forEach(d=>{d.props.color=h;_rebuildGrid(d.id)});}

// ═════════════════════════════════════════════════════════════
//  TELEOP CONTROL PANEL (cmd_vel)
//  แผงควบคุมขับหุ่นยนต์แบบกดค้าง (press & hold) → ส่ง geometry_msgs/Twist
//  ลง /cmd_vel ตามปกติ (linear.x + angular.z) ผ่าน `ros2 topic pub`
//  - แผงลากได้ (drag ที่ header) และซ่อนได้ (toggle ปุ่ม 🕹)
//  - รองรับทั้งเมาส์/ทัช (pointer events) และคีย์บอร์ด (WASD / ลูกศร)
// ═════════════════════════════════════════════════════════════
const TELEOP_PY   = '/tmp/_teleop_pub.py';   // script ของ persistent publisher
const TELEOP_TGT  = '/tmp/_teleop.target';   // ไฟล์เก็บ target twist (ลำดับ: "lin ang")
const TELEOP_ACC  = '/tmp/_teleop.accel';    // ไฟล์เก็บความเร่ง (lin ang) — ปรับความฉับไว/สมูท สดๆ ได้
const TELEOP_PID  = '/tmp/_teleop.pid';
const TELEOP_RATE = 100;                      // Hz — อัตรา publish (สูงพอไม่หลุด CMD_TIMEOUT 0.5s + ลดหน่วง)
const rvizTeleop = {
  lin: 0, ang: 0,                 // ความเร็วที่ต้องการ (linear.x, angular.z)
  linScale: 1.0, angScale: 2.0,   // เพดานความเร็วจากสไลเดอร์ (เพิ่มจาก 0.5 / 1.0)
  accLin: 8.0, accAng: 14.0,      // ความเร่ง (ปรับความฉับไว vs ความสมูท) — สไลเดอร์เขียนลงไฟล์
  curLin: 0, curAng: 0,           // twist ล่าสุดที่เขียนลง target ไฟล์
  pid: null,                      // PID ของ node persistent
  running: false, busy: false, dirty: false,
  topic: '/cmd_vel',
};
// Source ของ persistent publisher — เขียนลงหุ่นครั้งเดียว แล้วอ่าน target จากไฟล์
// → เปลี่ยนทิศทางแค่เขียนไฟล์ (ไม่ต้อง kill/spawn process ใหม่ → ตอบสนองทันที ไม่หน่วง)
const _teleopPySrc = [
  "#!/usr/bin/env python3",
  "# ros2ide_teleop_pub - persistent /cmd_vel publisher with smooth accel/decel ramp",
  "import rclpy, sys, time, math",
  "from rclpy.node import Node",
  "from geometry_msgs.msg import Twist",
  "class TP(Node):",
  "    def __init__(self, path, topic, rate):",
  "        super().__init__('teleop_pub')",
  "        self.pub = self.create_publisher(Twist, topic, 10)",
  "        self.path = path",
  "        self.dt = 1.0 / rate",
  "        self.target = [0.0, 0.0]    # ความเร็วเป้าหมายจากไฟล์ (กระโดดได้)",
  "        self.cur = [0.0, 0.0]       # ความเร็วที่ส่งจริง (ค่อยๆ ไต่ไปหา target → สมูท)",
  "        self.A_LIN = 8.0   # m/s^2 - ความเร่งเชิงเส้นดีฟอลต์ (ปรับสดๆ ได้ผ่านไฟล์ .accel)",
  "        self.A_ANG = 14.0  # rad/s^2 - ความเร่งเชิงมุมดีฟอลต์",
  "        self.create_timer(self.dt, self.cb)",
  "    def _ramp(self, cur, tgt, amax):",
  "        d = tgt - cur",
  "        if abs(d) <= amax * self.dt:",
  "            return tgt",
  "        return cur + math.copysign(amax * self.dt, d)",
  "    def cb(self):",
  "        try:",
  "            with open(self.path) as f:",
  "                s = f.read().strip()",
  "            if s:",
  "                p = s.split()",
  "                if len(p) >= 2:",
  "                    self.target = [float(p[0]), float(p[1])]",
  "        except Exception:",
  "            pass",
  "        try:",
  "            with open(self.path.rsplit('.',1)[0] + '.accel') as fa:",
  "                av = fa.read().strip().split()",
  "                if len(av) >= 2:",
  "                    self.A_LIN = float(av[0]); self.A_ANG = float(av[1])",
  "        except Exception:",
  "            pass",
  "        self.cur[0] = self._ramp(self.cur[0], self.target[0], self.A_LIN)",
  "        self.cur[1] = self._ramp(self.cur[1], self.target[1], self.A_ANG)",
  "        tw = Twist()",
  "        tw.linear.x = self.cur[0]",
  "        tw.angular.z = self.cur[1]",
  "        self.pub.publish(tw)",
  "def main():",
  "    rclpy.init()",
  "    node = TP(sys.argv[1], sys.argv[2], float(sys.argv[3]))",
  "    try:",
  "        rclpy.spin(node)",
  "    finally:",
  "        node.destroy_node()",
  "        rclpy.shutdown()",
  "if __name__ == '__main__':",
  "    main()",
].join('\n');
const rvizTeleopActive = new Set();   // direction ที่กำลังกดค้างอยู่
let _teleopInited = false;

// สร้าง YAML Twist string (สำหรับส่ง one-shot ตอนหยุด)
function rvizTeleopTwist(lin, ang){
  return "{linear: {x: " + lin.toFixed(3) + ", y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: " + ang.toFixed(3) + "}}";
}
// string สำหรับเขียนลง target ไฟล์: "lin ang"
function rvizTeleopTargetStr(lin, ang){
  return lin.toFixed(3) + ' ' + ang.toFixed(3);
}
// ส่ง twist ครั้งเดียว (-1) — fallback ตอนหยุด (ให้หยุดทันทีแม้ node จะตาย)
function rvizTeleopSendOnce(lin, ang){
  if(!sessionId) return Promise.resolve();
  const tw = rvizTeleopTwist(lin, ang);
  return API('/api/exec', {
    sessionId,
    command: `source ${_setupBash} 2>/dev/null; ros2 topic pub -1 -w 0 ${rvizTeleop.topic} geometry_msgs/msg/Twist '${tw}'`,
    timeout: 20000
  }).catch(()=>{});
}
// หยุด node persistent (kill ด้วย PID + pattern ที่ self-safe) และลบไฟล์
function rvizTeleopStopProcOnly(){
  const cmd = (rvizTeleop.pid ? `kill ${rvizTeleop.pid} 2>/dev/null; ` : '') +
    `for p in $(pgrep -f '_teleop_pub[.]py' 2>/dev/null); do [ "$p" != "$$" ] && kill $p 2>/dev/null; done; rm -f ${TELEOP_PID} ${TELEOP_TGT}; true`;
  rvizTeleop.pid = null; rvizTeleop.running = false;
  return API('/api/exec', { sessionId, command: cmd, timeout: 2000 }).catch(()=>{});
}
// เขียน target twist ลงไฟล์ (node persistent อ่านแล้ว publish → เปลี่ยนทิศทางทันที ไม่ต้อง spawn ใหม่)
function rvizTeleopWriteTarget(lin, ang){
  const s = rvizTeleopTargetStr(lin, ang);
  return API('/api/exec', { sessionId, command: `printf '%s' '${s}' > ${TELEOP_TGT}`, timeout: 2000 }).catch(()=>{});
}
// เขียนความเร่ง (lin ang) ลงไฟล์ → node อ่านสดๆ ปรับความฉับไว/สมูท ไม่ต้อง restart
function rvizTeleopWriteAccel(){
  const s = rvizTeleop.accLin.toFixed(1) + ' ' + rvizTeleop.accAng.toFixed(1);
  return API('/api/exec', { sessionId, command: `printf '%s' '${s}' > ${TELEOP_ACC}`, timeout: 2000 }).catch(()=>{});
}
// ตรวจ/รัน node persistent ครั้งเดียว (เขียน script + spawn) — จากนั้นเปลี่ยนทิศทางแค่เขียนไฟล์
function rvizTeleopEnsureNode(){
  if(rvizTeleop.running) return Promise.resolve();
  if(rvizTeleop.busy){ rvizTeleop.dirty = true; return Promise.resolve(); }  // กำลัง spawn → จดไว้รอบหน้า
  rvizTeleop.busy = true;
  const killStale = `for p in $(pgrep -f '_teleop_pub[.]py' 2>/dev/null); do [ "$p" != "$$" ] && kill $p 2>/dev/null; done`;
  const startCmd = `source ${_setupBash} 2>/dev/null; ${killStale}; rm -f ${TELEOP_PID}; nohup python3 -u ${TELEOP_PY} ${TELEOP_TGT} ${rvizTeleop.topic} ${TELEOP_RATE} > /tmp/_teleop_out.log 2>&1 & echo $! > ${TELEOP_PID}`;
  return API('/api/files/write', { sessionId, path: TELEOP_PY, content: _teleopPySrc }).then(()=>
    API('/api/exec', { sessionId, command: startCmd, timeout: 5000 })
  ).then(r=>{
    if(r && r.ok){
      const m = String(r.stdout || '').trim().split(/\s+/).pop();
      if(m && /^\d+$/.test(m)) rvizTeleop.pid = m;
      rvizTeleop.running = true;
      rvizTeleopWriteAccel();   // ส่งค่าความเร่งเริ่มต้นลงไฟล์ (node อ่านสดๆ)
    }
  }).catch(()=>{}).finally(()=>{
    rvizTeleop.busy = false;
    if(rvizTeleop.dirty){ rvizTeleop.dirty = false; rvizTeleopEnsureNode(); } // มีการเปลี่ยนระหว่างรอ → รันใหม่
  });
}
// เริ่มส่ง cmd_vel: ให้ node persistent รัน (ถ้ายังไม่รัน) แล้วเขียน target ทันที — ไม่มีหน่วงเวลา spawn
function rvizTeleopStart(){
  if(!sessionId) return;
  const lin = rvizTeleop.lin, ang = rvizTeleop.ang;
  if(lin === 0 && ang === 0){ rvizTeleopStop(); return; }
  if(rvizTeleop.running){
    if(rvizTeleop.curLin !== lin || rvizTeleop.curAng !== ang) rvizTeleopWriteTarget(lin, ang); // เปลี่ยนทิศทาง → แค่เขียนไฟล์ (เร็ว, ไม่ spawn ใหม่)
  } else {
    rvizTeleopEnsureNode().then(()=> rvizTeleopWriteTarget(lin, ang));
  }
  rvizTeleop.curLin = lin; rvizTeleop.curAng = ang;
}
// คำนวณ lin/ang จากชุดทิศทางที่กดค้าง + เพดานความเร็ว แล้วส่ง/หยุด
function rvizTeleopRecompute(){
  let lin = 0, ang = 0;
  if(rvizTeleopActive.has('fwd')  && !rvizTeleopActive.has('back')) lin =  rvizTeleop.linScale;
  else if(rvizTeleopActive.has('back') && !rvizTeleopActive.has('fwd')) lin = -rvizTeleop.linScale;
  if(rvizTeleopActive.has('left') && !rvizTeleopActive.has('right')) ang =  rvizTeleop.angScale;
  else if(rvizTeleopActive.has('right') && !rvizTeleopActive.has('left')) ang = -rvizTeleop.angScale;
  rvizTeleop.lin = lin; rvizTeleop.ang = ang;
  if(lin === 0 && ang === 0) rvizTeleopStop(); else rvizTeleopStart();
  rvizTeleopUpdateUI();
}
function rvizTeleopSet(dir, on){
  if(on) rvizTeleopActive.add(dir); else rvizTeleopActive.delete(dir);
  rvizTeleopRecompute();
}
// หยุด: เคลียร์ทิศทาง + เขียน target 0 (node ค้างไว้ → กดซ้ำตอบสนองทันที ไม่มีดีเลย์สปาวน์)
// หมายเหตุ: ไม่ฆ่า node ที่นี่ (ฆ่าเฉพาะตอน Disconnect) เพื่อลดความหน่วงในการควบคุม
function rvizTeleopStop(){
  rvizTeleopActive.clear();
  rvizTeleop.lin = 0; rvizTeleop.ang = 0;
  rvizTeleopWriteTarget(0, 0);                       // ramp ลงสู่ 0 (สมูท)
  if(!rvizTeleop.running) rvizTeleopSendOnce(0, 0);  // fallback หยุดทันทีกรณี node ตาย
  rvizTeleopUpdateUI();
}
// ซ่อน/แสดงแผง (ซ่อน → หยุดส่งทันที กันหุ่นวิ่งต่อหลังปิดแผง)
function rvizTeleopToggle(){
  const p = document.getElementById('rviz-teleop'); if(!p) return;
  const willHide = p.style.display !== 'none';
  p.style.display = willHide ? 'none' : '';
  if(willHide) rvizTeleopStop();
}
function rvizTeleopUpdateUI(){
  const st = document.getElementById('rviz-teleop-state');
  if(st){
    const live = rvizTeleop.running && (rvizTeleop.lin !== 0 || rvizTeleop.ang !== 0);
    st.textContent = live ? 'LIVE ●' : 'stopped';
    st.classList.toggle('live', live);
  }
  document.querySelectorAll('.rv-tp-btn').forEach(b=>{
    b.classList.toggle('on', rvizTeleopActive.has(b.dataset.dir));
  });
  const lv = document.getElementById('rviz-teleop-linval'); if(lv) lv.textContent = rvizTeleop.linScale.toFixed(2);
  const av = document.getElementById('rviz-teleop-angval'); if(av) av.textContent = rvizTeleop.angScale.toFixed(2);
}
function rvizTeleopDragInit(){
  const panel = document.getElementById('rviz-teleop');
  const handle = document.getElementById('rviz-teleop-handle');
  const vp = document.getElementById('rviz-viewport');
  if(!panel || !handle || !vp) return;
  let dx = 0, dy = 0, drag = false;
  handle.addEventListener('pointerdown', e=>{
    drag = true;
    try { handle.setPointerCapture(e.pointerId); } catch(_){}
    const r = panel.getBoundingClientRect(), v = vp.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';   // สลับเป็น left/top เพื่อลากอิสระ
  });
  handle.addEventListener('pointermove', e=>{
    if(!drag) return;
    const v = vp.getBoundingClientRect();
    let x = e.clientX - v.left - dx, y = e.clientY - v.top - dy;
    x = Math.max(4, Math.min(x, v.width  - panel.offsetWidth  - 4));
    y = Math.max(4, Math.min(y, v.height - panel.offsetHeight - 4));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  });
  const end = ()=>{ drag = false; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
function rvizTeleopKey(e){
  if(!sessionId) return;
  const page = document.getElementById('page-rviz');
  if(!page || !page.classList.contains('show')) return;   // ทำงานเฉพาะตอนเปิดหน้า RViz
  const p = document.getElementById('rviz-teleop');
  if(!p || p.style.display === 'none') return;
  const a = document.activeElement;
  if(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
  const map = { ArrowUp:'fwd', w:'fwd', W:'fwd', ArrowDown:'back', s:'back', S:'back',
                ArrowLeft:'left', a:'left', A:'left', ArrowRight:'right', d:'right', D:'right' };
  const dir = map[e.key];
  if(dir){ e.preventDefault(); rvizTeleopSet(dir, true); }
}
function rvizTeleopKeyUp(e){
  const map = { ArrowUp:'fwd', w:'fwd', W:'fwd', ArrowDown:'back', s:'back', S:'back',
                ArrowLeft:'left', a:'left', A:'left', ArrowRight:'right', d:'right', D:'right' };
  const dir = map[e.key];
  if(dir) rvizTeleopSet(dir, false);
}
// ผูก event ทั้งหมด (เรียกครั้งเดียว)
function rvizTeleopInit(){
  if(_teleopInited) return; _teleopInited = true;
  const ti = document.getElementById('rviz-teleop-topic');
  if(ti) ti.addEventListener('change', e=>{ rvizTeleop.topic = (e.target.value || '/cmd_vel').trim() || '/cmd_vel'; });
  const ls = document.getElementById('rviz-teleop-lin');
  if(ls) ls.addEventListener('input', e=>{ rvizTeleop.linScale = Math.max(0.01, +e.target.value || 0.5); rvizTeleopRecompute(); });
  const as = document.getElementById('rviz-teleop-ang');
  if(as) as.addEventListener('input', e=>{ rvizTeleop.angScale = Math.max(0.01, +e.target.value || 1); rvizTeleopRecompute(); });
  const ac = document.getElementById('rviz-teleop-acc');
  if(ac) ac.addEventListener('input', e=>{
    const v = Math.max(2, +e.target.value || 8);     // 2=สมูทมาก, 20=ฉับไวมาก
    rvizTeleop.accLin = v; rvizTeleop.accAng = v * 1.75;
    rvizTeleopWriteAccel();
    const av = document.getElementById('rviz-teleop-accval'); if(av) av.textContent = v.toFixed(0);
  });
  document.querySelectorAll('.rv-tp-btn').forEach(b=>{
    const dir = b.dataset.dir;
    const down = e=>{ e.preventDefault(); if(!sessionId){ sbMsg('ต้องเชื่อมต่อหุ่นก่อน'); return; } rvizTeleopSet(dir, true); };
    const up   = e=>{ e.preventDefault(); rvizTeleopSet(dir, false); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointerleave', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', e=> e.preventDefault());
  });
  rvizTeleopDragInit();
  window.addEventListener('keydown', rvizTeleopKey);
  window.addEventListener('keyup', rvizTeleopKeyUp);
  rvizTeleopUpdateUI();
}
