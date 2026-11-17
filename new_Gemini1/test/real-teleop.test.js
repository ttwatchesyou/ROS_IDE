'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/dashboard.js'),'utf8');

function fixture(handler=async()=>({ok:true})){
  const nodes=new Map(),calls=[],sockets=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',options:[],classList:{toggle(){}},add(option){this.options.push(option);},set innerHTML(_){this.options=[];}});return nodes.get(id);}
  class WebSocket{
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=1;sockets.push(this);}
    send(payload){(this.sent||(this.sent=[])).push(JSON.parse(payload));}
    close(){this.readyState=3;this.onclose?.();}
    receive(message){this.onmessage?.({data:JSON.stringify(message)});}
  }
  const context=vm.createContext({RealDriveMotion:require('../public/real-drive-motion'),document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]},WebSocket,
    API:async(url,body)=>{calls.push({url,body});return handler(url,body);},Option:function(text,value){this.text=text;this.value=value;},
    realTeleopDrawMap(){},RealScanTF:{...require('../public/real-scan-transform'),load:async()=>[]},LIDAR_MODELS:[{id:'rplidar_c1',port:'/dev/ttyUSB0',baud:460800}],sessionId:'fixture',wsPath:'/robot',
    location:{protocol:'http:',host:'fixture'},getAuthToken:()=>'',setInterval,clearInterval});
  vm.runInContext(source.slice(source.indexOf('let realTeleopBound='),source.indexOf('function realTeleopDrawMap()')),context);
  node('real-lidar-model').value='rplidar_c1';node('real-lidar-model').options=[{value:'rplidar_c1'}];node('real-controller-baud').value='115200';
  return{context,node,calls,sockets,run:code=>vm.runInContext(code,context)};
}

test('teleop defaults to separate ports and honors saved LiDAR settings',async()=>{
  const f=fixture(async(url,body)=>url==='/api/serial/ports'?{ok:true,ports:[{path:'/dev/ttyUSB0'},{path:'/dev/ttyUSB1'}]}:
    {ok:true,content:JSON.stringify(body.path.endsWith('hardware.json')?{serialPort:'/dev/ttyUSB1',baudRate:57600}:{modelId:'rplidar_c1',port:'/dev/ttyUSB0',baud:460800})});
  await f.run('realTeleopLoadHardware();');await f.run('realTeleopRefreshPorts()');
  assert.equal(f.node('real-controller-port').value,'/dev/ttyUSB1');assert.equal(f.node('real-lidar-port').value,'/dev/ttyUSB0');
  assert.equal(f.node('real-controller-baud').value,57600);
  const defaults=fixture(async()=>({ok:true,ports:[{path:'/dev/ttyUSB0'},{path:'/dev/ttyUSB1'}]}));
  await defaults.run('realTeleopRefreshPorts()');assert.notEqual(defaults.node('real-controller-port').value,defaults.node('real-lidar-port').value);
});

test('a single COM port is not silently reused for LiDAR',async()=>{
  const f=fixture(async()=>({ok:true,ports:[{path:'/dev/ttyUSB0'}]}));await f.run('realTeleopRefreshPorts()');
  assert.equal(f.node('real-lidar-port').value,'');await f.run('realTeleopToggleLidar()');
  assert.equal(f.calls.filter(call=>call.url==='/api/lidar/driver').length,0);
});

test('teleop selects the saved GPIO UART alias while keeping the USB LiDAR separate',async()=>{
  const f=fixture(async()=>({ok:true,ports:[{path:'/dev/ttyUSB0',kind:'usb'},{path:'/dev/ttyAMA0',kind:'uart',aliases:['/dev/serial1']},{path:'/dev/ttyAMA10',kind:'debug-uart',aliases:['/dev/serial0']}]}));
  f.run("realDriveHardware={serialPort:'/dev/serial1'};realDriveLidar={port:'/dev/ttyUSB0'};");
  await f.run('realTeleopRefreshPorts()');assert.equal(f.node('real-controller-port').value,'/dev/ttyAMA0');assert.equal(f.node('real-lidar-port').value,'/dev/ttyUSB0');
});

test('teleop does not automatically choose the Pi debug UART when the GPIO UART is disabled',async()=>{
  const f=fixture(async()=>({ok:true,ports:[{path:'/dev/ttyUSB0',kind:'usb'},{path:'/dev/ttyAMA10',kind:'debug-uart'}],uartHint:'เปิด GPIO UART ก่อน'}));
  f.run("realDriveLidar={port:'/dev/ttyUSB0'};");await f.run('realTeleopRefreshPorts()');
  assert.equal(f.node('real-controller-port').value,'');assert.equal(f.node('real-controller-state').textContent,'เปิด GPIO UART ก่อน');
});

