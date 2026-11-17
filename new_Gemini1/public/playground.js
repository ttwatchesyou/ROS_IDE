'use strict';

let playgroundReady=false;
let playgroundMapData=null;
let playgroundMapLoadId=0;
let playgroundPresentation=null;
const playgroundLayers={Environment:true,Map:false};
let playgroundHiddenTF=[];
let playgroundMode='mapping';
let playgroundNavGoal=null;
let playgroundNavRunning=false;
let playgroundNavStarting=false;
let playgroundSelectedMap='';
let playgroundNavReady=false;
let playgroundNavPackagePromise=null;
const PLAYGROUND_RUNTIME_TOPICS=['runtime','tf','odom','desc','scan','map'];

async function playgroundConnectRuntime(){
  const connected=!_live?await rvizConnect():await _restartStream();
  if(connected===false)throw new Error('เปิด RViz bridge ไม่สำเร็จภายใน 20 วินาที');
  await rvizWaitForData(PLAYGROUND_RUNTIME_TOPICS,15000);
}

function playgroundNavigationParameters(){
  return NavigationSettings.normalize(Object.fromEntries(Object.keys(NavigationSettings.fields).map(name=>[name,document.getElementById('pg-nav-'+name)?.value])));
}

let playgroundNavParametersSession=null;
async function playgroundLoadNavParameters(){
  if(!sessionId||playgroundNavParametersSession===sessionId)return;
  const requestSession=sessionId;playgroundNavParametersSession=requestSession;
  const before=JSON.stringify(playgroundNavigationParameters());
  try{
    const result=await API('/api/sim/navigation-parameters',{sessionId:requestSession});
    if(requestSession===sessionId&&result?.ok&&before===JSON.stringify(playgroundNavigationParameters()))playgroundSetNavFields(result.parameters);
  }catch{if(requestSession===sessionId)playgroundNavParametersSession=null;}
}

async function playgroundPrepareNavigationPackage(mapName=playgroundSelectedMap){
  if(!sessionId)return null;if(playgroundNavPackagePromise)return playgroundNavPackagePromise;
  const label=document.getElementById('pg-nav-package-status');if(label)label.textContent='⏳ กำลังสร้าง mecha_rayong_nav ใน workspace…';
  playgroundNavPackagePromise=API('/api/sim/prepare-navigation-package',{sessionId,mapName,parameters:playgroundNavigationParameters()}).then(result=>{
    if(result?.ok){if(label)label.textContent=`✅ สร้าง ${result.packageDir} แล้ว • Map: ${result.mapName}`;return result;}
    if(label)label.textContent='⚠️ '+(result?.error||'สร้าง Navigation package ไม่สำเร็จ');return null;
  }).catch(error=>{if(label)label.textContent='❌ '+error.message;return null;}).finally(()=>{playgroundNavPackagePromise=null;});
  return playgroundNavPackagePromise;
}

function playgroundRenderReadiness(data){
  playgroundNavReady=Boolean(data?.ready);const badge=document.getElementById('pg-nav-ready-badge'),checks=document.getElementById('pg-nav-checks'),error=document.getElementById('pg-nav-error');
  if(badge){badge.textContent=playgroundNavReady?'พร้อมออกเดินทาง':'ยังไม่พร้อม';badge.classList.toggle('ready',playgroundNavReady);}
  if(error){error.textContent=!data?.maps?.length?'⚠️ ยังไม่มี Saved Map — ไปโหมดเก็บแผนที่ สำรวจพื้นที่ แล้วกด Save Map ก่อน':data?.mapReady?'⚠️ ROS node หรือ topics ยังไม่ครบ ดูรายการด้านล่างแล้วลองเริ่มใหม่':'⚠️ กรุณาเลือก Saved Map ก่อนเริ่ม Navigation';error.classList.toggle('show',!playgroundNavReady);}
  if(checks)checks.innerHTML=(data?.checks||[]).map(check=>{const icon={ready:'✅',error:'❌',warning:'⚠️',auto:'🔄'}[check.state]||'•';return `<div class="pg-check ${check.state}"><i>${icon}</i><b>${check.label}</b><small>${check.detail}</small></div>`;}).join('');
}

async function playgroundLoadNavMaps(){
  const select=document.getElementById('pg-nav-map-select');if(!sessionId||!select)return;
  select.disabled=true;
  try{
    const data=await API('/api/sim/navigation-readiness',{sessionId,mapName:playgroundSelectedMap});if(!data?.ok)throw new Error(data?.error||'อ่านรายการ Map ไม่สำเร็จ');
    select.innerHTML='<option value="">— ยังไม่ได้เลือกแผนที่ —</option>'+data.maps.map(map=>`<option value="${map.name}">${map.ready?'🗺':'⚠️'} ${map.name}${map.explored===null?'':` — สำรวจ ${map.explored}%`}</option>`).join('');
    select.value=playgroundSelectedMap;playgroundRenderReadiness(data);
  }catch(error){playgroundNavReady=false;playgroundStatus('ตรวจสอบ Saved Map ไม่สำเร็จ: '+error.message);}
  finally{select.disabled=false;}
}

