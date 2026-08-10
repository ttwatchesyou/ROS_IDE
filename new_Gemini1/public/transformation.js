'use strict';
// ═══════════════════════════════════════════════════════════════
//  TRANSFORMATION — 3D TF Model Builder
//  ประกอบโมเดลหุ่นยนต์ (ตัวถัง/ล้อ/เซนเซอร์) + ระบุเฟรม/TF ให้ง่าย
//  ใช้ Three.js (โหลด lazy เหมือน rviz.js) + custom orbit camera
//  Convention พิกัดเดียวกับ rviz: r2t(rx,ry,rz)=(-ry,rz,-rx)
// ═══════════════════════════════════════════════════════════════

// ── coord conversion (ROS → Three) ──
function tf_r2t(x, y, z) { return new THREE.Vector3(y, z, x); }

function tfRosToQuat(rDeg, pDeg, yDeg) {
  const r = THREE.MathUtils.degToRad(rDeg), p = THREE.MathUtils.degToRad(pDeg), y = THREE.MathUtils.degToRad(yDeg);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'XYZ'));
  return new THREE.Quaternion(q.y, q.z, q.x, q.w).normalize();
}

// ── state ──
const tf = {
  renderer: null, scene: null, camera: null, perspCam: null, orthoCam: null,
  proj: 'perspective',
  ready: false,
  comps: [], selected: null, _nid: 1,
  transformControls: null, gizmoDragging: false, snap: false,
  showLabels: true,
  groupVis: {},
  userComps: [],
  cam: { theta: Math.PI / 4, phi: Math.PI / 3, radius: 6, target: { x: 0, y: 0, z: 0 }, drag: false, rightDrag: false, lx: 0, ly: 0 },
  container: null, ray: null, selBox: null,
  odom: { wheels: [], pattern: 'differential', ppr: 1024, channels: 4 },
};
const tfTypeMeta = {
  base:     { label: '🤖 Chassis',   color: 0x4f8ef7, hasSize: true },
  wheel:    { label: '⚙️ Wheel',     color: 0xf2b134, hasSize: true },
  lidar:    { label: '📡 Lidar',     color: 0x62cf73, hasSize: true },
  camera:   { label: '🎥 Camera',    color: 0xb98cff, hasSize: true },
  imu:      { label: '🧭 IMU',       color: 0xff7eb6, hasSize: true },
  box:      { label: '📦 Box',       color: 0x8aa0b5, hasSize: true },
  cylinder: { label: '🔵 Cylinder',  color: 0x57c7d4, hasSize: true },
  encoder:  { label: '🟠 Encoder',     color: 0xd4a017, hasSize: true },
  omni:     { label: '🛞 Omni Wheel', color: 0x00d2ff, hasSize: true },
};

// ── small 3D SVG icons for the COMPONENTS panel ──
const tfIcons = {
  base:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 13l2-5h10l3 5v4H3Z"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="15.5" cy="17" r="1.8"/></svg>`,
  wheel:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>`,
  lidar:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5 14h14l-2 6H7Z"/><path d="M12 3v11"/><circle cx="12" cy="3" r="2"/></svg>`,
  camera:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="8" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3Z"/></svg>`,
  imu:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>`,
  box:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3 21 8 12 13 3 8Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`,
  cylinder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/></svg>`,
  encoder:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="7" y="3" width="10" height="9" rx="1.5"/><path d="M12 12v7"/><circle cx="12" cy="20" r="2"/></svg>`,
  omni:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4"/><path d="M12 5l3 3M19 12l-3 3M12 19l-3-3M5 12l3-3"/></svg>`,
};

// maps a ROS dimension (sx/sy/sz) to the Three.js scale axis that grows it
// (derived from each type's BoxGeometry/CylinderGeometry orientation)
const tfGeoAxisMap = {
  base:     { x: 'z', y: 'x', z: 'y' },
  box:      { x: 'x', y: 'z', z: 'y' },
  wheel:    { x: 'x', y: 'y', z: 'z' },
  lidar:    { x: 'x', y: 'z', z: 'x' },
  camera:   { x: 'x', y: 'z', z: 'y' },
  imu:      { x: 'x', y: 'z', z: 'y' },
  cylinder: { x: 'x', y: 'z', z: 'x' },
  encoder:  { x: 'x', y: 'z', z: 'y' },
  omni:     { x: 'x', y: 'y', z: 'z' },
};

// ── persistence ──
function tfStoreKey() { return 'tf_model_' + (sessionId || 'default'); }
function tfSave() {
  try {
    const data = tf.comps.map(c => ({
      id: c.id, type: c.type, name: c.name, parent: c.parent,
      pos: c.pos, rpy: c.rpy, params: c.params, viewGroup: c.viewGroup || '',
      customId: c.customId || '',
    }));
    localStorage.setItem(tfStoreKey(), JSON.stringify(data));
    try { localStorage.setItem(tfStoreKey() + '_grp', JSON.stringify(tf.groupVis || {})); } catch (e) {}
  } catch (e) {}
}
// turn a plain comp array (from localStorage or the server) into live tf.comps
function tfApplyComps(arr) {
  if (!Array.isArray(arr) || !arr.length) return false;
  tf.comps = arr.map(d => Object.assign({ group: null, _mat: null, viewGroup: '', customId: '' }, d));
  // keep the id counter ahead of any loaded ids so new comps never collide
  let max = 0;
  tf.comps.forEach(c => {
    const n = parseInt(String(c.id).replace(/\D/g, ''), 10);
    if (!isNaN(n)) max = Math.max(max, n);
  });
  tf._nid = max + 1;
  return true;
}
function tfLoad() {
  try {
    const raw = localStorage.getItem(tfStoreKey());
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!tfApplyComps(data)) return false;
    try { tf.groupVis = JSON.parse(localStorage.getItem(tfStoreKey() + '_grp')) || {}; } catch (e) { tf.groupVis = {}; }
    return true;
  } catch (e) { return false; }
}
// Restore the saved workspace state (models + TFs).
// 1) in-browser cache (localStorage), 2) the saved package's tf_model.json.
async function tfLoadWorkspace() {
  if (tfLoad()) return true;
  if (!sessionId) return false;
  try {
    const r = await API('/api/files/read', {
      sessionId, path: '~/ros2_ws/src/sim_robot_tf/tf_model.json',
    });
    if (r && r.ok && r.content) {
      const data = JSON.parse(r.content);
      if (tfApplyComps(data)) return true;
    }
  } catch (e) {}
  return false;
}

// ── component factory ──
function tfDefaultParams(type) {
  switch (type) {
    case 'base':     return { sx: 0.6, sy: 0.4, sz: 0.25 };
    case 'wheel':    return { radius: 0.1, width: 0.05 };
    case 'lidar':    return { radius: 0.05, height: 0.12 };
    case 'camera':   return { w: 0.06, h: 0.05, d: 0.04 };
    case 'imu':      return { s: 0.04 };
    case 'box':      return { sx: 0.2, sy: 0.2, sz: 0.2 };
    case 'cylinder': return { radius: 0.1, height: 0.2 };
    case 'encoder':  return { bodyR: 0.02, bodyH: 0.03, shaftR: 0.004, shaftH: 0.04 };
    case 'omni':     return { radius: 0.05, width: 0.04, rollerR: 0.012 };
    default:         return {};
  }
}
function tfUniqueName(type) {
  const base = { base: 'base_link', wheel: 'wheel', lidar: 'lidar_link', camera: 'camera_link', imu: 'imu_link', box: 'box', cylinder: 'cyl', encoder: 'encoder_link', omni: 'omni_wheel' }[type] || 'frame';
  if (type === 'base') return 'base_link';
  let i = 1, nm;
  const taken = new Set(tf.comps.map(c => c.name));
  do { nm = base + '_' + i++; } while (taken.has(nm));
  return nm;
}
function tfCreateComp(type) {
  const base = tf.comps.find(c => c.type === 'base');
  const c = {
    id: 'c' + (tf._nid++), type,
    name: tfUniqueName(type),
    parent: (type !== 'base' && base) ? base.name : '',
    pos: { x: 0, y: 0, z: 0 }, rpy: { r: 0, p: 0, y: 0 },
    params: tfDefaultParams(type), group: null, _mat: null,
  };
  if (type === 'base') {
    // chassis ลอยขึ้นจากพื้นเล็กน้อย
    c.pos = { x: 0, y: 0, z: 0 };
  } else if (base) {
    // วางบนฐานโดยอัตโนมัติ (z = ครึ่งความสูงฐาน + เล็กน้อย)
    c.pos = { x: 0, y: 0, z: (base.params.sz / 2) };
  }
  return c;
}
function tfAddComp(type) {
  const c = tfCreateComp(type);
  tf.comps.push(c);
  tfAfterChange();
  tfSelect(c.id);
}
function tfAddWheelSet(n) {
  n = Math.max(1, Math.min(12, n | 0 || 4));
  const base = tf.comps.find(c => c.type === 'base');
  const sx = base ? base.params.sx : 0.6, sy = base ? base.params.sy : 0.4, sz = base ? base.params.sz : 0.25;
  const r = 0.1, w = 0.05;
  const ix = Math.max(0.05, sx / 2 - r * 0.4), iy = Math.max(0.05, sy / 2 - r * 0.4), z = -sz / 2 + r;
  const slots = [[ix, iy, z], [ix, -iy, z], [-ix, iy, z], [-ix, -iy, z], [0, iy, z], [0, -iy, z], [ix, 0, z], [-ix, 0, z], [0, 0, z]];
  for (let i = 0; i < n; i++) {
    const s = slots[i % slots.length];
    const c = tfCreateComp('wheel');
    c.params = { radius: r, width: w };
    c.pos = { x: s[0], y: s[1], z: s[2] };
    c.parent = base ? base.name : '';
    tf.comps.push(c);
  }
  tfAfterChange();
  sbMsg('เพิ่มล้อ ' + n + ' ตัว');
}
// เพิ่มคู่ เอนโคเดอร์ + ล้อ Omni (encoder เป็น parent, omni เป็นลูกที่ปลาย shaft)
function tfAddEncoderOmni() {
  const base = tf.comps.find(c => c.type === 'base');
  const enc = tfCreateComp('encoder');
  enc.parent = base ? base.name : '';
  tf.comps.push(enc);
  const omni = tfCreateComp('omni');
  const bodyH = enc.params.bodyH || 0.03, shaftH = enc.params.shaftH || 0.04;
  omni.parent = enc.name;                       // โยงเข้ากับเอนโคเดอร์
  omni.pos = { x: 0, y: 0, z: bodyH / 2 + shaftH }; // วางบนปลาย shaft
  tf.comps.push(omni);
  tfAfterChange();
  tfSelect(enc.id);
  sbMsg('เพิ่ม Encoder + Omni Wheel (โยงกันแล้ว)');
}
function tfDeleteComp(id) {
  const c = tf.comps.find(x => x.id === id);
  if (!c) return;
  // ลบลูกที่อ้างอิงด้วย
  tf.comps = tf.comps.filter(x => x.id !== id && x.parent !== c.name);
  if (tf.selected === id) tf.selected = null;
  tfAfterChange();
}
// ปุ่มลบใหญ่ → ยืนยันก่อนลบ (ลบคอมโพเนนต์นี้และลูกที่อ้างอิง)
function tfDeleteCompConfirm(id) {
  const c = tf.comps.find(x => x.id === id);
  if (!c) return;
  const kids = tf.comps.filter(x => x.parent === c.name).map(x => x.name);
  const extra = kids.length ? `\nและจะลบคอมโพเนนต์ลูก: ${kids.join(', ')}` : '';
  if (window.confirm(`ลบคอมโพเนนต์ "${c.name}" ?${extra}`)) tfDeleteComp(id);
}

// ── geometry ──
function tfMat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.1 });
}
function tfBuildMesh(c) {
  if (c.type === 'custom') return tfBuildCustomMesh(c);
  const meta = tfTypeMeta[c.type];
  const mat = tfMat(meta.color); c._mat = mat;
  const P = c.params;
  let m;
  if (c.type === 'base') {
    // ROS: x=length,y=width,z=height → Three: X=width(y), Y=height(z), Z=length(x)
    m = new THREE.Mesh(new THREE.BoxGeometry(P.sy, P.sz, P.sx), mat);
  } else if (c.type === 'wheel') {
    const geo = new THREE.CylinderGeometry(P.radius, P.radius, P.width, 20);
    geo.rotateZ(Math.PI / 2);           // ให้แกนล้อชี้ along ROS-y (ซ้าย-ขวา)
    m = new THREE.Mesh(geo, mat);
  } else if (c.type === 'lidar') {
    m = new THREE.Mesh(new THREE.CylinderGeometry(P.radius, P.radius, P.height, 20), mat);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(P.radius * 1.4, P.radius * 0.6, P.radius * 1.4), tfMat(0x2a2f3a));
    cap.position.y = P.height / 2; m.add(cap);
  } else if (c.type === 'camera') {
    m = new THREE.Mesh(new THREE.BoxGeometry(P.d, P.h, P.w), mat);
  } else if (c.type === 'imu') {
    m = new THREE.Mesh(new THREE.BoxGeometry(P.s, P.s, P.s), mat);
  } else if (c.type === 'box') {
    m = new THREE.Mesh(new THREE.BoxGeometry(P.sx, P.sz, P.sy), mat);
  } else if (c.type === 'cylinder') {
    m = new THREE.Mesh(new THREE.CylinderGeometry(P.radius, P.radius, P.height, 20), mat);
  } else if (c.type === 'encoder') {
    // เอนโคเดอร์หมุน: ลำตัว (body) + แกน shaft + จาน code disc
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(P.bodyR, P.bodyR, P.bodyH, 24), mat);
    g.add(body);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(P.shaftR, P.shaftR, P.shaftH, 16), tfMat(0x2a2f3a));
    shaft.position.y = P.bodyH / 2 + P.shaftH / 2;
    g.add(shaft);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(P.bodyR * 0.7, P.bodyR * 0.7, P.bodyH * 0.12, 24), tfMat(0xb98cff));
    disc.position.y = P.bodyH * 0.5 - P.bodyH * 0.06;
    g.add(disc);
    g.userData.compId = c.id;
    g.children.forEach(ch => ch.userData.compId = c.id);
    return g;
  } else if (c.type === 'omni') {
    // ล้อ omni: แกนหลัก (core) + ลูก rollers ล้อมรอบ (หมุนแนวสัมผัส)
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(P.radius, P.radius, P.width, 24), mat);
    core.rotation.z = Math.PI / 2; // ชี้ along ROS-y (ซ้าย-ขวา)
    g.add(core);
    const nR = 4;
    for (let i = 0; i < nR; i++) {
      const a = (i / nR) * Math.PI * 2;
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(P.rollerR, P.rollerR, P.width * 1.04, 14), tfMat(0x2a2f3a));
      // วางลูก roller ริมแกนหลัก แล้วหมุนแกนตัวเองให้สัมผัสผิว
      roller.position.set(Math.cos(a) * (P.radius - P.rollerR * 0.6), 0, Math.sin(a) * (P.radius - P.rollerR * 0.6));
      roller.rotation.x = Math.PI / 2;      // แกนลูกหมุนแนวนอน
      roller.rotation.y = -a;               // เอียงตามทิศรอบแกนหลัก
      g.add(roller);
    }
    g.userData.compId = c.id;
    g.children.forEach(ch => ch.userData.compId = c.id);
    return g;
  } else {
    m = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), mat);
  }
  m.userData.compId = c.id; // ทำเครื่องหมายบน mesh หลักเพื่อ raycast
  return m;
}
// สร้างเมชจาก shape/params/color (ใช้ทั้ง custom instance และ preview)
function tfBuildShapeObject(shape, P, color) {
  const g = new THREE.Group();
  const mat = tfMat(color);
  const accent = tfMat(0x2a2f3a);
  if (shape === 'box') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(P.sx, P.sz, P.sy), mat));
  } else if (shape === 'cylinder') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(P.radius, P.radius, P.height, 24), mat));
  } else if (shape === 'cone') {
    // แกน ConeGeometry ชี้ along Three-Y (= ROS-z) เหมือน cylinder → ห้ามหมุน geometry
    g.add(new THREE.Mesh(new THREE.ConeGeometry(P.radius, P.height, 24), mat));
  } else if (shape === 'lidar') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(P.radius, P.radius, P.height, 28), mat));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(P.radius * 0.92, P.radius * 0.92, P.height * 0.18, 28), accent);
    cap.position.y = P.height * 0.5 - P.height * 0.09; g.add(cap);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(P.radius * 0.96, P.radius * 0.06, 10, 28), accent);
    ring.rotation.x = Math.PI / 2; ring.position.y = P.height * 0.5 - P.height * 0.02; g.add(ring);
  } else if (shape === 'camera') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(P.d, P.h, P.w), mat));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(P.h, P.d) * 0.4, Math.min(P.h, P.d) * 0.4, P.w * 0.5, 20), accent);
    lens.rotation.x = Math.PI / 2; lens.position.z = P.w * 0.5; g.add(lens);
  } else if (shape === 'sphere') {
    g.add(new THREE.Mesh(new THREE.SphereGeometry(P.radius, 24, 16), mat));
  } else if (shape === 'cad') {
    // P.mesh = {pos,nor(,groups)} หน่วยเมตร — groups ให้สีจาก MTL หลายวัสดุ
    if (P && P.mesh && P.mesh.pos && P.mesh.pos.length) {
      const geo = tfCadGeoToGeometry(P.mesh, 1);
      let cm = mat;
      const groups = P.mesh.groups;
      if (groups && groups.length) {
        const multi = groups.some(g => g.map) || (new Set(groups.map(g => g.color != null ? g.color : 0x8aa0b5))).size > 1;
        if (multi) {
          const mats = groups.map(gr => {
            const m2 = tfMat(gr.color != null ? gr.color : 0x8aa0b5);
            if (gr.map) {
              const fbColor = (gr.color != null && gr.color !== 0) ? gr.color : 0x8aa0b5;
              const tex = (typeof gr.map === 'string')
                ? new THREE.TextureLoader().load(gr.map, undefined, undefined, () => { m2.color.setHex(fbColor); m2.needsUpdate = true; })
                : gr.map;
              if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
              else if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
              m2.map = tex; m2.color.setHex(0xffffff); m2.needsUpdate = true;
            }
            return m2;
          });
          groups.forEach((gr, i) => { if (gr.count > 0) geo.addGroup(gr.start, gr.count, i); });
          cm = mats;
        } else {
          cm = tfMat(groups[0].color != null ? groups[0].color : 0x8aa0b5);
        }
      }
      if (cm) { if (Array.isArray(cm)) cm.forEach(x => { x.side = THREE.DoubleSide; }); else cm.side = THREE.DoubleSide; }
      g.add(new THREE.Mesh(geo, cm));
    } else {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat));
    }
  } else {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mat));
  }
  return g;
}
function tfBuildCustomMesh(c) {
  const def = (tf.userComps || []).find(x => x.id === c.customId);
  // CAD mesh import (shape === 'cad') → สร้าง BufferGeometry จาก mesh.pos/nor
  if (def && def.shape === 'cad') {
    const g = tfBuildCadMesh(def, def.color);
    g.traverse(o => { o.userData.compId = c.id; }); // ตั้งให้ลูกทุกตัว → raycast คลิกเลือกได้
    return g;
  }
  // composite = ชิ้นงานจากหน้า 3D Component (มีหลาย primitive)
  if (def && Array.isArray(def.parts) && def.parts.length) {
    const g = new THREE.Group();
    def.parts.forEach(sp => {
      const sub = tfBuildShapeObject(sp.shape, sp.params, (sp.color != null ? sp.color : 0x4f8ef7));
      const pos = sp.pos || { x: 0, y: 0, z: 0 }, rpy = sp.rpy || { r: 0, p: 0, y: 0 };
      sub.position.copy(tf_r2t(pos.x, pos.y, pos.z));
      sub.quaternion.copy(tfRosToQuat(rpy.r, rpy.p, rpy.y));
      g.add(sub);
    });
    c._mat = (g.children[0] && g.children[0].children[0]) ? g.children[0].children[0].material : tfMat(0x4f8ef7);
    g.userData.compId = c.id;
    return g;
  }
  const color = def ? def.color : 0x8aa0b5;
  const shape = def ? def.shape : 'box';
  const P = def ? def.params : { sx: 0.2, sy: 0.2, sz: 0.2 };
  const g = tfBuildShapeObject(shape, P, color);
  c._mat = g.children.length ? g.children[0].material : tfMat(color);
  g.userData.compId = c.id;
  return g;
}
// สร้าง mesh จาก CAD geometry (mesh.pos / mesh.nor คือ Float32 ในหน่วยเมตร)
function tfBuildCadMesh(def, color) {
  const m = tfMat(color != null ? color : 0x8aa0b5);
  const g = new THREE.Group();
  const mesh = def.mesh || (def.params && def.params.mesh);
  if (!mesh || !mesh.pos || !mesh.pos.length) {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m));
    g.userData.compId = def.id || null;
    return g;
  }
  const geo = tfCadGeoToGeometry(mesh, 1); // เก็บเป็นเมตรแล้ว (ถูกสเกลตอน import)
  const groups = mesh.groups;
  let material = m;
  if (groups && groups.length) {
    // ถ้าสีเดียว (และไม่มี texture ต่างกัน) → ใช้ single material แบบเดียวกับคอมโพเนนต์อื่น (render ชัวร์กว่า multi-material)
    const multi = groups.some(g => g.map) || (new Set(groups.map(g => g.color != null ? g.color : 0x8aa0b5))).size > 1;
    if (multi) {
      const mats = groups.map(gr => {
        const mat = tfMat(gr.color != null ? gr.color : 0x8aa0b5);
        if (gr.map) { // map_Kd → แปะ texture (สีจริงมักอยู่ตรงนี้)
          const fbColor = (gr.color != null && gr.color !== 0) ? gr.color : 0x8aa0b5;
          const tex = (typeof gr.map === 'string')
            ? new THREE.TextureLoader().load(gr.map, undefined, undefined, () => { mat.color.setHex(fbColor); mat.needsUpdate = true; })
            : gr.map;
          if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
          else if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
          mat.map = tex;
          mat.color.setHex(0xffffff); // อย่าให้สี diffuse ทับสี texture (เผื่อโหลดไม่ได้จะ fallback ด้านบน)
          mat.needsUpdate = true;
        }
        return mat;
      });
      groups.forEach((gr, i) => { if (gr.count > 0) geo.addGroup(gr.start, gr.count, i); });
      material = mats;
    } else {
      material = tfMat(groups[0].color != null ? groups[0].color : 0x8aa0b5);
    }
  }
  // CAD mesh จากภายนอก มักมี winding สลับ → normal ผิดด้าน → ดำ ให้ใช้ DoubleSide
  if (material) {
    if (Array.isArray(material)) material.forEach(x => { x.side = THREE.DoubleSide; });
    else material.side = THREE.DoubleSide;
  }
  const mesh3 = new THREE.Mesh(geo, material);
  mesh3.userData.compId = def.id || null;
  g.add(mesh3);
  g.userData.compId = def.id || null;
  return g;
}
// แปลง {pos,nor} (array ของจำนวนจริง) → THREE.BufferGeometry (คูณสเกล)
function tfCadGeoToGeometry(raw, scale) {
  const pos = raw.pos, nor = raw.nor;
  const geo = new THREE.BufferGeometry();
  const pa = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) pa[i] = pos[i] * scale;
  geo.setAttribute('position', new THREE.BufferAttribute(pa, 3));
  // ใช้ normal ที่เก็บมา ก็ต่อเมื่อไม่ใช่ศูนย์ทั้งหมด (OBJ บางตัวมี vn แต่ f ไม่ได้อ้างอิง → normal เป็น 0 ทั้งหมด → ดำ)
  // ถ้าไม่มี/ศูนย์ทั้งหมด → คำนวณ normal ใหม่จาก winding เสมอ
  let haveNor = false;
  if (nor && nor.length === pos.length) {
    for (let i = 0; i < nor.length; i++) { if (nor[i] !== 0) { haveNor = true; break; } }
  }
  if (haveNor) {
    const na = new Float32Array(nor.length);
    for (let i = 0; i < nor.length; i++) na[i] = nor[i];
    geo.setAttribute('normal', new THREE.BufferAttribute(na, 3));
  } else {
    geo.computeVertexNormals();
  }
  return geo;
}
function tfMakeLabel(text) {
  const cv = document.createElement('canvas'); cv.width = 192; cv.height = 48;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(18,20,28,0.4)';
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
  rr(3, 3, 186, 42, 8); ctx.fill();
  ctx.font = '600 15px ui-monospace, monospace'; ctx.fillStyle = '#bcd6ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 96, 25);
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  sp.scale.set(0.36, 0.09, 1);
  sp.renderOrder = 999;
  return sp;
}

