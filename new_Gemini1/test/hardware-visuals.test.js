'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),WebSocket=require('ws');
const {render,profiles}=require('../public/hardware-visuals');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('fixed hardware illustrations cover every controller and device without animation or external assets',()=>{
  const source=read('public/hardware-visuals.js'),hardware=read('public/hardware.js');
  const controllers=[...hardware.matchAll(/^  (\w+):\{label:/gm)].map(match=>match[1]);
  assert.deepEqual(Object.keys(profiles).sort(),controllers.sort());
  const arts=controllers.map(model=>render('controller',model));
  assert.equal(new Set(arts).size,controllers.length);
  for(const[kind,model]of [['driver','cycron'],['driver','tb6612'],['driver','l298n'],['encoder',''],['mpu6050',''],['bno055',''],['hcsr04',''],['servo','']])arts.push(render(kind,model));
  for(const art of arts){assert.match(art,/<polygon/);assert.match(art,/role="img"/);assert.doesNotMatch(art,/NaN|Infinity|<animate|<script|https?:/);}
  assert.doesNotMatch(source,/requestAnimationFrame|setInterval|OrbitControls|WebGLRenderer|fetch\(/);
  assert.doesNotMatch(render('controller','esp32','<img src=x onerror="bad()">'),/<img/);
  assert.match(read('public/hardware.html'),/hardware-visuals\.js/);
  for(const file of ['public/index.html','public/map.js','public/playground.js'])assert.doesNotMatch(read(file),/hardware-visuals/);
});

test('real wiring renders static 3D, keeps pin mappings and anchors every route on desktop and tablet',{skip:process.env.ROSIDE_TEST_BROWSER!=='1',timeout:20000},async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-hardware-ui-'));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});let socket;
  try{
    const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),8000);chrome.stderr.on('data',data=>{text+=data;const match=text.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});chrome.once('error',reject);});
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let seq=0;const pending=new Map();
    socket.on('message',raw=>{const result=JSON.parse(raw),entry=pending.get(result.id);if(entry){pending.delete(result.id);result.error?entry.reject(new Error(JSON.stringify(result.error))):entry.resolve(result.result);}});
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const target=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true}),cdp=(method,params)=>send(method,params,sessionId);
    await cdp('Page.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    const {frameTree}=await cdp('Page.getFrameTree');
    const html=read('public/hardware.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'').replace(/@import\s+url\([^)]*\);/g,'').replace('</head>',`<style>${read('public/hardware-visuals.css')}</style></head>`);
    await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
    const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    await evaluate('function getAuthToken(){return "mock"};Object.defineProperty(globalThis,"localStorage",{value:{getItem:()=>null,setItem(){}},configurable:true,writable:true});void 0;');
    await evaluate(read('public/hardware-visuals.js'));
    await evaluate(read('public/hardware.js').replace(/\ninit\(\);\s*$/,''));
    await evaluate(`robotDesign={drive:'diff2',pattern:'differential',encoders:[],wheels:[{name:'left_wheel',motorEnabled:true,motorRole:'left',encoderEnabled:true,ppr:600},{name:'right_wheel',motorEnabled:true,motorRole:'right',encoderEnabled:true,ppr:600}]};document.documentElement.dataset.theme='light';document.getElementById('controller-board').value='esp32';document.querySelector('[value="mpu6050"]').checked=true;renderDiagram();new Promise(r=>setTimeout(r,60))`);
    assert.equal(await evaluate('document.querySelectorAll(".hw-device-art").length'),6);
    assert.equal(await evaluate('document.querySelector("#pinout-mcu [data-device-model]").dataset.deviceModel'),'esp32');
    const pins=await evaluate('motorPinData().map(({in1,in2,pwm,encA,encB})=>[in1,in2,pwm,encA,encB])');
    assert.deepEqual(pins,[['16','17','25','32','33'],['18','19','26','27','14']]);
    const snapshot=await evaluate('document.querySelector("#pinout-mcu svg").outerHTML');
    await evaluate('new Promise(r=>setTimeout(r,250))');assert.equal(await evaluate('document.querySelector("#pinout-mcu svg").outerHTML'),snapshot);
    const capture=async name=>{const shot=await cdp('Page.captureScreenshot',{format:'png'});const file=path.join(profile,name+'.png');fs.writeFileSync(file,Buffer.from(shot.data,'base64'));console.log('Hardware screenshot:',file);};
    await capture('wiring-light');
    await evaluate(`document.documentElement.dataset.theme='dark';document.getElementById('motor-driver').value='l298n';document.getElementById('controller-board').value='stm32f103';renderDiagram();new Promise(r=>setTimeout(r,60))`);
    assert.equal(await evaluate('document.querySelector("#pinout-driver-0 [data-device-model]").dataset.deviceModel'),'l298n');await capture('wiring-dark');
    // Large sensor sets must terminate at the controller, not in empty space beside it.
    await evaluate(`document.querySelectorAll('.device-option input').forEach(input=>input.checked=true);renderDiagram();new Promise(r=>setTimeout(r,60))`);
    const anchored=()=>evaluate(`(()=>{const stage=document.getElementById('pinout-stage').getBoundingClientRect(),mcu=document.getElementById('pinout-mcu').getBoundingClientRect();return [...document.querySelectorAll('.pinout-dot')].every(dot=>{const y=Number(dot.getAttribute('cy'))+stage.top;return y>mcu.top&&y<mcu.bottom})})()`);
    assert.equal(await anchored(),true);
    await cdp('Emulation.setDeviceMetricsOverride',{width:820,height:1180,deviceScaleFactor:1,mobile:false});
    await evaluate('drawPinoutLines()');assert.equal(await anchored(),true);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await capture('wiring-tablet');
    assert.deepEqual(await evaluate('motorPinData().map(({in1,in2,pwm,encA,encB})=>[in1,in2,pwm,encA,encB])'),[['PB12','PB13','PA8','PA0','PA1'],['PB14','PB15','PB0','PA2','PA3']]);
    await evaluate(`document.querySelectorAll('.device-option input').forEach(input=>input.checked=false);document.getElementById('code-modal').hidden=true;changeHardwarePin('motor:left_wheel:in1','PB5');new Promise(r=>setTimeout(r,50))`);
    assert.equal(await evaluate('motorPinData()[0].in1'),'PB5');
    assert.equal(await evaluate(`document.querySelector('#pinout-driver-0 select[data-pin-key="motor:left_wheel:in1"]').value`),'PB5');
    assert.equal(await evaluate('document.querySelector(".hardware-pin-mapper")'),null);
    assert.equal(await evaluate('document.querySelectorAll("#pinout-motor-encoder-0 select").length'),2);
    assert.match(await evaluate('document.getElementById("pinout-driver-0").textContent'),/PB5/);
    assert.match(await evaluate('firmwareSourceWithAssignments(currentConfig())'),/\{PB5, PB13, PA8, PA0, PA1\}/);
    await evaluate(`const driverPin=document.querySelector('#pinout-driver-0 select[data-pin-key="motor:left_wheel:in1"]');driverPin.value='PB14';driverPin.dispatchEvent(new Event('change',{bubbles:true}));void 0`);
    assert.match(await evaluate('pinConflictErrors().join(" ")'),/ซ้ำ/);
    await evaluate('resetHardwarePins()');
    await capture('pin-picker-bluepill');
    await evaluate('scrollTo(0,0)');
    const firmware=await evaluate('firmwareSourceWithAssignments(currentConfig())');
    assert.match(firmware,/HardwareSerial SerialBridge\(PA10, PA9\);/);
    assert.doesNotMatch(firmware,/\bSerial\./);
    await evaluate(read('public/mecanum-xy-source.js'));
    await evaluate(read('public/mecanum-xy.js'));
    await evaluate(`
      const roles=['front_left','front_right','rear_left','rear_right'];
      const wheels=roles.map((role,i)=>({name:'mecanum_'+['fl','fr','rl','rr'][i],x:i<2?.3:-.3,y:i%2?-.36:.36,radius:.0635,motorEnabled:true,motorRole:role,encoderEnabled:true,encoderRole:'motor_feedback',ppr:600,channels:1,invert:i===0?1:-1}));
      robotDesign={hardwareTemplate:'mecanum_xy',drive:'mecanum4',driveLabel:'Mecanum XY',pattern:'mecanum',wheels,hasImu:true,hasLidar:true,wheelDiameterMm:127,wheelTrackMm:720,wheelBaseMm:600,encoders:[...wheels.map(w=>({name:'encoder_'+w.name,attachedWheel:w.name,role:'motor_feedback',enabled:true,ppr:600,channels:1,invert:w.invert})),...['x','y'].map(axis=>({name:'encoder_odom_'+axis,attachedWheel:'',role:'odom_'+axis,enabled:true,ppr:600,channels:1,invert:axis==='x'?-1:1,x:axis==='x'?-.11:0,y:0}))]};
      globalThis.localStorage={getItem:()=>null,setItem(){}};
      applySavedOptions();renderAssignments();renderSummary();renderDiagram();
      document.querySelectorAll('.sidebar-card').forEach(card=>card.open=true);
      new Promise(r=>setTimeout(r,80));
    `);
    assert.equal(await evaluate('document.querySelectorAll("#hardware-assignments .assignment-row").length'),6);
    assert.equal(await evaluate('[...document.querySelectorAll(".pid-field")].every(e=>e.hidden)'),true);
    assert.match(await evaluate('document.getElementById("bridge-config-summary").textContent'),/Position Control/);
    assert.match(await evaluate('firmwareSourceWithAssignments(currentConfig())'),/T:GOAL:/);
    assert.equal(await evaluate('document.querySelectorAll(".hardware-wheel-role select").length'),4);
    assert.deepEqual(await evaluate('[...document.querySelector(".hardware-wheel-role select").options].map(o=>o.value)'),['front_left','front_right','rear_left','rear_right']);
    await evaluate(`document.getElementById('code-modal').hidden=true;const wheelRole=document.querySelector('#pinout-driver-0 .hardware-wheel-role select');wheelRole.value='rear_right';wheelRole.dispatchEvent(new Event('change',{bubbles:true}));new Promise(r=>setTimeout(r,60))`);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".hardware-wheel-role select")].map(s=>s.value)'),['rear_right','front_right','rear_left','front_left']);
    assert.equal(await evaluate(`document.querySelector('#pinout-driver-0 select[data-pin-key$=":pwm"]').value`),'PA8');
    assert.match(await evaluate('firmwareSourceWithAssignments(currentConfig())'),/\{PA6, PA7, PB8, PB14, TIM4, 3,/);
    await capture('mecanum-xy-assignments');

  }finally{socket?.close();chrome.kill('SIGTERM');}
});
