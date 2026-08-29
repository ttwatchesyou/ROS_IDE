'use strict';
// 3D Map Editor layer. Values in mapData are always stored in metres.
const map3d = {
  ready:false, loading:null, scene:null, camera:null, renderer:null, orbit:null, transform:null,
  ray:null, pointer:null, roots:new Map(), selectedId:null, unit:'m', floor:null, grid:null,
  resizeObserver:null, pointerStart:null, animationId:null,
};
const MAP3D_LABELS = { wall:'กำแพง',door:'ประตู',window:'หน้าต่าง',column:'เสา',stairs:'บันได',table:'โต๊ะ',chair:'เก้าอี้',sofa:'โซฟา',cabinet:'ตู้',lamp:'โคมไฟ',rug:'พรม',plant:'ต้นไม้',bed:'เตียง',appliance:'เครื่องใช้',board:'กระดาน',barrier:'แผงกั้น',cone:'กรวย',box:'กล่อง',start:'จุดเริ่มหุ่นยนต์' };
const MAP3D_DEFAULTS = {
  wall:{ w:3,d:.15,h:2.5,color:0x7986cb }, door:{ w:.9,d:.12,h:2.1,color:0xffb45c },
  table:{ w:1.2,d:.7,h:.75,color:0x42a5a5 }, chair:{ w:.5,d:.5,h:.9,color:0xab78df },
  window:{w:1.2,d:.08,h:1.2,color:0x55c7e8},column:{w:.35,d:.35,h:2.6,color:0x9aa7bd},stairs:{w:1.2,d:1.8,h:1,color:0x8795a8},
  sofa:{w:1.9,d:.82,h:.85,color:0x6c7ee1},cabinet:{w:1.2,d:.45,h:1.9,color:0xb18462},lamp:{w:.4,d:.4,h:1.6,color:0xffce68},rug:{w:2,d:1.4,h:.025,color:0x9b72d2},plant:{w:.5,d:.5,h:1.2,color:0x46b978},bed:{w:1.1,d:2,h:.55,color:0x72a7df},appliance:{w:.75,d:.7,h:1.8,color:0xc4ccd8},board:{w:1.8,d:.08,h:1.1,color:0xe8edf3},barrier:{w:1.5,d:.18,h:.9,color:0xffb33b},cone:{w:.35,d:.35,h:.65,color:0xff7b3d},
  box:{ w:.6,d:.6,h:.6,color:0xff8a73 }, start:{ w:.55,d:.45,h:.48,color:0x35d69f },
};
const MAP3D_CATEGORIES={all:'✨ ทั้งหมด',architecture:'🏠 ห้อง',living:'🛋️ ห้องนั่งเล่น',bedroom:'🛏️ ห้องนอน',dining:'🍽️ โต๊ะและครัว',school:'🎒 ห้องเรียน',robot:'🤖 หุ่นยนต์'};
const MAP3D_ASSETS=[
  ['wall','wall','กำแพง','🧱','architecture'],['glass-wall','wall','ผนังกระจก','🪟','architecture',{d:.08,color:0x55c7e8}],['door','door','ประตูเดี่ยว','🚪','architecture'],['double-door','door','ประตูคู่','🚪','architecture',{w:1.8}],['window','window','หน้าต่าง','🪟','architecture'],['column','column','เสากลม','🏛️','architecture'],['stairs','stairs','บันได','🪜','architecture'],
  ['sofa','sofa','โซฟา 3 ที่นั่ง','🛋️','living'],['armchair','sofa','โซฟาเดี่ยว','💺','living',{w:.85,d:.8}],['coffee-table','table','โต๊ะกลาง','🫖','living',{w:1,d:.6,h:.42}],['tv-stand','cabinet','ชั้นวางทีวี','📺','living',{w:1.5,d:.4,h:.55}],['bookshelf','cabinet','ชั้นหนังสือ','📚','living',{w:1,d:.35,h:1.9}],['floor-lamp','lamp','โคมไฟตั้งพื้น','💡','living'],['rug','rug','พรม','🟪','living'],['plant','plant','ต้นไม้กระถาง','🪴','living'],
  ['single-bed','bed','เตียงเดี่ยว','🛏️','bedroom'],['double-bed','bed','เตียงคู่','🛏️','bedroom',{w:1.8,d:2}],['wardrobe','cabinet','ตู้เสื้อผ้า','🚪','bedroom',{w:1.5,d:.6,h:2.1}],['bedside-table','cabinet','โต๊ะข้างเตียง','🗄️','bedroom',{w:.5,d:.45,h:.55}],['dresser','cabinet','โต๊ะแป้ง','🪞','bedroom',{w:1.1,d:.45,h:1.35}],['desk','table','โต๊ะเขียนหนังสือ','✏️','bedroom',{w:1.2,d:.6,h:.75}],
  ['dining-table','table','โต๊ะอาหาร','🍽️','dining',{w:1.6,d:.9,h:.76}],['round-table','table','โต๊ะกลม','⭕','dining',{w:1.1,d:1.1,h:.75}],['chair','chair','เก้าอี้','🪑','dining'],['stool','chair','เก้าอี้สตูล','🟤','dining',{w:.38,d:.38,h:.65}],['bench','chair','ม้านั่ง','🪑','dining',{w:1.4,d:.45,h:.65}],['kitchen-counter','cabinet','เคาน์เตอร์ครัว','🥣','dining',{w:1.8,d:.65,h:.9}],['refrigerator','appliance','ตู้เย็น','🧊','dining'],
  ['student-desk','table','โต๊ะนักเรียน','📖','school',{w:.65,d:.5,h:.72}],['teacher-desk','table','โต๊ะคุณครู','👩‍🏫','school',{w:1.4,d:.7,h:.75}],['whiteboard','board','กระดานไวท์บอร์ด','⬜','school'],['locker','cabinet','ตู้ล็อกเกอร์','🗄️','school',{w:1.2,d:.45,h:1.8}],['storage-cabinet','cabinet','ตู้เก็บอุปกรณ์','🧰','school'],['computer-table','table','โต๊ะคอมพิวเตอร์','🖥️','school',{w:1.2,d:.65,h:.75}],
  ['start','start','จุดเริ่มหุ่นยนต์','🤖','robot'],['charging-station','appliance','แท่นชาร์จ','🔋','robot',{w:.65,d:.35,h:.55,color:0x35d69f}],['cone','cone','กรวยจราจร','🚧','robot'],['barrier','barrier','แผงกั้น','⛔','robot'],['box','box','กล่องพัสดุ','📦','robot'],
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
    try{await map3dLoadThree();const source=await map3dAutoLoad();map3dNormalizeData();mapSyncLidarInputs();map3dInitScene();map3d.ready=true;map3dRenderAll();map3dFocus();mapStatus(source==='workspace'?'📂 โหลดแผนที่ล่าสุดจาก ~/map.json แล้ว':'✨ พร้อมแล้ว! กด “เพิ่มของในห้อง” เพื่อเริ่มออกแบบ')}
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
  mapData.version=Math.max(3,Number(mapData.version)||0);if(!Array.isArray(mapData.bounds)||mapData.bounds.length<4)mapData.bounds=[-4,-4,4,4];
  if(!Array.isArray(mapData.objects))mapData.objects=[];
  if(!mapData.objects.length&&Array.isArray(mapData.walls)){
    mapData.walls.forEach((line,i)=>{if(!Array.isArray(line)||line.length<4)return;const dx=line[2]-line[0],dy=line[3]-line[1];mapData.objects.push({id:map3dId(),type:'wall',name:`กำแพง ${i+1}`,x:(line[0]+line[2])/2,y:(line[1]+line[3])/2,z:0,w:Math.max(.05,Math.hypot(dx,dy)),d:.12,h:2.5,r:Math.atan2(dy,dx)*180/Math.PI,color:MAP3D_DEFAULTS.wall.color})})
  }
  mapData.objects=mapData.objects.filter(o=>o&&MAP3D_DEFAULTS[o.type]).map((o,i)=>map3dSanitizeObject(o,i));
  if(!mapData.objects.some(o=>o.type==='start')){const s=Array.isArray(mapData.start)?mapData.start:[0,0];mapData.objects.push(map3dSanitizeObject({type:'start',x:+s[0]||0,y:+s[1]||0,z:0,r:+s[2]||0},mapData.objects.length))}
  map3dSyncLegacy();map3dSyncRoomInputs();
}
function map3dSanitizeObject(o,i){const d=MAP3D_DEFAULTS[o.type]||MAP3D_DEFAULTS.box;const asset=MAP3D_ASSET_MAP[o.asset]?o.asset:(MAP3D_ASSET_MAP[o.type]?o.type:'box');return{id:String(o.id||map3dId()),type:o.type,name:String(o.name||`${MAP3D_LABELS[o.type]} ${i+1}`),asset,x:map3dNum(o.x,0),y:map3dNum(o.y,0),z:Math.max(0,map3dNum(o.z,0)),w:Math.max(.001,map3dNum(o.w??o.width,d.w)),d:Math.max(.001,map3dNum(o.d??o.depth??o.length,d.d)),h:Math.max(.001,map3dNum(o.h??o.height,d.h)),r:map3dNum(o.r??o.rotation,0),color:Number(o.color)||d.color}}
function map3dNum(v,fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback}function map3dId(){return 'obj-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)}

function map3dInitScene(){
  const host=document.getElementById('map3d-container');if(!host)return;host.replaceChildren();
  const workspaceBackground=new THREE.Color(map3dThemeColor('--bg2','#111622'));
  map3d.scene=new THREE.Scene();map3d.scene.background=workspaceBackground;map3d.scene.fog=new THREE.Fog(workspaceBackground,22,65);
  map3d.camera=new THREE.PerspectiveCamera(48,1,.02,300);map3d.camera.position.set(8,7,9);
  map3d.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});map3d.renderer.setClearColor(workspaceBackground,1);map3d.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));map3d.renderer.shadowMap.enabled=true;map3d.renderer.shadowMap.type=THREE.PCFSoftShadowMap;map3d.renderer.outputEncoding=THREE.sRGBEncoding;host.appendChild(map3d.renderer.domElement);
  map3d.scene.add(new THREE.HemisphereLight(0xddeeff,0x29304a,1.05));const sun=new THREE.DirectionalLight(0xffffff,.9);sun.position.set(7,12,8);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);map3d.scene.add(sun);
  map3d.orbit=new THREE.OrbitControls(map3d.camera,map3d.renderer.domElement);map3d.orbit.enableDamping=true;map3d.orbit.dampingFactor=.08;map3d.orbit.maxPolarAngle=Math.PI/2.02;map3d.orbit.minDistance=2;map3d.orbit.maxDistance=80;map3d.orbit.target.set(0,0,0);
  if(THREE.MOUSE){map3d.orbit.mouseButtons.LEFT=THREE.MOUSE.PAN;map3d.orbit.mouseButtons.RIGHT=THREE.MOUSE.ROTATE;map3d.orbit.mouseButtons.MIDDLE=THREE.MOUSE.DOLLY}
  map3d.transform=new THREE.TransformControls(map3d.camera,map3d.renderer.domElement);map3d.transform.setMode('translate');map3d.transform.setTranslationSnap(.05);map3d.transform.setRotationSnap(THREE.MathUtils.degToRad(5));map3d.transform.addEventListener('dragging-changed',e=>map3d.orbit.enabled=!e.value);map3d.transform.addEventListener('objectChange',map3dTransformChanged);map3d.scene.add(map3d.transform);
  map3d.ray=new THREE.Raycaster();map3d.pointer=new THREE.Vector2();map3dBindSelection();map3d.resizeObserver=new ResizeObserver(map3dResize);map3d.resizeObserver.observe(document.getElementById('map3d-viewport'));map3dResize();
  const animate=()=>{map3d.animationId=requestAnimationFrame(animate);map3d.orbit?.update();map3d.renderer?.render(map3d.scene,map3d.camera)};animate();
}
function map3dResize(){if(!map3d.renderer)return;const host=document.getElementById('map3d-viewport');const r=host?.getBoundingClientRect();if(!r?.width||!r?.height)return;map3d.renderer.setSize(r.width,r.height,false);map3d.camera.aspect=r.width/r.height;map3d.camera.updateProjectionMatrix()}
function map3dBindSelection(){const el=map3d.renderer.domElement;el.addEventListener('pointerdown',e=>map3d.pointerStart=[e.clientX,e.clientY]);el.addEventListener('pointerup',e=>{if(!map3d.pointerStart||Math.hypot(e.clientX-map3d.pointerStart[0],e.clientY-map3d.pointerStart[1])>5)return;const rect=el.getBoundingClientRect();map3d.pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);map3d.ray.setFromCamera(map3d.pointer,map3d.camera);const hit=map3d.ray.intersectObjects([...map3d.roots.values()],true).find(x=>x.object.userData.mapObjectId||x.object.parent);if(hit){let node=hit.object;while(node&&!node.userData.mapObjectId)node=node.parent;if(node)map3dSelect(node.userData.mapObjectId)}else map3dSelect(null)})}

