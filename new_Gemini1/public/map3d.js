'use strict';
// 3D Map Editor layer. Values in mapData are always stored in metres.
const map3d = {
  ready:false, loading:null, scene:null, camera:null, renderer:null, orbit:null, transform:null,
  ray:null, pointer:null, roots:new Map(), selectedId:null, unit:'m', floor:null, grid:null,
  resizeObserver:null, pointerStart:null, animationId:null, sun:null, gridVisible:false, objectDragging:false,
};
let map3dHistory = null;
let map3dClipboard = null;
let map3dSaving = false;
function map3dSyncClipboardButtons() {
  const selected = map3dObject();
  for (const id of ['map3d-copy','map3d-duplicate']) { const button = document.getElementById(id); if (button) button.disabled = !selected || selected.type === 'start'; }
  const paste = document.getElementById('map3d-paste'); if (paste) paste.disabled = !map3dClipboard;
}
function map3dCopy() {
  const o = map3dObject(); if (!o || map3d.objectDragging || map3d.transform?.dragging) return false;
  if (o.type === 'start') { mapStatus('จุดเริ่มหุ่นยนต์มีได้หนึ่งจุด — เลือกวัตถุอื่นเพื่อคัดลอก'); return false; }
  const objects = [o, ...mapData.objects.filter(child => child.wallId === o.id)];
  map3dClipboard = {objects: JSON.parse(JSON.stringify(objects)), count: 0};
  map3dSyncClipboardButtons(); mapStatus('📋 คัดลอกแล้ว — กดวางซ้ำได้หลายครั้ง'); return true;
}
function map3dPaste() {
  if (!map3dClipboard || map3d.objectDragging || map3d.transform?.dragging) return;
  map3dHistory?.breakMerge();
  const objects = JSON.parse(JSON.stringify(map3dClipboard.objects)), ids = new Map(), names = new Set(mapData.objects.map(o => o.name));
  const offset = .4 * ++map3dClipboard.count;
  for (const o of objects) {
    const oldId = o.id; o.id = map3dId(); ids.set(oldId, o.id); o.locked = false;
    let n = 1; while (names.has(`${o.name} (สำเนา ${n})`)) n++;
    o.name = `${o.name} (สำเนา ${n})`; names.add(o.name);
    o.x = map3dRound(o.x + offset); o.y = map3dRound(o.y + offset);
  }
  for (const o of objects) {
    if (ids.has(o.wallId)) o.wallId = ids.get(o.wallId);
    else { delete o.wallId; delete o.wallOffset; }
  }
  mapData.objects.push(...objects);
  // A copied opening can snap to a nearby host; copied walls retain their own openings.
  for (const o of objects) if (!o.wallId && ['door','window'].includes(o.type)) MapGeometry.attach(o, mapData.objects);
  map3dRenderAll(); map3dSelect(objects[0].id); map3dChanged();
  mapStatus(`📋 วาง ${objects[0].name} แล้ว — กดวางเพื่อเพิ่มอีกได้`);
}
function map3dDuplicate() { if (map3dCopy()) map3dPaste(); }
function map3dChangeColor(value) {
  const o = map3dObject();
  if (map3d.objectDragging || map3d.transform?.dragging || !map3dCanEdit(o) || !/^#[0-9a-f]{6}$/i.test(value)) return;
  o.color = parseInt(value.slice(1), 16); o.colorCustomized = true;
  if (map3d.ready) {
    map3d.selectionHalo?.clear(); map3d.transform?.detach();
    const old = map3d.roots.get(o.id);
    if (old) { map3d.scene.remove(old); MapSceneAssets.dispose(old); }
    const root = map3dBuildObject(o); map3d.roots.set(o.id, root); map3d.scene.add(root); map3dSelect(o.id);
  }
  map3dChanged();
}
function map3dInitHistory() {
  if (map3dHistory) return;
  map3dHistory = EditorHistory.create({
    capture: () => { const {editorUnit, ...data} = mapData; return data; },
    selection: () => map3d.selectedId,
    restore: (data, selected) => {
      Object.keys(mapData).forEach(key => { delete mapData[key]; });
      Object.assign(mapData, data);
      map3d.selectedId = selected;
      map3dRenderAll(); map3dSyncRoomInputs(); mapSyncLidarInputs(); map3dChanged();
    },
    onChange: history => EditorHistory.updateButtons(history, 'map3d-undo', 'map3d-redo'),
  });
  EditorHistory.bindInputs(document.getElementById('page-map'), map3dHistory);
  EditorHistory.bindInputs(document.getElementById('map3d-lidar-modal'), map3dHistory);
  map3dHistory.reset();
}
function map3dRecordHistory() { map3dHistory?.record(EditorHistory.inputKey()); }
function map3dUndo() { if (map3dHistory?.undo()) mapStatus('↶ ย้อนกลับการแก้ไขห้องแล้ว'); }
function map3dRedo() { if (map3dHistory?.redo()) mapStatus('↷ ทำซ้ำการแก้ไขห้องแล้ว'); }
function map3dEditBlocker(o) {
  if (!o) return null;
  if (o.locked === true) return o;
  return o.type === 'wall' ? mapData.objects.find(child => child.wallId === o.id && child.locked === true) : null;
}
function map3dLockMessage(o) {
  const locked = map3dEditBlocker(o);
  return locked === o ? 'ล็อกอยู่ — ปลดล็อกก่อนย้าย หมุน ปรับขนาด หรือลบ' : locked ? `ขยับกำแพงไม่ได้ เพราะ “${locked.name}” ที่ติดอยู่ล็อกไว้` : 'ปลดล็อกอยู่ — แก้ไขวัตถุได้';
}
function map3dCanEdit(o) {
  if (!o) return false;
  if (map3dEditBlocker(o)) { mapStatus(map3dLockMessage(o)); return false; }
  return true;
}
function map3dSyncLockControls() {
  const o = map3dObject(), button = document.getElementById('map3d-lock');
  if (button) {
    button.disabled = !o;
    button.textContent = o?.locked ? '🔒 ปลดล็อกวัตถุ' : '🔓 ล็อกวัตถุ';
    button.setAttribute('aria-pressed', String(o?.locked === true));
  }
  const hint = document.getElementById('map3d-lock-hint');
  if (hint) hint.textContent = o ? map3dLockMessage(o) : '';
  const fields = document.getElementById('map3d-object-fields');
  if (fields) fields.disabled = !!map3dEditBlocker(o);
}
function map3dToggleLock() {
  const o = map3dObject();
  if (!o || map3d.transform?.dragging || map3d.objectDragging) return;
  map3dHistory?.breakMerge();
  o.locked = o.locked !== true;
  map3dSelect(o.id); map3dChanged();
  mapStatus(`${o.locked ? '🔒 ล็อก' : '🔓 ปลดล็อก'} ${o.name} แล้ว`);
}
function map3dPickRoot(hits) {
  const roots = [];
  for (const hit of hits) {
    let root = hit.object;
    while (root && !root.userData.mapObjectId) root = root.parent;
    if (root && !roots.includes(root)) roots.push(root);
  }
  // A locked wall must not steal a drag aimed at a window or furniture.
  return roots.find(root => !map3dEditBlocker(mapData.objects.find(o => o.id === root.userData.mapObjectId))) || roots[0];
}
function map3dRestoreLocalLocks(loaded) {
  // The workspace map loads first; retain lock/unlock choices made locally since its last save.
  try {
    const cached = JSON.parse(localStorage.getItem(mapStoreKey()));
    const locks = new Map((cached?.objects || []).filter(o => typeof o.locked === 'boolean').map(o => [o.id, o.locked]));
    for (const o of loaded.objects || []) if (locks.has(o.id)) o.locked = locks.get(o.id);
  } catch (e) {}
}
const MAP3D_LABELS = { wall:'กำแพง',door:'ประตู',window:'หน้าต่าง',column:'เสา',stairs:'บันได',table:'โต๊ะ',chair:'เก้าอี้',sofa:'โซฟา',cabinet:'ตู้',lamp:'โคมไฟ',rug:'พรม',plant:'ต้นไม้',bed:'เตียง',appliance:'เครื่องใช้',board:'กระดาน',barrier:'แผงกั้น',cone:'กรวย',box:'กล่อง',start:'จุดเริ่มหุ่นยนต์' };
const MAP3D_DEFAULTS = {
  wall:{ w:3,d:.18,h:2.7,color:0xe4dfd4 }, door:{ w:1.05,d:.14,h:2.15,color:0xb48b60 },
  table:{ w:1.2,d:.7,h:.75,color:0xbe9b72 }, chair:{ w:.5,d:.5,h:.9,color:0xa39c89 },
  window:{w:1.4,d:.1,h:1.2,z:.95,color:0xadc9cb},column:{w:.35,d:.35,h:2.6,color:0x9aa7bd},stairs:{w:1.2,d:1.8,h:1,color:0x8795a8},
  sofa:{w:2.15,d:.92,h:.88,color:0x858f88},cabinet:{w:1.2,d:.45,h:1.9,color:0xb4926c},lamp:{w:.4,d:.4,h:1.6,color:0xeee1c9},rug:{w:2,d:1.4,h:.025,color:0x9e9b8d},plant:{w:.5,d:.5,h:1.2,color:0x506b43},bed:{w:1.1,d:2.05,h:.85,color:0xa9b8b3},appliance:{w:.75,d:.7,h:1.8,color:0xc4ccd8},board:{w:1.8,d:.06,h:1.1,z:1.05,color:0xe8edf3},barrier:{w:1.5,d:.18,h:.9,color:0xffb33b},cone:{w:.35,d:.35,h:.65,color:0xff7b3d},
  box:{ w:.6,d:.6,h:.6,color:0xb49870 }, start:{ w:.55,d:.45,h:.48,color:0x35d69f },
};
const MAP3D_CATEGORIES={all:'✨ ทั้งหมด',architecture:'🏠 ห้อง',living:'🛋️ ห้องนั่งเล่น',bedroom:'🛏️ ห้องนอน',dining:'🍽️ โต๊ะและครัว',school:'🎒 ห้องเรียน',robot:'🤖 หุ่นยนต์'};
const MAP3D_ASSETS=[
  ['wall','wall','กำแพง','🧱','architecture'],['glass-wall','wall','ผนังกระจก','🪟','architecture',{d:.08,color:0x55c7e8}],['door','door','ประตูเดี่ยว','🚪','architecture'],['double-door','door','ประตูคู่','🚪','architecture',{w:1.8}],['window','window','หน้าต่าง','🪟','architecture'],['column','column','เสากลม','🏛️','architecture'],['stairs','stairs','บันได','🪜','architecture'],
  ['sofa','sofa','โซฟา 3 ที่นั่ง','🛋️','living'],['armchair','sofa','โซฟาเดี่ยว','💺','living',{w:.85,d:.8}],['coffee-table','table','โต๊ะกลาง','🫖','living',{w:1,d:.6,h:.42}],['tv-stand','cabinet','ชั้นวางทีวี','📺','living',{w:1.5,d:.4,h:.55}],['bookshelf','cabinet','ชั้นหนังสือ','📚','living',{w:1,d:.35,h:1.9}],['floor-lamp','lamp','โคมไฟตั้งพื้น','💡','living'],['rug','rug','พรม','🟪','living'],['plant','plant','ต้นไม้กระถาง','🪴','living'],
  ['single-bed','bed','เตียงเดี่ยว','🛏️','bedroom'],['double-bed','bed','เตียงคู่','🛏️','bedroom',{w:1.8,d:2}],['wardrobe','cabinet','ตู้เสื้อผ้า','🚪','bedroom',{w:1.5,d:.6,h:2.1}],['bedside-table','cabinet','โต๊ะข้างเตียง','🗄️','bedroom',{w:.5,d:.45,h:.55}],['dresser','cabinet','โต๊ะแป้ง','🪞','bedroom',{w:1.1,d:.45,h:1.35}],['desk','table','โต๊ะเขียนหนังสือ','✏️','bedroom',{w:1.2,d:.6,h:.75}],
  ['dining-table','table','โต๊ะอาหาร','🍽️','dining',{w:1.6,d:.9,h:.76}],['round-table','table','โต๊ะกลม','⭕','dining',{w:1.1,d:1.1,h:.75}],['chair','chair','เก้าอี้','🪑','dining'],['stool','chair','เก้าอี้สตูล','🟤','dining',{w:.38,d:.38,h:.65}],['bench','chair','ม้านั่ง','🪑','dining',{w:1.4,d:.45,h:.65}],['kitchen-counter','cabinet','เคาน์เตอร์ครัว','🥣','dining',{w:1.8,d:.65,h:.9}],['refrigerator','appliance','ตู้เย็น','🧊','dining'],
  ['student-desk','table','โต๊ะนักเรียน','📖','school',{w:.65,d:.5,h:.72}],['teacher-desk','table','โต๊ะคุณครู','👩‍🏫','school',{w:1.4,d:.7,h:.75}],['whiteboard','board','กระดานไวท์บอร์ด','⬜','school'],['locker','cabinet','ตู้ล็อกเกอร์','🗄️','school',{w:1.2,d:.45,h:1.8}],['storage-cabinet','cabinet','ตู้เก็บอุปกรณ์','🧰','school'],['computer-table','table','โต๊ะคอมพิวเตอร์','🖥️','school',{w:1.2,d:.65,h:.75}],
  ['start','start','จุดเริ่มหุ่นยนต์','🤖','robot'],['charging-station','appliance','แท่นชาร์จ','🔋','robot',{w:.65,d:.35,h:.55,color:0x35d69f}],['cone','cone','กรวยจราจร','🚧','robot'],['barrier','barrier','แผงกั้น','⛔','robot'],['box','box','กล่องพัสดุ','📦','robot'],
  ['warehouse-rack','cabinet','ชั้นวางคลังสินค้า','🏭','robot',{w:2,d:.7,h:2.2,color:0x598aab}],
  ['pallet','box','พาเลตไม้','🪵','robot',{w:1.2,d:1,h:.15,color:0xb99465}],
  ['workbench','table','โต๊ะช่าง','🛠️','robot',{w:1.8,d:.8,h:.9,color:0x77948a}],
  ['low-wall','wall','กำแพงเตี้ย','🧱','architecture',{w:2,d:.2,h:1,color:0xc7b99d}],
  ['wide-window','window','หน้าต่างบานกว้าง','🪟','architecture',{w:2.2,h:1.4}],
  ['office-chair','chair','เก้าอี้สำนักงาน','💺','school',{w:.6,d:.6,h:1.1,color:0x4b647a}],
  ['filing-cabinet','cabinet','ตู้ลิ้นชักเอกสาร','🗃️','school',{w:.5,d:.6,h:1.3,color:0x8d9b9d}],
  ['side-table','table','โต๊ะข้างโซฟา','☕','living',{w:.5,d:.5,h:.55}],
  ['ottoman','chair','สตูลเบาะ','🟫','living',{w:.7,d:.55,h:.45,color:0xa78970}],
  ['washing-machine','appliance','เครื่องซักผ้า','🧺','dining',{w:.6,d:.6,h:.85,color:0xd7dddc}],
  ['trash-bin','column','ถังขยะ','🗑️','dining',{w:.4,d:.4,h:.65,color:0x55877d}],
  ['road-post','column','เสากั้นทาง','🚧','robot',{w:.14,d:.14,h:.8,color:0xf2af3b}],
].map(([id,type,label,icon,category,defaults={}])=>({id,type,label,icon,category,defaults}));
const MAP3D_ASSET_MAP=Object.fromEntries(MAP3D_ASSETS.map(asset=>[asset.id,asset]));

function map3dThemeColor(variable,fallback){
  const value=getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return value||fallback;
}
function map3dApplyWorkspaceTheme(){
  if(!window.THREE||!map3d.scene)return;
  const background=new THREE.Color(map3dThemeColor('--bg2','#111622'));
  map3d.scene.background=background;
  if(map3d.scene.fog)map3d.scene.fog.color.copy(background);
  if(map3d.renderer)map3d.renderer.setClearColor(background,1);
}
window.addEventListener('roside-theme-change',map3dApplyWorkspaceTheme);

function map3dScript(src){
  return new Promise((resolve,reject)=>{const found=[...document.scripts].find(s=>s.src===src);if(found){if(found.dataset.loaded==='1'||(src.includes('three.min')&&window.THREE))return resolve();found.addEventListener('load',resolve,{once:true});found.addEventListener('error',reject,{once:true});return}const s=document.createElement('script');s.src=src;s.onload=()=>{s.dataset.loaded='1';resolve()};s.onerror=reject;document.head.appendChild(s)});
}
async function map3dLoadThree(){
  if(!window.THREE) await map3dScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
  if(typeof THREE.OrbitControls!=='function') await map3dScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');
  if(typeof THREE.TransformControls!=='function') await map3dScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js');
}

async function initMapEditor(){
  map3dMoveLidarCard();
  if(map3d.ready){map3dResize();map3dRenderAll();return}
  if(map3d.loading) return map3d.loading;
  map3d.loading=(async()=>{
    mapStatus('⏳ กำลังเปิดห้องสร้างแผนที่ 3D...');
    try{await map3dLoadThree();const source=await map3dAutoLoad();map3dNormalizeData();mapSyncLidarInputs();map3dInitScene();map3d.ready=true;map3dRenderAll();map3dFocus();map3dInitHistory();mapStatus(source==='workspace'?'📂 โหลดแผนที่ล่าสุดจาก ~/map.json แล้ว':'✨ พร้อมแล้ว! กด “เพิ่มของในห้อง” เพื่อเริ่มออกแบบ')}
    catch(error){console.error(error);mapStatus('⚠️ เปิดระบบ 3D ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่')}
    finally{map3d.loading=null}
  })();
  return map3d.loading;
}

function map3dMoveLidarCard(){
  const body=document.getElementById('map3d-lidar-body');const card=document.querySelector('#map-page .map-lidar-card');
  if(body&&card&&!body.contains(card)){body.appendChild(card);const note=document.createElement('div');note.className='map-lidar-future';note.textContent='รุ่นที่เลือกจะถูกบันทึกใน map.json เพื่อใช้เตรียมระบบหุ่นยนต์';body.appendChild(note)}
  if(typeof mapSyncLidarInputs==='function')mapSyncLidarInputs();
}

function map3dNormalizeData(){
  const oldVersion=Number(mapData.version)||0;if(!Array.isArray(mapData.bounds)||mapData.bounds.length<4)mapData.bounds=[-4,-4,4,4];
  mapData.objects=map3dReadObjects(mapData);
  if(!mapData.objects.some(o=>o.type==='start')){const s=Array.isArray(mapData.start)?mapData.start:[0,0];mapData.objects.push(map3dSanitizeObject({type:'start',x:+s[0]||0,y:+s[1]||0,z:0,r:+s[2]||0},mapData.objects.length))}
  mapData.version=Math.max(4,oldVersion);mapData.floorStyle=['oak','tile','concrete'].includes(mapData.floorStyle)?mapData.floorStyle:'oak';
  map3dSyncLegacy();map3dSyncRoomInputs();
}
// Read a model without changing the saved document or the editor's active map.
function map3dReadObjects(map){
  let objects=Array.isArray(map.objects)?map.objects:[];
  if(!objects.length&&Array.isArray(map.walls))objects=map.walls.filter(line=>Array.isArray(line)&&line.length>=4&&line.slice(0,4).every(v=>Number.isFinite(Number(v)))).map((line,i)=>{
    const [x1,y1,x2,y2]=line.map(Number),dx=x2-x1,dy=y2-y1;
    return {id:`legacy-wall-${i}`,type:'wall',asset:'wall',name:`กำแพง ${i+1}`,x:(x1+x2)/2,y:(y1+y2)/2,z:0,w:Math.max(.05,Math.hypot(dx,dy)),d:.12,h:2.5,r:Math.atan2(dy,dx)*180/Math.PI,color:MAP3D_DEFAULTS.wall.color};
  });
  objects=objects.filter(o=>o&&MAP3D_DEFAULTS[o.type]).map(map3dSanitizeObject);
  if((Number(map.version)||0)<4){const oldColors={wall:0x7986cb,door:0xffb45c,table:0x42a5a5,chair:0xab78df,sofa:0x6c7ee1,cabinet:0xb18462,lamp:0xffce68,rug:0x9b72d2,plant:0x46b978,bed:0x72a7df,box:0xff8a73};for(const o of objects){if(!o.colorCustomized&&o.color===oldColors[o.type])o.color=MAP3D_DEFAULTS[o.type].color;}}
  MapGeometry.reconcile(objects);return objects;
}
function map3dSanitizeObject(o,i){
  const d=MAP3D_DEFAULTS[o.type]||MAP3D_DEFAULTS.box,asset=MAP3D_ASSET_MAP[o.asset]?o.asset:(MAP3D_ASSET_MAP[o.type]?o.type:'box');
  return {id:String(o.id||map3dId()),type:o.type,name:String(o.name||`${MAP3D_LABELS[o.type]} ${i+1}`),asset,locked:o.locked===true,
    ...(o.colorCustomized===true?{colorCustomized:true}:{}),
    x:map3dNum(o.x,0),y:map3dNum(o.y,0),z:Math.max(0,map3dNum(o.z,d.z||0)),
    w:Math.max(.001,map3dNum(o.w??o.width,d.w)),d:Math.max(.001,map3dNum(o.d??o.depth??o.length,d.d)),h:Math.max(.001,map3dNum(o.h??o.height,d.h)),r:map3dNum(o.r??o.rotation,0),color:Math.max(0,Math.min(0xffffff,Math.round(map3dNum(o.color,d.color)))),
    ...(o.type==='door'?{openAngle:Math.max(0,Math.min(170,map3dNum(o.openAngle,90))),hinge:o.hinge==='right'?'right':'left'}:{}),
    ...(o.wallId?{wallId:String(o.wallId),wallOffset:map3dNum(o.wallOffset,0)}:{})};
}
function map3dNum(v,fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback}function map3dId(){return 'obj-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)}

function map3dInitScene(){
  const host=document.getElementById('map3d-container');if(!host)return;host.replaceChildren();
  const workspaceBackground=new THREE.Color(map3dThemeColor('--bg2','#111622'));
  map3d.scene=new THREE.Scene();map3d.scene.background=workspaceBackground;map3d.scene.fog=new THREE.Fog(workspaceBackground,22,65);
  map3d.selectionHalo=EditorSelection.create(THREE,map3d.scene);
  map3d.camera=new THREE.PerspectiveCamera(48,1,.02,300);map3d.camera.position.set(8,7,9);
  map3d.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});map3d.renderer.setClearColor(workspaceBackground,1);map3d.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));MapSceneAssets.configureRenderer(map3d.renderer);host.appendChild(map3d.renderer.domElement);
  const lighting=MapSceneAssets.lighting(mapData.bounds);map3d.scene.add(lighting.group);map3d.sun=lighting.sun;
  map3d.orbit=new THREE.OrbitControls(map3d.camera,map3d.renderer.domElement);map3d.orbit.enableDamping=true;map3d.orbit.dampingFactor=.08;map3d.orbit.maxPolarAngle=Math.PI/2.02;map3d.orbit.minDistance=2;map3d.orbit.maxDistance=80;map3d.orbit.target.set(0,0,0);
  if(THREE.MOUSE){map3d.orbit.mouseButtons.LEFT=THREE.MOUSE.PAN;map3d.orbit.mouseButtons.RIGHT=THREE.MOUSE.ROTATE;map3d.orbit.mouseButtons.MIDDLE=THREE.MOUSE.DOLLY}
  map3d.transform=new THREE.TransformControls(map3d.camera,map3d.renderer.domElement);map3d.transform.setMode('translate');map3d.transform.setTranslationSnap(.05);map3d.transform.setRotationSnap(THREE.MathUtils.degToRad(5));map3d.transform.addEventListener('dragging-changed',e=>{map3d.orbit.enabled=!e.value;if(e.value)map3dHistory?.begin();else{map3dRefreshArchitecture();map3dChanged();map3dHistory?.end();}});map3d.transform.showY=false;map3d.transform.addEventListener('objectChange',map3dTransformChanged);map3d.scene.add(map3d.transform);
  map3d.ray=new THREE.Raycaster();map3d.pointer=new THREE.Vector2();map3dBindSelection();map3d.resizeObserver=new ResizeObserver(map3dResize);map3d.resizeObserver.observe(document.getElementById('map3d-viewport'));map3dResize();
  const animate=()=>{map3d.animationId=requestAnimationFrame(animate);if(!document.getElementById('page-map')?.getClientRects().length)return;map3d.orbit?.update();map3d.selectionHalo?.update();map3d.renderer?.render(map3d.scene,map3d.camera)};animate();
}
function map3dResize(){if(!map3d.renderer)return;const host=document.getElementById('map3d-viewport');const r=host?.getBoundingClientRect();if(!r?.width||!r?.height)return;map3d.renderer.setSize(r.width,r.height,false);map3d.camera.aspect=r.width/r.height;map3d.camera.updateProjectionMatrix()}
function map3dBindSelection(){
  const el=map3d.renderer.domElement;let drag=null;
  const setRay=e=>{const rect=el.getBoundingClientRect();map3d.pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);map3d.ray.setFromCamera(map3d.pointer,map3d.camera);};
  const pick=()=>map3dPickRoot(map3d.ray.intersectObjects([...map3d.roots.values()],true));
  el.addEventListener('pointerdown',e=>{
    if(e.button!==0||map3d.transform.dragging)return;
    map3d.pointerStart=[e.clientX,e.clientY];setRay(e);const root=pick();
    if(!root)return;
    map3dSelect(root.userData.mapObjectId);
    if(!map3dCanEdit(map3dObject()))return;
    if(map3d.transform.mode!=='translate')return;
    const plane=new THREE.Plane(new THREE.Vector3(0,1,0),-root.position.y),point=new THREE.Vector3();
    if(!map3d.ray.ray.intersectPlane(plane,point))return;
    drag={root,plane,start:point,position:root.position.clone(),moved:false};map3d.objectDragging=true;map3dHistory?.begin();map3d.orbit.enabled=false;el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove',e=>{
    if(!drag)return;
    if(!drag.moved&&Math.hypot(e.clientX-map3d.pointerStart[0],e.clientY-map3d.pointerStart[1])<4)return;
    drag.moved=true;setRay(e);const point=new THREE.Vector3();if(!map3d.ray.ray.intersectPlane(drag.plane,point))return;
    drag.root.position.x=Math.round((drag.position.x+point.x-drag.start.x)*20)/20;drag.root.position.z=Math.round((drag.position.z+point.z-drag.start.z)*20)/20;
    map3dTransformChanged();
  });
  const finish=e=>{if(!drag)return false;const moved=drag.moved;drag=null;map3d.objectDragging=false;map3d.orbit.enabled=true;if(el.hasPointerCapture(e.pointerId))el.releasePointerCapture(e.pointerId);if(moved){map3dRefreshArchitecture();map3dChanged();}map3dHistory?.end();return moved;};
  el.addEventListener('pointerup',e=>{
    if(e.button!==0)return;
    if(finish(e))return;
    if(!map3d.pointerStart||Math.hypot(e.clientX-map3d.pointerStart[0],e.clientY-map3d.pointerStart[1])>5)return;
    setRay(e);map3dSelect(pick()?.userData.mapObjectId||null);
  });
  el.addEventListener('pointercancel',finish);
  el.addEventListener('lostpointercapture',finish);
}


