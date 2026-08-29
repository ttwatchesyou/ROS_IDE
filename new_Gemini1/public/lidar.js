// Real robot LiDAR setup: model-specific driver install + live /scan plot.
const LIDAR_MODELS=[
  {id:'rplidar_a1',brand:'SLAMTEC',name:'RPLIDAR A1 / A1M8',detail:'360° · 0.15–12 m · USB',port:'/dev/ttyUSB0',baud:'115200',repo:'https://github.com/Slamtec/sllidar_ros2'},
  {id:'rplidar_a2',brand:'SLAMTEC',name:'RPLIDAR A2M8',detail:'360° · สูงสุด 18 m · USB',port:'/dev/ttyUSB0',baud:'115200',repo:'https://github.com/Slamtec/sllidar_ros2'},
  {id:'rplidar_c1',brand:'SLAMTEC',name:'RPLIDAR C1',detail:'360° · สูงสุด 12 m · USB',port:'/dev/ttyUSB0',baud:'460800',repo:'https://github.com/Slamtec/sllidar_ros2'},
  {id:'rplidar_s2',brand:'SLAMTEC',name:'RPLIDAR S2',detail:'360° · สูงสุด 30 m · USB',port:'/dev/ttyUSB0',baud:'1000000',repo:'https://github.com/Slamtec/sllidar_ros2'},
  {id:'ydlidar_x4',brand:'YDLIDAR',name:'YDLIDAR X4',detail:'360° · 0.12–10 m · USB',port:'/dev/ttyUSB0',baud:'128000',repo:'https://github.com/YDLIDAR/ydlidar_ros2'},
  {id:'ydlidar_g4',brand:'YDLIDAR',name:'YDLIDAR G4',detail:'360° · 0.10–16 m · USB',port:'/dev/ttyUSB0',baud:'230400',repo:'https://github.com/YDLIDAR/ydlidar_ros2'},
  {id:'ldlidar_ld06',brand:'LDROBOT',name:'LD06',detail:'360° · 0.02–12 m · USB/UART',port:'/dev/ttyUSB0',baud:'230400',repo:'https://github.com/ldrobotSensorTeam/ldlidar_stl_ros2'},
  {id:'ldlidar_ld19',brand:'LDROBOT',name:'LD19',detail:'360° · 0.02–12 m · USB/UART',port:'/dev/ttyUSB0',baud:'230400',repo:'https://github.com/ldrobotSensorTeam/ldlidar_stl_ros2'},
  {id:'hokuyo_ust10lx',brand:'Hokuyo',name:'UST-10LX',detail:'270° · 0.06–10 m · Ethernet',port:'192.168.0.10',baud:'Ethernet',repo:'https://github.com/Hokuyo-aut/urg_node2'},
];
let lidarSelected='rplidar_a1',lidarScanTimer=null,lidarSocket=null,lidarPolling=false,lidarLastScan=null,lidarLastReceived=0;
let lidarPackageState=null,lidarKnownPorts=[],lidarBusy=false,lidarStatusSequence=0;
let lidarDriverBusy=false,lidarDiagnosticText='',lidarPreferences={lastModel:'rplidar_a1',models:{}},lidarPreferenceLoadedFromStorage=false;
let lidarZoom=1,lidarZoomPointers=new Map(),lidarPinchDistance=0;