function map3dRenderAll(){
  if(!map3d.ready)return;const previous=map3d.selectedId;map3d.transform.detach();for(const root of map3d.roots.values())map3d.scene.remove(root);map3d.roots.clear();if(map3d.floor)map3d.scene.remove(map3d.floor);if(map3d.grid)map3d.scene.remove(map3d.grid);
  const b=mapData.bounds;const rw=Math.max(.5,b[2]-b[0]),rd=Math.max(.5,b[3]-b[1]),cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2;const floorMat=new THREE.MeshStandardMaterial({color:0x20283b,roughness:.92,metalness:.02});map3d.floor=new THREE.Mesh(new THREE.BoxGeometry(rw,.06,rd),floorMat);map3d.floor.position.set(cx,-.035,-cy);map3d.floor.receiveShadow=true;map3d.floor.userData.ignorePick=true;map3d.scene.add(map3d.floor);const size=Math.ceil(Math.max(rw,rd));map3d.grid=new THREE.GridHelper(size,Math.max(2,size*2),0x5f6f98,0x34405e);map3d.grid.position.set(cx,.003,-cy);map3d.scene.add(map3d.grid);
  mapData.objects.forEach(o=>{const root=map3dBuildObject(o);map3d.roots.set(o.id,root);map3d.scene.add(root)});if(previous&&map3d.roots.has(previous))map3dSelect(previous);else map3dSelect(null);map3dSyncRoomInputs();
}
function map3dMat(color,extra={}){return new THREE.MeshStandardMaterial({color,roughness:.62,metalness:.08,...extra})}
function map3dMesh(group,geometry,material,x,y,z){const m=new THREE.Mesh(geometry,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;group.add(m);return m}
function map3dBuildObject(o){
  const g=new THREE.Group();g.userData.mapObjectId=o.id;g.userData.mapObjectType=o.type;const asset=o.asset||o.type;const mat=asset==='glass-wall'?map3dMat(o.color,{transparent:true,opacity:.38}):map3dMat(o.color);const dark=map3dMat(0x26304a);const light=map3dMat(0xd9e0ef);
  if(o.type==='wall'||o.type==='box')map3dMesh(g,new THREE.BoxGeometry(o.w,o.h,o.d),mat,0,o.h/2,0);
  if(o.type==='door'){const post=Math.min(o.w*.12,.12),top=Math.min(o.h*.1,.14);map3dMesh(g,new THREE.BoxGeometry(post,o.h,o.d*1.25),dark,-o.w/2+post/2,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(post,o.h,o.d*1.25),dark,o.w/2-post/2,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w,top,o.d*1.25),dark,0,o.h-top/2,0);map3dMesh(g,new THREE.BoxGeometry(Math.max(.01,o.w-post*2),Math.max(.01,o.h-top),o.d),mat,0,(o.h-top)/2,0)}
  if(o.type==='window'){const frame=Math.min(o.w*.08,.09),pane=map3dMat(0x78d7ed,{transparent:true,opacity:.45});map3dMesh(g,new THREE.BoxGeometry(o.w,frame,o.d*1.4),dark,0,o.h-frame/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w,frame,o.d*1.4),dark,0,frame/2,0);map3dMesh(g,new THREE.BoxGeometry(frame,o.h,o.d*1.4),dark,-o.w/2+frame/2,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(frame,o.h,o.d*1.4),dark,o.w/2-frame/2,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w-frame*2,o.h-frame*2,o.d),pane,0,o.h/2,0)}
  if(o.type==='column')map3dMesh(g,new THREE.CylinderGeometry(o.w/2,o.d/2,o.h,24),mat,0,o.h/2,0);
  if(o.type==='stairs'){const steps=6;for(let i=0;i<steps;i++){const dep=o.d/steps,hh=o.h*(i+1)/steps;map3dMesh(g,new THREE.BoxGeometry(o.w,hh,dep),mat,0,hh/2,-o.d/2+dep*(i+.5))}}
  if(o.type==='table'){const top=Math.max(.04,o.h*.12),leg=Math.min(o.w,o.d)*.09;if(asset==='round-table')map3dMesh(g,new THREE.CylinderGeometry(o.w/2,o.w/2,top,28),mat,0,o.h-top/2,0);else map3dMesh(g,new THREE.BoxGeometry(o.w,top,o.d),mat,0,o.h-top/2,0);if(asset==='round-table')map3dMesh(g,new THREE.CylinderGeometry(leg*1.2,leg*1.6,o.h-top,18),dark,0,(o.h-top)/2,0);else[[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([sx,sz])=>map3dMesh(g,new THREE.BoxGeometry(leg,o.h-top,leg),dark,sx*(o.w/2-leg),(o.h-top)/2,sz*(o.d/2-leg)));if(asset==='computer-table'){map3dMesh(g,new THREE.BoxGeometry(o.w*.45,o.h*.3,.04),dark,0,o.h*1.18,0);map3dMesh(g,new THREE.BoxGeometry(.05,o.h*.38,.05),dark,0,o.h*.92,0)}}
  if(o.type==='chair'){const leg=Math.min(o.w,o.d)*.09,seatH=o.h*.48,seatT=Math.max(.035,o.h*.08);map3dMesh(g,new THREE.BoxGeometry(o.w,seatT,o.d),mat,0,seatH,0);[[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([sx,sz])=>map3dMesh(g,new THREE.BoxGeometry(leg,seatH,leg),dark,sx*(o.w/2-leg),seatH/2,sz*(o.d/2-leg)));map3dMesh(g,new THREE.BoxGeometry(o.w,Math.max(.05,o.h-seatH),leg),mat,0,seatH+(o.h-seatH)/2,o.d/2-leg/2)}
  if(o.type==='sofa'){const seat=o.h*.42,arm=Math.max(.08,o.w*.08);map3dMesh(g,new THREE.BoxGeometry(o.w,seat,o.d),dark,0,seat/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w-arm*2,o.h*.18,o.d*.72),mat,0,seat+o.h*.09,-o.d*.06);map3dMesh(g,new THREE.BoxGeometry(o.w,o.h-seat,o.d*.18),mat,0,seat+(o.h-seat)/2,o.d*.4);map3dMesh(g,new THREE.BoxGeometry(arm,o.h*.62,o.d),mat,-o.w/2+arm/2,o.h*.31,0);map3dMesh(g,new THREE.BoxGeometry(arm,o.h*.62,o.d),mat,o.w/2-arm/2,o.h*.31,0)}
  if(o.type==='cabinet'){map3dMesh(g,new THREE.BoxGeometry(o.w,o.h,o.d),mat,0,o.h/2,0);const count=asset==='bookshelf'?5:3;for(let i=1;i<count;i++)map3dMesh(g,new THREE.BoxGeometry(o.w*.92,.025,o.d*.92),dark,0,o.h*i/count,-o.d*.02);map3dMesh(g,new THREE.BoxGeometry(.02,o.h*.9,o.d*.03),dark,0,o.h*.48,-o.d/2-.02)}
  if(o.type==='lamp'){const stem=Math.min(o.w,o.d)*.09;map3dMesh(g,new THREE.CylinderGeometry(o.w*.35,o.w*.42,.08,20),dark,0,.04,0);map3dMesh(g,new THREE.CylinderGeometry(stem,stem,o.h*.7,12),dark,0,o.h*.38,0);map3dMesh(g,new THREE.ConeGeometry(o.w*.48,o.h*.3,24,1,true),mat,0,o.h*.84,0)}
  if(o.type==='rug')map3dMesh(g,new THREE.BoxGeometry(o.w,o.h,o.d),mat,0,o.h/2,0);
  if(o.type==='plant'){map3dMesh(g,new THREE.CylinderGeometry(o.w*.28,o.w*.38,o.h*.3,18),map3dMat(0x9a623d),0,o.h*.15,0);map3dMesh(g,new THREE.CylinderGeometry(o.w*.05,o.w*.07,o.h*.48,10),dark,0,o.h*.48,0);[[0,.78,0],[-.18,.7,.05],[.17,.65,-.08],[.05,.9,.04]].forEach(([x,y,z],i)=>map3dMesh(g,new THREE.SphereGeometry(o.w*(i? .25:.32),16,10),mat,x*o.w,y*o.h,z*o.d))}
  if(o.type==='bed'){const base=o.h*.24;map3dMesh(g,new THREE.BoxGeometry(o.w,base,o.d),dark,0,base/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w*.96,o.h*.36,o.d*.9),mat,0,base+o.h*.18,-o.d*.02);map3dMesh(g,new THREE.BoxGeometry(o.w,o.h*.82,.1),dark,0,o.h*.48,o.d/2-.05);map3dMesh(g,new THREE.BoxGeometry(o.w*.36,o.h*.13,o.d*.22),light,-o.w*.22,base+o.h*.42,o.d*.27)}
  if(o.type==='appliance'){map3dMesh(g,new THREE.BoxGeometry(o.w,o.h,o.d),mat,0,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w*.78,.025,o.d*.02),dark,0,o.h*.48,-o.d/2-.02);map3dMesh(g,new THREE.BoxGeometry(.035,o.h*.17,.035),dark,o.w*.3,o.h*.65,-o.d/2-.04)}
  if(o.type==='board'){map3dMesh(g,new THREE.BoxGeometry(o.w,o.h,o.d),mat,0,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w*1.06,.045,o.d*1.4),dark,0,.02,0)}
  if(o.type==='barrier'){const post=Math.min(.12,o.w*.1);map3dMesh(g,new THREE.BoxGeometry(post,o.h,post),dark,-o.w/2+post,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(post,o.h,post),dark,o.w/2-post,o.h/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w,o.h*.18,o.d),mat,0,o.h*.65,0);map3dMesh(g,new THREE.BoxGeometry(o.w,o.h*.18,o.d),light,0,o.h*.38,0)}
  if(o.type==='cone')map3dMesh(g,new THREE.ConeGeometry(o.w/2,o.h,20),mat,0,o.h/2,0);
  if(o.type==='start'){const baseH=o.h*.3;map3dMesh(g,new THREE.CylinderGeometry(Math.min(o.w,o.d)*.48,Math.min(o.w,o.d)*.48,baseH,28),dark,0,baseH/2,0);map3dMesh(g,new THREE.BoxGeometry(o.w*.72,o.h*.52,o.d*.7),mat,0,baseH+o.h*.26,0);const eyeGeo=new THREE.SphereGeometry(Math.min(o.w,o.h)*.055,12,8);map3dMesh(g,eyeGeo,light,-o.w*.14,baseH+o.h*.31,-o.d*.36);map3dMesh(g,eyeGeo,light,o.w*.14,baseH+o.h*.31,-o.d*.36);const arrow=map3dMesh(g,new THREE.ConeGeometry(o.w*.09,o.d*.28,12),map3dMat(0xffc857),0,o.h+.04,-o.d*.15);arrow.rotation.x=-Math.PI/2}
  g.position.set(o.x,o.z,-o.y);g.rotation.y=THREE.MathUtils.degToRad(o.r);g.traverse(n=>{n.userData.mapObjectId=o.id});return g;
}