// ── axes helper with RViz colors: X=Red, Y=Blue, Z=Green ──
// rotated so the arrows align with the ROS frame (tf_r2t: ROS X→-Z, Y→-X, Z→+Y)
// ── axes helper with RViz colors: X=Red, Y=Blue, Z=Green ──
function tfMakeAxes(size) {
  const axes = new THREE.AxesHelper(size);
  const col = axes.geometry.attributes.color;
  const set = (i, hex) => { const c = new THREE.Color(hex); col.setXYZ(i, c.r, c.g, c.b); };
  col.needsUpdate = true;
  const m = new THREE.Matrix4().set(
    0, 1, 0, 0,
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 0, 0, 1
  );
  axes.quaternion.setFromRotationMatrix(m);
  return axes;
}

// ── build scene graph ──
function tfBuildScene() {
  if (!tf.scene) return;
  tf.comps.forEach(c => { if (c.group) { tf.scene.remove(c.group); c.group = null; } });
  const byName = {};
  tf.comps.forEach(c => byName[c.name] = c);
  tf.comps.forEach(c => {
    const g = new THREE.Group();
    g.add(tfBuildMesh(c));
    g.position.copy(tf_r2t(c.pos.x, c.pos.y, c.pos.z));
    g.quaternion.copy(tfRosToQuat(c.rpy.r, c.rpy.p, c.rpy.y));
    g.add(tfMakeAxes(0.12));
    if (tf.showLabels) {
      const lbl = tfMakeLabel(c.name); lbl.position.set(0, 0, 0.15); g.add(lbl);
      c.label = lbl;
    } else {
      c.label = null;
    }
    c.group = g;
  });
  tf.comps.forEach(c => {
    const pg = (c.parent && byName[c.parent]) ? byName[c.parent].group : null;
    if (pg) pg.add(c.group); else tf.scene.add(c.group);
  });
  tfUpdateSelBox();
  // re-attach the transform gizmo to the (new) selected group
  if (tf.transformControls) {
    const sel = tf.comps.find(x => x.id === tf.selected);
    if (sel && sel.group && tfCompVisible(sel)) tf.transformControls.attach(sel.group);
    else tf.transformControls.detach();
  }
  tfApplyGroupVisibility();
}

// update one component's existing group IN PLACE (no rebuild → gizmo stays attached)
function tfSyncGroup(c) {
  if (!tf.scene) return;
  if (!c.group) { tfBuildScene(); return; }
  c.group.position.copy(tf_r2t(c.pos.x, c.pos.y, c.pos.z));
  c.group.quaternion.copy(tfRosToQuat(c.rpy.r, c.rpy.p, c.rpy.y));
  // rebuild only the main mesh to reflect size params (keep axes/label, keep gizmo attached)
  const old = c.group.children.find(o => o.userData && o.userData.compId === c.id);
  if (old) {
    c.group.remove(old);
    if (old.geometry && old.geometry.dispose) old.geometry.dispose();
    old.traverse(o => { if (o !== old && o.geometry && o.geometry.dispose) o.geometry.dispose(); });
  }
  c.group.add(tfBuildMesh(c));
  tfUpdateSelBox();
}

// ── selection ──
function tfSelect(id) {
  tf.selected = id;
  tfBuildScene();
  tfRenderProps();
  tfRenderTree();
}
function tfUpdateSelBox() {
  if (tf.selBox) { tf.scene.remove(tf.selBox); tf.selBox = null; }
  const c = tf.comps.find(x => x.id === tf.selected);
  if (c && c.group) {
    tf.selBox = new THREE.BoxHelper(c.group, 0xffd166);
    //tf.scene.add(tf.selBox);
  }
  if (tf._mat) tf._mat.emissive && tf._mat.emissive.setHex(0x000000);
}

// ── after any change ──
function tfAfterChange() {
  tfBuildScene();
  tfRenderTree();
  tfRenderGroups();
  tfSave();
}

// ── camera controls (mirror rviz.js) ──
function tfBindCam(el) {
  // ── เลือกคอมโพเนนต์ (raycast) — ใช้ร่วมกับ mouse click + touch tap ──
  function pickAt(clientX, clientY) {
    if (tf.transformControls && (tf.transformControls.axis || tf.transformControls.dragging)) return;
    if (!tf.ray || !tf.camera) return;
    const r = el.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = -((clientY - r.top) / r.height) * 2 + 1;
    tf.ray.setFromCamera(new THREE.Vector2(nx, ny), tf.camera);
    const hits = tf.ray.intersectObjects(tf.scene.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.compId) o = o.parent;
      if (o && o.userData.compId) {
        const comp = tf.comps.find(x => x.id === o.userData.compId);
        if (comp && !tfCompVisible(comp)) continue; // ข้ามชิ้นส่วนที่ซ่อนอยู่
        tfSelect(o.userData.compId); return;
      }
    }
  }

  el.addEventListener('mousedown', e => {
    // don't start orbiting when the user grabs a gizmo handle
    if (tf.transformControls && (tf.transformControls.axis || tf.transformControls.dragging)) return;
    tf.cam.drag = true; tf.cam.rightDrag = (e.button === 2 || e.button === 1);
    tf.cam.lx = e.clientX; tf.cam.ly = e.clientY;
  });
  window.addEventListener('mouseup', () => { tf.cam.drag = false; });
  window.addEventListener('mousemove', e => {
    if (!tf.cam.drag) return;
    if (tf.transformControls && tf.transformControls.dragging) return; // gizmo owns the drag
    const dx = e.clientX - tf.cam.lx, dy = e.clientY - tf.cam.ly;
    tf.cam.lx = e.clientX; tf.cam.ly = e.clientY;
    if (tf.cam.rightDrag) {
      const s = tf.cam.radius * 0.002;
      tf.cam.target.x -= dx * s; tf.cam.target.z -= dy * s;
    } else {
      tf.cam.theta -= dx * 0.012;
      tf.cam.phi = Math.max(0.02, Math.min(Math.PI - 0.02, tf.cam.phi - dy * 0.012));
    }
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    tf.cam.radius = Math.max(0.4, Math.min(200, tf.cam.radius * (1 + Math.sign(e.deltaY) * 0.1)));
  }, { passive: false });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => pickAt(e.clientX, e.clientY));

  // ── TOUCH EVENTS (Tablet / Mobile) — เหมือน rviz.js ──
  // 1 นิ้ว = Orbit (หมุน) · 2 นิ้ว = Pan (เลื่อนเป้าหมาย) + Pinch Zoom (ซูม)
  let _pinch = null, _tapX = 0, _tapY = 0, _tapT = 0, _tapFingers = 0, _moved = 0;
  const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  el.addEventListener('touchstart', e => {
    if (tf.transformControls && (tf.transformControls.axis || tf.transformControls.dragging)) return; // ให้ gizmo จัดการ
    e.preventDefault(); // กันเด้ง/scroll หน้าเว็บ
    _tapFingers = e.touches.length; _moved = 0;
    _tapX = e.touches[0].clientX; _tapY = e.touches[0].clientY; _tapT = _now();
    if (e.touches.length === 1) {
      // 1 นิ้ว = Orbit (เหมือนคลิกซ้าย)
      tf.cam.drag = true; tf.cam.rightDrag = false;
      tf.cam.lx = e.touches[0].clientX; tf.cam.ly = e.touches[0].clientY;
    } else if (e.touches.length >= 2) {
      // 2 นิ้ว = Pan + Zoom
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      _pinch = Math.hypot(dx, dy);
      tf.cam.drag = true; tf.cam.rightDrag = true; // โหมด Pan
      tf.cam.lx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      tf.cam.ly = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    }
  }, { passive: false });
  el.addEventListener('touchmove', e => {
    if (tf.transformControls && tf.transformControls.dragging) return; // gizmo owns the drag
    if (!tf.cam.drag) return;
    e.preventDefault();
    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - tf.cam.lx, dy = e.touches[0].clientY - tf.cam.ly;
      _moved += Math.abs(dx) + Math.abs(dy);
      tf.cam.lx = e.touches[0].clientX; tf.cam.ly = e.touches[0].clientY;
      tf.cam.theta -= dx * 0.012;
      tf.cam.phi = Math.max(0.02, Math.min(Math.PI - 0.02, tf.cam.phi - dy * 0.012));
    } else if (e.touches.length >= 2) {
      // คำนวณระยะห่าง 2 นิ้วเพื่อซูม
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (_pinch) {
        const zoomDelta = _pinch / dist;
        tf.cam.radius = Math.max(0.4, Math.min(200, tf.cam.radius * zoomDelta));
        _pinch = dist; // อัปเดตระยะล่าสุด
      }
      // จุดกึ่งกลาง เพื่อคำนวณ Pan
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const pdx = cx - tf.cam.lx, pdy = cy - tf.cam.ly;
      _moved += Math.abs(pdx) + Math.abs(pdy);
      tf.cam.lx = cx; tf.cam.ly = cy;
      const s = tf.cam.radius * 0.002;
      tf.cam.target.x -= pdx * s; tf.cam.target.z -= pdy * s;
    }
  }, { passive: false });
  ['touchend', 'touchcancel'].forEach(ev => el.addEventListener(ev, e => {
    // tap (แตะสั้น ๆ แทบไม่ขยับ) → เลือกคอมโพเนนต์เหมือนคลิกซ้าย
    // (touch-action:none ปิด synthesized click ของเบราว์เซอร์ ต้องเลือกเอง)
    if (ev === 'touchend' && _tapFingers === 1 && _moved < 8) {
      const t = e.changedTouches && e.changedTouches[0];
      if (t && (_now() - _tapT) < 500) pickAt(t.clientX, t.clientY);
    }
    tf.cam.drag = false; _pinch = null; _moved = 0;
  }));
}
function tfCamUpdate() {
  const c = tf.camera; if (!c) return;
  const { theta, phi, radius, target } = tf.cam;
  const px = target.x + radius * Math.sin(phi) * Math.cos(theta);
  const py = target.y + radius * Math.cos(phi);
  const pz = target.z + radius * Math.sin(phi) * Math.sin(theta);
  // จัดตำแหน่งกล้องทั้งสองตัวให้ตรงกัน (สลับ projection ได้ seamless)
  if (tf.perspCam) { tf.perspCam.position.set(px, py, pz); tf.perspCam.lookAt(target.x, target.y, target.z); }
  if (tf.orthoCam) {
    tf.orthoCam.position.set(px, py, pz); tf.orthoCam.lookAt(target.x, target.y, target.z);
    const W = tf.container ? tf.container.offsetWidth : 800, H = tf.container ? tf.container.offsetHeight : 600;
    const aspect = W / H || 1;
    // ครอบฟรัสตัมอิงรัศมี (zoom) เทียบเท่า perspective fov 45° → isometric/orthographic
    const halfH = radius * Math.tan(THREE.MathUtils.degToRad(45) / 2);
    tf.orthoCam.left = -halfH * aspect; tf.orthoCam.right = halfH * aspect;
    tf.orthoCam.top = halfH; tf.orthoCam.bottom = -halfH;
    tf.orthoCam.updateProjectionMatrix();
  }
}

// ── frame label toggle ──
function tfToggleLabels() {
  tf.showLabels = !tf.showLabels;
  tfBuildScene();
  const btn = document.getElementById('tf-label-toggle');
  if (btn) btn.classList.toggle('off', !tf.showLabels);
}

