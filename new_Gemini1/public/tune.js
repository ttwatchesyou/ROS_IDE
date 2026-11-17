'use strict';

const TOKEN=getAuthToken();
if(!TOKEN){location.replace('/');throw new Error('Not authenticated');}

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const validPort=value=>/^\/dev\/(?:tty(?:USB|ACM|AMA|THS|S)\d+|serial\d+|rfcomm\d+|serial\/by-id\/[A-Za-z0-9._:+-]+)$/.test(String(value));
const ROLE_LABELS={left:'ล้อซ้าย',right:'ล้อขวา',front_left:'ล้อหน้าซ้าย',front_right:'ล้อหน้าขวา',rear_left:'ล้อหลังซ้าย',rear_right:'ล้อหลังขวา',auxiliary:'มอเตอร์เสริม'};

let sessionId='',workspace='~/ros2_ws',socket=null,hardwareConfig={},motors=[],gyroCapability={enabled:false,label:''},pidControlEnabled=true;
let protocolVerified=false,rpmFrames=0,gyroFrames=0,pidAcks=0,validFrames=0,invalidFrames=0,lastFrameAt=0,lastRpmAt=0,lastGyroAt=0,portOpenedAt=0,frameTimes=[];
let rawLines=0,serialBytes=0,serialLines=0,legacyFirmware=false,noDataHintShown=false;
let holdTimer=null,tuneDashboard=null;
let positionOnly=false,lastOdomAt=0;
function tuneHelp(message='',bad=false){const node=$('tune-help');if(!node)return;node.hidden=!message;node.textContent=message;node.classList.toggle('bad',bad);}

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
  if(config.robotDesign?.hardwareTemplate==='mecanum_xy'){
    const order=['front_left','front_right','rear_left','rear_right'];
    enabled.sort((a,b)=>order.indexOf(a.motorRole)-order.indexOf(b.motorRole));
  }
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
  const accessories=Array.isArray(config.accessories)?config.accessories:[],models=accessories.filter(item=>item==='mpu6050'||item==='bno055'||item==='bno08x');
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
  positionOnly=hardwareConfig.robotDesign?.hardwareTemplate==='mecanum_xy';
  if(positionOnly)tuneDashboard?.presetPose();
  const encoderCount=motors.filter(motor=>motor.hasEncoder).length;gyroCapability=configuredGyro(hardwareConfig);pidControlEnabled=!positionOnly&&hardwareConfig.pidControl!==false;
  $('tune-title').textContent='Robot Tune · Dashboard';
  $('tune-subtitle').textContent=positionOnly?'Mecanum · Position X/Y · BNO08x Yaw · ODOM':`${hardwareConfig.driveLabel||hardwareConfig.drive||'Controller'} · ${pidControlEnabled?'PID Control':'Open-loop Speed'} · มอเตอร์ ${motors.length} ตัว · Encoder ${encoderCount}`;
  $('pid-card').hidden=!pidControlEnabled;
  $('pose-card').hidden=!positionOnly;
  $('rpm-state-row').hidden=positionOnly;
  $('test-rpm-field').hidden=positionOnly;
  $('drive-test-fields').style.gridTemplateColumns=positionOnly?'1fr':'';
  $('drive-safety').textContent=positionOnly?'⚠️ ทดสอบบนพื้นที่โล่ง ตรวจทิศมอเตอร์ก่อนเริ่ม และกดค้างเฉพาะระหว่างควบคุม · เมื่อปล่อยปุ่มระบบจะสั่งหยุด':'⚠️ ยกล้อให้พ้นพื้นก่อนจูนมอเตอร์เดี่ยว วางหุ่นบนพื้นที่โล่งก่อนทดสอบเดินหน้า ทุกปุ่มเป็นแบบกดค้างและจะส่งคำสั่งหยุดเมื่อปล่อย';
  $('motor-tests').hidden=positionOnly;
  $('save-tune').hidden=positionOnly;
  $('drive-test-title').textContent=positionOnly?'2 · ทดสอบเดินหน้าแบบกดค้าง':'3 · ทดสอบความเร็วและเดินหน้า';
  $('save-tune').textContent=hardwareConfig.robotDesign?.hardwareTemplate==='mecanum_xy'?'บันทึก PID 4 ล้อสำหรับ Firmware':pidControlEnabled?'บันทึก PID ลง ROS Bridge Config':'บันทึกผลทดสอบความเร็ว';
  $('pid-grid').innerHTML=motors.map(motor=>{const pid=savedPidFor(motor);return `<div class="pid-side"><h3>${esc(motor.label)}</h3><div class="pid-inputs">${['kp','ki','kd'].map(gain=>`<label>${gain[0].toUpperCase()+gain.slice(1)}<input id="${inputId(motor.index,gain)}" type="number" min="0" step="0.001" value="${pid[gain]}"></label>`).join('')}</div></div>`;}).join('');
  $('motor-tests').innerHTML=motors.map(motor=>`<button class="btn hold" data-test="motor" data-motor="${motor.index}" disabled>กดค้าง · ${esc(motor.label)}</button>`).join('');
  $('gyro-state-row').hidden=false;
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
  $('apply-pid').disabled=!pidControlEnabled||!live;$('emergency-stop').disabled=!live;$('save-tune').disabled=positionOnly||!(live&&rpmFrames>0&&(!pidControlEnabled||pidAcks>0));
}

