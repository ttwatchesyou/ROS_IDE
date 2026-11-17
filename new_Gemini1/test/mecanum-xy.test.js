'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
function fixture(){
  const storage=new Map(),nodes=new Map();
  const values={'controller-board':'stm32f103','motor-driver':'cycron','bridge-serial-port':'/dev/ttyUSB0','bridge-baud-rate':'115200','command-timeout-ms':'1000','motor-max-rpm':'500','pid-kp':'0.8','pid-ki':'0.35','pid-kd':'0'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:values[id]||'',checked:true,disabled:false});return nodes.get(id);};
  const c=vm.createContext({RobotVisuals:require('../public/robot-visuals'),isSimWorkspace:false,sessionId:'xy',getAuthToken:()=> 'test',
    window:{addEventListener(){},confirm:()=>true},document:{getElementById:()=>null,querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},sbMsg(){},escH:String,encArg:encodeURIComponent,setTimeout,requestAnimationFrame(){},THREE:{MathUtils:{degToRad:d=>d*Math.PI/180}}});
  const run=s=>vm.runInContext(s,c);
  run(fs.readFileSync('public/transformation.js','utf8').replace("let sessionId",'let unusedSessionId'));
  run("tfApplyRobotTemplate('mecanum_xy');globalThis.model=tf.comps;globalThis.odom=JSON.parse(tfBuildOdomConfig());");
  for(const file of ['mecanum-xy-source.js','mecanum-xy.js','hardware.js'])run(fs.readFileSync('public/'+file,'utf8').replace(/\ninit\(\);\s*$/,''));
  c.document.getElementById=node;
  run('robotDesign=deriveRobotDesign(model,odom);');
  return {c,run,node,storage};
}
test('XY template survives detection/export and generates six independent encoders with correct pins',()=>{
  const {run}=fixture();
  assert.equal(run('odom.wheels.length'),4);assert.equal(run('odom.encoders.length'),6);
  assert.equal(run('odom.wheels[0].radius'),.0635);
  assert.equal(run('odom.encoders.filter(e=>!e.attached_wheel).length'),2);
  assert.equal(run('robotDesign.hardwareTemplate'),'mecanum_xy');
  assert.equal(run('robotDesign.wheelDiameterMm'),127);
  assert.equal(run('robotDesign.encoders.filter(e=>e.role==="motor_feedback").length'),4);
  run('globalThis.config=currentConfig();globalThis.firmware=firmwareSourceWithAssignments(config);');
  const source=run('firmware');
  assert.match(source,/MECANUM_HALF_LENGTH_M = 0.300000f/);assert.match(source,/MECANUM_HALF_WIDTH_M = 0.360000f/);
  assert.deepEqual(Array.from(run('motorPinData().map(m=>[m.encA,m.encB])'),pair=>Array.from(pair)),[['PA0','PA1'],['PA2','PA3'],['PA4','PA5'],['PA6','PA7']]);
  assert.match(source,/\{PA0, PA1, PA8, PB12, TIM1, 1, false, false, true \}/);
  assert.match(source,/\{PA2, PA3, PB6, PB15, TIM4, 1, true, true, false \}/);
  assert.match(source,/\{PA4, PA5, PB7, PB13, TIM4, 2, false, true, false \}/);
  assert.match(source,/\{PA6, PA7, PB8, PB14, TIM4, 3, true, true, false \}/);
  assert.doesNotMatch(source,/state\.raw_rpm = \(ticks\[i\]/);
  assert.doesNotMatch(source,/attachInterrupt\(digitalPinToInterrupt\(WHEELS\[(?:FL|FR|RL|RR)\].*encoder(?:FL|FR|RL|RR)/);
  assert.doesNotMatch(source,/tunerSerial\.print\("ENC "\)/);
  assert.match(source,/const bool other_phase = \(GPIOA->IDR >> other_bit\) & 1u/);
  assert.match(source,/ODOM_X_ENCODER_A = PB0/);assert.match(source,/ODOM_Y_ENCODER_A = PB9/);
  assert.match(source,/ODOM_TICKS_PER_REV = 600.000000f/);
  assert.match(source,/T:GOAL:/);assert.match(source,/T:SAFE_STOP:timeout/);assert.match(source,/ODOM_OUTLIER/);
  assert.doesNotMatch(source,/#include "/,'all local headers are bundled');
  run('tfOdomDetect()');assert.equal(run('tf.odom.encoders.filter(e=>!e.attachedWheel).length'),2);
  run('robotDesign.encoders.find(e=>e.role==="odom_x").enabled=false');
  assert.throws(()=>run('currentConfig()'),/Encoder/);
});
test('Mecanum X/Y pin swap changes firmware and saved option without swapping axis calibration',()=>{
  const {run,storage}=fixture();
  run('renderAssignments=()=>{};renderDiagram=()=>{};refreshCodePreview=()=>{};');
  const normal=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(normal,/ODOM_X_ENCODER_A = PB0/);
  assert.match(normal,/ODOM_Y_ENCODER_A = PB9/);
  run("setMecanumOdomSwap('swapped')");
  assert.equal(run('currentConfig().odomSwapXY'),true);
  run("globalThis.odomSwapPreview={innerHTML:''};renderMecanumAssignments(odomSwapPreview)");
  assert.match(run('odomSwapPreview.innerHTML'),/X = PB9\/PB5, Y = PB0\/PB1/);
  assert.match(run('odomSwapPreview.innerHTML'),/A PB9 \/ B PB5/);
  const swapped=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(swapped,/ODOM_X_ENCODER_A = PB9/);
  assert.match(swapped,/ODOM_X_ENCODER_B = PB5/);
  assert.match(swapped,/ODOM_Y_ENCODER_A = PB0/);
  assert.match(swapped,/ODOM_Y_ENCODER_B = PB1/);
  assert.match(swapped,/ODOM_X_ENCODER_INVERTED = true/);
  assert.match(swapped,/ODOM_Y_ENCODER_INVERTED = false/);
  assert.match(swapped,/attachInterrupt\(digitalPinToInterrupt\(ODOM_X_ENCODER_A\), encoderOdomX/);
  assert.match(run('readmeWithAssignments(currentConfig())'),/X: A PB9, B PB5/);
  assert.equal(storage.get('roside_hardware_config_default_odom_swap'),'1');
  run('applySavedOptions()');assert.equal(run('currentConfig().odomSwapXY'),true);
  run('restoreMecanumAssignments()');assert.equal(run('currentConfig().odomSwapXY'),false);
});
test('right-side motor polarity is applied to FR/RR by role, independent of wheel array order',()=>{
  const {run}=fixture();
  assert.deepEqual(Array.from(run('robotDesign.wheels.map(w=>w.motorInvert)')),[false,true,false,true]);
  const source=run('MecanumXY.firmware(currentConfig(),motorPinData().reverse())');
  assert.match(source,/\{PA0, PA1, PA8, PB12, TIM1, 1, false, false, true \}/);
  assert.match(source,/\{PA2, PA3, PB6, PB15, TIM4, 1, true, true, false \}/);
  assert.match(source,/\{PA4, PA5, PB7, PB13, TIM4, 2, false, true, false \}/);
  assert.match(source,/\{PA6, PA7, PB8, PB14, TIM4, 3, true, true, false \}/);
  assert.doesNotMatch(source,/T:SAFE_STOP:wheel_direction:/);
  assert.doesNotMatch(source,/T:ERR:WHEEL_DIRECTION_LATCHED/);
  assert.equal(run('currentConfig().version'),18);
});
test('older saved Mecanum XY assignments receive right-side correction once',()=>{
  const {run,storage}=fixture();
  const saved=JSON.parse(run('JSON.stringify(currentConfig())'));
  saved.version=14;saved.assignments.forEach(a=>a.motorInvert=false);
  storage.set('roside_hardware_config_default',JSON.stringify(saved));
  run('applySavedOptions()');
  assert.deepEqual(Array.from(run('robotDesign.wheels.map(w=>w.motorInvert)')),[false,true,false,true]);
  saved.version=15;storage.set('roside_hardware_config_default',JSON.stringify(saved));
  run('applySavedOptions()');
  assert.deepEqual(Array.from(run('robotDesign.wheels.map(w=>w.motorInvert)')),[false,false,false,false]);
});
test('disabled motor-speed encoders generate feed-forward wheels while passive X/Y remain required',()=>{
  const {run}=fixture();
  run("robotDesign.encoders.find(e=>e.attachedWheel==='mecanum_fr').enabled=false");
  let source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(source,/WHEEL_ENCODER_AVAILABLE\[WHEEL_COUNT\] = \{false, false, false, false\}/);
  assert.match(source,/FR motor-speed encoder interrupt disabled/);
  assert.match(source,/if \(!WHEEL_ENCODER_AVAILABLE\[i\]\) \{/);
  run('robotDesign.encoders.filter(e=>e.attachedWheel).forEach(e=>e.enabled=false)');
  run('syncDesignAssignments()');
  assert.deepEqual(Array.from(run('currentConfig().assignments.map(w=>w.encoderEnabled)')),[false,false,false,false]);
  source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(source,/WHEEL_ENCODER_AVAILABLE\[WHEEL_COUNT\] = \{false, false, false, false\}/);
  assert.match(source,/heading_available = imu_fresh \|\| encoders_valid/);
  assert.match(source,/ODOM_X_ENCODER_A = PB0/);
  assert.match(source,/ODOM_Y_ENCODER_A = PB9/);
  assert.match(run('readmeWithAssignments(currentConfig())'),/FR: feed-forward \(encoder disabled\)/);
  run("robotDesign.encoders.find(e=>e.role==='odom_x').enabled=false");
  assert.throws(()=>run('currentConfig()'),/Encoder/);
});
test('Mecanum firmware and bridge use the same four-wheel tune frames as differential',()=>{
  const {run,storage}=fixture();
  const saved=JSON.parse(run('JSON.stringify(currentConfig())'));
  saved.pid.motors=[{kp:.11,ki:.21,kd:.01},{kp:.12,ki:.22,kd:.02},{kp:.13,ki:.23,kd:.03},{kp:.14,ki:.24,kd:.04}];
  storage.set('roside_hardware_config_default',JSON.stringify(saved));
  run('applySavedOptions()');
  const source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(source,/ROSIDE_CONTROLLER_READY/);
  assert.match(source,/tunerSerial\.println\("ROSIDE_BOOT"\)/);
  assert.match(source,/int retries = 5;/);
  assert.doesNotMatch(source,/tunerSerial\.print\("RPM"\)/);
  assert.match(source,/tunerSerial\.print\("GYRO "\)/);
  assert.doesNotMatch(source,/T:TARGET:|T:TEL:/,'duplicate legacy frames must not consume BluePill FLASH');
  assert.doesNotMatch(source,/T:POSE:/,'ODOM carries the same position without a duplicate frame');
  assert.match(source,/tunerSerial\.print\("ODOM "\)/);
  assert.match(source,/SH2_GYROSCOPE_CALIBRATED/);
  assert.match(source,/command = "T:WHEEL_RPM:" \+ values/);
  assert.match(source,/command = "T:WHEEL_PID:" \+ values/);
  assert.match(source,/float values\[WHEEL_COUNT \* 3\]/);
  assert.match(source,/tunerSerial\.print\("PID"\)/);
  assert.match(source,/saved_wheel_pid\[WHEEL_COUNT\] = \{\{0\.110000f, 0\.210000f, 0\.010000f/);
  const bridge=run('MecanumXY.bridge(controllerBridgePython())');
  assert.match(bridge,/len\(fields\) == 9 and fields\[0\] == 'RPM'/);
  assert.doesNotMatch(bridge,/len\(fields\) == 5 and fields\[0\] == 'RPM'/);
});
test('Robot Tune orders Mecanum channels FL FR RL RR and offers BNO08x gyro graph',()=>{
  const source=fs.readFileSync('public/tune.js','utf8');
  const code=source.slice(source.indexOf('function motorList('),source.indexOf('function savedPidFor('));
  const context=vm.createContext({ROLE_LABELS:{front_left:'FL',front_right:'FR',rear_left:'RL',rear_right:'RR'}});
  vm.runInContext(code,context);
  const assignments=['rear_right','front_right','rear_left','front_left'].map(motorRole=>({motorRole,name:motorRole,motorEnabled:true,encoderEnabled:true}));
  const config={robotDesign:{hardwareTemplate:'mecanum_xy'},motorCount:4,assignments,accessories:['bno08x']};
  context.config=config;
  assert.deepEqual(Array.from(vm.runInContext('motorList(config).map(motor=>motor.key)',context)),['front_left','front_right','rear_left','rear_right']);
  assert.equal(vm.runInContext('configuredGyro(config).enabled',context),true);
});
test('Robot Tune forwards four-wheel RPM and gyro frames to the data-driven dashboard',()=>{
  const source=fs.readFileSync('public/tune.js','utf8');
  const code=source.slice(source.indexOf('function handleTelemetry('),source.indexOf('function sendCommand('));
  const helper=source.slice(source.indexOf('function tuneHelp('),source.indexOf('async function api('));
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',classList:{toggle(){}}});return nodes.get(id);};
  const ingested=[];
  const context=vm.createContext({$:node,Date,Number,motors:Array.from({length:4},(_,index)=>({index,hasEncoder:true})),gyroCapability:{enabled:true},
    positionOnly:false,lastOdomAt:0,protocolVerified:false,validFrames:0,invalidFrames:0,rpmFrames:0,gyroFrames:0,pidAcks:0,rawLines:0,serialBytes:0,serialLines:0,legacyFirmware:false,lastFrameAt:0,lastRpmAt:0,lastGyroAt:0,portOpenedAt:0,
    frameTimes:[],tuneDashboard:{ingest:frame=>ingested.push(frame)},state(){},log(){},setControls(){}});
  vm.runInContext(helper+code,context);
  vm.runInContext("handleTelemetry({event:'frame',kind:'RPM',values:[10,9,20,19,30,29,40,39],line:'RPM 10 9 20 19 30 29 40 39'})",context);
  assert.equal(context.rpmFrames,1);assert.equal(context.protocolVerified,true);
  assert.equal(ingested[0].values[6],40);
  vm.runInContext("handleTelemetry({event:'frame',kind:'GYRO',values:[1,2,3],line:'GYRO 1 2 3'})",context);
  assert.equal(context.gyroFrames,1);assert.equal(ingested[1].values[2],3);
  vm.runInContext("handleTelemetry({event:'frame',kind:'ENC',values:[12,0,15],line:'ENC 12 0 15'})",context);
  assert.equal(ingested[2].kind,'ENC');
  assert.match(node('encoder-diagnostic').textContent,/FR \(PA2\/PA3\) ticks 12 · RL \(PA4\/PA5\) ticks 0/);
  assert.match(node('encoder-diagnostic').textContent,/PA0=1.*PA4=0/);
  vm.runInContext("handleTelemetry({event:'invalid_frame',line:'T:TEL:123'})",context);
  assert.equal(context.invalidFrames,0,'legacy diagnostic frames must not pollute the graph status');
  assert.equal(context.legacyFirmware,true);
  assert.match(node('tune-help').textContent,/Upload Firmware Mecanum ล่าสุด/);
  context.legacyFirmware=false;context.lastRpmAt=0;context.portOpenedAt=Date.now()-10000;
  vm.runInContext("handleTelemetry({event:'serial_status',bytesReceived:0,linesReceived:0})",context);
  assert.match(node('tune-help').textContent,/รับข้อมูล 0 ไบต์/);
  assert.equal(node('serial-rx-state').textContent,'0 bytes / 0 lines');
});
test('Robot Tune explains a silent open port instead of leaving no-data graphs unexplained',()=>{
  const source=fs.readFileSync('public/tune.js','utf8');
  const helper=source.slice(source.indexOf('function tuneHelp('),source.indexOf('async function api('));
  const rate=source.slice(source.indexOf('function updateRate('),source.indexOf("document.addEventListener('DOMContentLoaded'"));
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',classList:{toggle(){}}});return nodes.get(id);};
  const context=vm.createContext({$:node,Date,positionOnly:false,lastOdomAt:0,portOpenedAt:Date.now()-31000,lastFrameAt:0,lastRpmAt:0,lastGyroAt:0,rawLines:0,serialBytes:0,legacyFirmware:false,noDataHintShown:false,tuneDashboard:null,
    motors:[],gyroCapability:{enabled:false},frameTimes:[],log(){},state(){},setControls(){}});
  vm.runInContext(helper+rate+'updateRate()',context);
  assert.match(node('tune-help').textContent,/Build อย่างเดียวยังไม่แฟลช/);
  assert.match(node('tune-help').textContent,/PA9 TX/);
});
test('held wheel test refreshes the command before controller timeout and stops on release',()=>{
  const source=fs.readFileSync('public/tune.js','utf8');
  const code=source.slice(source.indexOf('function stopTest('),source.indexOf('async function fixSerialPermission('));
  const sent=[];let tick,cleared=false;
  const button={dataset:{motor:'2'},classList:{add(){},remove(){}}};
  const context=vm.createContext({$:id=>({value:id==='test-rpm'?'30':'0.1'}),document:{querySelectorAll:()=>[button]},
    motors:Array.from({length:4},()=>({})),protocolVerified:true,socket:{readyState:1},WebSocket:{OPEN:1},holdTimer:null,
    sendCommand:command=>sent.push(command),setInterval:fn=>{tick=fn;return 7;},clearInterval:()=>{cleared=true;}});
  vm.runInContext(code,context);
  vm.runInContext('startTest(button,"motor")',Object.assign(context,{button}));
  assert.deepEqual(sent,['R 0 0 30 0']);
  tick();assert.deepEqual(sent,['R 0 0 30 0','R 0 0 30 0']);
  vm.runInContext('stopTest()',context);
  assert.equal(cleared,true);assert.equal(sent.at(-1),'S');
});
test('generated ROS bridge has valid Python and transports strafe, world goals, keepalive and stop',()=>{
  const {run}=fixture(),source=run('MecanumXY.bridge(controllerBridgePython())');
  const check=spawnSync('python3',['-c',`import ast,sys,math
source=sys.stdin.read(); tree=ast.parse(source)
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef))
methods=[n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name in ('_cmd_vel','_position_goal')]
ns={'math':math}; exec(compile(ast.Module(body=methods,type_ignores=[]),'bridge','exec'),ns)
class Fake:
 def __init__(self): self.sent=[]
 def _write(self,c): self.sent.append(c)
 def get_logger(self): return self
 def warning(self,c): pass
class Msg: pass
f=Fake(); m=Msg(); m.data=[1.,2.,.5]; ns['_position_goal'](f,m)
assert f.sent[-1]=='T:GOAL:1.000000:2.000000:0.500000'
m.data=[float('nan'),0,0]; ns['_position_goal'](f,m); assert len(f.sent)==1
m.linear=Msg();m.angular=Msg();m.linear.x=0;m.linear.y=.25;m.angular.z=0
ns['_cmd_vel'](f,m); assert f.sent[-1]=='V 0.000000 0.250000 0.000000'
`],{input:source,encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);assert.match(source,/position_keepalive/);assert.match(source,/b'T:STOP\\n'/);
  assert.doesNotMatch(source,/self.create_subscription\(Float32MultiArray, '\/controller\/tune_rpm'/);
});
test('mecanum inverse kinematics: forward, left, CCW and uniform saturation',()=>{
  const {run}=fixture(),source=run('firmwareSourceWithAssignments(currentConfig())');
  const start=source.indexOf('inline void mecanumTwistToRpm');let end=start,depth=0,opened=false;
  for(;end<source.length;end++){if(source[end]==='{'){depth++;opened=true;}if(source[end]==='}'&&--depth===0&&opened){end++;break;}}
  // Extract the function using balanced braces, then run it against real floats.
  const cpp=`#include <cmath>\n#include <algorithm>\n#include <cassert>\n#include <cstdint>\nusing std::max;\nconstexpr float PI=3.141592653589793f,DRIVE_WHEEL_RADIUS_M=.0635f,MAX_RPM=500,MECANUM_HALF_LENGTH_M=.3f,MECANUM_HALF_WIDTH_M=.36f;\nenum{FL,FR,RL,RR,WHEEL_COUNT};\nstruct MecanumTwist{float vx_mps,vy_mps,wz_radps;};\n${source.slice(start,end)}\nint main(){float r[4];mecanumTwistToRpm({1,0,0},r);for(float v:r)assert(v>0);mecanumTwistToRpm({0,1,0},r);assert(r[0]<0&&r[1]>0&&r[2]>0&&r[3]<0);mecanumTwistToRpm({0,0,1},r);assert(r[0]<0&&r[1]>0&&r[2]<0&&r[3]>0);mecanumTwistToRpm({10,5,2},r);float peak=0;for(float v:r)peak=max(peak,fabsf(v));assert(fabsf(peak-500)<.001f);}`;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mecanum-xy-')),binary=path.join(dir,'check');
  try{const build=spawnSync('g++',['-x','c++','-std=c++17','-o',binary,'-'],{input:cpp,encoding:'utf8'});assert.equal(build.status,0,build.stderr);assert.equal(spawnSync(binary).status,0);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('replacing an existing template does not inherit disabled motors or encoders from browser ODOM',()=>{
  const {run,storage,c}=fixture();
  const bad=JSON.parse(run('JSON.stringify(tf.odom)'));
  bad.wheels.forEach(w=>{w.motorEnabled=false;w.encoderEnabled=false;});bad.encoders.forEach(e=>e.enabled=false);
  storage.set('tf_odom_xy',JSON.stringify(bad));
  c.document.getElementById=()=>null;
  run("tfApplyRobotTemplate('mecanum_xy');globalThis.model=tf.comps;globalThis.odom=JSON.parse(tfBuildOdomConfig());robotDesign=deriveRobotDesign(model,odom);");
  assert.equal(run('robotDesign.wheels.filter(w=>w.motorEnabled).length'),4);
  assert.equal(run('robotDesign.wheels.filter(w=>w.encoderEnabled).length'),0);
  assert.equal(run('robotDesign.encoders.filter(e=>e.enabled).length'),2);
});
test('model metadata recovers omitted encoder config without borrowing another encoder by array index',()=>{
  const {run}=fixture();
  run("odom.encoders=odom.encoders.filter(e=>e.name==='encoder_odom_y');robotDesign=deriveRobotDesign(model,odom);");
  assert.equal(run('robotDesign.encoders.filter(e=>e.attachedWheel).length'),4);
  assert.equal(run('robotDesign.encoders.find(e=>e.name==="encoder_mecanum_fr").invert'),-1);
  assert.equal(run('robotDesign.encoders.find(e=>e.name==="encoder_odom_x").role'),'odom_x');
  assert.doesNotThrow(()=>run('currentConfig()'));
});
test('reference reset repairs saved disabled assignments; disabled FL never moves FR wiring to FL pins',()=>{
  const {run}=fixture();
  run("robotDesign.wheels[0].motorEnabled=false;robotDesign.encoders.forEach(e=>e.enabled=false);");
  assert.equal(run('motorPinData()[0].pwm'),'PB6');
  run("renderAssignments=()=>{};renderSummary=()=>{};renderDiagram=()=>{};refreshCodePreview=()=>{};restoreMecanumAssignments();");
  assert.doesNotThrow(()=>run('currentConfig()'));
  assert.equal(run('motorPinData().filter(m=>m.encoderEnabled).length'),0);
  assert.equal(run('robotDesign.encoders.filter(e=>e.enabled&&!e.attachedWheel).length'),2);
});


test('hardware export includes the patched BNO08x library and licenses in the Local workspace',async()=>{
  const {run,c}=fixture();const calls=[];
  c.capture=async(endpoint,payload)=>{calls.push({endpoint,...payload});return {ok:true};};
  run("api=capture;sessionId='local-test';workspace='/tmp/robot-ws';");
  await run('writeHardwareFiles()');
  const files=calls.filter(c=>c.endpoint==='/api/files/write');
  const header=files.find(c=>c.path.endsWith('/lib/Adafruit BNO08x/src/Adafruit_BNO08x.h'));
  assert.match(header.content,/initStage/);assert.match(header.content,/initStatus/);
  for(const name of ['license.txt','src/NOTICE.txt','LOCAL_CHANGES.md','src/sh2.c'])assert.ok(files.some(c=>c.path.endsWith('/lib/Adafruit BNO08x/'+name)),name);
  assert.doesNotMatch(files.find(c=>c.path.endsWith('/platformio.ini')).content,/adafruit\/Adafruit BNO08x@/);
});


test('PlatformIO preflight names a missing patched BNO08x library before compilation',()=>{
  const {run}=fixture();
  const script=run('platformioTaskScript("/tmp/robot-ws/src/roside_stm32_base/firmware", "", "ROSIDE_DONE_")');
  assert.match(script,/grep -Fq 'bno08x\.initStage'/);
  assert.match(script,/Update Local Agent, reload Hardware Wiring, then regenerate firmware/);
});
test('generated Mecanum XY firmware builds for Blue Pill with the bundled BNO08x library',{
  skip:!process.env.ROSIDE_TEST_PIO,timeout:600000,
},async()=>{
  const {run,c}=fixture(),files=[];
  c.capture=async(endpoint,payload)=>{if(endpoint==='/api/files/write')files.push(payload);return {ok:true};};
  run("api=capture;sessionId='local-pio-test';workspace='/tmp/roside-local-pio';");
  for(const swappedOdomAxes of [false,true]){
    files.length=0;
    if(swappedOdomAxes)run('odomSwapXY=true');
    await run('writeHardwareFiles()');
    const project=fs.mkdtempSync(path.join(os.tmpdir(),'roside-mecanum-build-'));
    try{
      for(const file of files){
        const marker='/firmware/',offset=file.path.indexOf(marker);
        if(offset<0)continue;
        const target=path.join(project,file.path.slice(offset+marker.length));
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content);
      }
      const build=spawnSync(process.env.ROSIDE_TEST_PIO,['run','-d',project,'-j','2'],{encoding:'utf8',timeout:550000,maxBuffer:8*1024*1024});
      assert.equal(build.status,0,[build.error,build.stdout,build.stderr].filter(Boolean).join('\n'));
      assert.ok(fs.statSync(path.join(project,'.pio/build/stm32f103/firmware.bin')).size>0);
    }finally{fs.rmSync(project,{recursive:true,force:true});}
  }
});

// Pin overrides must reach both the diagram data and exported firmware.
test('Mecanum pin selections preserve PWM timers and remap DIR and passive encoder firmware',()=>{
  const {run}=fixture();
  run("hardwarePinAssignments[pinScope()]={'motor:mecanum_fl:in1':'PA4','odom:x:encA':'PA0'}");
  // Use the actual model wheel name rather than depending on naming conventions.
  run("hardwarePinAssignments[pinScope()]['motor:'+robotDesign.wheels.find(w=>w.motorRole==='front_left').name+':in1']='PA4'");
  const source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(source,/\{PA0, PA1, PA8, PA4, TIM1, 1,/);
  assert.match(source,/ODOM_X_ENCODER_A = PA0;/);
  assert.equal(run("motorPinData()[0].in1"),'PA4');
  run("hardwarePinAssignments[pinScope()]['odom:x:encA']='PB9'");
  assert.throws(()=>run('currentConfig()'),/ซ้ำ/);
});

test('pin overrides restore per robot, remain scoped by controller, and reject reserved UART pins',()=>{
  const {run,storage,node}=fixture();
  const name=run("robotDesign.wheels.find(w=>w.motorRole==='front_left').name");
  storage.set('roside_hardware_config_default_pins',JSON.stringify({'stm32f103:mecanum_xy':{['motor:'+name+':in1']:'PA4'}}));
  run('applySavedOptions()');
  assert.equal(run("motorPinData()[0].in1"),'PA4');
  node('controller-board').value='esp32';
  assert.equal(run("motorPinData()[0].in1"),'PB12');
  node('controller-board').value='stm32f103';
  assert.equal(run("motorPinData()[0].in1"),'PA4');
  assert.equal(run("pinChoices().includes('PA9')||pinChoices().includes('PA10')"),false);
  assert.equal(run("allowedPin('PC13','pwm')"),false);
  assert.match(run("pinLocation('PA0')"),/แถวซ้าย.*5/);
});

test('driver wheel selection exchanges roles while preserving electrical channels, pins and PWM timers',()=>{
  const {run,node,storage}=fixture();
  run('renderAssignments=()=>{};renderSummary=()=>{};renderDiagram=()=>{};');node('code-modal').hidden=true;
  const name=run("robotDesign.wheels.find(w=>w.motorRole==='front_left').name");
  run(`assignHardwareMotorRole(${JSON.stringify(name)},'rear_right')`);
  assert.deepEqual(Array.from(run('hardwareDisplayMotors().map(m=>m.motorRole)')),['rear_right','front_right','rear_left','front_left']);
  assert.deepEqual(Array.from(run('hardwareDisplayMotors().map(m=>m.pwm)')),['PA8','PB6','PB7','PB8']);
  assert.equal(run('new Set(motorPinData().map(m=>m.motorRole)).size'),4);
  const source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(source,/\{PA6, PA7, PB8, PB14, TIM4, 3,/);
  assert.match(source,/\{PA0, PA1, PA8, PB12, TIM1, 1,/);
  storage.set('roside_hardware_config_default',run('JSON.stringify(currentConfig())'));
  run('robotDesign=deriveRobotDesign(model,odom);applySavedOptions();');
  assert.deepEqual(Array.from(run('hardwareDisplayMotors().map(m=>m.motorRole)')),['rear_right','front_right','rear_left','front_left']);
  assert.deepEqual(Array.from(run('hardwareDisplayMotors().map(m=>m.pwm)')),['PA8','PB6','PB7','PB8']);
});

test('wheel diagnostics avoid passive odometry EXTI lines and exclude conflicting pins without enabling wheel PID',()=>{
  const {run}=fixture();
  const plan=JSON.parse(run('JSON.stringify(MecanumXY.encoderDiagnosticPlan(currentConfig(),motorPinData()))'));
  assert.equal(plan.mask,15);assert.deepEqual(plan.onB,[true,false,false,false]);
  const source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.match(source,/kWheelDiagnosticMask = 15;/);assert.match(source,/kWheelDiagnosticOnB\[WHEEL_COUNT\] = \{true, false, false, false\}/);
  assert.match(source,/tunerSerial\.print\("WENC"\)/);assert.match(source,/setupWheelEncoderDiagnostics\(\);/);
  assert.match(source,/WHEEL_ENCODER_AVAILABLE\[WHEEL_COUNT\] = \{false, false, false, false\}/);
  assert.equal(run("(()=>{const motors=motorPinData();motors[0].encA='PB0';return MecanumXY.encoderDiagnosticPlan(currentConfig(),motors).mask})()"),14);
  assert.equal(run("(()=>{const motors=motorPinData();motors[1].encA='PA9';return MecanumXY.encoderDiagnosticPlan(currentConfig(),motors).mask})()"),13);
  assert.equal(run("(()=>{const motors=motorPinData();motors[0].encA='PA9';motors[0].encB='PA10';return MecanumXY.encoderDiagnosticPlan(currentConfig(),motors).mask})()"),14);
});

test('opening Hardware in a new browser restores the robot saved pins and motor roles',async()=>{
  const {run,c,storage}=fixture();
  const saved=JSON.parse(run('JSON.stringify(currentConfig())'));
  saved.updatedAt='2026-11-14T12:00:00Z';saved.assignments[0].motorInvert=true;
  saved.pinAssignments={'stm32f103:mecanum_xy':{'odom:x:encA':'PB9','odom:x:encB':'PB5','odom:y:encA':'PB0','odom:y:encB':'PB1'}};
  c.saved=saved;run('api=async()=>({ok:true,content:JSON.stringify(saved)})');
  await run('restoreWorkspaceHardwareOptions()');run('applySavedOptions()');
  assert.equal(run('motorPinData()[0].motorInvert'),true);
  assert.equal(run("mappedPin('odom:x:encA','PB0')"),'PB9');
  assert.equal(JSON.parse(storage.get('roside_hardware_config_default')).updatedAt,saved.updatedAt);
});
test('newer browser hardware changes survive an older workspace config and missing config is optional',async()=>{
  const {run,c,storage}=fixture();const saved=JSON.parse(run('JSON.stringify(currentConfig())'));saved.updatedAt='2026-11-14T12:00:00Z';c.saved=saved;
  storage.set('roside_hardware_config_default',JSON.stringify({...saved,updatedAt:'2026-11-14T13:00:00Z',serialPort:'/dev/ttyUSB1'}));
  run('api=async()=>({ok:true,content:JSON.stringify(saved)})');await run('restoreWorkspaceHardwareOptions()');
  assert.equal(JSON.parse(storage.get('roside_hardware_config_default')).serialPort,'/dev/ttyUSB1');
  run("api=async()=>({ok:false,error:'File not found'})");await run('restoreWorkspaceHardwareOptions()');
  assert.equal(JSON.parse(storage.get('roside_hardware_config_default')).serialPort,'/dev/ttyUSB1');
});

test('diagnostic interrupts start after IMU and repair their own EXTI lines while preserving passive odometry',()=>{
  const {run}=fixture();const source=run('firmwareSourceWithAssignments(currentConfig())');
  assert.ok(source.indexOf('imu_ok = initialiseImu();')<source.indexOf('  setupWheelEncoderDiagnostics();'));
  const diagnostic=source.slice(source.indexOf('constexpr uint8_t kWheelDiagnosticMask'),source.indexOf('\nvoid setup() {'));
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'roside-wheel-irq-test-'));
  try{
    const cpp=`#include <cstdint>
#include <cassert>
#include <string>
constexpr uint8_t WHEEL_COUNT=4;constexpr int INPUT_PULLUP=2,RISING=3;
enum IRQn_Type {EXTI0_IRQn=6,EXTI9_5_IRQn=23,EXTI15_10_IRQn=40};
struct Afio {uint32_t EXTICR[4]={};} afio;
struct Exti {uint32_t IMR=0,RTSR=0;} exti;
Afio *AFIO=&afio;Exti *EXTI=&exti;
struct WheelConfig {uint32_t encoder_a,encoder_b;bool encoder_inverted;};
const WheelConfig WHEELS[4]={{0,1,false},{2,3,true},{4,5,true},{6,7,true}};
bool irq_enabled[64]={};int attaches[16]={};bool levels[8]={};uint32_t current_ms=100;
uint32_t millis(){return current_ms;}void noInterrupts(){}void interrupts(){}void pinMode(uint32_t,int){}
int digitalRead(uint32_t pin){return levels[pin];}uint32_t digitalPinToInterrupt(uint32_t pin){return pin;}
uint32_t NVIC_GetEnableIRQ(IRQn_Type irq){return irq_enabled[irq];}
void attachInterrupt(uint32_t pin,void (*)(),int){assert(pin<8);attaches[pin]++;AFIO->EXTICR[pin/4]&=~(15u<<((pin%4)*4));EXTI->IMR|=1u<<pin;EXTI->RTSR|=1u<<pin;irq_enabled[pin<5?6+pin:23]=true;}
struct Serial {std::string output;void print(const char *v){output+=v;}void print(char v){output+=v;}void print(float v,int){output+=std::to_string(v);}template<typename T>void print(T v){output+=std::to_string(v);}template<typename T>void println(T v){print(v);println();}void println(){output+='\\n';}} tunerSerial;
${diagnostic}
int main(){
 // PB0 and PB9 belong to passive tracking encoders and must retain their routes.
 AFIO->EXTICR[0]=1u;AFIO->EXTICR[2]=1u<<4;EXTI->IMR=(1u<<0)|(1u<<9);EXTI->RTSR=EXTI->IMR;irq_enabled[6]=irq_enabled[23]=true;
 setupWheelEncoderDiagnostics();
 for(int i=0;i<4;i++)assert(wheelDiagnosticInterruptReady(i));
 assert((AFIO->EXTICR[0]&15u)==1u);assert(((AFIO->EXTICR[2]>>4)&15u)==1u);
 levels[0]=true;diagnosticWheel0();assert(wheel_diagnostic_edges[0]==1);assert(wheel_diagnostic_ticks[0]==uint32_t(-1));
 publishWheelEncoderDiagnostics();
 // Simulate GPIO/IRQ reconfiguration of the first three wheel lines.
 EXTI->IMR&=~(1u<<1);AFIO->EXTICR[0]|=1u<<8;irq_enabled[10]=false;
 diagnosticWheel0();current_ms=600;publishWheelEncoderDiagnostics();
 for(int i=0;i<4;i++)assert(wheelDiagnosticInterruptReady(i));
 assert(attaches[1]==2&&attaches[2]==2&&attaches[4]==2&&attaches[6]==1);
 assert((AFIO->EXTICR[0]&15u)==1u);assert(((AFIO->EXTICR[2]>>4)&15u)==1u);
 assert(tunerSerial.output.find("WDIAG ")!=std::string::npos);
 assert(tunerSerial.output.find("-0.200000")!=std::string::npos);
}
`;
    const binary=path.join(project,'irq-test'),build=spawnSync('g++',['-x','c++','-std=c++17','-o',binary,'-'],{input:cpp,encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);const result=spawnSync(binary,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});