// ── view presets (SolidWorks-style) ──
function tfAnimateCam(toTheta, toPhi, toRadius, toTarget) {
  const s = {
    theta: tf.cam.theta, phi: tf.cam.phi, radius: tf.cam.radius,
    tx: tf.cam.target.x, ty: tf.cam.target.y, tz: tf.cam.target.z,
  };
  const e = {
    theta: toTheta, phi: Math.max(0.02, Math.min(Math.PI - 0.02, toPhi)),
    radius: toRadius, tx: toTarget.x, ty: toTarget.y, tz: toTarget.z,
  };
  const dur = 420;
  let t0 = null;
  function step(now) {
    if (t0 === null) t0 = now;
    const t = Math.min(1, (now - t0) / dur);
    const k = 1 - Math.pow(1 - t, 3); // ease-out cubic
    tf.cam.theta = s.theta + (e.theta - s.theta) * k;
    tf.cam.phi = s.phi + (e.phi - s.phi) * k;
    tf.cam.radius = s.radius + (e.radius - s.radius) * k;
    tf.cam.target.x = s.tx + (e.tx - s.tx) * k;
    tf.cam.target.y = s.ty + (e.ty - s.ty) * k;
    tf.cam.target.z = s.tz + (e.tz - s.tz) * k;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function tfSetView(view) {
  const r = tf.cam.radius;
  const tgt = tf.cam.target;
  const presets = {
    top:     { theta: 0,            phi: 0.001 },
    bottom:  { theta: 0,            phi: Math.PI - 0.001 },
    front:   { theta: -Math.PI / 2, phi: Math.PI / 2 },  // ROS +X (forward) → Three -Z
    back:    { theta: Math.PI / 2,  phi: Math.PI / 2 },  // ROS -X (back)    → Three +Z
    left:    { theta: 0,            phi: Math.PI / 2 },  // ROS +Y (left)    → Three +X
    right:   { theta: Math.PI,      phi: Math.PI / 2 },  // ROS -Y (right)   → Three -X
    iso:     { theta: Math.PI / 4,  phi: Math.PI / 3 },
  };
  const p = presets[view] || presets.iso;
  tfAnimateCam(p.theta, p.phi, r, tgt);
  // update active button state
  document.querySelectorAll('.tf-view-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
}
function tfResetView() { tfSetView('iso'); }

// ── projection switch: Perspective ↔ Isometric (Orthographic) ──
function tfSetProjection(proj) {
  if (tf.proj === proj) return;
  tf.proj = proj;
  const cam = proj === 'iso' ? tf.orthoCam : tf.perspCam;
  tf.camera = cam;
  // สลับกล้องที่ gizmo อ้างอิง (r128 ใช้ this.camera โดยตรง)
  if (tf.transformControls) {
    try { tf.transformControls.camera = cam; } catch (e) {}
    const sel = tf.comps.find(x => x.id === tf.selected);
    if (sel && sel.group && tfCompVisible(sel)) { tf.transformControls.detach(); tf.transformControls.attach(sel.group); }
    else tf.transformControls.detach();
  }
  document.querySelectorAll('.tf-proj-btn').forEach(b => b.classList.toggle('active', b.dataset.proj === proj));
  tfCamUpdate();
  sbMsg(proj === 'iso' ? 'มุมมอง: Isometric (Orthographic)' : 'มุมมอง: Perspective');
}

// ── THREE → ROS inverse conversions ──
function tfT2RPos(p) { return { x: p.z, y: p.x, z: p.y }; }
function tfT2RRpy(q) {
  const rq = new THREE.Quaternion(q.z, q.x, q.y, q.w);
  const e = new THREE.Euler().setFromQuaternion(rq, 'XYZ');
  return { r: THREE.MathUtils.radToDeg(e.x), p: THREE.MathUtils.radToDeg(e.y), y: THREE.MathUtils.radToDeg(e.z) };
}
// bake a local group.scale back into the component's size params
function tfApplyScale(c, s) {
  const base = c._scaleBase || c.params;
  const eff = {};
  if ('sx' in base) {
    const m = tfGeoAxisMap[c.type] || { x: 'x', y: 'z', z: 'y' };
    eff.sx = +((base.sx) * s[m.x]).toFixed(4);
    eff.sy = +((base.sy) * s[m.y]).toFixed(4);
    eff.sz = +((base.sz) * s[m.z]).toFixed(4);
  } else {
    const f = (s.x + s.y + s.z) / 3;
    Object.keys(base).forEach(k => { if (typeof base[k] === 'number') eff[k] = +(base[k] * f).toFixed(4); });
  }
  return eff;
}
// live two-way sync: push current comp values into the right-panel inputs
function tfSyncPropInputs(c) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = (v === undefined || v === null) ? '' : v; };
  set('tf-p-x', c.pos.x); set('tf-p-y', c.pos.y); set('tf-p-z', c.pos.z);
  set('tf-p-r', c.rpy.r); set('tf-p-p', c.rpy.p); set('tf-p-yaw', c.rpy.y);
  const p = c.params;
  set('tf-p-sx', p.sx); set('tf-p-sy', p.sy); set('tf-p-sz', p.sz);
  set('tf-p-radius', p.radius); set('tf-p-width', p.width); set('tf-p-height', p.height);
  set('tf-p-w', p.w); set('tf-p-h', p.h); set('tf-p-d', p.d); set('tf-p-s', p.s);
}
// build the COMPONENTS add-grid with small 3D icons
function tfRenderAddGrid() {
  tfLoadCustom();
  const el = document.getElementById('tf-add-grid'); if (!el) return;
  const order = ['base', 'wheel', 'lidar', 'camera', 'imu', 'box', 'cylinder', 'encoder', 'omni'];
  const labels = { base: 'Chassis', wheel: 'Wheel', lidar: 'Lidar', camera: 'Camera', imu: 'IMU', box: 'Box', cylinder: 'Cylinder', encoder: 'Encoder', omni: 'Omni' };
  let html = order.map(t =>
    `<button class="tf-comp-btn" onclick="tfAddComp('${t}')"><span class="tf-comp-ico">${tfIcons[t]}</span><span>+ ${labels[t]}</span></button>`
  ).join('');
  html += `<button class="tf-comp-btn tf-comp-special" onclick="tfAddWheelSet(4)"><span class="tf-comp-ico">${tfIcons.wheel}</span><span>+ 4 Wheels</span></button>`;
  html += `<button class="tf-comp-btn tf-comp-special" onclick="tfAddEncoderOmni()"><span class="tf-comp-ico">${tfIcons.encoder}</span><span>+ Encoder + Omni</span></button>`;
  html += `<div class="tf-add-sep"></div>`;
  html += `<button class="tf-comp-btn tf-comp-create" onclick="tfOpenCustom()"><span class="tf-comp-ico">➕</span><span>+ สร้าง Component</span></button>`;
  html += `<button class="tf-comp-btn tf-comp-create" onclick="tfOpenCadImport()"><span class="tf-comp-ico">⤓</span><span>+ Import CAD</span></button>`;
  const uc = tf.userComps || [];
  if (uc.length) {
    html += `<div class="tf-add-hd">★ Custom (${escH(tfCurrentUser())})</div>`;
    html += uc.map(d => `<button class="tf-comp-btn" onclick="tfAddCustomComp(decodeURIComponent('${encArg(d.id)}'))" title="เพิ่ม ${escH(d.name)} (offset ${d.offset.pos.x},${d.offset.pos.y},${d.offset.pos.z})">
      <span class="tf-comp-ico" style="color:#${('000000' + d.color.toString(16)).slice(-6)}">◆</span><span>${escH(d.name)}</span></button>`).join('');
  }
  el.innerHTML = html;
}

// ══ Custom Components (สร้างโมเดลเอง + เก็บเป็น library ของ user) ══
function tfCurrentUser() {
  try { const u = localStorage.getItem('ros2ide_username'); if (u) return u; } catch (e) {}
  return (typeof sessionId !== 'undefined' && sessionId) ? sessionId : 'default';
}
function tfCustomKey() { return 'tf_custom_' + tfCurrentUser(); }
function tfLoadCustom() {
  try { tf.userComps = JSON.parse(localStorage.getItem(tfCustomKey())) || []; } catch (e) { tf.userComps = []; }
  if (!Array.isArray(tf.userComps)) tf.userComps = [];
}
function tfSaveCustomComps() {
  try { localStorage.setItem(tfCustomKey(), JSON.stringify(tf.userComps || [])); } catch (e) {}
}
let tfPrev = null;
function tfInitCustomPreview() {
  const cv = document.getElementById('tf-c-prev'); if (!cv || !window.THREE) return;
  if (tfPrev && tfPrev.renderer) return; // สร้างครั้งเดียว
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setSize(220, 220, false);
  r.setClearColor(0x1b2030, 1);
  const sc = new THREE.Scene();
  sc.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(2, 4, 3); sc.add(dl);
  sc.add(new THREE.GridHelper(2, 8, 0x394150, 0x262d3a));
  const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  tfPrev = { renderer: r, scene: sc, camera: cam };
}
function tfRenderCustomPreview() {
  tfInitCustomPreview(); if (!tfPrev) return;
  const def = tfReadCustomForm(false); if (!def) return;
  if (tfPrev.mesh) tfPrev.scene.remove(tfPrev.mesh);
  tfPrev.mesh = tfBuildShapeObject(def.shape, def.params, def.color);
  tfPrev.scene.add(tfPrev.mesh);
  const box = new THREE.Box3().setFromObject(tfPrev.mesh);
  const ctr = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3()).length() || 1;
  tfPrev.mesh.position.sub(ctr); // ศูนย์กลางที่ origin
  const d = Math.max(0.3, sz);
  tfPrev.camera.position.set(d * 1.1, d * 0.9, d * 1.5);
  tfPrev.camera.lookAt(0, 0, 0);
  tfPrev.camera.near = 0.01; tfPrev.camera.far = 100; tfPrev.camera.updateProjectionMatrix();
  tfPrev.renderer.render(tfPrev.scene, tfPrev.camera);
}
function tfRenderCustomDims() {
  const shape = document.getElementById('tf-c-shape').value;
  const el = document.getElementById('tf-c-dims');
  const row = (id, lab, val) => `<div><label>${lab}</label><input id="${id}" type="number" step="0.01" value="${val}"></div>`;
  let h = '<div class="tf-sec">ขนาด (m)</div><div class="tf-grid3">';
  if (shape === 'box') h += row('tf-c-sx', 'X', 0.2) + row('tf-c-sy', 'Y', 0.2) + row('tf-c-sz', 'Z', 0.2);
  else if (shape === 'cylinder' || shape === 'lidar' || shape === 'cone') h += row('tf-c-radius', 'รัศมี', 0.05) + row('tf-c-height', 'สูง', 0.08);
  else if (shape === 'camera') h += row('tf-c-w', 'W', 0.06) + row('tf-c-h', 'H', 0.04) + row('tf-c-d', 'D', 0.04);
  else if (shape === 'sphere') h += row('tf-c-radius', 'รัศมี', 0.05);
  h += '</div>';
  el.innerHTML = h;
  tfRenderCustomPreview();
}
function tfReadCustomForm(forSave) {
  const shape = document.getElementById('tf-c-shape').value;
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  let params = {};
  if (shape === 'box') params = { sx: num('tf-c-sx'), sy: num('tf-c-sy'), sz: num('tf-c-sz') };
  else if (shape === 'cylinder' || shape === 'lidar' || shape === 'cone') params = { radius: Math.max(0.01, num('tf-c-radius')), height: Math.max(0.01, num('tf-c-height')) };
  else if (shape === 'camera') params = { w: num('tf-c-w'), h: num('tf-c-h'), d: num('tf-c-d') };
  else if (shape === 'sphere') params = { radius: Math.max(0.01, num('tf-c-radius')) };
  const color = parseInt((document.getElementById('tf-c-color').value || '#4f8ef7').replace('#', ''), 16) || 0x4f8ef7;
  const def = {
    shape, params, color,
    offset: { pos: { x: num('tf-c-ox'), y: num('tf-c-oy'), z: num('tf-c-oz') }, rpy: { r: num('tf-c-or'), p: num('tf-c-op'), y: num('tf-c-oyaw') } },
  };
  if (forSave) {
    const name = (document.getElementById('tf-c-name').value || '').trim();
    if (!name) return null;
    def.name = name;
    def.id = 'uc_' + Date.now().toString(36);
  }
  return def;
}
function tfOpenCustom() {
  const nm = document.getElementById('tf-c-name'); if (nm) nm.value = '';
  const sh = document.getElementById('tf-c-shape'); if (sh) sh.value = 'lidar';
  const col = document.getElementById('tf-c-color'); if (col) col.value = '#4f8ef7';
  ['tf-c-ox', 'tf-c-oy', 'tf-c-oz', 'tf-c-or', 'tf-c-op', 'tf-c-oyaw'].forEach(id => { const e = document.getElementById(id); if (e) e.value = 0; });
  tfRenderCustomDims();
  if (sh) sh.onchange = tfRenderCustomDims;
  const dims = document.getElementById('tf-c-dims'); if (dims) dims.oninput = tfRenderCustomPreview;
  if (col) col.oninput = tfRenderCustomPreview;
  document.getElementById('tf-custom-modal').style.display = 'flex';
}
function tfCloseCustom() {
  const m = document.getElementById('tf-custom-modal'); if (m) m.style.display = 'none';
}
function tfSaveCustom() {
  const def = tfReadCustomForm(true);
  if (!def) { sbMsg('กรุณาใส่ชื่อ component'); return; }
  if (!tf.userComps) tf.userComps = [];
  tf.userComps.push(def);
  tfSaveCustomComps();
  tfRenderAddGrid();
  tfCloseCustom();
  sbMsg('บันทึก component "' + def.name + '" แล้ว (ไปที่กลุ่ม Custom)');
}
function tfAddCustomComp(defId) {
  const def = (tf.userComps || []).find(x => x.id === defId);
  if (!def) return;
  const base = tf.comps.find(x => x.type === 'base');
  const c = {
    id: 'c' + (tf._nid++), type: 'custom', customId: def.id, name: def.name,
    parent: base ? base.name : null,
    pos: Object.assign({}, def.offset.pos), rpy: Object.assign({}, def.offset.rpy),
    params: JSON.parse(JSON.stringify(def.params)),
    group: null, _mat: null, viewGroup: '',
  };
  tf.comps.push(c);
  tfAfterChange();
  tfSelect(c.id);
}