function lidarModel(){return LIDAR_MODELS.find(item=>item.id===lidarSelected)||LIDAR_MODELS[0];}
function lidarPreferenceKey(){return `ros2ide_lidar_${localStorage.getItem('ros2ide_robotid')||wsPath||'robot'}`;}
function lidarLoadPreferences(){
  try{const raw=localStorage.getItem(lidarPreferenceKey());lidarPreferenceLoadedFromStorage=!!raw;const saved=JSON.parse(raw||'{}');if(saved&&typeof saved==='object')lidarPreferences={lastModel:saved.lastModel||'rplidar_a1',models:saved.models&&typeof saved.models==='object'?saved.models:{}};}catch(_){lidarPreferences={lastModel:'rplidar_a1',models:{}};}
  if(LIDAR_MODELS.some(item=>item.id===lidarPreferences.lastModel))lidarSelected=lidarPreferences.lastModel;
}
function lidarSavedModel(){return lidarPreferences.models[lidarSelected]||{};}
function lidarUpdateLaunchPreview(){
  const item=lidarModel(),port=lidarSelectedPort(),baud=lidarSelectedBaud(),target=document.getElementById('lidar-launch-command');if(!target)return;
  target.textContent=item.brand==='YDLIDAR'?`ros2 run ydlidar ydlidar_node --ros-args -p port:=${port} -p baudrate:=${baud}`:item.port.includes('.')?`ros2 launch ${item.id.startsWith('hokuyo')?'urg_node2':item.id} ${item.id.startsWith('hokuyo')?'urg_node2.launch.py':'lidar.launch.py'} ip_address:=${port}`:`ros2 launch ${item.repo.includes('sllidar')?'sllidar_ros2':item.id.startsWith('ldlidar')?'ldlidar_stl_ros2':item.id} ${item.id==='rplidar_a1'?'sllidar_a1_launch.py':item.id==='rplidar_a2'?'sllidar_a2m8_launch.py':item.id==='rplidar_c1'?'sllidar_c1_launch.py':item.id==='rplidar_s2'?'sllidar_s2_launch.py':item.id.endsWith('ld06')?'ld06.launch.py':'ld19.launch.py'} serial_port:=${port} serial_baudrate:=${baud}`;
}
function lidarSavePreference(){
  const item=lidarModel(),baud=document.getElementById('lidar-baud-input')?.value||item.baud,port=document.getElementById('lidar-port-select')?.value||item.port;
  lidarPreferences.lastModel=lidarSelected;lidarPreferences.models[lidarSelected]={port,baud};localStorage.setItem(lidarPreferenceKey(),JSON.stringify(lidarPreferences));
}
function initLidarSetup(){
  if(isSimWorkspace){window.switchPage('dashboard');return;}
  lidarLoadPreferences();
  const workspace=document.getElementById('lidar-workspace');if(workspace)workspace.textContent=(wsPath||'~/ros2_ws')+'/src';
  const brands=[...new Set(LIDAR_MODELS.map(item=>item.brand))];
  const tabs=document.getElementById('lidar-brand-tabs');
  if(tabs&&!tabs.children.length)tabs.innerHTML=brands.map((brand,index)=>`<button type="button" class="lidar-brand${index===0?' active':''}" data-brand="${escH(brand)}" onclick="lidarChooseBrand(decodeURIComponent('${encArg(brand)}'))">${escH(brand)}</button>`).join('');
  const selectedBrand=lidarModel().brand;
  document.querySelectorAll('.lidar-brand').forEach(button=>button.classList.toggle('active',button.dataset.brand===selectedBrand));
  lidarRenderModels(selectedBrand);lidarSelectModel(lidarSelected);
  lidarBindZoom();
  requestAnimationFrame(()=>lidarDrawScan(lidarLastScan));
}

function lidarSetZoom(value){
  lidarZoom=Math.max(.5,Math.min(10,Number(value)||1));
  const label=document.getElementById('lidar-zoom-value');if(label)label.textContent=lidarZoom.toFixed(1)+'×';
  lidarDrawScan(lidarLastScan);
}
function lidarZoomBy(factor){lidarSetZoom(lidarZoom*factor);}
function lidarResetZoom(){lidarSetZoom(1);}
function lidarBindZoom(){
  const canvas=document.getElementById('lidar-canvas');if(!canvas||canvas.dataset.zoomBound)return;canvas.dataset.zoomBound='1';
  canvas.addEventListener('wheel',event=>{event.preventDefault();lidarZoomBy(event.deltaY<0?1.18:1/1.18);},{passive:false});
  const distance=()=>{const points=[...lidarZoomPointers.values()];return points.length<2?0:Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);};
  canvas.addEventListener('pointerdown',event=>{if(event.pointerType==='touch'){lidarZoomPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});canvas.setPointerCapture?.(event.pointerId);if(lidarZoomPointers.size===2)lidarPinchDistance=distance();}});
  canvas.addEventListener('pointermove',event=>{if(!lidarZoomPointers.has(event.pointerId))return;lidarZoomPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const next=distance();if(lidarPinchDistance&&next){lidarZoomBy(next/lidarPinchDistance);lidarPinchDistance=next;}});
  const release=event=>{lidarZoomPointers.delete(event.pointerId);if(lidarZoomPointers.size<2)lidarPinchDistance=0;};canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  canvas.addEventListener('dblclick',lidarResetZoom);
}

function lidarChooseBrand(brand){
  document.querySelectorAll('.lidar-brand').forEach(button=>button.classList.toggle('active',button.dataset.brand===brand));
  lidarRenderModels(brand);
  const first=LIDAR_MODELS.find(item=>item.brand===brand);if(first)lidarSelectModel(first.id);
}

