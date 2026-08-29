'use strict';

const TOKEN=getAuthToken();
if(!TOKEN){location.replace('/');throw new Error('Not authenticated');}

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const validPort=value=>/^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/.test(String(value));
const COLORS=['#6c8cff','#32d5f2','#b879ff','#3ed598','#ffb653','#ff718b','#36c5a7','#e6d04c'];
const ROLE_LABELS={left:'ล้อซ้าย',right:'ล้อขวา',front_left:'ล้อหน้าซ้าย',front_right:'ล้อหน้าขวา',rear_left:'ล้อหลังซ้าย',rear_right:'ล้อหลังขวา',auxiliary:'มอเตอร์เสริม'};

let sessionId='',workspace='~/ros2_ws',socket=null,hardwareConfig={},motors=[],gyroCapability={enabled:false,label:''},pidControlEnabled=true;
let protocolVerified=false,rpmFrames=0,gyroFrames=0,pidAcks=0,validFrames=0,invalidFrames=0,lastFrameAt=0,lastRpmAt=0,lastGyroAt=0,portOpenedAt=0,frameTimes=[],history=[],gyroHistory=[];

async function api(path,body){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders(TOKEN)},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({ok:false,error:'Server response ไม่ถูกต้อง'}));
  if(response.status===401){clearAuthSession();location.replace('/');throw Error('Session expired');}
  return data;
}
function log(message){const line=`${new Date().toLocaleTimeString('th-TH')}  ${message}`;$('serial-log').textContent=(line+'\n'+$('serial-log').textContent).slice(0,12000);}
function state(id,text,kind='wait'){const node=$(id);node.textContent=text;node.className=kind;}
function hardwareKey(){return `roside_hardware_config_${localStorage.getItem('ros2ide_robotid')||'default'}`;}

