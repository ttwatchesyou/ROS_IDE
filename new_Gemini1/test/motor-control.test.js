'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/motor-control.js','utf8').replace(/\nmotorControlInit\(\);\s*$/,'');
const config={drive:'mecanum4',motorCount:4,motorMaxRpm:300,assignments:['front_left','front_right','rear_left','rear_right'].map((motorRole,i)=>({name:'wheel_'+i,motorRole,motorEnabled:true,hardwareChannel:i}))};
function fixture(handler=async()=>({ok:true})){
  const nodes=new Map(),sockets=[],calls=[],timers=new Map();let seq=0;
  const classes=()=>({add(){},remove(){},toggle(){}});
  function node(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',dataset:{},classList:classes(),addEventListener(){},add(){}});return nodes.get(id);}
  class WebSocket{
    static OPEN=1;
    constructor(url,protocols){this.url=url;this.protocols=protocols;this.readyState=1;this.sent=[];sockets.push(this);}
    send(raw){this.sent.push(JSON.parse(raw));}close(){this.readyState=3;this.onclose?.();}
    receive(message){this.onmessage?.({data:JSON.stringify(message)});}
  }
  const c=vm.createContext({RealDriveMotion:require('../public/real-drive-motion'),getAuthToken:()=> 'token',authHeaders:()=>({}),clearAuthSession(){},localStorage:{getItem:()=>null,setItem(){}},
    document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},location:{protocol:'https:',host:'fixture',replace(){}},WebSocket,Option:function(text,value){this.text=text;this.value=value;},
    setInterval:callback=>{const id=++seq;timers.set(id,callback);return id;},clearInterval:id=>timers.delete(id),
    fetch:async(path,options)=>{const body=JSON.parse(options.body);calls.push({path,body});const result=await handler(path,body);return{ok:true,status:200,json:async()=>result};}});
  vm.runInContext(source,c);const run=code=>vm.runInContext(code,c);
  run(`motorControlConfig=${JSON.stringify(config)};motorControlMotors=motorControlDescribe(motorControlConfig);motorControlSession='session'`);
  node('motor-port').value='/dev/ttyUSB1';node('motor-baud').value='115200';for(let i=0;i<4;i++)node('motor-speed-'+i).value='30';
  return{run,node,sockets,calls,timers,c,button:()=>({classList:classes(),closest:()=>({classList:classes()})})};
}
test('single motor commands set every other motor to zero in both directions',()=>{
  const f=fixture();
  for(const count of [2,4])for(let i=0;i<count;i++)for(const sign of [1,-1]){
    const values=f.run(`motorControlBuildCommand(${i},${sign},30,${count})`).split(' ').slice(1).map(Number);
    assert.equal(values.length,count);assert.equal(values[i],sign*30);assert.equal(values.filter(v=>v!==0).length,1);
  }
  assert.throws(()=>f.run('motorControlBuildCommand(4,1,30,4)'));
});
test('cards follow firmware wheel order and retain physical driver channel labels',()=>{
  const f=fixture();f.run('motorControlConfig.assignments.reverse();motorControlConfig.assignments[0].hardwareChannel=0;motorControlMotors=motorControlDescribe(motorControlConfig)');
  assert.deepEqual(Array.from(f.run('motorControlMotors.map(m=>m.role)')),['front_left','front_right','rear_left','rear_right']);
  assert.equal(f.run('motorControlMotors[3].channel'),1);
  f.run("motorControlConfig.assignments[1].motorRole='front_left'");assert.throws(()=>f.run('motorControlDescribe(motorControlConfig)'),/ซ้ำ/);
});
test('connection waits for port_open and never starts a motor automatically',async()=>{
  const f=fixture();await f.run('motorControlConnect()');const socket=f.sockets[0];socket.onopen();
  assert.equal(socket.sent[0].type,'start');assert.equal(socket.sent[0].motorCount,4);
  assert.equal(f.run('motorControlReady'),false);assert.equal(socket.sent.filter(m=>m.type==='command').length,0);
  socket.receive({type:'telemetry',data:{event:'port_open'}});
  assert.equal(f.run('motorControlReady'),true);assert.deepEqual(socket.sent.filter(m=>m.type==='command').map(m=>m.command),['S']);
  f.c.button=f.button();f.run('motorControlStart(2,-1,button,7)');
  assert.equal(socket.sent.at(-1).command,'R 0.0000 0.0000 -30.0000 0.0000');assert.equal(f.timers.size,2);
  const callback=f.timers.get(f.run('motorControlTimer'));callback();assert.equal(socket.sent.at(-1).command,'R 0.0000 0.0000 -30.0000 0.0000');
  f.run('motorControlStop()');assert.equal(socket.sent.at(-1).command,'S');assert.equal(f.timers.size,1);assert.equal(f.run('motorControlHold'),null);
});
test('disconnect stops the motor, clears its heartbeat, and ignores delayed events from the old socket',async()=>{
  const f=fixture();await f.run('motorControlConnect()');const old=f.sockets[0];old.receive({type:'telemetry',data:{event:'port_open'}});
  f.c.button=f.button();f.run('motorControlStart(0,1,button,1);motorControlDisconnect()');assert.equal(old.sent.at(-1).command,'S');assert.equal(f.timers.size,0);
  await f.run('motorControlConnect()');const current=f.sockets[1];current.receive({type:'telemetry',data:{event:'port_open'}});old.onclose();
  assert.equal(f.run('motorControlReady'),true);assert.equal(f.run('motorControlSocket===null'),false);
});
test('leaving during port preparation cannot open a late control socket',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));const connecting=f.run('motorControlConnect()');f.run('motorControlDisconnect()');resolve({ok:true});await connecting;
  assert.equal(f.sockets.length,0);assert.equal(f.run('motorControlPending'),false);
});
test('new tool is a separate dashboard card, outside the mission grid',()=>{
  const html=fs.readFileSync('public/index.html','utf8');assert.match(html,/class="motor-control-tool-card" data-real-only href="\/motor-control.html"/);
  assert.match(html,/id="project-capabilities-grid">\s*<div class="empty-state">[^<]+<\/div>\s*<\/div>\s*<a class="motor-control-tool-card"/);
  assert.doesNotMatch(fs.readFileSync('public/dashboard.js','utf8').slice(0,fs.readFileSync('public/dashboard.js','utf8').indexOf('let realTeleopBound=')),/motor-control.*detected/);
});

