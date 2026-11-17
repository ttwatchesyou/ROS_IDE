'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');

function generatedFirmware(motorInvert=[false,false],encoderInvert=[1,1]){
  const context=vm.createContext({motorInvert,encoderInvert,getAuthToken:()=> 'fixture',document:{getElementById:()=>({value:'stm32f103'})}});
  const source=fs.readFileSync(path.join(__dirname,'../public/hardware.js'),'utf8').replace(/\ninit\(\);\s*$/,'');
  vm.runInContext(source,context);
  return vm.runInContext(`
    robotDesign={drive:'diff2',encoders:[],wheels:[
      {name:'left',motorRole:'left',motorEnabled:true,motorInvert:motorInvert[0],encoderEnabled:true,invert:encoderInvert[0],ppr:1024},
      {name:'right',motorRole:'right',motorEnabled:true,motorInvert:motorInvert[1],encoderEnabled:true,invert:encoderInvert[1],ppr:1024}
    ]};
    const config={controller:'stm32f103',boardLabel:'STM32F103C8T6',drive:'diff2',driveLabel:'2WD Differential',motorDriver:'cycron',motorCount:2,wheelDiameterMm:100,wheelTrackMm:300,wheelBaseMm:0,encoderTicksPerRevolution:1024,motorMaxRpm:300,accessories:['bno055','hcsr04','servo'],baudRate:115200,pidControl:true,pid:{kp:0.5,ki:0,kd:0},commandTimeoutMs:300};
    ({source:firmwareSourceWithAssignments(config),ini:platformioSource(config)});
  `,context);
}

test('generated Blue Pill velocity and PID parsers enable newlib-nano float scanning',()=>{
  const generated=generatedFirmware();
  assert.match(generated.source,/sscanf\(line, "V %f %f %f"/);
  assert.match(generated.source,/sscanf\(line, "R %f %f"/);
  assert.match(generated.ini,/-D PIO_FRAMEWORK_ARDUINO_NANOLIB_FLOAT_SCANF/);
});

test('motor inversion changes electrical direction only, preserving encoder calibration, kinematics and STOP',()=>{
  const baseline=generatedFirmware().source;
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'roside-motor-direction-'));
  for(const inverted of [[false,false],[true,false],[false,true],[true,true]]){
    const generated=generatedFirmware(inverted).source;
    assert.equal(generated.match(/void calculateWheelTargets[\s\S]*?\n}\n/)[0],baseline.match(/void calculateWheelTargets[\s\S]*?\n}\n/)[0]);
    assert.equal(generated.match(/void onEncoder1[\s\S]*?using EncoderIsr/)[0],baseline.match(/void onEncoder1[\s\S]*?using EncoderIsr/)[0]);
    const signs=generated.match(/constexpr int8_t kMotorDirection[^;]+;/)[0];
    assert.ok(signs.includes(`{${inverted.map(value=>value?-1:1).join(', ')}}`));
    const setMotor=generated.match(/void setMotor\([\s\S]*?\n}\n/)[0];
    const cpp=`#include <cassert>
#include <cstdint>
#include <cstdlib>
constexpr int HIGH=1, LOW=0, kMotorCount=2;
template<class T> T constrain(T value,T lo,T hi){return value<lo?lo:value>hi?hi:value;}
struct MotorPins {uint32_t direction,pwm;};
constexpr MotorPins kMotorPins[2]={{0,2},{1,3}};
int direction[2]={}, pwm[2]={};
void digitalWrite(uint32_t pin,int value){direction[pin]=value;}
void analogWrite(uint32_t pin,int value){pwm[pin-2]=value;}
${signs}
${setMotor}
int main(){for(int i=0;i<2;i++){
  setMotor(i,60);assert(pwm[i]==60);assert(direction[i]==(kMotorDirection[i]>0?HIGH:LOW));
  setMotor(i,-60);assert(pwm[i]==60);assert(direction[i]==(kMotorDirection[i]>0?LOW:HIGH));
  setMotor(i,300);assert(pwm[i]==255);
  setMotor(i,0);assert(pwm[i]==0);
}}
`;
    const binary=path.join(project,'direction-'+inverted.map(Number).join(''));
    const build=spawnSync('g++',['-x','c++','-std=c++17','-o',binary,'-'],{input:cpp,encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);assert.equal(spawnSync(binary).status,0);
  }
  assert.match(generatedFirmware([true,true],[-1,-1]).source,/encoder_ticks\[0\] \+= .* \* -1;/,'encoder inversion stays separately selectable');
});