async function readHardwareConfig(){
  let local=null;try{local=JSON.parse(localStorage.getItem(hardwareKey())||'null');}catch{}
  let remote=null;try{const root=String(workspace).replace(/\/$/,'');const result=await api('/api/files/read',{sessionId,path:`${root}/.roside/hardware.json`});if(result.ok)remote=JSON.parse(result.content);}catch{}
  return{...(local||{}),...(remote||{})};
}
async function discoverSerialPorts(){
  const primary=await api('/api/serial/ports',{sessionId}).catch(error=>({ok:false,error:error.message}));
  if(primary.ok&&Array.isArray(primary.ports)){if(primary.uartHint)log(primary.uartHint);return primary.ports;}
  const command="for port in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyTHS* /dev/ttyS* /dev/serial[0-9]* /dev/rfcomm*; do [ -c \"$port\" ] || continue; if [ -r \"$port\" ] && [ -w \"$port\" ]; then access=1; else access=0; fi; printf '%s\\t%s\\n' \"$port\" \"$access\"; done; true";
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
    const selected=ports.find(item=>item.path===preferred||item.stablePath===preferred||item.aliases?.includes(preferred));if(selected)select.value=selected.path;
    log(ports.length?`พบ COM PORT ${ports.map(item=>item.path).join(', ')}`:'ไม่พบ USB/UART COM port บนเครื่อง Robot');
  }catch(error){select.innerHTML='<option value="">ค้นหาไม่สำเร็จ</option>';log(error.message);}
}
function resetLiveState(){protocolVerified=false;rpmFrames=gyroFrames=pidAcks=validFrames=invalidFrames=0;rawLines=serialBytes=serialLines=0;legacyFirmware=noDataHintShown=false;lastFrameAt=lastRpmAt=lastGyroAt=lastOdomAt=portOpenedAt=0;frameTimes=[];tuneHelp();for(const id of ['pose-x','pose-y','pose-yaw','pose-distance','pose-turn'])$(id).textContent='—';$('pose-health').textContent='รอข้อมูล ODOM และ IMU จากบอร์ด';state('protocol-state','รอข้อมูลบอร์ด');state('rpm-state','NO DATA');state('gyro-state','NO DATA');$('frames').textContent='0 / 0';$('serial-rx-state').textContent='0 bytes / 0 lines';$('fix-permission').hidden=true;if($('encoder-diagnostic'))$('encoder-diagnostic').hidden=true;tuneDashboard?.clearData();setControls();}
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
function disconnect(sendStop=true){if(holdTimer){clearInterval(holdTimer);holdTimer=null;}if(socket){if(sendStop&&socket.readyState===WebSocket.OPEN)sendCommand('S');socket.close();socket=null;}$('connect-button').disabled=false;$('disconnect-button').disabled=true;setControls();}
function handleTelemetry(data){
  if(data.event==='port_open'){portOpenedAt=Date.now();state('port-state',`${data.port} เปิดแล้ว`,'ok');$('fix-permission').hidden=true;tuneHelp('พอร์ตเปิดแล้ว กำลังรอ Firmware เริ่มทำงานและส่งข้อมูล…');log(`PORT OPEN ${data.port} @ ${data.baud}`);return;}
  if(data.event==='serial_status'){
    serialBytes=Number(data.bytesReceived)||0;serialLines=Number(data.linesReceived)||0;
    $('serial-rx-state').textContent=`${serialBytes} bytes / ${serialLines} lines`;
    if(!(positionOnly?lastOdomAt:lastRpmAt)&&portOpenedAt&&Date.now()-portOpenedAt>9000&&!legacyFirmware){
      if(!serialBytes)tuneHelp('รับข้อมูล 0 ไบต์: ตรวจว่าบอร์ดรัน Firmware หลัง Upload (BOOT0 = 0 แล้ว Reset), พอร์ตที่เลือกถูกต้อง, สาย PA9 TX → USB-UART RX และ GND ร่วม',true);
      else if(!serialLines)tuneHelp(`รับ ${serialBytes} ไบต์ แต่ยังไม่มีบรรทัดสมบูรณ์: ตรวจ Baud rate, สาย Serial และไฟเลี้ยงบอร์ด`,true);
      else if(tuneDashboard?.model.catalog.size)tuneHelp(positionOnly?'รับข้อมูลชนิดอื่นแล้ว แต่ยังรอเฟรม ODOM สำหรับตำแหน่ง X/Y':'รับข้อมูลชนิดอื่นแล้ว เลือกขึ้นกราฟได้จาก combobox; การจูนมอเตอร์ยังต้องมีเฟรม RPM');
      else tuneHelp(`รับ ${serialBytes} ไบต์ / ${serialLines} บรรทัด แต่ยังไม่พบข้อมูลตัวเลข: ตรวจข้อมูลดิบด้านล่างและ Firmware ที่ Upload`,true);
    }
    return;
  }
  if(data.event==='permission_denied'){state('port-state','ไม่มีสิทธิ์เปิดพอร์ต','bad');$('fix-permission').hidden=false;log(`SERIAL PERMISSION: ${data.message}`);log(data.hint||'กด “แก้สิทธิ์ Serial port” แล้วลองเชื่อมต่อใหม่');return;}
  if(data.event==='error'){state('port-state','เปิดไม่สำเร็จ','bad');log('SERIAL ERROR '+data.message);return;}
  if(data.event==='invalid_frame'){
    rawLines++;
    if(data.line==='ROSIDE_BOOT'){state('protocol-state','บอร์ดเริ่มบูต','wait');tuneHelp(positionOnly?'ได้รับ ROSIDE_BOOT จากบอร์ดแล้ว กำลังรอ IMU และเฟรม ODOM…':'ได้รับ ROSIDE_BOOT จากบอร์ดแล้ว กำลังรอ IMU และเฟรม RPM…');log('CONTROLLER  ROSIDE_BOOT');return;}
    if(/^T:/.test(data.line||'')){
      if(/^T:(?:TARGET|TEL|READY):/.test(data.line)){legacyFirmware=true;state('protocol-state','Firmware รุ่นเก่า','bad');tuneHelp('บอร์ดส่งเฟรม T: รุ่นเก่าอยู่: Build อย่างเดียวไม่เขียนลงบอร์ด กรุณา Upload Firmware Mecanum ล่าสุด แล้วตั้ง BOOT0 เป็น 0 และ Reset',true);}
      if(rawLines<=10||rawLines%50===0||/^T:(?:ERR|SAFE_STOP|WARN):/.test(data.line))log('CONTROLLER  '+data.line);
      return;
    }
    invalidFrames++;$('frames').textContent=`${validFrames} / ${invalidFrames}`;if(invalidFrames<=10||invalidFrames%50===0)log(`INVALID (${invalidFrames})  ${data.line}`);return;
  }
  if(data.event==='command_sent'){log('TX  '+data.command);return;}if(data.event!=='frame')return;
  rawLines++;if(data.kind===(positionOnly?'ODOM':'RPM')){legacyFirmware=false;tuneHelp();}
  validFrames++;lastFrameAt=Date.now();frameTimes.push(lastFrameAt);frameTimes=frameTimes.filter(time=>lastFrameAt-time<=3000);state('protocol-state',`${data.kind} · pattern ถูกต้อง`,'ok');$('frames').textContent=`${validFrames} / ${invalidFrames}`;if(validFrames<=10||validFrames%30===0)log('RX  '+data.line);
  tuneDashboard?.ingest(data);
  if(data.kind==='ODOM'&&data.values.length===6){
    lastOdomAt=Date.now();if(positionOnly)protocolVerified=true;
    const pose=tuneDashboard?.model.pose;
    if(pose){$('pose-x').textContent=`${pose.x.toFixed(3)} m`;$('pose-y').textContent=`${pose.y.toFixed(3)} m`;$('pose-yaw').textContent=`${pose.yawDeg.toFixed(1)}°`;$('pose-distance').textContent=`${pose.distance.toFixed(3)} m`;$('pose-turn').textContent=`${pose.turnDeg.toFixed(1)}°`;}
    if(positionOnly)$('pose-health').textContent=lastGyroAt&&Date.now()-lastGyroAt<1500?'ODOM และ IMU กำลังส่งข้อมูล':'ได้รับ ODOM · รอ IMU เพื่อยืนยันมุมหัวหุ่น';
  }
  if(data.kind==='ENC'&&data.values.length===3){
    const levels=Number(data.values[2])&255,diagnostic=$('encoder-diagnostic');
    if(diagnostic){diagnostic.hidden=false;diagnostic.textContent=`STM32 Encoder · FR (PA2/PA3) ticks ${data.values[0]} · RL (PA4/PA5) ticks ${data.values[1]} · ${Array.from({length:8},(_,pin)=>`PA${pin}=${(levels>>pin)&1}`).join('  ')} · หมุน FR/RL ด้วยมือแล้วดู ticks กับระดับขาเปลี่ยน`;}
  }
  if(data.kind==='RPM'&&data.values.length===motors.length*2){
    protocolVerified=true;rpmFrames++;lastRpmAt=Date.now();state('rpm-state',`${rpmFrames} เฟรม · ${motors.length} มอเตอร์`,'ok');
  }else if(data.kind==='RPM'){state('rpm-state',`RPM ${data.values.length/2} ชุด · Config ${motors.length}`,'bad');if(rpmFrames===0)log(`RPM มี ${data.values.length/2} ชุด แต่ Hardware config กำหนด ${motors.length} มอเตอร์ · กราฟยังแสดงข้อมูลที่รับจริง`);}
  else if((data.kind==='GYRO'||data.kind==='IMU')&&data.values.length>=3){
    gyroFrames++;lastGyroAt=Date.now();state('gyro-state',`${gyroFrames} เฟรม · X/Y/Z`,'ok');
  }
  else if(data.kind==='PID'){
    if(data.values.length===motors.length*3){pidAcks++;motors.forEach((motor,index)=>['kp','ki','kd'].forEach((gain,offset)=>$(inputId(motor.index,gain)).value=data.values[index*3+offset]));}
    else log(`PID response มี ${data.values.length} ค่า แต่ต้องการ ${motors.length*3} ค่า`);
  }
  setControls();
}
function sendCommand(command){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'command',command,motorCount:motors.length}));}
function applyPid(){if(!pidControlEnabled)return log('Hardware config ปิด PID Control อยู่');try{const values=pidValues().flatMap(pid=>[pid.kp,pid.ki,pid.kd]);pidAcks=0;setControls();sendCommand(`P ${values.join(' ')}`);}catch(error){log(error.message);}}
function stopTest(){if(holdTimer){clearInterval(holdTimer);holdTimer=null;}sendCommand('S');document.querySelectorAll('.hold.active').forEach(button=>button.classList.remove('active'));}
function startTest(button,kind){
  if(!protocolVerified)return;const rpm=Math.max(1,Math.abs(Number($('test-rpm').value)||30)),speed=Math.max(.01,Math.min(1,Math.abs(Number($('forward-speed').value)||.1)));
  if(holdTimer)stopTest();
  const command=kind==='motor'?`R ${motors.map((_,index)=>index===Number(button.dataset.motor)?rpm:0).join(' ')}`:`V ${speed} 0 0`;
  sendCommand(command);button.classList.add('active');
  holdTimer=setInterval(()=>{if(socket?.readyState!==WebSocket.OPEN){stopTest();return;}sendCommand(command);},150);
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
    const pid={motors:values.map(({key,label,...gains})=>gains)};values.forEach(value=>{pid[value.key]={kp:value.kp,ki:value.ki,kd:value.kd};});
    if(motors.length===2){if(values[0])pid.left={kp:values[0].kp,ki:values[0].ki,kd:values[0].kd};if(values[1])pid.right={kp:values[1].kp,ki:values[1].ki,kd:values[1].kd};}
    let hardware={};try{const read=await api('/api/files/read',{sessionId,path:`${root}/.roside/hardware.json`});if(read.ok)hardware=JSON.parse(read.content);}catch{}
    hardware={...hardware,version:Math.max(13,Number(hardware.version)||0),motorCount:motors.length,pidControl:pidControlEnabled,serialPort:port,baudRate:baud,pid,updatedAt:savedAt};
    const tune={version:3,drive:hardware.drive||'',motorCount:motors.length,pidControl:pidControlEnabled,motors:values,leftPid:values[0]||null,rightPid:values[1]||values[0]||null,protocolVerified:true,protocolFrames:validFrames,rpmFrames,pidAcks,serialPort:port,baudRate:baud,savedAt};
    const maxRpm=Number(hardware.motorMaxRpm)||300,mecanum=hardware.robotDesign?.hardwareTemplate==='mecanum_xy',left=values[0],right=values[1]||values[0];
    const wheelPidYaml=mecanum?'':`    left_kp: ${left.kp}\n    left_ki: ${left.ki}\n    left_kd: ${left.kd}\n    right_kp: ${right.kp}\n    right_ki: ${right.ki}\n    right_kd: ${right.kd}\n`;
    const yaml=`controller_bridge:\n  ros__parameters:\n    serial_port: "${port}"\n    baud_rate: ${baud}\n    base_frame: base_link\n    odom_frame: odom\n    publish_tf: true\n    pid_control_enabled: ${pidControlEnabled}\n${mecanum?'':`    motor_count: ${motors.length}\n`}${wheelPidYaml}    max_rpm: ${maxRpm}\n`;
    for(const dir of [`${root}/.roside`,`${root}/src/roside_controller_bridge/config`]){const result=await api('/api/files/mkdir',{sessionId,path:dir});if(!result.ok)throw Error(result.error);}
    for(const [path,content] of [[`${root}/.roside/controller_tune.json`,JSON.stringify(tune,null,2)+'\n'],[`${root}/.roside/hardware.json`,JSON.stringify(hardware,null,2)+'\n'],[`${root}/src/roside_controller_bridge/config/controller.yaml`,yaml]]){const result=await api('/api/files/write',{sessionId,path,content});if(!result.ok)throw Error(result.error);}
    hardwareConfig=hardware;localStorage.setItem(hardwareKey(),JSON.stringify(hardware));await api('/api/dashboard',{sessionId,forceProjectScan:true}).catch(()=>null);status.className='save-status ok';status.textContent=mecanum?`✓ บันทึก PID แยก ${motors.length} ล้อแล้ว · สร้าง Firmware ใน Hardware Wiring และ Upload ใหม่เพื่อให้ค่าคงอยู่หลังปิดบอร์ด`:pidControlEnabled?`✓ บันทึก PID มอเตอร์ ${motors.length} ตัวและ ROS Bridge config แล้ว`:'✓ บันทึกการทดสอบ Open-loop Speed และ ROS Bridge config แล้ว';
  }catch(error){status.className='save-status bad';status.textContent='✕ '+error.message;}
}
function updateRate(){
  const now=Date.now();if(portOpenedAt&&!(positionOnly?lastOdomAt:lastRpmAt)&&!legacyFirmware&&now-portOpenedAt>30000){
    const hasNumericData=Boolean(tuneDashboard?.model.catalog.size);
    if(!noDataHintShown){log(hasNumericData?`มีข้อมูลตัวเลขจาก Controller แล้ว แต่ยังไม่มี ${positionOnly?'ODOM':'RPM'}`:rawLines?'มีข้อมูล Serial แต่ยังไม่มีข้อมูลตัวเลขสำหรับกราฟ':'พอร์ตเปิดได้แต่ไม่ได้รับข้อความจากบอร์ดภายใน 30 วินาที');noDataHintShown=true;}
    if(hasNumericData)tuneHelp(positionOnly?'กราฟรับข้อมูลแล้ว แต่ยังรอ ODOM สำหรับตำแหน่ง X/Y':'กราฟใช้ข้อมูลที่รับจริงได้แล้ว เลือกช่องข้อมูลจาก combobox; ปุ่มจูนมอเตอร์จะพร้อมเมื่อได้รับ RPM ที่ตรง Config');
    else{state('protocol-state',rawLines?'เฟรมไม่ตรง':'บอร์ดไม่ส่งข้อมูล','bad');tuneHelp(rawLines||serialBytes?'ได้รับข้อความจากบอร์ด แต่ยังไม่มีข้อมูลตัวเลขสำหรับกราฟ: ตรวจ Baud rate และข้อมูลดิบด้านล่าง':'พอร์ตเปิดได้ แต่รับข้อมูล 0 ไบต์จากบอร์ด: ตรวจว่า Upload สำเร็จ (Build อย่างเดียวยังไม่แฟลช), ตั้ง BOOT0 = 0 แล้ว Reset, และต่อ PA9 TX → USB-UART RX พร้อม GND ร่วม',true);}
  }
  if(!positionOnly&&portOpenedAt&&now-(lastRpmAt||portOpenedAt)>1500)state('rpm-state','NO DATA','bad');
  if(portOpenedAt&&now-(lastGyroAt||portOpenedAt)>1500)state('gyro-state','NO DATA','bad');
  if(positionOnly&&lastOdomAt&&now-lastOdomAt>1500){protocolVerified=false;$('pose-health').textContent='ODOM หยุดส่งข้อมูล';setControls();}
  else if(positionOnly&&lastOdomAt&&(!lastGyroAt||now-lastGyroAt>1500))$('pose-health').textContent='ODOM กำลังส่ง · ไม่พบเฟรม GYRO สด: ตรวจ BNO08x หากมุม Yaw ไม่เปลี่ยน';
  if(!lastFrameAt)return;const age=now-lastFrameAt,hz=frameTimes.length>1?(frameTimes.length-1)/((frameTimes.at(-1)-frameTimes[0])/1000):0;$('rate-state').textContent=`${hz.toFixed(1)} Hz / ${age} ms`;if(age>1000){state('protocol-state','NO DATA','bad');protocolVerified=false;setControls();}
}

document.addEventListener('DOMContentLoaded',async()=>{
  tuneDashboard=window.TuneDashboard.create({root:$('tune-dashboard'),addButton:$('td-add-chart'),columnsSelect:$('td-columns'),storage:localStorage,robotId:localStorage.getItem('ros2ide_robotid')});
  try{await restore();}catch(error){hardwareConfig={motorCount:2};motors=motorList(hardwareConfig);renderMotors();log(error.message);state('port-state','โหลดไม่ได้','bad');}
  $('refresh-port').onclick=()=>refreshPorts($('tune-port').value);$('connect-button').onclick=connect;$('disconnect-button').onclick=()=>disconnect();$('fix-permission').onclick=fixSerialPermission;$('apply-pid').onclick=applyPid;$('emergency-stop').onclick=stopTest;$('save-tune').onclick=saveTune;
  window.addEventListener('blur',stopTest);document.addEventListener('visibilitychange',()=>{if(document.hidden)stopTest();});window.addEventListener('beforeunload',()=>disconnect());window.addEventListener('resize',()=>tuneDashboard?.resize());setInterval(updateRate,250);
});