async function playgroundSelectNavMap(mapName){
  playgroundSelectedMap=/^[A-Za-z0-9_-]{1,40}$/.test(mapName)?mapName:'';playgroundNavRunning=false;
  if(!playgroundSelectedMap){await playgroundLoadNavMaps();playgroundStatus('ยังไม่ได้เลือกแผนที่สำหรับ Navigation');return;}
  try{
    const selected=await API('/api/sim/select-navigation-map',{sessionId,mapName:playgroundSelectedMap});if(!selected?.ok)throw new Error(selected?.error||'เลือก Map ไม่สำเร็จ');
    await playgroundLoadNavMaps();await playgroundPrepareNavigationPackage(playgroundSelectedMap);playgroundStatus(`เลือกแผนที่ “${playgroundSelectedMap}” แล้ว กดเริ่ม Navigation ได้เลย`);
  }catch(error){playgroundSelectedMap='';await playgroundLoadNavMaps();playgroundStatus('เลือกแผนที่ไม่ได้: '+error.message);}
}

async function playgroundOpenNavExport(){
  if(!sessionId){if(typeof sbMsg==='function')sbMsg('กรุณาเชื่อมต่อหุ่นยนต์ก่อน',2500);return;}
  openModal('pg-nav-export-modal');
  const select=document.getElementById('pg-export-map'),status=document.getElementById('pg-export-status'),button=document.getElementById('pg-export-download');
  if(select){select.disabled=true;select.innerHTML='<option value="">กำลังค้นหา Saved Map…</option>';}
  if(button)button.disabled=true;if(status)status.textContent='กำลังตรวจสอบแผนที่ที่พร้อม Export…';
  try{
    const data=await API('/api/sim/navigation-readiness',{sessionId,mapName:playgroundSelectedMap});if(!data?.ok)throw new Error(data?.error||'โหลดแผนที่ไม่สำเร็จ');
    const maps=(data.maps||[]).filter(map=>map.ready);
    if(select){select.innerHTML=maps.length?maps.map(map=>`<option value="${map.name}">🗺 ${map.name}${map.explored===null?'':` — สำรวจ ${map.explored}%`}</option>`).join(''):'<option value="">— ยังไม่มี Saved Map —</option>';select.value=maps.some(map=>map.name===playgroundSelectedMap)?playgroundSelectedMap:(maps[0]?.name||'');select.disabled=false;}
    if(button)button.disabled=!maps.length;if(status)status.textContent=maps.length?'พร้อมสร้าง Project — Parameters ปัจจุบันจะถูกบันทึกลง nav2_params.yaml':'ยังไม่มี Map สำหรับ Export กรุณาไปโหมดเก็บแผนที่และ Save Map ก่อน';
  }catch(error){if(status)status.textContent='❌ '+error.message;}
}

function playgroundExportMapChanged(){
  const mapName=document.getElementById('pg-export-map')?.value||'',status=document.getElementById('pg-export-status');
  if(status)status.textContent=mapName?`เลือก “${mapName}” แล้ว พร้อมสร้าง Navigation Project`:'กรุณาเลือก Saved Map';
}

function playgroundCopyExportCommand(id){
  const text=document.getElementById(id)?.textContent||'';if(!text)return;
  navigator.clipboard?.writeText(text).then(()=>{if(typeof sbMsg==='function')sbMsg('คัดลอกคำสั่งแล้ว',1800);}).catch(()=>{});
}

async function playgroundExportNavigation(){
  const mapName=document.getElementById('pg-export-map')?.value||'',button=document.getElementById('pg-export-download'),status=document.getElementById('pg-export-status');
  if(!mapName){if(status)status.textContent='⚠️ กรุณาเลือก Saved Map ก่อน';return;}
  const parameters=playgroundNavigationParameters();
  if(button){button.disabled=true;button.textContent='⏳ กำลังสร้างและ Build Package…';}if(status)status.textContent='กำลังรวม Map, Parameters, Launch และคู่มือติดตั้ง…';
  try{
    const token=getAuthToken(),response=await fetch('/api/sim/export-navigation-project',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders(token)},body:JSON.stringify({sessionId,mapName,parameters})});
    if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw new Error(error||'สร้างไฟล์ดาวน์โหลดไม่สำเร็จ');}
    const blob=await response.blob(),match=(response.headers.get('content-disposition')||'').match(/filename="?([^";]+)"?/i),filename=match?.[1]||`mecha_rayong_project_${mapName}.zip`,url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    if(status)status.textContent=`✅ Download ${filename} แล้ว — ภายในมี src, maps และ install_project.sh ครบ`;playgroundStatus('ดาวน์โหลด ROS Project พร้อมตัวติดตั้งสำเร็จ!',true);
  }catch(error){if(status)status.textContent='❌ '+error.message;}
  finally{if(button){button.disabled=false;button.textContent='⬇ Build และ Download ทั้ง Project';}}
}