// ══════════════════════════════════════════════════════════════
//  IMPORT CAD (.stl / .obj) → Custom Library
//  parser เขียนเองแบบ inline (ไม่พึ่ง STLLoader/OBJLoader ภายนอก)
// ══════════════════════════════════════════════════════════════
// ── STL parser: รองรับทั้ง ASCII และ Binary ──
function tfParseSTL(buf) {
  const dv = new DataView(buf);
  // ตรวจ binary: header 80B + uint32 count → ขนาดไฟล์ควร = 84 + count*50
  const nTri = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const isBinary = buf.byteLength === 84 + nTri * 50 && nTri > 0;
  if (isBinary) {
    const pos = new Float32Array(nTri * 9), nor = new Float32Array(nTri * 9);
    let off = 84;
    for (let i = 0; i < nTri; i++) {
      const nx = dv.getFloat32(off, true), ny = dv.getFloat32(off + 4, true), nz = dv.getFloat32(off + 8, true);
      off += 12;
      for (let v = 0; v < 3; v++) {
        const k = i * 9 + v * 3;
        pos[k] = dv.getFloat32(off, true); pos[k + 1] = dv.getFloat32(off + 4, true); pos[k + 2] = dv.getFloat32(off + 8, true);
        nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
        off += 12;
      }
      off += 2; // attribute byte count
    }
    return { pos: Array.from(pos), nor: Array.from(nor) };
  }
  // ASCII
  const txt = new TextDecoder().decode(buf);
  const pos = [], nor = [];
  const re = /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)[\s\S]*?outer\s+loop([\s\S]*?)endloop/gi;
  let m;
  while ((m = re.exec(txt))) {
    const nx = +m[1] || 0, ny = +m[2] || 0, nz = +m[3] || 0;
    const vre = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
    let vm, vc = 0;
    while ((vm = vre.exec(m[4])) && vc < 3) {
      pos.push(+vm[1] || 0, +vm[2] || 0, +vm[3] || 0);
      nor.push(nx, ny, nz);
      vc++;
    }
  }
  return { pos, nor };
}
// ── MTL parser: newmtl / Kd(diffuse RGB) / d / Tr(opacity) ──
// คืนค่า map { materialName: { color: hex, opacity } }  (สีอ่านจาก Kd)
function tfParseMTL(text) {
  const mats = {};
  let cur = null;
  const toHex = (r, g, b) => {
    const c = v => Math.max(0, Math.min(255, Math.round((+v || 0) * 255)));
    return (c(r) << 16) | (c(g) << 8) | c(b);
  };
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const a = t.split(/\s+/);
    if (a[0] === 'newmtl') {
      cur = a[1] || ('mat' + Object.keys(mats).length);
      mats[cur] = { color: 0x8aa0b5, opacity: 1 };
    } else if (cur && (a[0] === 'Kd' || a[0] === 'kd')) {
      if (a.length >= 4) mats[cur].color = toHex(a[1], a[2], a[3]);
    } else if (cur && (a[0] === 'd' || a[0] === 'Tr')) {
      if (a.length >= 2) mats[cur].opacity = Math.max(0, Math.min(1, +a[1] || 1));
    } else if (cur && (a[0] === 'map_Kd' || a[0] === 'map_kd')) {
      if (a.length >= 2) mats[cur].map = a[1]; // ชื่อไฟล์ texture (สีจริงมักอยู่ที่นี่ ไม่ใช่ Kd)
    }
  }
  return mats;
}
// ── OBJ parser: v / vn / f + usemtl groups + mtllib ──
// คืนค่า { pos, nor, groups:[{mat,start,count}], mtllib }
//   groups เก็บช่วง vertex (start/count) ตามวัสดุ → เอาไปทำ multi-material + ดึงสีจาก MTL
function tfParseOBJ(text) {
  const V = [], VN = [], pos = [], nor = [];
  const groups = [];        // { mat, start(vertex), count(vertex) }
  let curMat = '__default__';
  let curCount = 0, vCursor = 0;
  const flush = () => {
    if (curCount > 0) { groups.push({ mat: curMat, start: vCursor - curCount, count: curCount }); curCount = 0; }
  };
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('v ')) { const a = t.split(/\s+/); V.push([+a[1] || 0, +a[2] || 0, +a[3] || 0]); }
    else if (t.startsWith('vn ')) { const a = t.split(/\s+/); VN.push([+a[1] || 0, +a[2] || 0, +a[3] || 0]); }
    else if (t.startsWith('usemtl')) { flush(); curMat = t.split(/\s+/)[1] || '__default__'; }
    else if (t.startsWith('f ')) {
      const a = t.split(/\s+/).slice(1);
      const idx = a.map(tok => {
        const p = tok.split('/');
        let vi = parseInt(p[0], 10); let ni = p[2] ? parseInt(p[2], 10) : NaN;
        if (vi < 0) vi = V.length + vi + 1;
        if (ni < 0) ni = VN.length + ni + 1;
        return { v: vi - 1, n: isNaN(ni) ? -1 : ni - 1 };
      });
      for (let i = 1; i + 1 < idx.length; i++) { // fan triangulation
        [idx[0], idx[i], idx[i + 1]].forEach(o => {
          const vv = V[o.v] || [0, 0, 0]; pos.push(vv[0], vv[1], vv[2]);
          const nn = (o.n >= 0 && VN[o.n]) ? VN[o.n] : null;
          nor.push(nn ? nn[0] : 0, nn ? nn[1] : 0, nn ? nn[2] : 0);
        });
        curCount += 3; vCursor += 3;
      }
    }
  }
  flush();
  const m = text.match(/mtllib\s+([^\r\n\s]+)/i);
  return { pos, nor: nor.length === pos.length ? nor : [], groups, mtllib: m ? m[1] : null };
}
// ── ZIP reader (เขียนเอง ไม่พึ่ง library) ──
// รองรับ stored(method 0) + deflate(method 8 ผ่าน DecompressionStream)
// คืนค่า { 'path/in/zip': { method, data: ArrayBuffer } }
async function tfInflateRaw(slice) {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('เบราว์เซอร์ไม่รองรับการแตก zip (ไม่มี DecompressionStream) — ลองแตก zip แล้วเลือก .obj โดยตรง');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([slice]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}
// ช่วยโหลด texture (map_Kd) จากภายใน zip → dataURL (เก็บลง localStorage ได้)
function tfMimeFromName(n) {
  const e = n.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp' })[e] || 'image/png';
}
async function tfBufToDataURL(buf, mime) {
  return await new Promise((res, rej) => {
    const blob = new Blob([buf], { type: mime || 'image/png' });
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('read error'));
    r.readAsDataURL(blob);
  });
}
async function tfReadZip(buf) {
  const dv = new DataView(buf);
  // หา End-Of-Central-Directory (signature 0x06054b50) จากท้ายไฟล์
  let eocd = -1;
  const minPos = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ไม่พบ End-Of-Central-Directory — ไม่ใช่ไฟล์ .zip ที่ถูกต้อง');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // offset ของ central directory
  const entries = {}; // name -> { method, compSize, dataOff }
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // central dir signature
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    let name = '';
    for (let k = 0; k < nameLen; k++) name += String.fromCharCode(dv.getUint8(p + 46 + k));
    const dataOff = dv.getUint32(p + 42, true); // offset ของ local header
    entries[name] = { method, compSize, dataOff };
    p += 46 + nameLen + extraLen + commLen;
  }
  // อ่าน local header + data ทีละไฟล์
  const out = {};
  for (const name in entries) {
    const e = entries[name];
    const lNameLen = dv.getUint16(e.dataOff + 26, true);
    const lExtraLen = dv.getUint16(e.dataOff + 28, true);
    const start = e.dataOff + 30 + lNameLen + lExtraLen;
    const slice = buf.slice(start, start + e.compSize);
    let data;
    if (e.method === 0) data = slice;                                 // stored
    else if (e.method === 8) data = await tfInflateRaw(slice);        // deflate
    else throw new Error('zip ใช้การบีบอัดที่ไม่รองรับ (method ' + e.method + ')');
    out[name] = { method: e.method, data };
  }
  return out;
}
// ── ปรับสเกล + ศูนย์กลางที่ origin. auto-detect mm→m (ถ้าใหญ่เกิน 2 → หาร 1000) ──
function tfCadNormalize(mesh, userScale) {
  const pos = mesh.pos;
  if (!pos.length) return { mesh, scale: 1, size: [0, 0, 0] };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
    minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
  }
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const maxDim = Math.max(dx, dy, dz);
  let scale = userScale || 0;
  if (!scale) scale = maxDim > 2 ? 0.001 : 1; // auto: หน่วย mm → m
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const out = new Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = (pos[i] - cx) * scale;
    out[i + 1] = (pos[i + 1] - cy) * scale;
    out[i + 2] = (pos[i + 2] - cz) * scale;
  }
  return { mesh: { pos: out, nor: mesh.nor || [], groups: mesh.groups || [] }, scale, size: [dx * scale, dy * scale, dz * scale] };
}
// state ของ modal import
let tfCadPending = null; // { mesh, size }
let tfCadPrev = null;
function tfOpenCadImport() {
  const modal = document.getElementById('tf-cad-modal'); if (!modal) return;
  tfCadPending = null;
  const nm = document.getElementById('tf-cad-name'); if (nm) nm.value = '';
  const col = document.getElementById('tf-cad-color'); if (col) col.value = '#8aa0b5';
  const sc = document.getElementById('tf-cad-scale'); if (sc) sc.value = '';
  const fi = document.getElementById('tf-cad-file'); if (fi) fi.value = '';
  const info = document.getElementById('tf-cad-info'); if (info) info.textContent = 'ยังไม่ได้เลือกไฟล์';
  modal.style.display = 'flex';
  tfCadInitPreview();
  if (fi) fi.onchange = tfCadOnFile;
  if (sc) sc.oninput = () => { if (tfCadPending) tfCadReprocess(); };
  if (col) col.oninput = tfCadRenderPreview;
}
function tfCloseCadImport() {
  const m = document.getElementById('tf-cad-modal'); if (m) m.style.display = 'none';
  tfCadPending = null;
}
function tfCadInitPreview() {
  const cv = document.getElementById('tf-cad-prev'); if (!cv || !window.THREE) return;
  if (tfCadPrev && tfCadPrev.renderer) return;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setSize(220, 220, false); r.setClearColor(0x1b2030, 1);
  const sc = new THREE.Scene();
  sc.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(2, 4, 3); sc.add(dl);
  sc.add(new THREE.GridHelper(2, 8, 0x394150, 0x262d3a));
  const cam = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
  tfCadPrev = { renderer: r, scene: sc, camera: cam, mesh: null };
}
async function tfCadOnFile(e) {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  const info = document.getElementById('tf-cad-info');
  const name = file.name.toLowerCase();
  try {
    let raw = null, chosenName = file.name, matCount = 0;
    if (name.endsWith('.zip')) {
      // แตก zip → หา .obj (อันที่มี vertex เยอะสุด = โมเดลหลัก) + .mtl
      const entries = await tfReadZip(await file.arrayBuffer());
      let objName = null, bestCount = -1;
      const objTexts = {};
      for (const fn in entries) {
        if (fn.toLowerCase().endsWith('.obj')) {
          const txt = new TextDecoder().decode(entries[fn].data);
          const o = tfParseOBJ(txt);
          objTexts[fn] = o;
          const vc = o.pos.length / 3;
          if (vc > bestCount) { bestCount = vc; objName = fn; }
        }
      }
      if (!objName) { if (info) info.textContent = '❌ ไม่พบไฟล์ .obj ภายใน zip'; return; }
      const obj = objTexts[objName];
      // เลือกไฟล์ .mtl: อิงจาก mtllib ใน obj ก่อน ไม่ได้ก็หา .mtl ใด ๆ
      let mtlName = null;
      if (obj.mtllib) {
        const want = obj.mtllib.toLowerCase().split('/').pop();
        for (const fn in entries) if (fn.toLowerCase().split('/').pop() === want) { mtlName = fn; break; }
      }
      if (!mtlName) for (const fn in entries) if (fn.toLowerCase().endsWith('.mtl')) { mtlName = fn; break; }
      const mtl = mtlName ? tfParseMTL(new TextDecoder().decode(entries[mtlName].data)) : {};
      // รวบรวมไฟล์รูปใน zip (สำหรับ map_Kd) — คั่นด้วย basename
      const texCache = {};
      for (const fn in entries) if (/\.(png|jpe?g|bmp|gif|webp)$/i.test(fn)) texCache[fn.toLowerCase().split('/').pop()] = entries[fn];
      // จับคู่ชื่อวัสดุแบบไม่สนตัวพิมพ์/วรรค (usemtl ↔ newmtl มัก不符กัน)
      const mtlNorm = {};
      for (const k in mtl) mtlNorm[k.toLowerCase().trim()] = mtl[k];
      const lookup = n => mtlNorm[(n || '').toLowerCase().trim()];
      let groups = obj.groups.map(g => {
        const m = lookup(g.mat);
        return { color: m ? m.color : 0x8aa0b5, start: g.start, count: g.count, _found: !!m, _map: m ? m.map : null };
      });
      // fallback: OBJ ไม่มี usemtl แต่ MTL มีวัสดุเดียว → ใช้สี/texture นี้ทั้งโมเดล
      if (!groups.some(g => g._found) && Object.keys(mtl).length === 1) {
        const only = Object.values(mtl)[0];
        groups.forEach(g => { g.color = only.color; g._found = true; g._map = only.map || null; });
      }
      // โหลด texture (map_Kd) จากใน zip → dataURL
      let texCount = 0;
      await Promise.all(groups.map(async g => {
        if (g._map) {
          const key = g._map.toLowerCase().split('/').pop();
          const entry = texCache[key];
          if (entry) { try { g.map = await tfBufToDataURL(entry.data, tfMimeFromName(key)); texCount++; } catch (e) {} }
        }
        delete g._found; delete g._map;
      }));
      // สีที่ใช้ได้จริง = มี texture หรือสีไม่ดำสนิท
      const usable = groups.filter(g => g.map || (g.color != null && g.color !== 0));
      if (usable.length === 0) {
        // ดึงสีไม่ได้เลย (MTL ดำ/ไม่มีสี) → ใช้สีเดียวจากช่อง picker (ผู้ใช้เลือก/เปลี่ยนสีได้ ไม่ดำ)
        raw = { pos: obj.pos, nor: obj.nor };
        matCount = 0;
      } else {
        // กลุ่มที่ดำสนิทและไม่มี texture → fallback สีที่มองเห็นได้ (กันดำ)
        groups.forEach(g => { if (!g.map && (g.color == null || g.color === 0)) g.color = 0x8aa0b5; });
        raw = { pos: obj.pos, nor: obj.nor, groups };
        matCount = new Set(groups.map(g => g.color)).size;
        if (texCount > 0) raw.texCount = texCount;
      }
      if (typeof console !== 'undefined') console.log('[TF import] MTL materials:', Object.keys(mtl), '→ resolved colors:', groups.map(g => (g.color != null ? g.color.toString(16) : '?') + (g.map ? '+tex' : '')));
      chosenName = objName.replace(/\.obj$/i, '') + (mtlName ? ' (+mtl)' : '');
      tfCadPending = { raw, fileName: file.name, matCount, texCount: raw.texCount || 0 };
    } else if (name.endsWith('.stl')) {
      raw = tfParseSTL(await file.arrayBuffer());
      tfCadPending = { raw, fileName: file.name, matCount: 0 };
    } else if (name.endsWith('.obj')) {
      const obj = tfParseOBJ(await file.text());   // .obj เดี่ยว ไม่มี mtl → ใช้สีเดียวจาก picker
      raw = { pos: obj.pos, nor: obj.nor };
      tfCadPending = { raw, fileName: file.name, matCount: 0 };
    } else {
      if (info) info.textContent = '❌ รองรับเฉพาะ .stl / .obj / .zip (obj+mtl)';
      return;
    }
    if (!raw.pos.length) { if (info) info.textContent = '❌ อ่าน mesh ไม่ได้ (ไฟล์ว่างหรือรูปแบบไม่ถูกต้อง)'; return; }
    // เดาชื่อจากไฟล์
    const nm = document.getElementById('tf-cad-name');
    if (nm && !nm.value.trim()) nm.value = chosenName.replace(/\.(stl|obj)$/i, '');
    tfCadReprocess();
  } catch (err) {
    if (info) info.textContent = '❌ ' + (err.message || 'parse error');
  }
}
function tfCadReprocess() {
  if (!tfCadPending) return;
  const scEl = document.getElementById('tf-cad-scale');
  const userScale = scEl && scEl.value.trim() ? (parseFloat(scEl.value) || 0) : 0;
  const norm = tfCadNormalize(tfCadPending.raw, userScale);
  tfCadPending.mesh = norm.mesh;
  tfCadPending.size = norm.size;
  tfCadPending.appliedScale = norm.scale;
  const info = document.getElementById('tf-cad-info');
  const nTri = (norm.mesh.pos.length / 9) | 0;
  const matNote = (tfCadPending.matCount > 0) ? ` · 🎨 ${tfCadPending.matCount} สี (จาก MTL)` : '';
  const texNote = (tfCadPending.texCount > 0) ? ` · 🖼️ ${tfCadPending.texCount} texture` : '';
  if (info) info.textContent = `✅ ${nTri.toLocaleString()} tri · ขนาด ${norm.size.map(v => (v * 100).toFixed(1)).join('×')} cm · scale×${norm.scale}${matNote}${texNote}`;
  tfCadRenderPreview();
}
function tfCadRenderPreview() {
  tfCadInitPreview(); if (!tfCadPrev || !tfCadPending || !tfCadPending.mesh) return;
  if (tfCadPrev.mesh) tfCadPrev.scene.remove(tfCadPrev.mesh);
  const color = parseInt((document.getElementById('tf-cad-color').value || '#8aa0b5').replace('#', ''), 16) || 0x8aa0b5;
  tfCadPrev.mesh = tfBuildCadMesh({ mesh: tfCadPending.mesh, id: 'prev' }, color);
  tfCadPrev.scene.add(tfCadPrev.mesh);
  const box = new THREE.Box3().setFromObject(tfCadPrev.mesh);
  const sz = box.getSize(new THREE.Vector3()).length() || 0.3;
  const d = Math.max(0.15, sz);
  tfCadPrev.camera.position.set(d * 1.1, d * 0.9, d * 1.5);
  tfCadPrev.camera.lookAt(0, 0, 0);
  tfCadPrev.camera.near = 0.001; tfCadPrev.camera.far = 100; tfCadPrev.camera.updateProjectionMatrix();
  tfCadPrev.renderer.render(tfCadPrev.scene, tfCadPrev.camera);
}
function tfSaveCad() {
  if (!tfCadPending || !tfCadPending.mesh) { sbMsg('กรุณาเลือกไฟล์ .stl/.obj ก่อน'); return; }
  const name = (document.getElementById('tf-cad-name').value || '').trim();
  if (!name) { sbMsg('กรุณาใส่ชื่อ component'); return; }
  const color = parseInt((document.getElementById('tf-cad-color').value || '#8aa0b5').replace('#', ''), 16) || 0x8aa0b5;
  const def = {
    id: 'uc_' + Date.now().toString(36),
    name, shape: 'cad', color,
    mesh: { pos: tfCadPending.mesh.pos, nor: tfCadPending.mesh.nor || [], groups: tfCadPending.mesh.groups || [] },
    bbox: tfCadPending.size,
    params: {},
    offset: { pos: { x: 0, y: 0, z: 0 }, rpy: { r: 0, p: 0, y: 0 } },
  };
  if (!tf.userComps) tf.userComps = [];
  tf.userComps.push(def);
  try {
    tfSaveCustomComps();
  } catch (err) {
    // localStorage เต็ม (มักจาก texture ใหญ่) → ลองตัด texture ออกแล้วเซฟใหม่
    try {
      def.mesh.groups.forEach(g => { delete g.map; });
      tfSaveCustomComps();
      tfRenderAddGrid();
      tfCloseCadImport();
      sbMsg('⚠️ เซฟได้แต่ตัดรูป texture (สีอาจเพี้ยน) — mesh ใหญ่เกิน quota localStorage');
      return;
    } catch (e2) {}
    tf.userComps.pop();
    sbMsg('❌ mesh ใหญ่เกินไป เก็บไม่ได้ (localStorage เต็ม) — ลองไฟล์ที่เล็กลง');
    return;
  }
  tfRenderAddGrid();
  tfCloseCadImport();
  sbMsg('บันทึก CAD "' + name + '" แล้ว (ไปที่กลุ่ม Custom)');
}

// ── transform gizmo (Three.js TransformControls) ──
function tfSetupGizmo() {
  if (typeof THREE.TransformControls !== 'function') return false;
  const tc = new THREE.TransformControls(tf.camera, tf.renderer.domElement);
  tc.setSpace('local');
  tc.setMode('translate');
  tc.setSize(0.85);
  // RViz axis colors: X=Red, Y=Blue, Z=Green
  // (r128 TransformControls has no public color props → recolor materials by default color)
  tc.traverse(o => {
    if (o.material && o.material.color) {
      const hex = o.material.color.getHex();
      if (hex === 0xff0000) o.material.color.setHex(0x44ff66);      // X = red 0x4488ff
      else if (hex === 0x00ff00) o.material.color.setHex(0x4488ff); // Z = green (swap) 
      else if (hex === 0x0000ff) o.material.color.setHex(0xff4444); // Y = blue (swap) 0xff4444
    }
  });
  tc.addEventListener('dragging-changed', e => {
    tf.gizmoDragging = e.value;
    if (e.value) {
      tf.cam.drag = false; // hand the pointer to the gizmo
      if (tc.mode === 'scale') {
        const c = tf.comps.find(x => x.id === tf.selected);
        if (c) c._scaleBase = JSON.parse(JSON.stringify(c.params)); // remember size-at-drag-start
      }
    } else {
      // bake scale / keep transform IN PLACE — keep the gizmo attached to the same group (no rebuild churn)
      const c = tf.comps.find(x => x.id === tf.selected);
      if (c && c.group && tc.mode === 'scale') c.group.scale.set(1, 1, 1); // size already baked into params
      if (c) tfSyncGroup(c);
      tfSave();
    }
  });
  tc.addEventListener('objectChange', () => {
    const c = tf.comps.find(x => x.id === tf.selected); if (!c || !c.group) return;
    if (tc.mode === 'translate') {
      const ros = tfT2RPos(c.group.position);
      c.pos.x = +ros.x.toFixed(3); c.pos.y = +ros.y.toFixed(3); c.pos.z = +ros.z.toFixed(3);
    } else if (tc.mode === 'rotate') {
      const rpy = tfT2RRpy(c.group.quaternion);
      c.rpy.r = +rpy.r.toFixed(1); c.rpy.p = +rpy.p.toFixed(1); c.rpy.y = +rpy.y.toFixed(1);
    } else if (tc.mode === 'scale') {
      c.params = tfApplyScale(c, c.group.scale);
    }
    tfSyncPropInputs(c); // real-time → right panel
  });
  tf.scene.add(tc);
  tf.transformControls = tc;
  return true;
}
function tfSetupGizmoUI() {
  if (tf._uiBound) return; tf._uiBound = true;
  const bar = document.getElementById('tf-gizmo-bar'); if (!bar) return;
  bar.querySelectorAll('button[data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      if (!tf.transformControls) return;
      tf.transformControls.setMode(b.dataset.mode);
      bar.querySelectorAll('button[data-mode]').forEach(x => x.classList.toggle('active', x === b));
    });
  });
  const snap = document.getElementById('tf-snap-btn');
  if (snap) snap.addEventListener('click', () => {
    if (!tf.transformControls) return;
    tf.snap = !tf.snap;
    const v = 0.1;
    tf.transformControls.setTranslationSnap(tf.snap ? v : null);
    tf.transformControls.setRotationSnap(tf.snap ? THREE.MathUtils.degToRad(15) : null);
    tf.transformControls.setScaleSnap(tf.snap ? v : null);
    snap.classList.toggle('on', tf.snap);
  });
  window.addEventListener('keydown', e => {
    const a = document.activeElement;
    if (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
    if (!tf.transformControls) return;
    let mode = null;
    if (e.key === 'w' || e.key === 'W') mode = 'translate';
    else if (e.key === 'e' || e.key === 'E') mode = 'rotate';
    else if (e.key === 'r' || e.key === 'R') mode = 'scale';
    if (!mode) return;
    e.preventDefault();
    tf.transformControls.setMode(mode);
    const m = document.querySelector(`#tf-gizmo-bar button[data-mode="${mode}"]`);
    if (m) document.querySelectorAll('#tf-gizmo-bar button[data-mode]').forEach(x => x.classList.toggle('active', x === m));
  });
}