function motorList(config){
  const configured=(Array.isArray(config.assignments)?config.assignments:config.robotDesign?.wheels)||[];
  const encoders=(Array.isArray(config.encoderAssignments)?config.encoderAssignments:config.robotDesign?.encoders)||[];
  const enabled=configured.filter(item=>item.motorEnabled!==false);
  const rawCount=Number(config.motorCount||config.robotDesign?.motorCount||enabled.length||2);
  const count=Math.max(1,Math.min(8,Number.isInteger(rawCount)?rawCount:2));
  const fallbackEncoderCount=Math.max(0,Math.trunc(Number(config.encoderCount||config.robotDesign?.encoderCount)||0));
  const hasExplicitEncoderConfig=configured.some(item=>Object.prototype.hasOwnProperty.call(item,'encoderEnabled'))||encoders.length>0;
  return Array.from({length:count},(_,index)=>{
    const item=enabled[index]||configured[index]||{};
    const role=String(item.motorRole||(['left','right'][index])||`motor_${index+1}`);
    const attachedEncoder=encoders.find(encoder=>encoder.enabled!==false&&(encoder.attachedWheel===item.name||encoder.parent===item.name));
    const hasEncoder=item.encoderEnabled===true||item.encoder?.enabled===true||Boolean(attachedEncoder)||(!hasExplicitEncoderConfig&&index<fallbackEncoderCount);
    return{index,key:role,label:ROLE_LABELS[role]||item.name||`มอเตอร์ ${index+1}`,wheelName:item.name||'',hasEncoder};
  });
}
function configuredGyro(config){
  const accessories=Array.isArray(config.accessories)?config.accessories:[],models=accessories.filter(item=>item==='mpu6050'||item==='bno055');
  const enabled=models.length>0||config.hasImu===true||config.robotDesign?.hasImu===true;
  return{enabled,models,label:models.map(item=>item.toUpperCase()).join(' + ')||(enabled?'IMU จาก Robot Model':'')};
}
function savedPidFor(motor){
  const pid=hardwareConfig.pid||{},list=Array.isArray(pid.motors)?pid.motors:[];
  const found=list[motor.index]||pid[motor.key]||(motor.index===0?pid.left:motor.index===1?pid.right:null)||pid;
  return{kp:Number(found?.kp??.5),ki:Number(found?.ki??0),kd:Number(found?.kd??0)};
}
function inputId(index,gain){return `motor-${index}-${gain}`;}
function pidValues(){
  return motors.map(motor=>{
    const result={key:motor.key,label:motor.label};
    for(const gain of ['kp','ki','kd']){const value=Number($(inputId(motor.index,gain)).value);if(!Number.isFinite(value)||value<0)throw Error(`${motor.label} ${gain.toUpperCase()} ต้องเป็นเลขตั้งแต่ 0 ขึ้นไป`);result[gain]=value;}
    return result;
  });
}
function renderMotors(){
  const encoderCount=motors.filter(motor=>motor.hasEncoder).length;gyroCapability=configuredGyro(hardwareConfig);pidControlEnabled=hardwareConfig.pidControl!==false;
  $('tune-title').textContent=`Robot Tune · ${hardwareConfig.driveLabel||hardwareConfig.drive||`${motors.length} Motors`}`;
  $('tune-subtitle').textContent=`${pidControlEnabled?'PID Control':'Open-loop Speed'} · มอเตอร์ ${motors.length} ตัว · Encoder ${encoderCount} · Gyro ${gyroCapability.enabled?'มี':'ไม่มี'}`;
  $('pid-card').hidden=!pidControlEnabled;
  $('save-tune').textContent=pidControlEnabled?'บันทึก PID ลง ROS Bridge Config':'บันทึกผลทดสอบความเร็ว';
  $('pid-grid').innerHTML=motors.map(motor=>{const pid=savedPidFor(motor);return `<div class="pid-side"><h3>${esc(motor.label)}</h3><div class="pid-inputs">${['kp','ki','kd'].map(gain=>`<label>${gain[0].toUpperCase()+gain.slice(1)}<input id="${inputId(motor.index,gain)}" type="number" min="0" step="0.001" value="${pid[gain]}"></label>`).join('')}</div></div>`;}).join('');
  $('motor-tests').innerHTML=motors.map(motor=>`<button class="btn hold" data-test="motor" data-motor="${motor.index}" disabled>กดค้าง · ${esc(motor.label)}</button>`).join('');
  $('rpm-metrics').innerHTML=motors.map(motor=>`<div class="metric"><small>${esc(motor.label.toUpperCase())} TARGET</small><b id="target-${motor.index}">NO DATA</b></div>${motor.hasEncoder?`<div class="metric"><small>${esc(motor.label.toUpperCase())} ENCODER RPM</small><b id="measured-${motor.index}">NO DATA</b></div>`:''}`).join('')+'<div class="metric"><small>VALID / INVALID</small><b id="frames">0 / 0</b></div>';
  $('rpm-legend').innerHTML=motors.flatMap((motor,index)=>[`<span><i style="--c:${COLORS[index*2%COLORS.length]}"></i>${esc(motor.label)} target</span>`,...(motor.hasEncoder?[`<span><i style="--c:${COLORS[(index*2+1)%COLORS.length]}"></i>${esc(motor.label)} encoder</span>`]:[])]).join('');
  $('rpm-protocol').innerHTML=`เฟรมที่ต้องการ: <code>RPM ${motors.flatMap((_,i)=>[`target_${i+1}`,`measured_${i+1}`]).join(' ')}</code>${encoderCount?` · แสดง Encoder ตาม Config ${encoderCount} ล้อ`:' · ไม่มี Encoder ใน Config จึงแสดงเฉพาะ Target'}`;
  $('gyro-card').hidden=!gyroCapability.enabled;$('gyro-state-row').hidden=!gyroCapability.enabled;
  if(gyroCapability.enabled)$('gyro-protocol').innerHTML=`${esc(gyroCapability.label)} · เฟรม <code>GYRO gx gy gz</code> · หน่วย °/s`;
  bindMotorControls();
}
function bindMotorControls(){
  document.querySelectorAll('.pid-inputs input').forEach(input=>input.addEventListener('change',()=>{pidAcks=0;setControls();}));
  for(const button of document.querySelectorAll('[data-test]')){
    const start=event=>{event.preventDefault();startTest(button,button.dataset.test);};
    button.addEventListener('pointerdown',start);button.addEventListener('pointerup',stopTest);button.addEventListener('pointercancel',stopTest);
    button.addEventListener('pointerleave',event=>{if(event.buttons)stopTest();});
  }
}
function setControls(){
  const live=socket?.readyState===WebSocket.OPEN&&protocolVerified;
  document.querySelectorAll('[data-test]').forEach(button=>button.disabled=!live);
  $('apply-pid').disabled=!pidControlEnabled||!live;$('emergency-stop').disabled=!live;$('save-tune').disabled=!(live&&rpmFrames>0&&(!pidControlEnabled||pidAcks>0));
}