function map3dSelect(id){map3d.selectedId=id&&map3d.roots.has(id)?id:null;map3d.transform?.detach();document.getElementById('map3d-empty').style.display=map3d.selectedId?'none':'';document.getElementById('map3d-form').style.display=map3d.selectedId?'':'none';if(!map3d.selectedId){document.getElementById('map3d-selected-title').textContent='คุณสมบัติวัตถุ';return}const o=map3dObject();const root=map3d.roots.get(o.id);map3d.transform.attach(root);document.getElementById('map3d-selected-title').textContent=`${map3dIcon(o)} ${o.name}`;map3dSyncPropInputs()}
function map3dObject(){return mapData.objects.find(o=>o.id===map3d.selectedId)}function map3dIcon(object){return MAP3D_ASSET_MAP[typeof object==='string'?object:object?.asset]?.icon||({wall:'🧱',door:'🚪',table:'🪑',chair:'💺',box:'📦',start:'🤖'})[object?.type||object]||'📦'}
function map3dTransformChanged(){const o=map3dObject(),root=map3d.roots.get(map3d.selectedId);if(!o||!root)return;o.x=map3dRound(root.position.x);o.y=map3dRound(-root.position.z);o.z=Math.max(0,map3dRound(root.position.y));o.r=map3dRound(THREE.MathUtils.radToDeg(root.rotation.y),2);map3dSyncPropInputs();map3dChanged()}
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
  const offset=((mapData.objects.length%5)-2)*.45;const o=map3dCreateAsset(assetId,{x:offset,y:offset*.6});mapData.objects.push(o);map3dCloseModal('map3d-object-modal');map3dRenderAll();map3dSelect(o.id);map3dChanged();mapStatus(`${asset.icon} เพิ่ม${asset.label}แล้ว — ลากเพื่อย้าย หรือแก้ขนาดด้านขวา`)
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
function map3dUseTemplate(id){const template=MAP3D_TEMPLATES.find(t=>t.id===id);if(!template)return;if(mapData.objects.length>1&&!confirm(`เปลี่ยนเป็น Template “${template.name}” และแทนที่ห้องปัจจุบันใช่หรือไม่?`))return;mapData.objects=[];template.build();map3dCloseModal('map3d-template-modal');map3d.selectedId=null;map3dRenderAll();map3dFocus();map3dChanged();mapStatus(`${template.icon} สร้าง ${template.name} แล้ว — แก้ไขต่อได้ทุกชิ้น`)}
function map3dTemplateAdd(asset,x,y,r=0,extra={}){const object=map3dCreateAsset(asset,{x,y,r,...extra});mapData.objects.push(object);return object}
function map3dTemplateShell(w,d){mapData.bounds=[-w/2,-d/2,w/2,d/2];map3dTemplateAdd('wall',0,-d/2,0,{w});map3dTemplateAdd('wall',0,d/2,0,{w});map3dTemplateAdd('wall',-w/2,0,90,{w:d});map3dTemplateAdd('wall',w/2,0,90,{w:d})}
function map3dBuildFamilyHome(){map3dTemplateShell(14,10);map3dTemplateAdd('wall',0,0,0,{w:14});map3dTemplateAdd('wall',0,0,90,{w:10});map3dTemplateAdd('door',-2,0);map3dTemplateAdd('door',2,0);map3dTemplateAdd('door',0,-2.2,90);map3dTemplateAdd('door',0,2.2,90);map3dTemplateAdd('double-bed',-3.6,2.6,90);map3dTemplateAdd('wardrobe',-6,2.7,90);map3dTemplateAdd('bedside-table',-2.3,3.5);map3dTemplateAdd('single-bed',3.7,2.5,90);map3dTemplateAdd('wardrobe',6,2.7,90);map3dTemplateAdd('desk',2.4,3.8);map3dTemplateAdd('sofa',-3.8,-3.5);map3dTemplateAdd('coffee-table',-3.8,-2.25);map3dTemplateAdd('tv-stand',-3.8,-.45);map3dTemplateAdd('armchair',-5.6,-2.1,90);map3dTemplateAdd('sofa',3.8,-3.5);map3dTemplateAdd('coffee-table',3.8,-2.25);map3dTemplateAdd('bookshelf',6.4,-2.2,90);map3dTemplateAdd('plant',2,-1);map3dTemplateAdd('rug',3.8,-2.5);map3dTemplateAdd('start',0,-4.1)}
function map3dBuildClassroom(){map3dTemplateShell(10,8);map3dTemplateAdd('whiteboard',0,3.9);map3dTemplateAdd('teacher-desk',0,2.6);for(let row=0;row<3;row++)for(let col=0;col<4;col++){const x=-3+col*2,y=1-row*1.7;map3dTemplateAdd('student-desk',x,y);map3dTemplateAdd('chair',x,y-.55)}map3dTemplateAdd('locker',-4.7,2.4,90);map3dTemplateAdd('storage-cabinet',4.7,2.4,90);map3dTemplateAdd('door',4,-4);map3dTemplateAdd('start',0,-3.2)}
function map3dBuildRobotLab(){map3dTemplateShell(12,9);for(let i=0;i<3;i++){map3dTemplateAdd('computer-table',-4+i*4,2.8);map3dTemplateAdd('computer-table',-4+i*4,.8);map3dTemplateAdd('chair',-4+i*4,2.1);map3dTemplateAdd('chair',-4+i*4,.1)}map3dTemplateAdd('charging-station',-5.5,-3.6,90);map3dTemplateAdd('storage-cabinet',5.5,2.6,90);map3dTemplateAdd('whiteboard',0,4.4);map3dTemplateAdd('barrier',-2,-2.2,25);map3dTemplateAdd('barrier',2,-2.2,-25);map3dTemplateAdd('cone',-3.5,-3);map3dTemplateAdd('cone',3.5,-3);map3dTemplateAdd('start',0,-3.7)}
function map3dBuildLivingDining(){map3dTemplateShell(10,7);map3dTemplateAdd('sofa',-2.8,-2.3);map3dTemplateAdd('armchair',-4.2,-.8,90);map3dTemplateAdd('coffee-table',-2.8,-1);map3dTemplateAdd('rug',-2.8,-1.2);map3dTemplateAdd('tv-stand',-2.8,1.1);map3dTemplateAdd('dining-table',2.5,-.7);[[1.4,-.7],[3.6,-.7],[2.5,-1.7],[2.5,.3]].forEach(([x,y],i)=>map3dTemplateAdd('chair',x,y,i<2?90:0));map3dTemplateAdd('kitchen-counter',3.7,2.7);map3dTemplateAdd('refrigerator',4.5,1.7);map3dTemplateAdd('plant',-4.3,2.5);map3dTemplateAdd('floor-lamp',-4,-2.6);map3dTemplateAdd('start',0,-2.8)}
function map3dBuildChallenge(){map3dTemplateShell(12,8);[[-4,-2],[-2,-1],[0,-2],[2,-1],[4,-2],[-4,1],[-2,2],[0,1],[2,2],[4,1]].forEach(([x,y],i)=>map3dTemplateAdd(i%3===0?'barrier':i%2?'cone':'box',x,y,i%2?0:35));map3dTemplateAdd('charging-station',-5.4,3.2,90);map3dTemplateAdd('start',-5,-3.2)}
function map3dBuildEmptyRoom(){map3dTemplateShell(8,6);map3dTemplateAdd('door',0,-3);map3dTemplateAdd('start',0,-2)}
function map3dSetMode(mode){if(map3d.transform){map3d.transform.setMode(mode);map3d.transform.showX=mode==='translate';map3d.transform.showY=true;map3d.transform.showZ=mode==='translate'}document.getElementById('map3d-move').classList.toggle('active',mode==='translate');document.getElementById('map3d-rotate').classList.toggle('active',mode==='rotate')}
function map3dDeleteSelected(){const o=map3dObject();if(!o)return;if(o.type==='start'){mapStatus('🤖 จุดเริ่มจำเป็นสำหรับหุ่นยนต์ สามารถย้ายหรือปรับขนาดได้แต่ลบไม่ได้');return}mapData.objects=mapData.objects.filter(x=>x.id!==o.id);map3d.selectedId=null;map3dRenderAll();map3dChanged();mapStatus(`🗑 ลบ${MAP3D_LABELS[o.type]}แล้ว`)}

