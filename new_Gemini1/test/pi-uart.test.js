'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const server=read('server.js');

async function discover({devices=['/dev/ttyUSB0','/dev/ttyAMA0','/dev/ttyAMA10','/dev/ttyS0'],aliases={'/dev/serial0':'/dev/ttyAMA10','/dev/serial1':'/dev/ttyAMA0'},consolePort='ttyAMA10',denied='/dev/ttyS0'}={}){
  const context=vm.createContext({Buffer,agentReq:async(_key,_action,{command})=>{
    const python=Buffer.from(command.match(/b64decode\('([^']+)'\)/)[1],'base64').toString();
    const fixture=JSON.stringify({devices,aliases,consolePort,denied});
    const wrapper=`import io,json,os,glob,stat,fnmatch,types,builtins
from unittest.mock import patch
fixture=json.loads(${JSON.stringify(fixture)})
fixture_paths=fixture['devices']+list(fixture['aliases'])
def realpath(p): return fixture['aliases'].get(p,p)
def fake_stat(p):
 if realpath(p) not in fixture['devices']: raise FileNotFoundError(p)
 return types.SimpleNamespace(st_mode=stat.S_IFCHR|0o660,st_uid=os.getuid(),st_gid=os.getgid())
def fake_open(p,*args,**kwargs):
 if p=='/proc/device-tree/model': return io.StringIO('Raspberry Pi 5 Model B Rev 1.0'+chr(0))
 if p=='/proc/cmdline': return io.StringIO('console='+fixture['consolePort']+',115200 console=tty1')
 raise FileNotFoundError(p)
with patch.object(glob,'glob',lambda pattern:[p for p in fixture_paths if fnmatch.fnmatch(p,pattern)]),patch.object(os.path,'realpath',realpath),patch.object(os,'stat',fake_stat),patch.object(os,'access',lambda p,mode:p!=fixture['denied']),patch.object(builtins,'open',fake_open):
 exec(${JSON.stringify(python)})
`;
    const result=spawnSync('python3',['-c',wrapper],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    return{code:result.status,stdout:result.stdout,stderr:result.stderr};
  }});
  vm.runInContext(server.slice(server.indexOf('async function discoverRobotSerialPorts('),server.indexOf("app.post('/api/serial/ports'")),context);
  return context.discoverRobotSerialPorts({robotKey:'fixture'},true);
}

test('robot discovery includes GPIO UART and ttyS, resolves serial aliases once, and distinguishes Pi 5 debug UART',async()=>{
  const result=await discover();assert.equal(result.ports.length,4);
  const gpio=result.ports.find(p=>p.path==='/dev/ttyAMA0'),debug=result.ports.find(p=>p.path==='/dev/ttyAMA10');
  assert.equal(gpio.kind,'uart');assert.deepEqual([...gpio.aliases],['/dev/serial1']);assert.equal(gpio.consoleInUse,false);
  assert.equal(debug.kind,'debug-uart');assert.deepEqual([...debug.aliases],['/dev/serial0']);assert.equal(debug.consoleInUse,true);
  assert.match(debug.label,/not GPIO14\/15/);assert.equal(result.ports.find(p=>p.path==='/dev/ttyS0').accessible,false);
  assert.equal(result.uartHint,'');
});

test('missing Pi 5 GPIO UART reports boot configuration guidance without inventing a connected port',async()=>{
  const result=await discover({devices:['/dev/ttyAMA10'],aliases:{'/dev/serial0':'/dev/ttyAMA10'}});
  assert.equal(result.ports.length,1);assert.equal(result.ports[0].path,'/dev/ttyAMA10');assert.match(result.uartHint,/uart0-pi5/);
  assert.match(result.uartHint,/reboot/);
});

test('controller validators accept GPIO devices and serial aliases but reject shell injection and arbitrary files',()=>{
  const expressions=[server.match(/const SERIAL_DEVICE_PATTERN=(.*);/)[1],
    ...['public/mapping.js','public/navigation.js','public/tune.js','public/hardware.js'].map(file=>read(file).match(/\/\^\\\/dev.*?\$\//)[0])];
  for(const expression of expressions){const regex=vm.runInNewContext(expression);
    for(const port of ['/dev/ttyAMA0','/dev/ttyAMA10','/dev/ttyS0','/dev/serial0','/dev/serial1','/dev/ttyUSB0'])assert.equal(regex.test(port),true,expression+' '+port);
    for(const port of ['/etc/passwd','/dev/serial0;reboot','/dev/serial0/../null','/dev/serial','/dev/ttyAMA0\n'])assert.equal(regex.test(port),false,port);
  }
});

function browser(file,hardware={serialPort:'/dev/serial1',baudRate:115200},savedController=''){
  const nodes=new Map(),logs=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',options:[],add(option){this.options.push(option);},set innerHTML(_){this.options=[];this.value='';}});return nodes.get(id);};
  const ports=[{path:'/dev/ttyUSB0',kind:'usb',accessible:true},{path:'/dev/ttyAMA0',aliases:['/dev/serial1'],kind:'uart',label:'UART / GPIO',accessible:true},{path:'/dev/ttyAMA10',aliases:['/dev/serial0'],kind:'debug-uart',accessible:true}];
  const context=vm.createContext({document:{getElementById:node},getAuthToken:()=>'',authHeaders:()=>({}),localStorage:{getItem:key=>key.includes('_controller_port:')?savedController:'',setItem(){}},Option:function(text,value){this.text=text;this.value=value;},setTimeout,clearTimeout,AbortController,
    fetch:async(url,{body})=>{const request=JSON.parse(body);let result={ok:true};
      if(url==='/api/files/read')result=request.path.endsWith('hardware.json')?{ok:true,content:JSON.stringify(hardware)}:request.path.endsWith('selected_lidar.json')?{ok:true,content:JSON.stringify({port:'/dev/ttyUSB0',modelId:'rplidar_c1'})}:{ok:false,error:'missing map result'};
      if(url==='/api/serial/ports')result={ok:true,ports};
      if(url==='/api/navigation/maps')result={ok:true,maps:[]};
      return{ok:true,json:async()=>result};
    }});
  const source=read(file),end=source.indexOf(file.includes('mapping')?'async function restore()':'function watchNavInstall()');
  vm.runInContext(source.slice(0,end),context);context.log=message=>logs.push(message);
  return{node,run:code=>vm.runInContext(code,context)};
}

for(const file of ['public/mapping.js','public/navigation.js'])test(`${file}: saved UART alias resolves to GPIO port even without mapping_result.json`,async()=>{
  const f=browser(file);await f.run(file.includes('mapping')?'refreshPorts()':'refresh()');
  assert.equal(f.node('controller-port').value,'/dev/ttyAMA0');assert.equal(f.node('lidar-port').value,'/dev/ttyUSB0');
  assert.ok(f.node('controller-port').options.some(o=>o.text.includes('UART / GPIO')));
});

for(const file of ['public/mapping.js','public/navigation.js'])test(`${file}: stale USB controller default does not hide the available GPIO UART`,async()=>{
  const f=browser(file,{serialPort:'/dev/ttyUSB0'});await f.run(file.includes('mapping')?'refreshPorts()':'refresh()');
  assert.equal(f.node('controller-port').value,'/dev/ttyAMA0');assert.equal(f.node('lidar-port').value,'/dev/ttyUSB0');
});

for(const file of ['public/mapping.js','public/navigation.js'])for(const port of ['/dev/ttyAMA10','/dev/serial0'])test(`${file}: stale Pi 5 debug UART ${port} is not auto-selected for the controller`,async()=>{
  const f=browser(file,{serialPort:port});await f.run(file.includes('mapping')?'refreshPorts()':'refresh()');
  assert.equal(f.node('controller-port').value,'/dev/ttyAMA0');assert.equal(f.node('lidar-port').value,'/dev/ttyUSB0');
  assert.ok(f.node('controller-port').options.some(o=>o.value==='/dev/ttyAMA10'),'debug UART remains available for explicit selection');
});

test('Mapping does not let a stale browser-cached debug UART override the working hardware GPIO UART',async()=>{
  const f=browser('public/mapping.js',{serialPort:'/dev/ttyAMA0'},'/dev/ttyAMA10');await f.run('refreshPorts()');
  assert.equal(f.node('controller-port').value,'/dev/ttyAMA0');
});