function playgroundSetMode(mode){
  if(!['control','mapping','navigation'].includes(mode))return;
  playgroundMode=mode;playgroundStopRobot();
  document.querySelectorAll('#page-playground [data-pg-mode]').forEach(element=>element.classList.toggle('pg-mode-hidden',!element.dataset.pgMode.split(/\s+/).includes(mode)));
  document.querySelectorAll('#page-playground .pg-mode-btn').forEach(button=>button.classList.toggle('active',button.dataset.mode===mode));
  const primary=document.getElementById('pg-start-btn');
  if(primary)primary.textContent=mode==='mapping'?'▶ เริ่มเก็บ Map':mode==='navigation'?'▶ เริ่ม Navigation':'▶ เปิดสนามฝึกขับ';
  const mapLayerLabel=document.getElementById('pg-map-layer-label');if(mapLayerLabel)mapLayerLabel.textContent=mode==='mapping'?'🗺 SLAM Map':mode==='navigation'?'🗺 Saved Map':'🗺 สนามฝึก';
  const mapDisplay=typeof displayList!=='undefined'?displayList.find(display=>display.type==='Map'):null;
  if(mapDisplay){mapDisplay.props.topic=mode==='mapping'?'/slam_map':'/map';mapDisplay.enabled=true;}playgroundSyncMapLayers();
  if(_live&&typeof _restartStream==='function')_restartStream();
  if(mode==='mapping')playgroundStatus('โหมดเก็บแผนที่: ขับหุ่นให้ Laser สำรวจทุกมุม',_live);
  else if(mode==='navigation'){playgroundStatus('โหมด Navigation: กำลังสร้าง Package และตรวจ Saved Map',_live);playgroundLoadNavMaps();playgroundPrepareNavigationPackage();}
  else playgroundStatus('โหมดฝึกขับ: เปิดสนาม แล้วกดปุ่มทิศทางเพื่อควบคุมหุ่น',_live);
  if(typeof positionWorkspaceWizardReturn==='function')positionWorkspaceWizardReturn('playground');
}

function playgroundOpenMode(mode){
  if(!isSimWorkspace||!['control','mapping','navigation'].includes(mode))return;
  playgroundMode=mode;
  window.switchPage('playground');
}

function playgroundPrimaryAction(){return playgroundMode==='navigation'?playgroundStartNavigation():playgroundMode==='control'?playgroundStartControl():playgroundStart();}

function playgroundTuneLabel(){
  for(const name of Object.keys(NavigationSettings.fields)){
    const input=document.getElementById('pg-nav-'+name),label=document.getElementById('pg-nav-'+name+'-value');
    if(input&&label)label.value=Number(input.value).toFixed(2);
  }
  const p=playgroundNavigationParameters(),note=document.getElementById('pg-nav-clearance-note');
  if(note)note.textContent='ศูนย์กลางหุ่นต้องห่างวัตถุอย่างน้อย '+(p.radius+p.clearance).toFixed(2)+' m (รัศมี '+p.radius.toFixed(2)+' + ระยะปลอดภัย '+p.clearance.toFixed(2)+') และเผื่อความละเอียด Map เพิ่ม';
}
function playgroundNavNumber(name,value){
  const input=document.getElementById('pg-nav-'+name);if(!input)return;
  input.value=value;playgroundTuneLabel();
}
function playgroundSetNavFields(values){
  for(const [name,value] of Object.entries(NavigationSettings.normalize(values))){
    const input=document.getElementById('pg-nav-'+name);if(input)input.value=value;
  }
  playgroundTuneLabel();
}
function playgroundNavPreset(name,button){
  playgroundSetNavFields(NavigationSettings.presets[name]||NavigationSettings.presets.balanced);
  document.querySelectorAll('.pg-preset').forEach(item=>item.classList.toggle('active',item===button));
  playgroundStatus('เลือก template แล้ว กด “ใช้ค่า” เพื่อส่งให้หุ่น',_live);
}

let playgroundNavApplying=false;
async function playgroundApplyNavParams(){
  if(!sessionId||playgroundNavApplying)return false;
  playgroundNavApplying=true;
  const button=document.getElementById('pg-nav-apply');if(button)button.disabled=true;
  const requestSession=sessionId,parameters=playgroundNavigationParameters();
  try{
    playgroundStatus('กำลังใช้พารามิเตอร์ Navigation…');
    const result=await API('/api/sim/configure-navigation',{sessionId:requestSession,...parameters});
    if(requestSession!==sessionId)return false;
    if(!result?.ok)throw new Error(result?.error||'controller ไม่ตอบรับ');
    playgroundSetNavFields(result.parameters||parameters);
    // The controller invalidates/replans its active path exactly once on config change.
    // Package generation happens on Start/Export, not on each slider adjustment.
    playgroundStatus('ใช้ค่าแล้ว: ระยะจากศูนย์กลางหุ่น ≥ '+(parameters.radius+parameters.clearance).toFixed(2)+' m; controller จะตรวจเส้นทางใหม่',true);
    return true;
  }catch(error){if(requestSession===sessionId)playgroundStatus('ตั้งค่า Navigation ไม่สำเร็จ: '+error.message);return false;}
  finally{playgroundNavApplying=false;if(button)button.disabled=false;}
}

