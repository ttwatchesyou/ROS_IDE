'use strict';
// ═══════════════════════════════════════════════════════════════
//  MAP EDITOR — หน้าวาดแผนที่สำหรับทดสอบ simulation
//  วาดกำแพง/สิ่งกีดขวาง (เส้น/สี่เหลี่ยม/วงกลม) + ขอบเขตห้อง + จุดเริ่มหุ่น
//  บันทึกลง ~/map.json → sim (SIM_STATE_PUB และ wheel_odom) โหลดไปใช้คำนวณ laser scan
//  รองรับ mouse + touch (Pointer Events: 1 นิ้ว/คลิก = วาด, 2 นิ้ว = เลื่อน+ซูม)
//  พิกัด: X ไปขวา, Y ขึ้น (ROS convention) — หน่วยเมตร
// ═════════════════════════════════════════════════════════════

// ── state ──
let mapInited = false;
let mapDpr = 1;
let mapTool = 'wall';
const MAP_LIDAR_CATALOG = {
  slamtec: {
    label: 'SLAMTEC',
    driverRepository: 'https://github.com/CreedyNZ/rplidar_ros2',
    models: [
      { id:'rplidar_a1m8', label:'RPLIDAR A1M8', sensorType:'2D · 360°', driverPackage:'rplidar_ros' },
      { id:'rplidar_c1m1', label:'RPLIDAR C1M1', sensorType:'2D · 360°', driverPackage:'rplidar_ros' },
      { id:'rplidar_s2', label:'RPLIDAR S2', sensorType:'2D · 360°', driverPackage:'rplidar_ros' },
    ],
  },
  ydlidar: {
    label: 'YDLIDAR',
    driverRepository: 'https://github.com/YDLIDAR/ydlidar_ros2',
    models: [
      { id:'x4', label:'X4', sensorType:'2D · 360°', driverPackage:'ydlidar' },
      { id:'g4', label:'G4', sensorType:'2D · 360°', driverPackage:'ydlidar' },
    ],
  },
  hokuyo: {
    label: 'Hokuyo',
    models: [
      { id:'ust_10lx', label:'UST-10LX', sensorType:'2D · 270°', driverPackage:'urg_node2' },
    ],
  },
  livox: {
    label: 'Livox',
    models: [
      { id:'mid_360', label:'Mid-360', sensorType:'3D LiDAR', driverPackage:'livox_ros_driver2' },
    ],
  },
  custom: {
    label: 'ยี่ห้ออื่น ๆ',
    models: [
      { id:'custom', label:'กำหนดรุ่นภายหลัง', sensorType:'กำหนดเอง', driverPackage:'' },
    ],
  },
};
const mapData = {
  version: 2,
  bounds: [-4, -4, 4, 4],   // [xmin, ymin, xmax, ymax]
  walls: [],                // [[x1,y1,x2,y2], ...]
  start: [0, 0],           // [x, y]
  lidar: { brand:'', model:'', sensorType:'', driverPackage:'', driverRepository:'' },
};
const mapView = { cx: 0, cy: 0, scale: 60, zoom: 1 }; // scale px/m, zoom multiplier
let mapPolyline = [];       // จุดของเส้นกำแพงที่กำลังวาด (world)
let mapDrawing = false;     // กำลังลาก rect/circle/bounds
let mapDragStart = null;    // จุดเริ่มลาก (world)
let mapCur = null;          // จุดปัจจุบัน (world)
let mapPanning = false;
let mapPanLast = null;      // [screenX, screenY]
const mapPointers = new Map(); // pointerId -> {x,y} (screen px) สำหรับ pinch
let mapPinching = false;
let mapPinchDist = null;
let mapPinchMid = null;

function mapStoreKey() { return 'map_' + (sessionId || 'default'); }
function mapStatus(t) { const el = document.getElementById('map3d-status') || document.getElementById('map-status'); if (el) el.textContent = t || ''; }
function mapActiveTool() { return mapTool; }

