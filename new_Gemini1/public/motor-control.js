'use strict';
const motorControlToken=getAuthToken();
const motorControlNode=id=>document.getElementById(id);
const motorControlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MOTOR_CONTROL_ROLES={left:'ล้อซ้าย',right:'ล้อขวา',front_left:'ล้อหน้าซ้าย',front_right:'ล้อหน้าขวา',rear_left:'ล้อหลังซ้าย',rear_right:'ล้อหลังขวา',auxiliary:'มอเตอร์เสริม'};
let motorControlSession='',motorControlConfig={},motorControlMotors=[],motorControlSocket=null,motorControlReady=false,motorControlPending=false,motorControlGeneration=0,motorControlHold=null,motorControlTimer=null,motorControlEncoderTimer=null,motorControlEncoderReadings=[],motorControlEncoderSignals=[];
function motorControlState(message,state='wait'){const node=motorControlNode('connection-status');node.textContent=message;node.dataset.state=state;}
function motorControlLog(message){const node=motorControlNode('motor-log');node.textContent=(String(message)+'\n'+node.textContent).slice(0,8000);}
async function motorControlApi(path,body){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders(motorControlToken)},body:JSON.stringify(body)});
  if(response.status===401){clearAuthSession();location.replace('/');throw Error('Session expired');}
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'คำขอไม่สำเร็จ');return result;
}
function motorControlDescribe(config){
  const assignments=Array.isArray(config.assignments)?config.assignments:(config.robotDesign?.wheels||[]);
  const active=assignments.filter(item=>item.motorEnabled!==false),roles=['left','right','front_left','front_right','rear_left','rear_right','auxiliary'];
  const order=RealDriveMotion.isMecanum(config)?RealDriveMotion.controllerWheelOrder(config):roles;active.sort((a,b)=>order.indexOf(a.motorRole)-order.indexOf(b.motorRole));
  const count=Number(config.motorCount??config.robotDesign?.motorCount??active.length);
  if(!Number.isInteger(count)||count<1||count>8||active.length!==count)throw Error('จำนวนมอเตอร์ใน Hardware Config ไม่ครบ กรุณาบันทึก Hardware Wiring ก่อน');
  const keys=active.map(item=>item.motorRole);
  if(keys.some(role=>!roles.includes(role))||new Set(keys).size!==keys.length)throw Error('ตำแหน่งมอเตอร์ใน Hardware Config ซ้ำหรือไม่ถูกต้อง');
  const encoderOrder=[...active].sort((a,b)=>roles.indexOf(a.motorRole)-roles.indexOf(b.motorRole));
  const encoders=Array.isArray(config.encoderAssignments)?config.encoderAssignments:(config.robotDesign?.encoders||[]);
  return active.map((item,index)=>({index,encoderIndex:encoderOrder.indexOf(item),name:item.name||'',role:item.motorRole,label:MOTOR_CONTROL_ROLES[item.motorRole],channel:Number.isInteger(item.hardwareChannel)?item.hardwareChannel+1:index+1,encoderEnabled:item.encoderEnabled===true||encoders.some(encoder=>encoder.enabled!==false&&(encoder.attachedWheel===item.name||encoder.parent===item.name)),diagnostic:config.robotDesign?.hardwareTemplate==='mecanum_xy'}));
}
function motorControlRender(){
  const limit=Math.min(300,Math.max(1,Number(motorControlConfig.motorMaxRpm)||300)),initial=Math.min(30,limit);
  motorControlNode('motor-cards').innerHTML=motorControlMotors.map(motor=>`<article class="motor-card" data-motor-card="${motor.index}"><span class="channel">Driver M${motor.channel} · ช่องคำสั่ง ${motor.index+1}</span><h2>${motorControlEscape(motor.label)}</h2><div class="wheel-name">${motorControlEscape(motor.name)}</div><label class="rpm-setting">ความเร็ว <output id="motor-speed-label-${motor.index}">${initial} RPM</output><input id="motor-speed-${motor.index}" data-speed-index="${motor.index}" type="range" min="1" max="${limit}" step="1" value="${initial}" aria-label="ความเร็ว ${motorControlEscape(motor.label)}"></label><div class="motor-actions"><button type="button" data-motor-index="${motor.index}" data-motor-sign="1" disabled>↑ เดินหน้า</button><button type="button" data-motor-index="${motor.index}" data-motor-sign="-1" disabled>↓ ถอยหลัง</button></div><div class="motor-target">เป้าหมาย <b id="motor-target-${motor.index}">0 RPM</b></div><section class="motor-encoder" aria-label="Encoder ${motorControlEscape(motor.label)}"><div class="encoder-heading"><strong>Encoder</strong><span id="motor-encoder-state-${motor.index}" data-state="waiting">รอข้อมูล</span></div><div class="encoder-values"><div><small>RPM ที่วัดได้</small><b id="motor-measured-${motor.index}">—</b></div><div><small>พัลส์สะสมจากบอร์ด</small><b id="motor-ticks-${motor.index}">—</b></div></div><p class="encoder-signals" id="motor-encoder-signals-${motor.index}">ขา A/B: รอข้อมูลตรวจสอบ</p><p id="motor-encoder-note-${motor.index}">กำลังรอข้อมูล Encoder</p></section></article>`).join('');
  document.querySelectorAll('[data-speed-index]').forEach(input=>input.addEventListener('input',()=>{motorControlNode('motor-speed-label-'+input.dataset.speedIndex).textContent=input.value+' RPM';if(motorControlHold?.index===Number(input.dataset.speedIndex))motorControlSendHold();}));
  document.querySelectorAll('[data-motor-index]').forEach(button=>{
    button.addEventListener('pointerdown',event=>{event.preventDefault();if(motorControlHold)return;try{button.setPointerCapture(event.pointerId);}catch(_){}motorControlStart(Number(button.dataset.motorIndex),Number(button.dataset.motorSign),button,event.pointerId);});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(name,event=>{if(motorControlHold?.button===button&&motorControlHold?.pointerId===event.pointerId)motorControlStop();});
    button.addEventListener('contextmenu',event=>event.preventDefault());
  });
  motorControlResetEncoders();motorControlSetEnabled();
}
function motorControlSetEnabled(){
  document.querySelectorAll('[data-motor-index]').forEach(button=>button.disabled=!motorControlReady);
  motorControlNode('motor-connect').textContent=motorControlSocket?'ตัดการเชื่อมต่อ':'เชื่อมต่อ';
  motorControlNode('motor-connect').disabled=motorControlPending||!motorControlSession||!motorControlMotors.length;
  for(const id of ['motor-port','motor-baud','motor-refresh'])motorControlNode(id).disabled=Boolean(motorControlSocket)||motorControlPending||!motorControlSession;
}
function motorControlResetEncoders(disconnected=false){
  motorControlEncoderReadings=motorControlMotors.map(()=>null);motorControlEncoderSignals=motorControlMotors.map(()=>null);
  for(const motor of motorControlMotors){
    motorControlNode('motor-encoder-signals-'+motor.index).textContent=motor.diagnostic?'ขา A/B: รอข้อมูลตรวจสอบจาก Firmware':'ขา A/B: Firmware นี้ส่งเฉพาะค่าที่อ่านได้';
    motorControlNode('motor-measured-'+motor.index).textContent='—';motorControlNode('motor-ticks-'+motor.index).textContent='—';
    const state=motorControlNode('motor-encoder-state-'+motor.index);state.dataset.state='waiting';state.textContent=disconnected?'ยังไม่เชื่อมต่อ':'รอข้อมูล';
    motorControlNode('motor-encoder-note-'+motor.index).textContent=motor.diagnostic?'อ่านพัลส์แต่ละล้อได้เมื่ออัปโหลด Firmware ที่รองรับ Encoder diagnostic':motor.encoderEnabled?'ค่าที่วัดจาก Encoder แยกจากค่าเป้าหมาย':'ยังไม่เปิด Encoder ของล้อนี้ใน Hardware Config';
  }
}
function motorControlEncoderValue(index,reading){
  const motor=motorControlMotors[index];if(!motor)return;
  motorControlEncoderReadings[index]=reading;
  const state=motorControlNode('motor-encoder-state-'+index),note=motorControlNode('motor-encoder-note-'+index);
  state.dataset.state=reading.available?'live':'disabled';state.textContent=reading.available?'อ่านสด':'ไม่ได้อ่านขานี้';
  motorControlNode('motor-measured-'+index).textContent=reading.available?reading.rpm.toFixed(1)+' RPM':'—';
  motorControlNode('motor-ticks-'+index).textContent=reading.available&&reading.ticks!==null?String(reading.ticks):'—';
  note.textContent=!reading.available?'Firmware ไม่ได้เปิดอ่าน Encoder ขานี้ · ตรวจพินและ Hardware Config':reading.ticks===null?'Firmware ส่ง RPM จริง แต่ยังไม่ส่งจำนวนพัลส์':Math.abs(reading.rpm)<.05?'พัลส์ยังไม่เปลี่ยน / ล้อหยุด':'ทิศ Encoder '+(reading.rpm>0?'บวก (+)':'ลบ (−)');
}
function motorControlEncoderTelemetry(data,now=Date.now()){
  if(data.event!=='frame'||!Array.isArray(data.values)||!data.values.every(value=>typeof value==='number'&&Number.isFinite(value)))return false;
  const values=data.values,count=motorControlMotors.length;
  if(data.kind==='WDIAG'&&values.length===count+3){
    if(values.some((v,i)=>!Number.isInteger(v)||v<0||(i<3?v>=(1<<count):v>0xffffffff)))return false;
    for(const motor of motorControlMotors){const bit=1<<motor.encoderIndex,node=motorControlNode('motor-encoder-signals-'+motor.index);motorControlEncoderSignals[motor.index]={at:now};node.textContent=`A=${values[0]&bit?1:0} B=${values[1]&bit?1:0} · Interrupt ${values[2]&bit?'พร้อม':'ไม่พร้อม'} · ขอบสัญญาณ ${values[3+motor.encoderIndex]}`;}
    return true;
  }
  if(data.kind==='WENC'&&values.length===count*2+1){
    const mask=values.at(-1);if(!Number.isInteger(mask)||mask<0||mask>=(1<<count)||motorControlMotors.some((_,i)=>!Number.isInteger(values[i*2])))return false;
    for(const motor of motorControlMotors)motorControlEncoderValue(motor.index,{available:!!(mask&(1<<motor.encoderIndex)),ticks:values[motor.encoderIndex*2],rpm:values[motor.encoderIndex*2+1],at:now,source:'WENC'});
    return true;
  }
  if(data.kind==='RPM'&&values.length===count*2){
    for(const motor of motorControlMotors){if(motor.diagnostic||!motor.encoderEnabled||motorControlEncoderReadings[motor.index]?.source==='WENC')continue;motorControlEncoderValue(motor.index,{available:true,ticks:null,rpm:values[motor.encoderIndex*2+1],at:now,source:'RPM'});}
    return true;
  }
  return false;
}
function motorControlCheckEncoders(now=Date.now()){
  for(const motor of motorControlMotors){const signal=motorControlEncoderSignals[motor.index];if(signal&&now-signal.at>2000)motorControlNode('motor-encoder-signals-'+motor.index).textContent='ข้อมูลขา A/B ค้าง';}
  for(const motor of motorControlMotors){const reading=motorControlEncoderReadings[motor.index];if(!reading?.available||now-reading.at<=2000)continue;const state=motorControlNode('motor-encoder-state-'+motor.index);state.dataset.state='stale';state.textContent='ข้อมูลค้าง';motorControlNode('motor-measured-'+motor.index).textContent='—';motorControlNode('motor-ticks-'+motor.index).textContent='—';motorControlNode('motor-encoder-note-'+motor.index).textContent='ไม่ได้รับ Encoder เกิน 2 วินาที';}
}
function motorControlStopEncoderWatch(){if(motorControlEncoderTimer)clearInterval(motorControlEncoderTimer);motorControlEncoderTimer=null;}
function motorControlStartEncoderWatch(){motorControlStopEncoderWatch();motorControlEncoderTimer=setInterval(motorControlCheckEncoders,250);}
function motorControlSend(command){
  if(!motorControlReady||motorControlSocket?.readyState!==WebSocket.OPEN)return false;
  motorControlSocket.send(JSON.stringify({type:'command',command,motorCount:motorControlMotors.length}));motorControlNode('motor-command').textContent=command;return true;
}
function motorControlBuildCommand(index,sign,rpm,count){
  if(!Number.isInteger(index)||index<0||index>=count||![1,-1].includes(sign)||!Number.isFinite(rpm)||rpm<=0)throw Error('คำสั่งมอเตอร์ไม่ถูกต้อง');
  return 'R '+Array.from({length:count},(_,i)=>i===index?(sign*rpm).toFixed(4):'0.0000').join(' ');
}
function motorControlSendHold(){
  if(!motorControlHold||!motorControlReady)return motorControlStop();
  const {index,sign}=motorControlHold,limit=Math.min(300,Math.max(1,Number(motorControlConfig.motorMaxRpm)||300));
  const rpm=Math.min(limit,Math.max(1,Number(motorControlNode('motor-speed-'+index).value)||1));
  motorControlSend(motorControlBuildCommand(index,sign,rpm,motorControlMotors.length));
  motorControlNode('motor-target-'+index).textContent=(sign*rpm).toFixed(0)+' RPM';
}
function motorControlStart(index,sign,button,pointerId){
  if(!motorControlReady||motorControlHold||!motorControlMotors[index])return;
  motorControlHold={index,sign,button,pointerId};button.classList.add('on');button.closest('.motor-card').classList.add('active');
  motorControlSendHold();motorControlTimer=setInterval(motorControlSendHold,100);
}
function motorControlStop(){
  if(motorControlTimer)clearInterval(motorControlTimer);motorControlTimer=null;motorControlHold=null;
  document.querySelectorAll('.motor-card.active,.motor-actions .on').forEach(node=>node.classList.remove('active','on'));
  for(const motor of motorControlMotors){const node=motorControlNode('motor-target-'+motor.index);if(node)node.textContent='0 RPM';}
  motorControlSend('S');
}
function motorControlDisconnect(){
  motorControlGeneration++;motorControlStop();motorControlStopEncoderWatch();motorControlResetEncoders(true);const socket=motorControlSocket;motorControlSocket=null;motorControlReady=false;motorControlPending=false;
  try{socket?.close();}catch(_){}motorControlSetEnabled();motorControlState('ตัดการเชื่อมต่อแล้ว');
}
async function motorControlRefresh(){
  try{
    const result=await motorControlApi('/api/serial/ports',{sessionId:motorControlSession}),ports=result.ports||[],select=motorControlNode('motor-port'),previous=select.value||motorControlConfig.serialPort;
    select.innerHTML='<option value="">เลือกพอร์ต Controller</option>';
    for(const port of ports){const option=new Option(`${port.path} · ${port.label||port.path}`,port.path);option.disabled=port.accessible===false||port.consoleInUse;select.add(option);}
    const eligible=ports.filter(port=>port.accessible!==false&&!port.consoleInUse&&port.kind!=='debug-uart');
    select.value=eligible.find(port=>port.path===previous||port.aliases?.includes(previous))?.path||eligible.find(port=>port.kind==='uart')?.path||'';
    motorControlState(result.uartHint||'เลือกพอร์ตแล้วกดเชื่อมต่อ');
  }catch(error){motorControlState(error.message,'error');}
}
async function motorControlConnect(){
  if(motorControlSocket)return motorControlDisconnect();if(motorControlPending)return;
  const port=motorControlNode('motor-port').value,baud=Number(motorControlNode('motor-baud').value);
  if(!port||!Number.isInteger(baud)||baud<9600||baud>3000000)return motorControlState('เลือกพอร์ตและ Baud rate ให้ถูกต้อง','error');
  const generation=++motorControlGeneration;motorControlResetEncoders();motorControlPending=true;motorControlSetEnabled();motorControlState('กำลังเตรียมพอร์ต…');
  try{
    await motorControlApi('/api/serial/prepare',{sessionId:motorControlSession,port});if(generation!==motorControlGeneration)return;
    const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/controller-tune`,['ros2ide',motorControlToken]);motorControlSocket=socket;
    socket.onopen=()=>{if(motorControlSocket===socket)socket.send(JSON.stringify({type:'start',sessionId:motorControlSession,port,baud,motorCount:motorControlMotors.length}));};
    socket.onmessage=event=>{
      if(motorControlSocket!==socket)return;let message;try{message=JSON.parse(event.data);}catch(_){return;}
      const data=message.data||{};
      if(message.type==='error'||['error','permission_denied'].includes(data.event)){motorControlDisconnect();motorControlState(message.message||data.message||'เปิดพอร์ตไม่สำเร็จ','error');return;}
      if(message.type==='telemetry'&&data.event==='port_open'){motorControlReady=true;motorControlPending=false;motorControlSetEnabled();motorControlStartEncoderWatch();motorControlSend('S');motorControlState(`${port} @ ${baud} · พร้อมทดสอบทีละมอเตอร์`,'ready');}
      if(message.type==='telemetry')motorControlEncoderTelemetry(data);
      if(message.type==='telemetry'&&(data.line||data.raw||data.kind))motorControlLog(data.line||data.raw||`${data.kind} ${(data.values||[]).join(' ')}`);
    };
    socket.onclose=()=>{if(motorControlSocket!==socket)return;motorControlStop();motorControlStopEncoderWatch();motorControlResetEncoders(true);motorControlSocket=null;motorControlReady=false;motorControlPending=false;motorControlSetEnabled();motorControlState('Controller หลุด · หยุดส่งคำสั่งแล้ว','error');};
    socket.onerror=()=>{if(motorControlSocket===socket){motorControlDisconnect();motorControlState('เชื่อมต่อ Controller ไม่สำเร็จ','error');}};
  }catch(error){if(generation===motorControlGeneration){motorControlPending=false;motorControlSetEnabled();motorControlState(error.message,'error');}}
}
async function motorControlInit(){
  if(!motorControlToken){location.replace('/');return;}
  motorControlNode('motor-refresh').onclick=motorControlRefresh;motorControlNode('motor-connect').onclick=motorControlConnect;motorControlNode('motor-stop').onclick=motorControlStop;
  window.addEventListener('blur',motorControlStop);window.addEventListener('pagehide',motorControlDisconnect);window.addEventListener('beforeunload',motorControlDisconnect);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)motorControlStop();});document.addEventListener('keydown',event=>{if(event.code==='Space'){event.preventDefault();motorControlStop();}});
  try{
    const restored=await motorControlApi('/api/session/restore',{sessionId:localStorage.getItem('ros2ide_session'),robotId:localStorage.getItem('ros2ide_robotid')});
    if(restored.isSim)throw Error('เครื่องมือนี้ใช้กับหุ่นยนต์จริงเท่านั้น');motorControlSession=restored.sessionId;localStorage.setItem('ros2ide_session',motorControlSession);
    const root=String(restored.workspace||'~/ros2_ws').replace(/\/$/,'');
    const file=await motorControlApi('/api/files/read',{sessionId:motorControlSession,path:root+'/.roside/hardware.json'});motorControlConfig=JSON.parse(file.content);motorControlMotors=motorControlDescribe(motorControlConfig);
    motorControlNode('robot-description').textContent=`${motorControlConfig.driveLabel||motorControlConfig.drive||'หุ่นยนต์จริง'} · ${motorControlMotors.length} มอเตอร์ · ${motorControlConfig.boardLabel||motorControlConfig.controller||'Controller'}`;
    motorControlNode('motor-baud').value=motorControlConfig.baudRate||115200;motorControlRender();motorControlSetEnabled();await motorControlRefresh();
  }catch(error){motorControlNode('motor-cards').textContent='ยังเปิดการ์ดมอเตอร์ไม่ได้ · กลับไปบันทึก Hardware Wiring แล้วเปิดเครื่องมืออีกครั้ง';motorControlState(error.message,'error');}
}
motorControlInit();