function map3dUnitFactor(){return map3d.unit==='mm'?1000:map3d.unit==='cm'?100:1}function map3dChangeUnit(unit){map3d.unit=['mm','cm','m'].includes(unit)?unit:'m';document.querySelectorAll('.map3d-unit-label').forEach(e=>e.textContent=map3d.unit);map3dSyncPropInputs();map3dSyncRoomInputs();mapStatus(`📏 เปลี่ยนหน่วยแก้ไขเป็น ${map3d.unit} (ไฟล์ยังบันทึกเป็นเมตร)`)}
function map3dSetInput(id,value){const e=document.getElementById(id);if(e)e.value=Number.isFinite(value)?map3dRound(value,3):''}
function map3dSyncPropInputs(){const o=map3dObject();if(!o)return;const f=map3dUnitFactor();map3dSetInput('map3d-x',o.x*f);map3dSetInput('map3d-y',o.y*f);map3dSetInput('map3d-z',o.z*f);map3dSetInput('map3d-r',o.r);map3dSetInput('map3d-w',o.w*f);map3dSetInput('map3d-d',o.d*f);map3dSetInput('map3d-h',o.h*f)}
function map3dApplyProps(){const o=map3dObject();if(!o)return;const f=map3dUnitFactor(),v=id=>map3dNum(document.getElementById(id)?.value);o.x=v('map3d-x')/f;o.y=v('map3d-y')/f;o.z=Math.max(0,v('map3d-z')/f);o.r=v('map3d-r');o.w=Math.max(.001,v('map3d-w')/f);o.d=Math.max(.001,v('map3d-d')/f);o.h=Math.max(.001,v('map3d-h')/f);map3dRenderAll();map3dSelect(o.id);map3dChanged();mapStatus('✅ อัปเดตขนาดแล้ว (ค่าจริงเก็บเป็นเมตร)')}
function map3dSyncRoomInputs(){if(!Array.isArray(mapData.bounds))return;const f=map3dUnitFactor();map3dSetInput('map3d-room-w',(mapData.bounds[2]-mapData.bounds[0])*f);map3dSetInput('map3d-room-d',(mapData.bounds[3]-mapData.bounds[1])*f)}
function map3dApplyRoom(){const f=map3dUnitFactor(),w=Math.max(.5,map3dNum(document.getElementById('map3d-room-w').value)/f),d=Math.max(.5,map3dNum(document.getElementById('map3d-room-d').value)/f),b=mapData.bounds,cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2;mapData.bounds=[cx-w/2,cy-d/2,cx+w/2,cy+d/2].map(x=>map3dRound(x));const start=mapData.objects.find(o=>o.type==='start');if(start){start.x=Math.max(mapData.bounds[0],Math.min(mapData.bounds[2],start.x));start.y=Math.max(mapData.bounds[1],Math.min(mapData.bounds[3],start.y))}map3dRenderAll();map3dChanged();mapStatus('🏠 ปรับขนาดพื้นที่แล้ว')}