function lidarRenderModels(brand){
  const grid=document.getElementById('lidar-model-grid');if(!grid)return;
  grid.innerHTML=LIDAR_MODELS.filter(item=>item.brand===brand).map(item=>`<button type="button" class="lidar-model-card${item.id===lidarSelected?' selected':''}" data-model="${item.id}" onclick="lidarSelectModel('${item.id}')"><span class="lidar-model-icon">◉</span><span><b>${escH(item.name)}</b><small>${escH(item.detail)}</small></span><span class="lidar-model-check">✓</span></button>`).join('');
}

function lidarSelectModel(id){
  if(!LIDAR_MODELS.some(item=>item.id===id))return;lidarSelected=id;lidarPreferences.lastModel=id;
  document.querySelectorAll('.lidar-model-card').forEach(card=>card.classList.toggle('selected',card.dataset.model===id));
  const item=lidarModel();
  document.getElementById('lidar-selected-name').textContent=`${item.brand} ${item.name}`;
  document.getElementById('lidar-selected-detail').textContent=item.detail;
  const baud=document.getElementById('lidar-baud-input'),saved=lidarSavedModel();if(baud){baud.value=saved.baud||item.baud;baud.disabled=item.baud==='Ethernet';}
  document.getElementById('lidar-repository').textContent=item.repo.replace('https://github.com/','');
  localStorage.setItem(lidarPreferenceKey(),JSON.stringify(lidarPreferences));
  lidarUpdateLaunchPreview();
  lidarPackageState=null;
  lidarRefreshStatus();
}

function lidarSetInstallStatus(text,kind=''){
  const status=document.getElementById('lidar-install-status');if(!status)return;
  status.className=`lidar-install-status${kind?' '+kind:''}`;status.textContent=text;
}

function lidarResetPipeline(){document.querySelectorAll('.lidar-build-step').forEach(step=>step.classList.remove('active','done','error'));}
function lidarPipeline(stage,state='active'){
  const order=['driver','tools','dependencies','build'],index=Math.max(0,order.indexOf(stage));
  document.querySelectorAll('.lidar-build-step').forEach(step=>{
    const at=order.indexOf(step.dataset.stage);step.classList.remove('active','done','error');
    if(at<index)step.classList.add('done');else if(at===index)step.classList.add(state);
  });
}
function lidarPipelineComplete(){document.querySelectorAll('.lidar-build-step').forEach(step=>{step.classList.remove('active','error');step.classList.add('done');});}

function lidarSelectedPort(){return document.getElementById('lidar-port-select')?.value||lidarSavedModel().port||lidarModel().port;}
function lidarSelectedBaud(){const value=Number(document.getElementById('lidar-baud-input')?.value);return Number.isInteger(value)&&value>=1200&&value<=4000000?value:Number(lidarModel().baud)||null;}
function lidarRenderPorts(ports=[]){
  lidarKnownPorts=Array.isArray(ports)?ports:[];
  const select=document.getElementById('lidar-port-select');if(!select)return;
  const previous=select.value,saved=lidarSavedModel(),item=lidarModel(),available=lidarKnownPorts.slice();
  if(saved.port&&!available.some(port=>port.path===saved.port))available.push({path:saved.port,label:saved.port,connected:false});
  if(!available.some(port=>port.path===item.port))available.push({path:item.port,label:item.port,connected:false});
  select.innerHTML=available.map(port=>`<option value="${escH(port.path)}">${port.connected?'●':'○'} ${escH(port.path)} · ${escH(port.label||port.path)}${!port.connected?' (ไม่พบอุปกรณ์)':port.accessible===false?' (ไม่มีสิทธิ์)':' (พร้อมใช้)'}</option>`).join('');
  const preferred=available.find(port=>port.path===(previous||saved.port))?.path||available.find(port=>port.connected)?.path||item.port;
  select.value=preferred;lidarUpdatePortState();lidarUpdateLaunchPreview();
}
function lidarUpdatePortState(){
  const selected=lidarSelectedPort(),port=lidarKnownPorts.find(item=>item.path===selected),present=port?.connected===true,connected=present&&port.accessible!==false;
  const badge=document.getElementById('lidar-port-state'),help=document.getElementById('lidar-port-help');if(!badge)return;
  badge.className=`lidar-port-state ${connected?'connected':'disconnected'}`;badge.innerHTML=`<i></i> ${connected?'Connected':'Disconnected'}`;
  if(help)help.textContent=connected?`พบอุปกรณ์ที่ ${selected} พร้อมใช้เป็นพอร์ตของ Driver`:present?`พบ ${selected} แล้ว แต่ Agent ไม่มีสิทธิ์อ่าน/เขียน (group ${port.group||'dialout'}, mode ${port.mode||'ไม่ทราบ'})`:`ยังไม่พบอุปกรณ์ที่ ${selected} — ตรวจสาย USB และไฟเลี้ยง`;
}
function lidarPortChanged(){
  if(lidarPolling)stopLidarScan();lidarUpdatePortState();lidarSavePreference();lidarUpdateLaunchPreview();
  if(lidarPackageState?.installed)lidarSetInstallStatus('บันทึกพอร์ตแล้ว สามารถกดเชื่อมต่อได้ทันทีโดยไม่ต้อง Build ใหม่','success');
}
function lidarBaudChanged(){if(lidarPolling)stopLidarScan();lidarSavePreference();lidarUpdateLaunchPreview();if(lidarPackageState?.installed)lidarSetInstallStatus('บันทึก baudrate แล้ว สามารถกดเชื่อมต่อได้ทันที','success');}