async function readHardwareConfig(){
  let local=null;try{local=JSON.parse(localStorage.getItem(hardwareKey())||'null');}catch{}
  let remote=null;try{const root=String(workspace).replace(/\/$/,'');const result=await api('/api/files/read',{sessionId,path:`${root}/.roside/hardware.json`});if(result.ok)remote=JSON.parse(result.content);}catch{}
  return{...(local||{}),...(remote||{})};
}
async function discoverSerialPorts(){
  const primary=await api('/api/serial/ports',{sessionId}).catch(error=>({ok:false,error:error.message}));
  if(primary.ok&&Array.isArray(primary.ports))return primary.ports;
  const command="for port in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyTHS* /dev/rfcomm*; do [ -c \"$port\" ] || continue; if [ -r \"$port\" ] && [ -w \"$port\" ]; then access=1; else access=0; fi; printf '%s\\t%s\\n' \"$port\" \"$access\"; done; true";
  const fallback=await api('/api/exec',{sessionId,command,timeout:10000});
  if(!fallback.ok)throw Error(primary.error||fallback.error||'ค้นหา COM port ไม่สำเร็จ');
  return String(fallback.stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{const [path,access]=line.split('\t');return{path,label:path.split('/').pop(),connected:true,accessible:access==='1'};}).filter(item=>validPort(item.path));
}
async function restore(){
  const saved=localStorage.getItem('ros2ide_session'),robotId=localStorage.getItem('ros2ide_robotid');
  const result=await api('/api/session/restore',{sessionId:saved,robotId});
  if(!result.ok||result.isSim)throw Error(result.error||'หน้า Tune ใช้กับหุ่นยนต์จริงเท่านั้น');
  sessionId=result.sessionId;workspace=result.workspace||'~/ros2_ws';localStorage.setItem('ros2ide_session',sessionId);
  hardwareConfig=await readHardwareConfig();motors=motorList(hardwareConfig);renderMotors();
  $('tune-baud').value=hardwareConfig.baudRate||115200;
  await refreshPorts(hardwareConfig.serialPort);
}
async function refreshPorts(preferred=''){
  const select=$('tune-port');select.innerHTML='<option value="">กำลังค้นหา…</option>';
  try{
    const ports=(await discoverSerialPorts()).filter(item=>validPort(item.path));
    select.innerHTML='<option value="">'+(ports.length?`เลือก COM port (${ports.length} พอร์ต)`:'ไม่พบ COM port')+'</option>';
    for(const item of ports){const access=item.accessible?'พร้อมใช้':'ไม่มีสิทธิ์';select.add(new Option(`${item.path} · ${item.label||item.path} · ${access}`,item.path));}
    const selected=ports.find(item=>item.path===preferred||item.stablePath===preferred);if(selected)select.value=selected.path;
    log(ports.length?`พบ COM PORT ${ports.map(item=>item.path).join(', ')}`:'ไม่พบ USB/UART COM port บนเครื่อง Robot');
  }catch(error){select.innerHTML='<option value="">ค้นหาไม่สำเร็จ</option>';log(error.message);}
}
function resetLiveState(){protocolVerified=false;rpmFrames=gyroFrames=pidAcks=validFrames=invalidFrames=0;lastFrameAt=lastRpmAt=lastGyroAt=portOpenedAt=0;frameTimes=[];history=[];gyroHistory=[];state('protocol-state','รอข้อมูลบอร์ด');state('rpm-state','NO DATA');if(gyroCapability.enabled)state('gyro-state','NO DATA');$('frames').textContent='0 / 0';$('gyro-frames').textContent='0';for(const motor of motors){$('target-'+motor.index).textContent='NO DATA';if(motor.hasEncoder)$('measured-'+motor.index).textContent='NO DATA';}for(const axis of ['x','y','z'])$('gyro-'+axis).textContent='NO DATA';$('fix-permission').hidden=true;setControls();drawChart();drawGyroChart();}
async function connect(){
  const port=$('tune-port').value,baud=Math.trunc(Number($('tune-baud').value));
  if(!validPort(port))return log('กรุณาเลือก COM port');if(!Number.isInteger(baud)||baud<9600)return log('Baud rate ไม่ถูกต้อง');
  disconnect(false);resetLiveState();state('port-state','กำลังตรวจสิทธิ์…');$('connect-button').disabled=true;
  const prepared=await api('/api/serial/prepare',{sessionId,port}).catch(error=>({ok:false,error:error.message}));
  if(!prepared.ok){state('port-state','แก้สิทธิ์ไม่สำเร็จ','bad');$('fix-permission').hidden=false;$('connect-button').disabled=false;log(`SERIAL PERMISSION: ${prepared.error||'ไม่สามารถเตรียมพอร์ตได้'}`);return;}
  if(prepared.repaired)log(`แก้สิทธิ์ ${port} สำหรับ Agent แล้ว`);
  state('port-state','กำลังเปิด…');$('disconnect-button').disabled=false;
  const proto=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(`${proto}//${location.host}/ws/controller-tune`,['ros2ide',TOKEN]);
  socket.onopen=()=>socket.send(JSON.stringify({type:'start',sessionId,port,baud,motorCount:motors.length}));
  socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}if(message.type==='error'){log('ERROR '+message.message);state('port-state','เปิดไม่สำเร็จ','bad');setControls();return;}if(message.type==='pty_closed'){log('Serial worker หยุดทำงาน');socket?.close();return;}if(message.type==='telemetry')handleTelemetry(message.data);};
  socket.onerror=()=>log('WebSocket เชื่อมต่อไม่สำเร็จ');socket.onclose=()=>{if($('fix-permission').hidden)state('port-state','ปิดแล้ว','wait');$('connect-button').disabled=false;$('disconnect-button').disabled=true;socket=null;setControls();};
}
function disconnect(sendStop=true){if(socket){if(sendStop&&socket.readyState===WebSocket.OPEN)sendCommand('S');socket.close();socket=null;}$('connect-button').disabled=false;$('disconnect-button').disabled=true;setControls();}
function handleTelemetry(data){
  if(data.event==='port_open'){portOpenedAt=Date.now();state('port-state',`${data.port} เปิดแล้ว`,'ok');$('fix-permission').hidden=true;log(`PORT OPEN ${data.port} @ ${data.baud}`);return;}
  if(data.event==='permission_denied'){state('port-state','ไม่มีสิทธิ์เปิดพอร์ต','bad');$('fix-permission').hidden=false;log(`SERIAL PERMISSION: ${data.message}`);log(data.hint||'กด “แก้สิทธิ์ Serial port” แล้วลองเชื่อมต่อใหม่');return;}
  if(data.event==='error'){state('port-state','เปิดไม่สำเร็จ','bad');log('SERIAL ERROR '+data.message);return;}
  if(data.event==='invalid_frame'){invalidFrames++;$('frames').textContent=`${validFrames} / ${invalidFrames}`;if(invalidFrames<=10||invalidFrames%50===0)log(`INVALID (${invalidFrames})  ${data.line}`);return;}
  if(data.event==='command_sent'){log('TX  '+data.command);return;}if(data.event!=='frame')return;
  protocolVerified=true;validFrames++;lastFrameAt=Date.now();frameTimes.push(lastFrameAt);frameTimes=frameTimes.filter(time=>lastFrameAt-time<=3000);state('protocol-state',`${data.kind} · pattern ถูกต้อง`,'ok');$('frames').textContent=`${validFrames} / ${invalidFrames}`;log('RX  '+data.line);
  if(data.kind==='RPM'&&data.values.length===motors.length*2){
    rpmFrames++;lastRpmAt=Date.now();const targets=[],measured=[];for(let index=0;index<motors.length;index++){targets.push(data.values[index*2]);measured.push(data.values[index*2+1]);$('target-'+index).textContent=targets[index].toFixed(1);if(motors[index].hasEncoder)$('measured-'+index).textContent=measured[index].toFixed(1);}
    history.push({targets,measured});if(history.length>240)history.shift();state('rpm-state',`${rpmFrames} เฟรม · ${motors.length} มอเตอร์`,'ok');drawChart();
  }else if(data.kind==='RPM'){log(`RPM มี ${data.values.length/2} มอเตอร์ แต่ Hardware config กำหนด ${motors.length} มอเตอร์`);}
  else if(data.kind==='GYRO'&&data.values.length>=3&&gyroCapability.enabled){
    const values=data.values.slice(0,3);gyroFrames++;lastGyroAt=Date.now();gyroHistory.push(values);if(gyroHistory.length>240)gyroHistory.shift();
    ['x','y','z'].forEach((axis,index)=>$('gyro-'+axis).textContent=`${values[index].toFixed(2)} °/s`);
    $('gyro-frames').textContent=String(gyroFrames);state('gyro-state',`${gyroFrames} เฟรม · X/Y/Z`,'ok');drawGyroChart();
  }
  else if(data.kind==='PID'){
    if(data.values.length===motors.length*3){pidAcks++;motors.forEach((motor,index)=>['kp','ki','kd'].forEach((gain,offset)=>$(inputId(motor.index,gain)).value=data.values[index*3+offset]));}
    else log(`PID response มี ${data.values.length} ค่า แต่ต้องการ ${motors.length*3} ค่า`);
  }
  setControls();
}
function sendCommand(command){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'command',command,motorCount:motors.length}));}
function applyPid(){if(!pidControlEnabled)return log('Hardware config ปิด PID Control อยู่');try{const values=pidValues().flatMap(pid=>[pid.kp,pid.ki,pid.kd]);pidAcks=0;setControls();sendCommand(`P ${values.join(' ')}`);}catch(error){log(error.message);}}
function stopTest(){sendCommand('S');document.querySelectorAll('.hold.active').forEach(button=>button.classList.remove('active'));}
function startTest(button,kind){
  if(!protocolVerified)return;const rpm=Math.max(1,Math.abs(Number($('test-rpm').value)||30)),speed=Math.max(.01,Math.min(1,Math.abs(Number($('forward-speed').value)||.1)));
  if(kind==='motor'){const values=motors.map((_,index)=>index===Number(button.dataset.motor)?rpm:0);sendCommand(`R ${values.join(' ')}`);}else sendCommand(`V ${speed} 0 0`);button.classList.add('active');
}
async function fixSerialPermission(){
  const button=$('fix-permission'),port=$('tune-port').value;if(!validPort(port))return log('กรุณาเลือก COM port');button.disabled=true;button.textContent='กำลังแก้สิทธิ์…';
  try{const result=await api('/api/serial/prepare',{sessionId,port});if(result.ok){log('แก้สิทธิ์ Serial แล้ว กำลังเชื่อมต่อใหม่');button.hidden=true;await connect();}else{log(result.error||'แก้สิทธิ์ไม่สำเร็จ');state('port-state',result.requiresSudo?'ต้องตรวจรหัส Robot/sudo':'แก้สิทธิ์ไม่สำเร็จ','bad');}}catch(error){log(error.message);}finally{button.disabled=false;button.textContent='🔐 แก้สิทธิ์ Serial port';}
}
async function saveTune(){
  const status=$('save-status');
  try{
    if(!protocolVerified||!rpmFrames||(pidControlEnabled&&!pidAcks))throw Error(pidControlEnabled?'ต้องพบ RPM และ PID response จากบอร์ดก่อนบันทึก':'ต้องพบ RPM response จากบอร์ดก่อนบันทึก');
    const values=pidValues(),port=$('tune-port').value,baud=Math.trunc(Number($('tune-baud').value)),root=String(workspace).replace(/\/$/,''),savedAt=new Date().toISOString();
    const pid={motors:values.map(({key,label,...gains})=>gains)};values.forEach(value=>{pid[value.key]={kp:value.kp,ki:value.ki,kd:value.kd};});if(values[0])pid.left={kp:values[0].kp,ki:values[0].ki,kd:values[0].kd};if(values[1])pid.right={kp:values[1].kp,ki:values[1].ki,kd:values[1].kd};
    let hardware={};try{const read=await api('/api/files/read',{sessionId,path:`${root}/.roside/hardware.json`});if(read.ok)hardware=JSON.parse(read.content);}catch{}
    hardware={...hardware,version:Math.max(13,Number(hardware.version)||0),motorCount:motors.length,pidControl:pidControlEnabled,serialPort:port,baudRate:baud,pid,updatedAt:savedAt};
    const tune={version:3,drive:hardware.drive||'',motorCount:motors.length,pidControl:pidControlEnabled,motors:values,leftPid:values[0]||null,rightPid:values[1]||values[0]||null,protocolVerified:true,protocolFrames:validFrames,rpmFrames,pidAcks,serialPort:port,baudRate:baud,savedAt};
    const maxRpm=Number(hardware.motorMaxRpm)||300,left=values[0],right=values[1]||values[0];
    const yaml=`controller_bridge:\n  ros__parameters:\n    serial_port: "${port}"\n    baud_rate: ${baud}\n    base_frame: base_link\n    odom_frame: odom\n    publish_tf: true\n    pid_control_enabled: ${pidControlEnabled}\n    motor_count: ${motors.length}\n    left_kp: ${left.kp}\n    left_ki: ${left.ki}\n    left_kd: ${left.kd}\n    right_kp: ${right.kp}\n    right_ki: ${right.ki}\n    right_kd: ${right.kd}\n    max_rpm: ${maxRpm}\n`;
    for(const dir of [`${root}/.roside`,`${root}/src/roside_controller_bridge/config`]){const result=await api('/api/files/mkdir',{sessionId,path:dir});if(!result.ok)throw Error(result.error);}
    for(const [path,content] of [[`${root}/.roside/controller_tune.json`,JSON.stringify(tune,null,2)+'\n'],[`${root}/.roside/hardware.json`,JSON.stringify(hardware,null,2)+'\n'],[`${root}/src/roside_controller_bridge/config/controller.yaml`,yaml]]){const result=await api('/api/files/write',{sessionId,path,content});if(!result.ok)throw Error(result.error);}
    hardwareConfig=hardware;localStorage.setItem(hardwareKey(),JSON.stringify(hardware));await api('/api/dashboard',{sessionId,forceProjectScan:true}).catch(()=>null);status.className='save-status ok';status.textContent=pidControlEnabled?`✓ บันทึก PID มอเตอร์ ${motors.length} ตัวและ ROS Bridge config แล้ว`:'✓ บันทึกการทดสอบ Open-loop Speed และ ROS Bridge config แล้ว';
  }catch(error){status.className='save-status bad';status.textContent='✕ '+error.message;}
}
function drawChart(){
  const canvas=$('rpm-chart'),ratio=devicePixelRatio||1,width=canvas.clientWidth||700,height=canvas.clientHeight||300;if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}
  const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--line');ctx.lineWidth=1;for(let i=1;i<5;i++){const y=height*i/5;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}if(history.length<2)return;
  const max=Math.max(10,...history.flatMap(point=>[...point.targets,...point.measured.filter((_,index)=>motors[index].hasEncoder)].map(Math.abs)))*1.15;
  motors.forEach((motor,motorIndex)=>['targets',...(motor.hasEncoder?['measured']:[])].forEach((key,typeIndex)=>{ctx.beginPath();ctx.strokeStyle=COLORS[(motorIndex*2+typeIndex)%COLORS.length];ctx.lineWidth=2;history.forEach((point,index)=>{const x=index/(history.length-1)*width,y=height/2-point[key][motorIndex]/max*(height*.43);index?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}));
}
function drawGyroChart(){
  if(!gyroCapability.enabled)return;const canvas=$('gyro-chart'),ratio=devicePixelRatio||1,width=canvas.clientWidth||700,height=canvas.clientHeight||220;if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}
  const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--line');ctx.lineWidth=1;for(let i=1;i<4;i++){const y=height*i/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}if(gyroHistory.length<2)return;
  const max=Math.max(5,...gyroHistory.flatMap(values=>values.map(Math.abs)))*1.15,colors=['#ff718b','#3ed598','#b879ff'];
  for(let axis=0;axis<3;axis++){ctx.beginPath();ctx.strokeStyle=colors[axis];ctx.lineWidth=2;gyroHistory.forEach((values,index)=>{const x=index/(gyroHistory.length-1)*width,y=height/2-values[axis]/max*(height*.43);index?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
}
function updateRate(){
  const now=Date.now();if(portOpenedAt&&now-(lastRpmAt||portOpenedAt)>1500){state('rpm-state','NO DATA','bad');for(const motor of motors){$('target-'+motor.index).textContent='NO DATA';if(motor.hasEncoder)$('measured-'+motor.index).textContent='NO DATA';}}
  if(gyroCapability.enabled&&portOpenedAt&&now-(lastGyroAt||portOpenedAt)>1500){state('gyro-state','NO DATA','bad');for(const axis of ['x','y','z'])$('gyro-'+axis).textContent='NO DATA';}
  if(!lastFrameAt)return;const age=now-lastFrameAt,hz=frameTimes.length>1?(frameTimes.length-1)/((frameTimes.at(-1)-frameTimes[0])/1000):0;$('rate-state').textContent=`${hz.toFixed(1)} Hz / ${age} ms`;if(age>1000){state('protocol-state','NO DATA','bad');protocolVerified=false;setControls();}
}

document.addEventListener('DOMContentLoaded',async()=>{
  try{await restore();}catch(error){hardwareConfig={motorCount:2};motors=motorList(hardwareConfig);renderMotors();log(error.message);state('port-state','โหลดไม่ได้','bad');}
  $('refresh-port').onclick=()=>refreshPorts($('tune-port').value);$('connect-button').onclick=connect;$('disconnect-button').onclick=()=>disconnect();$('fix-permission').onclick=fixSerialPermission;$('apply-pid').onclick=applyPid;$('emergency-stop').onclick=stopTest;$('save-tune').onclick=saveTune;
  window.addEventListener('blur',stopTest);document.addEventListener('visibilitychange',()=>{if(document.hidden)stopTest();});window.addEventListener('beforeunload',()=>disconnect());window.addEventListener('resize',()=>{drawChart();drawGyroChart();});setInterval(updateRate,250);drawChart();drawGyroChart();
});