test('both startup orders reject a shared port even while the first request is pending',async()=>{
  for(const first of ['Controller','Lidar']){
    let finish;
    const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
    f.node('real-controller-port').value=f.node('real-lidar-port').value='/dev/ttyUSB0';
    const pending=f.run(`realTeleopToggle${first}()`);
    await f.run(`realTeleopToggle${first==='Controller'?'Lidar':'Controller'}()`);
    await f.run(`realTeleopToggle${first}()`);
    assert.equal(f.calls.length,1,'no overlapping request may touch the reserved port');
    finish({ok:true});await pending;
  }
});

test('different ports can start together and controller serial errors stay visible',async()=>{
  const f=fixture();f.node('real-controller-port').value='/dev/ttyUSB1';f.node('real-lidar-port').value='/dev/ttyUSB0';
  await Promise.all([f.run('realTeleopToggleController()'),f.run('realTeleopToggleLidar()')]);assert.equal(f.sockets.length,2);
  const controller=f.sockets.find(socket=>socket.url.endsWith('/ws/controller-tune'));
  controller.receive({type:'telemetry',data:{event:'permission_denied',message:'Permission denied'}});
  assert.match(f.node('real-controller-state').textContent,/ttyUSB1.*Permission denied/);
  assert.equal(f.run('realControllerConnected'),false);assert.equal(f.run('realLidarRunning'),true);
});

test('old controller close cannot reset a replacement connection',async()=>{
  const f=fixture();f.node('real-controller-port').value='/dev/ttyUSB1';await f.run('realTeleopToggleController()');
  const old=f.sockets[0];old.close=()=>{old.readyState=3;};await f.run('realTeleopToggleController()');await f.run('realTeleopToggleController()');
  f.sockets[1].receive({type:'telemetry',data:{event:'port_open'}});old.onclose();
  assert.equal(f.run('realControllerConnected'),true);assert.match(f.node('real-controller-state').textContent,/CONNECTED/);
});

test('LiDAR startup reports stage and remote log output',async()=>{
  const f=fixture(async()=>({ok:false,stage:'launch-driver',error:'เปิดไม่ได้',output:'serial port busy'}));f.node('real-lidar-port').value='/dev/ttyUSB0';
  await f.run('realTeleopToggleLidar()');assert.match(f.node('real-lidar-state').textContent,/launch-driver[\s\S]*serial port busy/);assert.equal(f.run('realLidarPort'),'');
});

test('teleop map keeps its scale between scans and zooms only with the mouse wheel',()=>{
  const f=fixture(),drawn=[];
  const ctx={setTransform(){},clearRect(){},fillRect(x,y){drawn.push([x,y]);},beginPath(){},moveTo(){},lineTo(){},stroke(){},save(){},translate(){},rotate(){},closePath(){},fill(){},restore(){}};
  const canvas=f.node('real-teleop-map');canvas.getBoundingClientRect=()=>({width:600,height:500});canvas.getContext=()=>ctx;
  f.context.devicePixelRatio=1;
  f.run("realDriveTfModel=[{name:'base_link',type:'base',pos:{x:0,y:0,z:0}},{name:'laser_frame',type:'lidar',parent:'base_link',pos:{x:0,y:0,z:0}}]");
  vm.runInContext(source.slice(source.indexOf('function realTeleopZoomMap('),source.indexOf('function realTeleopBind()')),f.context);
  const point=()=>drawn[1][0];
  f.run('realDriveScan={ranges:[2,20],angleMin:0,angleIncrement:1};realTeleopDrawMap()');const first=point();
  drawn.length=0;f.run('realDriveScan={ranges:[2,200],angleMin:0,angleIncrement:1};realTeleopDrawMap()');
  assert.equal(point(),first);assert.match(f.node('real-map-scale').textContent,/±9\.0 m/);
  let prevented=false;drawn.length=0;f.context.wheelEvent={deltaY:-1,preventDefault(){prevented=true;}};
  f.run('realTeleopZoomMap(wheelEvent)');
  assert.equal(prevented,true);assert.equal(f.run('realTeleopMapExtent'),7.5);
  assert.ok(Math.abs(point()-300)>Math.abs(first-300),'zooming in should move a LiDAR point farther from the map center');
  assert.match(f.node('real-map-scale').textContent,/±7\.5 m/);
});