function map3dRenderAll(){
  if(!map3d.ready)return;
  MapGeometry.reconcile(mapData.objects);
  const previous=map3d.selectedId;map3d.transform.detach();
  map3d.selectionHalo?.clear();
  for(const root of map3d.roots.values()){map3d.scene.remove(root);MapSceneAssets.dispose(root);}map3d.roots.clear();
  for(const root of [map3d.floor,map3d.grid])if(root){map3d.scene.remove(root);MapSceneAssets.dispose(root);}
  const b=mapData.bounds,rw=Math.max(.5,b[2]-b[0]),rd=Math.max(.5,b[3]-b[1]),cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2;
  map3d.floor=MapSceneAssets.roomFloor(mapData);map3d.scene.add(map3d.floor);
  const size=Math.ceil(Math.max(rw,rd));map3d.grid=new THREE.GridHelper(size,Math.max(2,size*2),0x807c70,0x9d998d);map3d.grid.position.set(cx,.013,-cy);map3d.grid.visible=map3d.gridVisible;map3d.scene.add(map3d.grid);
  if(map3d.sun)MapSceneAssets.updateLighting(map3d.sun,b);

  mapData.objects.forEach(o=>{const root=map3dBuildObject(o);map3d.roots.set(o.id,root);map3d.scene.add(root);});
  if(previous&&map3d.roots.has(previous))map3dSelect(previous);else map3dSelect(null);map3dSyncRoomInputs();
}
function map3dArchitectureSignature(o){return JSON.stringify([o,o.type==='wall'?MapGeometry.holes(o,mapData.objects):mapData.objects.find(w=>w.id===o.wallId)?.d]);}
function map3dBuildObject(o){const root=MapSceneAssets.build(o,mapData.objects);root.userData.mapSignature=map3dArchitectureSignature(o);return root;}
function map3dRefreshArchitecture(){
  MapGeometry.reconcile(mapData.objects);
  if(!map3d.ready)return;
  for(const o of mapData.objects.filter(o=>['wall','door','window'].includes(o.type))){
    const current=map3d.roots.get(o.id);if(!current||current.userData.mapSignature===map3dArchitectureSignature(o))continue;
    const next=map3dBuildObject(o);MapSceneAssets.dispose(current);current.clear();
    while(next.children.length)current.add(next.children[0]);current.position.copy(next.position);current.rotation.copy(next.rotation);current.userData.mapSignature=next.userData.mapSignature;
  }
  map3d.selectionHalo?.clear();map3d.selectionHalo?.set(map3d.roots.get(map3d.selectedId)||null);
}
function map3dToggleGrid(){map3d.gridVisible=!map3d.gridVisible;if(map3d.grid)map3d.grid.visible=map3d.gridVisible;document.getElementById('map3d-grid-toggle')?.classList.toggle('active',map3d.gridVisible);}
function map3dChangeFloor(style){mapData.floorStyle=['oak','tile','concrete'].includes(style)?style:'oak';mapData.floorZones=[];map3dRenderAll();map3dChanged();}