function map3dSyncLegacy(){
  const start=mapData.objects.find(o=>o.type==='start');mapData.start=start?[map3dRound(start.x),map3dRound(start.y)]:[0,0];mapData.startPose=start?{x:map3dRound(start.x),y:map3dRound(start.y),z:map3dRound(start.z),yaw:map3dRound(start.r,2)}:{x:0,y:0,z:0,yaw:0};const lines=[];
  mapData.objects.filter(o=>o.type!=='start'&&o.type!=='rug').forEach(o=>{if(o.type==='wall'||o.type==='door'){const a=THREE?.MathUtils?THREE.MathUtils.degToRad(o.r):o.r*Math.PI/180,dx=Math.cos(a)*o.w/2,dy=Math.sin(a)*o.w/2;lines.push([o.x-dx,o.y-dy,o.x+dx,o.y+dy].map(v=>map3dRound(v)));return}const a=o.r*Math.PI/180,c=Math.cos(a),s=Math.sin(a),corners=[[-o.w/2,-o.d/2],[o.w/2,-o.d/2],[o.w/2,o.d/2],[-o.w/2,o.d/2]].map(([x,y])=>[o.x+x*c-y*s,o.y+x*s+y*c]);for(let i=0;i<4;i++){const p=corners[i],q=corners[(i+1)%4];lines.push([p[0],p[1],q[0],q[1]].map(v=>map3dRound(v)))}});mapData.walls=lines;mapData.units='m';mapData.editorUnit=map3d.unit;
}
function map3dChanged(){map3dSyncLegacy();if(typeof mapSaveLocal==='function')mapSaveLocal()}