// ── init ──
async function tfInitThree() {
  const c = document.getElementById('tf-3d-container'); if (!c) return;
  tf.container = c;
  tf.renderer = new THREE.WebGLRenderer({ antialias: true });
  tf.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  tf.renderer.setClearColor(0x161a22, 1);
  tf.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;cursor:grab;touch-action:none;';
  c.appendChild(tf.renderer.domElement);
  tf.scene = new THREE.Scene();
  const W = c.offsetWidth || 800, H = c.offsetHeight || 600;
  tf.perspCam = new THREE.PerspectiveCamera(45, W / H, 0.01, 2000);
  tf.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  tf.camera = tf.perspCam;
  tf.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(3, 8, 5); tf.scene.add(dl);
  tf.scene.add(new THREE.GridHelper(10, 20, 0x394150, 0x262d3a));
  tf.scene.add(tfMakeAxes(0.4));
  tf.ray = new THREE.Raycaster();
  tfBindCam(tf.renderer.domElement);
  tfSetupGizmo();
  tfSetupGizmoUI();
  tfRenderAddGrid();
  new ResizeObserver(tfResize).observe(c);
  // โหลดสถานะ workspace ที่เซฟไว้ (models + TFs) หากมี
  // ถ้าไม่มีจึงสร้างโมเดลว่าง (base) ใหม่
  await tfLoadWorkspace();
  if (!tf.comps.length) {
    const b = tfCreateComp('base');
    tf.comps.push(b);
    tfAfterChange();
    tfSelect(b.id);
  } else {
    tfAfterChange();
    tfSelect(tf.comps[0].id);
  }
  (function loop() {
    requestAnimationFrame(loop);
    tfCamUpdate();
    if (tf.selBox) tf.selBox.update();
    tf.renderer.render(tf.scene, tf.camera);
  })();
  tf.ready = true;
}
function initTransformation() {
  if (tf.renderer) {
    tfBuildScene(); tfRenderTree(); tfRenderProps(); tfRenderGroups(); tfResize();
    tfRenderAddGrid(); tfSetupGizmoUI();
    return;
  }
  if (typeof THREE !== 'undefined') { loadTransformControls(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  s.onload = loadTransformControls;
  s.onerror = () => sbMsg('ไม่สามารถโหลด Three.js ได้ (ต้องมีอินเทอร์เน็ต)');
  document.head.appendChild(s);
}
// load TransformControls (gizmo) from the matching r128 examples build, then boot
function loadTransformControls() {
  if (typeof THREE !== 'undefined' && typeof THREE.TransformControls === 'function') { tfInitThree(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js';
  s.onload = () => { if (typeof THREE !== 'undefined' && typeof THREE.TransformControls === 'function') tfInitThree(); else { sbMsg('ไม่สามารถโหลด Gizmo ได้ — ใช้งานแบบไม่มี Gizmo'); tfInitThree(); } };
  s.onerror = () => { sbMsg('ไม่สามารถโหลด Gizmo (TransformControls) ได้ — ใช้งานแบบไม่มี Gizmo'); tfInitThree(); };
  document.head.appendChild(s);
}
function tfResize() {
  if (!tf.renderer || !tf.container) return;
  const W = tf.container.offsetWidth || 800, H = tf.container.offsetHeight || 600;
  tf.renderer.setSize(W, H, false);
  if (tf.perspCam) { tf.perspCam.aspect = W / H; tf.perspCam.updateProjectionMatrix(); }
  if (tf.orthoCam) {
    const halfH = tf.cam.radius * Math.tan(THREE.MathUtils.degToRad(45) / 2);
    tf.orthoCam.left = -halfH * (W / H); tf.orthoCam.right = halfH * (W / H);
    tf.orthoCam.top = halfH; tf.orthoCam.bottom = -halfH;
    tf.orthoCam.updateProjectionMatrix();
  }
}

// ── left panel: component list + TF tree ──
function tfRenderTree() {
  const el = document.getElementById('tf-tree'); if (!el) return;
  // สร้าง adjacency เพื่อหาความลึก
  const byName = {}; tf.comps.forEach(c => byName[c.name] = c);
  function depth(c, seen) { if (!c.parent || !byName[c.parent] || seen.has(c.name)) return 0; seen.add(c.name); return 1 + depth(byName[c.parent], seen); }
  const rows = tf.comps.map(c => {
    const d = depth(c, new Set());
    const sel = c.id === tf.selected ? ' style="background:rgba(79,142,247,.15);color:#fff"' : '';
    const def = c.type === 'custom' ? (tf.userComps || []).find(x => x.id === c.customId) : null;
    const tlabel = c.type === 'custom' ? (def ? def.name : 'Custom') : (tfTypeMeta[c.type] ? tfTypeMeta[c.type].label.split(' ')[0] : c.type);
    return `<div class="ti" ${sel} onclick="tfSelect(decodeURIComponent('${encArg(c.id)}'))" style="padding-left:${10 + d * 16}px;display:flex;justify-content:space-between;gap:6px;cursor:pointer">
      <span><span style="opacity:.7">${escH(tlabel)}</span> ${escH(c.name)}</span>
      <span style="color:var(--dim);font-size:10px">${escH(c.parent || '—')}</span>
    </div>`;
  });
  el.innerHTML = rows.length ? rows.join('') : '<div class="ti" style="color:var(--dim);font-size:11px">ยังไม่มีคอมโพเนนต์ — กด + เพิ่มด้านบน</div>';
}

// ── view groups (assemblies) + show/hide ──
function tfCompVisible(c) { return tf.groupVis[c.viewGroup || 'Default'] !== false; }
function tfApplyGroupVisibility() {
  tf.comps.forEach(c => { if (c.group) c.group.visible = tfCompVisible(c); });
}
function tfRenderGroups() {
  const el = document.getElementById('tf-groups'); if (!el) return;
  const map = {};
  tf.comps.forEach(c => { const g = c.viewGroup || 'Default'; (map[g] = map[g] || []).push(c); });
  const names = Object.keys(map).sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b));
  el.innerHTML = names.map(g => {
    const vis = tf.groupVis[g] !== false;
    const n = map[g].length;
    const esc = escH(g), arg = encArg(g);
    return `<div class="tf-grp">
      <span class="tf-grp-eye" title="แสดง/ซ่อนกลุ่ม" onclick="tfToggleGroup(decodeURIComponent('${arg}'))">${vis ? '👁' : '🚫'}</span>
      <span class="tf-grp-name" title="เลือกสมาชิกกลุ่ม" onclick="tfSelectGroup(decodeURIComponent('${arg}'))">${esc}</span>
      <span class="tf-grp-cnt">${n}</span>
    </div>`;
  }).join('');
}
function tfToggleGroup(g) {
  tf.groupVis[g] = tf.groupVis[g] === false; // toggle (default = ปรากฏ)
  tfApplyGroupVisibility();
  // ถ้าคอมโพเนนต์ที่เลือกถูกซ่อน ให้ถอด gizmo ออก
  const sel = tf.comps.find(x => x.id === tf.selected);
  if (sel && !tfCompVisible(sel) && tf.transformControls) tf.transformControls.detach();
  tfRenderGroups();
}
function tfSelectGroup(g) {
  const m = tf.comps.filter(c => (c.viewGroup || 'Default') === g);
  if (m[0]) tfSelect(m[0].id);
}

// ── right panel: properties ──
function tfRenderProps() {
  const el = document.getElementById('tf-props'); if (!el) return;
  const c = tf.comps.find(x => x.id === tf.selected);
  if (!c) { el.innerHTML = '<div style="padding:16px;color:var(--dim);font-size:12px">เลือกคอมโพเนนต์เพื่อแก้ไขเฟรม / ตำแหน่ง</div>'; return; }
  const def = c.type === 'custom' ? (tf.userComps || []).find(x => x.id === c.customId) : null;
  const meta = c.type === 'custom' ? { label: (def ? def.name : 'Custom') + ' ⭐' } : tfTypeMeta[c.type];
  const parentOpts = ['<option value="">— root —</option>'].concat(
    tf.comps.filter(x => x.id !== c.id).map(x => `<option value="${escH(x.name)}" ${x.name === c.parent ? 'selected' : ''}>${escH(x.name)}</option>`)
  ).join('');
  const p = c.params;
  let sizeRows = {
    base: `<div class="tf-grid3">
        <div><label class="tf-axis-x">ยาว X (m)</label><input id="tf-p-sx" type="number" step="0.01" value="${p.sx}"></div>
        <div><label class="tf-axis-y">กว้าง Y (m)</label><input id="tf-p-sy" type="number" step="0.01" value="${p.sy}"></div>
        <div><label class="tf-axis-z">สูง Z (m)</label><input id="tf-p-sz" type="number" step="0.01" value="${p.sz}"></div>
      </div>`,
    box: `<div class="tf-grid3">
        <div><label class="tf-axis-x">ยาว X (m)</label><input id="tf-p-sx" type="number" step="0.01" value="${p.sx}"></div>
        <div><label class="tf-axis-y">กว้าง Y (m)</label><input id="tf-p-sy" type="number" step="0.01" value="${p.sy}"></div>
        <div><label class="tf-axis-z">สูง Z (m)</label><input id="tf-p-sz" type="number" step="0.01" value="${p.sz}"></div>
      </div>`,
    camera: `<div class="tf-grid3">
        <div><label>กว้าง W (m)</label><input id="tf-p-w" type="number" step="0.01" value="${p.w}"></div>
        <div><label>สูง H (m)</label><input id="tf-p-h" type="number" step="0.01" value="${p.h}"></div>
        <div><label>ลึก D (m)</label><input id="tf-p-d" type="number" step="0.01" value="${p.d}"></div>
      </div>`,
    wheel: `<div class="tf-grid2">
        <div><label>รัศมีล้อ (m)</label><input id="tf-p-radius" type="number" step="0.01" min="0.01" value="${p.radius}"></div>
        <div><label>ความกว้างล้อ (m)</label><input id="tf-p-width" type="number" step="0.01" min="0.01" value="${p.width}"></div>
      </div>`,
    lidar: `<div class="tf-grid2">
        <div><label>รัศมี (m)</label><input id="tf-p-radius" type="number" step="0.01" value="${p.radius}"></div>
        <div><label>สูง (m)</label><input id="tf-p-height" type="number" step="0.01" value="${p.height}"></div>
      </div>`,
    cylinder: `<div class="tf-grid2">
        <div><label>รัศมี (m)</label><input id="tf-p-radius" type="number" step="0.01" value="${p.radius}"></div>
        <div><label>สูง (m)</label><input id="tf-p-height" type="number" step="0.01" value="${p.height}"></div>
      </div>`,
    imu: `<div class="tf-grid2"><div><label>ขนาด (m)</label><input id="tf-p-s" type="number" step="0.01" value="${p.s}"></div></div>`,
    encoder: `<div class="tf-grid2"><div><label>รัศมีลำ (m)</label><input id="tf-p-bodyR" type="number" step="0.005" value="${p.bodyR}"></div><div><label>สูงลำ (m)</label><input id="tf-p-bodyH" type="number" step="0.005" value="${p.bodyH}"></div></div><div class="tf-grid2"><div><label>รัศมี shaft (m)</label><input id="tf-p-shaftR" type="number" step="0.002" value="${p.shaftR}"></div><div><label>ยาว shaft (m)</label><input id="tf-p-shaftH" type="number" step="0.005" value="${p.shaftH}"></div></div>`,
    omni: `<div class="tf-grid3"><div><label>รัศมีล้อ (m)</label><input id="tf-p-radius" type="number" step="0.01" min="0.01" value="${p.radius}"></div><div><label>กว้างล้อ (m)</label><input id="tf-p-width" type="number" step="0.01" min="0.01" value="${p.width}"></div><div><label>รัศมีลูก (m)</label><input id="tf-p-rollerR" type="number" step="0.005" value="${p.rollerR}"></div></div>`,
  }[c.type] || '';
  if (c.type === 'custom' && def) {
    sizeRows = ({
      box: `<div class="tf-grid3"><div><label class="tf-axis-x">ยาว X (m)</label><input id="tf-p-sx" type="number" step="0.01" value="${p.sx}"></div><div><label class="tf-axis-y">กว้าง Y (m)</label><input id="tf-p-sy" type="number" step="0.01" value="${p.sy}"></div><div><label class="tf-axis-z">สูง Z (m)</label><input id="tf-p-sz" type="number" step="0.01" value="${p.sz}"></div></div>`,
      cylinder: `<div class="tf-grid2"><div><label>รัศมี (m)</label><input id="tf-p-radius" type="number" step="0.01" min="0.01" value="${p.radius}"></div><div><label>สูง (m)</label><input id="tf-p-height" type="number" step="0.01" value="${p.height}"></div></div>`,
      lidar: `<div class="tf-grid2"><div><label>รัศมี (m)</label><input id="tf-p-radius" type="number" step="0.01" min="0.01" value="${p.radius}"></div><div><label>สูง (m)</label><input id="tf-p-height" type="number" step="0.01" value="${p.height}"></div></div>`,
      camera: `<div class="tf-grid3"><div><label>กว้าง W (m)</label><input id="tf-p-w" type="number" step="0.01" value="${p.w}"></div><div><label>สูง H (m)</label><input id="tf-p-h" type="number" step="0.01" value="${p.h}"></div><div><label>ลึก D (m)</label><input id="tf-p-d" type="number" step="0.01" value="${p.d}"></div></div>`,
      sphere: `<div class="tf-grid2"><div><label>รัศมี (m)</label><input id="tf-p-radius" type="number" step="0.01" min="0.01" value="${p.radius}"></div></div>`,
      cone: `<div class="tf-grid2"><div><label>รัศมี (m)</label><input id="tf-p-radius" type="number" step="0.01" min="0.01" value="${p.radius}"></div><div><label>สูง (m)</label><input id="tf-p-height" type="number" step="0.01" min="0.01" value="${p.height}"></div></div>`,
      cad: `<div class="tf-prop"><label>CAD mesh (imported)</label><div style="font-size:11px;color:var(--dim);font-family:var(--mono)">${def.bbox ? 'ขนาด ' + def.bbox.map(v => (v * 100).toFixed(1)).join('×') + ' cm' : 'mesh'} · ${((def.mesh && def.mesh.pos ? def.mesh.pos.length / 9 : 0) | 0).toLocaleString()} tri</div></div>
           <div class="tf-prop"><label>สี (ใช้เมื่อไม่มีสีจาก MTL/texture)</label><input id="tf-p-color" type="color" value="#${('000000' + (def.color != null ? def.color : 0x8aa0b5).toString(16)).slice(-6)}" style="height:30px;padding:2px;width:100%"></div>`,
    })[def.shape] || '';
  }

  const typeName = c.type === 'custom' ? (def ? def.name : 'Custom') : (meta.label.split(' ')[1] || meta.label).trim();
  const axisIcon = `<svg class="tf-axis-ico" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 12 20 6" stroke="#4488ff"/><path d="M12 12 6 20" stroke="#ff4444"/><path d="M12 12 12 3" stroke="#44ff66"/><circle cx="12" cy="12" r="1.5" fill="#fff"/></svg>`;
  el.innerHTML = `
    <div class="tf-props-head">${axisIcon}<span>การตั้งค่า Transform (${escH(typeName)})</span></div>
    <div class="tf-prop"><label>ชื่อเฟรม (frame_id)</label><input id="tf-p-name" value="${escH(c.name)}"></div>
    <div class="tf-prop"><label>Parent frame</label><select id="tf-p-parent">${parentOpts}</select></div>
    <div class="tf-prop"><label>View Group (จัดกลุ่ม)</label><input id="tf-p-group" value="${escH(c.viewGroup || '')}" placeholder="เช่น Arm, Base…"></div>
    <div class="tf-sec">ตำแหน่ง (สัมพัทธ์กับ parent) — <span class="tf-axis-x">X</span>/<span class="tf-axis-y">Y</span>/<span class="tf-axis-z">Z</span> <span class="lnk">↔ Move Gizmo</span></div>
    <div class="tf-grid3">
      <div><label class="tf-axis-x">X (m)</label><input id="tf-p-x" type="number" step="0.01" value="${c.pos.x}"></div>
      <div><label class="tf-axis-y">Y (m)</label><input id="tf-p-y" type="number" step="0.01" value="${c.pos.y}"></div>
      <div><label class="tf-axis-z">Z (m)</label><input id="tf-p-z" type="number" step="0.01" value="${c.pos.z}"></div>
    </div>
    <div class="tf-sec">การหมุน — <span class="tf-axis-x">Roll</span>/<span class="tf-axis-y">Pitch</span>/<span class="tf-axis-z">Yaw</span> <span class="lnk">↔ Rotate Gizmo</span></div>
    <div class="tf-grid3">
      <div><label class="tf-axis-x">Roll°</label><input id="tf-p-r" type="number" step="1" value="${c.rpy.r}"></div>
      <div><label class="tf-axis-y">Pitch°</label><input id="tf-p-p" type="number" step="1" value="${c.rpy.p}"></div>
      <div><label class="tf-axis-z">Yaw°</label><input id="tf-p-yaw" type="number" step="1" value="${c.rpy.y}"></div>
    </div>
    ${sizeRows ? `<div class="tf-sec">ขนาด/พารามิเตอร์ — กว้าง/ยาว/สูง <span class="lnk">↔ Scale Gizmo</span></div>${sizeRows}` : ''}
    <div class="tf-del-wrap">
      <button class="btn btn-r tf-del-btn" onclick="tfDeleteCompConfirm(decodeURIComponent('${encArg(c.id)}'))">🗑 ลบคอมโพเนนต์นี้</button>
    </div>
  `;
  // bind
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('input', fn); };
  // numeric transform/size edits update the 3D IN PLACE (gizmo stays attached, no full rebuild)
  const bindLive = (id, fn) => bind(id, e => { fn(e); tfSyncGroup(c); tfSave(); });
  bind('tf-p-name', e => { c.name = e.target.value.trim() || c.name; tfAfterChange(); });
  bind('tf-p-parent', e => { c.parent = e.target.value; tfAfterChange(); tfRenderProps(); });
  const ge = document.getElementById('tf-p-group');
  if (ge) ge.addEventListener('change', e => { c.viewGroup = e.target.value.trim(); tfAfterChange(); tfRenderGroups(); });
  bindLive('tf-p-x', e => { c.pos.x = +e.target.value || 0; });
  bindLive('tf-p-y', e => { c.pos.y = +e.target.value || 0; });
  bindLive('tf-p-z', e => { c.pos.z = +e.target.value || 0; });
  bindLive('tf-p-r', e => { c.rpy.r = +e.target.value || 0; });
  bindLive('tf-p-p', e => { c.rpy.p = +e.target.value || 0; });
  bindLive('tf-p-yaw', e => { c.rpy.y = +e.target.value || 0; });
  const pbl = (id, key) => bindLive(id, e => { c.params[key] = +e.target.value || 0; });
  pbl('tf-p-sx', 'sx'); pbl('tf-p-sy', 'sy'); pbl('tf-p-sz', 'sz');
  pbl('tf-p-radius', 'radius'); pbl('tf-p-width', 'width'); pbl('tf-p-height', 'height');
  pbl('tf-p-w', 'w'); pbl('tf-p-h', 'h'); pbl('tf-p-d', 'd'); pbl('tf-p-s', 's');
  pbl('tf-p-bodyR', 'bodyR'); pbl('tf-p-bodyH', 'bodyH'); pbl('tf-p-shaftR', 'shaftR'); pbl('tf-p-shaftH', 'shaftH');
  // เปลี่ยนสี CAD (ใช้กับเมชที่ไม่มีสี/texture จาก MTL)
  const colEl = document.getElementById('tf-p-color');
  if (colEl && def) colEl.addEventListener('input', e => {
    def.color = parseInt((e.target.value || '#8aa0b5').replace('#', ''), 16) || 0x8aa0b5;
    tfSyncGroup(c); tfSaveCustomComps();
  });
  pbl('tf-p-rollerR', 'rollerR');
}

// ══ EXPORT ══
function tfRad(d) { return THREE.MathUtils.degToRad(d); }
function tfR3(x) { return (+x).toFixed(3); }
// root link ของโมเดล (chassis ถ้ามี) — ใช้เป็น target ของ tf
function tfPkgRootName() {
  const b = tf.comps.find(c => c.type === 'base') || tf.comps[0];
  return b ? b.name : 'base_link';
}
function tfBuildSTP() {
  const byName = {}; tf.comps.forEach(c => byName[c.name] = c);
  const lines = ['#!/usr/bin/env bash', '# Static TF Publishers — สร้างโดย Robot Config (Transformation)', 'set -e', ''];
  tf.comps.forEach(c => {
    if (!c.parent || !byName[c.parent] || c.type === 'base') {
      if (c.type === 'base') return; // root ไม่ม่ำเป็นต้อง publish
    }
    // เพิ่ม roll 90° ให้ล้อ (wheel) เพื่อสอดคล้องกับการหมุน geometry
    const rollAdj = c.type === 'wheel' ? 90 : 0;
    const x = c.pos.x.toFixed(3), y = c.pos.y.toFixed(3), z = c.pos.z.toFixed(3);
    const yaw = tfRad(c.rpy.y).toFixed(4), pitch = tfRad(c.rpy.p).toFixed(4), roll = tfRad(c.rpy.r + rollAdj).toFixed(4);
    const parent = c.parent || 'map';
    lines.push(`ros2 run tf2_ros static_transform_publisher ${x} ${y} ${z} ${yaw} ${pitch} ${roll} ${parent} ${c.name}`);
  });
  return lines.join('\n') + '\n';
}
function tfHexToRgba(hex) {
  const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
  return `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)} 1.0`;
}
function tfBuildURDF() {
  const byName = {}; tf.comps.forEach(c => byName[c.name] = c);
  const P = c => c.params;
  // เลือก root link เดียว (chassis ถ้ามี ไม่เช่นนั้นคอมโพเนนต์ตัวแรก) → URDF ต้องมี root เดียว
  const baseComp = tf.comps.find(c => c.type === 'base') || tf.comps[0];
  const rootName = baseComp ? baseComp.name : 'base_link';
  const visOf = c => {
    const p = P(c);
    if (c.type === 'base')     return `<box size="${tfR3(p.sx)} ${tfR3(p.sy)} ${tfR3(p.sz)}"/>`;
    if (c.type === 'wheel')    return `<cylinder radius="${tfR3(p.radius)}" length="${tfR3(p.width)}"/>`;
    if (c.type === 'lidar' || c.type === 'cylinder') return `<cylinder radius="${tfR3(p.radius)}" length="${tfR3(p.height)}"/>`;
    if (c.type === 'camera')   return `<box size="${tfR3(p.w)} ${tfR3(p.d)} ${tfR3(p.h)}"/>`;
    if (c.type === 'imu' || c.type === 'box') return `<box size="${tfR3(p.s)} ${tfR3(p.s)} ${tfR3(p.s)}"/>`;
    if (c.type === 'encoder')  return `<cylinder radius="${tfR3(p.bodyR)}" length="${tfR3(p.bodyH)}"/><!-- + shaft r=${tfR3(p.shaftR)} h=${tfR3(p.shaftH)} -->`;
    if (c.type === 'omni')    return `<cylinder radius="${tfR3(p.rollerR)}" length="${tfR3(p.width)}"/><!-- omni rollers x4 -->`;
    if (c.type === 'custom') {
      const def = (tf.userComps || []).find(x => x.id === c.customId);
      const sh = def ? def.shape : 'box', pp = def ? def.params : p;
      if (sh === 'cad') {
        // CAD mesh → export เป็นกล่อง AABB (URDF portable, ไม่อ้างไฟล์ mesh ภายนอก)
        const b = (def && def.bbox) || [0.1, 0.1, 0.1];
        return `<box size="${tfR3(b[0] || 0.1)} ${tfR3(b[1] || 0.1)} ${tfR3(b[2] || 0.1)}"/><!-- CAD mesh (imported): ${escH(def ? def.name : 'cad')} -->`;
      }
      if (sh === 'cone')    return `<cone radius="${tfR3(pp.radius)}" height="${tfR3(pp.height)}"/>`;
      if (sh === 'cylinder' || sh === 'lidar') return `<cylinder radius="${tfR3(pp.radius)}" length="${tfR3(pp.height)}"/>`;
      if (sh === 'sphere') return `<sphere radius="${tfR3(pp.radius)}"/>`;
      if (sh === 'camera') return `<box size="${tfR3(pp.w)} ${tfR3(pp.d)} ${tfR3(pp.h)}"/>`;
      return `<box size="${tfR3(pp.sx || 0.2)} ${tfR3(pp.sz || 0.2)} ${tfR3(pp.sy || 0.2)}"/>`;
    }
    return `<box size="0.15 0.15 0.15"/>`;
  };
  // สร้าง material definitions จากสีแต่ละประเภท (tfTypeMeta) เพื่อให้ rviz แสดงสีต่างกัน
  const matDefs = Object.entries(tfTypeMeta).map(([type, meta]) =>
    `  <material name="${type}_material"><color rgba="${tfHexToRgba(meta.color)}"/></material>`
  ).join('\n');
  const customMats = (tf.userComps || []).map(d =>
    `  <material name="custom_${d.id}"><color rgba="${tfHexToRgba(d.color)}"/></material>`
  ).join('\n');
  const matName = c => c.type === 'custom' ? 'custom_' + c.customId : c.type + '_material';
  // geometry ของ primitive 1 ชิ้น (ใช้กับ composite parts)
  const shapeGeo = (sh, pp) => {
    if (sh === 'cylinder' || sh === 'lidar') return `<cylinder radius="${tfR3(pp.radius)}" length="${tfR3(pp.height)}"/>`;
    if (sh === 'sphere') return `<sphere radius="${tfR3(pp.radius)}"/>`;
    if (sh === 'cone')   return `<cone radius="${tfR3(pp.radius)}" height="${tfR3(pp.height)}"/>`;
    if (sh === 'camera') return `<box size="${tfR3(pp.w)} ${tfR3(pp.d)} ${tfR3(pp.h)}"/>`;
    return `<box size="${tfR3(pp.sx || 0.1)} ${tfR3(pp.sy || 0.1)} ${tfR3(pp.sz || 0.1)}"/>`;
  };
  // ถ้าเป็น composite → คืน <visual>/<collision> หลายอัน (แต่ละ part มี origin), ไม่งั้นคืน null
  const compositeMarkup = c => {
    if (c.type !== 'custom') return null;
    const def = (tf.userComps || []).find(x => x.id === c.customId);
    if (!def || !Array.isArray(def.parts) || !def.parts.length) return null;
    return def.parts.map(sp => {
      const pos = sp.pos || { x: 0, y: 0, z: 0 }, rpy = sp.rpy || { r: 0, p: 0, y: 0 };
      const org = `<origin xyz="${tfR3(pos.x)} ${tfR3(pos.y)} ${tfR3(pos.z)}" rpy="${tfRad(rpy.r).toFixed(4)} ${tfRad(rpy.p).toFixed(4)} ${tfRad(rpy.y).toFixed(4)}"/>`;
      const geo = shapeGeo(sp.shape, sp.params);
      return `    <visual>${org}<geometry>${geo}</geometry><material name="${matName(c)}"/></visual>\n    <collision>${org}<geometry>${geo}</geometry></collision>\n`;
    }).join('');
  };
  let s = '<?xml version="1.0"?>\n<robot name="sim_robot_tf">\n';
  s += matDefs + (customMats ? '\n' + customMats : '') + '\n';
  tf.comps.forEach(c => {
    const comp = compositeMarkup(c);
    s += `  <link name="${c.name}">\n`;
    if (comp) {
      s += comp;
    } else {
      s += `    <visual><geometry>${visOf(c)}</geometry><material name="${matName(c)}"/></visual>\n`;
      s += `    <collision><geometry>${visOf(c)}</geometry></collision>\n`;
    }
    s += `    <inertial><mass value="0.1"/><inertia ixx="0.001" ixy="0" ixz="0" iyy="0.001" iyz="0" izz="0.001"/></inertial>\n  </link>\n`;
  });
  tf.comps.forEach(c => {
    if (c.name === rootName) return;
    const parent = (c.parent && byName[c.parent]) ? c.parent : rootName;
    const xyz = `${tfR3(c.pos.x)} ${tfR3(c.pos.y)} ${tfR3(c.pos.z)}`;
    // เพิ่ม roll 90° ให้ล้อ (wheel) เพื่อสอดคล้องกับการหมุน geometry
    const rollAdj = c.type === 'wheel' ? Math.PI / 2 : 0;
    const rpy = `${tfRad(c.rpy.r + rollAdj * 180 / Math.PI).toFixed(4)} ${tfRad(c.rpy.p).toFixed(4)} ${tfRad(c.rpy.y).toFixed(4)}`;
    s += `  <joint name="${c.name}_joint" type="fixed">\n    <parent link="${parent}"/>\n    <child link="${c.name}"/>\n    <origin xyz="${xyz}" rpy="${rpy}"/>\n  </joint>\n`;
  });
  s += '</robot>\n';
  return s;
}
function tfBuildJSON() {
  const byName = {}; tf.comps.forEach(c => byName[c.name] = c);
  const arr = tf.comps.map(c => ({
    name: c.name, type: c.type, parent: c.parent || null,
    xyz: [+c.pos.x.toFixed(3), +c.pos.y.toFixed(3), +c.pos.z.toFixed(3)],
    rpy_rad: [+tfRad(c.rpy.r).toFixed(4), +tfRad(c.rpy.p).toFixed(4), +tfRad(c.rpy.y).toFixed(4)],
  }));
  return JSON.stringify({ frames: arr }, null, 2);
}
// Serialize the editable model (models + TFs) so it can be reloaded
// when the workspace is reopened. Same shape as the localStorage copy.
function tfBuildModelJSON() {
  const arr = tf.comps.map(c => ({
    id: c.id, type: c.type, name: c.name, parent: c.parent || null,
    pos: { x: +c.pos.x, y: +c.pos.y, z: +c.pos.z },
    rpy: { r: +c.rpy.r, p: +c.rpy.p, y: +c.rpy.y },
    params: c.params || {}, viewGroup: c.viewGroup || '',
    customId: c.customId || '',
  }));
  return JSON.stringify(arr, null, 2);
}
function tfBuildLaunchPy() {
  const stp = tfBuildSTP().split('\n').filter(l => l.startsWith('ros2 run tf2_ros'));
  let nodes = '';
  stp.forEach((line, i) => {
    const parts = line.split(' ');
    const args = parts.slice(4); // x y z yaw pitch roll parent child
    nodes += `    Node(\n        package='tf2_ros',\n        executable='static_transform_publisher',\n        name='stp_${i}',\n        arguments=[${args.map(a => `'${a}'`).join(', ')}],\n    ),\n`;
  });
  return `from launch import LaunchDescription\nfrom launch_ros.actions import Node\n\ndef generate_launch_description():\n    return LaunchDescription([\n${nodes}    ])\n`;
}

// ══ Package generators for `sim_robot_tf` (Save to Workspace) ══
// แพ็กเกจ ROS2 จริงที่ build/launch ได้: โมเดลหุ่นยนต์ (URDF) + ต้นไม้ TF
function tfPkgXml() {
  return `<?xml version="1.0"?>
<package format="3">
  <name>sim_robot_tf</name>
  <version>0.1.0</version>
  <description>Robot TF model — generated by Robot Config page</description>
  <maintainer email="sim@ros2ide.local">sim</maintainer>
  <buildtool_depend>ament_python</buildtool_depend>
  <exec_depend>rclpy</exec_depend>
  <exec_depend>tf2_ros</exec_depend>
  <exec_depend>robot_state_publisher</exec_depend>
  <exec_depend>std_msgs</exec_depend>
  <exec_depend>ament_index_python</exec_depend>
</package>
`;
}
function tfPkgSetupPy() {
  return `from setuptools import setup
from glob import glob
import os

package_name = 'sim_robot_tf'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
        (os.path.join('share', package_name, 'urdf'), glob('urdf/*.urdf')),
        # install the standalone node into lib/<pkg> so \`ros2 run sim_robot_tf
        # tf\` AND the launch file (executable='tf')
        # resolve to a real, runnable executable in every ROS 2 layout.
        ('lib/' + package_name, ['scripts/tf']),
    ],
    # console_scripts entry point (canonical ament_python style): the same node,
    # importable as sim_robot_tf.tf:main, installed as \`tf\`.
    entry_points={
        'console_scripts': [
            'tf = sim_robot_tf.tf:main',
        ],
    },
    install_requires=['setuptools'],
    zip_safe=False,
)
`;
}
function tfPkgLaunchPy() {
  return `import os

from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    # ต้นไม้ TF จากหน้า Robot Config — แสดงบน rviz
    return LaunchDescription([
        Node(
            package='sim_robot_tf',
            executable='tf',
            name='tf',
        ),
    ])
`;
}
// TF publisher node (named \`tf\`) — broadcasts the whole transform tree
// AND the 3D model (URDF on /robot_description) so rviz shows both.
// No odom/patrol code.
function tfTfPy() {
  const byName = {}; tf.comps.forEach(c => byName[c.name] = c);
  const frames = tf.comps.map(c => {
    const parent = (c.parent && byName[c.parent]) ? c.parent : 'map';
    // base_link เป็นของโหนด odometry (wheel_odom / SIM_STATE_PUB) ที่โพสต์ odom→base_link เคลื่อนที่
    // ห้าม sim_robot_tf โพสต์ base_link→map ซ้ำเดี๋ยว TF ชนกัน → rviz กระพริบ 2 ตำแหน่ง
    if (c.name === 'base_link' && parent === 'map') return null;
    const x = (+c.pos.x).toFixed(3), y = (+c.pos.y).toFixed(3), z = (+c.pos.z).toFixed(3);
    // เพิ่ม roll 90° ให้ล้อ (wheel) เพื่อสอดคล้องกับการหมุน geometry
    const rollAdj = c.type === 'wheel' ? Math.PI / 2 : 0;
    const roll = tfRad(c.rpy.r + rollAdj * 180 / Math.PI).toFixed(4), pitch = tfRad(c.rpy.p).toFixed(4), yaw = tfRad(c.rpy.y).toFixed(4);
    return `    ('${c.name}', '${parent}', ${x}, ${y}, ${z}, ${roll}, ${pitch}, ${yaw}),`;
  }).filter(Boolean).join('\n');
  return `#!/usr/bin/env python3
# tf — เผยแพร่ต้นไม้ TF + โมเดล 3D (URDF) จากหน้า Robot Config ให้ rviz
import math
import os

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped
from tf2_ros import TransformBroadcaster
from ament_index_python.packages import get_package_share_directory


def euler_to_quat(roll, pitch, yaw):
    cr, sr = math.cos(roll / 2.0), math.sin(roll / 2.0)
    cp, sp = math.cos(pitch / 2.0), math.sin(pitch / 2.0)
    cy, sy = math.cos(yaw / 2.0), math.sin(yaw / 2.0)
    return (
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    )


class TfPublisher(Node):
    # (child, parent, x, y, z, roll, pitch, yaw) — จากโมเดลในหน้า Robot Config
    FRAMES = [
${frames}
    ]

    def __init__(self):
        super().__init__('sim_robot_tf')
        self.br = TransformBroadcaster(self)
        # โมเดล 3D (URDF) ลง /robot_description เพื่อให้ rviz RobotModel แสดงได้
        self.desc_pub = self.create_publisher(
            String, '/robot_description',
            QoSProfile(depth=1, reliability=QoSReliabilityPolicy.RELIABLE,
                      durability=QoSDurabilityPolicy.TRANSIENT_LOCAL))
        try:
            urdf_path = os.path.join(
                get_package_share_directory('sim_robot_tf'), 'urdf', 'robot.urdf')
            with open(urdf_path, 'r') as f:
                self.robot_desc = f.read()
        except Exception:
            self.robot_desc = ''
        self.timer = self.create_timer(0.1, self.tick)

    def tick(self):
        now = self.get_clock().now().to_msg()
        # โมเดล 3D (URDF)
        if self.robot_desc:
            m = String(); m.data = self.robot_desc
            self.desc_pub.publish(m)
        # ต้นไม้ TF
        for child, parent, x, y, z, roll, pitch, yaw in self.FRAMES:
            t = TransformStamped()
            t.header.stamp = now
            t.header.frame_id = parent
            t.child_frame_id = child
            t.transform.translation.x = float(x)
            t.transform.translation.y = float(y)
            t.transform.translation.z = float(z)
            qx, qy, qz, qw = euler_to_quat(float(roll), float(pitch), float(yaw))
            t.transform.rotation.x = qx
            t.transform.rotation.y = qy
            t.transform.rotation.z = qz
            t.transform.rotation.w = qw
            self.br.sendTransform(t)


def main(args=None):
    rclpy.init(args=args)
    node = TfPublisher()
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
// ══ Package generators for `sim_robot_odom` (Save to Workspace) ══
// แพ็กเกจ ROS2 แยกต่างหากจาก sim_robot_tf: โหนด wheel_odom (คำนวณ /odom จากล้อจริง)
// + config โครงสร้างเหมือน sim_robot_tf ทุกประการ (package.xml / setup.py / launch / entry point)
function tfOdomPkgXml() {
  return `<?xml version="1.0"?>
<package format="3">
  <name>sim_robot_odom</name>
  <version>0.1.0</version>
  <description>Robot odometry node — generated by Robot Config (Odometry)</description>
  <maintainer email="sim@ros2ide.local">sim</maintainer>
  <buildtool_depend>ament_python</buildtool_depend>
  <exec_depend>rclpy</exec_depend>
  <exec_depend>tf2_ros</exec_depend>
  <exec_depend>geometry_msgs</exec_depend>
  <exec_depend>nav_msgs</exec_depend>
  <exec_depend>sensor_msgs</exec_depend>
  <exec_depend>std_msgs</exec_depend>
  <exec_depend>ament_index_python</exec_depend>
</package>
`;
}
function tfOdomPkgSetupPy() {
  return `from setuptools import setup
from glob import glob
import os

package_name = 'sim_robot_odom'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
        # install the standalone node into lib/<pkg> so \`ros2 run sim_robot_odom
        # wheel_odom\` AND the launch file (executable='wheel_odom')
        # resolve to a real, runnable executable in every ROS 2 layout.
        ('lib/' + package_name, ['scripts/wheel_odom']),
    ],
    # console_scripts entry point (canonical ament_python style): the same node,
    # importable as sim_robot_odom.odom:main, installed as \`wheel_odom\`.
    entry_points={
        'console_scripts': [
            'wheel_odom = sim_robot_odom.odom:main',
        ],
    },
    install_requires=['setuptools'],
    zip_safe=False,
)
`;
}
function tfOdomPkgLaunchPy() {
  return `import os