test('Hardware UI saves and restores motor polarity without changing encoder polarity',()=>{
  const nodes=new Map(),storage=new Map();
  const values={'controller-board':'stm32f103','motor-driver':'cycron','bridge-serial-port':'/dev/ttyAMA0','bridge-baud-rate':'115200','command-timeout-ms':'300','motor-max-rpm':'300','pid-kp':'0.5','pid-ki':'0','pid-kd':'0'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:values[id]||'',checked:true,hidden:true,innerHTML:'',insertAdjacentHTML(){}});return nodes.get(id);};
  const context=vm.createContext({getAuthToken:()=> 'fixture',document:{getElementById:node,querySelectorAll:()=>[]},queueMicrotask(){},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/hardware.js'),'utf8').replace(/\ninit\(\);\s*$/,''),context);
  vm.runInContext(`robotDesign={pattern:'differential',drive:'diff2',hasImu:false,encoders:[],wheels:[
    {name:'left',motorRole:'left',motorEnabled:true,encoderEnabled:true,invert:-1,ppr:1024,channels:4},
    {name:'right',motorRole:'right',motorEnabled:true,encoderEnabled:true,invert:1,ppr:1024,channels:4}
  ]};renderSummary=()=>{};renderDiagram=()=>{};updateAssignment(0,'motorInvert',true);updateAssignment(1,'motorInvert',true);`,context);
  assert.match(node('hardware-assignments').innerHTML,/กลับทิศมอเตอร์ \(Motor Invert\)/);
  const config=vm.runInContext('currentConfig()',context);
  assert.deepEqual(Array.from(config.assignments,a=>a.motorInvert),[true,true]);
  assert.deepEqual(Array.from(config.assignments,a=>a.invert),[-1,1]);
  storage.set('roside_hardware_config_default',JSON.stringify(config));
  vm.runInContext('robotDesign.wheels.forEach(w=>w.motorInvert=false);applySavedOptions()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[true,true]);
  // Older saved projects must not silently reverse their motors.
  config.assignments.forEach(a=>delete a.motorInvert);storage.set('roside_hardware_config_default',JSON.stringify(config));
  vm.runInContext('applySavedOptions()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[false,false]);
  // The bulk action reverses the current configuration, not every robot's defaults.
  context.confirm=()=>false;
  vm.runInContext('reverseBothMotors()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[false,false]);
  context.confirm=()=>true;
  vm.runInContext('reverseBothMotors()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[true,true]);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.invert),[-1,1]);
  vm.runInContext('reverseBothMotors()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[false,false],'second click restores the original direction');
  vm.runInContext('updateAssignment(0,"motorInvert",true);reverseBothMotors()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[false,true],'mixed polarity is toggled independently');
  vm.runInContext('platformioBusy=true;reverseBothMotors()',context);
  assert.deepEqual(Array.from(vm.runInContext('motorPinData()',context),m=>m.motorInvert),[false,true],'cannot edit polarity during upload');
});

test('generated Blue Pill firmware builds with PlatformIO STM32 20 / Arduino core 3',{
  skip:!process.env.ROSIDE_TEST_PIO,timeout:600000,
},()=>{
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'roside-stm32-build-'));
  const generated=generatedFirmware([true,true]);
  fs.mkdirSync(path.join(project,'src'));
  fs.writeFileSync(path.join(project,'src/main.cpp'),generated.source);
  fs.writeFileSync(path.join(project,'platformio.ini'),generated.ini.replace('platform = ststm32','platform = ststm32@20.0.0'));
  const build=spawnSync(process.env.ROSIDE_TEST_PIO,['run','-d',project,'-j','2'],{encoding:'utf8',timeout:550000,maxBuffer:8*1024*1024});
  console.log('Firmware build artifacts:',project);
  assert.equal(build.status,0,[build.error,build.stdout,build.stderr].filter(Boolean).join('\n'));
  assert.ok(fs.statSync(path.join(project,'.pio/build/stm32f103/firmware.bin')).size>0);
  const linkedMap=fs.readFileSync(path.join(project,'.pio/build/stm32f103/firmware.map'),'utf8');
  assert.match(linkedMap,/\.text\._scanf_float\s+0x0*800[0-9a-f]+/i,'float scanner must be linked into FLASH, not absent or discarded');
  console.log(build.stdout.split('\n').filter(line=>/RAM:|Flash:|SUCCESS|framework-arduinoststm32/.test(line)).join('\n'));
});