async function lidarRefreshStatus(){
  if(!sessionId)return lidarSetInstallStatus('กรุณาเชื่อมต่อหุ่นยนต์จริงก่อน','error');
  if(lidarBusy)return;
  const sequence=++lidarStatusSequence,item=lidarModel(),button=document.getElementById('lidar-install-button'),connectButton=document.getElementById('lidar-scan-button'),dot=document.getElementById('lidar-package-dot'),label=document.getElementById('lidar-package-label');
  button.disabled=true;button.textContent='กำลังตรวจสอบ…';dot.className='lidar-package-dot checking';label.textContent='กำลังตรวจสอบ workspace และ COM port…';lidarSetInstallStatus('กำลังอ่านสถานะ package จากหุ่นยนต์จริง','busy');
  try{
    const result=await API('/api/lidar/status',{sessionId,modelId:item.id});if(sequence!==lidarStatusSequence)return;if(!result.ok)throw new Error(result.error||'ตรวจสอบ package ไม่สำเร็จ');
    const remembered=result.savedSelection||{};
    if(!lidarPreferenceLoadedFromStorage&&LIDAR_MODELS.some(model=>model.id===remembered.modelId)&&remembered.modelId!==lidarSelected){
      lidarPreferences.lastModel=remembered.modelId;lidarPreferences.models[remembered.modelId]={port:remembered.port||LIDAR_MODELS.find(model=>model.id===remembered.modelId).port,baud:remembered.baud||LIDAR_MODELS.find(model=>model.id===remembered.modelId).baud};lidarPreferenceLoadedFromStorage=true;localStorage.setItem(lidarPreferenceKey(),JSON.stringify(lidarPreferences));
      const brand=LIDAR_MODELS.find(model=>model.id===remembered.modelId).brand;document.querySelectorAll('.lidar-brand').forEach(tab=>tab.classList.toggle('active',tab.dataset.brand===brand));lidarRenderModels(brand);lidarSelectModel(remembered.modelId);return;
    }
    lidarPackageState=result;lidarRenderPorts(result.ports);
    connectButton.hidden=!result.installed;
    dot.className=`lidar-package-dot ${result.installed?'installed':'missing'}`;
    label.textContent=result.installed?`ติดตั้งแล้ว · ${result.driverDir}`:`ยังไม่มี ${item.name} ใน workspace/src`;
    lidarResetPipeline();if(result.installed)lidarPipeline('driver','done');if(result.built)lidarPipelineComplete();
    button.disabled=false;button.textContent=result.installed?'⚙ Build Package ใหม่':'⬇ ติดตั้งและ Build อัตโนมัติ';
    lidarSetInstallStatus(result.installed?'พบ LIDAR package แล้ว · เชื่อมต่อได้ทันที หรือเลือก Build ใหม่เมื่อต้องการ':'ยังไม่มี Driver · ติดตั้งก่อนจึงจะแสดงปุ่มเชื่อมต่อ',result.installed?'success':'');
  }catch(error){if(sequence!==lidarStatusSequence)return;dot.className='lidar-package-dot missing';label.textContent='ตรวจสอบ package ไม่สำเร็จ';connectButton.hidden=true;button.disabled=false;button.textContent='↻ ลองตรวจสอบอีกครั้ง';lidarSetInstallStatus(error.message,'error');}
}

