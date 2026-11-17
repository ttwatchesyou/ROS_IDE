'use strict';
// ═══════════════════════════════════════════════════════════════
//  3D COMPONENT BUILDER — โปรแกรมสร้างชิ้นงาน 3D แบบ CAD
//  ประกอบ primitive หลายชิ้น (box/cylinder/sphere/cone/lidar/camera)
//  เป็น component เดียว → เซฟเข้า Custom Library ของ user
//  → นำไปต่อใช้ในหน้า Transformation (TF) ได้
//  Convention พิกัดเดียวกับ transformation.js: r2t(x,y,z)=(y,z,x)
// ═══════════════════════════════════════════════════════════════

// ── coord conversion (ROS → Three) ── (เหมือน transformation.js)
function dc_r2t(x, y, z) { return new THREE.Vector3(y, z, x); }
function dcRosToQuat(rDeg, pDeg, yDeg) {
  const r = THREE.MathUtils.degToRad(rDeg), p = THREE.MathUtils.degToRad(pDeg), y = THREE.MathUtils.degToRad(yDeg);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r, p, y, 'ZYX'));
  return new THREE.Quaternion(q.y, q.z, q.x, q.w).normalize();
}
function dcT2RPos(p) { return { x: p.z, y: p.x, z: p.y }; }
function dcT2RRpy(q) {
  const rq = new THREE.Quaternion(q.z, q.x, q.y, q.w);
  const e = new THREE.Euler().setFromQuaternion(rq, 'ZYX');
  return { r: THREE.MathUtils.radToDeg(e.x), p: THREE.MathUtils.radToDeg(e.y), y: THREE.MathUtils.radToDeg(e.z) };
}

// ── state ──
const dc = {
  renderer: null, scene: null, camera: null, perspCam: null, orthoCam: null,
  proj: 'perspective',
  ready: false,
  parts: [], selected: null, _nid: 1,
  transformControls: null, gizmoMode: 'translate',
  editingId: null,   // ถ้ากำลังแก้ไข component ที่มีอยู่แล้ว
  holes: [],          // รายการหลุม (array of hole objects)
  cam: { theta: Math.PI / 4, phi: Math.PI / 3, radius: 1.2, target: { x: 0, y: 0, z: 0 }, drag: false, rightDrag: false, lx: 0, ly: 0 },
  container: null, ray: null,
};

// primitive shapes ที่เลือกได้
const dcShapeMeta = {
  box:      { label: 'Box',      icon: '📦', defaults: { sx: 0.1, sy: 0.1, sz: 0.1 } },
  cylinder: { label: 'Cylinder', icon: '🔵', defaults: { radius: 0.05, height: 0.1 } },
  sphere:   { label: 'Sphere',   icon: '🔴', defaults: { radius: 0.05 } },
  cone:     { label: 'Cone',     icon: '🔺', defaults: { radius: 0.05, height: 0.1 } },
  lidar:    { label: 'Lidar',    icon: '📡', defaults: { radius: 0.05, height: 0.12 } },
  camera:   { label: 'Camera',   icon: '🎥', defaults: { w: 0.06, h: 0.04, d: 0.04 } },
};

// hole shapes ที่เจาะได้ (Tinkercad-style)
const dcHoleShapes = {
  circle:   { label: 'Circle',   icon: '🔵', defaults: { radius: 0.05, depth: 0.2 } },
  square:   { label: 'Square',   icon: '▭', defaults: { size: 0.05, depth: 0.2 } },
  rectangle:{ label: 'Rectangle',icon: '▯', defaults: { width: 0.1, height: 0.05, depth: 0.2 } },
  triangle: { label: 'Triangle', icon: '🔺', defaults: { radius: 0.05, depth: 0.2 } },
  pentagon: { label: 'Pentagon', icon: '🟠', defaults: { radius: 0.05, depth: 0.2 } },
  hexagon:  { label: 'Hexagon',  icon: '🟡', defaults: { radius: 0.05, depth: 0.2 } },
  slot:     { label: 'Slot',     icon: '▰', defaults: { width: 0.15, height: 0.03, depth: 0.2 } },
};

// ── persistence: Custom Library ต่อ user (ใช้ key เดียวกับ transformation.js) ──
function dcCurrentUser() {
  try { const u = localStorage.getItem('ros2ide_username'); if (u) return u; } catch (e) {}
  return (typeof sessionId !== 'undefined' && sessionId) ? sessionId : 'default';
}
function dcCustomKey() { return 'tf_custom_' + dcCurrentUser(); }
function dcLoadLibrary() {
  try { const a = JSON.parse(localStorage.getItem(dcCustomKey())); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function dcSaveLibrary(arr) {
  try { localStorage.setItem(dcCustomKey(), JSON.stringify(arr || [])); return true; }
  catch (e) { alert('บันทึกคลังไม่ได้ พื้นที่จัดเก็บของเบราว์เซอร์อาจเต็ม กรุณาเก็บงานเดิมไว้แล้วลองอีกครั้ง'); return false; }
}

// ── geometry ──
function dcMat(color) { return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 }); }

// สร้าง mesh ของ primitive 1 ชิ้น (คืน THREE.Mesh) — พิกัด geometry อ้าง ROS
function dcBuildPartMesh(part) {
  const P = part.params, mat = dcMat(part.color);
  let geo;
  if (part.shape === 'box') {
    geo = new THREE.BoxGeometry(P.sy, P.sz, P.sx);          // ROS x=len→Three z
  } else if (part.shape === 'cylinder' || part.shape === 'lidar') {
    geo = new THREE.CylinderGeometry(P.radius, P.radius, P.height, 28);
  } else if (part.shape === 'sphere') {
    geo = new THREE.SphereGeometry(P.radius, 28, 20);
  } else if (part.shape === 'cone') {
    geo = new THREE.ConeGeometry(P.radius, P.height, 28);
  } else if (part.shape === 'camera') {
    geo = new THREE.BoxGeometry(P.d, P.h, P.w);
  } else {
    geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  }
  const m = new THREE.Mesh(geo, mat);
  m.userData.partId = part.id;
  return m;
}