function map3dSelect(id){map3d.selectedId=id&&map3d.roots.has(id)?id:null;map3dHistory?.select();map3d.transform?.detach();map3dSyncLockControls();map3dSyncClipboardButtons();map3d.selectionHalo?.set(map3d.roots.get(map3d.selectedId)||null);document.getElementById('map3d-empty').style.display=map3d.selectedId?'none':'';document.getElementById('map3d-form').style.display=map3d.selectedId?'':'none';if(!map3d.selectedId){document.getElementById('map3d-selected-title').textContent='คุณสมบัติวัตถุ';return}const o=map3dObject();const root=map3d.roots.get(o.id);if(!map3dEditBlocker(o))map3d.transform?.attach(root);document.getElementById('map3d-selected-title').textContent=`${o.locked?'🔒 ':''}${map3dIcon(o)} ${o.name}`;map3dSyncPropInputs()}
function map3dObject(){return mapData.objects.find(o=>o.id===map3d.selectedId)}function map3dIcon(object){return MAP3D_ASSET_MAP[typeof object==='string'?object:object?.asset]?.icon||({wall:'🧱',door:'🚪',table:'🪑',chair:'💺',box:'📦',start:'🤖'})[object?.type||object]||'📦'}
function map3dTransformChanged(){
  const o=map3dObject(),root=map3d.roots.get(map3d.selectedId);if(!o||!root)return;
  if(!map3dCanEdit(o)){root.position.set(o.x,o.z,-o.y);root.rotation.y=THREE.MathUtils.degToRad(o.r);map3dSyncPropInputs();return;}
  o.x=map3dRound(root.position.x);o.y=map3dRound(-root.position.z);o.z=Math.max(0,map3dRound(root.position.y));o.r=map3dRound(THREE.MathUtils.radToDeg(root.rotation.y),2);
  if(o.type==='door'||o.type==='window')MapGeometry.attach(o,mapData.objects);
  if(['wall','door','window'].includes(o.type))map3dRefreshArchitecture();
  map3dSyncPropInputs();map3dChanged();
}
function map3dRound(v,p=4){const k=10**p;return Math.round(v*k)/k}