async function playgroundStartNavigation(){
  const button=document.getElementById('pg-start-btn');if(!sessionId){playgroundStatus('ยังไม่ได้เชื่อมต่อหุ่นจำลอง');return;}
  if(playgroundNavStarting){playgroundStatus('กำลังเปิด Navigation อยู่ กรุณารอสักครู่');return;}
  if(!playgroundSelectedMap||!playgroundNavReady){
    const error=document.getElementById('pg-nav-error');if(error)error.classList.add('show');
    playgroundStatus(playgroundSelectedMap?'แผนที่ที่เลือกยังไม่พร้อมใช้งาน':'กรุณาเลือก Saved Map ก่อนเริ่ม Navigation');return;
  }
  playgroundNavStarting=true;if(button){button.disabled=true;button.textContent='⏳ กำลังเปิด Navigation...';}
  try{
    const map=await playgroundLoadMapInfo();if(!map)throw new Error('โหลดข้อมูลสนามจำลองไม่สำเร็จ');
    const selected=await API('/api/sim/select-navigation-map',{sessionId,mapName:playgroundSelectedMap});if(!selected?.ok)throw new Error(selected?.error||'โหลด Saved Map ไม่สำเร็จ');
    playgroundEnsureDisplays();const mapDisplay=displayList.find(display=>display.type==='Map');if(mapDisplay)mapDisplay.props.topic='/map';
    const result=await API('/api/sim/run-mapsim',{sessionId});if(!result?.ok)throw new Error(result?.error||'เริ่ม MapSim ไม่สำเร็จ');
    await playgroundConnectRuntime();
    playgroundNavRunning=await playgroundApplyNavParams();
    if(!playgroundNavRunning)throw new Error('เปิด Navigation controller ไม่สำเร็จ');
    const readiness=await API('/api/sim/navigation-readiness',{sessionId,mapName:playgroundSelectedMap,checkRuntime:true});playgroundRenderReadiness(readiness);
    if(!readiness?.ready)throw new Error('ROS node หรือ topics สำหรับ Navigation ยังไม่ครบ กรุณาดูรายการความพร้อม');
    const mission=await API('/api/sim/start-navigation-mission',{sessionId,mapName:playgroundSelectedMap});
    if(!mission?.ok)throw new Error(mission?.error||'บันทึกการเริ่มภารกิจ Navigation ไม่สำเร็จ');
    rvizSetFixedFrame('map');rvizSetView('top');rvizCam.radius=10;
    playgroundStatus(`Navigation พร้อมแล้วบน Map “${playgroundSelectedMap}” — ตั้งจุดหมายได้เลย!`,true);
  }catch(error){playgroundStatus('เริ่ม Navigation ไม่สำเร็จ: '+error.message);}
  finally{playgroundNavStarting=false;if(button){button.disabled=false;button.textContent='↻ เริ่ม Navigation ใหม่';}}
}

function playgroundPickPose(kind){
  if(!playgroundNavRunning){playgroundStatus('กด “เริ่ม Navigation” ก่อนนะ');return;}
  if(typeof playgroundSetCameraView==='function')playgroundSetCameraView('free');
  rvizActivateTool(kind);playgroundStatus(kind==='goal'?'ลากลูกศร 🚩 จากจุดหมายไปยังทิศที่ต้องการ':'ลากลูกศร 📍 ที่ตำแหน่งจริงของหุ่น',true);
}

function playgroundPosePublished(kind,point,yaw,result){
  if(playgroundMode!=='navigation'||!result?.ok)return;
  if(kind==='goal'){
    playgroundNavGoal={x:point.ros.x,y:point.ros.y,yaw};
    const help=document.getElementById('pg-nav-help');if(help)help.textContent='หุ่นกำลังวางแผนและเดินทางไปยังธง 🚩';
    playgroundStatus('รับจุดหมายแล้ว หุ่นกำลังเดินทาง!',true);
  }else playgroundStatus('ตั้งตำแหน่งเริ่มต้นให้หุ่นแล้ว',true);
  rvizActivateTool('move');
}

function playgroundUpdateNavPose(x,y){
  if(playgroundMode!=='navigation'||!playgroundNavGoal)return;
  const distance=Math.hypot(playgroundNavGoal.x-x,playgroundNavGoal.y-y),label=document.getElementById('pg-nav-distance');if(label)label.textContent=distance.toFixed(2);
  // Completion comes from the controller (position AND heading), not distance alone.
}