// ── coordinate transforms (CSS px) ──
function mapEffScale() { return mapView.scale * mapView.zoom; }
function mapW2S(wx, wy) {
  const cv = document.getElementById('map-canvas'); if (!cv) return [0, 0];
  const W = cv.clientWidth, H = cv.clientHeight, s = mapEffScale();
  return [(wx - mapView.cx) * s + W / 2, H / 2 - (wy - mapView.cy) * s];
}
function mapS2W(sx, sy) {
  const cv = document.getElementById('map-canvas'); if (!cv) return [0, 0];
  const W = cv.clientWidth, H = cv.clientHeight, s = mapEffScale();
  return [(sx - W / 2) / s + mapView.cx, (H / 2 - sy) / s + mapView.cy];
}
function mapPointerWorld(e) {
  const cv = document.getElementById('map-canvas');
  const r = cv.getBoundingClientRect();
  return mapS2W(e.clientX - r.left, e.clientY - r.top);
}
function mapDistToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// ── init ──
function initMapEditor() {
  const cv = document.getElementById('map-canvas');
  if (!cv) return;
  if (!mapInited) {
    mapBindCanvas(cv);
    const wrap = document.getElementById('map-canvas-wrap');
    if (wrap && typeof ResizeObserver !== 'undefined') new ResizeObserver(mapResize).observe(wrap);
    mapInited = true;
    // โหลดแผนที่ที่เคยบันทึก (localStorage ก่อน → แล้วพยายามอ่านจาก workspace)
    mapLoadLocal();
  }
  mapSyncInputs();
  mapResize();
  mapRender();
  mapRenderWallList();
}

function mapResize() {
  const wrap = document.getElementById('map-canvas-wrap');
  const cv = document.getElementById('map-canvas');
  if (!wrap || !cv) return;
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return;
  mapDpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.floor(r.width * mapDpr));
  cv.height = Math.max(1, Math.floor(r.height * mapDpr));
  cv.style.width = r.width + 'px';
  cv.style.height = r.height + 'px';
  if (mapInited) mapRender();
}