test('wheel encoder telemetry maps canonical firmware slots to Mecanum XY cards independently of command order',()=>{
  const f=fixture();
  f.run("motorControlConfig.robotDesign={hardwareTemplate:'mecanum_xy'};motorControlMotors=motorControlDescribe(motorControlConfig)");
  assert.equal(f.run('motorControlMotors[2].role'),'rear_right');
  assert.equal(f.run("motorControlEncoderTelemetry({event:'frame',kind:'WENC',values:[101,1.5,202,-2.5,303,3.5,404,-4.5,15]},1000)"),true);
  assert.equal(f.node('motor-ticks-2').textContent,'404');assert.equal(f.node('motor-measured-2').textContent,'-4.5 RPM');
  assert.equal(f.node('motor-ticks-3').textContent,'303');
  f.run('motorControlStop()');assert.equal(f.node('motor-measured-2').textContent,'-4.5 RPM');
  assert.equal(f.node('motor-target-2').textContent,'0 RPM');
});
test('unavailable encoder bits, stale data, reconnect and invalid frames never fabricate measured values',()=>{
  const f=fixture();
  f.run("motorControlEncoderTelemetry({event:'frame',kind:'WENC',values:[12,1,23,2,34,3,45,4,5]},1000)");
  assert.equal(f.node('motor-encoder-state-0').dataset.state,'live');
  assert.equal(f.node('motor-encoder-state-1').dataset.state,'disabled');assert.equal(f.node('motor-measured-1').textContent,'—');
  for(const values of [[1,2],[1,2,3,4,5,6,7,8,16],[1,2,3,4,5,6,7,8,-1],[1.5,2,3,4,5,6,7,8,15],[1,2,3,4,5,6,7,Infinity,15]]){
    f.c.invalid=values;assert.equal(f.run("motorControlEncoderTelemetry({event:'frame',kind:'WENC',values:invalid},1500)"),false);
  }
  assert.equal(f.run("motorControlEncoderTelemetry({event:'frame',kind:'ENC',values:[1,2,3]},1500)"),false);
  f.run('motorControlCheckEncoders(3001)');assert.equal(f.node('motor-encoder-state-0').dataset.state,'stale');assert.equal(f.node('motor-ticks-0').textContent,'—');
  f.run("motorControlEncoderTelemetry({event:'frame',kind:'WENC',values:[13,0,23,0,34,0,45,0,15]},3100)");
  assert.equal(f.node('motor-encoder-state-0').dataset.state,'live');assert.equal(f.node('motor-ticks-0').textContent,'13');
  f.run('motorControlDisconnect()');assert.equal(f.node('motor-ticks-0').textContent,'—');assert.equal(f.node('motor-encoder-state-0').textContent,'ยังไม่เชื่อมต่อ');
});
test('legacy RPM frames use measured fields only for enabled wheel feedback, and WENC takes priority',()=>{
  const f=fixture();f.run('motorControlMotors[0].encoderEnabled=true;motorControlMotors[2].diagnostic=true;motorControlMotors[2].encoderEnabled=true');
  f.run("motorControlEncoderTelemetry({event:'frame',kind:'RPM',values:[30,11,40,22,50,33,60,44]},1000)");
  assert.equal(f.node('motor-measured-0').textContent,'11.0 RPM');assert.equal(f.node('motor-ticks-0').textContent,'—');
  assert.equal(f.node('motor-measured-1').textContent,'');assert.equal(f.node('motor-measured-2').textContent,'');
  f.run("motorControlEncoderTelemetry({event:'frame',kind:'WENC',values:[1,2,3,4,5,6,7,8,15]},1500);motorControlEncoderTelemetry({event:'frame',kind:'RPM',values:[30,11,40,22,50,33,60,44]},1600)");
  assert.equal(f.node('motor-measured-0').textContent,'2.0 RPM');assert.equal(f.node('motor-ticks-0').textContent,'1');
});
test('socket frames update encoder cards and disconnection clears all telemetry timers',async()=>{
  const f=fixture();await f.run('motorControlConnect()');const socket=f.sockets[0];socket.receive({type:'telemetry',data:{event:'port_open'}});
  socket.receive({type:'telemetry',data:{event:'frame',kind:'WENC',values:[9,0,8,0,7,0,6,0,15]}});
  assert.equal(f.node('motor-ticks-0').textContent,'9');assert.equal(f.timers.size,1);
  socket.close();assert.equal(f.timers.size,0);assert.equal(f.node('motor-ticks-0').textContent,'—');
});