function playgroundNavigationStatus(status){
  if(playgroundMode!=='navigation'||!status||typeof status.message!=='string')return;
  if(['failed','succeeded','canceled'].includes(status.state))playgroundNavGoal=null;
  const help=document.getElementById('pg-nav-help');if(help)help.textContent=status.message;
  const label=document.getElementById('pg-nav-distance');if(label&&Number.isFinite(status.distance))label.textContent=status.distance.toFixed(2);
  playgroundStatus(status.message,!['failed','blocked','replanning'].includes(status.state));
}

async function playgroundCancelNavigation(){
  if(sessionId){
    const result=await API('/api/sim/navigation-goal',{sessionId,cancel:true}).catch(error=>({ok:false,error:error.message}));
    if(!result?.ok){playgroundStatus('ยังยกเลิก Navigation ไม่สำเร็จ: '+(result?.error||'controller ไม่ตอบรับ'));return;}
  }
  playgroundNavGoal=null;const label=document.getElementById('pg-nav-distance');if(label)label.textContent='—';
  playgroundStopRobot();playgroundStatus('ยกเลิกภารกิจ Navigation แล้ว',_live);
}

function playgroundStatus(message,live=false){
  const status=document.getElementById('pg-status');
  if(status){status.textContent=message;status.classList.toggle('live',live);}
  const chip=document.getElementById('pg-live-chip');
  if(chip)chip.textContent=live?'โลกจำลองกำลังทำงาน ✨':message;
}

function playgroundUseViewport(){
  const host=document.getElementById('playground-view-host'),viewport=document.getElementById('rviz-viewport');
  if(!host||!viewport)return;
  host.appendChild(viewport);viewport.classList.add('playground-mode');
  if(typeof rvizApplyWorkspaceTheme==='function')rvizApplyWorkspaceTheme();
  setTimeout(()=>{if(typeof rvizResize==='function')rvizResize();},60);
}

function rvizUseDesktopLayout(){
  const anchor=document.getElementById('rviz-viewport-anchor'),viewport=document.getElementById('rviz-viewport');
  if(!anchor||!viewport)return;
  anchor.parentElement.insertBefore(viewport,anchor.nextSibling);viewport.classList.remove('playground-mode');
  playgroundClearDecor();
  playgroundHiddenTF.forEach(id=>{const d=displayList.find(x=>x.id===id);if(d){d.enabled=true;const obj=rviz3d.objects[id];if(obj)obj.visible=true;}});
  playgroundHiddenTF=[];
  setTimeout(()=>{if(typeof rvizResize==='function')rvizResize();},60);
}

function playgroundClearDecor(){
  if(typeof playgroundCameraSuspend==='function')playgroundCameraSuspend();
  for(const key of ['playgroundDecor','playgroundLighting']){
    const group=rviz3d?.[key];if(!group)continue;
    rviz3d.scene?.remove(group);MapSceneAssets.dispose(group);rviz3d[key]=null;
  }
  if(playgroundPresentation){
    const {renderer,settings,lights,grids,fog,fov}=playgroundPresentation;
    Object.assign(renderer,settings);Object.assign(renderer.shadowMap,playgroundPresentation.shadow);
    lights.forEach(([light,visible])=>light.visible=visible);
    grids.forEach(([id,enabled,visible])=>{const display=displayList.find(d=>d.id===id);if(display)display.enabled=enabled;const obj=rviz3d.objects[id];if(obj)obj.visible=visible;});
    rviz3d.scene.fog=fog;if(rviz3d.camera){rviz3d.camera.fov=fov;rviz3d.camera.updateProjectionMatrix();}
    playgroundPresentation=null;
    displayList.filter(d=>d.type==='Map').forEach(d=>{const obj=rviz3d.objects[d.id];if(obj)obj.visible=d.enabled;});
    rvizApplyWorkspaceTheme();
  }
}

function playgroundUseMapPresentation(map){
  const renderer=rviz3d.renderer;
  if(!playgroundPresentation){
    playgroundPresentation={renderer,settings:{outputEncoding:renderer.outputEncoding,toneMapping:renderer.toneMapping,toneMappingExposure:renderer.toneMappingExposure},shadow:{enabled:renderer.shadowMap.enabled,type:renderer.shadowMap.type},
      lights:rviz3d.scene.children.filter(n=>n.isLight).map(light=>[light,light.visible]),
      grids:displayList.filter(d=>d.type==='Grid').map(d=>[d.id,d.enabled,rviz3d.objects[d.id]?.visible??d.enabled]),fog:rviz3d.scene.fog,fov:rviz3d.camera.fov};
  }
  playgroundPresentation.lights.forEach(([light])=>light.visible=false);
  MapSceneAssets.configureRenderer(renderer);
  const lighting=MapSceneAssets.lighting(map.bounds);lighting.group.rotation.y=Math.PI/2;rviz3d.scene.add(lighting.group);rviz3d.playgroundLighting=lighting.group;
  const color=getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim()||'#111622';rviz3d.scene.fog=new THREE.Fog(color,22,65);
  rviz3d.camera.fov=48;rviz3d.camera.updateProjectionMatrix();rvizApplyWorkspaceTheme();
}