function mecanumDriveFixture(){
  const f=fixture();
  f.run("realDriveHardware={drive:'mecanum4',motorCount:4,wheelDiameterMm:127,wheelTrackMm:720,wheelBaseMm:600,motorMaxRpm:300};realControllerSocket=new WebSocket('fixture');realControllerConnected=true;");
  f.node('real-teleop-linear').value='.2';f.node('real-teleop-angular').value='.8';return f;
}
test('real Mecanum turn sends opposite left/right wheel RPM, distinct from lateral motion',()=>{
  const f=mecanumDriveFixture();
  for(const [direction,sign] of [['left',1],['right',-1]]){
    f.run(`realDriveKeys=new Set(['${direction}']);realTeleopSendDrive()`);
    const command=f.sockets[0].sent.at(-1).command;
    assert.match(command,/^R /);
    const rpm=command.split(' ').slice(1).map(Number);
    assert.ok(rpm[0]*sign<0&&rpm[1]*sign>0&&rpm[2]*sign<0&&rpm[3]*sign>0);
    assert.equal(rpm[0],rpm[2]);assert.equal(rpm[1],rpm[3]);
    const strafe=f.run('realTeleopMecanumRpmCommand(0,.2,0)').split(' ').slice(1).map(Number);
    assert.ok(strafe[0]<0&&strafe[1]>0&&strafe[2]>0&&strafe[3]<0);
  }
});
test('Mecanum mixed forward and turn preserves proportions and uniformly limits wheel RPM',()=>{
  const f=mecanumDriveFixture();
  f.run("realDriveHardware.motorMaxRpm=20;realDriveKeys=new Set(['fwd','left']);realTeleopSendDrive()");
  const rpm=f.sockets[0].sent.at(-1).command.split(' ').slice(1).map(Number);
  assert.equal(Math.max(...rpm.map(Math.abs)),20);
  assert.equal(rpm[0],rpm[2]);assert.equal(rpm[1],rpm[3]);
  assert.ok(rpm[0]<0&&rpm[1]>0);
});
test('straight Mecanum motion retains firmware heading hold and invalid geometry sends stop',()=>{
  const f=mecanumDriveFixture();f.run("realDriveKeys=new Set(['fwd']);realTeleopSendDrive()");
  assert.equal(f.sockets[0].sent.at(-1).command,'V 0.2000 0 0.0000');
  f.run("realDriveHardware.wheelBaseMm=0;realDriveKeys=new Set(['left']);realTeleopSendDrive()");
  assert.equal(f.sockets[0].sent.at(-1).command,'S');
  assert.match(f.node('real-teleop-status').textContent,/Hardware Config/);
});
test('differential turns retain angular velocity commands and emergency stop clears held directions',()=>{
  const f=mecanumDriveFixture();f.run("realDriveHardware={drive:'diff2',motorCount:2};realDriveKeys=new Set(['left']);realTeleopSendDrive()");
  assert.equal(f.sockets[0].sent.at(-1).command,'V 0.0000 0 0.8000');
  f.run('realTeleopStop()');assert.equal(f.sockets[0].sent.at(-1).command,'S');assert.equal(f.run('realDriveKeys.size'),0);
});

test('Mecanum lateral buttons send a diagonal wheel pattern, independently from rotation',()=>{
  const f=mecanumDriveFixture();
  for(const [direction,sign] of [['strafe-left',1],['strafe-right',-1]]){
    f.run(`realDriveKeys=new Set(['${direction}']);realTeleopSendDrive()`);
    const command=f.sockets[0].sent.at(-1).command,rpm=command.split(' ').slice(1).map(Number);
    assert.match(command,/^R /);assert.ok(rpm[0]*sign<0&&rpm[1]*sign>0&&rpm[2]*sign>0&&rpm[3]*sign<0);
    assert.equal(f.node('real-teleop-command').textContent,command);
  }
});
test('keyboard distinguishes Mecanum strafe and rotation and preserves Differential keys',()=>{
  const f=mecanumDriveFixture();
  for(const [key,direction] of [['a','strafe-left'],['d','strafe-right'],['q','left'],['e','right'],['ArrowLeft','left'],['ArrowRight','right']])assert.equal(f.run(`realTeleopKeyDirection('${key}')`),direction);
  f.run("realDriveHardware={drive:'diff2'}");
  assert.equal(f.run("realTeleopKeyDirection('a')"),'left');assert.equal(f.run("realTeleopKeyDirection('q')"),undefined);
  assert.equal(f.run("realTeleopSetDirection('strafe-left',true)"),false);
  assert.equal(f.run('realDriveKeys.size'),0);
});
test('stopping teleop clears the heartbeat as well as all held directions',()=>{
  const f=mecanumDriveFixture();f.run("realDriveKeys=new Set(['left']);realDriveTimer=setInterval(()=>{},100);realTeleopStop()");
  assert.equal(f.run('realDriveTimer'),null);assert.equal(f.run('realDriveKeys.size'),0);assert.equal(f.sockets[0].sent.at(-1).command,'S');
});