// ── scene graph ──
function dcBuildScene() {
  if (!dc.scene) return;
  // ลบ group เดิม
  dc.parts.forEach(p => { if (p._grp) { dc.scene.remove(p._grp); p._grp = null; } });
  // ลบ hole helpers เดิม
  dc.holes.forEach(h => { if (h._mesh) { dc.scene.remove(h._mesh); h._mesh = null; } });
  dc.parts.forEach(p => {
    const g = new THREE.Group();
    g.add(dcBuildPartMesh(p));
    g.position.copy(dc_r2t(p.pos.x, p.pos.y, p.pos.z));
    g.quaternion.copy(dcRosToQuat(p.rpy.r, p.rpy.p, p.rpy.y));
    g.userData.partId = p.id;
    p._grp = g;
    dc.scene.add(g);
  });
  // วาด hole helpers (world space = group world * local hole)
  dc.holes.forEach(h => {
    const parent = dc.parts.find(p => p.id === h.parentId);
    const m = dcBuildHoleMesh(h);
    if (parent && parent._grp) { m.position.copy(parent._grp.position).add(m.position); m.quaternion.copy(parent._grp.quaternion).multiply(m.quaternion); }
    h._mesh = m;
    dc.scene.add(m);
  });
  // ต่อ gizmo กับชิ้นที่เลือก (หรือ hole ที่เลือก)
  if (dc.transformControls) {
    const hole = dc.holes.find(h => h.id === dc.selectedHole);
    if (hole && hole._mesh) dc.transformControls.attach(hole._mesh);
    else {
      const sel = dc.parts.find(p => p.id === dc.selected);
      if (sel && sel._grp) dc.transformControls.attach(sel._grp);
      else dc.transformControls.detach();
    }
  }
}

function dcSyncGroup(p) {
  if (!p._grp) { dcBuildScene(); return; }
  p._grp.position.copy(dc_r2t(p.pos.x, p.pos.y, p.pos.z));
  p._grp.quaternion.copy(dcRosToQuat(p.rpy.r, p.rpy.p, p.rpy.y));
  const old = p._grp.children.find(o => o.userData && o.userData.partId === p.id);
  if (old) { p._grp.remove(old); if (old.geometry) old.geometry.dispose(); }
  p._grp.add(dcBuildPartMesh(p));
}

// ── parts CRUD ──
function dcUniqueName(shape) {
  let i = 1, nm; const taken = new Set(dc.parts.map(p => p.name));
  do { nm = shape + '_' + i++; } while (taken.has(nm));
  return nm;
}
function dcAddPart(shape) {
  const meta = dcShapeMeta[shape]; if (!meta) return;
  const p = {
    id: 'p' + (dc._nid++), shape, name: dcUniqueName(shape),
    params: JSON.parse(JSON.stringify(meta.defaults)),
    pos: { x: 0, y: 0, z: 0 }, rpy: { r: 0, p: 0, y: 0 },
    color: 0x4f8ef7, _grp: null,
  };
  dc.parts.push(p);
  dcAfterChange();
  dcSelect(p.id);
}
function dcDeletePart(id) {
  const p = dc.parts.find(x => x.id === id); if (!p) return;
  if (!window.confirm('ลบชิ้นส่วน "' + p.name + '" ?')) return;
  dc.parts = dc.parts.filter(x => x.id !== id);
  if (dc.selected === id) dc.selected = null;
  dcAfterChange();
}
function dcDuplicatePart(id) {
  const p = dc.parts.find(x => x.id === id); if (!p) return;
  const c = JSON.parse(JSON.stringify({ shape: p.shape, params: p.params, pos: p.pos, rpy: p.rpy, color: p.color }));
  c.id = 'p' + (dc._nid++); c.name = dcUniqueName(p.shape); c._grp = null;
  c.pos.x += 0.05;
  dc.parts.push(c);
  dcAfterChange();
  dcSelect(c.id);
}

function dcSelect(id) {
  dc.selected = id;
  dc.selectedHole = null;
  dcBuildScene();
  dcRenderParts();
  dcRenderProps();
}
function dcSelectHole(id) {
  dc.selectedHole = id;
  dc.selected = null;
  dcBuildScene();
  dcRenderProps();
}

function dcAfterChange() {
  dcBuildScene();
  dcRenderParts();
}

