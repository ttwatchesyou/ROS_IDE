'use strict';

const TOKEN=getAuthToken();
if(!TOKEN){location.replace('/');throw new Error('Not authenticated');}

let sessionId='';
let workspace='~/ros2_ws';
let robotDesign=null;
let activeCodeFile='main.cpp';
let platformioBusy=false;
let hardwareOpenAssignment='';
let tunedWheelPid=null;
let odomSwapXY=false;
let hardwarePinAssignments={};
const DRIVE_META={diff2:{label:'2WD Differential',motors:2,kinematics:'differential',icon:'🛞'},diff4:{label:'4WD Differential',motors:4,kinematics:'differential_4wd',icon:'🚙'},mecanum4:{label:'4WD Mecanum',motors:4,kinematics:'mecanum',icon:'✣'}};
function isMecanumXY(){return robotDesign?.hardwareTemplate==='mecanum_xy';}
function hardwareSupported(){return robotDesign?.drive==='diff2'||(isMecanumXY()&&robotDesign.drive==='mecanum4');}
const COLORS={power:'#ff718b',control:'#6c8cff',motor:'#ffb653',encoder:'#32d5f2',sensor:'#b879ff',data:'#3ed598'};
const CONTROLLERS={
  // USART1 is the real-robot bridge: PA9=TX and PA10=RX are reserved and must
  // never be allocated to motors, encoders, or accessories. PB0 replaces the
  // old M2 PWM assignment; the ultrasonic pair moves to the free PA11/PA12.
  stm32f103:{label:'STM32F103C8T6',sub:'BLUE PILL · UART1 PA9/PA10',motors:[['PB12','PB13','PA8','PA0','PA1'],['PB14','PB15','PB0','PA2','PA3'],['PB3','PB4','PA6','PA4','PA5'],['PB5','PB8','PA7','PB10','PB11']],aux:{scl:'PB6',sda:'PB7',trig:'PA11',echo:'PA12',servo:'PB9'}},
  portenta_h7:{label:'Arduino Portenta H7',sub:'CUSTOM SERIAL · PYTHON BRIDGE',motors:[['D2','D3','D5','D22','D23'],['D4','D7','D6','D24','D25'],['D8','D12','D9','D26','D27'],['D13','D14','D10','D28','D29']],aux:{scl:'SCL',sda:'SDA',trig:'D30',echo:'D31',servo:'D11'}},
  nanorp2040:{label:'Nano RP2040 Connect',sub:'CUSTOM SERIAL · PYTHON BRIDGE',motors:[['D2','D3','D5','A0','A1'],['D4','D7','D6','A2','A3'],['D8','D9','D10','D11','D12'],['D13','D14','D15','D16','D17']],aux:{scl:'SCL',sda:'SDA',trig:'D18',echo:'D19',servo:'D20'}},
  opencr:{label:'ROBOTIS OpenCR',sub:'USB SERIAL · PYTHON BRIDGE',motors:[['D2','D3','D4','D22','D23'],['D5','D6','D7','D24','D25'],['D8','D9','D10','D26','D27'],['D11','D12','D13','D28','D29']],aux:{scl:'SCL',sda:'SDA',trig:'D30',echo:'D31',servo:'D14'}},
  teensy41:{label:'Teensy 4.1',sub:'CUSTOM SERIAL · PYTHON BRIDGE',motors:[['2','3','4','5','6'],['7','8','9','10','11'],['12','14','15','16','17'],['18','19','20','21','22']],aux:{scl:'24',sda:'25',trig:'26',echo:'27',servo:'28'}},
  // The active 2WD template keeps GPIO0/2/5/12/15 free so attached hardware
  // cannot interfere with the ESP32 download boot mode. Encoder pins also use
  // GPIOs that support the internal pull-ups requested by the generated code.
  esp32:{label:'NodeMCU-32S (Auto BOOT)',sub:'ESP32 · ESPTOOL AUTO RESET',motors:[['16','17','25','32','33'],['18','19','26','27','14'],['4','5','13','34','35'],['2','15','12','36','39']],aux:{scl:'22',sda:'21',trig:'23',echo:'34',servo:'13'}},
  arduino_due:{label:'Arduino Due',sub:'CUSTOM SERIAL · COMMUNITY',motors:[['D22','D23','D2','D30','D31'],['D24','D25','D3','D32','D33'],['D26','D27','D4','D34','D35'],['D28','D29','D5','D36','D37']],aux:{scl:'SCL',sda:'SDA',trig:'D38',echo:'D39',servo:'D6'}},
  stm32_e407:{label:'Olimex STM32-E407',sub:'CUSTOM SERIAL · COMMUNITY',motors:[['PD0','PD1','PA0','PE0','PE1'],['PD2','PD3','PA1','PE2','PE3'],['PD4','PD5','PA2','PE4','PE5'],['PD6','PD7','PA3','PE6','PE7']],aux:{scl:'PB6',sda:'PB7',trig:'PC0',echo:'PC1',servo:'PA8'}},
  pico:{label:'Raspberry Pi Pico',sub:'CUSTOM SERIAL · COMMUNITY',motors:[['GP2','GP3','GP4','GP5','GP6'],['GP7','GP8','GP9','GP10','GP11'],['GP12','GP13','GP14','GP15','GP16'],['GP17','GP18','GP19','GP20','GP21']],aux:{scl:'GP27',sda:'GP26',trig:'GP0',echo:'GP1',servo:'GP22'}}
};
const PLATFORMIO_TARGETS={stm32f103:['ststm32','bluepill_f103c8','upload_protocol = serial'],portenta_h7:['ststm32','portenta_h7_m7',''],nanorp2040:['raspberrypi','nanorp2040connect',''],opencr:['ststm32','opencr',''],teensy41:['teensy','teensy41',''],esp32:['espressif32','nodemcu-32s',''],arduino_due:['atmelsam','due',''],stm32_e407:['ststm32','olimex_e407',''],pico:['raspberrypi','pico','']};
const MOTOR_ROLES={left:'ขับล้อซ้าย',right:'ขับล้อขวา',front_left:'ขับล้อหน้าซ้าย',front_right:'ขับล้อหน้าขวา',rear_left:'ขับล้อหลังซ้าย',rear_right:'ขับล้อหลังขวา',auxiliary:'มอเตอร์เสริม'};
const ENCODER_ROLES={odom_x:'PID + ODOM X / Yaw',odom_y:'PID + ODOM Y',odom_xy:'PID + ODOM X/Y',motor_feedback:'PID มอเตอร์เท่านั้น',unused:'ไม่นำไปคำนวณ'};
const MOTOR_ROLE_ORDER=['left','right','front_left','front_right','rear_left','rear_right','auxiliary'];

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function storageKey(){return `roside_hardware_config_${localStorage.getItem('ros2ide_robotid')||'default'}`;}
function returnToWorkspace(){location.assign('/app');}

async function api(path,body){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders(TOKEN)},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({ok:false,error:'Server response ไม่ถูกต้อง'}));
  if(response.status===401){clearAuthSession();location.replace('/');throw new Error('Session expired');}
  return data;
}

async function restoreRobotSession(){
  const saved=localStorage.getItem('ros2ide_session'),robotId=localStorage.getItem('ros2ide_robotid');
  if(!saved&&!robotId)throw new Error('ยังไม่ได้เลือกหุ่นยนต์ กรุณากลับไปหน้า Robots');
  const result=await api('/api/session/restore',{sessionId:saved,robotId});
  if(!result.ok)throw new Error(result.error||'กู้คืนการเชื่อมต่อหุ่นยนต์ไม่สำเร็จ');
  sessionId=result.sessionId;workspace=result.workspace||localStorage.getItem('ros2ide_workspace')||'~/ros2_ws';
  localStorage.setItem('ros2ide_session',sessionId);localStorage.setItem('ros2ide_workspace',workspace);
  if(result.robotId)localStorage.setItem('ros2ide_robotid',String(result.robotId));
  if(result.isSim)throw new Error('Hardware Wiring ใช้สำหรับหุ่นยนต์จริงเท่านั้น');
}

async function readWorkspaceJson(relativePath){
  const root=String(workspace).replace(/\/$/,'');
  const result=await api('/api/files/read',{sessionId,path:`${root}/${relativePath}`});
  if(!result.ok)throw new Error(result.error||`ไม่พบ ${relativePath}`);
  return JSON.parse(result.content);
}

function deriveRobotDesign(model,odom){
  const xy=model?.some(c=>c.type==='base'&&c.params?.hardwareTemplate==='mecanum_xy');
  const sourceWheels=(Array.isArray(odom?.wheels)?odom.wheels:[]).filter(w=>!xy||!model.find(c=>c.name===w.name)?.params?.passiveOdom);
  if(!Array.isArray(model)||!model.length)throw new Error('Robot Model ยังไม่มีชิ้นส่วน');
  if(!sourceWheels.length)throw new Error('ODOM config ยังไม่มีข้อมูลล้อ');
  const pattern=String(odom.pattern||''),defaultEncoderRole=pattern==='mecanum'||pattern.startsWith('omni')?'odom_xy':'odom_x';
  const modelEncoders=model.filter(component=>component.type==='encoder'),configuredEncoders=Array.isArray(odom?.encoders)?odom.encoders:[];
  // ชื่อ Encoder ต้องตาม frame_id ล่าสุดจาก Robot Model เสมอ ส่วนค่า PPR/role
  // เดิมจะจับคู่ด้วยชื่อก่อน และใช้ลำดับเดิมเป็น fallback เมื่อมีการเปลี่ยนชื่อ frame
  const sourceEncoders=modelEncoders.length?modelEncoders.map((component,index)=>{
    const configured=configuredEncoders.find(item=>item.name===component.name)||(!xy?configuredEncoders[index]:null)||{};
    const defaults=component.params||{};
    const linked=defaults.attachedWheel||sourceWheels.find(w=>component.name==='encoder_'+w.name)?.name;
    return{...configured,attached_wheel:defaults.passiveOdom?'':(configured.attached_wheel??configured.attachedWheel??linked),passiveOdom:!!defaults.passiveOdom,name:component.name||configured.name||`encoder_${index+1}`,parent:component.parent||configured.parent||'',x:component.pos?.x??configured.x??0,y:component.pos?.y??configured.y??0,z:component.pos?.z??configured.z??0,enabled:configured.enabled!==false,role:configured.role||defaults.encoderRole||defaultEncoderRole,ppr:configured.ppr||defaults.ppr||1024,channels:configured.channels||defaults.channels||4,invert:configured.invert||defaults.encoderInvert||1};
  }):configuredEncoders;
  const encoders=sourceEncoders.map((encoder,index)=>{const attachedWheel=encoder.passiveOdom?'':encoder.attached_wheel??encoder.attachedWheel??sourceWheels.find(wheel=>wheel.name===encoder.parent)?.name??model.find(component=>(component.type==='wheel'||component.type==='omni')&&!component.params?.passiveOdom&&component.parent===encoder.name)?.name??'';return{name:encoder.name||`encoder_${index+1}`,parent:encoder.parent||'',attachedWheel,enabled:xy&&attachedWheel?false:encoder.enabled!==false,role:pattern==='differential'&&attachedWheel?defaultEncoderRole:(encoder.role||defaultEncoderRole),ppr:Math.max(1,Number(encoder.ppr)||1024),channels:Math.max(1,Number(encoder.channels)||1),invert:Number(encoder.invert)===-1?-1:1,x:Number(encoder.x)||0,y:Number(encoder.y)||0,z:Number(encoder.z)||0};});
  const wheels=sourceWheels.map((wheel,index)=>{
    const defaultRole=sourceWheels.length===2?(Number(wheel.y)>=0?'left':'right'):sourceWheels.length===4?`${Number(wheel.x)>=0?'front':'rear'}_${Number(wheel.y)>=0?'left':'right'}`:'auxiliary';
    const encoder=encoders.find(item=>item.attachedWheel===wheel.name),integrated=wheel.encoder||{};return{...wheel,motorInvert:wheel.motorInvert===true||(xy&&wheel.motorInvert==null&&defaultRole.endsWith('_right')),motorEnabled:wheel.motor?.enabled!==false,motorRole:wheel.motor?.role||defaultRole,encoderEnabled:encoder?encoder.enabled:integrated.enabled===true,encoderRole:encoder?.role||(pattern==='differential'?defaultEncoderRole:(integrated.role||defaultEncoderRole)),ppr:encoder?.ppr||Math.max(1,Number(integrated.ppr??wheel.ppr)||600),channels:encoder?.channels||Math.max(1,Number(integrated.channels??wheel.channels)||1),invert:encoder?.invert||(Number(integrated.invert??wheel.invert)===-1?-1:1),encoderName:encoder?.name||'',sourceIndex:index};
  });
  const motorCount=wheels.filter(wheel=>wheel.motorEnabled).length;
  const drive=pattern==='differential'&&motorCount===2?'diff2':pattern==='skid'&&motorCount===4?'diff4':pattern==='mecanum'&&motorCount===4?'mecanum4':null;
  const radii=wheels.map(w=>Number(w.radius)).filter(value=>Number.isFinite(value)&&value>0);
  const diameter=Math.round(radii.reduce((sum,value)=>sum+value,0)/radii.length*2000);
  const track=Math.round(Math.max(...wheels.map(w=>Math.abs(Number(w.y)||0)))*2000);
  const wheelBase=Math.round(Math.max(...wheels.map(w=>Math.abs(Number(w.x)||0)))*2000);
  if(!diameter||!track)throw new Error('ขนาดล้อหรือ Wheel track ใน ODOM ไม่ถูกต้อง');
  const types=new Set(model.map(component=>component.type));
  const attachedWheels=new Set(encoders.map(encoder=>encoder.attachedWheel).filter(Boolean));
  const encoderCount=encoders.filter(encoder=>encoder.enabled).length+wheels.filter(wheel=>wheel.encoderEnabled&&!attachedWheels.has(wheel.name)).length;
  return{hardwareTemplate:model.find(c=>c.type==='base')?.params?.hardwareTemplate||'',drive,driveLabel:drive?DRIVE_META[drive].label:'กรุณาตรวจ Motor Assignment',pattern,motorCount,encoderCount,wheelDiameterMm:diameter,wheelTrackMm:track,wheelBaseMm:wheelBase,hasImu:types.has('imu'),hasLidar:types.has('lidar'),componentCount:model.length,wheels,encoders};
}

function syncDesignAssignments(){
  if(isMecanumXY())for(const wheel of robotDesign.wheels){
    const encoder=robotDesign.encoders.find(item=>item.attachedWheel===wheel.name);
    wheel.encoderEnabled=!!encoder?.enabled;
    if(encoder){wheel.encoderRole=encoder.role;wheel.ppr=encoder.ppr;wheel.channels=encoder.channels;wheel.invert=encoder.invert;}
  }
  robotDesign.motorCount=robotDesign.wheels.filter(wheel=>wheel.motorEnabled).length;
  const attachedWheels=new Set(robotDesign.encoders.map(encoder=>encoder.attachedWheel).filter(Boolean));
  robotDesign.encoderCount=robotDesign.encoders.filter(encoder=>encoder.enabled).length+robotDesign.wheels.filter(wheel=>wheel.encoderEnabled&&!attachedWheels.has(wheel.name)).length;
  robotDesign.drive=robotDesign.pattern==='differential'&&robotDesign.motorCount===2?'diff2':robotDesign.pattern==='skid'&&robotDesign.motorCount===4?'diff4':robotDesign.pattern==='mecanum'&&robotDesign.motorCount===4?'mecanum4':null;
  robotDesign.driveLabel=robotDesign.drive?DRIVE_META[robotDesign.drive].label:'รูปแบบยังไม่รองรับ Firmware';
  if(robotDesign.drive==='diff2'){
    for(const wheel of robotDesign.wheels)if(wheel.encoderEnabled)wheel.encoderRole='odom_x';
    for(const encoder of robotDesign.encoders)if(encoder.enabled&&encoder.attachedWheel)encoder.role='odom_x';
  }
}

async function restoreWorkspaceHardwareOptions(){
  const saved=await readWorkspaceJson('.roside/hardware.json').catch(()=>null);
  if(!saved||!Array.isArray(saved.assignments)||!CONTROLLERS[saved.controller])return;
  if(isMecanumXY()!==(saved.robotDesign?.hardwareTemplate==='mecanum_xy'))return;
  let cached=null;try{cached=JSON.parse(localStorage.getItem(storageKey())||'null');}catch(_){}
  if(cached&&(Date.parse(cached.updatedAt)||0)>=(Date.parse(saved.updatedAt)||0))return;
  localStorage.setItem(storageKey(),JSON.stringify(saved));
  localStorage.setItem(storageKey()+'_pins',JSON.stringify(saved.pinAssignments||{}));
  localStorage.setItem(storageKey()+'_odom_swap',saved.odomSwapXY?'1':'0');
}