function playgroundRenderMapObjects(map){
  playgroundMapData=map;
  playgroundClearDecor();
  if(!map||!rviz3d?.scene||!rviz3d.renderer||typeof THREE==='undefined')return;
  const bounds=Array.isArray(map.bounds)&&map.bounds.length===4&&map.bounds.every(Number.isFinite)&&map.bounds[2]>map.bounds[0]&&map.bounds[3]>map.bounds[1]?map.bounds:[-4,-4,4,4];
  const model={...map,bounds},objects=map3dReadObjects(model),group=new THREE.Group();group.name='Map Editor Objects';
  // Editor (x,z,-y) → RViz (-y,z,-x): rotate the entire model once.
  // This preserves all child geometry, UVs, door hinges and ROS scan alignment.
  group.rotation.y=Math.PI/2;group.add(MapSceneAssets.roomFloor(model));
  objects.filter(obj=>obj.type!=='start').forEach(obj=>group.add(MapSceneAssets.build(obj,objects)));
  rviz3d.scene.add(group);rviz3d.playgroundDecor=group;
  playgroundUseMapPresentation(model);playgroundSyncMapLayers();
}

function playgroundSyncMapLayers(){
  const decor=rviz3d?.playgroundDecor;if(!decor)return;
  decor.visible=playgroundLayers.Environment;
  // Keep Map subscribed for SLAM progress while its visual overlay is hidden.
  displayList.filter(d=>d.type==='Map').forEach(d=>{d.enabled=true;const obj=rviz3d.objects[d.id];if(obj)obj.visible=playgroundLayers.Map;});
  for(const [id,enabled,visible] of playgroundPresentation?.grids||[]){const obj=rviz3d.objects[id];if(obj)obj.visible=!playgroundLayers.Environment&&enabled&&visible;}
  const checkbox=document.getElementById('pg-layer-map');if(checkbox)checkbox.checked=playgroundLayers.Map;
}

function playgroundFitMapView(){
  if(!rviz3d.camera||!playgroundMapData)return;
  const b=playgroundMapData.bounds||[-4,-4,4,4],size=Math.max(b[2]-b[0],b[3]-b[1],4),ratio=Math.hypot(.72,.98,.8);
  const target=r2t((b[0]+b[2])/2,(b[1]+b[3])/2,0);rvizCam.target={x:target.x,y:target.y,z:target.z};
  rvizCam.theta=Math.atan2(.8,-.72);rvizCam.phi=Math.acos(.98/ratio);rvizCam.radius=size*ratio*Math.max(1,1/rviz3d.camera.aspect);
}

function playgroundEnsureDisplays(){
  if(typeof displayList==='undefined'||!rviz3d?.scene)return false;
  let changed=false;
  const enableDisplay=(type,props)=>{
    let display=displayList.find(item=>item.type===type);
    if(!display){rvizAddDisplay(type,true,props);changed=true;return displayList.find(item=>item.type===type);}
    display.props={...(display.props||{}),...props};
    display.enabled=true;
    const object=rviz3d.objects[display.id];if(object)object.visible=true;
    return display;
  };
  const mapDisplay=displayList.find(d=>d.type==='Map');
  const mapTopic=playgroundMode==='mapping'?'/slam_map':'/map';
  if(!mapDisplay){rvizAddDisplay('Map',true,{topic:mapTopic,alpha:.9});changed=true;}
  else{mapDisplay.props={...(mapDisplay.props||{}),topic:mapTopic};mapDisplay.enabled=true;const obj=rviz3d.objects[mapDisplay.id];if(obj)obj.visible=true;}
  enableDisplay('LaserScan',{topic:'/scan',frameId:'laser_frame',size:.055,color:'#ff4057'});
  enableDisplay('Odometry',{topic:'/odom',frameId:'odom',color:'#ffba38',keep:500});
  enableDisplay('RobotModel',{baseFrame:'base_link',alpha:1});
  enableDisplay('Path',{topic:'/plan',color:'#32e59b',width:3});
  // เด็กไม่จำเป็นต้องเห็นแกน/ชื่อ TF ทุกเฟรมซ้อนบนฉาก แต่ bridge
  // ยัง subscribe /tf เพื่อขยับ RobotModel, LaserScan และ Odometry ตามจริง
  displayList.filter(d=>d.type==='TF'&&d.enabled).forEach(d=>{
    if(!playgroundHiddenTF.includes(d.id))playgroundHiddenTF.push(d.id);
    d.enabled=false;const obj=rviz3d.objects[d.id];if(obj)obj.visible=false;
  });
  playgroundSyncMapLayers();rvizRenderPanel();rvizSetFixedFrame('map');return true;
}

function playgroundToggleLayer(type,enabled){
  if(type==='Environment'||type==='Map'){playgroundLayers[type]=enabled;playgroundSyncMapLayers();return;}
  displayList.filter(d=>d.type===type).forEach(d=>{d.enabled=enabled;const obj=rviz3d.objects[d.id];if(obj)obj.visible=enabled;});
  if(type==='TF'&&enabled)playgroundHiddenTF=[];
  rvizRenderPanel();
}