// ── tools ──
function mapSetTool(t) {
  mapTool = t;
  mapPolyline = []; mapDrawing = false;
  document.querySelectorAll('.map-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  const hint = document.getElementById('map-hint');
  if (hint) {
    const hints = {
      wall: 'คลิกทีละจุดเพื่อต่อเส้นกำแพง · 「✓ จบเส้น」ปิดเส้น · คลิกจุดแรกซ้ำเพื่อปิดทับ',
      rect: 'กดลากเพื่อวาดสี่เหลี่ยม',
      circle: 'กดลากจากจุดศูนย์กลางออกไปกำหนดรัศมี',
      bounds: 'กดลากเพื่อกำหนดขอบเขตห้อง (ใช้ลาดตระเวณ + ขอบเขตมุมมอง)',
      start: 'คลิกเพื่อวางจุดเริ่มหุ่น',
      erase: 'คลิกบนกำแพงเพื่อลบ · คลิกบนหุ่นเพื่อรีเซ็ตจุดเริ่ม',
      pan: 'ลากเพื่อเลื่อนมุมมอง · ใช้ล้อเลื่อน/บีบนิ้วเพื่อซูม',
    };
    hint.textContent = hints[t] || '';
  }
  mapRender();
}
function mapFinishWall() {
  if (mapPolyline.length >= 2) sbMsg('ปิดเส้นกำแพง (' + (mapPolyline.length - 1) + ' ท่อน)');
  mapPolyline = [];
  mapRender();
}
function mapClear() {
  if (!window.confirm('ล้างแผนที่ทั้งหมด (กำแพง/ขอบเขต/จุดเริ่ม) ?')) return;
  mapData.walls = [];
  mapData.bounds = [-4, -4, 4, 4];
  mapData.start = [0, 0];
  mapPolyline = [];
  mapView.cx = 0; mapView.cy = 0; mapView.zoom = 1;
  mapSyncInputs(); mapRender(); mapRenderWallList(); mapSaveLocal();
  sbMsg('ล้างแผนที่แล้ว');
}

function mapApplyBounds() {
  const x0 = parseFloat(document.getElementById('map-bx0').value);
  const y0 = parseFloat(document.getElementById('map-by0').value);
  const x1 = parseFloat(document.getElementById('map-bx1').value);
  const y1 = parseFloat(document.getElementById('map-by1').value);
  if ([x0, y0, x1, y1].some(v => isNaN(v))) { sbMsg('ขอบเขตไม่ถูกต้อง'); return; }
  mapData.bounds = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  mapFitView();
  mapRender(); mapSaveLocal();
  sbMsg('ใช้ขอบเขตห้องแล้ว');
}
function mapApplyStart() {
  const x = parseFloat(document.getElementById('map-sx').value);
  const y = parseFloat(document.getElementById('map-sy').value);
  if (isNaN(x) || isNaN(y)) { sbMsg('จุดเริ่มไม่ถูกต้อง'); return; }
  mapData.start = [x, y];
  mapRender(); mapSaveLocal();
  sbMsg('ใช้จุดเริ่มหุ่นแล้ว');
}

// ── canvas binding (Pointer Events: mouse + touch + pen) ──
function mapBindCanvas(cv) {
  cv.style.touchAction = 'none';
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    const sp = { x: e.clientX, y: e.clientY };
    mapPointers.set(e.pointerId, sp);
    if (mapPointers.size >= 2) {
      mapPinching = true; mapPolyline = []; mapDrawing = false;
      const pts = [...mapPointers.values()];
      mapPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      mapPinchMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
      return;
    }
    if (mapPinching) return;
    const p = mapPointerWorld(e);
    mapCur = p;
    if (mapTool === 'pan') {
      mapPanning = true;
      mapPanLast = [e.clientX, e.clientY];
      cv.style.cursor = 'grabbing';
      return;
    }
    if (mapTool === 'wall') { mapMapAddWallPoint(p, e); return; }
    if (mapTool === 'rect' || mapTool === 'circle' || mapTool === 'bounds') {
      mapDrawing = true; mapDragStart = p; mapCur = p; mapRender(); return;
    }
    if (mapTool === 'start') {
      mapData.start = [+p[0].toFixed(2), +p[1].toFixed(2)];
      mapSyncStartInputs(); mapRender(); mapSaveLocal(); return;
    }
    if (mapTool === 'erase') { mapEraseAt(p); return; }
  });

  cv.addEventListener('pointermove', e => {
    if (mapPointers.has(e.pointerId)) mapPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mapPinching && mapPointers.size >= 2) { mapPinch(); mapRender(); return; }
    const p = mapPointerWorld(e);
    mapCur = p;
    const ro = document.getElementById('map-readout');
    if (ro) ro.textContent = `x: ${p[0].toFixed(2)}  y: ${p[1].toFixed(2)}  m`;
    if (mapPanning && mapPanLast) {
      const dxs = e.clientX - mapPanLast[0], dys = e.clientY - mapPanLast[1];
      const s = mapEffScale();
      mapView.cx -= dxs / s; mapView.cy += dys / s;
      mapPanLast = [e.clientX, e.clientY];
      mapRender(); return;
    }
    if (mapDrawing || mapTool === 'wall') mapRender();
  });

  const endPointer = e => {
    if (mapPinching && mapPointers.size <= 2) {
      // ปล่อยนิ้วหนึ่ง → ยังเหลือ 1 นิ้ว ให้เลิก pinch
      if (mapPointers.size === 1) { mapPinching = false; mapPinchDist = null; mapPinchMid = null; }
    }
    if (mapPointers.has(e.pointerId)) mapPointers.delete(e.pointerId);
    if (mapPointers.size < 2) { mapPinching = false; mapPinchDist = null; mapPinchMid = null; }
    cv.releasePointerCapture && mapPointers.has(e.pointerId) && cv.releasePointerCapture(e.pointerId);
    if (mapPanning) { mapPanning = false; mapPanLast = null; cv.style.cursor = 'crosshair'; }
    if (mapDrawing) { mapFinalizeDraw(e); mapDrawing = false; }
    mapRender(); mapRenderWallList();
  };
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    mapZoomAt(e.clientX - r.left, e.clientY - r.top, factor);
  }, { passive: false });

  cv.addEventListener('dblclick', e => {
    if (mapTool === 'wall' && mapPolyline.length >= 3) mapFinishWall();
  });
}