from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    # โหนด Odometry จากหน้า Robot Config — คำนวณ /odom จากล้อจริง (wheel_odom)
    return LaunchDescription([
        Node(
            package='sim_robot_odom',
            executable='wheel_odom',
            name='wheel_odom',
        ),
    ])
`;
}
// คืน map ไฟล์แพ็กเกจ sim_robot_odom เต็มรูปแบบ (ใช้ทั้ง Save → packages และ Generate)
function tfOdomPackageFiles() {
  return {
    'package.xml':                     tfOdomPkgXml(),
    'setup.py':                        tfOdomPkgSetupPy(),
    'resource/sim_robot_odom':         '',                       // ament marker (ไฟล์ว่าง)
    'sim_robot_odom/__init__.py':      '',
    'sim_robot_odom/odom.py':        tfBuildOdomPy(),         // โมดูล wheel_odom (console_scripts → lib/<pkg>/wheel_odom)
    'scripts/wheel_odom':            tfBuildOdomPy(),         // สคริปต์ standalone (data_files → lib/<pkg>/wheel_odom สำหรับ ros2 run/launch)
    'launch/wheel_odom.launch.py':     tfOdomPkgLaunchPy(),     // รันโหนด odom (เผยแพร่ /odom ให้ rviz)
    'odom_config.json':                tfBuildOdomConfig(),     // config ล้อ/PPR/pattern (เผาไว้ในโค้ดแล้ว แต่เก็บไว้ดูด้วย)
  };
}

let tfExportKind = 'stp';
function tfSetExportTab(kind) {
  tfExportKind = kind;
  document.querySelectorAll('#tf-export-modal .tf-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === kind));
  tfRefreshExport();
}
function tfRefreshExport() {
  const ta = document.getElementById('tf-export-text'); if (!ta) return;
  ta.value = { stp: tfBuildSTP(), urdf: tfBuildURDF(), json: tfBuildJSON(), launch: tfBuildLaunchPy() }[tfExportKind] || '';
}
function tfOpenExport() {
  tfRefreshExport();
  document.getElementById('tf-export-modal').style.display = 'flex';
}
function tfCloseExport() { document.getElementById('tf-export-modal').style.display = 'none'; }
// ── save confirmation modal ──
function tfShowSaveAlert(msg) {
  const m = document.getElementById('tf-save-modal');
  const body = document.getElementById('tf-save-modal-body');
  if (body) body.innerHTML = msg;
  if (m) m.style.display = 'flex';
}
function tfCloseSaveAlert() {
  const m = document.getElementById('tf-save-modal');
  if (m) m.style.display = 'none';
}
function tfCopyExport() {
  const ta = document.getElementById('tf-export-text');
  ta.select(); document.execCommand('copy');
  sbMsg('คัดลอกแล้ว');
}
function tfDownloadExport() {
  const ta = document.getElementById('tf-export-text');
  const ext = { stp: 'sh', urdf: 'urdf', json: 'json', launch: 'launch.py' }[tfExportKind];
  const name = 'tf_' + tfExportKind + '.' + ext;
  const blob = new Blob([ta.value], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  sbMsg('ดาวน์โหลด ' + name);
}
async function tfSaveToWorkspace() {
  if (!sessionId) { sbMsg('ต้องเชื่อมต่อหุ่นก่อนจึงจะบันทึก package ได้'); return; }
  if (!tf.comps.length) { sbMsg('ยังไม่มีโมเดล — เพิ่มคอมโพเนนต์ก่อน'); return; }
  // สร้างแพ็กเกจ sim_robot_tf เต็มรูปแบบ (สร้างใหม่ หรือแก้ไขถ้ามีอยู่แล้ว)
  const files = {
    'package.xml':                     tfPkgXml(),
    'setup.py':                        tfPkgSetupPy(),
    'resource/sim_robot_tf':           '',                       // ament marker (ไฟล์ว่าง)
    'sim_robot_tf/__init__.py':        '',
    'sim_robot_tf/tf.py':            tfTfPy(),               // โมดูล TF publisher (console_scripts → lib/<pkg>/tf)
    'scripts/tf':                    tfTfPy(),               // สคริปต์ standalone (data_files → lib/<pkg>/tf สำหรับ ros2 run/launch)
    'urdf/robot.urdf':                 tfBuildURDF(),            // โมเดลหุ่นยนต์
    'launch/tf_static.launch.py':      tfPkgLaunchPy(),         // รัน TF tree (แสดงบน rviz)
    'tf_model.json':                    tfBuildModelJSON(),        // บันทึกโมเดลแบบแก้ไขได้ (models + TFs) เพื่อโหลดกลับตอนเปิด workspace
  };
  // ตรวจล้ออัตโนมัติ → ถ้ามีล้อ ให้ gen แพ็กเกจ sim_robot_odom ไปพร้อมกัน (export ด้วยกัน)
  if (!tf.odom || !tf.odom.wheels || !tf.odom.wheels.length) tfOdomDetect();
  const odomFiles = (tf.odom && tf.odom.wheels && tf.odom.wheels.length) ? tfOdomPackageFiles() : null;
  try {
    const r = await API('/api/sim/save-tf-package', { sessionId, files });
    if (!r.ok) { sbMsg('บันทึก TF ไม่สำเร็จ: ' + (r.error || '')); return; }
    const verb = r.created ? 'สร้างแพ็กเกจใหม่' : 'อัปเดต';
    let msg = `✅ บันทึก${verb}แพ็กเกจ <b>sim_robot_tf</b> เรียบร้อยแล้ว<br><span style="color:var(--dim);font-size:12px">(${r.written.length} ไฟล์) → src/sim_robot_tf</span>`;
    // ถ้ามีล้อ → สร้างแพ็กเกจ sim_robot_odom แยกต่างหาก (เหมือน TF ทุกประการ)
    if (odomFiles) {
      const ro = await API('/api/sim/save-odom-package', { sessionId, files: odomFiles });
      if (ro.ok) {
        const v2 = ro.created ? 'สร้างแพ็กเกจใหม่' : 'อัปเดต';
        msg += `<br>✅ บันทึก${v2}แพ็กเกจ <b>sim_robot_odom</b> เรียบร้อยแล้ว<br><span style="color:var(--dim);font-size:12px">(${ro.written.length} ไฟล์) → src/sim_robot_odom</span>`;
        sbMsg('บันทึก sim_robot_tf + sim_robot_odom แล้ว');
      } else {
        msg += `<br>⚠️ บันทึก sim_robot_odom ไม่สำเร็จ: ` + (ro.error || '');
        sbMsg('⚠️ บันทึก sim_robot_odom ไม่สำเร็จ: ' + (ro.error || ''));
      }
    } else {
      sbMsg(`${verb} sim_robot_tf แล้ว`);
    }
    tfShowSaveAlert(msg);
    // เซฟเสร็จ → ปิด modal อัตโนมัติ (แสดงข้อความยืนยัน briefly แล้วปิดทั้ง export + alert)
    setTimeout(() => { tfCloseSaveAlert(); tfCloseExport(); }, 1800);
  } catch (e) { sbMsg('บันทึกไม่สำเร็จ: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  ODOMETRY — ตั้งค่าล้อ + encoder จากโมเดล TF แล้ว gencode node
//  อ่าน TF model อัตโนมัติ (ตำแหน่ง/รัศมีล้อ) → ผู้ใช้ระบุแค่ PPR + pattern
//  คำนวณค่าเอง (เส้นรอบวง / ticks-per-m / wheelbase / track)
//  Generate → แพ็กเกจ sim_robot_odom (wheel_odom.py + config เผาไว้ในโค้ด + URDF)
//  Run in Sim → รัน node ใน sim domain → RViz โชว์ /odom จากล้อจริง
// ═════════════════════════════════════════════════════════════

const TF_ODOM_PATTERNS = {
  differential: { label: 'Differential (2WD)',      hint: 'ล้อ 2 ตัว' },
  skid:         { label: 'Skid-steer (4WD)',        hint: 'ล้อ 4 ตัว' },
  mecanum:      { label: 'Mecanum (4WD)',           hint: 'ล้อ 4 ตัว 45°' },
  omni3:        { label: 'Omni 3-wheel',            hint: 'omni 3 ตัว' },
  omni4:        { label: 'Omni 4-wheel',            hint: 'omni 4 ตัว' },
};

// ตำแหน่งของคอมโพเนนต์เทียบกับ base (เดินขึ้นไปตาม parent chain)
function tfWorldPosOf(c) {
  const byName = {}; tf.comps.forEach(x => byName[x.name] = x);
  const chain = []; const seen = new Set(); let cur = c;
  while (cur && !seen.has(cur.name)) { seen.add(cur.name); chain.unshift(cur); cur = byName[cur.parent]; }
  let x = 0, y = 0, z = 0;
  chain.forEach(cc => { x += cc.pos.x; y += cc.pos.y; z += cc.pos.z; });
  return { x, y, z };
}

// ตรวจหาล้อทั้งหมด (wheel + omni) จากโมเดล → คืนตำแหน่งสัมพัทธ์ base + รัศมี
function tfDetectWheels() {
  return tf.comps.filter(c => c.type === 'wheel' || c.type === 'omni').map(c => {
    const wp = tfWorldPosOf(c);
    const R = (c.params && c.params.radius != null) ? c.params.radius : 0.1;
    return {
      name: c.name, type: c.type,
      x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3),
      radius: +R.toFixed(3),
    };
  });
}

// เดา pattern จากจำนวน/ชนิดล้อ
function tfSuggestPattern(wheels) {
  const n = wheels.length;
  const omnis = wheels.filter(w => w.type === 'omni').length;
  if (omnis >= 3) return omnis === 3 ? 'omni3' : 'omni4';
  if (n === 2) return 'differential';
  if (n === 4) return 'skid';
  if (n >= 3) return 'omni3';
  return 'differential';
}

// ทิศทางการกลิ้งของล้อ (rolling direction β, องศา) — ใช้ในสูตร IK/FK
//   standard wheel : β = 0   (กลิ้ง along ROS-x)
//   omni wheel     : β = radial + 90° (สัมผัสวงกลม → tangential)
//   mecanum        : β ตามมุม (FL=135, FR=45, RL=45, RR=135)
function tfBeta(w, pattern) {
  if (pattern === 'mecanum') {
    const front = w.x >= 0, left = w.y >= 0;
    if (front && left) return 135;
    if (front && !left) return 45;
    if (!front && left) return 45;
    return 135;
  }
  if (w.type === 'omni') {
    const phi = Math.atan2(w.y, w.x) * 180 / Math.PI;
    return phi + 90;
  }
  return 0;
}

// ค่าเรขาคณิตที่คำนวณเองจากล้อ
function tfKinematics(wheels, pattern) {
  const radii = wheels.map(w => w.radius);
  const R = radii.reduce((a, b) => a + b, 0) / Math.max(1, radii.length);
  const circ = 2 * Math.PI * R;
  const maxY = Math.max.apply(null, wheels.map(w => Math.abs(w.y)).concat(0));
  const track = 2 * maxY;
  const xs = wheels.map(w => w.x);
  const wheelbase = (Math.max.apply(null, xs) - Math.min.apply(null, xs));
  return { R, circ, track, wheelbase };
}

// ── Linear algebra helpers (สำหรับ pseudoinverse ของ IK matrix) ──
function tfMatMul(A, B) {
  const m = A.length, n = B.length, p = B[0].length;
  const C = Array.from({ length: m }, () => new Array(p).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < n; k++) s += A[i][k] * B[k][j]; C[i][j] = s; }
  return C;
}
function tfMatT(A) { return A[0].map((_, j) => A.map(r => r[j])); }
function tfInv3(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular');
  const id = 1 / det;
  return [
    [A * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [B * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [C * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ];
}
// A: N×3 → pseudoinverse 3×N (ใช้เมื่อ rank=3 เท่านั้น)
function tfPinv33(A) {
  const At = tfMatT(A);
  const AtA = tfMatMul(At, A);
  const inv = tfInv3(AtA);
  return tfMatMul(inv, At);
}

// ══ State / persistence ══
function tfOdomKey() { return 'tf_odom_' + (sessionId || 'default'); }
function tfOdomLoad() { try { const r = localStorage.getItem(tfOdomKey()); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
function tfOdomSave() {
  try {
    const saved = { pattern: tf.odom.pattern, wheels: tf.odom.wheels.map(w => ({ name: w.name, ppr: w.ppr, channels: w.channels, invert: w.invert })) };
    localStorage.setItem(tfOdomKey(), JSON.stringify(saved));
  } catch (e) {}
}
function tfOdomDetect() {
  let wheels = tfDetectWheels();
  if (!wheels.length) { tf.odom = { wheels: [], pattern: 'differential', ppr: 1024, channels: 4 }; return; }
  const saved = tfOdomLoad();
  const savedMap = {}; (saved && saved.wheels || []).forEach(w => savedMap[w.name] = w);
  wheels = wheels.map(w => ({
    ...w,
    ppr:   (savedMap[w.name] && savedMap[w.name].ppr)     || 1024,
    channels: (savedMap[w.name] && savedMap[w.name].channels) || 4,
    invert:  (savedMap[w.name] && savedMap[w.name].invert)  || 1,
  }));
  const pat = (saved && saved.pattern) || tfSuggestPattern(wheels);
  tf.odom = { wheels, pattern: pat, ppr: 1024, channels: 4 };
}
function tfOpenOdom() {
  if (!tf.odom || !tf.odom.wheels || !tf.odom.wheels.length) tfOdomDetect();
  const m = document.getElementById('tf-odom-modal'); if (m) m.style.display = 'flex';
  tfRenderOdom();
}
function tfCloseOdom() { const m = document.getElementById('tf-odom-modal'); if (m) m.style.display = 'none'; }

function tfOdomSetPattern(p) { tf.odom.pattern = p; tfOdomSave(); tfRenderOdom(); }
function tfOdomSetPpr(name, v) { const w = tf.odom.wheels.find(x => x.name === name); if (w) { w.ppr = Math.max(1, parseInt(v) || 1024); tfOdomUpdateKpis(); tfOdomSave(); } }
function tfOdomSetCh(name, v) { const w = tf.odom.wheels.find(x => x.name === name); if (w) { w.channels = parseInt(v) || 4; tfOdomUpdateKpis(); tfOdomSave(); } }
function tfOdomSetInv(name, chk) { const w = tf.odom.wheels.find(x => x.name === name); if (w) { w.invert = chk ? -1 : 1; tfOdomSave(); } }

function tfRenderOdom() {
  const body = document.getElementById('tf-odom-body'); if (!body) return;
  const o = tf.odom;
  if (!o.wheels.length) {
    body.innerHTML = `<div class="tf-odom-sec">⚠️ ไม่พบล้อในโมเดล</div>
      <div class="tf-odom-note">เพิ่มคอมโพเนนต์ประเภท <b>Wheel</b> หรือ <b>Omni</b> ลงในโมเดลก่อน (แผง COMPONENTS ด้านซ้าย) แล้วเปิดหน้านี้ใหม่</div>`;
    document.getElementById('tf-odom-foot').innerHTML = `<button class="btn" onclick="tfCloseOdom()">ปิด</button>`;
    return;
  }
  const kin = tfKinematics(o.wheels, o.pattern);
  const baseName = tfPkgRootName();
  const patBtns = Object.entries(TF_ODOM_PATTERNS).map(([k, m]) => {
    const auto = (tfSuggestPattern(o.wheels) === k) ? '<span class="auto">⚡ auto</span>' : '';
    return `<button class="tf-pat-btn ${o.pattern === k ? 'active' : ''}" onclick="tfOdomSetPattern('${k}')">${m.label}${auto}</button>`;
  }).join('');
  const rows = o.wheels.map(w => {
    const icon = w.type === 'omni' ? '🛞' : '⚙️';
    return `<tr>
      <td>${icon} ${escH(w.name)}</td>
      <td style="color:var(--dim)">${w.type}</td>
      <td style="color:var(--dim)">${w.x}, ${w.y}</td>
      <td style="color:var(--dim)">${w.radius}</td>
      <td><input type="number" min="1" step="1" value="${w.ppr}" oninput="tfOdomSetPpr('${escH(w.name)}',this.value)"></td>
      <td><select onchange="tfOdomSetCh('${escH(w.name)}',this.value)">
            <option value="1" ${w.channels == 1 ? 'selected' : ''}>1 (ธรรมดา)</option>
            <option value="4" ${w.channels == 4 ? 'selected' : ''}>4 (quad)</option>
          </select></td>
      <td style="text-align:center"><input type="checkbox" ${w.invert === -1 ? 'checked' : ''} onchange="tfOdomSetInv('${escH(w.name)}',this.checked)"></td>
    </tr>`;
  }).join('');
  body.innerHTML = `
    <div class="tf-odom-sec">🛞 ล้อที่ตรวจพบจากโมเดล TF <span class="tf-odom-sub">(ตำแหน่ง/รัศมีคำนวณจากการติดตั้ง TF อัตโนมัติ)</span></div>
    <table class="tf-wheel-tbl">
      <thead><tr><th>เฟรม</th><th>ชนิด</th><th>ตำแหน่ง(x,y)</th><th>R(m)</th><th>PPR encoder</th><th>channels</th><th>inv</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="tf-odom-sec">🎛 รูปแบบขับเคลื่อน (drive pattern)</div>
    <div class="tf-odom-pat">${patBtns}</div>
    <div class="tf-odom-sec">📐 ค่าที่คำนวณอัตโนมัติ <span class="tf-odom-sub">(จาก TF + PPR — อัปเดตตามที่พิมพ์)</span></div>
    <div class="tf-odom-kpis" id="tf-odom-kpis"></div>
    <div class="tf-odom-note">💡 ระบบเดา pattern จากจำนวน/ชนิดล้ออัตโนมัติ (กดปุ่มด้านบนเปลี่ยนได้) — คุณระบุแค่ <b>PPR ของ encoder</b> และ <b>channels</b> ต่อล้อ<br>
      ✅ กด <b>▶ Run in Sim</b> (ที่นี่หรือปุ่มในแถบซ้าย) → ระบบ generate จากดีไซน์ปัจจุบัน → รันหุ่นใน Sim → สลับไป RViz อัตโนมัติ (generic ถูกหยุดให้อัตโนมัติ ไม่มี /odom ซ้อน) — ส่ง /cmd_vel จากแผง Teleop หุ่นจะเดินตามค่าล้อ/PPR ที่ตั้ง</div>
  `;
  tfOdomUpdateKpis();
  document.getElementById('tf-odom-foot').innerHTML = `
    <button class="btn" onclick="tfOdomStopGeneric()">⏹ หยุด generic</button>
    <button class="btn" onclick="tfOdomStopOdom()">⏹ หยุด odom</button>
    <span style="flex:1"></span>
    <button class="btn" onclick="tfCloseOdom()">ปิด</button>
    <button class="btn" id="tf-odom-gen" onclick="tfOdomGenerate()">📦 Generate</button>
    <button class="btn btn-g" id="tf-odom-run" onclick="tfOdomRun()">▶ Run in Sim</button>
  `;
}
// อัปเดตเฉพาะช่อง KPI (ไม่ re-render ทั้งหมด → ไม่เสียโฟกัส input)
function tfOdomUpdateKpis() {
  const el = document.getElementById('tf-odom-kpis'); if (!el) return;
  const o = tf.odom; if (!o.wheels.length) return;
  const kin = tfKinematics(o.wheels, o.pattern);
  const baseName = tfPkgRootName();
  const meanPpr = Math.round(o.wheels.reduce((a, w) => a + (w.ppr || 1024), 0) / o.wheels.length);
  const meanCh = Math.round(o.wheels.reduce((a, w) => a + (w.channels || 4), 0) / o.wheels.length);
  const circ = kin.circ;
  const ticksPerM = (meanPpr * meanCh) / circ;
  const mPerTick = circ / (meanPpr * meanCh);
  el.innerHTML = `
    <div class="tf-kpi"><div class="k">base frame</div><div class="v">${escH(baseName)}</div></div>
    <div class="tf-kpi"><div class="k">รัศมีล้อเฉลี่ย</div><div class="v">${kin.R.toFixed(3)} m</div></div>
    <div class="tf-kpi"><div class="k">เส้นรอบวง</div><div class="v">${circ.toFixed(3)} m</div></div>
    <div class="tf-kpi"><div class="k">wheelbase</div><div class="v">${kin.wheelbase.toFixed(2)} m</div></div>
    <div class="tf-kpi"><div class="k">track</div><div class="v">${kin.track.toFixed(2)} m</div></div>
    <div class="tf-kpi"><div class="k">ticks / เมตร</div><div class="v">${ticksPerM.toFixed(0)}</div></div>
    <div class="tf-kpi"><div class="k">เมตร / tick</div><div class="v">${mPerTick.toFixed(5)}</div></div>
    <div class="tf-kpi"><div class="k">PPR เฉลี่ย</div><div class="v">${meanPpr} ×${meanCh}</div></div>
  `;
}

// ══ Generator: odom_config.json ══
function tfBuildOdomConfig() {
  const o = tf.odom;
  const cfg = {
    pattern: o.pattern,
    base_frame: tfPkgRootName(),
    odom_frame: 'odom',
    wheels: o.wheels.map(w => ({
      name: w.name, type: w.type, x: w.x, y: w.y, radius: w.radius,
      ppr: w.ppr, channels: w.channels, invert: w.invert, beta_deg: tfBeta(w, o.pattern),
    })),
  };
  return JSON.stringify(cfg, null, 2);
}

// ══ Generator: wheel_odom.py (self-contained ROS2 node) ══
function tfBuildOdomPy() {
  const o = tf.odom;
  const wheels = o.wheels;
  const baseName = tfPkgRootName();
  const kin = tfKinematics(wheels, o.pattern);
  // IK matrix A (N×3): row = [cosβ, sinβ, x·sinβ − y·cosβ]
  const A = wheels.map(w => {
    const b = tfBeta(w, o.pattern) * Math.PI / 180;
    const cb = Math.cos(b), sb = Math.sin(b);
    return [+cb.toFixed(6), +sb.toFixed(6), +(w.x * sb - w.y * cb).toFixed(6)];
  });
  let fkMode = 'matrix', FK = null, TRACK = kin.track.toFixed(4);
  if (o.pattern === 'differential' || o.pattern === 'skid') {
    fkMode = 'skid';
  } else {
    try { FK = tfPinv33(A); } catch (e) { fkMode = 'skid'; FK = null; }
  }
  const wheelsPy = wheels.map(w => {
    const b = tfBeta(w, o.pattern);
    return `  ('${w.name}', '${w.type}', ${w.x}, ${w.y}, ${w.radius}, ${w.ppr}, ${w.channels}, ${w.invert}, ${b}),`;
  }).join('\n');
  const fkPy = (FK ? FK.map(r => '  [' + r.map(v => v.toFixed(6)).join(', ') + '],').join('\n') : '  # skid mode (ใช้สูตร left/right แทน matrix)');
  const urdf = tfBuildURDF();
  return `#!/usr/bin/env python3
