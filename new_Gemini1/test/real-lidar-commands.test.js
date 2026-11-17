'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');

async function request(action,{failPreparation=false,processRunning=true,frameId,tfModel}={}){
  const commands=[];let route,response,startCommand;
  const diagnostic='ROSIDE_PORT=connected\nROSIDE_PROCESS=running\nROSIDE_TOPICS_BEGIN\n/scan [sensor_msgs/msg/LaserScan]\nROSIDE_TOPICS_END\nROSIDE_INFO_BEGIN\nPublisher count: 1\nROSIDE_INFO_END\nROSIDE_LOG_BEGIN\nROSIDE_LOG_STATE=present\ndriver ready\nROSIDE_LOG_END';
  const context=vm.createContext({
    app:{post(_path,_auth,handler){route=handler;}},auth(){},
    getOwnedSess:()=>({robotKey:'fixture',workspace:'/tmp/fixture',rosInfo:{setupBash:'/dev/null'}}),isSim:()=>false,
    robotRuntimeOperations:new Map(),robotControlLeases:new Map(),WebSocket:{OPEN:1},
    SERIAL_DEVICE_PATTERN:/^\/dev\/ttyUSB\d+$/,
    agentReq:async(_key,_action,{command})=>{
      if(command)commands.push(command);
      if(_action==='fs_read')return{content:JSON.stringify(tfModel||[])};
      if(failPreparation&&command.includes('needs_build=0'))return{code:2,stdout:'',stderr:'fixture: driver package missing'};
      return{code:0,stdout:command.includes('ROSIDE_TOPICS_BEGIN')?diagnostic.replace('ROSIDE_PROCESS=running',`ROSIDE_PROCESS=${processRunning?'running':'stopped'}`):command.includes('tail -120')?'fixture platform log':'',stderr:''};
    },
    ensureSllidarChannelFix:async()=>'',restoreDetachedUsbSerial:async()=>'',ensureRobotSerialAccess:async()=>({repaired:false}),
    runLidarStartWithUsbRecovery:async(_session,{command})=>{startCommand=command;commands.push(command);return{started:{code:0,stdout:'',stderr:''}};},
  });
  vm.runInContext(source.slice(source.indexOf('function reserveRuntimeOperation('),source.indexOf('function acquireControlLease(')),context);
  vm.runInContext(source.slice(source.indexOf('const REAL_LIDAR_CATALOG='),source.indexOf('async function ensureSllidarChannelFix')),context);
  vm.runInContext(source.slice(source.indexOf('function lidarSerialPreflightCommand'),source.indexOf('async function resetRobotUsbSerial')),context);
  vm.runInContext(source.slice(source.indexOf('function lidarRuntimePaths'),source.indexOf("app.post('/api/lidar/scan'")),context);
  const res={status(code){this.statusCode=code;return this;},json(value){response=value;}};
  await route({body:{action,modelId:'rplidar_c1',port:'/dev/ttyUSB0',baud:460800,frameId}},res);
  assert.equal(context.robotRuntimeOperations.size,0,'every success, failure and status request must release only its own reservation');
  return{commands,response,startCommand};
}

test('selected LiDAR frame reaches the real driver and TF uses parent pose',async()=>{
  const {startCommand,response}=await request('start',{frameId:'front_scan'});
  assert.equal(response.ok,true);
  assert.match(startCommand,/frame_id:=.*front_scan/);
  const context=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('const REAL_LIDAR_CATALOG='),source.indexOf('async function ensureSllidarChannelFix')),context);
  const commands=vm.runInContext(`lidarTfLaunchCommands([{type:'base',name:'base_link'},{name:'sensor_mount',parent:'base_link',pos:{x:0.2,y:0,z:0.3},rpy:{r:0,p:0,y:45}},{name:'front_scan',parent:'sensor_mount',pos:{x:0,y:0.1,z:0.2},rpy:{r:30,p:20,y:10}}],'front_scan')`,context);
  assert.equal(commands.length,2);
  assert.match(commands[0],/--child-frame-id 'sensor_mount'/);
  assert.match(commands[1],/--roll 0\.523598/);
  assert.match(commands[1],/--child-frame-id 'front_scan'/);
  assert.throws(()=>vm.runInContext(`selectedLidarFrame('bad;echo injected')`,context));
  vm.runInContext(source.slice(source.indexOf('function lidarSetupFiles('),source.indexOf("app.post('/api/lidar/frame'")),context);
  for(const id of ['rplidar_a1','ydlidar_g4','ldlidar_ld06','hokuyo_ust10lx']){
    const files=vm.runInContext(`lidarSetupFiles(${JSON.stringify(id)},REAL_LIDAR_CATALOG[${JSON.stringify(id)}],'front_scan')`,context);
    assert.equal(JSON.parse(files['config/selected_lidar.json']).frameId,'front_scan');
    const parsed=spawnSync('python3',['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:files['launch/lidar.launch.py'],encoding:'utf8'});
    assert.equal(parsed.status,0,id+': '+parsed.stderr);
  }
});