function lidarPrimaryAction(){if(lidarPackageState?.installed)lidarRunBuild(false);else lidarRunBuild(true);}
function lidarInstallSelected(){lidarRunBuild(true);}
function lidarBuildSelected(){lidarRunBuild(false);}

async function lidarRunBuild(install=false,automatic=false){
  if(lidarBusy||!sessionId)return;lidarBusy=true;
  const item=lidarModel(),modelId=item.id,button=document.getElementById('lidar-install-button'),outputWrap=document.getElementById('lidar-build-output-wrap'),output=document.getElementById('lidar-build-output');
  button.disabled=true;button.textContent=install?'กำลังติดตั้งและ Build…':'กำลังเตรียมและ Build…';
  lidarPipeline(install?'driver':'tools');lidarSetInstallStatus(install?`กำลังดาวน์โหลด ${item.name} จาก GitHub จากนั้นจะ Build อัตโนมัติ`:`${automatic?'พบ Package เดิม — ':''}กำลังตรวจและติดตั้ง Build tools ก่อน Build`,'busy');
  try{
    const endpoint=install?'/api/lidar/install':'/api/lidar/build',result=await API(endpoint,{sessionId,modelId,port:lidarSelectedPort(),baud:lidarSelectedBaud()});
    if(!result.ok){const error=new Error(result.error||'Build ไม่สำเร็จ');error.stage=result.stage;error.requiresSudo=result.requiresSudo;throw error;}
    const build=install?result.build:result;lidarPackageState={...(lidarPackageState||{}),installed:true,built:true,driverDir:result.driverDir||lidarPackageState?.driverDir};lidarPipelineComplete();
    document.getElementById('lidar-scan-button').hidden=false;
    document.getElementById('lidar-package-dot').className='lidar-package-dot installed';document.getElementById('lidar-package-label').textContent=`ติดตั้งและ Build แล้ว · ${lidarPackageState.driverDir||build.packageName}`;
    lidarSetInstallStatus(`สำเร็จ · เตรียม Build tools, dependencies และ Build ${build.packageName} ครบแล้ว`,'success');
    if(outputWrap&&output){output.textContent=build.output||'Build completed successfully';outputWrap.classList.remove('hidden');}
    if(typeof refreshTree==='function')refreshTree();if(typeof loadDashboard==='function')setTimeout(()=>loadDashboard(true),400);
  }catch(error){
    const stage=['driver','tools','dependencies','build'].includes(error.stage)?error.stage:(install?'driver':'build');lidarPipeline(stage,'error');lidarSetInstallStatus(`${stage==='tools'?'ติดตั้ง Build tools':stage==='dependencies'?'ติดตั้ง ROS dependencies':stage==='driver'?'ดาวน์โหลด Driver':'Colcon build'} ไม่สำเร็จ: ${error.message}`,'error');
    if(outputWrap&&output){output.textContent=error.message;outputWrap.classList.remove('hidden');outputWrap.open=true;}
  }finally{
    lidarBusy=false;button.disabled=false;button.textContent=lidarPackageState?.installed?'⚙ Build Package ใหม่':'⬇ ติดตั้งและ Build อัตโนมัติ';
  }
}

function lidarOpenRepository(){window.open(lidarModel().repo,'_blank','noopener,noreferrer');}
async function lidarCopyCommand(id){
  const text=document.getElementById(id)?.textContent||'';if(!text)return;
  try{await navigator.clipboard.writeText(text);if(typeof sbMsg==='function')sbMsg('คัดลอกคำสั่งแล้ว',1800);}catch(_){if(typeof sbMsg==='function')sbMsg('คัดลอกไม่สำเร็จ',1800);}
}