let map3dAssetCategory='all';
function map3dOpenObjects(){map3dRenderCategories();map3dRenderPalette();document.getElementById('map3d-object-modal').classList.add('open')}
function map3dRenderCategories(){const el=document.getElementById('map3d-categories');if(!el)return;el.innerHTML=Object.entries(MAP3D_CATEGORIES).map(([id,label])=>`<button class="map3-cat ${id===map3dAssetCategory?'active':''}" onclick="map3dFilterCategory('${id}')">${label}</button>`).join('')}
function map3dFilterCategory(category){map3dAssetCategory=MAP3D_CATEGORIES[category]?category:'all';map3dRenderCategories();map3dRenderPalette()}
function map3dRenderPalette(){const el=document.getElementById('map3d-palette');if(!el)return;const assets=MAP3D_ASSETS.filter(asset=>map3dAssetCategory==='all'||asset.category===map3dAssetCategory);el.innerHTML=assets.map(asset=>`<button class="map3-object" onclick="map3dAdd('${asset.id}')"><span>${asset.icon}</span><strong>${asset.label}</strong><small>${MAP3D_CATEGORIES[asset.category].replace(/^\S+\s/,'')}</small></button>`).join('')}
function map3dCloseModal(id){document.getElementById(id)?.classList.remove('open')}
function map3dOpenLidar(){map3dMoveLidarCard();document.getElementById('map3d-lidar-modal').classList.add('open')}
function map3dCreateAsset(assetId,props={}){const asset=MAP3D_ASSET_MAP[assetId]||MAP3D_ASSET_MAP.box;const base={...MAP3D_DEFAULTS[asset.type],...asset.defaults};const n=mapData.objects.filter(o=>o.asset===asset.id).length+1;return map3dSanitizeObject({id:map3dId(),type:asset.type,asset:asset.id,name:asset.type==='start'?'จุดเริ่มหุ่นยนต์':`${asset.label} ${n}`,x:0,y:0,z:0,...base,...props},mapData.objects.length)}
function map3dAdd(assetId){
  const asset=MAP3D_ASSET_MAP[assetId];if(!asset)return;if(asset.type==='start'){const existing=mapData.objects.find(o=>o.type==='start');if(existing){map3dCloseModal('map3d-object-modal');map3dSelect(existing.id);mapStatus('🤖 มีจุดเริ่มแล้ว ลากหุ่นไปยังตำแหน่งใหม่ได้เลย');return}}
  const offset=((mapData.objects.length%5)-2)*.45;const o=map3dCreateAsset(assetId,{x:(map3d.orbit?.target.x||0)+offset,y:-(map3d.orbit?.target.z||0)+offset*.6});mapData.objects.push(o);map3dCloseModal('map3d-object-modal');map3dRenderAll();map3dSelect(o.id);map3dChanged();mapStatus(`${asset.icon} เพิ่ม${asset.label}แล้ว — ลากเพื่อย้าย หรือแก้ขนาดด้านขวา`)
}
const MAP3D_TEMPLATES=[
  {id:'family-home',icon:'🏡',name:'บ้าน 2 ห้องนอน + 2 ห้องนั่งเล่น',desc:'14 × 10 m · มีเตียง โซฟา โต๊ะ ตู้ และประตูครบ',build:map3dBuildFamilyHome},
  {id:'classroom',icon:'🏫',name:'ห้องเรียนสร้างสรรค์',desc:'10 × 8 m · โต๊ะนักเรียน 12 ชุด โต๊ะครูและไวท์บอร์ด',build:map3dBuildClassroom},
  {id:'robot-lab',icon:'🔬',name:'ห้องแล็บหุ่นยนต์',desc:'12 × 9 m · โต๊ะคอม แท่นชาร์จ และพื้นที่ทดลอง',build:map3dBuildRobotLab},
  {id:'living-dining',icon:'🛋️',name:'ห้องนั่งเล่น + ห้องอาหาร',desc:'10 × 7 m · โซฟา โต๊ะอาหาร ครัว และต้นไม้',build:map3dBuildLivingDining},
  {id:'challenge',icon:'🏁',name:'สนามฝึกหุ่นยนต์',desc:'12 × 8 m · กรวย แผงกั้น กล่อง และเส้นทางฝึกขับ',build:map3dBuildChallenge},
  {id:'empty-room',icon:'📐',name:'ห้องเปล่าสำหรับเริ่มเอง',desc:'8 × 6 m · มีผนังรอบห้องและจุดเริ่มหุ่นยนต์',build:map3dBuildEmptyRoom},
];
function map3dOpenTemplates(){const grid=document.getElementById('map3d-template-grid');if(grid)grid.innerHTML=MAP3D_TEMPLATES.map(t=>`<button class="map3-template" onclick="map3dUseTemplate('${t.id}')"><span>${t.icon}</span><div><strong>${t.name}</strong><small>${t.desc}</small></div><b>→</b></button>`).join('');document.getElementById('map3d-template-modal').classList.add('open')}
function map3dUseTemplate(id){const template=MAP3D_TEMPLATES.find(t=>t.id===id);if(!template)return;if(mapData.objects.length>1&&!confirm(`เปลี่ยนเป็น Template “${template.name}” และแทนที่ห้องปัจจุบันใช่หรือไม่?`))return;mapData.objects=[];mapData.floorZones=[];mapData.version=4;template.build();map3dCloseModal('map3d-template-modal');map3d.selectedId=null;map3dRenderAll();map3dFocus();map3dChanged();mapStatus(`${template.icon} สร้าง ${template.name} แล้ว — แก้ไขต่อได้ทุกชิ้น`)}
function map3dTemplateAdd(asset,x,y,r=0,extra={}){const object=map3dCreateAsset(asset,{x,y,r,...extra});mapData.objects.push(object);return object}
function map3dTemplateShell(w,d,style='oak'){mapData.floorStyle=style;mapData.bounds=[-w/2,-d/2,w/2,d/2];map3dTemplateAdd('wall',0,-d/2,0,{w});map3dTemplateAdd('wall',0,d/2,0,{w});map3dTemplateAdd('wall',-w/2,0,90,{w:d});map3dTemplateAdd('wall',w/2,0,90,{w:d})}
function map3dBuildFamilyHome(){map3dTemplateShell(14,10);map3dTemplateAdd('wall',0,0,0,{w:14});map3dTemplateAdd('wall',0,0,90,{w:10});map3dTemplateAdd('door',-2,0);map3dTemplateAdd('door',2,0);map3dTemplateAdd('door',0,-2.2,90);map3dTemplateAdd('door',0,2.2,90);map3dTemplateAdd('double-bed',-3.6,2.6,90);map3dTemplateAdd('wardrobe',-6,2.7,-90);map3dTemplateAdd('bedside-table',-2.3,3.5);map3dTemplateAdd('single-bed',3.7,2.5,90);map3dTemplateAdd('wardrobe',6,2.7,90);map3dTemplateAdd('desk',2.4,3.8);map3dTemplateAdd('sofa',-3.8,-3.5,180);map3dTemplateAdd('coffee-table',-3.8,-2.25);map3dTemplateAdd('tv-stand',-3.8,-.45);map3dTemplateAdd('armchair',-5.6,-2.1,-90);map3dTemplateAdd('sofa',3.8,-3.5,180);map3dTemplateAdd('coffee-table',3.8,-2.25);map3dTemplateAdd('bookshelf',6.4,-2.2,90);map3dTemplateAdd('plant',2,-1);map3dTemplateAdd('rug',3.8,-2.5);map3dTemplateAdd('door',-1.2,-5);map3dTemplateAdd('window',-4,5);map3dTemplateAdd('window',3.7,5);map3dTemplateAdd('window',-7,-1.8,90);map3dTemplateAdd('window',7,-1.8,90);map3dTemplateAdd('floor-lamp',-5.8,-4.2);map3dTemplateAdd('rug',-3.8,-2.5);map3dTemplateAdd('start',-1.2,-4.1)}
function map3dBuildClassroom(){map3dTemplateShell(10,8,'tile');map3dTemplateAdd('whiteboard',0,3.9);map3dTemplateAdd('teacher-desk',0,2.6);for(let row=0;row<3;row++)for(let col=0;col<4;col++){const x=-3+col*2,y=1-row*1.7;map3dTemplateAdd('student-desk',x,y);map3dTemplateAdd('chair',x,y-.65,180)}map3dTemplateAdd('locker',-4.7,2.4,90);map3dTemplateAdd('storage-cabinet',4.7,2.4,90);map3dTemplateAdd('door',4,-4);map3dTemplateAdd('window',-5,0,90,{w:2.4});map3dTemplateAdd('window',5,0,90,{w:2.4});map3dTemplateAdd('start',0,-3.2)}
function map3dBuildRobotLab(){map3dTemplateShell(12,9,'concrete');for(let i=0;i<3;i++){map3dTemplateAdd('computer-table',-4+i*4,2.8);map3dTemplateAdd('computer-table',-4+i*4,.8);map3dTemplateAdd('chair',-4+i*4,2.1,180);map3dTemplateAdd('chair',-4+i*4,.1,180)}map3dTemplateAdd('charging-station',-5.5,-3.6,90);map3dTemplateAdd('storage-cabinet',5.5,2.6,90);map3dTemplateAdd('whiteboard',0,4.4);map3dTemplateAdd('barrier',-2,-2.2,25);map3dTemplateAdd('barrier',2,-2.2,-25);map3dTemplateAdd('cone',-3.5,-3);map3dTemplateAdd('cone',3.5,-3);map3dTemplateAdd('double-door',0,-4.5);map3dTemplateAdd('window',-3,4.5,0,{w:2});map3dTemplateAdd('window',3,4.5,0,{w:2});map3dTemplateAdd('start',0,-3.4)}
function map3dBuildLivingDining(){map3dTemplateShell(10,7);mapData.floorZones=[{bounds:[.5,-3.4,4.9,3.4],style:'tile'}];map3dTemplateAdd('sofa',-2.8,-2.3,180);map3dTemplateAdd('armchair',-4.2,-.8,-90);map3dTemplateAdd('coffee-table',-2.8,-1);map3dTemplateAdd('rug',-2.8,-1.2);map3dTemplateAdd('tv-stand',-2.8,1.1);map3dTemplateAdd('dining-table',2.5,-.7);[[1.4,-.7],[3.6,-.7],[2.5,-1.7],[2.5,.3]].forEach(([x,y],i)=>map3dTemplateAdd('chair',x,y,[-90,90,180,0][i]));map3dTemplateAdd('kitchen-counter',3.7,2.7);map3dTemplateAdd('refrigerator',4.35,1.5);map3dTemplateAdd('plant',-4.3,2.5);map3dTemplateAdd('floor-lamp',-4,-2.6);map3dTemplateAdd('door',0,-3.5);map3dTemplateAdd('window',-2.5,3.5,0,{w:2.2});map3dTemplateAdd('window',5,-.5,90,{w:2});map3dTemplateAdd('start',0,-2.5)}
function map3dBuildChallenge(){map3dTemplateShell(12,8,'concrete');[[-4,-2],[-2,-1],[0,-2],[2,-1],[4,-2],[-4,1],[-2,2],[0,1],[2,2],[4,1]].forEach(([x,y],i)=>map3dTemplateAdd(i%3===0?'barrier':i%2?'cone':'box',x,y,i%2?0:35));map3dTemplateAdd('charging-station',-5.4,3.2,90);map3dTemplateAdd('double-door',0,-4);map3dTemplateAdd('start',-5,-3.2)}
function map3dBuildEmptyRoom(){map3dTemplateShell(8,6);map3dTemplateAdd('door',0,-3);map3dTemplateAdd('window',0,3,0,{w:1.8});map3dTemplateAdd('start',0,-1.8)}
function map3dSetMode(mode){if(map3d.transform){map3d.transform.setMode(mode);map3d.transform.showX=mode==='translate';map3d.transform.showY=mode==='rotate';map3d.transform.showZ=mode==='translate'}document.getElementById('map3d-move').classList.toggle('active',mode==='translate');document.getElementById('map3d-rotate').classList.toggle('active',mode==='rotate')}
function map3dDeleteSelected(){const o=map3dObject();if(!map3dCanEdit(o))return;if(o.type==='start'){mapStatus('🤖 จุดเริ่มจำเป็นสำหรับหุ่นยนต์ สามารถย้ายหรือปรับขนาดได้แต่ลบไม่ได้');return}mapData.objects=mapData.objects.filter(x=>x.id!==o.id);map3d.selectedId=null;map3dRenderAll();map3dChanged();mapStatus(`🗑 ลบ${MAP3D_LABELS[o.type]}แล้ว`)}

