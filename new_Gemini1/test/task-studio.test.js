'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const M=require('../public/task-studio-model'),root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('Task Studio functions bind local arguments, nest, repeat, and reject recursion and invalid blocks',()=>{
  const p=M.sample();assert.deepEqual(M.validate(p),[]);p.main[1].args.delay=3;
  assert.equal([...M.steps(p)].find(e=>e.block.type==='wait').block.seconds,3);
  p.functions.push({name:'nested',params:{amount:2},body:[{...M.block('call'),fn:'inspect',args:{delay:'$amount'}}]});
  p.main.push({...M.block('repeat'),count:2,body:[{...M.block('call'),fn:'nested',args:{amount:4}}]});
  assert.deepEqual(M.validate(p),[]);
  const waits=[...M.steps(p)].filter(e=>e.phase==='enter'&&e.block.type==='wait');assert.deepEqual(waits.map(e=>e.block.seconds),[3,4,4]);assert.deepEqual(waits[1].stack,['Main','รอบ 1/2','nested','inspect']);
  p.functions[0].body.push({...M.block('call'),fn:'nested',args:{}});assert.match(M.validate(p).join(' '),/วนกลับ/);
  const bad=M.sample();bad.main.push({...M.block('odom_position'),speed:2});assert.match(M.validate(bad).join(' '),/ความเร็ว/);
  bad.main[1].args.delay='$missing';assert.match(M.validate(bad).join(' '),/พารามิเตอร์/);
  assert.ok(M.validate({version:1,name:'valid',main:[],functions:[null]}).length);
  assert.equal(M.compare(undefined,'!=',true),false);assert.equal(M.compare('1','==',1),false);assert.equal(M.field({pose:{x:2}},'pose.x'),2);
});
test('export is a valid offline ROS package ZIP with round-trip graph and safe default launch',async()=>{
  const p=M.sample(),files=M.packageFiles(p,read('public/task-studio-runner.py'));
  const buffer=Buffer.from(await M.zip(files).arrayBuffer());
  const output=execFileSync('python3',['-c',`import ast,io,json,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
assert json.loads(z.read('robot_task/flows/task.flow.json'))['functions'][0]['name']=='inspect'
assert E.fromstring(z.read('robot_task/package.xml')).find('export/build_type').text=='ament_python'
for name in z.namelist():
 if name.endswith('.py'): ast.parse(z.read(name))
assert b"'dry_run':True" in z.read('robot_task/launch/task.launch.py')
assert b'__TASK_PACKAGE__' not in z.read('robot_task/robot_task/task_runner.py')
print(len(z.namelist()))`],{input:buffer}).toString().trim();assert.equal(output,'9');
});
test('exported runtime pure logic matches function steps and clamps/stops odometry control',()=>{
  const output=execFileSync('python3',['-c',`import ast,json,math,sys
source=sys.stdin.read(); tree=ast.parse(source)
defs=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('resolve','events','condition','motion')]
exec(compile(ast.Module(body=defs,type_ignores=[]),'runtime','exec'))
p={'functions':[{'name':'f','params':{'n':1},'body':[{'id':'b2','type':'wait','seconds':'$n'}]}]}
ev=list(events(p,[{'id':'b1','type':'call','fn':'f','args':{'n':2}}]))
assert ev[1][0]['seconds']==2 and ev[1][1]==['Main','f']
assert condition(1.,'==',1) and not condition(True,'==',1)
b={'x':1.,'y':0.,'yaw':0.,'speed':.1,'timeout':30}
v,w,done=motion((0,0,0),b);assert 0<v<=.1 and w==0 and not done
assert motion((1,0,0),b)==(0.,0.,True)
assert motion((0,0,math.pi),b)[0]==0
b['speed']=1
try: motion((0,0,0),b);raise AssertionError('unsafe speed accepted')
except ValueError: pass
print('ok')`],{input:read('public/task-studio-runner.py')}).toString().trim();assert.equal(output,'ok');
});
test('new mode is additive and never reuses the Sim or wizard execution paths',()=>{
  const ui=read('public/task-studio.js'),probe=read('public/task-studio-probe.py'),entry=read('public/task-studio-entry.js');
  assert.match(ui,/if\(result\.isSim\)throw/);assert.match(entry,/!isSimWorkspace/);
  assert.doesNotMatch(probe,/create_publisher|cmd_vel|subprocess|os\.system/);
  assert.doesNotMatch(ui,/\/api\/sim\/|pkill|systemctl|ros2 run|ros2 launch|files\/write/);
  for(const file of ['public/flow.js','public/playground.js','public/dashboard.js','sim.js'])assert.doesNotMatch(read(file),/task-studio/);
  assert.match(read('public/index.html'),/task-studio-entry\.js/);
});

test('runtime fails closed on lost safety permit, stale ODOM and cancellation',()=>{
  const script=`import ast,math,time,sys,types
tree=ast.parse(sys.stdin.read())
class Node: pass
class Twist:
 def __init__(self): self.linear=types.SimpleNamespace(x=0.);self.angular=types.SimpleNamespace(z=0.)
defs=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name!='main']
exec(compile(ast.Module(body=defs,type_ignores=[]),'runtime','exec'))
class Output:
 def __init__(self): self.commands=[]
 def publish(self,m): self.commands.append((m.linear.x,m.angular.z))
def fixture():
 n=TaskRunner.__new__(TaskRunner);n.dry=False;n.active=True;n.output=Output();n.report=lambda:None
 n.safety_ok=True;n.safety_at=time.monotonic();n.pose=(0.,0.,0.);n.pose_at=time.monotonic();n.event_count=0
 n.last_debug=0;n.start_at=time.monotonic();n.current=({'id':'b1','type':'odom_position','x':1.,'y':0.,'yaw':0.,'speed':.1,'timeout':30},['Main'],{},'enter')
 return n
n=fixture();n.safety_ok=False;n.tick();assert not n.active and n.phase=='failed' and n.output.commands==[(0.,0.)]
n=fixture();n.pose_at-=1;n.tick();assert n.phase=='failed' and n.output.commands==[(0.,0.)]
n=fixture();n.tick();assert n.active and n.output.commands[-1][0]>.0
n.finish('cancelled','operator stop');assert not n.active and n.output.commands[-1]==(0.,0.)
n=fixture();n.dry=True;n.output=None;n.tick();assert n.current is None
print('ok')`;
  assert.equal(execFileSync('python3',['-c',script],{input:read('public/task-studio-runner.py')}).toString().trim(),'ok');
});