test('direct LiDAR test launches the saved TF so RViz sees the same mounting rotation',async()=>{
  const {startCommand,response}=await request('start',{frameId:'front_scan',tfModel:[
    {type:'base',name:'base_link'},
    {type:'lidar',name:'front_scan',parent:'base_link',pos:{x:0.2,y:0,z:0.3},rpy:{r:0,p:0,y:90}},
  ]});
  assert.equal(response.ok,true);
  assert.match(startCommand,/static_transform_publisher/);
  assert.match(startCommand,/--yaw 1\.57079632679/);
  assert.match(startCommand,/--child-frame-id .*front_scan/);
});

test('stale laser_frame selection follows the only connected LiDAR frame before starting',async()=>{
  const {startCommand,response}=await request('start',{frameId:'laser_frame',tfModel:[
    {type:'base',name:'base_link'},
    {type:'lidar',name:'laser_link',parent:'base_link',pos:{x:-0.09,y:0,z:0.26},rpy:{r:0,p:0,y:180}},
  ]});
  assert.equal(response.ok,true);
  assert.equal(response.frameId,'laser_link');
  assert.match(startCommand,/frame_id:.*laser_link/);
  assert.match(startCommand,/--child-frame-id .*laser_link/);
  assert.doesNotMatch(startCommand,/frame_id:.*laser_frame/);
});

test('ambiguous TF frames fail before cleaning up a working LiDAR',async()=>{
  const {commands,response,startCommand}=await request('start',{frameId:'laser_frame',tfModel:[
    {type:'base',name:'base_link'},
    ...['laser_left','laser_right'].map(name=>({type:'lidar',name,parent:'base_link',pos:{x:0,y:0,z:0},rpy:{r:0,p:0,y:0}})),
  ]});
  assert.equal(response.ok,false);
  assert.equal(response.stage,'lidar-tf');
  assert.match(response.error,/เลือกเฟรม LiDAR/);
  assert.equal(startCommand,undefined);
  assert.ok(!commands.some(command=>command.includes('pkill -TERM')));
});

for(const action of ['start','stop','status'])test(`LiDAR ${action}: every generated Agent command parses in Bash`,async()=>{
  const {commands,response}=await request(action);
  assert.equal(response.ok,true);
  for(const command of commands){
    const parsed=spawnSync('bash',['-n'],{input:command,encoding:'utf8'});
    assert.equal(parsed.status,0,parsed.stderr+'\n'+command);
  }
});

test('LiDAR cleanup patterns match drivers but never the orchestration shell',async()=>{
  const {commands}=await request('start');
  const cleanup=commands.find(command=>command.includes('pkill -TERM'));
  const patterns=[...source.matchAll(/const staleLidarPattern="'([^"\n]+)'";/g)].map(match=>match[1]);
  assert.equal(patterns.length,3,'Test, Mapping and Navigation must all use safe matching');
  for(const pattern of patterns){
    for(const cmdline of ['/bin/bash -c '+cleanup,'/bin/bash -lc '+cleanup+'; ros2 run sllidar_ros2 sllidar_node']){
      const match=spawnSync('grep',['-E',pattern],{input:cmdline,encoding:'utf8'});
      assert.equal(match.status,1,'cleanup must not match its own shell');
    }
    for(const cmdline of ['/robot/install/lib/sllidar_ros2/sllidar_node --ros-args','/usr/bin/python3 /opt/ros/jazzy/bin/ros2 run sllidar_ros2 sllidar_node --ros-args','ros2 launch sllidar_ros2 sllidar_c1_launch.py','/robot/install/lib/ldlidar_stl_ros2/ldlidar_stl_ros2_node']){
      assert.equal(spawnSync('grep',['-E',pattern],{input:cmdline}).status,0,cmdline);
    }
  }
});