function playgroundUpdateSlamProgress(map){
  if(!map||!Array.isArray(map.data)||!map.data.length)return;
  const known=map.data.reduce((count,value)=>count+(value>=0?1:0),0),percent=Math.round(known/map.data.length*100);
  const value=document.getElementById('pg-slam-percent'),bar=document.getElementById('pg-slam-progress');
  if(value)value.textContent=percent+'%';if(bar)bar.style.width=percent+'%';
}

async function playgroundSaveSlamMap(){
  if(!_live||!sessionId){playgroundStatus('เริ่มภารกิจ SLAM ก่อนบันทึกแผนที่นะ');return;}
  const input=document.getElementById('pg-map-name'),button=document.getElementById('pg-save-map-btn'),output=document.getElementById('pg-save-result');
  const mapName=(input?.value||'my_slam_map').trim().replace(/[^A-Za-z0-9_-]/g,'_').slice(0,40)||'my_slam_map';
  if(button){button.disabled=true;button.textContent='⏳ กำลังสร้าง Package...';}if(output)output.textContent='กำลังแปลงเป็น PGM/YAML และ build ROS 2 package';
  try{
    const result=await API('/api/sim/save-slam-map',{sessionId,mapName});
    if(!result?.ok)throw new Error(result?.error||'บันทึกไม่สำเร็จ');
    if(output)output.innerHTML=`✅ บันทึกแล้ว: <b>${result.yaml}</b><br>ผ่านขั้นตอนวาดแผนที่ใน ROS Wizzard แล้ว`;
    playgroundStatus('บันทึก SLAM Map และผ่านภารกิจวาดแผนที่แล้ว!',true);
    playgroundLoadNavMaps();
  }catch(error){if(output)output.textContent='❌ '+error.message;playgroundStatus('บันทึกแผนที่ไม่สำเร็จ: '+error.message);}
  finally{if(button){button.disabled=false;button.textContent='💾 Save Map สำหรับ Nav2';}}
}

async function playgroundLoadMapInfo(){
  const requestId=++playgroundMapLoadId,requestSession=sessionId;
  if(!sessionId){playgroundMapData=null;playgroundClearDecor();playgroundStatus('เชื่อมต่อหุ่นจำลองก่อน แล้วกลับมาเปิดหน้านี้อีกครั้ง');return null;}
  try{
    const response=await API('/api/files/read',{sessionId,path:'~/map.json'});
    if(requestId!==playgroundMapLoadId||sessionId!==requestSession)return null;
    if(!response?.ok||!response.content)throw new Error('ยังไม่มีแผนที่');
    const map=JSON.parse(response.content),bounds=map.bounds||[-4,-4,4,4],start=map.start||[0,0];
    const width=Math.abs(Number(bounds[2])-Number(bounds[0])),height=Math.abs(Number(bounds[3])-Number(bounds[1]));
    const size=document.getElementById('pg-map-size'),pose=document.getElementById('pg-map-start'),objects=document.getElementById('pg-map-objects');
    if(size)size.textContent=`${width.toFixed(1)} × ${height.toFixed(1)} m`;
    if(pose)pose.textContent=`${Number(start[0]).toFixed(1)}, ${Number(start[1]).toFixed(1)} m`;
    if(objects)objects.textContent=String(Array.isArray(map.objects)?map.objects.length:0);
    playgroundRenderMapObjects(map);playgroundFitMapView();
    playgroundStatus('พบแผนที่แล้ว พร้อมเริ่มโลกจำลอง');return map;
  }catch(error){if(requestId!==playgroundMapLoadId||sessionId!==requestSession)return null;playgroundMapData=null;playgroundClearDecor();playgroundStatus('โหลด Map ไม่สำเร็จ — '+error.message);return null;}
}

function playgroundBindDrive(){
  if(playgroundReady)return;playgroundReady=true;
  document.querySelectorAll('#page-playground .pg-drive-btn').forEach(button=>{
    const direction=button.dataset.dir;
    let heldPointer=null;
    const down=event=>{event.preventDefault();if(!_live){playgroundStatus('กดเริ่มโลกจำลองก่อนนะ');return;}heldPointer=event.pointerId;try{button.setPointerCapture(event.pointerId);}catch{}rvizTeleopSet(direction,true);playgroundStatus('กำลังขับหุ่น — ปล่อยปุ่มเพื่อหยุด',true);};
    const up=event=>{if(heldPointer===null)return;event.preventDefault();heldPointer=null;rvizTeleopSet(direction,false);playgroundStatus('หุ่นหยุดแล้ว พร้อมรับคำสั่งต่อไป',_live);};
    button.addEventListener('pointerdown',down);button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('lostpointercapture',up);
  });
  const keyMap={ArrowUp:'fwd',w:'fwd',ArrowDown:'back',s:'back',ArrowLeft:'left',a:'left',ArrowRight:'right',d:'right'};
  window.addEventListener('keydown',event=>{const page=document.getElementById('page-playground'),dir=keyMap[event.key];if(!page?.classList.contains('show')||!dir||event.repeat||playgroundMode==='navigation'||event.target.closest?.('input,textarea,select,[contenteditable="true"],#pg-camera-menu'))return;event.preventDefault();document.querySelector(`#page-playground .pg-drive-btn[data-dir="${dir}"]`)?.classList.add('on');if(_live)rvizTeleopSet(dir,true);});
  window.addEventListener('keyup',event=>{const page=document.getElementById('page-playground'),dir=keyMap[event.key];if(!page?.classList.contains('show')||!dir)return;event.preventDefault();document.querySelector(`#page-playground .pg-drive-btn[data-dir="${dir}"]`)?.classList.remove('on');rvizTeleopSet(dir,false);});
  window.addEventListener('blur',()=>{if(document.getElementById('page-playground')?.classList.contains('show'))playgroundStopRobot();});
}