function map3dUnitFactor(){return map3d.unit==='mm'?1000:map3d.unit==='cm'?100:1}function map3dChangeUnit(unit){map3d.unit=['mm','cm','m'].includes(unit)?unit:'m';document.querySelectorAll('.map3d-unit-label').forEach(e=>e.textContent=map3d.unit);map3dSyncPropInputs();map3dSyncRoomInputs();mapStatus(`📏 เปลี่ยนหน่วยแก้ไขเป็น ${map3d.unit} (ไฟล์ยังบันทึกเป็นเมตร)`)}
function map3dSetInput(id,value){const e=document.getElementById(id);if(e)e.value=Number.isFinite(value)?map3dRound(value,3):''}
function map3dSyncPropInputs(){const o=map3dObject();if(!o)return;map3dSyncOpeningInputs(o);const color=document.getElementById('map3d-color');if(color)color.value='#'+o.color.toString(16).padStart(6,'0');const f=map3dUnitFactor();map3dSetInput('map3d-x',o.x*f);map3dSetInput('map3d-y',o.y*f);map3dSetInput('map3d-z',o.z*f);map3dSetInput('map3d-r',o.r);map3dSetInput('map3d-w',o.w*f);map3dSetInput('map3d-d',o.d*f);map3dSetInput('map3d-h',o.h*f)}
function map3dApplyProps(){const o=map3dObject();if(!map3dCanEdit(o)){map3dSyncPropInputs();return;}const f=map3dUnitFactor(),v=id=>map3dNum(document.getElementById(id)?.value);o.x=v('map3d-x')/f;o.y=v('map3d-y')/f;o.z=Math.max(0,v('map3d-z')/f);o.r=v('map3d-r');o.w=Math.max(.001,v('map3d-w')/f);o.d=Math.max(.001,v('map3d-d')/f);o.h=Math.max(.001,v('map3d-h')/f);if(o.type==='door'||o.type==='window')MapGeometry.attach(o,mapData.objects);map3dRenderAll();map3dSelect(o.id);map3dChanged();mapStatus('✅ อัปเดตขนาดแล้ว (ค่าจริงเก็บเป็นเมตร)')}
function map3dSyncRoomInputs(){const floor=document.getElementById('map3d-floor-style');if(floor)floor.value=mapData.floorStyle||'oak';if(!Array.isArray(mapData.bounds))return;const f=map3dUnitFactor();map3dSetInput('map3d-room-w',(mapData.bounds[2]-mapData.bounds[0])*f);map3dSetInput('map3d-room-d',(mapData.bounds[3]-mapData.bounds[1])*f)}
function map3dApplyRoom(){
  const f=map3dUnitFactor(),w=Math.max(.5,map3dNum(document.getElementById('map3d-room-w').value)/f),d=Math.max(.5,map3dNum(document.getElementById('map3d-room-d').value)/f),b=mapData.bounds,cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2;
  const bounds=[cx-w/2,cy-d/2,cx+w/2,cy+d/2].map(x=>map3dRound(x)),start=mapData.objects.find(o=>o.type==='start');
  if(start?.locked&&(start.x<bounds[0]||start.x>bounds[2]||start.y<bounds[1]||start.y>bounds[3])){mapStatus('🔒 ปลดล็อกจุดเริ่มหุ่นยนต์ก่อนลดพื้นที่จนต้องย้ายจุดเริ่ม');map3dSyncRoomInputs();return;}
  mapData.bounds=bounds;
  if(start){start.x=Math.max(bounds[0],Math.min(bounds[2],start.x));start.y=Math.max(bounds[1],Math.min(bounds[3],start.y));}
  map3dRenderAll();map3dChanged();mapStatus('🏠 ปรับขนาดพื้นที่แล้ว');
}