function lidarToggleScan(){lidarPolling?stopLidarScan():startLidarScan();}
function lidarSetDiagnosticCheck(name,state,message){
  const item=document.querySelector(`.lidar-diagnostic-check[data-check="${name}"]`);if(!item)return;
  item.className=`lidar-diagnostic-check ${state}`;const small=item.querySelector('small');if(small)small.textContent=message;
}
function lidarRenderDriverDiagnostic(result={}){
  const portState=result.portState||'missing',running=result.processRunning===true,topic=result.topicReady===true;
  lidarSetDiagnosticCheck('port',portState==='connected'?'ok':'error',portState==='connected'?`${result.port||lidarSelectedPort()} พร้อมใช้งาน`:portState==='permission'?'พบพอร์ต แต่ไม่มีสิทธิ์อ่าน/เขียน':`ไม่พบ ${result.port||lidarSelectedPort()}`);
  lidarSetDiagnosticCheck('process',running?'ok':'error',running?'Driver กำลังทำงาน':'Driver ไม่ได้ทำงานหรือหยุดแล้ว');
  lidarSetDiagnosticCheck('topic',topic?'ok':'error',topic?'พบ publisher ของ /scan':'ยังไม่พบ publisher ของ /scan');
  const launch=document.getElementById('lidar-launch-command'),test=document.getElementById('lidar-test-command');if(launch&&result.commands?.launch)launch.textContent=result.commands.launch;if(test&&result.commands?.topic)test.textContent=result.commands.topic;
  const hints=Array.isArray(result.hints)?result.hints:[],hint=document.getElementById('lidar-diagnostic-hint');if(hint){hint.className=`lidar-diagnostic-hint ${running&&topic&&portState==='connected'?'ok':hints.length?'error':''}`;hint.textContent=hints.join(' · ')||(running&&topic?'Driver พร้อมแล้ว กำลังอ่านข้อมูล LaserScan…':'กดเชื่อมต่อและทดสอบเพื่อเปิด Driver');}
  lidarDiagnosticText=[`PORT: ${result.port||lidarSelectedPort()} (${portState})`,`PROCESS: ${running?'running':'stopped'}`,`TOPIC /scan: ${topic?'ready':'missing'}`,result.output||result.log||''].filter(Boolean).join('\n');
  const log=document.getElementById('lidar-runtime-log');if(log){log.textContent=lidarDiagnosticText;log.scrollTop=log.scrollHeight;}
}
async function lidarRefreshDriverStatus(){
  if(!sessionId||lidarDriverBusy)return;lidarDriverBusy=true;const hint=document.getElementById('lidar-diagnostic-hint');if(hint){hint.className='lidar-diagnostic-hint';hint.textContent='กำลังตรวจพอร์ต, process, topic และ driver log…';}
  try{const result=await API('/api/lidar/driver',{sessionId,action:'status',modelId:lidarSelected,port:lidarSelectedPort(),baud:lidarSelectedBaud()});if(!result.ok)throw new Error(result.error||'ตรวจ Driver ไม่สำเร็จ');lidarRenderDriverDiagnostic(result);}
  catch(error){if(hint){hint.className='lidar-diagnostic-hint error';hint.textContent=error.message;}const log=document.getElementById('lidar-runtime-log');if(log)log.textContent=error.message;}
  finally{lidarDriverBusy=false;}
}
async function lidarCopyDiagnostics(){
  const commands=[document.getElementById('lidar-launch-command')?.textContent,document.getElementById('lidar-test-command')?.textContent,lidarDiagnosticText].filter(Boolean).join('\n\n');
  try{await navigator.clipboard.writeText(commands);if(typeof sbMsg==='function')sbMsg('คัดลอก Driver log แล้ว',1800);}catch(_){if(typeof sbMsg==='function')sbMsg('คัดลอก log ไม่สำเร็จ',1800);}
}
async function startLidarScan(){
  if(!sessionId){lidarSetScanState(false,'กรุณาเชื่อมต่อหุ่นยนต์จริงก่อน');return;}
  if(!lidarPackageState?.installed){lidarSetScanState(false,'ยังไม่มี LIDAR package กรุณาติดตั้งก่อน');return;}
  if(lidarDriverBusy)return;lidarDriverBusy=true;const button=document.getElementById('lidar-scan-button');if(button){button.disabled=true;button.textContent='กำลังเชื่อมต่อ Driver…';}
  ['port','process','topic','data'].forEach(name=>lidarSetDiagnosticCheck(name,'checking','กำลังตรวจสอบ…'));lidarSetScanState(false,'กำลังเปิด LIDAR driver และตรวจการเชื่อมต่อ');
  try{
    const result=await API('/api/lidar/driver',{sessionId,action:'start',modelId:lidarSelected,port:lidarSelectedPort(),baud:lidarSelectedBaud()});if(!result.ok)throw Object.assign(new Error(result.error||'เปิด Driver ไม่สำเร็จ'),{result});
    lidarRenderDriverDiagnostic(result);lidarPolling=true;if(button){button.disabled=false;button.textContent='■ หยุดทดสอบ';}lidarOpenStream();
  }catch(error){lidarPolling=false;lidarSetScanState(false,error.message);if(error.result?.portState)lidarSetDiagnosticCheck('port','error',error.result.portState==='permission'?'ระบบใช้สิทธิ์จากการเชื่อมต่อแก้พอร์ตไม่สำเร็จ':'ไม่พบพอร์ต');if(error.result?.stage==='build')lidarSetDiagnosticCheck('process','error','LIDAR Driver ยัง Build ไม่สมบูรณ์');const hint=document.getElementById('lidar-diagnostic-hint');if(hint){hint.className='lidar-diagnostic-hint error';hint.textContent=error.result?.requiresSudo?'รหัสของ Robot ที่บันทึกไว้ใช้ sudo ไม่สำเร็จ กรุณาตรวจข้อมูล Robot Connection':error.result?.stage==='build'?'ระบบลองเตรียม Driver แล้วแต่ยังไม่สำเร็จ — ดู error จริงใน Command output':error.message;}lidarDiagnosticText=[error.message,error.result?.command?`$ ${error.result.command}`:'',error.result?.output||''].filter(Boolean).join('\n\n');const log=document.getElementById('lidar-runtime-log');if(log)log.textContent=lidarDiagnosticText;if(button){button.disabled=false;button.textContent='▶ เชื่อมต่อใหม่';}}
  finally{lidarDriverBusy=false;}
}
function stopLidarScan(){
  lidarPolling=false;if(lidarScanTimer)clearInterval(lidarScanTimer);lidarScanTimer=null;
  if(lidarSocket){const socket=lidarSocket;lidarSocket=null;try{socket.close();}catch(_){}}
  lidarLastReceived=0;
  const button=document.getElementById('lidar-scan-button');if(button)button.textContent='▶ เชื่อมต่อและทดสอบ';
  const rate=document.getElementById('lidar-stat-rate'),interval=document.getElementById('lidar-stat-interval');if(rate)rate.textContent='—';if(interval)interval.textContent='—';
  if(sessionId)API('/api/lidar/driver',{sessionId,action:'stop',modelId:lidarSelected,port:lidarSelectedPort(),baud:lidarSelectedBaud()}).then(result=>{if(result.ok)lidarRenderDriverDiagnostic(result);}).catch(()=>{});
}
function lidarApplyLiveScan(result){
  if(!result?.ranges?.length)return;
  lidarLastReceived=Date.now();lidarLastScan=result;lidarDrawScan(result);
  const minRange=Number(result.rangeMin)||0,maxRange=Number(result.rangeMax)||Infinity;
  const valid=result.ranges.filter(value=>Number.isFinite(value)&&value>=minRange&&value<=maxRange),closest=valid.length?Math.min(...valid):null,hz=result.hz==null?NaN:Number(result.hz),interval=result.interval==null?NaN:Number(result.interval);
  lidarSetScanState(true,`รับข้อมูล realtime ${valid.length.toLocaleString()} จุด · ${Number.isFinite(hz)?hz.toFixed(1)+' Hz':'กำลังวัด'}`);
  document.getElementById('lidar-stat-points').textContent=valid.length.toLocaleString();
  document.getElementById('lidar-stat-nearest').textContent=closest===null?'—':closest.toFixed(2)+' m';
  document.getElementById('lidar-stat-rate').textContent=Number.isFinite(hz)?hz.toFixed(1)+' Hz':'กำลังวัด';
  document.getElementById('lidar-stat-interval').textContent=Number.isFinite(interval)?interval.toFixed(3)+' s':'กำลังวัด';
  document.getElementById('lidar-stat-range').textContent=Number.isFinite(result.rangeMax)?result.rangeMax.toFixed(1)+' m':'—';
  lidarSetDiagnosticCheck('data','ok',`Realtime ${valid.length.toLocaleString()} จุด · ${Number.isFinite(hz)?hz.toFixed(1)+' Hz':'กำลังวัด'}`);
}
function lidarOpenStream(){
  if(!lidarPolling||!sessionId)return;
  if(lidarSocket){try{lidarSocket.close();}catch(_){}}
  const proto=location.protocol==='https:'?'wss:':'ws:',socket=new WebSocket(`${proto}//${location.host}/ws/lidar`,['ros2ide',getAuthToken()]);lidarSocket=socket;lidarLastReceived=Date.now();
  lidarSetScanState(false,'กำลัง subscribe /scan แบบ realtime…');
  socket.onopen=()=>socket.send(JSON.stringify({type:'start',sessionId}));
  socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch(_){return;}if(message.type==='scan')lidarApplyLiveScan(message.data);else if(message.type==='error'){lidarSetScanState(false,message.message||'เปิด realtime stream ไม่สำเร็จ');lidarSetDiagnosticCheck('data','error',message.message||'Realtime stream error');}};
  socket.onerror=()=>{if(lidarPolling)lidarSetScanState(false,'การเชื่อมต่อ realtime stream ขัดข้อง');};
  socket.onclose=()=>{if(lidarSocket===socket)lidarSocket=null;if(lidarPolling){lidarPolling=false;if(lidarScanTimer)clearInterval(lidarScanTimer);lidarScanTimer=null;lidarSetScanState(false,'Realtime stream หลุด กรุณากดเชื่อมต่อใหม่');const button=document.getElementById('lidar-scan-button');if(button)button.textContent='▶ เชื่อมต่อใหม่';}};
  if(lidarScanTimer)clearInterval(lidarScanTimer);
  lidarScanTimer=setInterval(()=>{if(!lidarPolling||!lidarLastReceived)return;if(Date.now()-lidarLastReceived>2500){lidarSetScanState(false,`ข้อมูล /scan หยุดมา ${Math.floor((Date.now()-lidarLastReceived)/1000)} วินาที`);lidarSetDiagnosticCheck('data','error','ไม่ได้รับข้อมูลเกิน 2.5 วินาที');const rate=document.getElementById('lidar-stat-rate');if(rate)rate.textContent='0.0 Hz';}},500);
}

