'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{spawnSync}=require('node:child_process');
const motion=require('../public/real-drive-motion');
const config={drive:'mecanum4',robotDesign:{hardwareTemplate:'mecanum_xy'},wheelDiameterMm:127,wheelBaseMm:600,wheelTrackMm:720,motorMaxRpm:300};
const values=command=>command.split(' ').slice(1).map(Number),signs=command=>values(command).map(Math.sign);
test('Mecanum XY turn and strafe account for the controller rear-channel order',()=>{
  assert.deepEqual(motion.controllerWheelOrder(config),['front_left','front_right','rear_right','rear_left']);
  assert.deepEqual(signs(motion.rpmCommand(config,0,0,.6)),[-1,1,1,-1]);
  assert.deepEqual(signs(motion.rpmCommand(config,0,.2,0)),[-1,1,-1,1]);
  assert.deepEqual(signs(motion.rpmCommand(config,0,0,-.6)),[1,-1,-1,1]);
  assert.deepEqual(signs(motion.rpmCommand(config,0,-.2,0)),[1,-1,1,-1]);
  assert.deepEqual(signs(motion.rpmCommand(config,.2,0,0)),[1,1,1,1]);
});
test('explicit controller layouts and generic Mecanum retain canonical order',()=>{
  const canonical=['front_left','front_right','rear_left','rear_right'];
  assert.deepEqual(signs(motion.rpmCommand({...config,controllerWheelOrder:canonical},0,0,.6)),[-1,1,-1,1]);
  assert.deepEqual(motion.controllerWheelOrder({...config,robotDesign:{}}),canonical);
  assert.throws(()=>motion.controllerWheelOrder({...config,controllerWheelOrder:['front_left','front_left','rear_left','rear_right']}));
});
test('mapping validation permits only bounded four-wheel RPM, legacy CMD and STOP',()=>{
  assert.equal(motion.mappingCommand('R -30 30 30 -30'),'R -30.0000 30.0000 30.0000 -30.0000');
  assert.equal(motion.mappingCommand('CMD 4 -30'),'CMD 1.5 -10');assert.equal(motion.mappingCommand('STOP'),'STOP');
  for(const text of ['R 1 2','R 1 2 3 4 5','R NaN 0 0 0','R Infinity 0 0 0','R 5001 0 0 0','R 1 2 3 4\nS','P 1 2 3','V 1 0 0','CMD NaN 0'])assert.equal(motion.mappingCommand(text),'',text);
});
test('Mapping and practice generate the same corrected RPM and separate rotation/lateral keys',()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='linear'?'.2':'.6',textContent:'',classList:{toggle(){}}});return nodes.get(id);};
  const context=vm.createContext({RealDriveMotion:motion,getAuthToken:()=>'',document:{getElementById:node,querySelector:()=>null,querySelectorAll:()=>[]}});
  const source=fs.readFileSync('public/mapping.js','utf8');vm.runInContext(source.slice(0,source.indexOf("document.querySelectorAll('[data-layer]')")),context);
  const run=text=>vm.runInContext(text,context);run(`mappingHardware=${JSON.stringify(config)}`);
  assert.equal(run("commandFor('left')"),motion.rpmCommand(config,0,0,.6));
  assert.equal(run("commandFor('strafe-left')"),motion.rpmCommand(config,0,.2,0));
  assert.equal(run("mappingKeyDirection('q')"),'left');assert.equal(run("mappingKeyDirection('a')"),'strafe-left');
  run("mappingHardware={drive:'diff2'}");assert.equal(run("commandFor('left')"),'CMD 0 0.6');assert.equal(run("commandFor('strafe-left')"),'STOP');
});
test('generated Mapping Python forwards four-wheel RPM and preserves the command watchdog',()=>{
  const server=fs.readFileSync('server.js','utf8'),section=server.indexOf("} else if(pathname==='/ws/mapping'){"),start=server.indexOf('const pyLines=[',section),end=server.indexOf('\n          ];',start)+14;
  const context=vm.createContext({port:'/dev/ttyUSB1',baud:115200,pidCommand:''});vm.runInContext(server.slice(start,end)+';globalThis.python=pyLines.join("\\n");',context);
  const code=`import ast,io,json,math,sys,types
payload=json.loads(sys.stdin.read())
tree=ast.parse(payload['source'])
loop=next(n for n in tree.body if isinstance(n,ast.While))
command=next(n for n in loop.body if isinstance(n,ast.If) and 'select.select' in ast.unparse(n.test))
watchdog=next(n for n in loop.body if isinstance(n,ast.If) and 'last_cmd' in ast.unparse(n.test))
def compiled(node): return compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'<mapping>','exec')
result=[]
for text in payload['commands']:
 sent=[]
 env={'math':math,'now':10.,'last_cmd':0.,'send':sent.append,'sys':types.SimpleNamespace(stdin=io.StringIO(text+'\\n')),'select':types.SimpleNamespace(select=lambda *args:([1],[],[]))}
 exec(compiled(command),env)
 result.append({'sent':list(sent),'last':env['last_cmd']})
 if env['last_cmd']:
  env['now']=10.4;exec(compiled(watchdog),env)
  assert sent[-1]=='S' and env['last_cmd']==0.
print(json.dumps(result))`;
  const commands=['R -30 30 30 -30','R nan 0 0 0','R 9000 0 0 0','CMD 0 .6','STOP'];
  const result=spawnSync('python3',['-c',code],{input:JSON.stringify({source:context.python,commands}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const rows=JSON.parse(result.stdout);assert.deepEqual(rows[0].sent,['R -30.0000 30.0000 30.0000 -30.0000']);assert.deepEqual(rows[1].sent,[]);assert.deepEqual(rows[2].sent,[]);assert.deepEqual(rows[3].sent,['V 0.0000 0 0.6000']);assert.deepEqual(rows[4].sent,['S']);
});