function map3dSyncLegacy(){
  MapGeometry.reconcile(mapData.objects);
  const start=mapData.objects.find(o=>o.type==='start');mapData.start=start?[map3dRound(start.x),map3dRound(start.y)]:[0,0];mapData.startPose=start?{x:map3dRound(start.x),y:map3dRound(start.y),z:map3dRound(start.z),yaw:map3dRound(start.r,2)}:{x:0,y:0,z:0,yaw:0};
  const lines=MapGeometry.segments(mapData.objects);mapData.walls=lines;mapData.units='m';mapData.editorUnit=map3d.unit;
}
function map3dSyncOpeningInputs(o){
  const section=document.getElementById('map3d-opening-props');if(!section)return;
  section.style.display=o.type==='door'||o.type==='window'?'':'none';
  document.getElementById('map3d-door-controls').style.display=o.type==='door'?'':'none';
  const status=document.getElementById('map3d-opening-status');status.textContent=o.wallId?'เชื่อมกับผนังแล้ว · ช่องเปิดอัปเดตตามวัตถุ':'ลากเข้าหาผนังเพื่อสร้างช่องเปิดอัตโนมัติ';
  if(o.type==='door'){map3dSetInput('map3d-door-angle',o.openAngle);document.getElementById('map3d-door-hinge').value=o.hinge||'left';document.getElementById('map3d-door-angle-label').textContent=`${map3dRound(o.openAngle,0)}°`;}
}
function map3dApplyDoor(){
  const o=map3dObject();if(o?.type!=='door')return;
  if(!map3dCanEdit(o)){map3dSyncOpeningInputs(o);return;}
  o.openAngle=Math.max(0,Math.min(170,map3dNum(document.getElementById('map3d-door-angle').value,90)));o.hinge=document.getElementById('map3d-door-hinge').value==='right'?'right':'left';
  map3dRefreshArchitecture();map3dSyncOpeningInputs(o);map3dChanged();
}