function lidarSetScanState(live,message){
  const dot=document.getElementById('lidar-live-dot'),label=document.getElementById('lidar-live-label'),hint=document.getElementById('lidar-plot-message');
  if(dot)dot.classList.toggle('live',live);if(label)label.textContent=live?'LIVE /scan':'WAITING /scan';if(hint)hint.textContent=message;
}

function lidarDrawScan(scan){
  const canvas=document.getElementById('lidar-canvas');if(!canvas)return;
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2),width=Math.max(320,Math.floor(rect.width)),height=Math.max(300,Math.floor(rect.height));
  if(canvas.width!==width*dpr||canvas.height!==height*dpr){canvas.width=width*dpr;canvas.height=height*dpr;}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const css=getComputedStyle(document.documentElement),grid=css.getPropertyValue('--brd').trim()||'#28344a',muted=css.getPropertyValue('--dim').trim()||'#728099',accent=css.getPropertyValue('--acc').trim()||'#4f8ef7',green=css.getPropertyValue('--grn').trim()||'#3ecf8e';
  const cx=width/2,cy=height/2,maxRadius=Math.min(width,height)*.43,baseRange=Math.max(2,Math.min(30,Number(scan?.rangeMax)||12)),viewRange=baseRange/lidarZoom;
  ctx.strokeStyle=grid;ctx.lineWidth=3;ctx.fillStyle=muted;ctx.font='10px monospace';ctx.textAlign='center';
  for(let ring=1;ring<=4;ring++){const radius=maxRadius*ring/4;ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.stroke();ctx.fillText((viewRange*ring/4).toFixed(viewRange<4?2:1)+' m',cx+4,cy-radius+12);}
  ctx.beginPath();ctx.moveTo(cx-maxRadius,cy);ctx.lineTo(cx+maxRadius,cy);ctx.moveTo(cx,cy-maxRadius);ctx.lineTo(cx,cy+maxRadius);ctx.stroke();
  ctx.save();ctx.translate(cx,cy);ctx.fillStyle=accent;ctx.beginPath();ctx.moveTo(0,-12);ctx.lineTo(-8,8);ctx.lineTo(8,8);ctx.closePath();ctx.fill();ctx.restore();
  if(!scan?.ranges?.length)return;
  const start=Number.isFinite(scan.angleMin)?scan.angleMin:-Math.PI,increment=Number.isFinite(scan.angleIncrement)?scan.angleIncrement:(Math.PI*2/scan.ranges.length);
  ctx.fillStyle=green;ctx.shadowColor='transparent';ctx.shadowBlur=0;
  for(let index=0;index<scan.ranges.length;index++){
    const range=scan.ranges[index];if(!Number.isFinite(range)||range<=0||range>viewRange)continue;
    // ROS laser frame: +X is forward and +Y is left. Screen-up represents forward.
    const angle=start+index*increment,x=cx-Math.sin(angle)*range/viewRange*maxRadius,y=cy-Math.cos(angle)*range/viewRange*maxRadius;
    ctx.fillRect(Math.round(x)-1,Math.round(y)-1,3,3);
  }
  ctx.shadowBlur=0;
}
window.addEventListener('resize',()=>{if(document.getElementById('page-lidar')?.classList.contains('show'))lidarDrawScan(lidarLastScan);});