# wheel_odom.py — GENERATED by Robot Config → Odometry (ห้ามแก้มือเอง) — package: sim_robot_odom
# Pattern: ${o.pattern} | Base frame: ${baseName} | Wheels: ${wheels.length}
# Kinematics ถูกคำนวณอัตโนมัติจากโมเดล TF (ตำแหน่งล้อ + รัศมี + PPR ของ encoder)
import math, time
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from geometry_msgs.msg import TransformStamped, Twist
from tf2_ros import TransformBroadcaster, StaticTransformBroadcaster
from nav_msgs.msg import Odometry
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String

BE = QoSProfile(depth=10, reliability=QoSReliabilityPolicy.BEST_EFFORT)
ST = QoSProfile(depth=10, reliability=QoSReliabilityPolicy.RELIABLE, durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)
CMD_TIMEOUT = 0.5   # วินาที — หยุดหุ่นถ้าไม่ได้รับ /cmd_vel ใหม่ (กันหุ่นวิ่งทิ้ง)
DT = 0.05

PATTERN = '${o.pattern}'
BASE_FRAME = '${baseName}'
ODOM_FRAME = 'odom'
FK_MODE = '${fkMode}'
TRACK = ${TRACK}
# WHEELS: (name, type, x, y, radius, ppr, channels, invert, beta_deg)
WHEELS = [
${wheelsPy}
]
# FK matrix (pseudoinverse ของ IK) — ใช้เมื่อ FK_MODE == 'matrix'
FK_MAT = [
${fkPy}
]
URDF = r'''${urdf}'''
WALLS = [(-4,-4,4,-4),(4,-4,4,4),(4,4,-4,4),(-4,4,-4,-4),
         (-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,1),(2.5,-3,2.5,-1)]