function map3dChanged(){map3dSyncLegacy();if(typeof mapSaveLocal==='function')mapSaveLocal()}

async function map3dAutoLoad(){
  if(sessionId){try{const response=await API('/api/files/read',{sessionId,path:'~/map.json'});if(response?.ok&&response.content){const loaded=JSON.parse(response.content);if(Array.isArray(loaded.walls)||Array.isArray(loaded.objects)){map3dRestoreLocalLocks(loaded);mapData.objects=Array.isArray(loaded.objects)?loaded.objects:[];mapData.floorZones=[];mapData.floorStyle='oak';Object.assign(mapData,loaded);mapSaveLocal();return 'workspace'}}}catch(error){console.warn('[Map3D] auto-load workspace:',error.message)}}
  mapData.floorZones=[];mapData.floorStyle='oak';if(typeof mapLoadLocal==='function'&&mapLoadLocal())return 'local';return 'new';
}
function map3dReturnToWizard(){
  setTimeout(()=>{if(typeof window.switchPage==='function')window.switchPage('dashboard');if(typeof loadDashboard==='function')loadDashboard()},900);
}
async function map3dSave(){
  if(map3dSaving)return false;
  map3dChanged();
  const savedSession=sessionId,content=JSON.stringify(mapData),snapshot=JSON.parse(content);
  const button=document.getElementById('map3d-save'),old=button?.innerHTML;
  let saved=false,phase='บันทึกไฟล์แผนที่';map3dSaving=true;
  if(button){button.disabled=true;button.innerHTML='⏳ <span>กำลังบันทึก...</span>'}
  mapStatus('💾 กำลังบันทึกแผนที่...');
  try{
    if(!savedSession){mapStatus('💾 บันทึกในเครื่องแล้ว — กำลังกลับไป ROS Wizzard');map3dReturnToWizard();return true}
    if(typeof isSimWorkspace!=='undefined'&&!isSimWorkspace){
      const written=await API('/api/files/write',{sessionId:savedSession,path:'~/map.json',content});if(!written?.ok)throw new Error(written?.error||'บันทึก map.json ไม่สำเร็จ');
      saved=true;if(sessionId!==savedSession)return false;
      mapStatus('💾 บันทึก ~/map.json แล้ว — กำลังกลับไป ROS Wizzard');if(JSON.stringify(mapData)===content)map3dReturnToWizard();return true;
    }
    phase='เตรียมและเปิด Simulation';
    mapStatus('⏳ กำลังบันทึกและส่งเข้าคิวสร้างสนาม...');
    const started=await API('/api/sim/run-mapsim',{sessionId:savedSession,map:snapshot},{
      isCurrent:()=>sessionId===savedSession,
      onAccepted:response=>{saved=response.saved===true;},
      onProgress:(message,job)=>{mapStatus(message);if(button)button.textContent=job.state==='queued'?`⏳ รอคิว (${job.position})`:'⏳ กำลังเตรียมสนาม...';},
    });if(!started?.ok)throw new Error(started?.error||'เปิด MapSim node ไม่สำเร็จ');
    if(sessionId!==savedSession)return false;
    if(JSON.stringify(mapData)!==content){mapStatus('💾 บันทึกและเปิด Simulation แล้ว · มีการแก้ไขเพิ่มเติมระหว่างรอ กดบันทึกอีกครั้งเพื่อใช้ค่าล่าสุด');return true}
    mapStatus('✅ บันทึกและรัน /sim_robot_mapsim แล้ว — กำลังกลับไป ROS Wizzard');
    map3dReturnToWizard();return true;
  }catch(error){
    if(sessionId===savedSession){
      const detail=error.message==='Timeout'?'ใช้เวลานานเกินกำหนด (timeout)':error.message;
      mapStatus(saved?`💾 บันทึกแผนที่แล้ว แต่${phase}ไม่สำเร็จ: ${detail} · กดบันทึกเพื่อลองอีกครั้ง`:`⚠️ ${phase}ไม่สำเร็จ: ${detail} · สำเนางานยังอยู่ในเบราว์เซอร์`);
    }
    return false;
  }finally{map3dSaving=false;if(button){button.disabled=false;button.innerHTML=old||'💾 <span>บันทึกแผนที่ simulation</span>'}}
}
async function map3dLoad(){
  let loaded=null;if(sessionId){try{const r=await API('/api/files/read',{sessionId,path:'~/map.json'});if(r?.ok&&r.content)loaded=JSON.parse(r.content)}catch(e){mapStatus('⚠️ '+e.message);return}}
  if(!loaded){try{const raw=localStorage.getItem(mapStoreKey());if(raw)loaded=JSON.parse(raw)}catch(e){}}
  if(!loaded){mapStatus('ℹ️ ยังไม่มี map.json ที่บันทึกไว้');return}if(!Array.isArray(loaded.walls)&&!Array.isArray(loaded.objects)){mapStatus('⚠️ รูปแบบ map.json ไม่ถูกต้อง');return}map3dRestoreLocalLocks(loaded);mapData.objects=Array.isArray(loaded.objects)?loaded.objects:[];mapData.floorZones=[];mapData.floorStyle='oak';Object.assign(mapData,loaded);map3dNormalizeData();map3dRenderAll();map3dFocus();mapSaveLocal();mapStatus('📂 โหลดแผนที่ 3D แล้ว')
}
function map3dApplyToSim(){map3dChanged();if(typeof mapApplyToSim==='function')mapApplyToSim()}
function map3dView(view){const b=mapData.bounds,size=Math.max(b[2]-b[0],b[3]-b[1],4),cx=(b[0]+b[2])/2,cz=-(b[1]+b[3])/2;map3d.orbit.target.set(cx,0,cz);if(view==='top')map3d.camera.position.set(cx,size*1.35,cz+.001);else if(view==='front')map3d.camera.position.set(cx,size*.42,cz+size*1.25);else map3d.camera.position.set(cx+size*.72,size*.98,cz+size*.8);map3d.camera.lookAt(map3d.orbit.target);map3d.orbit.update()}
function map3dFocus(){map3dView('iso')}

window.addEventListener('keydown',e=>{if(!document.getElementById('page-map')?.classList.contains('show'))return;if(typeof EditorHistory!=='undefined'&&EditorHistory.clipboardShortcut(e,map3dCopy,map3dPaste,map3dDuplicate))return;if(map3dHistory&&EditorHistory.shortcut(e,map3dUndo,map3dRedo))return;if(e.ctrlKey||e.metaKey||e.altKey||e.target.isContentEditable||e.target.matches?.('input,select,textarea'))return;if(e.key.toLowerCase()==='w')map3dSetMode('translate');if(e.key.toLowerCase()==='e')map3dSetMode('rotate');if((e.key==='Delete'||e.key==='Backspace')&&map3d.selectedId)map3dDeleteSelected();if(e.key==='Escape'){map3dCloseModal('map3d-object-modal');map3dCloseModal('map3d-template-modal');map3dCloseModal('map3d-lidar-modal');map3dSelect(null)}});