test('serial preflight failures retain stderr and prevent the driver launch',async()=>{
  const {startCommand}=await request('start');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'roside-lidar-preflight-'));
  try{
    const command=startCommand.replaceAll('"$HOME"/\'.roside/lidar-runtime',"'"+fixture);
    const result=spawnSync('bash',['-c',`python3(){ echo 'fixture serial port busy' >&2; return 1; }; sleep(){ :; }; fuser(){ :; }; nohup(){ echo UNEXPECTED_LAUNCH; }; ${command}`],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,53,result.stderr);
    assert.match(result.stdout,/fixture serial port busy/);
    assert.doesNotMatch(result.stdout,/UNEXPECTED_LAUNCH/);
    assert.match(fs.readFileSync(path.join(fixture,'driver.log'),'utf8'),/fixture serial port busy/);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});}
});

test('status reaches diagnostic markers even when the workspace setup is missing',async()=>{
  const {commands}=await request('status');
  const diagnostic=commands.find(command=>command.includes('ROSIDE_TOPICS_BEGIN'));
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'roside-lidar-status-'));
  try{
    const command=diagnostic.replaceAll('/tmp/fixture',fixture).replaceAll('"$HOME"/\'.roside/lidar-runtime',"'"+fixture);
    const result=spawnSync('bash',['-c',`timeout(){ return 1; }; ${command}`],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/ROSIDE_PROCESS=stopped/);
    assert.match(result.stdout,/ROSIDE_PLATFORM_LOG_BEGIN/);
    assert.match(result.stdout,/ROSIDE_LOG_STATE=missing/);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});}
});

test('pre-launch build failure returns both the original error and platform log',async()=>{
  const {response,startCommand}=await request('start',{failPreparation:true});
  assert.equal(response.ok,false);
  assert.equal(response.stage,'build');
  assert.match(response.output,/driver package missing/);
  assert.match(response.output,/fixture platform log/);
  assert.equal(startCommand,undefined);
});

test('a dead driver cannot be reported as a successful start',async()=>{
  const {response}=await request('start',{processRunning:false});
  assert.equal(response.ok,false);
  assert.equal(response.stage,'launch-driver');
});

for(const mission of ['MAPPING_LIDAR','LIDAR'])test(`${mission}: runtime preflight failures are logged and abort before starting drivers`,()=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'roside-mission-preflight-'));
  try{
    const context=vm.createContext({SERIAL_DEVICE_PATTERN:/^\/dev\/ttyUSB\d+$/,
      p:{runtime:fixture,log:path.join(fixture,'runtime.log'),lidarLog:path.join(fixture,'lidar.log'),lidarPid:path.join(fixture,'lidar.pid'),pid:path.join(fixture,'runtime.pid')},
      prepared:{lidarModelId:'rplidar_c1',lidarPort:'/dev/ttyUSB0',lidarBaud:460800},source:'source /dev/null',lidarRunner:':',runner:':'});
    vm.runInContext(source.slice(source.indexOf('const REAL_LIDAR_CATALOG='),source.indexOf('async function ensureSllidarChannelFix')),context);
    vm.runInContext(source.slice(source.indexOf('function lidarSerialPreflightCommand'),source.indexOf('async function resetRobotUsbSerial')),context);
    vm.runInContext('const serialPreflight=lidarSerialPreflightCommand(prepared.lidarPort,prepared.lidarBaud);',context);
    const line=source.split('\n').find(line=>line.includes('const command=')&&line.includes(`echo ROSIDE_${mission}_ATTEMPT=`));assert.ok(line);
    const command=vm.runInContext(line+'\ncommand;',context);
    assert.equal(spawnSync('bash',['-n'],{input:command,encoding:'utf8'}).status,0);
    const result=spawnSync('bash',['-c',`python3(){ echo 'fixture serial port busy' >&2; return 1; }; sleep(){ :; }; fuser(){ :; }; udevadm(){ :; }; nohup(){ echo UNEXPECTED_LAUNCH; }; ${command}`],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,53,result.stderr);assert.match(result.stdout,/fixture serial port busy/);assert.doesNotMatch(result.stdout,/UNEXPECTED_LAUNCH/);
    assert.match(fs.readFileSync(path.join(fixture,'lidar.log'),'utf8'),/fixture serial port busy/);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});}
});