// ── camera controls (custom orbit เหมือน transformation.js) ──
function dcBindCam(el) {
  el.addEventListener('mousedown', e => {
    if (dc.transformControls && (dc.transformControls.axis || dc.transformControls.dragging)) return;
    dc.cam.drag = true; dc.cam.rightDrag = (e.button === 2 || e.button === 1);
    dc.cam.lx = e.clientX; dc.cam.ly = e.clientY;
  });
  window.addEventListener('mouseup', () => { dc.cam.drag = false; });
  window.addEventListener('mousemove', e => {
    if (!dc.cam.drag) return;
    if (dc.transformControls && dc.transformControls.dragging) return;
    const dx = e.clientX - dc.cam.lx, dy = e.clientY - dc.cam.ly;
    dc.cam.lx = e.clientX; dc.cam.ly = e.clientY;
    if (dc.cam.rightDrag) {
      const s = dc.cam.radius * 0.002;
      dc.cam.target.x -= dx * s; dc.cam.target.z -= dy * s;
    } else {
      dc.cam.theta -= dx * 0.012;
      dc.cam.phi = Math.max(0.02, Math.min(Math.PI - 0.02, dc.cam.phi - dy * 0.012));
    }
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    dc.cam.radius = Math.max(0.1, Math.min(50, dc.cam.radius * (1 + Math.sign(e.deltaY) * 0.1)));
  }, { passive: false });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => {
    if (dc.transformControls && (dc.transformControls.axis || dc.transformControls.dragging)) return;
    if (!dc.ray || !dc.camera) return;
    const r = el.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    dc.ray.setFromCamera(new THREE.Vector2(nx, ny), dc.camera);
    const hits = dc.ray.intersectObjects(dc.scene.children, true);
    for (const h of hits) {
      // hole helper first (userData.holeId)
      let hole = h.object;
      while (hole && !(hole.userData && hole.userData.holeId)) hole = hole.parent;
      if (hole && hole.userData.holeId) { dcSelectHole(hole.userData.holeId); return; }
      let o = h.object;
      while (o && !(o.userData && o.userData.partId)) o = o.parent;
      if (o && o.userData.partId) { dcSelect(o.userData.partId); return; }
    }
  });
}
function dcCamUpdate() {
  const c = dc.camera; if (!c) return;
  const { theta, phi, radius, target } = dc.cam;
  c.position.set(
    target.x + radius * Math.sin(phi) * Math.cos(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.sin(theta)
  );
  c.lookAt(target.x, target.y, target.z);
}

// ── View controls (mirrors transformation.js) ──
function dcAnimateCam(toTheta, toPhi, toRadius, toTarget) {
  const s = {
    theta: dc.cam.theta, phi: dc.cam.phi, radius: dc.cam.radius,
    tx: dc.cam.target.x, ty: dc.cam.target.y, tz: dc.cam.target.z,
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
    const k = 1 - Math.pow(1 - t, 3);
    dc.cam.theta = s.theta + (e.theta - s.theta) * k;
    dc.cam.phi = s.phi + (e.phi - s.phi) * k;
    dc.cam.radius = s.radius + (e.radius - s.radius) * k;
    dc.cam.target.x = s.tx + (e.tx - s.tx) * k;
    dc.cam.target.y = s.ty + (e.ty - s.ty) * k;
    dc.cam.target.z = s.tz + (e.tz - s.tz) * k;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function dcSetView(view) {
  const r = dc.cam.radius;
  const tgt = dc.cam.target;
  const presets = {
    top:     { theta: 0,            phi: 0.001 },
    bottom:  { theta: 0,            phi: Math.PI - 0.001 },
    front:   { theta: -Math.PI / 2, phi: Math.PI / 2 },
    back:    { theta: Math.PI / 2,  phi: Math.PI / 2 },
    left:    { theta: 0,            phi: Math.PI / 2 },
    right:   { theta: Math.PI,      phi: Math.PI / 2 },
    iso:     { theta: Math.PI / 4, phi: Math.PI / 3 },
  };
  const p = presets[view] || presets.iso;
  dcAnimateCam(p.theta, p.phi, r, tgt);
  document.querySelectorAll('#dc-view-bar .dc-view-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
}
function dcResetView() { dcSetView('iso'); }

function dcSetProjection(proj) {
  if (dc.proj === proj) return;
  dc.proj = proj;
  const cam = proj === 'iso' ? dc.orthoCam : dc.perspCam;
  dc.camera = cam;
  if (dc.transformControls) {
    try { dc.transformControls.camera = cam; } catch (e) {}
    const sel = dc.parts.find(x => x.id === dc.selected);
    if (sel && sel._grp) { dc.transformControls.detach(); dc.transformControls.attach(sel._grp); }
    else dc.transformControls.detach();
  }
  document.querySelectorAll('#dc-view-bar .tf-proj-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.proj === proj));
  dcCamUpdate();
}

// ── Hole punching (TinkerCAD-style CSG) ──
function dcOpenHoleModal() {
  const m = document.getElementById('dc-hole-modal');
  if (m) m.style.display = 'flex';
  dcRenderHoleShapes();
}
function dcCloseHoleModal() {
  const m = document.getElementById('dc-hole-modal');
  if (m) m.style.display = 'none';
}

function dcRenderHoleShapes() {
  const el = document.getElementById('dc-hole-shapes');
  if (!el) return;
  let sel = dc._holeShape || 'circle';
  el.innerHTML = Object.keys(dcHoleShapes).map(k => {
    const sh = dcHoleShapes[k];
    return `<button class="tf-comp-btn ${k === sel ? 'tf-comp-special' : ''}" onclick="dcPickHoleShape('${k}')"
      style="padding:10px 6px;font-size:11px">
      <span style="font-size:20px;display:block;margin-bottom:4px">${sh.icon}</span>${sh.label}
    </button>`;
  }).join('');
}

function dcPickHoleShape(k) {
  dc._holeShape = k;
  const sh = dcHoleShapes[k];
  const rEl = document.getElementById('dc-hole-radius');
  const wEl = document.getElementById('dc-hole-width');
  const hEl = document.getElementById('dc-hole-height');
  const dEl = document.getElementById('dc-hole-depth');
  if (rEl) rEl.value = (sh.defaults.radius !== undefined ? sh.defaults.radius : (sh.defaults.size || 0.05)).toFixed(3);
  if (wEl) wEl.value = (sh.defaults.width || 0.05).toFixed(3);
  if (hEl) hEl.value = (sh.defaults.height || 0.05).toFixed(3);
  if (dEl) dEl.value = (sh.defaults.depth || 0.2).toFixed(3);
  dcRenderHoleShapes();
}

// Build geometry for a hole shape (returns THREE.BufferGeometry, centered on origin, axis along Y)
function dcBuildHoleGeometry(shape, params) {
  switch (shape) {
    case 'square': {
      const s = params.size || 0.05;
      return new THREE.BoxGeometry(s, params.depth || 0.2, s);
    }
    case 'rectangle': {
      const w = params.width || 0.1;
      const h = params.height || 0.05;
      return new THREE.BoxGeometry(w, params.depth || 0.2, h);
    }
    case 'slot': {
      // Slot = capsule shape (rounded rectangle) - approximate with cylinder + box
      const w = params.width || 0.15;
      const h = params.height || 0.03;
      const d = params.depth || 0.2;
      // Use CylinderGeometry for the rounded ends + Box for middle
      // For simplicity, use a capsule-like cylinder (radius = h/2)
      return new THREE.CylinderGeometry(h / 2, h / 2, d, 24);
    }
    case 'triangle':
    case 'pentagon':
    case 'hexagon': {
      const n = shape === 'triangle' ? 3 : shape === 'pentagon' ? 5 : 6;
      const r = params.radius || 0.05;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / n;
        pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
      }
      const shapeGeo = new THREE.Shape(pts);
      const geo = new THREE.ExtrudeGeometry(shapeGeo, { depth: params.depth || 0.2, bevelEnabled: false });
      geo.translate(0, 0, -params.depth / 2);
      return geo;
    }
    case 'circle':
    default: {
      const r = params.radius || 0.05;
      return new THREE.CylinderGeometry(r, r, params.depth || 0.2, 28);
    }
  }
}

// Hole data object -> mesh (semi-transparent red)
function dcBuildHoleMesh(hole) {
  const geo = dcBuildHoleGeometry(hole.shape, hole.params);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff4444, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(hole.pos.x, hole.pos.y, hole.pos.z);
  m.quaternion.copy(dcRosToQuat(hole.rpy.r, hole.rpy.p, hole.rpy.y));
  m.userData.holeId = hole.id;
  return m;
}

// sync a hole transform from its mesh back into the data object (local space)
function dcSyncHole(hole) {
  if (!hole._mesh) { dcBuildScene(); return; }
  const parent = dc.parts.find(p => p.id === hole.parentId);
  const localPos = parent && parent._grp
    ? hole._mesh.position.clone().sub(parent._grp.position)
    : hole._mesh.position.clone();
  const localQuat = parent && parent._grp
    ? parent._grp.quaternion.clone().invert().multiply(hole._mesh.quaternion)
    : hole._mesh.quaternion.clone();
  hole.pos.x = +localPos.x.toFixed(3); hole.pos.y = +localPos.y.toFixed(3); hole.pos.z = +localPos.z.toFixed(3);
  const rpy = dcT2RRpy(localQuat);
  hole.rpy.r = +rpy.r.toFixed(1); hole.rpy.p = +rpy.p.toFixed(1); hole.rpy.y = +rpy.y.toFixed(1);
}

function dcSyncPropInputsForHole(hole) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = (v == null ? '' : v); };
  set('dc-h-x', hole.pos.x); set('dc-h-y', hole.pos.y); set('dc-h-z', hole.pos.z);
  set('dc-h-r', hole.rpy.r); set('dc-h-p', hole.rpy.p); set('dc-h-yaw', hole.rpy.y);
  // shape-specific params
  const P = hole.params;
  set('dc-h-radius', P.radius);
  set('dc-h-size', P.size);
  set('dc-h-width', P.width);
  set('dc-h-height', P.height);
  set('dc-h-depth', P.depth);
}

// update a hole's helper mesh IN PLACE (size + transform) so edits reflect live
function dcSyncHoleMesh(hole) {
  if (!hole._mesh) { dcBuildScene(); return; }
  const parent = dc.parts.find(p => p.id === hole.parentId);
  const geo = dcBuildHoleGeometry(hole.shape, hole.params);
  const old = hole._mesh.geometry;
  hole._mesh.geometry = geo;
  if (old && old.dispose) old.dispose();
  // local transform (group transform handled at render time)
  hole._mesh.position.set(hole.pos.x, hole.pos.y, hole.pos.z);
  hole._mesh.quaternion.copy(dcRosToQuat(hole.rpy.r, hole.rpy.p, hole.rpy.y));
  // keep world transform consistent if a parent group exists
  if (parent && parent._grp) {
    hole._mesh.position.copy(parent._grp.position).add(hole._mesh.position);
    hole._mesh.quaternion.copy(parent._grp.quaternion).multiply(hole._mesh.quaternion);
  }
  dcRenderHolesList();
}

function dcDeleteHole(id) {
  const h = dc.holes.find(x => x.id === id); if (!h) return;
  if (!window.confirm('ลบรู "' + (h.shape) + '" ?')) return;
  dc.holes = dc.holes.filter(x => x.id !== id);
  if (dc.selectedHole === id) dc.selectedHole = null;
  dcAfterChange();
  dcRenderProps();
}

function dcAddHoleFromModal() {
  const shape = dc._holeShape || 'circle';
  const meta = dcHoleShapes[shape] || dcHoleShapes.circle;
  const oxEl = document.getElementById('dc-hole-ox');
  const oyEl = document.getElementById('dc-hole-oy');
  const ozEl = document.getElementById('dc-hole-oz');
  const rEl = document.getElementById('dc-hole-r');
  const pEl = document.getElementById('dc-hole-p');
  const yEl = document.getElementById('dc-hole-yaw');
  const ox = oxEl ? parseFloat(oxEl.value) || 0 : 0;
  const oy = oyEl ? parseFloat(oyEl.value) || 0 : 0;
  const oz = ozEl ? parseFloat(ozEl.value) || 0 : 0;
  const r = rEl ? parseFloat(rEl.value) || 0 : 0;
  const p = pEl ? parseFloat(pEl.value) || 0 : 0;
  const y = yEl ? parseFloat(yEl.value) || 0 : 0;
  const hole = {
    id: 'h' + (dc._nid++),
    shape,
    params: JSON.parse(JSON.stringify(meta.defaults)),
    parentId: dc.selected || null,
    pos: { x: ox, y: oy, z: oz },
    rpy: { r, p, y },
  };
  dc.holes.push(hole);
  dc.selectedHole = hole.id;
  dc.selected = null;
  dcCloseHoleModal();
  dcAfterChange();
  dcRenderProps();
  sbMsg('เพิ่มรู ' + shape + ' แล้ว — ลาก gizmo ไปวางตำแหน่ง แล้วกด ✂ Cut');
}

// Apply all holes belonging to the selected part (CSG subtraction)
function dcCutHoles() {
  const sel = dc.parts.find(x => x.id === dc.selected);
  if (!sel) { sbMsg('เลือกชิ้นส่วนก่อนเจาะรู'); return; }
  const myHoles = dc.holes.filter(h => h.parentId === sel.id);
  if (!myHoles.length) { sbMsg('ยังไม่มีรูในชิ้นส่วนนี้ — กด ✂ Hole เพื่อเพิ่ม'); return; }
  if (typeof CSG === 'undefined') { sbMsg('CSG library ไม่โหลดได้'); return; }
  const grp = sel._grp;
  if (!grp) return;
  try {
    // 1) build base solid in WORLD space (group transform + local geometry)
    const baseMesh = dcBuildPartMesh(sel);
    baseMesh.position.copy(grp.position);
    baseMesh.quaternion.copy(grp.quaternion);
    baseMesh.updateMatrixWorld(true);
    const baseWorld = baseMesh.geometry.clone();
    baseWorld.applyMatrix4(baseMesh.matrixWorld);

    // 2) build a hole-solids mesh (union of all holes) in WORLD space
    let holeCSG = null;
    myHoles.forEach(h => {
      const hm = dcBuildHoleMesh(h); // already in part-LOCAL space
      const hWorld = hm.geometry.clone(); // geometry only
      const m = new THREE.Matrix4()
        .copy(grp.matrixWorld)
        .multiply(new THREE.Matrix4().compose(hm.position, hm.quaternion, new THREE.Vector3(1, 1, 1)));
      hWorld.applyMatrix4(m);
      const hCSG = csgFromGeometry(hWorld);
      holeCSG = holeCSG ? CSG.fromPolygons(holeCSG.union(hCSG).toPolygons()) : hCSG;
    });

    // 3) subtract
    const baseCSG = csgFromGeometry(baseWorld);
    const outCSG = baseCSG.subtract(holeCSG);
    const resultGeom = geometryFromCSG(outCSG);

    // 4) replace geometry inside the group (group keeps its transform)
    const old = grp.children.find(o => o.userData && o.userData.partId === sel.id);
    if (old) { grp.remove(old); if (old.geometry && old.geometry.dispose) old.geometry.dispose(); }
    const newMesh = new THREE.Mesh(resultGeom, dcMat(sel.color));
    newMesh.userData.partId = sel.id;
    grp.add(newMesh);

    // 5) remove the hole helpers for this part
    dc.holes = dc.holes.filter(h => h.parentId !== sel.id);
    dc.selectedHole = null;
    dcAfterChange();
    dcRenderProps();
    sbMsg('✅ เจาะรู ' + myHoles.length + ' รูใน "' + sel.name + '" สำเร็จ');
  } catch (e) {
    console.error(e);
    sbMsg('เจาะรูไม่สำเร็จ: ' + e.message);
  }
}



// ── transform gizmo ──
function dcSetupGizmo() {
  if (typeof THREE.TransformControls !== 'function') return false;
  const tc = new THREE.TransformControls(dc.camera, dc.renderer.domElement);
  tc.setSpace('local'); tc.setMode('translate'); tc.setSize(0.8);
  tc.addEventListener('dragging-changed', e => {
    if (e.value) dc.cam.drag = false;
    else {
      const hole = dc.holes.find(h => h.id === dc.selectedHole);
      if (hole) { dcSyncHole(hole); dcRenderProps(); }
      else { const p = dc.parts.find(x => x.id === dc.selected); if (p) { dcSyncGroup(p); dcRenderProps(); } }
    }
  });
  tc.addEventListener('objectChange', () => {
    const hole = dc.holes.find(h => h.id === dc.selectedHole);
    if (hole && hole._mesh) {
      const parent = dc.parts.find(p => p.id === hole.parentId);
      const localPos = parent && parent._grp
        ? hole._mesh.position.clone().sub(parent._grp.position)
        : hole._mesh.position.clone();
      const localQuat = parent && parent._grp
        ? parent._grp.quaternion.clone().invert().multiply(hole._mesh.quaternion)
        : hole._mesh.quaternion.clone();
      hole.pos.x = +localPos.x.toFixed(3); hole.pos.y = +localPos.y.toFixed(3); hole.pos.z = +localPos.z.toFixed(3);
      const rpy = dcT2RRpy(localQuat);
      hole.rpy.r = +rpy.r.toFixed(1); hole.rpy.p = +rpy.p.toFixed(1); hole.rpy.y = +rpy.y.toFixed(1);
      dcSyncPropInputsForHole(hole);
      return;
    }
    const p = dc.parts.find(x => x.id === dc.selected); if (!p || !p._grp) return;
    if (tc.mode === 'translate') {
      const ros = dcT2RPos(p._grp.position);
      p.pos.x = +ros.x.toFixed(3); p.pos.y = +ros.y.toFixed(3); p.pos.z = +ros.z.toFixed(3);
    } else if (tc.mode === 'rotate') {
      const rpy = dcT2RRpy(p._grp.quaternion);
      p.rpy.r = +rpy.r.toFixed(1); p.rpy.p = +rpy.p.toFixed(1); p.rpy.y = +rpy.y.toFixed(1);
    }
    dcSyncPropInputs(p);
  });
  dc.scene.add(tc);
  dc.transformControls = tc;
  return true;
}
function dcSetGizmoMode(mode) {
  dc.gizmoMode = mode;
  if (dc.transformControls) dc.transformControls.setMode(mode);
  document.querySelectorAll('#dc-gizmo-bar button[data-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
}

// ── init Three.js ──
async function dcInitThree() {
  const c = document.getElementById('dc-3d-container'); if (!c) return;
  dc.container = c;
  dc.renderer = new THREE.WebGLRenderer({ antialias: true });
  dc.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  dc.renderer.setClearColor(0x161a22, 1);
  dc.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;outline:none;cursor:grab';
  c.appendChild(dc.renderer.domElement);
  dc.scene = new THREE.Scene();
  const W = c.offsetWidth || 800, H = c.offsetHeight || 600;
  dc.perspCam = new THREE.PerspectiveCamera(45, W / H, 0.01, 1000);
  dc.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  dc.camera = dc.perspCam;
  dc.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(3, 8, 5); dc.scene.add(dl);
  dc.scene.add(new THREE.GridHelper(1, 20, 0x394150, 0x262d3a));
  const ax = new THREE.AxesHelper(0.25); dc.scene.add(ax);
  dc.ray = new THREE.Raycaster();
  dcBindCam(dc.renderer.domElement);
  dcSetupGizmo();
  new ResizeObserver(dcResize).observe(c);
  (function loop() {
    requestAnimationFrame(loop);
    dcCamUpdate();
    dc.renderer.render(dc.scene, dc.camera);
  })();
  dc.ready = true;
  dcRenderPalette();
  dcAfterChange();
  dcRenderProps();
}
function dcResize() {
  if (!dc.renderer || !dc.container) return;
  const W = dc.container.offsetWidth || 800, H = dc.container.offsetHeight || 600;
  dc.renderer.setSize(W, H, false);
  if (dc.perspCam) { dc.perspCam.aspect = W / H; dc.perspCam.updateProjectionMatrix(); }
  if (dc.orthoCam) {
    const halfH = dc.cam.radius * Math.tan(THREE.MathUtils.degToRad(45) / 2);
    dc.orthoCam.left = -halfH * (W / H); dc.orthoCam.right = halfH * (W / H);
    dc.orthoCam.top = halfH; dc.orthoCam.bottom = -halfH;
    dc.orthoCam.updateProjectionMatrix();
  }
}

// entry point เรียกจากเมนู
function init3DComponent() {
  if (dc.renderer) { dcResize(); dcRenderPalette(); dcRenderParts(); dcRenderProps(); dcRenderLibrary(); return; }
  const boot = () => {
    if (typeof THREE !== 'undefined' && typeof THREE.TransformControls === 'function') { dcInitThree(); dcRenderLibrary(); return; }
    // โหลด TransformControls ถ้ายังไม่มี
    if (typeof THREE !== 'undefined' && typeof THREE.TransformControls !== 'function') {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js';
      s2.onload = () => { dcInitThree(); dcRenderLibrary(); };
      s2.onerror = () => { dcInitThree(); dcRenderLibrary(); };
      document.head.appendChild(s2);
    }
  };
  if (typeof THREE !== 'undefined') { boot(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  s.onload = boot;
  s.onerror = () => { if (typeof sbMsg === 'function') sbMsg('โหลด Three.js ไม่ได้ (ต้องมีอินเทอร์เน็ต)'); };
  document.head.appendChild(s);
}

// ── UI: palette (ปุ่มเพิ่ม primitive) ──
function dcRenderPalette() {
  const el = document.getElementById('dc-palette'); if (!el) return;
  el.innerHTML = Object.keys(dcShapeMeta).map(k =>
    `<button class="dc-add-btn" onclick="dcAddPart('${k}')"><span class="dc-ico">${dcShapeMeta[k].icon}</span><span>+ ${dcShapeMeta[k].label}</span></button>`
  ).join('');
}

// ── UI: รายการชิ้นส่วน ──
function dcRenderParts() {
  const el = document.getElementById('dc-parts'); if (!el) return;
  if (!dc.parts.length) { el.innerHTML = '<div class="dc-empty">ยังไม่มีชิ้นส่วน — กด + เพิ่มด้านบน</div>'; return; }
  let html = '';
  dc.parts.forEach(p => {
    const sel = p.id === dc.selected ? ' dc-part-sel' : '';
    html += `<div class="dc-part${sel}" onclick="dcSelect(decodeURIComponent('${encArg(p.id)}'))">
      <span class="dc-ico">${dcShapeMeta[p.shape] ? dcShapeMeta[p.shape].icon : '◆'}</span>
      <span class="dc-part-nm">${escDC(p.name)}</span>
      <span class="dc-part-act" onclick="event.stopPropagation();dcDuplicatePart(decodeURIComponent('${encArg(p.id)}'))" title="Duplicate">⧉</span>
      <span class="dc-part-act" onclick="event.stopPropagation();dcDeletePart(decodeURIComponent('${encArg(p.id)}'))" title="Delete">🗑</span>
    </div>`;
    // hole sub-items for this part
    const hs = dc.holes.filter(h => h.parentId === p.id);
    hs.forEach(h => {
      const hsel = h.id === dc.selectedHole ? ' dc-part-sel' : '';
      const ico = dcHoleShapes[h.shape] ? dcHoleShapes[h.shape].icon : '✂';
      html += `<div class="dc-part${hsel}" style="padding-left:22px;font-size:11px" onclick="dcSelectHole(decodeURIComponent('${encArg(h.id)}'))">
        <span class="dc-ico" style="opacity:.7">${ico}</span>
        <span class="dc-part-nm">รู ${escDC(h.shape)}</span>
        <span class="dc-part-act" onclick="event.stopPropagation();dcDeleteHole(decodeURIComponent('${encArg(h.id)}'))" title="ลบรู">🗑</span>
      </div>`;
    });
  });
  el.innerHTML = html;
}
// sync the parts list (called after any hole edit)
function dcRenderHolesList() { dcRenderParts(); }

function escDC(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── UI: properties panel ──
function dcSyncPropInputs(p) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = (v == null ? '' : v); };
  set('dc-p-x', p.pos.x); set('dc-p-y', p.pos.y); set('dc-p-z', p.pos.z);
  set('dc-p-r', p.rpy.r); set('dc-p-p', p.rpy.p); set('dc-p-yaw', p.rpy.y);
}
function dcRenderProps() {
  const el = document.getElementById('dc-props'); if (!el) return;

  // ── Hole selected? show hole editor ──
  const h = dc.holes.find(x => x.id === dc.selectedHole);
  if (h) {
    const selShape = dcHoleShapes[h.shape] ? dcHoleShapes[h.shape].label : h.shape;
    el.innerHTML = `
      <div class="dc-props-head">✂ รู ${escDC(selShape)} <span style="color:var(--dim);font-weight:400">(${escDC(h.shape)})</span></div>
      <div class="dc-sec">รูปทรง</div>
      <div class="tf-grid2">
        <div><label>รัศมี/ขนาด (m)</label><input id="dc-h-radius" type="number" step="0.005" value="${h.shape === 'rectangle' ? h.params.width : h.shape === 'slot' ? h.params.width : h.params.radius !== undefined ? h.params.radius : h.params.size || 0.05}"></div>
        <div><label>ความลึก (m)</label><input id="dc-h-depth" type="number" step="0.01" value="${h.params.depth || 0.2}"></div>
      </div>
      <div class="dc-sec">ตำแหน่ง (Local)</div>
      <div class="dc-grid3">
        <div><label class="ax-x">X</label><input id="dc-h-x" type="number" step="0.01" value="${h.pos.x}"></div>
        <div><label class="ax-y">Y</label><input id="dc-h-y" type="number" step="0.01" value="${h.pos.y}"></div>
        <div><label class="ax-z">Z</label><input id="dc-h-z" type="number" step="0.01" value="${h.pos.z}"></div>
      </div>
      <div class="dc-sec">การหมุน (°)</div>
      <div class="dc-grid3">
        <div><label class="ax-x">Roll</label><input id="dc-h-r" type="number" step="1" value="${h.rpy.r}"></div>
        <div><label class="ax-y">Pitch</label><input id="dc-h-p" type="number" step="1" value="${h.rpy.p}"></div>
        <div><label class="ax-z">Yaw</label><input id="dc-h-yaw" type="number" step="1" value="${h.rpy.y}"></div>
      </div>
      <div class="dc-sec">จัดการ</div>
      <div class="dc-prop">
        <button class="btn" style="width:100%;background:var(--pur);color:#fff" onclick="dcSelect(decodeURIComponent('${encArg(h.parentId || '')}'))">↩ กลับไปชิ้นส่วน</button>
      </div>
      <div class="dc-del-wrap">
        <button class="btn btn-r" style="width:100%" onclick="dcDeleteHole(decodeURIComponent('${encArg(h.id)}'))">🗑 ลบริูนี้</button>
      </div>
    `;
    const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('input', fn); };
    const live = (id, fn) => bind(id, e => { fn(e); dcSyncHoleMesh(h); });
    live('dc-h-radius', e => {
      if (h.shape === 'rectangle') {
        const val = +e.target.value;
        if (e.target.id === 'dc-h-radius') h.params.width = val;
      } else if (h.shape === 'slot') {
        const val = +e.target.value;
        if (e.target.id === 'dc-h-radius') {
          h.params.width = val;
        } else if (e.target.id === 'dc-h-depth') {
          h.params.depth = val;
        }
      } else if (h.shape === 'circle' || h.shape === 'triangle' || h.shape === 'pentagon' || h.shape === 'hexagon') {
        h.params.radius = +e.target.value;
      } else if (h.shape === 'square') {
        h.params.size = +e.target.value;
      }
      if (e.target.id !== 'dc-h-depth') h.params.depth = +document.getElementById('dc-h-depth').value;
    });
    live('dc-h-depth', e => { h.params.depth = +e.target.value || 0.2; });
    live('dc-h-x', e => { h.pos.x = +e.target.value || 0; });
    live('dc-h-y', e => { h.pos.y = +e.target.value || 0; });
    live('dc-h-z', e => { h.pos.z = +e.target.value || 0; });
    live('dc-h-r', e => { h.rpy.r = +e.target.value || 0; });
    live('dc-h-p', e => { h.rpy.p = +e.target.value || 0; });
    live('dc-h-yaw', e => { h.rpy.y = +e.target.value || 0; });
    return;
  }

  const p = dc.parts.find(x => x.id === dc.selected);
  if (!p) { el.innerHTML = '<div class="dc-props-empty">เลือกชิ้นส่วนเพื่อแก้ไขขนาด/ตำแหน่ง<br><br>หรือกด + เพิ่มชิ้นส่วนใหม่</div>'; return; }
  const P = p.params;
  const colHex = '#' + ('000000' + p.color.toString(16)).slice(-6);

  let sizeRows = '';
  if (p.shape === 'box' || p.shape === 'camera') {
    const k = p.shape === 'box' ? ['sx', 'sy', 'sz'] : ['w', 'h', 'd'];
    const lbl = p.shape === 'box' ? ['X', 'Y', 'Z'] : ['W', 'H', 'D'];
    sizeRows = `<div class="dc-grid3">
      <div><label>${lbl[0]} (m)</label><input id="dc-s-${k[0]}" type="number" step="0.01" value="${P[k[0]]}"></div>
      <div><label>${lbl[1]} (m)</label><input id="dc-s-${k[1]}" type="number" step="0.01" value="${P[k[1]]}"></div>
      <div><label>${lbl[2]} (m)</label><input id="dc-s-${k[2]}" type="number" step="0.01" value="${P[k[2]]}"></div>
    </div>`;
  } else if (p.shape === 'sphere') {
    sizeRows = `<div class="dc-grid3"><div><label>Radius (m)</label><input id="dc-s-radius" type="number" step="0.01" value="${P.radius}"></div></div>`;
  } else {
    sizeRows = `<div class="dc-grid3">
      <div><label>Radius (m)</label><input id="dc-s-radius" type="number" step="0.01" value="${P.radius}"></div>
      <div><label>Height (m)</label><input id="dc-s-height" type="number" step="0.01" value="${P.height}"></div>
    </div>`;
  }

  el.innerHTML = `
    <div class="dc-props-head">🔧 ${escDC(p.name)} <span style="color:var(--dim);font-weight:400">(${p.shape})</span></div>
    <div class="dc-prop"><label>ชื่อชิ้นส่วน</label><input id="dc-p-name" value="${escDC(p.name)}"></div>
    <div class="dc-sec">ขนาด</div>${sizeRows}
    <div class="dc-sec">ตำแหน่ง (m)</div>
    <div class="dc-grid3">
      <div><label class="ax-x">X</label><input id="dc-p-x" type="number" step="0.01" value="${p.pos.x}"></div>
      <div><label class="ax-y">Y</label><input id="dc-p-y" type="number" step="0.01" value="${p.pos.y}"></div>
      <div><label class="ax-z">Z</label><input id="dc-p-z" type="number" step="0.01" value="${p.pos.z}"></div>
    </div>
    <div class="dc-sec">การหมุน (°)</div>
    <div class="dc-grid3">
      <div><label class="ax-x">Roll</label><input id="dc-p-r" type="number" step="1" value="${p.rpy.r}"></div>
      <div><label class="ax-y">Pitch</label><input id="dc-p-p" type="number" step="1" value="${p.rpy.p}"></div>
      <div><label class="ax-z">Yaw</label><input id="dc-p-yaw" type="number" step="1" value="${p.rpy.y}"></div>
    </div>
    <div class="dc-sec">สี</div>
    <div class="dc-prop"><input id="dc-p-color" type="color" value="${colHex}" style="height:32px;padding:2px"></div>
    <div class="dc-del-wrap" style="display:flex;gap:6px;flex-direction:column">
      <button class="btn" style="width:100%;background:var(--pur);color:#fff" onclick="dcOpenHoleModal()">✂ เพิ่มรู (Hole)</button>
      <button class="btn btn-r" style="width:100%" onclick="dcDeletePart(decodeURIComponent('${encArg(p.id)}'))">🗑 ลบชิ้นส่วนนี้</button>
    </div>
  `;

  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('input', fn); };
  const live = (id, fn) => bind(id, e => { fn(e); dcSyncGroup(p); });
  bind('dc-p-name', e => { p.name = e.target.value.trim() || p.name; dcRenderParts(); });
  live('dc-p-x', e => { p.pos.x = +e.target.value || 0; });
  live('dc-p-y', e => { p.pos.y = +e.target.value || 0; });
  live('dc-p-z', e => { p.pos.z = +e.target.value || 0; });
  live('dc-p-r', e => { p.rpy.r = +e.target.value || 0; });
  live('dc-p-p', e => { p.rpy.p = +e.target.value || 0; });
  live('dc-p-yaw', e => { p.rpy.y = +e.target.value || 0; });
  const sk = (id, key) => live(id, e => { p.params[key] = +e.target.value || 0; });
  sk('dc-s-sx', 'sx'); sk('dc-s-sy', 'sy'); sk('dc-s-sz', 'sz');
  sk('dc-s-w', 'w'); sk('dc-s-h', 'h'); sk('dc-s-d', 'd');
  sk('dc-s-radius', 'radius'); sk('dc-s-height', 'height');
  live('dc-p-color', e => { p.color = parseInt(e.target.value.replace('#', ''), 16) || 0x4f8ef7; });
}

// ── new / clear ──
function dcNewComponent() {
  if (dc.parts.length && !window.confirm('เริ่มชิ้นงานใหม่? (ชิ้นส่วนที่ยังไม่เซฟจะหายไป)')) return;
  dc.parts = []; dc.selected = null; dc.editingId = null; dc._nid = 1;
  const nm = document.getElementById('dc-comp-name'); if (nm) nm.value = '';
  dcAfterChange(); dcRenderProps();
}

// ── save เข้า Custom Library ──
function dcSaveComponent() {
  const nameEl = document.getElementById('dc-comp-name');
  const name = (nameEl ? nameEl.value : '').trim();
  if (!name) { alert('กรุณาตั้งชื่อ Component ก่อนบันทึก'); if (nameEl) nameEl.focus(); return; }
  if (!dc.parts.length) { alert('ยังไม่มีชิ้นส่วน — เพิ่มอย่างน้อย 1 ชิ้น'); return; }

  // สี/รูปทรงหลัก = ชิ้นแรก (ใช้เป็น fallback ให้โค้ดเดิมใน transformation.js)
  const first = dc.parts[0];
  const parts = dc.parts.map(p => ({
    shape: p.shape,
    params: JSON.parse(JSON.stringify(p.params)),
    color: p.color,
    pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
    rpy: { r: p.rpy.r, p: p.rpy.p, y: p.rpy.y },
  }));

  const def = {
    id: dc.editingId || ('uc_' + Date.now().toString(36)),
    name,
    shape: 'composite',              // marker: มีหลายชิ้น
    parts,                           // ชิ้นส่วนทั้งหมด
    params: JSON.parse(JSON.stringify(first.params)),  // fallback
    color: first.color,              // fallback
    offset: { pos: { x: 0, y: 0, z: 0 }, rpy: { r: 0, p: 0, y: 0 } },
  };

  const lib = dcLoadLibrary();
  const idx = lib.findIndex(x => x.id === def.id);
  if (idx >= 0) lib[idx] = def; else lib.push(def);
  if(!dcSaveLibrary(lib))return;
  dc.editingId = def.id;

  // ให้ transformation.js เห็นทันทีถ้าเปิดอยู่
  if (typeof tf !== 'undefined') { tf.userComps = lib; if (typeof tfRenderAddGrid === 'function') try { tfRenderAddGrid(); } catch (e) {} }

  dcRenderLibrary();
  if (typeof sbMsg === 'function') sbMsg('บันทึก "' + name + '" เข้า Custom Library แล้ว — ไปหน้า Robot Config จะเห็นในกลุ่ม Custom');
  alert('✅ บันทึก "' + name + '" แล้ว\nไปที่หน้า Robot Config → กลุ่ม ★ Custom เพื่อนำไปต่อกับ TF');
}

// ── โหลด component เดิมมาแก้ไข ──
function dcEditLibrary(id) {
  const lib = dcLoadLibrary();
  const def = lib.find(x => x.id === id); if (!def) return;
  dc.parts = []; dc._nid = 1;
  const src = Array.isArray(def.parts) && def.parts.length
    ? def.parts
    : [{ shape: def.shape === 'composite' ? 'box' : def.shape, params: def.params, color: def.color || 0x4f8ef7, pos: { x: 0, y: 0, z: 0 }, rpy: { r: 0, p: 0, y: 0 } }];
  src.forEach(sp => {
    dc.parts.push({
      id: 'p' + (dc._nid++), shape: sp.shape, name: dcUniqueName(sp.shape),
      params: JSON.parse(JSON.stringify(sp.params || {})),
      pos: Object.assign({ x: 0, y: 0, z: 0 }, sp.pos),
      rpy: Object.assign({ r: 0, p: 0, y: 0 }, sp.rpy),
      color: sp.color ?? 0x4f8ef7, _grp: null,
    });
  });
  dc.editingId = def.id;
  const nm = document.getElementById('dc-comp-name'); if (nm) nm.value = def.name;
  dcAfterChange();
  dcSelect(dc.parts.length ? dc.parts[0].id : null);
  if (typeof sbMsg === 'function') sbMsg('แก้ไข "' + def.name + '"');
}
function dcDeleteLibrary(id) {
  const lib = dcLoadLibrary();
  const def = lib.find(x => x.id === id); if (!def) return;
  if (!window.confirm('ลบ "' + def.name + '" ออกจาก Library ?')) return;
  const next = lib.filter(x => x.id !== id);
  if(!dcSaveLibrary(next))return;
  if (dc.editingId === id) dc.editingId = null;
  if (typeof tf !== 'undefined') { tf.userComps = next; if (typeof tfRenderAddGrid === 'function') try { tfRenderAddGrid(); } catch (e) {} }
  dcRenderLibrary();
}

// ── UI: library list ──
function dcRenderLibrary() {
  const el = document.getElementById('dc-library'); if (!el) return;
  const lib = dcLoadLibrary();
  if (!lib.length) { el.innerHTML = '<div class="dc-empty">ยังไม่มี component ที่บันทึก</div>'; return; }
  el.innerHTML = lib.map(d => {
    const n = Array.isArray(d.parts) ? d.parts.length : 1;
    return `<div class="dc-lib">
      <span class="dc-ico">◆</span>
      <span class="dc-part-nm" title="${escDC(d.name)}">${escDC(d.name)}</span>
      <span class="dc-lib-cnt">${n}</span>
      <span class="dc-part-act" onclick="dcEditLibrary(decodeURIComponent('${encArg(d.id)}'))" title="แก้ไข">✏️</span>
      <span class="dc-part-act" onclick="dcDeleteLibrary(decodeURIComponent('${encArg(d.id)}'))" title="ลบ">🗑</span>
    </div>`;
  }).join('');
}