function applySavedOptions(){
  let saved=null;try{saved=JSON.parse(localStorage.getItem(storageKey())||'null');}catch(_){ }
  if(isMecanumXY()&&saved?.robotDesign?.hardwareTemplate!=='mecanum_xy')saved=null;
  try{hardwarePinAssignments=JSON.parse(localStorage.getItem(storageKey()+'_pins')||'null')||saved?.pinAssignments||{};}catch(_){hardwarePinAssignments={};}
  const savedOdomSwap=localStorage.getItem(storageKey()+'_odom_swap');
  odomSwapXY=isMecanumXY()&&(savedOdomSwap===null?saved?.odomSwapXY===true:savedOdomSwap==='1');
  const legacySharedPid=Number(saved?.version||0)<12&&!saved?.pid?.left&&!saved?.pid?.right&&Math.abs(Number(saved?.pid?.kp)-.975)<.0001&&Math.abs(Number(saved?.pid?.ki)-5.005)<.0001&&Math.abs(Number(saved?.pid?.kd)||0)<.0001;
  tunedWheelPid=Array.isArray(saved?.pid?.motors)&&saved.pid.motors.length===4?{motors:saved.pid.motors.map(gains=>({...gains}))}:saved?.pid?.left&&saved?.pid?.right?{left:{...saved.pid.left},right:{...saved.pid.right}}:null;
  if(saved?.controller&&CONTROLLERS[saved.controller])$('controller-board').value=saved.controller;
  if(saved?.motorDriver&&['cycron','tb6612','l298n'].includes(saved.motorDriver))$('motor-driver').value=saved.motorDriver;
  if($('pid-control-enabled'))$('pid-control-enabled').checked=saved?.pidControl!==false;
  const restoredFields={
    'bridge-serial-port':saved?.serialPort,
    'bridge-baud-rate':saved?.baudRate,
    'command-timeout-ms':saved?.commandTimeoutMs,
    'motor-max-rpm':saved?.motorMaxRpm,
    'pid-kp':legacySharedPid?0.5:(saved?.pid?.kp??saved?.pid?.left?.kp),
    'pid-ki':legacySharedPid?0:(saved?.pid?.ki??saved?.pid?.left?.ki),
    'pid-kd':legacySharedPid?0:(saved?.pid?.kd??saved?.pid?.left?.kd)
  };
  for(const [id,value] of Object.entries(restoredFields))if(value!==undefined&&value!==null&&$(id))$(id).value=String(value);
  if(Array.isArray(saved?.assignments))for(const assignment of saved.assignments){const wheel=robotDesign.wheels.find(item=>item.name===assignment.name);if(wheel){const migrate2wdOdom=Number(saved.version||0)<8&&robotDesign.pattern==='differential'&&!wheel.encoderName&&assignment.encoderEnabled===true&&(!assignment.encoderRole||assignment.encoderRole==='motor_feedback'||assignment.encoderRole==='unused'),xyRightFix=isMecanumXY()&&Number(saved.version||0)<15&&(assignment.motorRole||wheel.motorRole).endsWith('_right'),restored={motorInvert:xyRightFix||assignment.motorInvert===true,motorEnabled:assignment.motorEnabled!==false,motorRole:assignment.motorRole||wheel.motorRole,hardwareChannel:Number.isInteger(assignment.hardwareChannel)&&assignment.hardwareChannel>=0&&assignment.hardwareChannel<4?assignment.hardwareChannel:undefined,encoderRole:migrate2wdOdom?'odom_x':(assignment.encoderRole||wheel.encoderRole),ppr:Math.max(1,Number(assignment.ppr)||wheel.ppr),channels:Math.max(1,Number(assignment.channels)||wheel.channels),invert:Number(assignment.invert)===-1?-1:1};if(Object.prototype.hasOwnProperty.call(assignment,'encoderEnabled'))restored.encoderEnabled=assignment.encoderEnabled===true;Object.assign(wheel,restored);}}
  if(Array.isArray(saved?.encoderAssignments))for(const assignment of saved.encoderAssignments){const encoder=robotDesign.encoders.find(item=>item.name===assignment.name);if(encoder){const attachedWheel=assignment.attachedWheel||'',migrate2wdOdom=Number(saved.version||0)<8&&robotDesign.pattern==='differential'&&attachedWheel&&(!assignment.role||assignment.role==='motor_feedback'||assignment.role==='unused');Object.assign(encoder,{attachedWheel,enabled:assignment.enabled!==false,role:migrate2wdOdom?'odom_x':(assignment.role||encoder.role),ppr:Math.max(1,Number(assignment.ppr)||encoder.ppr),channels:Math.max(1,Number(assignment.channels)||encoder.channels),invert:Number(assignment.invert)===-1?-1:1});}}
  if(isMecanumXY())for(const encoder of robotDesign.encoders)if(encoder.attachedWheel)encoder.enabled=false;
  syncDesignAssignments();
  const selected=new Set(Array.isArray(saved?.accessories)?saved.accessories:[]);
  const imuInputs=[...document.querySelectorAll('input[name="imu-model"]')];
  imuInputs.forEach(input=>{input.disabled=!robotDesign.hasImu||(input.value==='bno08x'&&!isMecanumXY());input.checked=!input.disabled&&selected.has(input.value);});
  if(robotDesign.hasImu&&!imuInputs.some(input=>input.checked)){const first=imuInputs.find(input=>!input.disabled);if(first)first.checked=true;}
  for(const input of document.querySelectorAll('.device-option input[type="checkbox"]:not([name="imu-model"])'))input.checked=selected.has(input.value);
  if(isMecanumXY()) {
    $('controller-board').value='stm32f103';$('motor-driver').value='cycron';
    $('controller-board').disabled=true;$('motor-driver').disabled=true;
    $('pid-control-enabled').checked=false;$('pid-control-enabled').disabled=true;
    for(const input of document.querySelectorAll('.device-option input')) {input.checked=input.value==='bno08x';input.disabled=true;}
    if(saved?.robotDesign?.hardwareTemplate!=='mecanum_xy') {
      $('motor-max-rpm').value='500';$('command-timeout-ms').value='1000';
    }
    for(const id of ['pid-kp','pid-ki','pid-kd'])$(id).disabled=true;
  }
  updateMecanumProfileUI();
  updatePidControlFields();
  if(isMecanumXY())for(const id of ['pid-kp','pid-ki','pid-kd'])$(id).disabled=true;
}

function updateMecanumProfileUI(){
  const xy=isMecanumXY();
  if($('xy-profile-note'))$('xy-profile-note').hidden=!xy;
  if($('pid-mode-title'))$('pid-mode-title').textContent=xy?'Position Control X/Y + BNO08x':'ใช้ PID Control คุมความเร็วล้อ';
  if($('pid-mode-help'))$('pid-mode-help').textContent=xy?'อ่าน RPM/พัลส์ของมอเตอร์ทั้ง 4 ตัวเพื่อตรวจสอบ · ใช้ PWM feed-forward ขับมอเตอร์ และ Encoder X/Y อิสระร่วมกับ BNO08x ทำ ODOM':'ปิดเพื่อสั่งความเร็วแบบตรง (Open-loop) โดย Encoder และ ODOM ยังทำงานตาม Config เดิม';
  for(const field of document.querySelectorAll('.pid-field'))field.hidden=xy;
  if($('sensor-combo'))$('sensor-combo').hidden=xy;
  const option=$('motor-driver')?.querySelector?.('option[value="cycron"]');
  if(option)option.textContent=xy?'PWM + DIR · 4 ช่อง ตามโค้ดตัวอย่าง':'Cycron Driver · PWML / PWMR';
}

function restoreMecanumAssignments(){
  if(!isMecanumXY()||platformioBusy)return;
  odomSwapXY=false;localStorage.setItem(storageKey()+'_odom_swap','0');
  // Explicit user action: reset assignments and polarity to the reference table.
  for(const wheel of robotDesign.wheels){
    const role=`${wheel.x>=0?'front':'rear'}_${wheel.y>=0?'left':'right'}`;
    Object.assign(wheel,{motorEnabled:true,motorRole:role,hardwareChannel:['front_left','front_right','rear_left','rear_right'].indexOf(role),motorInvert:role.endsWith('_right'),encoderEnabled:false,encoderRole:'motor_feedback',ppr:600,channels:1,invert:role==='front_left'?1:-1});
  }
  for(const encoder of robotDesign.encoders){
    const wheel=robotDesign.wheels.find(w=>encoder.name==='encoder_'+w.name)||robotDesign.wheels.find(w=>w.name===encoder.attachedWheel);
    if(wheel)Object.assign(encoder,{attachedWheel:wheel.name,enabled:false,role:'motor_feedback',ppr:600,channels:1,invert:wheel.invert});
    else if(/^encoder_odom_[xy]$/.test(encoder.name))Object.assign(encoder,{attachedWheel:'',enabled:true,role:encoder.name.endsWith('_x')?'odom_x':'odom_y',ppr:600,channels:1,invert:encoder.name.endsWith('_x')?-1:1});
  }
  syncDesignAssignments();renderAssignments();renderSummary();renderDiagram();
  $('generate-button').disabled=!hardwareSupported();if($('hardware-upload-open'))$('hardware-upload-open').disabled=!hardwareSupported();$('save-status').textContent='คืนค่า Motor/Encoder ตามตัวอย่างแล้ว · ตรวจผังสายก่อนสร้าง Firmware';
  if(!$('code-modal').hidden)refreshCodePreview();
}

function updatePidControlFields(){
  const enabled=$('pid-control-enabled')?.checked!==false;
  document.querySelectorAll('.pid-field').forEach(field=>{field.classList.toggle('disabled',!enabled);const input=field.querySelector('input');if(input)input.disabled=!enabled;});
  if($('bridge-config-summary'))$('bridge-config-summary').textContent=isMecanumXY()?'🔧 Serial + Position Control X/Y':enabled?'🔧 Python Bridge + PID Tune':'🔧 Python Bridge + Open-loop Speed';
}

function selectedAccessories(){return [...document.querySelectorAll('.device-option input:checked')].map(input=>input.value);}
function updateMultiCombos(){
  for(const combo of document.querySelectorAll('.multi-combo')){
    const selected=[...combo.querySelectorAll('input:checked')],text=combo.querySelector('.combo-text'),count=combo.querySelector('.combo-count'),fallback=combo.id==='imu-combo'?'เลือก IMU (เลือกได้หลายตัว)':'เลือก Sensor (เลือกได้หลายตัว)';
    const names=selected.map(input=>input.closest('.device-option')?.querySelector('strong')?.textContent?.trim()||input.value);
    text.textContent=names.length?names.join(', '):fallback;text.title=names.join(', ');count.hidden=!names.length;count.textContent=String(names.length);
  }
}

// Header order viewed from the component side, USB at the bottom (Blue Pill).
// Original board schematic: stm32-base.org/assets/pdf/boards/original-schematic-STM32F103C8T6-Blue_Pill.pdf
const HARDWARE_HEADERS={
  stm32f103:[['VBAT','PC13','PC14','PC15','PA0','PA1','PA2','PA3','PA4','PA5','PA6','PA7','PB0','PB1','PB10','PB11','NRST','3V3','GND','GND'],['PB12','PB13','PB14','PB15','PA8','PA9','PA10','PA11','PA12','PA15','PB3','PB4','PB5','PB6','PB7','PB8','PB9','5V','GND','3V3']]
};
function pinScope(){return `${$('controller-board').value}:${isMecanumXY()?'mecanum_xy':'standard'}`;}
function mappedPin(key,fallback){const value=hardwarePinAssignments[pinScope()]?.[key];return typeof value==='string'&&pinChoices().includes(value)?value:fallback;}
function pinChoices(){
  const board=$('controller-board').value,profile=CONTROLLERS[board]||CONTROLLERS.stm32f103;
  if(board==='stm32f103')return HARDWARE_HEADERS.stm32f103.flat().filter((pin,i,all)=>/^P[ABC]\d+$/.test(pin)&&!['PA9','PA10','PC14','PC15'].includes(pin)&&all.indexOf(pin)===i);
  if(board==='esp32')return ['4','13','14','16','17','18','19','21','22','23','25','26','27','32','33','34','35','36','39'];
  if(board==='pico')return Array.from({length:23},(_,i)=>'GP'+i).concat(['GP26','GP27','GP28']);
  return [...new Set([...profile.motors.flat(),...Object.values(profile.aux)])];
}
function allowedPin(pin,field){
  const board=$('controller-board').value;
  if(board==='stm32f103'&&field==='pwm')return ['PA0','PA1','PA2','PA3','PA6','PA7','PA8','PB0','PB1','PB6','PB7','PB8','PB9'].includes(pin);
  if(board==='esp32'&&!['echo','encA','encB'].includes(field)&&Number(pin)>=34)return false;
  if(board==='esp32'&&['encA','encB'].includes(field)&&Number(pin)>=34)return false; // generated INPUT_PULLUP
  return true;
}
function pinLocation(pin){
  const headers=HARDWARE_HEADERS[$('controller-board').value];
  if(headers)for(let side=0;side<headers.length;side++){const index=headers[side].indexOf(pin);if(index>=0)return `${side===0?'แถวซ้าย':'แถวขวา'} · ลำดับ ${index+1} จากด้านบน (USB ด้านล่าง)`;}
  return `ขาที่พิมพ์ชื่อ ${pin} บนบอร์ด`;
}
function pinControl(key,field,pin,locked=false){
  const options=locked?[pin]:pinChoices().filter(value=>allowedPin(value,field)||value===pin);
  const note=locked?(field==='pwm'?' · ผูกกับ Timer ของ Template':' · ใช้พินประจำบัสของ Template'):'';
  return `<select class="hardware-pin-select" aria-label="เลือกพิน ${esc(key)}" title="${esc(pinLocation(pin)+note)}" data-pin-key="${esc(key)}" ${locked?'disabled':''} onchange="changeHardwarePin(this.dataset.pinKey,this.value)">${options.map(value=>`<option value="${esc(value)}" ${value===pin?'selected':''}>${esc(value)}</option>`).join('')}</select>`;
}
function changeHardwarePin(key,pin){
  if(!pinChoices().includes(pin))return;
  hardwarePinAssignments[pinScope()]={...hardwarePinAssignments[pinScope()],[key]:pin};
  localStorage.setItem(storageKey()+'_pins',JSON.stringify(hardwarePinAssignments));
  renderAssignments();renderDiagram();
  if(!$('code-modal').hidden)refreshCodePreview();
}
function resetHardwarePins(){delete hardwarePinAssignments[pinScope()];localStorage.setItem(storageKey()+'_pins',JSON.stringify(hardwarePinAssignments));renderAssignments();renderDiagram();if(!$('code-modal').hidden)refreshCodePreview();}
function hardwarePinConnections(){
  const rows=[];
  for(const motor of motorPinData()){
    for(const field of ($('motor-driver').value==='cycron'?['in1','pwm']:['in1','in2','pwm']).concat(motor.encoderEnabled?['encA','encB']:[]))rows.push({key:`motor:${motor.wheelName}:${field}`,field,pin:motor[field],label:`${motor.name} · ${field.toUpperCase()}`,locked:isMecanumXY()&&field==='pwm'});
  }
  const aux=hardwareAuxPins(),selected=new Set(selectedAccessories());
  for(const [device,fields] of [['mpu6050',['scl','sda']],['bno055',['scl','sda']],['hcsr04',['trig','echo']],['servo',['servo']]])if(selected.has(device))for(const field of fields){if(rows.some(row=>row.key==='aux:'+field))continue;rows.push({key:'aux:'+field,field,pin:aux[field],label:device+' · '+field.toUpperCase(),locked:['scl','sda'].includes(field)});}
  if(isMecanumXY()){
    const pins=MecanumXY.odomPins(odomSwapXY);
    for(const axis of ['x','y'])for(const [index,field] of ['encA','encB'].entries())rows.push({key:`odom:${axis}:${field}`,field,pin:mappedPin(`odom:${axis}:${field}`,pins[axis][index]),label:`Encoder ${axis.toUpperCase()} · ${field}`});
    for(const [field,pin] of [['scl','PB10'],['sda','PB11'],['reset','PC13']])rows.push({key:'bno08x:'+field,field,pin,label:'BNO08x · '+field.toUpperCase(),locked:true});
  }
  return rows;
}
function hardwareAuxPins(){const profile=CONTROLLERS[$('controller-board').value]||CONTROLLERS.stm32f103;return Object.fromEntries(Object.entries(profile.aux).map(([key,pin])=>[key,['scl','sda'].includes(key)?pin:mappedPin('aux:'+key,pin)]));}
function pinConflictErrors(){
  const rows=hardwarePinConnections(),errors=[];
  for(const row of rows){if(!row.locked&&!allowedPin(row.pin,row.field))errors.push(`${row.label}: ${row.pin} ไม่รองรับหน้าที่นี้`);const other=rows.find(item=>item!==row&&item.pin===row.pin&&item.key!==row.key);if(other)errors.push(`${row.pin} ซ้ำ: ${row.label} / ${other.label}`);}
  if($('controller-board').value==='stm32f103'){
    const interrupts=rows.filter(row=>row.field==='encA');
    for(const row of interrupts)if(interrupts.some(other=>other!==row&&other.pin.slice(2)===row.pin.slice(2)))errors.push(`Encoder interrupt EXTI${row.pin.slice(2)} ซ้ำ`);
  }
  return [...new Set(errors)];
}
function motorPinData(){
  const profile=CONTROLLERS[$('controller-board')?.value]||CONTROLLERS.stm32f103;
  const wheels=robotDesign.wheels.filter(wheel=>wheel.motorEnabled).sort((a,b)=>MOTOR_ROLE_ORDER.indexOf(a.motorRole)-MOTOR_ROLE_ORDER.indexOf(b.motorRole));
  return wheels.map((wheel,index)=>{const channel=Number.isInteger(wheel.hardwareChannel)?wheel.hardwareChannel:(isMecanumXY()?['front_left','front_right','rear_left','rear_right'].indexOf(wheel.motorRole):index),pins=isMecanumXY()?(MecanumXY.pins[channel]||['—','—','—','—','—']):profile.motors[channel],encoder=robotDesign.encoders.find(item=>item.attachedWheel===wheel.name),encoderEnabled=isMecanumXY()?false:(encoder?!!encoder.enabled:!!wheel.encoderEnabled);return{...wheel,hardwareChannel:channel,wheelName:wheel.name,name:`M${channel+1} · ${MOTOR_ROLES[wheel.motorRole]||wheel.name}`,encoderEnabled,encoderRole:robotDesign.drive==='diff2'&&encoderEnabled?'odom_x':(encoder?.role||wheel.encoderRole||'unused'),encoderName:encoder?.name||'',ppr:encoder?.ppr||wheel.ppr||600,channels:encoder?.channels||wheel.channels||1,invert:encoder?.invert||wheel.invert||1,...Object.fromEntries(['in1','in2','pwm','encA','encB'].map((field,i)=>[field,isMecanumXY()&&field==='pwm'?pins[i]:mappedPin(`motor:${wheel.name}:${field}`,pins[i])]))};});
}

// Firmware attaches one interrupt to encoder A on RISING. This is x1 decoding:
// one counted tick per A pulse; encoder B is sampled only to determine direction.
function encoderDecodeMultiplier(){return 1;}
function encoderTicksPerRevolution(motor){return Math.max(1,Number(motor.ppr)||600)*encoderDecodeMultiplier();}