function mapZoomAt(sx, sy, factor) {
  const before = mapS2W(sx, sy);
  mapView.zoom = Math.max(0.2, Math.min(8, mapView.zoom * factor));
  const after = mapS2W(sx, sy);
  mapView.cx += before[0] - after[0];
  mapView.cy += before[1] - after[1];
  mapRender();
}
function mapPinch() {
  const pts = [...mapPointers.values()];
  if (pts.length < 2) return;
  const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
  const dist = Math.hypot(dx, dy);
  const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
  if (mapPinchDist) mapZoomAt(mx, my, dist / mapPinchDist);
  if (mapPinchMid) {
    const ddx = mx - mapPinchMid[0], ddy = my - mapPinchMid[1];
    const s = mapEffScale();
    mapView.cx -= ddx / s; mapView.cy += ddy / s;
  }
  mapPinchDist = dist; mapPinchMid = [mx, my];
}

// ── drawing ops ──
function mapMapAddWallPoint(p, e) {
  const w = [+p[0].toFixed(2), +p[1].toFixed(2)];
  // คลิกใกล้จุดแรก → ปิดทับ (closed loop)
  if (mapPolyline.length >= 3) {
    const f = mapPolyline[0];
    const fs = mapW2S(f[0], f[1]), ps = mapW2S(w[0], w[1]);
    if (Math.hypot(fs[0] - ps[0], fs[1] - ps[1]) < 10) {
      mapData.walls.push([f[0], f[1], mapPolyline[mapPolyline.length - 1][0], mapPolyline[mapPolyline.length - 1][1]]);
      mapPolyline = []; mapRender(); mapRenderWallList(); mapSaveLocal();
      sbMsg('ปิดเส้นกำแพง (loop)');
      return;
    }
  }
  if (mapPolyline.length >= 1) {
    const prev = mapPolyline[mapPolyline.length - 1];
    mapData.walls.push([prev[0], prev[1], w[0], w[1]]);
  }
  mapPolyline.push(w);
  mapRender(); mapRenderWallList(); mapSaveLocal();
}
function mapFinalizeDraw(e) {
  if (!mapDragStart || !mapCur) { mapDrawing = false; return; }
  const a = mapDragStart, b = mapCur;
  if (mapTool === 'rect' || mapTool === 'bounds') {
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    if (Math.hypot(x1 - x0, y1 - y0) < 0.1) { mapDragStart = null; return; }
    if (mapTool === 'bounds') {
      mapData.bounds = [+x0.toFixed(2), +y0.toFixed(2), +x1.toFixed(2), +y1.toFixed(2)];
      mapSyncBoundsInputs(); mapFitView(); mapSaveLocal();
      sbMsg('กำหนดขอบเขตห้องแล้ว');
    } else {
      mapData.walls.push([x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]);
      mapSaveLocal();
      sbMsg('เพิ่มสี่เหลี่ยม');
    }
  } else if (mapTool === 'circle') {
    const cx = a[0], cy = a[1];
    const r = Math.hypot(b[0] - cx, b[1] - cy);
    if (r < 0.08) { mapDragStart = null; return; }
    const n = Math.max(8, Math.min(64, Math.round(2 * Math.PI * r / 0.15)));
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * 2 * Math.PI, t1 = ((i + 1) / n) * 2 * Math.PI;
      mapData.walls.push([
        +(cx + r * Math.cos(t0)).toFixed(2), +(cy + r * Math.sin(t0)).toFixed(2),
        +(cx + r * Math.cos(t1)).toFixed(2), +(cy + r * Math.sin(t1)).toFixed(2),
      ]);
    }
    mapSaveLocal();
    sbMsg('เพิ่มวงกลม (r=' + r.toFixed(2) + ' m)');
  }
  mapDragStart = null; mapCur = null;
}
function mapEraseAt(p) {
  // ลบจุดเริ่ม?
  const ds = Math.hypot(p[0] - mapData.start[0], p[1] - mapData.start[1]);
  const sPx = ds * mapEffScale();
  if (sPx < 10) { mapData.start = [0, 0]; mapSyncStartInputs(); mapRender(); mapSaveLocal(); sbMsg('รีเซ็ตจุดเริ่ม');
    return; }
  // หาเส้นที่ใกล้ที่สุด
  let best = -1, bestD = 1e9;
  const thresh = 10 / mapEffScale(); // 10 px → world
  mapData.walls.forEach((w, i) => {
    const d = mapDistToSeg(p[0], p[1], w[0], w[1], w[2], w[3]);
    if (d < thresh && d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    mapData.walls.splice(best, 1);
    mapRender(); mapRenderWallList(); mapSaveLocal();
    sbMsg('ลบกำแพง');
  }
}

// ── view fit ──
function mapFitView() {
  const b = mapData.bounds;
  mapView.cx = (b[0] + b[2]) / 2;
  mapView.cy = (b[1] + b[3]) / 2;
  const cv = document.getElementById('map-canvas'); if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  const wW = Math.max(1, (b[2] - b[0]) + 2), wH = Math.max(1, (b[3] - b[1]) + 2);
  mapView.zoom = Math.min(W / (wW * mapView.scale), H / (wH * mapView.scale)) || 1;
  mapView.zoom = Math.max(0.2, Math.min(8, mapView.zoom));
}

// ── render ──
function mapRender() {
  const cv = document.getElementById('map-canvas'); if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const W = cv.clientWidth, H = cv.clientHeight;
  ctx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0e1118'; ctx.fillRect(0, 0, W, H);

  // grid
  const corners = [mapS2W(0, 0), mapS2W(W, H)];
  const xmin = Math.min(corners[0][0], corners[1][0]), xmax = Math.max(corners[0][0], corners[1][0]);
  const ymin = Math.min(corners[0][1], corners[1][1]), ymax = Math.max(corners[0][1], corners[1][1]);
  ctx.lineWidth = 1;
  for (let x = Math.floor(xmin); x <= Math.ceil(xmax); x++) {
    const a = mapW2S(x, ymin), b = mapW2S(x, ymax);
    ctx.strokeStyle = (x === 0) ? 'rgba(255,80,80,.35)' : 'rgba(255,255,255,.06)';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  for (let y = Math.floor(ymin); y <= Math.ceil(ymax); y++) {
    const a = mapW2S(xmin, y), b = mapW2S(xmax, y);
    ctx.strokeStyle = (y === 0) ? 'rgba(79,142,247,.35)' : 'rgba(255,255,255,.06)';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }

  // bounds
  const b = mapData.bounds;
  const bl = mapW2S(b[0], b[1]), tr = mapW2S(b[2], b[3]);
  ctx.strokeStyle = 'rgba(86,211,100,.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
  ctx.strokeRect(bl[0], tr[1], tr[0] - bl[0], bl[1] - tr[1]);
  ctx.setLineDash([]);

  // walls
  ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  mapData.walls.forEach(w => {
    const a = mapW2S(w[0], w[1]), b2 = mapW2S(w[2], w[3]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
  });

  // กำแพงที่กำลังวาด (rubber-band)
  if (mapPolyline.length) {
    ctx.strokeStyle = 'rgba(255,180,84,.9)'; ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    mapPolyline.forEach(w => { const s = mapW2S(w[0], w[1]); if (first) { ctx.moveTo(s[0], s[1]); first = false; } else ctx.lineTo(s[0], s[1]); });
    if (mapCur) { const s = mapW2S(mapCur[0], mapCur[1]); ctx.lineTo(s[0], s[1]); }
    ctx.stroke();
    // จุด vertex
    ctx.fillStyle = '#ffd166';
    mapPolyline.forEach(w => { const s = mapW2S(w[0], w[1]); ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, 7); ctx.fill(); });
  }

  // ตัวอย่างลาก (rect/circle/bounds)
  if (mapDrawing && mapDragStart && mapCur) {
    ctx.strokeStyle = 'rgba(255,180,84,.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    if (mapTool === 'rect' || mapTool === 'bounds') {
      const a = mapW2S(mapDragStart[0], mapDragStart[1]), b2 = mapW2S(mapCur[0], mapCur[1]);
      ctx.strokeRect(Math.min(a[0], b2[0]), Math.min(a[1], b2[1]), Math.abs(b2[0] - a[0]), Math.abs(b2[1] - a[1]));
    } else if (mapTool === 'circle') {
      const a = mapW2S(mapDragStart[0], mapDragStart[1]), b2 = mapW2S(mapCur[0], mapCur[1]);
      const r = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
      ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, 7); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // จุดเริ่มหุ่น (สามเหลี่ยมชี้ +x)
  const sp = mapW2S(mapData.start[0], mapData.start[1]);
  const s = Math.max(7, 0.25 * mapEffScale());
  ctx.fillStyle = '#ff5d5d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sp[0] + s, sp[1]);
  ctx.lineTo(sp[0] - s * 0.7, sp[1] - s * 0.7);
  ctx.lineTo(sp[0] - s * 0.7, sp[1] + s * 0.7);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

function mapRenderWallList() {
  const el = document.getElementById('map-wall-list'); if (!el) return;
  const cnt = document.getElementById('map-wall-count'); if (cnt) cnt.textContent = mapData.walls.length;
  if (!mapData.walls.length) { el.innerHTML = '<div style="color:var(--dim);font-size:11px;padding:4px 6px">ยังไม่มีกำแพง — ใช้เครื่องมือวาดด้านซ้าย</div>'; return; }
  el.innerHTML = mapData.walls.map((w, i) => {
    const d = Math.hypot(w[2] - w[0], w[3] - w[1]).toFixed(2);
    return `<div class="map-wall" onclick="mapEraseIndex(${i})" title="คลิกเพื่อลบ"><span>#${i + 1}</span><span class="mx">${d} m</span></div>`;
  }).join('');
}
function mapEraseIndex(i) {
  if (i >= 0 && i < mapData.walls.length) { mapData.walls.splice(i, 1); mapRender(); mapRenderWallList(); mapSaveLocal(); }
}

// ── inputs sync ──
function mapSyncInputs() { mapSyncBoundsInputs(); mapSyncStartInputs(); mapSyncLidarInputs(); }
function mapSyncBoundsInputs() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  set('map-bx0', mapData.bounds[0]); set('map-by0', mapData.bounds[1]);
  set('map-bx1', mapData.bounds[2]); set('map-by1', mapData.bounds[3]);
}
function mapSyncStartInputs() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  set('map-sx', mapData.start[0]); set('map-sy', mapData.start[1]);
}

function mapNormalizeLidarConfig() {
  if (!mapData.lidar || typeof mapData.lidar !== 'object') mapData.lidar = {};
  const brand = MAP_LIDAR_CATALOG[mapData.lidar.brand] ? mapData.lidar.brand : '';
  const model = brand ? MAP_LIDAR_CATALOG[brand].models.find(item => item.id === mapData.lidar.model) : null;
  mapData.lidar = {
    brand,
    model: model?.id || '',
    sensorType: model?.sensorType || '',
    driverPackage: model?.driverPackage || '',
    driverRepository: model ? (MAP_LIDAR_CATALOG[brand]?.driverRepository || '') : '',
  };
}

function mapSyncLidarInputs() {
  mapNormalizeLidarConfig();
  const brandSelect = document.getElementById('map-lidar-brand');
  const modelSelect = document.getElementById('map-lidar-model');
  if (!brandSelect || !modelSelect) return;
  brandSelect.innerHTML = '<option value="">เลือกยี่ห้อ LiDAR</option>' + Object.entries(MAP_LIDAR_CATALOG)
    .map(([id, brand]) => `<option value="${id}">${brand.label}</option>`).join('');
  brandSelect.value = mapData.lidar.brand;
  const models = MAP_LIDAR_CATALOG[mapData.lidar.brand]?.models || [];
  modelSelect.innerHTML = '<option value="">เลือกรุ่น</option>' + models
    .map(model => `<option value="${model.id}">${model.label}</option>`).join('');
  modelSelect.disabled = !mapData.lidar.brand;
  modelSelect.value = mapData.lidar.model;
  mapRenderLidarSummary();
}

function mapLidarBrandChanged() {
  const brand = document.getElementById('map-lidar-brand')?.value || '';
  mapData.lidar = { brand, model:'', sensorType:'', driverPackage:'', driverRepository:'' };
  mapSyncLidarInputs();
  mapSaveLocal();
  mapStatus(brand ? '📡 เลือกยี่ห้อแล้ว — เลือกรุ่น LiDAR ต่อได้เลย' : 'ยังไม่ได้เลือก LiDAR');
}

function mapLidarModelChanged() {
  const brand = mapData.lidar?.brand || '';
  const modelId = document.getElementById('map-lidar-model')?.value || '';
  const model = MAP_LIDAR_CATALOG[brand]?.models.find(item => item.id === modelId);
  mapData.lidar = {
    brand,
    model: model?.id || '',
    sensorType: model?.sensorType || '',
    driverPackage: model?.driverPackage || '',
    driverRepository: model ? (MAP_LIDAR_CATALOG[brand]?.driverRepository || '') : '',
  };
  mapRenderLidarSummary();
  mapSaveLocal();
  mapStatus(model ? `📡 เตรียม ${MAP_LIDAR_CATALOG[brand].label} ${model.label} ไว้ในแผนที่แล้ว` : 'เลือกรุ่น LiDAR เพื่อบันทึกกับแผนที่');
}

function mapRenderLidarSummary() {
  const el = document.getElementById('map-lidar-summary');
  if (!el) return;
  const brand = MAP_LIDAR_CATALOG[mapData.lidar?.brand];
  const model = brand?.models.find(item => item.id === mapData.lidar.model);
  const driverButton = document.getElementById('map-lidar-driver');
  if (driverButton) {
    driverButton.disabled = !model || !brand?.driverRepository;
    driverButton.title = model && brand?.driverRepository ? `เปิด ${brand.driverRepository}` : 'ยังไม่มีไดรเวอร์สำหรับรุ่นที่เลือก';
  }
  if (!brand || !model) {
    el.className = 'map-lidar-summary empty';
    el.innerHTML = '<span>📡</span><div><strong>ยังไม่ได้เลือกรุ่น</strong><small>เลือกอุปกรณ์ที่จะใช้กับหุ่นยนต์จริงในภายหลัง</small></div>';
    return;
  }
  el.className = 'map-lidar-summary';
  el.innerHTML = `<span>📡</span><div><strong>${brand.label} · ${model.label}</strong><small>${model.sensorType}${model.driverPackage ? ` · ${model.driverPackage}` : ''}</small></div>`;
}

function mapOpenLidarDriver() {
  mapNormalizeLidarConfig();
  const repository = mapData.lidar?.driverRepository;
  if (!repository) { mapStatus('ยังไม่มีลิงก์ไดรเวอร์สำหรับ LiDAR ที่เลือก'); return; }
  window.open(repository, '_blank', 'noopener,noreferrer');
}

// ── save / load ──
function mapSaveLocal() {
  try { localStorage.setItem(mapStoreKey(), JSON.stringify(mapData)); } catch (e) {}
  if (typeof map3dRecordHistory === 'function') map3dRecordHistory();
}
function mapLoadLocal() {
  try {
    const raw = localStorage.getItem(mapStoreKey());
    if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.walls)) { Object.assign(mapData, d); mapFitView(); return true; } }
  } catch (e) {}
  return false;
}
function mapSave() {
  mapSaveLocal();
  if (!sessionId) { mapStatus('💾 บันทึก local แล้ว (ยังไม่ได้เชื่อมต่อ)'); return; }
  API('/api/files/write', { sessionId, path: '~/map.json', content: JSON.stringify(mapData) })
    .then(r => {
      if (r && r.ok) {
        mapStatus('💾 บันทึก ~/map.json แล้ว');
        // สร้าง package sim_robot_mapsim อัตโนมัติเมื่อบันทึกสำเร็จ
        API('/api/sim/generate-mapsim-package', { sessionId })
          .then(r2 => {
            if (r2 && r2.ok) {
              mapStatus('✅ ตรวจ map.json แล้ว พร้อมใช้กับ Sim และผ่านภารกิจ LiDAR');
              if (typeof loadDashboard === 'function') loadDashboard(true);
            } else {
              mapStatus('⚠️ บันทึก map สำเร็จ แต่สร้าง package ไม่สำเร็จ: ' + ((r2 && r2.error) || ''));
            }
          })
          .catch(e2 => mapStatus('⚠️ บันทึก map สำเร็จ แต่สร้าง package ล้มเหลว: ' + e2.message));
      } else {
        mapStatus('⚠️ บันทึกไม่สำเร็จ: ' + ((r && r.error) || ''));
      }
    })
    .catch(e => mapStatus('⚠️ ' + e.message));
}
function mapLoad() {
  if (!sessionId) { mapStatus('ไม่ได้เชื่อมต่อ — โหลดจาก local อย่างเดียว'); mapSyncInputs(); mapRender(); mapRenderWallList(); return; }
  API('/api/files/read', { sessionId, path: '~/map.json' })
    .then(r => {
      if (r && r.ok && r.content) {
        try {
          const d = JSON.parse(r.content);
          if (d && Array.isArray(d.walls)) { Object.assign(mapData, d); mapSyncInputs(); mapFitView(); mapRender(); mapRenderWallList(); mapSaveLocal(); mapStatus('📂 โหลด ~/map.json แล้ว'); return; }
        } catch (e) {}
        mapStatus('⚠️ ~/map.json ไม่ถูกต้อง');
      } else {
        mapStatus('ℹ️ ยังไม่มี ~/map.json (ใช้แผนที่ local)');
      }
    })
    .catch(e => mapStatus('⚠️ ' + e.message));
}
async function mapApplyToSim() {
  if (!sessionId) { sbMsg('ต้องเชื่อมต่อหุ่นก่อนจึงจะ Apply to Sim ได้ (บันทึกล本地ไปก่อน)'); mapSave(); return; }
  mapSaveLocal();
  try {
    const r = await API('/api/sim/apply-map', { sessionId, map: mapData });
    if (r && r.ok) sbMsg('▶ ใช้แผนที่กับ Sim แล้ว (backend รีสตาร์ทโหลด ~/map.json) — ดู laser scan ใน RViz');
    else sbMsg('⚠️ Apply to Sim ไม่สำเร็จ: ' + ((r && r.error) || '') + ' (แผนที่บันทึกล本地/ไฟล์แล้ว)');
  } catch (e) { sbMsg('⚠️ ' + e.message); }
}