# ── โหลดแผนที่จาก ~/map.json (ถ้ามี) → กำแพง/จุดเริ่ม ของ simulation ──
_MAP_START=(0.0,0.0)
try:
    import json as _json, os as _os
    with open(_os.path.expanduser('~/map.json')) as _mf:
        _map=_json.load(_mf)
    _w=_map.get('walls') or []
    if _w:
        WALLS=[(float(w[0]),float(w[1]),float(w[2]),float(w[3])) for w in _w]
    else:
        _b=_map.get('bounds')
        if _b:
            WALLS=[(_b[0],_b[1],_b[2],_b[1]),(_b[2],_b[1],_b[2],_b[3]),(_b[2],_b[3],_b[0],_b[3]),(_b[0],_b[3],_b[0],_b[1])]
    _s=_map.get('start')
    if _s: _MAP_START=(float(_s[0]),float(_s[1]))
except Exception:
    pass

def rayCast(ox, oy, ang, maxR):
    best = maxR
    dx, dy = math.cos(ang), math.sin(ang)
    for (x1, y1, x2, y2) in WALLS:
        sx, sy = x2 - x1, y2 - y1
        den = dx * sy - dy * sx
        if abs(den) < 1e-9: continue
        t = ((x1 - ox) * sy - (y1 - oy) * sx) / den
        u = ((x1 - ox) * dy - (y1 - oy) * dx) / den
        if t > 0 and t < best and 0 <= u <= 1: best = t
    return best

class WheelOdom(Node):
    def __init__(self):
        super().__init__('wheel_odom')
        self.br = TransformBroadcaster(self)            # publish /tf เป็น tf2_msgs/msg/TFMessage (มาตรฐาน)
        self.static_br = StaticTransformBroadcaster(self) # publish /tf_static เป็น TFMessage
        self.odom_pub = self.create_publisher(Odometry, '/odom', 10)
        self.scan_pub = self.create_publisher(LaserScan, '/scan', 10)
        self.desc_pub = self.create_publisher(String, '/robot_description', ST)
        self.x, self.y = float(_MAP_START[0]), float(_MAP_START[1])
        self.th = 0.0
        self.ticks = [0.0] * len(WHEELS)
        self.wang = [0.0] * len(WHEELS)
        self.cmd_v = 0.0; self.cmd_vy = 0.0; self.cmd_w = 0.0; self.cmd_t = 0.0
        m = TransformStamped(); m.header.frame_id = 'map'; m.child_frame_id = ODOM_FRAME; m.transform.rotation.w = 1.0; self._mo = m
        bl = TransformStamped(); bl.header.frame_id = BASE_FRAME; bl.child_frame_id = 'laser_frame'
        bl.transform.translation.z = 0.1; bl.transform.rotation.w = 1.0; self._bl = bl
        self.desc_pub.publish(String(data=URDF))
        self.static_br.sendTransform([self._mo, self._bl])
        self.cmd_sub = self.create_subscription(Twist, '/cmd_vel', self.cb_cmd, BE)
        self.create_timer(DT, self.tick)

    def cb_cmd(self, msg):
        self.cmd_v = float(msg.linear.x); self.cmd_vy = float(msg.linear.y); self.cmd_w = float(msg.angular.z)
        self.cmd_t = time.time()

    # Inverse kinematics: (vx, vy, w) → ความเร็วเชิงเส้นของแต่ละล้อ (m/s)
    def ik(self, vx, vy, w):
        out = []
        for (name, typ, x, y, R, ppr, ch, inv, beta) in WHEELS:
            b = math.radians(beta)
            vi = (math.cos(b) * vx + math.sin(b) * vy + w * (x * math.sin(b) - y * math.cos(b))) * inv
            out.append(vi)
        return out

    # Forward kinematics: ความเร็วล้อ → (vx, vy, w) ของฐาน
    def fk(self, wlin):
        if FK_MODE == 'skid':
            # +y = ซ้าย (ROS), -y = ขวา → v_left = vx - w*y, v_right = vx + w*y
            # WHEELS[i][3] คือตำแหน่ง y (index: 0name,1type,2x,3y,4R,...)
            left = [wlin[i] for i in range(len(WHEELS)) if WHEELS[i][3] > 0]
            right = [wlin[i] for i in range(len(WHEELS)) if WHEELS[i][3] < 0]
            l = sum(left) / max(1, len(left)); r = sum(right) / max(1, len(right))
            vx = (l + r) / 2.0; w = (r - l) / TRACK if TRACK > 1e-6 else 0.0; vy = 0.0
            return vx, vy, w
        vx = sum(FK_MAT[0][i] * wlin[i] for i in range(len(WHEELS)))
        vy = sum(FK_MAT[1][i] * wlin[i] for i in range(len(WHEELS)))
        w  = sum(FK_MAT[2][i] * wlin[i] for i in range(len(WHEELS)))
        return vx, vy, w

    def tick(self):
        if time.time() - self.cmd_t <= CMD_TIMEOUT:
            vx, vy, w = self.cmd_v, self.cmd_vy, self.cmd_w
        else:
            vx, vy, w = 0.0, 0.0, 0.0
        wlin = self.ik(vx, vy, w)
        # จำลอง encoder: นับ ticks + มุมล้อ จากความเร็วล้อ (dead-reckoning)
        # หมายเหตุ: index ของ WHEELS คือ (name,type,x,y,radius,ppr,channels,invert,beta)
        #   ⇒ radius=WHEELS[i][4], ppr=WHEELS[i][5], channels=WHEELS[i][6]
        for i, vi in enumerate(wlin):
            R = WHEELS[i][4]; ppr = WHEELS[i][5]; ch = WHEELS[i][6]
            if R <= 0:
                continue
            circ = 2.0 * math.pi * R
            if circ <= 0:
                continue
            self.wang[i] += (vi / R) * DT
            self.ticks[i] += (vi / circ) * ppr * ch * DT
        vx2, vy2, w2 = self.fk(wlin)
        # fallback: ถ้า FK คืนศูนย์ทั้งที่มีคำสั่ง cmd_vel (เช่น วางล้อผิดรูป / ไม่มีล้อซ้าย-ขวา)
        # ให้ใช้ cmd_vel โดยตรงเพื่อให้หุ่นขยับได้เสมอ (กันหุ่นไม่เคลื่อนที่ใน sim)
        if (abs(vx2) + abs(vy2) + abs(w2) < 1e-9) and (abs(vx) + abs(vy) + abs(w) > 1e-9):
            vx2, vy2, w2 = vx, vy, w
        # integrate pose ของฐาน (holonomic: x = vx·cosθ − vy·sinθ, y = vx·sinθ + vy·cosθ)
        self.th += w2 * DT
        self.x += (vx2 * math.cos(self.th) - vy2 * math.sin(self.th)) * DT
        self.y += (vx2 * math.sin(self.th) + vy2 * math.cos(self.th)) * DT
        now = self.get_clock().now().to_msg()
        qz = math.sin(self.th / 2.0); qw = math.cos(self.th / 2.0)
        tf = TransformStamped(); tf.header.stamp = now; tf.header.frame_id = ODOM_FRAME; tf.child_frame_id = BASE_FRAME
        tf.transform.translation.x = self.x; tf.transform.translation.y = self.y
        tf.transform.rotation.z = qz; tf.transform.rotation.w = qw
        self.br.sendTransform(tf)
        o = Odometry(); o.header.stamp = now; o.header.frame_id = ODOM_FRAME; o.child_frame_id = BASE_FRAME
        o.pose.pose.position.x = self.x; o.pose.pose.position.y = self.y
        o.pose.pose.orientation.z = qz; o.pose.pose.orientation.w = qw
        o.twist.twist.linear.x = vx2; o.twist.twist.linear.y = vy2; o.twist.twist.angular.z = w2
        self.odom_pub.publish(o)
        s = LaserScan(); s.header.stamp = now; s.header.frame_id = 'laser_frame'
        s.angle_min = -math.pi; s.angle_max = math.pi; s.angle_increment = 2.0 * math.pi / 360.0
        s.range_min = 0.1; s.range_max = 12.0
        s.ranges = [float(rayCast(self.x, self.y, self.th + a, s.range_max)) for a in
                    [s.angle_min + i * s.angle_increment for i in range(360)]]
        self.scan_pub.publish(s)

def main(args=None):
    rclpy.init(args=args)
    node = WheelOdom()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try: node.destroy_node()
        except Exception: pass
        rclpy.shutdown()

if __name__ == '__main__':
    main()
`;
}

// ══ Save + Run ══
async function tfOdomGenerate() {
  if (!tf.odom.wheels.length) { sbMsg('ไม่พบล้อในโมเดล'); return; }
  if (!sessionId) { sbMsg('ต้องเชื่อมต่อหุ่นก่อน'); return; }
  const files = tfOdomPackageFiles();   // แพ็กเกจ sim_robot_odom เต็มรูปแบบ (เหมือน TF)
  try {
    const r = await API('/api/sim/save-odom-package', { sessionId, files });
    if (r && r.ok) { sbMsg('✅ Generate โหนด odom แล้ว (' + r.written.length + ' ไฟล์ → sim_robot_odom)'); tfOdomSave(); }
    else sbMsg('Generate ไม่สำเร็จ: ' + ((r && r.error) || ''));
  } catch (e) { sbMsg('Generate error: ' + e.message); }
}

async function tfOdomRun() {
  if (!sessionId) { sbMsg('ต้องเชื่อมต่อหุ่นก่อน'); return; }
  if (!tf.odom.wheels.length) { sbMsg('ยังไม่มีล้อ — เพิ่มล้อแล้วตั้งค่า Odometry ก่อน'); tfOpenOdom(); return; }
  await tfOdomGenerate();   // regenerate + save แพ็กเกจจากดีไซน์ปัจจุบัน (รันได้เลยแม้ยังไม่กด Save All)
  // ฆ่า generic box (SIM_STATE_PUB) + wheel_odom เก่า ก่อนรัน → ให้ wheel_odom เป็น node เดียวที่ publish /odom + /robot_description (กันซ้อน/ชน type)
  const cmd = `bash -lc 'pkill -f "_sim_state_pub[.]py" 2>/dev/null; pkill -f "wheel_odom" 2>/dev/null; SRC=$(ls -1 /opt/ros 2>/dev/null | tail -1); [ -n "$SRC" ] && source /opt/ros/$SRC/setup.bash 2>/dev/null; setsid python3 ~/src/sim_robot_odom/scripts/wheel_odom > ~/tmp/wheel_odom.log 2>&1 < /dev/null & echo started; sleep 1.5; if pgrep -f "scripts/wheel_odom" >/dev/null 2>&1; then echo ODOM_OK; else echo ODOM_FAIL; echo "---- wheel_odom.log ----"; tail -n 25 ~/tmp/wheel_odom.log; fi'`;
  try {
    const r = await API('/api/exec', { sessionId, command: cmd, timeout: 12000 });
    const out = (r && r.stdout) || '';
    if (r && r.ok && out.indexOf('ODOM_OK') >= 0) {
      sbMsg('▶ หุ่นรันใน Sim แล้ว (wheel_odom) — สลับไป RViz: ส่ง /cmd_vel หุ่นจะเดิน + มี /odom ตามค่าล้อที่ตั้ง');
      switchPage('rviz'); initRviz();   // ปิดลูป design → see: เห็นหุ่นเดินถูกต้อง
    }
    else if (out.indexOf('ODOM_FAIL') >= 0) sbMsg('⚠️ wheel_odom เริ่มไม่ได้: ' + out.split('ODOM_FAIL')[1].replace(/^[\s\-]*wheel_odom\.log[\s\-]*/, '').trim().slice(0, 800));
    else if (r && r.ok) sbMsg('▶ รัน wheel_odom ใน sim แล้ว (sim_robot_odom)');
    else sbMsg('Run ไม่สำเร็จ: ' + ((r && r.error) || ''));
  } catch (e) { sbMsg('Run error: ' + e.message); }
}
function tfOdomStopGeneric() {
  if (!sessionId) return;
  API('/api/exec', { sessionId, command: `bash -lc "pkill -f '_sim_state_sub[.]py' 2>/dev/null; true"`, timeout: 5000 })
    .then(() => sbMsg('⏹ หยุด generic state publisher แล้ว')).catch(e => sbMsg('error: ' + e.message));
}
function tfOdomStopOdom() {
  if (!sessionId) return;
  API('/api/exec', { sessionId, command: `bash -lc "pkill -f 'scripts/wheel_odom' 2>/dev/null; true"`, timeout: 5000 })
    .then(() => sbMsg('⏹ หยุด wheel_odom แล้ว')).catch(e => sbMsg('error: ' + e.message));
}

// ================================