function renderAssignments(){
  const target=$('hardware-assignments');if(!target||!robotDesign)return;
  queueMicrotask(hardwareApplyAssignmentAccordions);
  if(isMecanumXY()){renderMecanumAssignments(target);return;}
  const motors=robotDesign.wheels.map((wheel,index)=>{const modelEncoder=robotDesign.encoders.find(encoder=>encoder.attachedWheel===wheel.name);const encoderControls=modelEncoder?`<div class="assignment-note">ใช้ Encoder จาก Model: <b>${esc(modelEncoder.name)}</b> · ตั้งค่า PPR และทิศทางในรายการ Encoder ด้านล่าง</div>`:`<label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${wheel.encoderEnabled?'checked':''} onchange="updateAssignment(${index},'encoderEnabled',this.checked)"> มี Encoder ติดท้ายมอเตอร์</span></label>${wheel.encoderEnabled?`<div class="assignment-grid"><label class="assignment-field">PPR ต่อรอบ<input class="insp-input" type="number" min="1" step="1" value="${wheel.ppr}" onchange="updateAssignment(${index},'ppr',this.value)"></label><label class="assignment-field">Channels<select onchange="updateAssignment(${index},'channels',this.value)"><option value="1" ${wheel.channels===1?'selected':''}>1</option><option value="2" ${wheel.channels===2?'selected':''}>2</option><option value="4" ${wheel.channels===4?'selected':''}>4 · Quadrature</option></select></label><label class="assignment-field">หน้าที่ Encoder<select onchange="updateAssignment(${index},'encoderRole',this.value)">${Object.entries(ENCODER_ROLES).map(([value,label])=>`<option value="${value}" ${wheel.encoderRole===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${wheel.invert===-1?'checked':''} onchange="updateAssignment(${index},'invert',this.checked)"> กลับทิศ Encoder (Invert)</span></label></div>${robotDesign.drive==='diff2'?'<div class="assignment-note">2WD: Encoder นี้ใช้คำนวณตำแหน่ง X และมุม Yaw ของ ODOM</div>':''}`:''}`;return`<article class="assignment-row"><div class="assignment-head"><strong>🛞 ${esc(wheel.name)}</strong><small>x ${esc(wheel.x)} · y ${esc(wheel.y)}</small></div><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${wheel.motorEnabled?'checked':''} onchange="updateAssignment(${index},'motorEnabled',this.checked)"> ใช้มอเตอร์</span><select ${wheel.motorEnabled?'':'disabled'} onchange="updateAssignment(${index},'motorRole',this.value)">${Object.entries(MOTOR_ROLES).map(([value,label])=>`<option value="${value}" ${wheel.motorRole===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${wheel.motorInvert?'checked':''} onchange="updateAssignment(${index},'motorInvert',this.checked)"> กลับทิศมอเตอร์ (Motor Invert)</span></label><div class="assignment-note">หลังเปลี่ยนทิศมอเตอร์ ตรวจ Encoder แยกกัน: หมุนล้อไปทางเดินหน้าต้องอ่าน RPM เป็นบวก</div>${encoderControls}</article>`;}).join('');
  const encoders=robotDesign.encoders.map((encoder,index)=>`<article class="assignment-row"><div class="assignment-head"><strong>🟠 ${esc(encoder.name)}</strong><small>frame_id</small><span class="assignment-switch"><input type="checkbox" ${encoder.enabled?'checked':''} onchange="updateEncoderAssignment(${index},'enabled',this.checked)"> ใช้ Encoder</span></div><div class="assignment-grid"><label class="assignment-field">ติดกับ Motor / ล้อ<select onchange="updateEncoderAssignment(${index},'attachedWheel',this.value)"><option value="">${esc(encoder.name)}</option>${robotDesign.wheels.map(wheel=>`<option value="${esc(wheel.name)}" ${encoder.attachedWheel===wheel.name?'selected':''}>${esc(wheel.name)} · ${esc(MOTOR_ROLES[wheel.motorRole]||wheel.motorRole)}</option>`).join('')}</select></label><label class="assignment-field">หน้าที่ Encoder<select onchange="updateEncoderAssignment(${index},'role',this.value)">${Object.entries(ENCODER_ROLES).map(([value,label])=>`<option value="${value}" ${encoder.role===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="assignment-field">PPR<input class="insp-input" type="number" min="1" value="${encoder.ppr}" onchange="updateEncoderAssignment(${index},'ppr',this.value)"></label><label class="assignment-field">Channels<select onchange="updateEncoderAssignment(${index},'channels',this.value)"><option value="1" ${encoder.channels===1?'selected':''}>1</option><option value="2" ${encoder.channels===2?'selected':''}>2</option><option value="4" ${encoder.channels===4?'selected':''}>4 · Quadrature</option></select></label><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${encoder.invert===-1?'checked':''} onchange="updateEncoderAssignment(${index},'invert',this.checked)"> กลับทิศ Encoder (Invert)</span></label></div></article>`).join('');
  target.innerHTML=`<div class="device-group-label">⚙️ MOTOR · ${robotDesign.wheels.length} ตัว</div>${motors}<div class="device-group-label">🟠 ENCODER จาก MODEL · ${robotDesign.encoders.length} ตัว</div>${encoders||'<div class="assignment-warning">ไม่พบ Encoder แยกใน Robot Model — ถ้ามี Encoder ติดท้ายมอเตอร์ ให้ติ๊กและกำหนด PPR ที่การ์ดมอเตอร์แต่ละตัวด้านบน</div>'}`+(!robotDesign.drive?`<div class="assignment-warning">⚠️ ${esc(robotDesign.pattern)} ต้องใช้จำนวนมอเตอร์ตาม Template เดิมก่อนจึงจะสร้าง Firmware ได้</div>`:'');
  if(isMecanumXY())target.insertAdjacentHTML('afterbegin','<button type="button" class="assignment-reset" onclick="restoreMecanumAssignments()">คืนค่า Motor/Encoder และทิศทางสำหรับ Mecanum XY</button><div class="assignment-note">Mecanum XY · FR/RR กลับทิศมอเตอร์ตามล้อขวาของหุ่นจริง · Encoder ปรับแยกจากทิศมอเตอร์ · ยกล้อลอยตรวจ RPM บวกเมื่อสั่งเดินหน้า · FL interrupt ที่ B (PA1)</div>');
  if(robotDesign.drive==='diff2')target.insertAdjacentHTML('afterbegin','<div class="assignment-note">2WD ใช้ Encoder ซ้าย/ขวาทำ PID และ ODOM X/Yaw อัตโนมัติ · Firmware นับแบบ ×1 ที่ขา A ขอบ RISING ดังนั้น Ticks/รอบ = PPR (ขา B ใช้ดูทิศทาง)</div><button type="button" class="btn" onclick="reverseBothMotors()">⇄ กลับทิศมอเตอร์ทั้งซ้ายและขวา</button><div class="assignment-note">สลับ Motor Invert จากค่าปัจจุบันทั้งสองล้อ · ไม่เปลี่ยน Encoder · ต้องสร้างและอัปโหลด Firmware ใหม่จึงมีผล</div>');
}

function renderMecanumAssignments(target){
  const roles=['front_left','front_right','rear_left','rear_right'];
  const odomPins=MecanumXY.odomPins(odomSwapXY);
  const encoderFields=(encoder,index,passive=false)=>!passive?'<div class="assignment-note">อ่าน Encoder เพื่อตรวจสอบได้ที่หน้าควบคุมมอเตอร์แยกตัว · ใช้ PWM feed-forward</div>':encoder?`<label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${encoder.enabled?'checked':''} onchange="updateEncoderAssignment(${index},'enabled',this.checked)"> ใช้ Encoder ${esc(encoder.name)}</span></label><div class="assignment-grid"><label class="assignment-field">PPR · นับ ×1<input type="number" min="1" value="${encoder.ppr}" onchange="updateEncoderAssignment(${index},'ppr',this.value)"></label><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${encoder.invert===-1?'checked':''} onchange="updateEncoderAssignment(${index},'invert',this.checked)"> กลับทิศ Encoder</span></label></div>`:passive?'<div class="assignment-warning">ต้องมี Encoder ตำแหน่ง X/Y อิสระเพื่อใช้ Position Control</div>':'<div class="assignment-note">ไม่มี Encoder ความเร็วที่ผูกกับล้อนี้ — สร้าง Firmware แบบ feed-forward อัตโนมัติ</div>';
  const motors=robotDesign.wheels.map((wheel,index)=>{
    const channel=roles.indexOf(wheel.motorRole),mapped=motorPinData().find(motor=>motor.wheelName===wheel.name),pins=mapped?[mapped.in1,mapped.in2,mapped.pwm,mapped.encA,mapped.encB]:MecanumXY.pins[channel];
    const encoder=robotDesign.encoders.find(e=>e.attachedWheel===wheel.name);
    return `<article class="assignment-row"><div class="assignment-head"><strong>${['FL · หน้าซ้าย','FR · หน้าขวา','RL · หลังซ้าย','RR · หลังขวา'][channel]||esc(wheel.motorRole)}</strong><small>${esc(wheel.name)}</small></div><div class="assignment-note">${pins?`PWM ${pins[2]} · DIR ${pins[0]} · ไม่มี feedback ความเร็วล้อ · ใช้ PWM feed-forward`: 'หน้าที่ล้อไม่ถูกต้อง — กดคืนค่าตามตัวอย่าง'}</div><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${wheel.motorEnabled?'checked':''} onchange="updateAssignment(${index},'motorEnabled',this.checked)"> ใช้มอเตอร์</span></label><label class="assignment-field"><span class="assignment-switch"><input type="checkbox" ${wheel.motorInvert?'checked':''} onchange="updateAssignment(${index},'motorInvert',this.checked)"> กลับทิศมอเตอร์</span></label>${encoderFields(encoder,robotDesign.encoders.indexOf(encoder))}</article>`;
  }).join('');
  const passive=['x','y'].map(axis=>{
    const encoder=robotDesign.encoders.find(e=>!e.attachedWheel&&e.role==='odom_'+axis);
    return `<article class="assignment-row"><div class="assignment-head"><strong>Encoder วัดระยะ ${axis.toUpperCase()} · อิสระ</strong></div><div class="assignment-note">A ${mappedPin(`odom:${axis}:encA`,odomPins[axis][0])} / B ${mappedPin(`odom:${axis}:encB`,odomPins[axis][1])} · ${axis==='x'?'หน้า–หลัง':'ซ้าย–ขวา'} · ล้อ R=29 mm<br>ใช้วัดตำแหน่ง ไม่ผูกกับมอเตอร์</div>${encoderFields(encoder,robotDesign.encoders.indexOf(encoder),true)}</article>`;
  }).join('');
  target.innerHTML='<button type="button" class="assignment-reset" onclick="restoreMecanumAssignments()">คืนค่า Motor/Encoder และทิศทางสำหรับ Mecanum XY</button><div class="assignment-note">อ่าน RPM/พัลส์มอเตอร์ทั้ง 4 ตัวเพื่อตรวจสอบ · Position Control และ ODOM ใช้ Encoder X/Y อิสระกับมุมจาก BNO08x ที่สดใหม่</div><div class="device-group-label">มอเตอร์ 4 ตัว · Encoder สำหรับตรวจสอบ</div>'+motors+'<div class="device-group-label">Encoder ตำแหน่ง X/Y · 2 ตัว (จำเป็น)</div><label class="assignment-field">การจับคู่ Encoder X/Y กับขา STM32<select onchange="setMecanumOdomSwap(this.value)"><option value="normal" '+(!odomSwapXY?'selected':'')+'>ปกติ · X = PB0/PB1, Y = PB9/PB5</option><option value="swapped" '+(odomSwapXY?'selected':'')+'>สลับ X ↔ Y · X = PB9/PB5, Y = PB0/PB1</option></select></label><div class="assignment-note">สลับเฉพาะคู่ขาสัญญาณ X/Y ใน Firmware · ค่า Invert และ PPR ของแต่ละแกนปรับด้านล่าง</div>'+passive;
}

function setMecanumOdomSwap(value){
  if(!isMecanumXY()||platformioBusy)return;
  odomSwapXY=value==='swapped';localStorage.setItem(storageKey()+'_odom_swap',odomSwapXY?'1':'0');
  renderAssignments();renderDiagram();
  if(!$('code-modal').hidden)refreshCodePreview();
}

function reverseBothMotors(){
  if(platformioBusy||robotDesign?.drive!=='diff2')return;
  const wheels=robotDesign.wheels.filter(wheel=>wheel.motorEnabled);
  if(wheels.length!==2||!wheels.some(wheel=>wheel.motorRole==='left')||!wheels.some(wheel=>wheel.motorRole==='right'))return;
  if(!confirm('กลับทิศมอเตอร์ซ้ายและขวาจากค่าปัจจุบันหรือไม่?\nยังไม่ส่งคำสั่งหรืออัปโหลดลงหุ่น ต้องสร้างและอัปโหลด Firmware ใหม่\nตัดไฟมอเตอร์และตรวจทิศ Encoder ด้วยมือก่อนทดสอบ PID'))return;
  for(const wheel of wheels)wheel.motorInvert=!wheel.motorInvert;
  syncDesignAssignments();renderAssignments();renderSummary();renderDiagram();
  if(!$('code-modal').hidden)refreshCodePreview();
}

function hardwareApplyAssignmentAccordions(){
  const target=$('hardware-assignments');if(!target)return;
  [...target.querySelectorAll('article.assignment-row')].forEach((article,index)=>{
    const head=article.querySelector('.assignment-head'),strong=head?.querySelector('strong'),small=head?.querySelector('small');
    const title=strong?.textContent?.trim()||`อุปกรณ์ ${index+1}`,meta=small?.textContent?.trim()||'',key=`${index}:${title}`;
    const details=document.createElement('details');details.className='assignment-row assignment-accordion';details.dataset.assignmentKey=key;details.open=hardwareOpenAssignment===key;
    const summary=document.createElement('summary');summary.className='assignment-summary';summary.innerHTML=`<span class="assignment-summary-main"><strong>${esc(title)}</strong>${meta?`<small>${esc(meta)}</small>`:''}</span><span class="assignment-summary-action">ตั้งค่า</span>`;
    strong?.remove();small?.remove();if(head&&!head.textContent.trim()&&!head.querySelector('input,select'))head.remove();
    const body=document.createElement('div');body.className='assignment-body';while(article.firstChild)body.appendChild(article.firstChild);
    details.append(summary,body);details.addEventListener('toggle',()=>{if(details.open){hardwareOpenAssignment=key;target.querySelectorAll('.assignment-accordion[open]').forEach(other=>{if(other!==details)other.open=false;});}else if(hardwareOpenAssignment===key)hardwareOpenAssignment='';});article.replaceWith(details);
  });
}

function updateAssignment(index,key,value){
  const wheel=robotDesign?.wheels?.[index];if(!wheel)return;if(key==='motorEnabled'||key==='encoderEnabled'||key==='motorInvert'){wheel[key]=!!value;if(key==='encoderEnabled'&&value&&robotDesign.pattern==='differential')wheel.encoderRole='odom_x';}else if(key==='invert')wheel.invert=value?-1:1;else if(key==='ppr'||key==='channels')wheel[key]=Math.max(1,Number(value)||1);else wheel[key]=value;syncDesignAssignments();renderAssignments();renderSummary();renderDiagram();$('generate-button').disabled=!hardwareSupported();if(!$('code-modal').hidden)refreshCodePreview();
}
function updateEncoderAssignment(index,key,value){
  const encoder=robotDesign?.encoders?.[index];if(!encoder)return;if(key==='enabled')encoder.enabled=!!value;else if(key==='invert')encoder.invert=value?-1:1;else if(key==='ppr'||key==='channels')encoder[key]=Math.max(1,Number(value)||1);else encoder[key]=value;if(robotDesign.pattern==='differential'&&encoder.enabled&&encoder.attachedWheel&&(key==='enabled'||key==='attachedWheel'))encoder.role='odom_x';if(key==='attachedWheel'&&encoder.attachedWheel)for(const other of robotDesign.encoders){if(other!==encoder&&other.attachedWheel===encoder.attachedWheel)other.attachedWheel='';}syncDesignAssignments();renderAssignments();renderSummary();renderDiagram();if(!$('code-modal').hidden)refreshCodePreview();
}

function hardwareDeviceArt(kind,variant,label){return typeof HardwareVisuals==='undefined'?'':HardwareVisuals.render(kind,variant,label);}
function hardwareDisplayMotors(){return motorPinData().sort((a,b)=>a.hardwareChannel-b.hardwareChannel);}
function hardwareWheelRoles(){return robotDesign?.wheels?.filter(wheel=>wheel.motorEnabled).length===2&&robotDesign.pattern==='differential'?['left','right']:['front_left','front_right','rear_left','rear_right'];}
function assignHardwareMotorRole(wheelName,role){
  if(platformioBusy||!hardwareWheelRoles().includes(role))return;
  const wheel=robotDesign.wheels.find(item=>item.name===wheelName&&item.motorEnabled);if(!wheel||wheel.motorRole===role)return;
  // Preserve each channel's pins, then exchange roles to keep the assignment unique.
  for(const motor of motorPinData())robotDesign.wheels.find(item=>item.name===motor.wheelName).hardwareChannel=motor.hardwareChannel;
  const other=robotDesign.wheels.find(item=>item!==wheel&&item.motorEnabled&&item.motorRole===role);
  if(other)other.motorRole=wheel.motorRole;
  wheel.motorRole=role;
  syncDesignAssignments();renderAssignments();renderSummary();renderDiagram();
  $('generate-button').disabled=!hardwareSupported();
  if(!$('code-modal').hidden)refreshCodePreview();
}
function hardwareWheelRoleControl(id){
  if(!id.startsWith('driver-'))return '';
  const motor=hardwareDisplayMotors()[Number(id.slice(7))];if(!motor)return '';
  return `<label class="hardware-wheel-role"><small>ตำแหน่งล้อ</small><select aria-label="ตำแหน่งล้อ M${motor.hardwareChannel+1}" data-wheel-name="${esc(motor.wheelName)}" onchange="assignHardwareMotorRole(this.dataset.wheelName,this.value)">${hardwareWheelRoles().map(role=>`<option value="${role}" ${role===motor.motorRole?'selected':''}>${esc(MOTOR_ROLES[role])}</option>`).join('')}</select></label>`;
}
function pinoutCellControl(id,label,pin){
  let key='',field='',locked=false;
  const motors=hardwareDisplayMotors();
  if(id.startsWith('driver-')){
    const motor=motors[Number(id.slice(7))];
    field=label.startsWith('PWM')?'pwm':label==='IN2'?'in2':'in1';
    if(motor)key=`motor:${motor.wheelName}:${field}`;
    locked=isMecanumXY()&&field==='pwm';
  }else if(id.startsWith('motor-encoder-')&&label.startsWith('ENC ')){
    const motor=motors.filter(item=>item.encoderEnabled)[Number(id.slice(14))];
    field=label==='ENC A'?'encA':'encB';
    if(motor)key=`motor:${motor.wheelName}:${field}`;
  }else if(id.startsWith('passive-')&&label.startsWith('ENC ')){
    field=label==='ENC A'?'encA':'encB';key=`odom:${id.slice(8)}:${field}`;
  }else if(['mpu6050','bno055'].includes(id)&&['SCL','SDA'].includes(label)){
    field=label.toLowerCase();key='aux:'+field;locked=true;
  }else if(id==='bno08x'&&['SCL','SDA','RESET'].includes(label)){
    field=label.toLowerCase();key='bno08x:'+field;locked=true;
  }else if(id==='hcsr04'&&['TRIG','ECHO'].includes(label)){
    field=label.toLowerCase();key='aux:'+field;
  }else if(id==='servo'&&label==='PWM'){
    field='servo';key='aux:servo';
  }
  return key?pinControl(key,field,pin,locked):`<b>${esc(pin)}</b>`;
}
function pinoutCard(id,side,icon,name,sub,pins,color){
  const kind=id.startsWith('driver-')?'driver':id.includes('encoder-')?'encoder':id,variant=kind==='driver'?$('motor-driver').value:kind;
  return `<article class="pinout-card ${side}" id="pinout-${esc(id)}" data-side="${side}" style="--wire:${color}"><div class="pinout-card-head"><span aria-hidden="true">${icon}</span><div><strong>${esc(name)}</strong><small>${esc(sub)}</small></div></div>${hardwareWheelRoleControl(id)}<div class="hw-device-scene">${hardwareDeviceArt(kind,variant,name)}</div><div class="pinout-pins">${pins.map(([label,pin])=>`<div class="pinout-pin"><small>${esc(label)}</small>${pinoutCellControl(id,label,pin)}</div>`).join('')}</div></article>`;
}

function renderSummary(){
  const meta=DRIVE_META[robotDesign.drive]||{icon:'⚠️',label:robotDesign.driveLabel};
  $('design-summary').innerHTML=`<div class="summary-row"><span>ฐานล้อ</span><b>${meta.icon} ${esc(meta.label)}</b></div><div class="summary-row"><span>มอเตอร์ใช้งาน</span><b>${robotDesign.motorCount} ตัว</b></div><div class="summary-row"><span>Encoder ใช้งาน</span><b>${robotDesign.encoderCount} ตัว</b></div><div class="summary-row"><span>Wheel diameter</span><b>${robotDesign.wheelDiameterMm} mm</b></div><div class="summary-row"><span>Wheel track</span><b>${robotDesign.wheelTrackMm} mm</b></div>${robotDesign.motorCount===4?`<div class="summary-row"><span>Wheel base</span><b>${robotDesign.wheelBaseMm} mm</b></div>`:''}<div class="summary-row"><span>Sensor ในแบบ</span><b>${[robotDesign.hasImu?'IMU':'',robotDesign.hasLidar?'LiDAR':''].filter(Boolean).join(' + ')||'ไม่มี'}</b></div>`;
  $('source-badge').textContent='✓ อ่านจาก TF Model + ODOM แล้ว';
}

function renderDiagram(){
  if(!robotDesign)return;
  const controller={...(CONTROLLERS[$('controller-board').value]||CONTROLLERS.stm32f103),aux:hardwareAuxPins()},driver=$('motor-driver').value,driverLabel=driver==='cycron'?'Cycron Driver':driver==='tb6612'?'TB6612FNG':'L298N',motors=hardwareDisplayMotors(),accessories=new Set(selectedAccessories());
  const left=motors.map((motor,index)=>{const channel=index%2===0?'L':'R',pins=driver==='cycron'?[[`DIR${channel}`,motor.in1],[`PWM${channel}`,motor.pwm]]:[['IN1',motor.in1],['IN2',motor.in2],['PWM',motor.pwm]];return pinoutCard(`driver-${index}`,'left','⚙️',`${driverLabel} · M${index+1}`,driver==='cycron'?`Channel ${channel} · Driver #${Math.floor(index/2)+1}`:motor.name,pins,COLORS.control);});
  const right=motors.filter(motor=>motor.encoderEnabled).map((motor,index)=>pinoutCard(`motor-encoder-${index}`,'right','◌',`Encoder · ${motor.encoderName||motor.wheelName}`,`${motor.name} · ${motor.ppr} PPR ×${isMecanumXY()?1:motor.channels}${isMecanumXY()&&motor.motorRole==='front_left'?' · ISR B (PA1)':''}${motor.invert===-1?' · INVERT':''}`,[['ENC A',motor.encA],['ENC B',motor.encB],['VCC','ตามสเปก'],['GND','GND ร่วม']],COLORS.encoder));
  const unresolvedEncoders=robotDesign.encoders.filter(encoder=>encoder.enabled&&!(isMecanumXY()&&!encoder.attachedWheel)&&!motors.some(motor=>motor.encoderName===encoder.name));
  unresolvedEncoders.forEach((encoder,index)=>right.push(pinoutCard(`unassigned-encoder-${index}`,'right','◌',`Encoder · ${encoder.name}`,encoder.attachedWheel?`${encoder.attachedWheel} · เปิด Motor ก่อน`:'ยังไม่ได้ผูกกับ Motor / ล้อ',[['ENC A','กำหนดล้อ'],['ENC B','ก่อน'],['VCC','ตามสเปก'],['GND','GND ร่วม']],COLORS.encoder)));
  if(isMecanumXY()) {
    const odomPins=MecanumXY.odomPins(odomSwapXY);
    for(const axis of ['x','y']){const [a,b]=['encA','encB'].map((field,i)=>mappedPin(`odom:${axis}:${field}`,odomPins[axis][i]));right.push(pinoutCard('passive-'+axis,'right','◌','Passive encoder '+axis.toUpperCase(),`${robotDesign.encoders.find(e=>e.role==='odom_'+axis)?.ppr||600} PPR ×1 · tracking wheel R=29 mm`,[['ENC A',a],['ENC B',b],['GND','GND ร่วม']],COLORS.encoder));}
    right.push(pinoutCard('bno08x','right','🧭','BNO08x','Position heading',[['SCL','PB10'],['SDA','PB11'],['RESET','PC13'],['VCC','3V3'],['GND','GND']],COLORS.sensor));
  }
  if(accessories.has('mpu6050'))right.push(pinoutCard('mpu6050','right','🧭','MPU6050 IMU','I²C · Address 0x68',[['VCC','3V3'],['SCL',controller.aux.scl],['SDA',controller.aux.sda],['GND','GND']],COLORS.sensor));
  if(accessories.has('bno055'))right.push(pinoutCard('bno055','right','🧿','BNO055 IMU','I²C · Address 0x28',[['VIN','3V3'],['SCL',controller.aux.scl],['SDA',controller.aux.sda],['GND','GND']],COLORS.sensor));
  if(accessories.has('hcsr04'))right.push(pinoutCard('hcsr04','right','📏','HC-SR04','ECHO ผ่าน Voltage divider',[['TRIG',controller.aux.trig],['ECHO',controller.aux.echo],['VCC','5V'],['GND','GND']],COLORS.sensor));
  if(accessories.has('servo'))right.push(pinoutCard('servo','right','⚙️','Servo Signal','ใช้ไฟ 5V ภายนอก',[['PWM',controller.aux.servo],['GND','GND']],COLORS.sensor));
  $('wiring-board').innerHTML=`<div class="pinout-stage" id="pinout-stage"><svg class="pinout-wires" id="pinout-wires" aria-hidden="true"></svg><div class="pinout-side">${left.join('')}</div><div class="hw-controller" id="pinout-mcu"><span class="hw-controller-kicker">CONTROLLER</span><div class="hw-device-scene">${hardwareDeviceArt('controller',$('controller-board').value,controller.label)}</div><strong>${esc(controller.label)}</strong><small>${esc(controller.sub)}</small><div class="hw-controller-foot">MOTOR DRIVER ← → ENCODER / SENSOR<br>เลือกพินได้ที่ช่องบนการ์ดอุปกรณ์</div></div><div class="pinout-side">${right.join('')}</div></div>`;
  const pinErrors=pinConflictErrors();if(pinErrors.length)$('wiring-board').insertAdjacentHTML('beforeend',`<div class="assignment-warning" role="alert">${pinErrors.map(esc).join('<br>')}</div>`);
  $('pin-table').hidden=true;
  requestAnimationFrame(drawPinoutLines);
}

function drawPinoutLines(){
  const stage=$('pinout-stage'),svg=$('pinout-wires'),mcu=$('pinout-mcu');if(!stage||!svg||!mcu)return;
  const root=stage.getBoundingClientRect(),board=mcu.getBoundingClientRect();svg.setAttribute('viewBox',`0 0 ${root.width} ${root.height}`);svg.innerHTML='';
  const cards=[...stage.querySelectorAll('.pinout-card')];
  cards.forEach(card=>{
    const box=card.getBoundingClientRect(),side=card.dataset.side,color=getComputedStyle(card).getPropertyValue('--wire').trim(),left=side==='left';
    const siblings=cards.filter(item=>item.dataset.side===side),index=siblings.indexOf(card);
    const x1=(left?box.right:box.left)-root.left,y=box.top+box.height/2-root.top,x2=(left?board.left:board.right)-root.left,mid=x1+(x2-x1)*.52;
    // Anchor every connection to the controller card, even with many sensors.
    // These are grouped visual routes, not claims of physical PCB pin locations.
    const targetY=board.top-root.top+36+(board.height-72)*(index+1)/(siblings.length+1);
    svg.insertAdjacentHTML('beforeend',`<path class="pinout-wire" style="--wire:${color}" d="M ${x1} ${y} C ${mid} ${y}, ${mid} ${targetY}, ${x2} ${targetY}"/><circle class="pinout-dot" style="--wire:${color}" cx="${x2}" cy="${targetY}" r="4"/>`);
  });
}

function validateMecanumXY(){
  if($('controller-board').value!=='stm32f103'||$('motor-driver').value!=='cycron')throw new Error('Mecanum XY ใช้ STM32F103 และ Driver PWM/DIR');
  const motors=motorPinData(),passive=robotDesign.encoders.filter(e=>e.enabled&&!e.attachedWheel);
  const disabled=robotDesign.wheels.filter(w=>!w.motorEnabled).map(w=>w.name+' (Motor ปิด)');
  if(motors.length!==4)throw new Error('Mecanum XY ต้องเปิดมอเตอร์ครบ 4 ตัว: '+disabled.join(', '));
  if(new Set(motors.map(m=>m.motorRole)).size!==4||motors.some(m=>!['front_left','front_right','rear_left','rear_right'].includes(m.motorRole)))throw new Error('กำหนด FL / FR / RL / RR ให้ครบและไม่ซ้ำ');
  if(motors.some(m=>robotDesign.encoders.filter(e=>e.enabled&&e.attachedWheel===m.wheelName).length>1))throw new Error('Encoder มอเตอร์ถูกผูกซ้ำ กรุณาผูกหนึ่งตัวต่อล้อ');
  if(new Set(motors.filter(m=>m.encoderEnabled).map(m=>m.ppr)).size>1)throw new Error('Encoder ความเร็วล้อที่เปิดใช้งานต้องมี PPR เท่ากัน');
  if(passive.length!==2||!['odom_x','odom_y'].every(role=>passive.some(e=>e.role===role)))throw new Error('ต้องมี Encoder อิสระ X และ Y อย่างละ 1 ตัว');
  if(passive[0].ppr!==passive[1].ppr)throw new Error('Encoder X/Y ต้องใช้ PPR เท่ากัน');
  if(motors.some(m=>m.encoderEnabled&&m.encoderRole!=='motor_feedback'))throw new Error('Encoder ความเร็วล้อที่เปิดใช้งานต้องเป็น motor_feedback; Encoder อิสระใช้ ODOM X/Y');
}

function currentConfig(){
  const pinErrors=pinConflictErrors();if(pinErrors.length)throw new Error(pinErrors.join(' · '));
  if(isMecanumXY())validateMecanumXY();
  if(!hardwareSupported())throw new Error('เลือก 2WD Differential หรือ Template Mecanum 4 ล้อ + Encoder X/Y');
  const motorRoles=robotDesign.wheels.filter(wheel=>wheel.motorEnabled).map(wheel=>wheel.motorRole),required=isMecanumXY()?['front_left','front_right','rear_left','rear_right']:['left','right'];
  if(!required.every(role=>motorRoles.includes(role)))throw new Error(`กรุณากำหนดหน้าที่มอเตอร์ให้ครบ: ${required.map(role=>MOTOR_ROLES[role]).join(', ')}`);
  const numberValue=(id,label,min)=>{const value=Number($(id)?.value);if(!Number.isFinite(value)||value<min)throw new Error(`${label} ไม่ถูกต้อง`);return value;};
  const serialPort=String($('bridge-serial-port')?.value||'').trim();if(!serialPort.startsWith('/dev/'))throw new Error('Serial port ต้องเป็น path ใต้ /dev/ เช่น /dev/ttyUSB0');
  const baudRate=Math.round(numberValue('bridge-baud-rate','Baud rate',9600)),commandTimeoutMs=Math.round(numberValue('command-timeout-ms','Command timeout',100)),motorMaxRpm=numberValue('motor-max-rpm','Motor max RPM',1),sharedPid={kp:numberValue('pid-kp','PID Kp',0),ki:numberValue('pid-ki','PID Ki',0),kd:numberValue('pid-kd','PID Kd',0)},pid=tunedWheelPid?{...sharedPid,...tunedWheelPid}:sharedPid;
  const accessories=selectedAccessories(),controller=$('controller-board').value,meta=CONTROLLERS[controller]||CONTROLLERS.stm32f103,assignments=robotDesign.wheels.map(({name,x,y,radius,motorEnabled,motorRole,hardwareChannel,motorInvert,encoderEnabled,encoderRole,ppr,channels,invert})=>({name,x,y,radius,motorEnabled,motorRole,hardwareChannel,motorInvert,encoderEnabled,encoderRole,ppr,channels,invert})),encoderAssignments=robotDesign.encoders.map(({name,parent,attachedWheel,enabled,role,ppr,channels,invert,x,y,z})=>({name,parent,attachedWheel,enabled,role,ppr,channels,invert,x,y,z}));return{version:18,pinAssignments:hardwarePinAssignments,odomPinAssignments:isMecanumXY()?Object.fromEntries(['x','y'].map(axis=>[axis,['encA','encB'].map((field,i)=>mappedPin(`odom:${axis}:${field}`,MecanumXY.odomPins(odomSwapXY)[axis][i]))])):null,motorSpeedFeedback:!isMecanumXY(),odomSwapXY:isMecanumXY()&&odomSwapXY,source:'sim_robot_tf/tf_model.json + sim_robot_odom/odom_config.json',transport:'python_serial',bridgePackage:'roside_controller_bridge',robotDesign:{...robotDesign,wheels:assignments,encoders:encoderAssignments},assignments,encoderAssignments,controller,board:controller,boardLabel:meta.label,drive:robotDesign.drive,driveLabel:robotDesign.driveLabel,kinematics:DRIVE_META[robotDesign.drive].kinematics,motorCount:robotDesign.motorCount,encoderCount:robotDesign.encoderCount,motorDriver:$('motor-driver').value,pidControl:$('pid-control-enabled')?.checked!==false,wheelDiameterMm:robotDesign.wheelDiameterMm,wheelTrackMm:robotDesign.wheelTrackMm,wheelBaseMm:robotDesign.wheelBaseMm,encoderTicksPerRevolution:600,encoderDecodeMode:'x1_a_rising',motorMaxRpm,serialPort,baudRate,commandTimeoutMs,pid,accessories,updatedAt:new Date().toISOString()};
}

function apply2wdRuntimeProtocol(source,config){
  const leftPid=config.pid?.left||config.pid||{},rightPid=config.pid?.right||config.pid||{};
  source=source.replace('constexpr uint32_t kCommandTimeoutMs = 300;',`constexpr uint32_t kCommandTimeoutMs = ${Math.round(Number(config.commandTimeoutMs)||300)};`);
  source=source.replace('constexpr float kVelocityKp = 0.975f;\nconstexpr float kVelocityKi = 5.005f;\nconstexpr float kVelocityKd = 0.000f;',`float velocity_kp[kMotorCount] = {${Number(leftPid.kp??0.5).toFixed(4)}f, ${Number(rightPid.kp??0.5).toFixed(4)}f};\nfloat velocity_ki[kMotorCount] = {${Number(leftPid.ki??0).toFixed(4)}f, ${Number(rightPid.ki??0).toFixed(4)}f};\nfloat velocity_kd[kMotorCount] = {${Number(leftPid.kd??0).toFixed(4)}f, ${Number(rightPid.kd??0).toFixed(4)}f};\nbool direct_rpm_mode = false;\nfloat direct_rpm_targets[kMotorCount] = {};`);
  source=source.replace('float calculateVelocityPid(MotorState &motor, const float dt)','float calculateVelocityPid(const uint8_t index, MotorState &motor, const float dt)');
  source=source.replaceAll('kVelocityKp','velocity_kp[index]').replaceAll('kVelocityKi','velocity_ki[index]').replaceAll('kVelocityKd','velocity_kd[index]');
  source=source.replace('// V <linear_x_mps> <linear_y_mps> <angular_z_radps>\n// Z resets odometry.','// V <linear_x_mps> <linear_y_mps> <angular_z_radps>\n// R <left_rpm> <right_rpm> enters wheel tuning mode.\n// P <kp> <ki> <kd> applies both wheels; P <Lkp> <Lki> <Lkd> <Rkp> <Rki> <Rkd> tunes separately.\n// S stops motors. Z resets odometry.');
  source=source.replace('    command_vx = vx;\n    command_vy = 0.0f;','    direct_rpm_mode = false;\n    command_vx = vx;\n    command_vy = 0.0f;');
  const extra=`\n  float left_rpm = 0.0f;\n  float right_rpm = 0.0f;\n  if (sscanf(line, "R %f %f", &left_rpm, &right_rpm) == 2)\n  {\n    direct_rpm_mode = true;\n    direct_rpm_targets[0] = constrain(left_rpm, -kMotorMaxRpm, kMotorMaxRpm);\n    direct_rpm_targets[1] = constrain(right_rpm, -kMotorMaxRpm, kMotorMaxRpm);\n    last_command_ms = millis();\n    return;\n  }\n\n  float lkp = 0.0f, lki = 0.0f, lkd = 0.0f, rkp = 0.0f, rki = 0.0f, rkd = 0.0f;\n  int pid_fields = sscanf(line, "P %f %f %f %f %f %f", &lkp, &lki, &lkd, &rkp, &rki, &rkd);\n  if (pid_fields == 3) { rkp = lkp; rki = lki; rkd = lkd; }\n  if ((pid_fields == 3 || pid_fields == 6) && isfinite(lkp) && isfinite(lki) && isfinite(lkd) && isfinite(rkp) && isfinite(rki) && isfinite(rkd) && lkp >= 0.0f && lki >= 0.0f && lkd >= 0.0f && rkp >= 0.0f && rki >= 0.0f && rkd >= 0.0f)\n  {\n    velocity_kp[0] = lkp; velocity_ki[0] = lki; velocity_kd[0] = lkd;\n    velocity_kp[1] = rkp; velocity_ki[1] = rki; velocity_kd[1] = rkd;\n    for (uint8_t i = 0; i < kMotorCount; ++i) { motors[i].integral = 0.0f; motors[i].previous_error = 0.0f; }\n    Serial.print("PID "); Serial.print(velocity_kp[0], 4); Serial.print(' '); Serial.print(velocity_ki[0], 4); Serial.print(' '); Serial.print(velocity_kd[0], 4); Serial.print(' ');\n    Serial.print(velocity_kp[1], 4); Serial.print(' '); Serial.print(velocity_ki[1], 4); Serial.print(' '); Serial.println(velocity_kd[1], 4);\n    return;\n  }\n\n  if (line[0] == 'S')\n  {\n    direct_rpm_mode = false; command_vx = 0.0f; command_vy = 0.0f; command_wz = 0.0f;\n    for (uint8_t i = 0; i < kMotorCount; ++i) { motors[i].target_rpm = 0.0f; setMotor(i, 0.0f); }\n    last_command_ms = millis();\n    return;\n  }\n`;
  source=source.replace("\n  if (line[0] == 'Z')",extra+"\n  if (line[0] == 'Z')");
  source=source.replace('motors[i].target_rpm = 0.0f; setMotor(i, 0.0f);','motors[i].target_rpm = 0.0f; motors[i].output_pwm = 0.0f; setMotor(i, 0.0f);');
  source=source.replace('void stopMotors()\n{\n  command_vx','void stopMotors()\n{\n  direct_rpm_mode = false;\n  command_vx');
  source=source.replace('Serial.begin(115200);',`Serial.begin(${Math.round(Number(config.baudRate)||115200)});`);
  source=source.replace('  float target_rpm[kMotorCount] = {};\n  calculateWheelTargets(command_vx, command_vy, command_wz, target_rpm);','  float target_rpm[kMotorCount] = {};\n  if (direct_rpm_mode) { target_rpm[0] = direct_rpm_targets[0]; target_rpm[1] = direct_rpm_targets[1]; }\n  else { calculateWheelTargets(command_vx, command_vy, command_wz, target_rpm); }');
  source=source.replace('calculateVelocityPid(motors[i], dt)','calculateVelocityPid(i, motors[i], dt)');
  source=source.replace('  updateOdometry(dt);\n}','  updateOdometry(dt);\n  Serial.print("RPM "); Serial.print(motors[0].target_rpm, 3); Serial.print(\' \'); Serial.print(motors[0].measured_rpm, 3); Serial.print(\' \'); Serial.print(motors[1].target_rpm, 3); Serial.print(\' \'); Serial.println(motors[1].measured_rpm, 3);\n}');
  return source;
}

function applyGyroTelemetry(source,config){
  const accessories=new Set(config.accessories||[]),model=accessories.has('bno055')?'bno055':accessories.has('mpu6050')?'mpu6050':'';
  if(!model)return source;
  const address=model==='bno055'?'kBno055Address':'kMpu6050Address';
  const register=model==='bno055'?'0x14':'0x43',littleEndian=model==='bno055',scale=model==='bno055'?'16.0f':'131.0f';
  const setup=model==='bno055'
    ?`  Wire.beginTransmission(${address}); Wire.write(0x3D); Wire.write(0x00); Wire.endTransmission(); delay(25);
  Wire.beginTransmission(${address}); Wire.write(0x3D); Wire.write(0x0C); Wire.endTransmission(); delay(25);`
    :`  Wire.beginTransmission(${address}); Wire.write(0x6B); Wire.write(0x00); Wire.endTransmission(); delay(100);
  Wire.beginTransmission(${address}); Wire.write(0x1B); Wire.write(0x00); Wire.endTransmission();`;
  const combine=littleEndian
    ?`  const int16_t raw_x = static_cast<int16_t>((static_cast<uint16_t>(data[1]) << 8) | data[0]);
  const int16_t raw_y = static_cast<int16_t>((static_cast<uint16_t>(data[3]) << 8) | data[2]);
  const int16_t raw_z = static_cast<int16_t>((static_cast<uint16_t>(data[5]) << 8) | data[4]);`
    :`  const int16_t raw_x = static_cast<int16_t>((static_cast<uint16_t>(data[0]) << 8) | data[1]);
  const int16_t raw_y = static_cast<int16_t>((static_cast<uint16_t>(data[2]) << 8) | data[3]);
  const int16_t raw_z = static_cast<int16_t>((static_cast<uint16_t>(data[4]) << 8) | data[5]);`;
  const code=`// -----------------------------------------------------------------------------
// Gyroscope telemetry (${model==='bno055'?'BNO055':'MPU6050'})
// Output unit is degrees per second: GYRO gx gy gz
// -----------------------------------------------------------------------------
void setupGyroscope()
{
${setup}
}

bool readGyroscope(float &gx, float &gy, float &gz)
{
  Wire.beginTransmission(${address});
  Wire.write(${register});
  if (Wire.endTransmission(false) != 0) return false;
  constexpr uint8_t kGyroBytes = 6;
  if (Wire.requestFrom(static_cast<uint8_t>(${address}), kGyroBytes) != kGyroBytes) return false;
  uint8_t data[kGyroBytes] = {};
  for (uint8_t i = 0; i < kGyroBytes; ++i) data[i] = Wire.read();
${combine}
  gx = static_cast<float>(raw_x) / ${scale};
  gy = static_cast<float>(raw_y) / ${scale};
  gz = static_cast<float>(raw_z) / ${scale};
  return true;
}

void publishGyroscope()
{
  static uint32_t previous_gyro_ms = 0;
  const uint32_t now = millis();
  if (now - previous_gyro_ms < 50) return;
  previous_gyro_ms = now;
  float gx = 0.0f, gy = 0.0f, gz = 0.0f;
  if (!readGyroscope(gx, gy, gz)) return;
  Serial.print("GYRO "); Serial.print(gx, 3); Serial.print(' ');
  Serial.print(gy, 3); Serial.print(' '); Serial.println(gz, 3);
}

`;
  source=source.replace('// Arduino lifecycle',code+'// Arduino lifecycle');
  source=source.replace('  Wire.begin();','  Wire.begin();\n  setupGyroscope();');
  source=source.replace("Serial.println(motors[1].measured_rpm, 3);\n}","Serial.println(motors[1].measured_rpm, 3);\n  publishGyroscope();\n}");
  return source;
}

function firmwareSource(config){
  const motors=motorPinData();
  const accessories=new Set(config.accessories);
  const usesI2c=accessories.has('mpu6050')||accessories.has('bno055');
  const cycron=config.motorDriver==='cycron',esp32Pwm=config.controller==='esp32';
  const aux=hardwareAuxPins();
  const radius=(config.wheelDiameterMm/2000).toFixed(6);
  const track=(config.wheelTrackMm/1000).toFixed(6);
  const wheelBase=(Math.max(0,config.wheelBaseMm||0)/1000).toFixed(6);
  const motorRows=motors.map(m=>cycron
    ?`    {${m.in1}, ${m.pwm}, ${m.encA}, ${m.encB}}`
    :`    {${m.in1}, ${m.in2}, ${m.pwm}, ${m.encA}, ${m.encB}}`).join(',\n');
  const isrFunctions=motors.map((motor,index)=>`void onEncoder${index+1}()\n{\n  encoder_ticks[${index}] += (digitalRead(kMotorPins[${index}].encoder_b) ? 1 : -1) * ${motor.invert===-1?'-1':'1'};\n}`).join('\n\n');
  const isrList=motors.map((_,index)=>`onEncoder${index+1}`).join(', ');
  const kinematics=config.drive==='mecanum4'
    ?`  // Mecanum inverse kinematics (FL, FR, RL, RR).\n  const float rotation = (kHalfWheelBaseM + kHalfTrackWidthM) * angular_z;\n  target_rpm[0] = linearToRpm(linear_x - linear_y - rotation);\n  target_rpm[1] = linearToRpm(linear_x + linear_y + rotation);\n  target_rpm[2] = linearToRpm(linear_x + linear_y - rotation);\n  target_rpm[3] = linearToRpm(linear_x - linear_y + rotation);`
    :config.motorCount===4
      ?`  // Four-wheel differential/skid-steer inverse kinematics.\n  const float left_mps  = linear_x - (angular_z * kTrackWidthM * 0.5f);\n  const float right_mps = linear_x + (angular_z * kTrackWidthM * 0.5f);\n  target_rpm[0] = linearToRpm(left_mps);\n  target_rpm[1] = linearToRpm(right_mps);\n  target_rpm[2] = linearToRpm(left_mps);\n  target_rpm[3] = linearToRpm(right_mps);`
      :`  // Two-wheel differential inverse kinematics.\n  const float left_mps  = linear_x - (angular_z * kTrackWidthM * 0.5f);\n  const float right_mps = linear_x + (angular_z * kTrackWidthM * 0.5f);\n  target_rpm[0] = linearToRpm(left_mps);\n  target_rpm[1] = linearToRpm(right_mps);`;
  const forwardKinematics=config.drive==='mecanum4'
    ?`  const float w_fl = rpmToRadPerSec(motors[0].measured_rpm);\n  const float w_fr = rpmToRadPerSec(motors[1].measured_rpm);\n  const float w_rl = rpmToRadPerSec(motors[2].measured_rpm);\n  const float w_rr = rpmToRadPerSec(motors[3].measured_rpm);\n  const float arm = kHalfWheelBaseM + kHalfTrackWidthM;\n\n  velocity_x = kWheelRadiusM * (w_fl + w_fr + w_rl + w_rr) * 0.25f;\n  velocity_y = kWheelRadiusM * (-w_fl + w_fr + w_rl - w_rr) * 0.25f;\n  velocity_yaw = kWheelRadiusM * (-w_fl + w_fr - w_rl + w_rr) / (4.0f * arm);`
    :config.motorCount===4
      ?`  const float left_mps = 0.5f * (rpmToLinear(motors[0].measured_rpm) +\n                                  rpmToLinear(motors[2].measured_rpm));\n  const float right_mps = 0.5f * (rpmToLinear(motors[1].measured_rpm) +\n                                   rpmToLinear(motors[3].measured_rpm));\n\n  velocity_x = 0.5f * (left_mps + right_mps);\n  velocity_y = 0.0f;\n  velocity_yaw = (right_mps - left_mps) / kTrackWidthM;`
      :`  const float left_mps = rpmToLinear(motors[0].measured_rpm);\n  const float right_mps = rpmToLinear(motors[1].measured_rpm);\n\n  velocity_x = 0.5f * (left_mps + right_mps);\n  velocity_y = 0.0f;\n  velocity_yaw = (right_mps - left_mps) / kTrackWidthM;`;
  const pwmSetup=esp32Pwm?'\n    ledcSetup(i, 20000, 8);\n    ledcAttachPin(kMotorPins[i].pwm, i);':'\n    pinMode(kMotorPins[i].pwm, OUTPUT);';
  const pinSetup=cycron
    ?`    pinMode(kMotorPins[i].direction, OUTPUT);${pwmSetup}`
    :`    pinMode(kMotorPins[i].in1, OUTPUT);\n    pinMode(kMotorPins[i].in2, OUTPUT);${pwmSetup}`;
  const pwmWrite=esp32Pwm?'ledcWrite(index, magnitude);':'analogWrite(pins.pwm, magnitude);';
  const motorOutput=cycron
    ?`  digitalWrite(pins.direction, pwm >= 0 ? HIGH : LOW);\n  ${pwmWrite}`
    :`  digitalWrite(pins.in1, pwm > 0 ? HIGH : LOW);\n  digitalWrite(pins.in2, pwm < 0 ? HIGH : LOW);\n  ${pwmWrite}`;
  const sensorConstants=[accessories.has('mpu6050')?'constexpr uint8_t kMpu6050Address = 0x68;':'',accessories.has('bno055')?'constexpr uint8_t kBno055Address = 0x28;':'',accessories.has('hcsr04')?`constexpr uint32_t kUltrasonicTriggerPin = ${aux.trig};\nconstexpr uint32_t kUltrasonicEchoPin = ${aux.echo};`:'',accessories.has('servo')?`constexpr uint32_t kServoPwmPin = ${aux.servo};`:'' ].filter(Boolean).join('\n');
  return `// Generated by Mecha Rayong Hardware Builder.\n// Source: Robot Model + TF + ODOM configuration.\n// Controller: ${config.boardLabel}\n// Drive: ${config.driveLabel}\n// Motor driver: ${config.motorDriver}\n\n#include <Arduino.h>\n${usesI2c?'#include <Wire.h>\n':''}\nnamespace config\n{\nconstexpr uint8_t kMotorCount = ${config.motorCount};\nconstexpr float kWheelRadiusM = ${radius}f;\nconstexpr float kTrackWidthM = ${track}f;\nconstexpr float kWheelBaseM = ${wheelBase}f;\nconstexpr float kHalfTrackWidthM = kTrackWidthM * 0.5f;\nconstexpr float kHalfWheelBaseM = kWheelBaseM * 0.5f;\nconstexpr float kEncoderTicksPerRevolution = ${Number(config.encoderTicksPerRevolution||600).toFixed(1)}f;\nconstexpr float kMotorMaxRpm = ${Number(config.motorMaxRpm||300).toFixed(1)}f;\nconstexpr uint32_t kControlPeriodMs = 20;\nconstexpr uint32_t kCommandTimeoutMs = 300;\n${sensorConstants}\n}  // namespace config\n\nusing namespace config;\n\n// -----------------------------------------------------------------------------\n// Pin map\n// -----------------------------------------------------------------------------\nstruct MotorPins\n{\n${cycron?'  uint32_t direction;\n  uint32_t pwm;':'  uint32_t in1;\n  uint32_t in2;\n  uint32_t pwm;'}\n  uint32_t encoder_a;\n  uint32_t encoder_b;\n};\n\nconstexpr MotorPins kMotorPins[kMotorCount] =\n{\n${motorRows}\n};\n\n// -----------------------------------------------------------------------------\n// Runtime state and PID\n// -----------------------------------------------------------------------------\nstruct MotorState\n{\n  volatile int32_t encoder_ticks = 0;\n  int32_t previous_ticks = 0;\n  float target_rpm = 0.0f;\n  float measured_rpm = 0.0f;\n  float integral = 0.0f;\n  float previous_error = 0.0f;\n};\n\nMotorState motors[kMotorCount];\nvolatile int32_t encoder_ticks[kMotorCount] = {};\n\nconstexpr float kVelocityKp = 0.975f;\nconstexpr float kVelocityKi = 5.005f;\nconstexpr float kVelocityKd = 0.000f;\n\nfloat command_vx = 0.0f;\nfloat command_vy = 0.0f;\nfloat command_wz = 0.0f;\nfloat pose_x = 0.0f;\nfloat pose_y = 0.0f;\nfloat pose_yaw = 0.0f;\nuint32_t last_command_ms = 0;\nuint32_t previous_control_ms = 0;\nchar serial_buffer[96] = {};\nsize_t serial_length = 0;\n\n// -----------------------------------------------------------------------------\n// Encoder interrupts\n// -----------------------------------------------------------------------------\n${isrFunctions}\n\nusing EncoderIsr = void (*)();\nEncoderIsr const kEncoderIsr[kMotorCount] = {${isrList}};\n\n// -----------------------------------------------------------------------------\n// Unit conversion and kinematics\n// -----------------------------------------------------------------------------\nfloat linearToRpm(const float metres_per_second)\n{\n  return metres_per_second * 60.0f / (2.0f * PI * kWheelRadiusM);\n}\n\nfloat rpmToLinear(const float rpm)\n{\n  return rpm * (2.0f * PI * kWheelRadiusM) / 60.0f;\n}\n\nfloat rpmToRadPerSec(const float rpm)\n{\n  return rpm * (2.0f * PI) / 60.0f;\n}\n\nvoid calculateWheelTargets(const float linear_x,\n                           const float linear_y,\n                           const float angular_z,\n                           float (&target_rpm)[kMotorCount])\n{\n${kinematics}\n\n  float largest = 0.0f;\n  for (uint8_t i = 0; i < kMotorCount; ++i)\n  {\n    largest = max(largest, fabs(target_rpm[i]));\n  }\n\n  if (largest > kMotorMaxRpm)\n  {\n    const float scale = kMotorMaxRpm / largest;\n    for (uint8_t i = 0; i < kMotorCount; ++i)\n    {\n      target_rpm[i] *= scale;\n    }\n  }\n}\n\n// -----------------------------------------------------------------------------\n// Motor control\n// -----------------------------------------------------------------------------\nvoid setMotor(const uint8_t index, const float requested_pwm)\n{\n  const MotorPins &pins = kMotorPins[index];\n  const int pwm = constrain(static_cast<int>(requested_pwm), -255, 255);\n  const int magnitude = abs(pwm);\n${motorOutput}\n}\n\nfloat calculateVelocityPid(MotorState &motor, const float dt)\n{\n  const float error = motor.target_rpm - motor.measured_rpm;\n  motor.integral = constrain(motor.integral + (error * dt), -250.0f, 250.0f);\n  const float derivative = (error - motor.previous_error) / dt;\n  motor.previous_error = error;\n  return (kVelocityKp * error) + (kVelocityKi * motor.integral) +\n         (kVelocityKd * derivative);\n}\n\nvoid updateMeasuredRpm(const float dt)\n{\n  noInterrupts();\n  int32_t ticks[kMotorCount] = {};\n  for (uint8_t i = 0; i < kMotorCount; ++i)\n  {\n    ticks[i] = encoder_ticks[i];\n  }\n  interrupts();\n\n  const float ticks_to_rpm = 60.0f / (kEncoderTicksPerRevolution * dt);\n  for (uint8_t i = 0; i < kMotorCount; ++i)\n  {\n    const int32_t delta = ticks[i] - motors[i].previous_ticks;\n    motors[i].previous_ticks = ticks[i];\n    motors[i].measured_rpm = static_cast<float>(delta) * ticks_to_rpm;\n  }\n}\n\n// -----------------------------------------------------------------------------\n// Encoder odometry (forward kinematics)\n// -----------------------------------------------------------------------------\nvoid updateOdometry(const float dt)\n{\n  float velocity_x = 0.0f;\n  float velocity_y = 0.0f;\n  float velocity_yaw = 0.0f;\n\n${forwardKinematics}\n\n  const float cos_yaw = cos(pose_yaw);\n  const float sin_yaw = sin(pose_yaw);\n  pose_x += (velocity_x * cos_yaw - velocity_y * sin_yaw) * dt;\n  pose_y += (velocity_x * sin_yaw + velocity_y * cos_yaw) * dt;\n  pose_yaw += velocity_yaw * dt;\n  pose_yaw = atan2(sin(pose_yaw), cos(pose_yaw));\n\n  Serial.print("ODOM ");\n  Serial.print(pose_x, 4);\n  Serial.print(' ');\n  Serial.print(pose_y, 4);\n  Serial.print(' ');\n  Serial.print(pose_yaw, 4);\n  Serial.print(' ');\n  Serial.print(velocity_x, 4);\n  Serial.print(' ');\n  Serial.print(velocity_y, 4);\n  Serial.print(' ');\n  Serial.println(velocity_yaw, 4);\n}\n\n// -----------------------------------------------------------------------------\n// Serial protocol from the ROS 2 bridge\n// V <linear_x_mps> <linear_y_mps> <angular_z_radps>\n// Z resets odometry.\n// -----------------------------------------------------------------------------\nvoid processCommand(char *line)\n{\n  float vx = 0.0f;\n  float vy = 0.0f;\n  float wz = 0.0f;\n\n  if (sscanf(line, "V %f %f %f", &vx, &vy, &wz) == 3)\n  {\n    command_vx = vx;\n    command_vy = ${config.drive==='mecanum4'?'vy':'0.0f'};\n    command_wz = wz;\n    last_command_ms = millis();\n    return;\n  }\n\n  if (line[0] == 'Z')\n  {\n    pose_x = 0.0f;\n    pose_y = 0.0f;\n    pose_yaw = 0.0f;\n  }\n}\n\nvoid readSerialCommands()\n{\n  while (Serial.available() > 0)\n  {\n    const char value = static_cast<char>(Serial.read());\n    if (value == '\\n')\n    {\n      serial_buffer[serial_length] = '\\0';\n      processCommand(serial_buffer);\n      serial_length = 0;\n    }\n    else if (value != '\\r' && serial_length < sizeof(serial_buffer) - 1)\n    {\n      serial_buffer[serial_length++] = value;\n    }\n  }\n}\n\nvoid stopMotors()\n{\n  command_vx = 0.0f;\n  command_vy = 0.0f;\n  command_wz = 0.0f;\n  for (uint8_t i = 0; i < kMotorCount; ++i)\n  {\n    motors[i].target_rpm = 0.0f;\n    setMotor(i, 0.0f);\n  }\n}\n\n// -----------------------------------------------------------------------------\n// Arduino lifecycle\n// -----------------------------------------------------------------------------\nvoid setup()\n{\n  Serial.begin(115200);\n${usesI2c?'  Wire.begin();\n':''}\n  for (uint8_t i = 0; i < kMotorCount; ++i)\n  {\n${pinSetup}\n    pinMode(kMotorPins[i].encoder_a, INPUT_PULLUP);\n    pinMode(kMotorPins[i].encoder_b, INPUT_PULLUP);\n    attachInterrupt(digitalPinToInterrupt(kMotorPins[i].encoder_a),\n                    kEncoderIsr[i],\n                    RISING);\n  }\n${accessories.has('hcsr04')?'\n  pinMode(kUltrasonicTriggerPin, OUTPUT);\n  pinMode(kUltrasonicEchoPin, INPUT);\n':''}${accessories.has('servo')?'\n  pinMode(kServoPwmPin, OUTPUT);\n':''}\n  stopMotors();\n  previous_control_ms = millis();\n  last_command_ms = previous_control_ms;\n  Serial.println("ROSIDE_CONTROLLER_READY");\n}\n\nvoid loop()\n{\n  readSerialCommands();\n\n  const uint32_t now = millis();\n  if (now - last_command_ms > kCommandTimeoutMs)\n  {\n    stopMotors();\n  }\n\n  if (now - previous_control_ms < kControlPeriodMs)\n  {\n    return;\n  }\n\n  const float dt = static_cast<float>(now - previous_control_ms) / 1000.0f;\n  previous_control_ms = now;\n\n  float target_rpm[kMotorCount] = {};\n  calculateWheelTargets(command_vx, command_vy, command_wz, target_rpm);\n  updateMeasuredRpm(dt);\n\n  for (uint8_t i = 0; i < kMotorCount; ++i)\n  {\n    motors[i].target_rpm = target_rpm[i];\n    setMotor(i, calculateVelocityPid(motors[i], dt));\n  }\n\n  updateOdometry(dt);\n}\n`;
}

function readme(config){return `# ${config.boardLabel} — ${config.driveLabel}\n\nGenerated from the saved Robot Model and ODOM. The geometry constants and kinematic equations in \`main.cpp\` follow this configuration.\n\n- Controller: ${config.boardLabel}\n- Drive: ${config.driveLabel}\n- Motors: ${config.motorCount}\n- Wheel diameter: ${config.wheelDiameterMm} mm\n- Wheel radius: ${(config.wheelDiameterMm/2).toFixed(1)} mm\n- Wheel track: ${config.wheelTrackMm} mm\n- Wheel base: ${config.wheelBaseMm||0} mm\n- Encoder resolution: ${config.encoderTicksPerRevolution} ticks/revolution\n- Motor limit: ${config.motorMaxRpm} RPM\n- Driver: ${config.motorDriver.toUpperCase()}\n- Accessories: ${config.accessories.join(', ')||'none'}\n\n## ROS 2 serial protocol\n\n- Velocity command: \`V <linear_x_mps> <linear_y_mps> <angular_z_radps>\`\n- Reset odometry: \`Z\`\n- Odometry output: \`ODOM x y yaw vx vy wz\`\n- Gyroscope output: \`GYRO gx gy gz\` in degrees/second when MPU6050 or BNO055 is selected.\n\n## Safety\n\n- Verify the controller logic voltage, encoder resolution, motor polarity, and default pin template before powering hardware.\n- Use a voltage divider on HC-SR04 ECHO for 3.3V GPIO.\n- Use separate motor power and connect all grounds together.\n- Lift the wheels before the first motor direction test.\n- Firmware stops all motors after 300 ms without a valid command.\n`;}
function platformioSource(config){
  if(config.robotDesign?.hardwareTemplate==='mecanum_xy')return MecanumXY.ini(config);
  // Blue Pill uses newlib-nano: V/R/P commands require its optional %f scanner.
  // Serial.print(float) can work while sscanf("%f") silently fails without it.
  const target=PLATFORMIO_TARGETS[config.controller]||PLATFORMIO_TARGETS.stm32f103;
  const environment=config.controller==='esp32'?'nodemcu-32s':config.controller;
  const esp32Upload=config.controller==='esp32'?'upload_speed = 115200\nboard_upload.before_reset = default_reset\nboard_upload.after_reset = hard_reset\n':'';
  return `; Generated by Mecha Rayong Hardware Builder\n; Geometry and pin assignments are stored in src/main.cpp\n; Sensors currently use Arduino Wire pin/address scaffolding only.\n; No unused registry libraries are downloaded during the build.\n\n[env:${environment}]\nplatform = ${target[0]}\nboard = ${target[1]}\nframework = arduino\n${target[2]?target[2]+'\n':''}${esp32Upload}monitor_speed = 115200\nbuild_flags =\n  -Wall\n  -Wextra\n  -Wpedantic${config.controller==='stm32f103'?'\n  -D PIO_FRAMEWORK_CREDENTIALS_NONE\n  -D PIO_FRAMEWORK_ARDUINO_NANOLIB_FLOAT_SCANF':''}\n`;
}
function firmwareSourceWithAssignments(config){
  if(config.robotDesign?.hardwareTemplate==='mecanum_xy')return MecanumXY.firmware(config,motorPinData());
  const motors=motorPinData(),enabled=motors.map(motor=>motor.encoderEnabled),roles=motors.map(motor=>({unused:0,odom_x:1,odom_y:2,odom_xy:3,motor_feedback:4}[motor.encoderRole]??0)),ticks=motors.map(encoderTicksPerRevolution);
  let source=applyGyroTelemetry(apply2wdRuntimeProtocol(firmwareSource(config),config),config);
  // Invert the electrical output, not ROS velocity/kinematics or PID targets.
  source=source.replace('static_cast<int>(requested_pwm)', 'static_cast<int>(requested_pwm * kMotorDirection[index])');
  const assignmentComments=motors.map((motor,index)=>`// M${index+1}: ${motor.name} | motor_invert=${motor.motorInvert?'on':'off'} | encoder=${motor.encoderEnabled?'on':'off'} | role=${motor.encoderRole} | ${motor.ppr} PPR x1 (A RISING, B direction) | signal_channels=${motor.channels} | invert=${motor.invert===-1?'on':'off'}`).join('\n');
  source=source.replace(`// Motor driver: ${config.motorDriver}`,`// Motor driver: ${config.motorDriver}\n${assignmentComments}`);
  source=source.replace('constexpr float kEncoderTicksPerRevolution = 600.0f;','// Per-wheel encoder PPR and decode multiplier are declared below.');
  source=source.replace('constexpr MotorPins kMotorPins[kMotorCount] =\n{',`constexpr int8_t kMotorDirection[kMotorCount] = {${motors.map(motor=>motor.motorInvert?-1:1).join(', ')}};  // electrical output only; encoder sign is calibrated separately\nconstexpr bool kPidControlEnabled = ${config.pidControl!==false};\nconstexpr bool kEncoderEnabled[kMotorCount] = {${enabled.join(', ')}};\nconstexpr uint8_t kEncoderRole[kMotorCount] = {${roles.join(', ')}};  // 1=X/Yaw odom, 2=Y, 3=X/Y, 4=PID only\nconstexpr uint8_t kEncoderDecodeMultiplier = 1;  // channel A RISING only\nconstexpr float kEncoderPpr[kMotorCount] = {${ticks.map(value=>value.toFixed(1)+'f').join(', ')}};\n\nconstexpr MotorPins kMotorPins[kMotorCount] =\n{`);
  source=source.replace('  const float ticks_to_rpm = 60.0f / (kEncoderTicksPerRevolution * dt);\n  for (uint8_t i = 0; i < kMotorCount; ++i)', '  for (uint8_t i = 0; i < kMotorCount; ++i)');
  source=source.replace('    motors[i].measured_rpm = static_cast<float>(delta) * ticks_to_rpm;',`    const float ticks_per_revolution = kEncoderPpr[i] * static_cast<float>(kEncoderDecodeMultiplier);\n    motors[i].measured_rpm = kEncoderEnabled[i]\n      ? static_cast<float>(delta) * (60.0f / (ticks_per_revolution * dt))\n      : motors[i].target_rpm;`);
  source=source.replace('float rpmToRadPerSec(const float rpm)\n{\n  return rpm * (2.0f * PI) / 60.0f;\n}',`float rpmToRadPerSec(const float rpm)\n{\n  return rpm * (2.0f * PI) / 60.0f;\n}\n\nfloat odomRpmX(const uint8_t index)\n{\n  return (kEncoderEnabled[index] && (kEncoderRole[index] == 1 || kEncoderRole[index] == 3)) ? motors[index].measured_rpm : 0.0f;\n}\n\nfloat odomRpmY(const uint8_t index)\n{\n  return (kEncoderEnabled[index] && (kEncoderRole[index] == 2 || kEncoderRole[index] == 3)) ? motors[index].measured_rpm : 0.0f;\n}\n\nfloat odomRpmAny(const uint8_t index)\n{\n  return (kEncoderEnabled[index] && kEncoderRole[index] >= 1 && kEncoderRole[index] <= 3) ? motors[index].measured_rpm : 0.0f;\n}`);
  const start=source.indexOf('// Encoder odometry (forward kinematics)'),end=source.indexOf('// Serial protocol from the ROS 2 bridge');
  if(start>=0&&end>start){let section=source.slice(start,end);if(config.drive==='mecanum4')section=section.replace(/  const float w_fl =[\s\S]*?  velocity_yaw = [^;]+;/,`  const float x_fl = rpmToRadPerSec(odomRpmX(0));\n  const float x_fr = rpmToRadPerSec(odomRpmX(1));\n  const float x_rl = rpmToRadPerSec(odomRpmX(2));\n  const float x_rr = rpmToRadPerSec(odomRpmX(3));\n  const float y_fl = rpmToRadPerSec(odomRpmY(0));\n  const float y_fr = rpmToRadPerSec(odomRpmY(1));\n  const float y_rl = rpmToRadPerSec(odomRpmY(2));\n  const float y_rr = rpmToRadPerSec(odomRpmY(3));\n  const float a_fl = rpmToRadPerSec(odomRpmAny(0));\n  const float a_fr = rpmToRadPerSec(odomRpmAny(1));\n  const float a_rl = rpmToRadPerSec(odomRpmAny(2));\n  const float a_rr = rpmToRadPerSec(odomRpmAny(3));\n  const float arm = kHalfWheelBaseM + kHalfTrackWidthM;\n\n  velocity_x = kWheelRadiusM * (x_fl + x_fr + x_rl + x_rr) * 0.25f;\n  velocity_y = kWheelRadiusM * (-y_fl + y_fr + y_rl - y_rr) * 0.25f;\n  velocity_yaw = kWheelRadiusM * (-a_fl + a_fr - a_rl + a_rr) / (4.0f * arm);`);else section=section.replace(/motors\[(\d+)\]\.measured_rpm/g,'odomRpmX($1)');source=source.slice(0,start)+section+source.slice(end);}
  source=source.replace('    pinMode(kMotorPins[i].encoder_a, INPUT_PULLUP);\n    pinMode(kMotorPins[i].encoder_b, INPUT_PULLUP);\n    attachInterrupt(digitalPinToInterrupt(kMotorPins[i].encoder_a),\n                    kEncoderIsr[i],\n                    RISING);',`    if (kEncoderEnabled[i])\n    {\n      pinMode(kMotorPins[i].encoder_a, INPUT_PULLUP);\n      pinMode(kMotorPins[i].encoder_b, INPUT_PULLUP);\n      attachInterrupt(digitalPinToInterrupt(kMotorPins[i].encoder_a),\n                      kEncoderIsr[i],\n                      RISING);\n    }`);
  source=source.replace('    setMotor(i, calculateVelocityPid(i, motors[i], dt));',`    const float output = (kPidControlEnabled && kEncoderEnabled[i])\n      ? calculateVelocityPid(i, motors[i], dt)\n      : (target_rpm[i] / kMotorMaxRpm) * 255.0f;\n    setMotor(i, applyMotorSlew(motors[i], output));`);
  source=source.replace('  float previous_error = 0.0f;\n};','  float previous_error = 0.0f;\n  float filtered_derivative = 0.0f;\n  float output_pwm = 0.0f;\n};');
  source=source.replace(`float calculateVelocityPid(const uint8_t index, MotorState &motor, const float dt)
{
  const float error = motor.target_rpm - motor.measured_rpm;
  motor.integral = constrain(motor.integral + (error * dt), -250.0f, 250.0f);
  const float derivative = (error - motor.previous_error) / dt;
  motor.previous_error = error;
  return (velocity_kp[index] * error) + (velocity_ki[index] * motor.integral) +
         (velocity_kd[index] * derivative);
}`,`float calculateVelocityPid(const uint8_t index, MotorState &motor, const float dt)
{
  if (fabs(motor.target_rpm) < 0.5f)
  {
    motor.integral = 0.0f;
    motor.previous_error = 0.0f;
    motor.filtered_derivative = 0.0f;
    return 0.0f;
  }
  const float error = motor.target_rpm - motor.measured_rpm;
  const float raw_derivative = (error - motor.previous_error) / max(dt, 0.001f);
  motor.filtered_derivative += 0.15f * (raw_derivative - motor.filtered_derivative);
  motor.previous_error = error;
  const float integral_limit = velocity_ki[index] > 0.0001f ? 80.0f / velocity_ki[index] : 0.0f;
  motor.integral = velocity_ki[index] > 0.0001f
    ? constrain(motor.integral + (error * dt), -integral_limit, integral_limit)
    : 0.0f;
  const float feedforward_pwm = (motor.target_rpm / kMotorMaxRpm) * 255.0f;
  return feedforward_pwm + (velocity_kp[index] * error) +
         (velocity_ki[index] * motor.integral) +
         (velocity_kd[index] * motor.filtered_derivative);
}

float applyMotorSlew(MotorState &motor, const float requested_pwm)
{
  constexpr float kMaximumPwmStep = 12.0f;
  const float desired = constrain(requested_pwm, -255.0f, 255.0f);
  motor.output_pwm += constrain(desired - motor.output_pwm, -kMaximumPwmStep, kMaximumPwmStep);
  if (fabs(motor.output_pwm) < 0.5f) motor.output_pwm = 0.0f;
  return motor.output_pwm;
}`);
  source=source.replace(`    const float ticks_per_revolution = kEncoderPpr[i] * static_cast<float>(kEncoderDecodeMultiplier);
    motors[i].measured_rpm = kEncoderEnabled[i]
      ? static_cast<float>(delta) * (60.0f / (ticks_per_revolution * dt))
      : motors[i].target_rpm;`,`    const float ticks_per_revolution = kEncoderPpr[i] * static_cast<float>(kEncoderDecodeMultiplier);
    const float raw_rpm = static_cast<float>(delta) * (60.0f / (ticks_per_revolution * dt));
    if (kEncoderEnabled[i])
    {
      constexpr float kRpmFilterAlpha = 0.22f;
      motors[i].measured_rpm += kRpmFilterAlpha * (raw_rpm - motors[i].measured_rpm);
    }
    else motors[i].measured_rpm = motors[i].target_rpm;`);
  source=source.replace('    motors[i].target_rpm = 0.0f;\n    setMotor(i, 0.0f);','    motors[i].target_rpm = 0.0f;\n    motors[i].output_pwm = 0.0f;\n    setMotor(i, 0.0f);');
  source=source.replace('void setup()\n{',`void publishWheelEncoderDiagnostics()
{
  static uint32_t previous_ms=0;
  const uint32_t now=millis();
  if(now-previous_ms<100)return;
  previous_ms=now;
  int32_t ticks[kMotorCount];
  noInterrupts();for(uint8_t i=0;i<kMotorCount;++i)ticks[i]=encoder_ticks[i];interrupts();
  uint32_t mask=0;
  Serial.print("WENC");
  for(uint8_t i=0;i<kMotorCount;++i){
    if(kEncoderEnabled[i])mask|=1u<<i;
    Serial.print(' ');Serial.print(ticks[i]);Serial.print(' ');
    Serial.print(kEncoderEnabled[i]?motors[i].measured_rpm:0.0f,1);
  }
  Serial.print(' ');Serial.println(mask);
}

void setup()\n{`);
  source=source.replace('  updateOdometry(dt);','  updateOdometry(dt);\n  publishWheelEncoderDiagnostics();');
  if(config.controller==='stm32f103'){
    source=source.replace('#include <Arduino.h>','#include <Arduino.h>\n\n// USART1 serial bridge: PA9 = TX, PA10 = RX. These pins are reserved.\n// STM32 core 3.x renamed the concrete HardwareSerial implementation to Uart.\n#if defined(STM32_CORE_VERSION_MAJOR) && STM32_CORE_VERSION_MAJOR >= 3\nUart SerialBridge(PA10, PA9);\n#else\nHardwareSerial SerialBridge(PA10, PA9);\n#endif');
    source=source.replace(/\bSerial\b/g,'SerialBridge');
  }
  return source;
}

function controllerBridgePython(){return `#!/usr/bin/env python3
import math
import threading
import time

import rclpy
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import Odometry
from rcl_interfaces.msg import SetParametersResult
from rclpy.node import Node
from std_msgs.msg import Float32MultiArray
from std_srvs.srv import Trigger
from tf2_ros import TransformBroadcaster

try:
    import serial
except ImportError:
    serial = None


class ControllerBridge(Node):
    def __init__(self):
        super().__init__('controller_bridge')
        self.declare_parameter('serial_port', '/dev/ttyUSB0')
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('base_frame', 'base_link')
        self.declare_parameter('odom_frame', 'odom')
        self.declare_parameter('publish_tf', True)
        self.declare_parameter('pid_control_enabled', True)
        self.declare_parameter('left_kp', 0.5)
        self.declare_parameter('left_ki', 0.0)
        self.declare_parameter('left_kd', 0.0)
        self.declare_parameter('right_kp', 0.5)
        self.declare_parameter('right_ki', 0.0)
        self.declare_parameter('right_kd', 0.0)
        self.declare_parameter('max_rpm', 300.0)
        self._serial = None
        self._lock = threading.Lock()
        self._last_connect_attempt = 0.0
        self._odom_pub = self.create_publisher(Odometry, '/odom', 20)
        self._rpm_pub = self.create_publisher(Float32MultiArray, '/controller/wheel_rpm', 20)
        self._tf = TransformBroadcaster(self)
        self.create_subscription(Twist, '/cmd_vel', self._cmd_vel, 20)
        self.create_subscription(Float32MultiArray, '/controller/tune_rpm', self._tune_rpm, 20)
        self.create_subscription(Float32MultiArray, '/controller/pid_gains', self._pid_topic, 10)
        self.create_service(Trigger, '/controller/reset_odometry', self._reset_odom)
        self.add_on_set_parameters_callback(self._parameters_changed)
        self.create_timer(0.01, self._poll_serial)

    def _connect(self):
        if self._serial is not None or serial is None:
            return
        now = time.monotonic()
        if now - self._last_connect_attempt < 2.0:
            return
        self._last_connect_attempt = now
        try:
            self._serial = serial.Serial(
                self.get_parameter('serial_port').value,
                int(self.get_parameter('baud_rate').value), timeout=0)
            self.get_logger().info('Controller serial connected')
            if self.get_parameter('pid_control_enabled').value:
                self._send_pid()
        except Exception as exc:
            self._serial = None
            self.get_logger().warning('Waiting for controller serial: %s' % exc)

    def _write(self, command):
        self._connect()
        if self._serial is None:
            return False
        try:
            with self._lock:
                self._serial.write((command + '\\n').encode('ascii'))
            return True
        except Exception as exc:
            self.get_logger().error('Serial write failed: %s' % exc)
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None
            return False

    def _cmd_vel(self, msg):
        self._write('V %.6f 0.0 %.6f' % (msg.linear.x, msg.angular.z))

    def _tune_rpm(self, msg):
        if len(msg.data) != 2:
            self.get_logger().warning('tune_rpm requires [left_rpm, right_rpm]')
            return
        limit = float(self.get_parameter('max_rpm').value)
        left = max(-limit, min(limit, float(msg.data[0])))
        right = max(-limit, min(limit, float(msg.data[1])))
        self._write('R %.4f %.4f' % (left, right))

    def _pid_topic(self, msg):
        if not self.get_parameter('pid_control_enabled').value:
            self.get_logger().warning('PID control is disabled in Hardware config')
            return
        if len(msg.data) not in (3, 6) or any(value < 0.0 for value in msg.data):
            self.get_logger().warning('pid_gains requires [kp,ki,kd] or six left/right gains')
            return
        values = list(msg.data) * 2 if len(msg.data) == 3 else list(msg.data)
        self._write('P ' + ' '.join('%.6f' % value for value in values))

    def _send_pid(self):
        if not self.get_parameter('pid_control_enabled').value:
            return
        names = ('left_kp', 'left_ki', 'left_kd', 'right_kp', 'right_ki', 'right_kd')
        self._write('P ' + ' '.join('%.6f' % self.get_parameter(name).value for name in names))

    def _parameters_changed(self, parameters):
        names = ('left_kp', 'left_ki', 'left_kd', 'right_kp', 'right_ki', 'right_kd')
        gains = {name: self.get_parameter(name).value for name in names}
        for parameter in parameters:
            if parameter.name in gains:
                if float(parameter.value) < 0.0:
                    return SetParametersResult(successful=False, reason='PID gains must be non-negative')
                gains[parameter.name] = float(parameter.value)
        if self.get_parameter('pid_control_enabled').value and any(parameter.name in gains for parameter in parameters):
            self._write('P ' + ' '.join('%.6f' % gains[name] for name in names))
        return SetParametersResult(successful=True)

    def _reset_odom(self, request, response):
        response.success = self._write('Z')
        response.message = 'reset command sent' if response.success else 'controller is disconnected'
        return response

    def _poll_serial(self):
        self._connect()
        if self._serial is None:
            return
        try:
            while self._serial.in_waiting:
                line = self._serial.readline().decode('ascii', errors='replace').strip()
                self._handle_line(line)
        except Exception as exc:
            self.get_logger().error('Serial read failed: %s' % exc)
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None

    def _handle_line(self, line):
        fields = line.split()
        try:
            if len(fields) == 7 and fields[0] == 'ODOM':
                self._publish_odom(*map(float, fields[1:]))
            elif len(fields) == 5 and fields[0] == 'RPM':
                msg = Float32MultiArray()
                msg.data = list(map(float, fields[1:]))
                self._rpm_pub.publish(msg)
        except ValueError:
            self.get_logger().warning('Invalid controller line: %s' % line)

    def _publish_odom(self, x, y, yaw, vx, vy, wz):
        now = self.get_clock().now().to_msg()
        qz, qw = math.sin(yaw * 0.5), math.cos(yaw * 0.5)
        msg = Odometry()
        msg.header.stamp = now
        msg.header.frame_id = self.get_parameter('odom_frame').value
        msg.child_frame_id = self.get_parameter('base_frame').value
        msg.pose.pose.position.x, msg.pose.pose.position.y = x, y
        msg.pose.pose.orientation.z, msg.pose.pose.orientation.w = qz, qw
        msg.twist.twist.linear.x, msg.twist.twist.linear.y = vx, vy
        msg.twist.twist.angular.z = wz
        self._odom_pub.publish(msg)
        if self.get_parameter('publish_tf').value:
            transform = TransformStamped()
            transform.header, transform.child_frame_id = msg.header, msg.child_frame_id
            transform.transform.translation.x, transform.transform.translation.y = x, y
            transform.transform.rotation.z, transform.transform.rotation.w = qz, qw
            self._tf.sendTransform(transform)

    def destroy_node(self):
        self._write('S')
        if self._serial is not None:
            self._serial.close()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = ControllerBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
`;}

function controllerBridgeFiles(config){
  const pkg='roside_controller_bridge',left=config.pid?.left||config.pid,right=config.pid?.right||config.pid,yaml=`controller_bridge:\n  ros__parameters:\n    serial_port: "${String(config.serialPort).replace(/"/g,'')}"\n    baud_rate: ${config.baudRate}\n    base_frame: base_link\n    odom_frame: odom\n    publish_tf: true\n    pid_control_enabled: ${config.pidControl!==false}\n    left_kp: ${left.kp}\n    left_ki: ${left.ki}\n    left_kd: ${left.kd}\n    right_kp: ${right.kp}\n    right_ki: ${right.ki}\n    right_kd: ${right.kd}\n    max_rpm: ${config.motorMaxRpm}\n`;
  const packageXml=`<?xml version="1.0"?>\n<package format="3"><name>${pkg}</name><version>0.1.0</version><description>ROS 2 Python custom serial bridge for the ROSIDE 2WD controller.</description><maintainer email="robot@localhost">ROSIDE</maintainer><license>Apache-2.0</license><buildtool_depend>ament_python</buildtool_depend><exec_depend>ament_index_python</exec_depend><exec_depend>rclpy</exec_depend><exec_depend>rcl_interfaces</exec_depend><exec_depend>geometry_msgs</exec_depend><exec_depend>nav_msgs</exec_depend><exec_depend>std_msgs</exec_depend><exec_depend>std_srvs</exec_depend><exec_depend>tf2_ros</exec_depend><exec_depend>python3-serial</exec_depend><exec_depend>launch</exec_depend><exec_depend>launch_ros</exec_depend><export><build_type>ament_python</build_type></export></package>\n`;
  const setupPy=`from setuptools import find_packages, setup\n\npackage_name = '${pkg}'\nsetup(name=package_name, version='0.1.0', packages=find_packages(), data_files=[('share/ament_index/resource_index/packages', ['resource/' + package_name]), ('share/' + package_name, ['package.xml']), ('share/' + package_name + '/launch', ['launch/controller_bridge.launch.py']), ('share/' + package_name + '/config', ['config/controller.yaml'])], install_requires=['setuptools', 'pyserial'], zip_safe=True, maintainer='ROSIDE', maintainer_email='robot@localhost', description='ROS 2 custom serial controller bridge', license='Apache-2.0', entry_points={'console_scripts': ['controller_bridge = roside_controller_bridge.controller_bridge:main']})\n`;
  const launchPy=`from ament_index_python.packages import get_package_share_directory\nfrom launch import LaunchDescription\nfrom launch_ros.actions import Node\nimport os\n\ndef generate_launch_description():\n    config = os.path.join(get_package_share_directory('${pkg}'), 'config', 'controller.yaml')\n    return LaunchDescription([Node(package='${pkg}', executable='controller_bridge', name='controller_bridge', output='screen', parameters=[config])])\n`;
  const bridgeReadme=`# ROSIDE 2WD Controller Bridge\n\nPython custom serial bridge. It subscribes to /cmd_vel, publishes /odom and /controller/wheel_rpm, and supports per-wheel runtime PID/RPM tuning.\n\nBuild: colcon build --symlink-install --packages-select ${pkg}\nRun: ros2 launch ${pkg} controller_bridge.launch.py\nPID: ros2 param set /controller_bridge left_kp 1.0\nTune all gains: ros2 topic pub --once /controller/pid_gains std_msgs/msg/Float32MultiArray "{data: [1.0, 5.0, 0.0, 1.1, 5.2, 0.0]}"\nTune wheels: ros2 topic pub --once /controller/tune_rpm std_msgs/msg/Float32MultiArray "{data: [30.0, 30.0]}"\n`;
  return{'package.xml':packageXml,'setup.py':setupPy,'setup.cfg':'[develop]\nscript_dir=$base/lib/roside_controller_bridge\n[install]\ninstall_scripts=$base/lib/roside_controller_bridge\n','resource/roside_controller_bridge':'','roside_controller_bridge/__init__.py':'','roside_controller_bridge/controller_bridge.py':config.robotDesign?.hardwareTemplate==='mecanum_xy'?MecanumXY.bridge(controllerBridgePython()):controllerBridgePython(),'launch/controller_bridge.launch.py':launchPy,'config/controller.yaml':config.robotDesign?.hardwareTemplate==='mecanum_xy'?yaml.replace(/^    (?:left|right)_(?:kp|ki|kd):.*\n/gm,''):yaml,'README.md':config.robotDesign?.hardwareTemplate==='mecanum_xy'?MecanumXY.readme:bridgeReadme};
}

function readmeWithAssignments(config){
  if(config.robotDesign?.hardwareTemplate==='mecanum_xy'){
    const roles=['front_left','front_right','rear_left','rear_right'];
    const odomPins=MecanumXY.odomPins(config.odomSwapXY===true);
    const modes=roles.map((role,index)=>{
      const wheel=config.assignments.find(item=>item.motorRole===role);
      const encoder=config.encoderAssignments.find(item=>item.attachedWheel===wheel?.name);
      return `- ${['FL','FR','RL','RR'][index]}: ${encoder?.enabled?'Speed PID + encoder':'feed-forward (encoder disabled)'}`;
    }).join('\n');
    return MecanumXY.readme+`\nGenerated ODOM X/Y pin mapping${config.odomSwapXY?' (swapped)':''}:\n- X: A ${odomPins.x[0]}, B ${odomPins.x[1]}\n- Y: A ${odomPins.y[0]}, B ${odomPins.y[1]}\n\nGenerated motor speed modes:\n`+modes+'\n';
  }
  const modelEncoderWheels=new Set(config.encoderAssignments.map(item=>item.attachedWheel).filter(Boolean));
  const motors=config.assignments.map(item=>`- ${item.name}: Motor=${item.motorEnabled?MOTOR_ROLES[item.motorRole]||item.motorRole:'ไม่ใช้'} · motor_invert=${item.motorInvert?'on':'off'}${!modelEncoderWheels.has(item.name)&&item.encoderEnabled?` · Encoder ท้ายมอเตอร์=${item.ppr} PPR ×${item.channels} (${ENCODER_ROLES[item.encoderRole]||item.encoderRole}, invert=${item.invert===-1?'on':'off'})`:''}`).join('\n');
  const encoders=config.encoderAssignments.map(item=>`- ${item.name}: ${item.enabled?ENCODER_ROLES[item.role]||item.role:'ไม่ใช้'} · ติดกับ ${item.attachedWheel||'Encoder อิสระ'} (${item.ppr} PPR ×${item.channels}, invert=${item.invert===-1?'on':'off'})`).join('\n')||'- ไม่พบ Encoder ใน Robot Model';
  const assignments=`### Motors\n\n${motors}\n\n### Encoders\n\n${encoders}`.replace(/PPR ×\d+/g,'PPR ×1 decoded (A RISING; B direction)');
  const protocol=`## Encoder and runtime tuning\n\n- Control mode: ${config.pidControl!==false?'closed-loop PID':'open-loop direct speed/PWM'}.\n- Enabled odometry encoders always feed X/Yaw odometry, including when PID is disabled.\n- Decode mode: ×1, interrupt on encoder A RISING; encoder B determines direction.\n- Effective ticks/revolution: configured PPR × 1. The Channels field is wiring metadata and does not multiply ticks.\n- Shared PID: \`P <kp> <ki> <kd>\`\n- Per-wheel PID: \`P <left_kp> <left_ki> <left_kd> <right_kp> <right_ki> <right_kd>\`\n- Direct wheel test: \`R <left_rpm> <right_rpm>\`\n- Stop: \`S\`\n- Wheel telemetry: \`RPM target_left measured_left target_right measured_right\`\n- Serial: ${config.serialPort} at ${config.baudRate} baud\n${config.controller==='stm32f103'?'- MCU UART: USART1 PA9 (TX) / PA10 (RX); both pins are reserved for the serial bridge\n':''}- Command timeout: ${config.commandTimeoutMs} ms\n`;
  return readme(config).replace(`- Motors: ${config.motorCount}`,`- Motors: ${config.motorCount}\n- Encoders: ${config.encoderCount}`).replace(`- Encoder resolution: ${config.encoderTicksPerRevolution} ticks/revolution`,`## Motor / Encoder assignments\n\n${assignments}`).replace('Firmware stops all motors after 300 ms without a valid command.',`Firmware stops all motors after ${config.commandTimeoutMs} ms without a valid command.`)+`\n${protocol}`;
}

function previewHardwareFiles(){const config=currentConfig(),bridge=controllerBridgeFiles(config);return{'main.cpp':firmwareSourceWithAssignments(config),'platformio.ini':platformioSource(config).replace('monitor_speed = 115200',`monitor_speed = ${config.baudRate}`),'controller_bridge.py':bridge['roside_controller_bridge/controller_bridge.py'],'controller.yaml':bridge['config/controller.yaml'],'README.md':readmeWithAssignments(config)+'\n'+bridge['README.md']};}
function refreshCodePreview(){if(!robotDesign)return;const files=previewHardwareFiles();$('code-view').textContent=files[activeCodeFile]||'';if($('code-file-label'))$('code-file-label').textContent=activeCodeFile;document.querySelectorAll('.code-tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.codeFile===activeCodeFile));}
function setBuildStep(name,state){const step=document.querySelector(`[data-build-step="${name}"]`);if(!step)return;step.classList.remove('active','done','error');if(state)step.classList.add(state);const icon=step.querySelector('i');if(icon)icon.textContent=state==='done'?'✓':state==='error'?'!':({files:'1',toolchain:'2',compile:'3',debug:'4'}[name]||'•');}
function resetBuildProgress(){for(const name of ['files','toolchain','compile','debug','upload'])setBuildStep(name,'');}
function validSerialPort(value){return /^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|serial\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/.test(String(value));}
function updateUploadAvailability(){const button=$('upload-button');if(button)button.disabled=platformioBusy||!validSerialPort($('upload-port')?.value);}
function setPlatformioBusy(busy){platformioBusy=busy;$('compile-button').disabled=busy;$('refresh-ports').disabled=busy;updateUploadAvailability();}
async function discoverSerialPorts(){
  const primary=await api('/api/serial/ports',{sessionId}).catch(error=>({ok:false,error:error.message}));
  if(primary.ok&&Array.isArray(primary.ports)){if(primary.uartHint)primary.ports.uartHint=primary.uartHint;return primary.ports;}
  const command="for port in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyTHS* /dev/ttyS* /dev/serial[0-9]* /dev/rfcomm*; do [ -c \"$port\" ] || continue; if [ -r \"$port\" ] && [ -w \"$port\" ]; then access=1; else access=0; fi; printf '%s\\t%s\\n' \"$port\" \"$access\"; done; true";
  const fallback=await api('/api/exec',{sessionId,command,timeout:10000});
  if(!fallback.ok)throw new Error(primary.error||fallback.error||'ค้นหา COM port ไม่สำเร็จ');
  return String(fallback.stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{const [path,access]=line.split('\t');return{path,label:path.split('/').pop(),connected:true,accessible:access==='1'};}).filter(item=>validSerialPort(item.path));
}
async function refreshSerialPorts(){
  const select=$('upload-port'),refresh=$('refresh-ports'),previous=select.value;refresh.disabled=true;select.disabled=true;
  select.innerHTML='<option value="">กำลังค้นหา COM port…</option>';updateUploadAvailability();
  try{
    const discovered=await discoverSerialPorts(),ports=discovered.filter(item=>validSerialPort(item.path));
    const bridgeList=$('bridge-serial-port-list');if(bridgeList)bridgeList.innerHTML=ports.map(item=>`<option value="${esc(item.path)}">${esc(item.label||item.path)} · ${item.accessible?'พร้อมใช้':'ไม่มีสิทธิ์'}</option>`).join('');
    select.innerHTML='';const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=ports.length?`เลือก COM port (${ports.length} พอร์ต)`:'ไม่พบ COM port · กรุณาเสียบบอร์ด';select.append(placeholder);
    for(const item of ports){const option=document.createElement('option');option.value=item.path;option.textContent=`${item.path} · ${item.label||item.path} · ${item.accessible?'พร้อมใช้':'ไม่มีสิทธิ์'}`;select.append(option);}
    const preferred=previous||$('bridge-serial-port')?.value;const selected=ports.find(item=>item.path===preferred||item.stablePath===preferred||item.aliases?.includes(preferred));if(selected)select.value=selected.path;
    $('compile-status').textContent=ports.length?`พบ COM port ${ports.length} พอร์ต: ${ports.map(item=>item.path).join(', ')}`:'ไม่พบ USB/UART COM port บนเครื่อง Robot';
    if(selected)$('compile-status').textContent+=' · พร้อมกด Upload Firmware';
    if(discovered.uartHint)$('compile-status').textContent+=' · '+discovered.uartHint;
  }catch(error){select.innerHTML='<option value="">ค้นหา COM port ไม่สำเร็จ</option>';$('compile-status').textContent=`✕ ${error.message}`;}
  finally{select.disabled=false;refresh.disabled=platformioBusy;updateUploadAvailability();}
}
function openCodeModal(mode='preview'){if(!robotDesign)return;const guide=$('stm32-upload-guide');if(guide)guide.hidden=$('controller-board').value!=='stm32f103';activeCodeFile='main.cpp';$('compile-output').textContent='';$('compile-output').className='compile-output';resetBuildProgress();if(mode==='generated'){setBuildStep('files','done');$('compile-status').textContent='✓ สร้างไฟล์แล้ว · พร้อม Build & Debug';}else $('compile-status').textContent='พร้อม Build & Debug';refreshCodePreview();$('code-modal').hidden=false;document.body.style.overflow='hidden';refreshSerialPorts().then(()=>$('upload-port')?.focus());}
function closeCodeModal(){$('code-modal').hidden=true;document.body.style.overflow='';$('generate-button')?.focus();}
async function copyCurrentCode(){try{await navigator.clipboard.writeText($('code-view').textContent);$('compile-status').textContent=`คัดลอก ${activeCodeFile} แล้ว`;}catch(_){$('compile-status').textContent='คัดลอกไม่สำเร็จ กรุณาเลือกข้อความด้วยตนเอง';}}
function shellPath(value){const path=String(value);if(path.startsWith('~/'))return `"$HOME"/'${path.slice(2).replace(/'/g,"'\\''")}'`;return `'${path.replace(/'/g,"'\\''")}'`;}
function debugSummary(log){const errors=(log.match(/(?:\[ROSIDE ERROR\]|\berror(?:\s*:|\[)|\b[A-Za-z]+Error\s*:|\bFAILED\b)/gi)||[]).length,warnings=(log.match(/\bwarning\s*:/gi)||[]).length,ram=log.match(/RAM:\s*\[[^\n]+/i)?.[0],flash=log.match(/Flash:\s*\[[^\n]+/i)?.[0];return[`Debug summary: ${errors} error(s), ${warnings} warning(s)`,ram,flash].filter(Boolean).join('\n');}
function cleanTerminalOutput(value){return String(value).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g,'').replace(/\r/g,'');}
function updatePlatformioLiveStatus(chunk){
  const text=cleanTerminalOutput(chunk),status=$('compile-status');
  if(/Preflight: checking build requirements/i.test(text)){setBuildStep('toolchain','active');status.textContent='2/4 · กำลังตรวจ Python, venv และ PlatformIO บนเครื่องหุ่นยนต์';}
  if(/Installing missing Python venv support/i.test(text)){setBuildStep('toolchain','active');status.textContent='2/4 · กำลังติดตั้ง python3-venv บนเครื่องหุ่นยนต์';}
  if(/\[ROSIDE ERROR\]/i.test(text)){setBuildStep('toolchain','error');status.textContent='✕ เครื่องหุ่นยนต์ยังขาดเครื่องมือสำหรับ Build';}
  if(/Installing|Downloading|Unpacking|Platform Manager|Tool Manager/i.test(text)){setBuildStep('toolchain','active');status.textContent='2/4 · PlatformIO กำลังดาวน์โหลด/ติดตั้ง Toolchain';}
  if(/Library Manager|Resolving dependencies|Installing dependencies/i.test(text)){setBuildStep('toolchain','active');status.textContent='2/4 · PlatformIO กำลังตรวจ Library dependencies';}
  if(/PlatformIO Core, version/i.test(text)){setBuildStep('toolchain','done');setBuildStep('compile','active');status.textContent='3/4 · PlatformIO พร้อม · กำลังเริ่ม Compile';}
  if(/Compiling\s|Building\s|Generating/i.test(text)){setBuildStep('toolchain','done');setBuildStep('compile','active');status.textContent='3/4 · กำลัง Compile source code';}
  if(/Linking\s|Archiving\s|Indexing\s/i.test(text)){setBuildStep('compile','active');status.textContent='3/4 · กำลัง Linking firmware';}
  if(/Checking size|Advanced Memory Usage|RAM:|Flash:/i.test(text)){setBuildStep('compile','done');setBuildStep('debug','active');status.textContent='4/4 · กำลังตรวจ RAM และ Flash';}
  if(/FAILED|[A-Za-z]+Error\s*:|fatal error:/i.test(text)){setBuildStep('compile','error');setBuildStep('debug','error');status.textContent=/HTTPClientError/i.test(text)?'✕ PlatformIO เชื่อมต่อ Library Registry ไม่สำเร็จ':'✕ PlatformIO พบข้อผิดพลาด';}
}
function platformioTaskScript(base,uploadPort,marker){
  const pioCommand=uploadPort?`"$PIO_BIN" run --target upload --upload-port ${shellPath(uploadPort)}`:`"$PIO_BIN" run`;
  const serialPreflight=uploadPort?`UPLOAD_PORT=${shellPath(uploadPort)}
if command -v stty >/dev/null 2>&1; then
  stty -F "$UPLOAD_PORT" -hupcl 2>/dev/null || true
  echo "[ROSIDE] Serial auto-reset prepared on $UPLOAD_PORT (HUPCL disabled)"
fi
`:'';
  return `#!/usr/bin/env bash
set -o pipefail
TOOL_DIR="$HOME/.roside/tools"
INSTALLER="$TOOL_DIR/get-platformio.py"
PIO_BIN=''
mkdir -p "$TOOL_DIR"
finish_roside_task() { TASK_CODE=$?; printf '\n${marker}%s\n' "$TASK_CODE"; }
trap finish_roside_task EXIT
fail() { echo "[ROSIDE ERROR] $*" >&2; exit 1; }
find_platformio() {
  if [ -x "$TOOL_DIR/platformio-penv/bin/platformio" ]; then PIO_BIN="$TOOL_DIR/platformio-penv/bin/platformio"
  elif [ -x "$HOME/.platformio/penv/bin/platformio" ]; then PIO_BIN="$HOME/.platformio/penv/bin/platformio"
  elif command -v platformio >/dev/null 2>&1; then PIO_BIN="$(command -v platformio)"
  elif command -v pio >/dev/null 2>&1; then PIO_BIN="$(command -v pio)"
  else PIO_BIN=''; fi
}
check_python_venv() {
  PROBE_DIR="$TOOL_DIR/.venv-preflight-$$"; VENV_LOG="$TOOL_DIR/venv-preflight.log"
  rm -rf "$PROBE_DIR"
  if python3 -m venv "$PROBE_DIR" >"$VENV_LOG" 2>&1; then rm -rf "$PROBE_DIR"; return 0; fi
  rm -rf "$PROBE_DIR"; return 1
}
install_python_venv() {
  command -v apt-get >/dev/null 2>&1 || return 1
  PYTHON_VENV_PACKAGE="python$(python3 -c 'import sys; print(str(sys.version_info.major)+"."+str(sys.version_info.minor))')-venv"
  echo "[ROSIDE] Installing missing Python venv support (python3-venv / $PYTHON_VENV_PACKAGE)"
  if [ "$(id -u)" -eq 0 ]; then
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv || DEBIAN_FRONTEND=noninteractive apt-get install -y "$PYTHON_VENV_PACKAGE"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y "$PYTHON_VENV_PACKAGE"
  else
    echo '[ROSIDE] Passwordless sudo is unavailable; switching to a user-local PlatformIO environment'
    return 1
  fi
}
bootstrap_user_platformio() {
  VIRTUALENV_ZIPAPP="$TOOL_DIR/virtualenv.pyz"; USER_PIO_HOME="$TOOL_DIR/platformio-penv"
  echo '[ROSIDE] Installing user-local virtualenv (no sudo required)'
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL 'https://bootstrap.pypa.io/virtualenv.pyz' -o "$VIRTUALENV_ZIPAPP" || fail 'Cannot download the user-local virtualenv bootstrap.'
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$VIRTUALENV_ZIPAPP" 'https://bootstrap.pypa.io/virtualenv.pyz' || fail 'Cannot download the user-local virtualenv bootstrap.'
  else fail 'curl or wget is required to install a user-local PlatformIO environment.'; fi
  python3 "$VIRTUALENV_ZIPAPP" "$USER_PIO_HOME" || fail 'Cannot create the user-local PlatformIO virtual environment.'
  "$USER_PIO_HOME/bin/python" -m pip install --upgrade 'platformio>=6,<7' || fail 'Cannot install PlatformIO Core in the user-local environment.'
  PIO_BIN="$USER_PIO_HOME/bin/platformio"
  [ -x "$PIO_BIN" ] || fail 'The user-local PlatformIO installation did not create an executable.'
}
echo '[ROSIDE] Preflight: checking build requirements on the connected machine'
echo "[ROSIDE] OS: $(uname -srm)"
command -v python3 >/dev/null 2>&1 || fail 'python3 is required. Install python3 before building.'
echo "[ROSIDE] Python: $(python3 --version 2>&1)"
find_platformio
if [ -z "$PIO_BIN" ]; then
  if ! check_python_venv; then
    cat "$TOOL_DIR/venv-preflight.log" >&2
    if install_python_venv && check_python_venv; then echo '[ROSIDE] Python venv support is ready'; else bootstrap_user_platformio; fi
  fi
  if [ -z "$PIO_BIN" ]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL 'https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py' -o "$INSTALLER" || fail 'Cannot download the PlatformIO installer with curl.'
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$INSTALLER" 'https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py' || fail 'Cannot download the PlatformIO installer with wget.'
    else fail 'curl or wget is required to download PlatformIO Core.'; fi
    echo '[ROSIDE] Installing PlatformIO Core 6'
    python3 "$INSTALLER" || fail 'PlatformIO Core installation failed.'
    find_platformio
  fi
fi
[ -n "$PIO_BIN" ] || fail 'PlatformIO executable was not found after installation.'
"$PIO_BIN" --version || fail 'PlatformIO is installed but cannot run.'
[ -f ${shellPath(`${base}/platformio.ini`)} ] || fail 'platformio.ini is missing from the generated firmware project.'
[ -f ${shellPath(`${base}/src/main.cpp`)} ] || fail 'src/main.cpp is missing from the generated firmware project.'
if grep -Fq 'bno08x.initStage' ${shellPath(`${base}/src/main.cpp`)}; then
  BNO_HEADER=${shellPath(`${base}/lib/Adafruit BNO08x/src/Adafruit_BNO08x.h`)}
  [ -f "$BNO_HEADER" ] && grep -Fq 'initStage' "$BNO_HEADER" || fail 'Mecanum XY needs the patched BNO08x library. Update Local Agent, reload Hardware Wiring, then regenerate firmware.'
fi
echo '[ROSIDE] Preflight passed: firmware project is ready to build'
cd -- ${shellPath(base)} || fail 'Cannot enter the generated firmware directory.'
${serialPreflight}${uploadPort?"echo '[ROSIDE] ESP32 upload uses DTR/RTS auto-reset; no BOOT press is needed on compatible DevKit boards'\n":''}${pioCommand}
exit $?
`;
}
async function runPlatformioStream(base,onChunk,options={}){
  const uploadPort=String(options.uploadPort||''),isUpload=Boolean(uploadPort);if(isUpload&&!validSerialPort(uploadPort))throw new Error('COM port ไม่ถูกต้อง กรุณาเลือกใหม่');
  const task=isUpload?'UPLOAD':'BUILD',marker=isUpload?`ROSIDE_UPLOAD_DONE_${Date.now()}_`:`ROSIDE_BUILD_DONE_${Date.now()}_`,scriptPath=isUpload?`${base}/.roside-platformio-upload.sh`:`${base}/.roside-platformio-build.sh`,script=platformioTaskScript(base,uploadPort,marker);
  const written=await api('/api/files/write',{sessionId,path:scriptPath,content:script});if(!written.ok)throw new Error(written.error||`สร้าง PlatformIO ${task.toLowerCase()} script ไม่สำเร็จ`);
  return new Promise((resolve,reject)=>{
    const proto=location.protocol==='https:'?'wss:':'ws:',ws=new WebSocket(`${proto}//${location.host}/ws/terminal`,['ros2ide',TOKEN]),utf8Decoder=new TextDecoder();let log='',finished=false,inactivityTimer,overallTimer,buildStarted=false;
    const finish=(error,code)=>{if(finished)return;finished=true;clearTimeout(inactivityTimer);clearTimeout(overallTimer);try{ws.close();}catch{}if(error)reject(error);else resolve({ok:code===0,code,log});};
    const armInactivityTimer=()=>{clearTimeout(inactivityTimer);inactivityTimer=setTimeout(()=>finish(new Error(`PlatformIO ${isUpload?'Upload':'Build'} ไม่มี output นานเกิน 10 นาที`)),600000);};
    overallTimer=setTimeout(()=>finish(new Error(`PlatformIO ${isUpload?'Upload':'Build'} ใช้เวลาเกิน 45 นาที`)),2700000);
    ws.onopen=()=>ws.send(JSON.stringify({type:'init',sessionId,cols:180,rows:42}));
    ws.onmessage=event=>{let msg;try{msg=JSON.parse(event.data);}catch{return;}if(msg.type==='ready'){
      buildStarted=true;armInactivityTimer();ws.send(JSON.stringify({type:'data',data:`bash ${shellPath(scriptPath)} 2>&1\n`}));
    }else if(msg.type==='data'||msg.type==='pty_output'){
      let raw='';try{const binary=atob(msg.data),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));raw=utf8Decoder.decode(bytes,{stream:true});}catch{raw=msg.data||'';}const clean=cleanTerminalOutput(raw);if(!buildStarted)return;armInactivityTimer();log+=clean;const markerIndex=log.indexOf(marker);if(markerIndex>=0){const markerInChunk=clean.indexOf(marker);if(markerInChunk>0)onChunk(clean.slice(0,markerInChunk));const beforeMarker=log.slice(0,markerIndex),match=log.slice(markerIndex+marker.length).match(/^(\d+)/),code=match?Number(match[1]):1;log=beforeMarker;finish(null,code);return;}onChunk(clean);
    }else if(msg.type==='error')finish(new Error(msg.message||'เปิด PlatformIO terminal ไม่สำเร็จ'));else if(msg.type==='pty_closed'&&!finished)finish(new Error(`PlatformIO terminal ถูกปิดก่อน ${isUpload?'Upload':'Build'} เสร็จ`));
    };
    ws.onerror=()=>finish(new Error('เชื่อมต่อ PlatformIO terminal ไม่สำเร็จ'));
    ws.onclose=()=>{if(!finished)finish(new Error('PlatformIO terminal หลุดการเชื่อมต่อ'));};
  });
}

async function writeHardwareFiles(){
  const config=currentConfig(),root=String(workspace).replace(/\/$/,''),base=`${root}/src/roside_stm32_base/firmware`,bridgeBase=`${root}/src/roside_controller_bridge`,bridge=controllerBridgeFiles(config);
  const extraFirmware=isMecanumXY()?MecanumXY.libraryFiles():{};
  const directories=[...new Set(Object.keys(extraFirmware).map(file=>`${base}/${file.slice(0,file.lastIndexOf('/'))}`)),`${root}/.roside`,`${base}/src`,bridgeBase,`${bridgeBase}/resource`,`${bridgeBase}/roside_controller_bridge`,`${bridgeBase}/launch`,`${bridgeBase}/config`];
  for(const path of directories){const result=await api('/api/files/mkdir',{sessionId,path});if(!result.ok)throw new Error(result.error||'สร้างโฟลเดอร์ไม่สำเร็จ');}
  const files=[[`${root}/.roside/hardware.json`,JSON.stringify(config,null,2)+'\n'],[`${base}/platformio.ini`,platformioSource(config).replace('monitor_speed = 115200',`monitor_speed = ${config.baudRate}`)],[`${base}/src/main.cpp`,firmwareSourceWithAssignments(config)],[`${base}/README.md`,readmeWithAssignments(config)],...Object.entries(extraFirmware).map(([file,content])=>[`${base}/${file}`,content]),...Object.entries(bridge).map(([relativePath,content])=>[`${bridgeBase}/${relativePath}`,content])];
  for(const [path,content] of files){const result=await api('/api/files/write',{sessionId,path,content});if(!result.ok)throw new Error(result.error||`เขียน ${path} ไม่สำเร็จ`);}
  localStorage.setItem(storageKey(),JSON.stringify(config));return{config,base,bridgeBase};
}

async function writeHardwareBuildEvidence(base,state,config=null){
  const evidence=state==='compiled'
    ?{version:2,status:'compiled',capability:'serial_bridge',transport:'python_serial',package:'roside_controller_bridge',controller:config?.controller||'',board:config?.boardLabel||'',compiledAt:new Date().toISOString()}
    :{version:1,status:state,updatedAt:new Date().toISOString()};
  const result=await api('/api/files/write',{sessionId,path:`${base}/build_verified.json`,content:JSON.stringify(evidence,null,2)+'\n'});
  if(!result.ok)throw new Error(result.error||'บันทึกผล Compile สำหรับ ROS Wizzard ไม่สำเร็จ');
}

async function compileHardwareCode(){
  const output=$('compile-output'),status=$('compile-status');setPlatformioBusy(true);output.className='compile-output';output.textContent='[1/4] กำลังสร้าง Config และ Firmware ล่าสุด…';resetBuildProgress();setBuildStep('files','active');status.textContent='1/4 · กำลังสร้างไฟล์';
  const root=String(workspace).replace(/\/$/,''),evidenceBase=`${root}/src/roside_stm32_base/firmware`;
  try{
    const directoryResult=await api('/api/files/mkdir',{sessionId,path:evidenceBase});if(!directoryResult.ok)throw new Error(directoryResult.error||'เตรียมโฟลเดอร์ Build ไม่สำเร็จ');
    await writeHardwareBuildEvidence(evidenceBase,'building');
    const {base,config}=await writeHardwareFiles();setBuildStep('files','done');setBuildStep('toolchain','active');status.textContent='2/4 · กำลังเปิด PlatformIO Live Build';output.textContent+='\n[2/4] เชื่อมต่อ PlatformIO terminal…\n';
    const buildResult=await runPlatformioStream(base,chunk=>{output.textContent+=chunk;output.scrollTop=output.scrollHeight;updatePlatformioLiveStatus(chunk);}),buildLog=buildResult.log;setBuildStep('compile',buildResult.ok?'done':'error');setBuildStep('debug','active');status.textContent='4/4 · กำลังสรุป Debug result';
    const summary=debugSummary(buildLog);output.textContent+=`\n\n[4/4] ${summary}`;
    if(!buildResult.ok){const preflightFailed=/\[ROSIDE ERROR\]/i.test(buildLog);await writeHardwareBuildEvidence(base,'failed').catch(()=>{});if(preflightFailed){setBuildStep('toolchain','error');setBuildStep('compile','');status.textContent='✕ Preflight ไม่ผ่าน · ดูรายละเอียด ROSIDE ERROR แล้วกด Build ใหม่';}setBuildStep('debug','error');output.className='compile-output error';if(!preflightFailed)status.textContent='✕ Build ไม่ผ่าน · ดู Error ใน Debug output';return;}
    await writeHardwareBuildEvidence(base,'compiled',config);
    setBuildStep('debug','done');output.className='compile-output ok';status.textContent='✓ Build สำเร็จ · การ์ด Hardware เป็นสีเขียวแล้ว · ต้องกด Upload จึงจะมี Firmware ใหม่นี้บนบอร์ด';
  }catch(error){await writeHardwareBuildEvidence(evidenceBase,'failed').catch(()=>{});const active=document.querySelector('.build-step.active');if(active){active.classList.remove('active');active.classList.add('error');const icon=active.querySelector('i');if(icon)icon.textContent='!';}output.className='compile-output error';output.textContent+=`\n\n[ERROR] ${error.message}`;status.textContent='✕ Build & Debug ไม่สำเร็จ';}
  finally{setPlatformioBusy(false);}
}

async function uploadHardwareCode(){
  const port=$('upload-port').value,output=$('compile-output'),status=$('compile-status');if(!validSerialPort(port)){status.textContent='กรุณาเลือก COM port ก่อน Upload';updateUploadAvailability();return;}
  setPlatformioBusy(true);setBuildStep('upload','active');output.className='compile-output';output.textContent=`[5/5] กำลังตรวจสิทธิ์ ${port}…\n`;status.textContent=`5/5 · กำลังเตรียมสิทธิ์ COM port`;
  try{
    const prepared=await api('/api/serial/prepare',{sessionId,port});if(!prepared.ok)throw new Error(prepared.error||`เตรียมสิทธิ์ ${port} ไม่สำเร็จ`);
    output.textContent+=prepared.repaired?`[ROSIDE] แก้สิทธิ์ ${port} สำหรับ Agent และตั้งค่า udev ถาวรแล้ว\n`:`[ROSIDE] ${port} มีสิทธิ์อ่าน/เขียนพร้อมแล้ว\n`;
    output.textContent+=`[5/5] กำลัง Upload ไปยัง ${port}…\n`;status.textContent=`5/5 · PlatformIO กำลัง Upload ไปยัง ${port}`;
    const {base}=await writeHardwareFiles(),result=await runPlatformioStream(base,chunk=>{output.textContent+=chunk;output.scrollTop=output.scrollHeight;if(/Uploading|Writing|wrote|Verify|Resetting/i.test(chunk))status.textContent=`5/5 · กำลังเขียน Firmware ไปยัง ${port}`;if(/FAILED|[A-Za-z]+Error\s*:|fatal error:/i.test(chunk)){setBuildStep('upload','error');status.textContent='✕ Upload พบข้อผิดพลาด';}}, {uploadPort:port});
    if(!result.ok){
      const noBootResponse=/Failed to connect to ESP32|No serial data received|Wrong boot mode detected/i.test(result.log),stm32NoBoot=$('controller-board').value==='stm32f103'&&/Failed to init device|Cannot initialize device|No response from the target/i.test(result.log);
      setBuildStep('upload','error');output.className='compile-output error';
      output.textContent+=`\n\n[UPLOAD ERROR] PlatformIO จบการทำงานด้วย code ${result.code}`;
      if(noBootResponse)output.textContent+='\n[ESP32 AUTO-BOOT] เปิด COM port ได้แล้ว แต่บอร์ดไม่ตอบสนองโหมด Download — ตรวจว่าสาย USB ส่งข้อมูลได้ และบอร์ด/USB-UART มี DTR→GPIO0, RTS→EN (หรือวงจร Auto-reset)';
      if(stm32NoBoot)output.textContent+='\n[STM32 BOOT] บอร์ดยังไม่ตอบ Bootloader: ตั้ง BOOT0=1, BOOT1=0 แล้วกด Reset ก่อน Upload · ตรวจ USB–UART TX→PA10, RX→PA9 และ GND ร่วมกัน';
      status.textContent=stm32NoBoot?'✕ STM32 ยังไม่เข้า Bootloader · ตรวจ Jumper, Reset และสาย UART':noBootResponse?'✕ ESP32 ไม่เข้า Auto BOOT · ตรวจวงจร DTR/RTS และสาย USB':'✕ Upload ไม่สำเร็จ · ตรวจสาย, Boot mode และ COM port';return;
    }
    setBuildStep('upload','done');output.className='compile-output ok';output.textContent+='\n\n[UPLOAD SUCCESS] เขียน Firmware ลงบอร์ดสำเร็จ';if($('controller-board').value==='stm32f103')output.textContent+='\n[STM32] ตั้ง BOOT0 เป็น 0 แล้วกด Reset ก่อนเปิด Robot Tune';status.textContent=`✓ Upload สำเร็จ · ${port}${$('controller-board').value==='stm32f103'?' · ตั้ง BOOT0 = 0 แล้ว Reset':''}`;
  }catch(error){setBuildStep('upload','error');output.className='compile-output error';output.textContent+=`\n\n[UPLOAD ERROR] ${error.message}`;status.textContent='✕ Upload ไม่สำเร็จ';}
  finally{setPlatformioBusy(false);}
}

async function generateHardwareFiles(){
  const button=$('generate-button'),status=$('save-status');if(!robotDesign||!sessionId)return;
  button.disabled=true;status.className='status';status.textContent='กำลังสร้าง Hardware config, firmware และ Python Serial Bridge…';
  try{
    await writeHardwareFiles();status.className='status ok';status.textContent='✓ สร้าง config + firmware + roside_controller_bridge แล้ว';openCodeModal('generated');
  }catch(error){status.className='status error';status.textContent='สร้างไฟล์ไม่สำเร็จ: '+error.message;if(isMecanumXY()){const card=$('hardware-assignments')?.closest('details');if(card){card.open=true;card.scrollIntoView({block:'nearest',behavior:'smooth'});}}}
  finally{button.disabled=!hardwareSupported();}
}

function showLoadError(error){
  $('source-badge').textContent='Robot Config ยังไม่พร้อม';$('wiring-board').innerHTML=`<div class="loading"><div class="error-box"><b>เปิด Wiring Diagram ไม่ได้</b><p>${esc(error.message)}</p><button type="button" onclick="returnToWorkspace()">กลับไปออกแบบ Robot Model →</button></div></div>`;$('save-status').className='status error';$('save-status').textContent=error.message;
}

async function init(){
  try{
    await restoreRobotSession();
    const [model,odom]=await Promise.all([readWorkspaceJson('src/sim_robot_tf/tf_model.json'),readWorkspaceJson('src/sim_robot_odom/odom_config.json')]);
    robotDesign=deriveRobotDesign(model,odom);await restoreWorkspaceHardwareOptions();applySavedOptions();updateMultiCombos();renderSummary();renderAssignments();renderDiagram();$('generate-button').disabled=!hardwareSupported();
    const rerender=()=>{renderDiagram();if(!$('code-modal').hidden)refreshCodePreview();};$('controller-board').addEventListener('change',rerender);$('motor-driver').addEventListener('change',rerender);$('pid-control-enabled').addEventListener('change',()=>{updatePidControlFields();rerender();});$('upload-port').addEventListener('change',updateUploadAvailability);for(const id of ['bridge-serial-port','bridge-baud-rate','command-timeout-ms','motor-max-rpm','pid-kp','pid-ki','pid-kd'])$(id)?.addEventListener('change',()=>{if(id.startsWith('pid-'))tunedWheelPid=null;if(!$('code-modal').hidden)refreshCodePreview();});document.querySelectorAll('.device-option input').forEach(input=>input.addEventListener('change',()=>{updateMultiCombos();rerender();}));document.querySelectorAll('.code-tab').forEach(tab=>tab.addEventListener('click',()=>{activeCodeFile=tab.dataset.codeFile;refreshCodePreview();}));document.querySelectorAll('.multi-combo').forEach(combo=>combo.addEventListener('toggle',()=>{if(combo.open)document.querySelectorAll('.multi-combo[open]').forEach(other=>{if(other!==combo)other.open=false;});}));document.querySelectorAll('.sidebar-card').forEach(card=>card.addEventListener('toggle',()=>{if(card.open)document.querySelectorAll('.sidebar-card[open]').forEach(other=>{if(other!==card)other.open=false;});}));document.addEventListener('click',event=>{if(!event.target.closest('.multi-combo'))document.querySelectorAll('.multi-combo[open]').forEach(combo=>combo.open=false);});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('code-modal').hidden)closeCodeModal();});window.addEventListener('resize',()=>requestAnimationFrame(drawPinoutLines));refreshSerialPorts();
  }catch(error){showLoadError(error);}
}

init();