async function map3dAutoLoad(){
  if(sessionId){try{const response=await API('/api/files/read',{sessionId,path:'~/map.json'});if(response?.ok&&response.content){const loaded=JSON.parse(response.content);if(Array.isArray(loaded.walls)||Array.isArray(loaded.objects)){mapData.objects=Array.isArray(loaded.objects)?loaded.objects:[];Object.assign(mapData,loaded);mapSaveLocal();return 'workspace'}}}catch(error){console.warn('[Map3D] auto-load workspace:',error.message)}}
  if(typeof mapLoadLocal==='function'&&mapLoadLocal())return 'local';return 'new';
}
function map3dReturnToWizard(){
  setTimeout(()=>{if(typeof window.switchPage==='function')window.switchPage('dashboard');if(typeof loadDashboard==='function')loadDashboard()},900);
}
async function map3dSave(){
  map3dChanged();const button=document.getElementById('map3d-save');const old=button?.innerHTML;if(button){button.disabled=true;button.innerHTML='⏳ <span>กำลังบันทึก...</span>'}
  try{
    if(!sessionId){mapStatus('💾 บันทึกในเครื่องแล้ว — กำลังกลับไป ROS Wizzard');map3dReturnToWizard();return}
    const saved=await API('/api/files/write',{sessionId,path:'~/map.json',content:JSON.stringify(mapData)});if(!saved?.ok)throw new Error(saved?.error||'บันทึก map.json ไม่สำเร็จ');
    if(typeof isSimWorkspace!=='undefined'&&!isSimWorkspace){mapStatus('💾 บันทึก ~/map.json แล้ว — กำลังกลับไป ROS Wizzard');map3dReturnToWizard();return}
    mapStatus('🗺️ บันทึกแล้ว กำลังใช้แผนที่กับ Sim...');
    const applied=await API('/api/sim/apply-map',{sessionId,map:mapData});if(!applied?.ok)throw new Error(applied?.error||'Apply map ไม่สำเร็จ');
    mapStatus('🔨 กำลัง Build และเปิด MapSim node...');
    const started=await API('/api/sim/run-mapsim',{sessionId});if(!started?.ok)throw new Error(started?.error||'เปิด MapSim node ไม่สำเร็จ');
    mapStatus('✅ บันทึกและรัน /sim_robot_mapsim แล้ว — กำลังกลับไป ROS Wizzard');
    map3dReturnToWizard();
  }catch(error){mapStatus('⚠️ '+error.message)}finally{if(button){button.disabled=false;button.innerHTML=old||'💾 <span>บันทึกแผนที่ simulation</span>'}}
}
async function map3dLoad(){
  let loaded=null;if(sessionId){try{const r=await API('/api/files/read',{sessionId,path:'~/map.json'});if(r?.ok&&r.content)loaded=JSON.parse(r.content)}catch(e){mapStatus('⚠️ '+e.message);return}}
  if(!loaded){try{const raw=localStorage.getItem(mapStoreKey());if(raw)loaded=JSON.parse(raw)}catch(e){}}
  if(!loaded){mapStatus('ℹ️ ยังไม่มี map.json ที่บันทึกไว้');return}if(!Array.isArray(loaded.walls)&&!Array.isArray(loaded.objects)){mapStatus('⚠️ รูปแบบ map.json ไม่ถูกต้อง');return}mapData.objects=Array.isArray(loaded.objects)?loaded.objects:[];Object.assign(mapData,loaded);map3dNormalizeData();map3dRenderAll();map3dFocus();mapSaveLocal();mapStatus('📂 โหลดแผนที่ 3D แล้ว')
}
function map3dApplyToSim(){map3dChanged();if(typeof mapApplyToSim==='function')mapApplyToSim()}
function map3dView(view){const b=mapData.bounds,size=Math.max(b[2]-b[0],b[3]-b[1],4),cx=(b[0]+b[2])/2,cz=-(b[1]+b[3])/2;map3d.orbit.target.set(cx,0,cz);if(view==='top')map3d.camera.position.set(cx,size*1.35,cz+.001);else if(view==='front')map3d.camera.position.set(cx,size*.42,cz+size*1.25);else map3d.camera.position.set(cx+size*.8,size*.72,cz+size*.9);map3d.camera.lookAt(map3d.orbit.target);map3d.orbit.update()}
function map3dFocus(){map3dView('iso')}

window.addEventListener('keydown',e=>{if(!document.getElementById('page-map')?.classList.contains('show')||e.target.matches('input,select,textarea'))return;if(e.key.toLowerCase()==='w')map3dSetMode('translate');if(e.key.toLowerCase()==='e')map3dSetMode('rotate');if((e.key==='Delete'||e.key==='Backspace')&&map3d.selectedId)map3dDeleteSelected();if(e.key==='Escape'){map3dCloseModal('map3d-object-modal');map3dCloseModal('map3d-template-modal');map3dCloseModal('map3d-lidar-modal');map3dSelect(null)}});