function initRobotPlayground(){
  if(!isSimWorkspace)return;
  if(typeof playgroundCameraEnter==='function')playgroundCameraEnter();
  playgroundUseViewport();playgroundBindDrive();playgroundTuneLabel();playgroundLoadNavParameters();playgroundSetMode(playgroundMode);playgroundLoadMapInfo();
  if(typeof initRviz==='function')initRviz();
  let tries=0;const wait=setInterval(()=>{if(playgroundEnsureDisplays()||++tries>30){clearInterval(wait);if(rviz3d?.camera){playgroundRenderMapObjects(playgroundMapData);playgroundFitMapView();rvizResize();}}},100);
}

async function playgroundStart(){
  const button=document.getElementById('pg-start-btn');
  if(!sessionId){playgroundStatus('ยังไม่ได้เชื่อมต่อหุ่นจำลอง');return;}
  const map=await playgroundLoadMapInfo();if(!map)return;
  if(button){button.disabled=true;button.textContent='⏳ กำลังสร้างโลก...';}
  try{
    playgroundStatus('กำลังสร้าง Map และวางหุ่นที่จุดเริ่มต้น...');
    const progress=document.getElementById('pg-slam-progress'),percent=document.getElementById('pg-slam-percent');if(progress)progress.style.width='0%';if(percent)percent.textContent='0%';
    playgroundEnsureDisplays();
    const result=await API('/api/sim/run-mapsim',{sessionId});
    if(!result?.ok)throw new Error(result?.error||'เริ่ม MapSim ไม่สำเร็จ');
    await playgroundConnectRuntime();
    const saveButton=document.getElementById('pg-save-map-btn');if(saveButton)saveButton.disabled=false;
    playgroundStatus('SLAM เริ่มแล้ว! ขับหุ่นให้ Laser สำรวจพื้นที่สีเทา',true);
    rvizSetFixedFrame('map');playgroundFitMapView();
  }catch(error){playgroundStatus('เริ่มโลกจำลองไม่สำเร็จ: '+error.message);}
  finally{if(button){button.disabled=false;button.textContent='↻ เริ่ม SLAM ใหม่';}}
}

async function playgroundStartControl(){
  const button=document.getElementById('pg-start-btn');
  if(!sessionId){playgroundStatus('ยังไม่ได้เชื่อมต่อหุ่นจำลอง');return;}
  const map=await playgroundLoadMapInfo();if(!map)return;
  if(button){button.disabled=true;button.textContent='⏳ กำลังเปิดสนามฝึก...';}
  try{
    playgroundStatus('กำลังวางหุ่นยนต์และเตรียมปุ่มควบคุม...');
    playgroundEnsureDisplays();
    const result=await API('/api/sim/run-mapsim',{sessionId});
    if(!result?.ok)throw new Error(result?.error||'เริ่มสนามฝึกไม่สำเร็จ');
    await playgroundConnectRuntime();
    rvizSetFixedFrame('map');playgroundFitMapView();
    playgroundStatus('สนามพร้อมแล้ว! กดปุ่มทิศทางค้างเพื่อขับ และปล่อยเพื่อหยุด',true);
  }catch(error){playgroundStatus('เปิดสนามฝึกไม่สำเร็จ: '+error.message);}
  finally{if(button){button.disabled=false;button.textContent='↻ เริ่มสนามฝึกใหม่';}}
}

function playgroundSetSpeed(value){
  const speed=Math.max(.1,Math.min(2,Number(value)||.6));rvizTeleop.linScale=speed;rvizTeleop.angScale=Math.max(.8,speed*2);
  const label=document.getElementById('pg-speed-value');if(label)label.textContent=speed.toFixed(1);
}

function playgroundStopRobot(){
  document.querySelectorAll('#page-playground .pg-drive-btn').forEach(button=>button.classList.remove('on'));
  rvizTeleopStop();playgroundStatus('หุ่นหยุดแล้ว พร้อมรับคำสั่งต่อไป',_live);
}