test('signal diagnostics map A/B, interrupt state and edge counts to the correct wheel and expire independently',()=>{
  const f=fixture();f.run("motorControlConfig.robotDesign={hardwareTemplate:'mecanum_xy'};motorControlMotors=motorControlDescribe(motorControlConfig)");
  assert.equal(f.run("motorControlEncoderTelemetry({event:'frame',kind:'WDIAG',values:[8,0,15,10,20,30,40]},1000)"),true);
  assert.match(f.node('motor-encoder-signals-2').textContent,/A=1 B=0.*พร้อม.*40$/);
  assert.match(f.node('motor-encoder-signals-3').textContent,/A=0 B=0.*พร้อม.*30$/);
  assert.equal(f.run("motorControlEncoderTelemetry({event:'frame',kind:'WDIAG',values:[16,0,15,10,20,30,40]},1500)"),false);
  assert.equal(f.run("motorControlEncoderTelemetry({event:'frame',kind:'WDIAG',values:[0,0,15,10,20,30,-1]},1500)"),false);
  f.run('motorControlCheckEncoders(3001)');assert.equal(f.node('motor-encoder-signals-2').textContent,'ข้อมูลขา A/B ค้าง');
  f.run('motorControlDisconnect()');assert.doesNotMatch(f.node('motor-encoder-signals-2').textContent,/40$/);
});
