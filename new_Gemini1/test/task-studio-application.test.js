'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const M=require('../public/task-studio-model'),A=require('../public/task-studio-application'),runner=fs.readFileSync('public/task-studio-runner.py','utf8');
const b=(type,values={})=>({...M.block(type),...values});
test('parallel validation follows function calls and rejects competing motion, recursion and nested workers',()=>{
  const p={version:1,name:'parallel_demo',main:[b('parallel',{branches:[[b('call',{fn:'hello',args:{delay:.1}})],[b('wait',{seconds:.2})]]})],functions:[{name:'hello',params:{delay:1},body:[b('wait',{seconds:'$delay'})]}]};
  assert.deepEqual(M.validate(p),[]);p.functions[0].body.push(b('odom_position'));assert.match(M.validate(p).join(),/เคลื่อนที่ออก/);p.functions[0].body.pop();p.functions[0].body.push(b('parallel'));assert.match(M.validate(p).join(),/ไม่ซ้อน/);
  const publish=b('publish');p.main=[publish];p.functions=[];assert.deepEqual(M.validate(p),[]);publish.topic='/cmd_vel';assert.ok(M.validate(p).length);publish.topic='/task_studio/user/value';publish.msgType='std_msgs/msg/Float64';publish.value=true;assert.ok(M.validate(p).length);
});
test('unfinished drafts remain editable but cannot be executed or exported',()=>{
  const app=A.migrate();app.units[0].program.main=[b('call',{fn:'not_created_yet',args:{}})];
  assert.deepEqual(A.validateDraft(app),[]);assert.ok(A.validate(app).length);assert.throws(()=>A.packageFiles(app,runner));
  app.units[0].program.main[0].type='unsupported';assert.ok(A.validateDraft(app).length);
  app.units[0].program.main=[];app.drafts=[];assert.ok(A.validateDraft(app).length);
});
test('application migrates v1 without mutation, wires typed topics, exports separate buildable ROS nodes and packages',async()=>{
  const old=M.sample(),original=JSON.stringify(old),app=A.migrate(old);assert.equal(JSON.stringify(old),original);assert.deepEqual(A.validate(app),[]);
  const out=b('publish'),input=b('wait_topic',{value:'พร้อมแล้ว'});
  app.units[0].program.main=[out];const next=A.unit({version:1,name:'receiver',main:[input],functions:[]},'receiver_pkg','receiver');app.units.push(next);
  A.connect(app,app.units[0].id,out.id,next.id,input.id);assert.equal(input.topic,'/object_detected');assert.equal(next.program.main[0].topic,out.topic);assert.equal(next.program.main[0].msgType,out.msgType);assert.deepEqual(A.validate(app),[]);
  next.program.main[0].msgType='std_msgs/msg/Bool';assert.throws(()=>A.connect(app,app.units[0].id,out.id,next.id,input.id),/ชนิดข้อมูล/);next.program.main[0].msgType=out.msgType;
  const files=A.packageFiles(app,runner);assert.ok(files['robot_task/robot_task/main_node.py']);assert.ok(files['receiver_pkg/receiver_pkg/receiver.py']);assert.ok(files['my_robot_app_bringup/launch/application.launch.py']);assert.ok(!files['robot_task/robot_task/task_runner.py']);
  const zip=Buffer.from(await M.zip(files).arrayBuffer());
  execFileSync('python3',['-c',`import ast,io,sys,zipfile,json,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None
for n in z.namelist():
 if n.endswith('.py'): ast.parse(z.read(n))
 if n.endswith('package.xml'): E.fromstring(z.read(n))
assert b"flows/receiver.flow.json" in z.read('receiver_pkg/receiver_pkg/receiver.py')
assert b"/task_studio/receiver_pkg/receiver/debug" in z.read('my_robot_app_bringup/launch/application.launch.py')
assert json.loads(z.read('receiver_pkg/flows/receiver.flow.json'))['main'][0]['topic']=='/task_studio/user/hello'
assert b"'dry_run':True" in z.read('my_robot_app_bringup/launch/application.launch.py')`],{input:zip});
  assert.equal(Object.keys(A.packageFiles(app,runner,'receiver_pkg')).every(p=>p.startsWith('receiver_pkg/')),true);
  app.units[0].program.main.push(b('odom_position'));next.program.main.push(b('odom_position'));assert.match(A.validate(app).join(),/เคลื่อนที่เพียงตัวเดียว/);
});
test('exported worker threads overlap, join, retain parameters, cancel siblings and never run motion',()=>{
  execFileSync('python3',['-c',`import ast,sys,time,math,threading,queue
from concurrent.futures import ThreadPoolExecutor
class Node: pass
tree=ast.parse(sys.stdin.read())
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name!='main'],type_ignores=[]),'runtime','exec'))
def fixture():
 n=TaskRunner.__new__(TaskRunner);n.program={'main':[],'functions':[{'name':'delay','params':{'seconds':.3},'body':[{'id':'b3','type':'wait','seconds':'$seconds'}]}]};n.dry=True;n.cancel_workers=threading.Event();n.worker_events=queue.Queue(maxsize=256);n.samples={};n.workers=ThreadPoolExecutor(max_workers=2);return n
n=fixture();t=time.monotonic()
jobs=[n.workers.submit(n.run_lane,[{'id':'b1','type':'call','fn':'delay','args':{'seconds':.35}}],{},['Main'],lane) for lane in ('A','B')]
for f in jobs: f.result(timeout=2)
elapsed=time.monotonic()-t;assert .3<elapsed<.65,elapsed
seen=[]
while not n.worker_events.empty(): seen.append(n.worker_events.get_nowait())
assert {x[0] for x in seen}=={'A','B'}
assert any(x[1]['env'].get('seconds')==.35 for x in seen)
n.close_workers()
n=fixture();long=n.workers.submit(n.run_lane,[{'id':'b2','type':'wait','seconds':60}],{},['Main'],'B')
bad=n.workers.submit(n.run_lane,[{'id':'b1','type':'odom_position'}],{},['Main'],'A')
try: bad.result(timeout=1);raise AssertionError('motion allowed')
except ValueError: pass
long.result(timeout=1);assert n.cancel_workers.is_set();n.close_workers()
n=fixture();n.publish_user({'type':'publish','topic':'/task_studio/user/hello','msgType':'std_msgs/msg/String','value':'hello'})
try: n.publish_user({'type':'publish','topic':'/cmd_vel','msgType':'std_msgs/msg/String','value':'hello'});raise AssertionError('unsafe publish')
except ValueError: pass
n.close_workers()
`],{input:runner,timeout:5000});
});
test('Blockly assets are local and only Task Studio loads the editor',()=>{
  const html=fs.readFileSync('public/task-studio.html','utf8');assert.match(html,/task-blockly\.js/);assert.doesNotMatch(html,/https?:\/\/.*blockly/);
  for(const file of ['index.html','flow.js','playground.js','dashboard.js'])assert.doesNotMatch(fs.readFileSync('public/'+file,'utf8'),/task-blockly|task-studio-editor/);
  assert.ok(fs.readFileSync('public/task-blockly-LICENSE.txt','utf8').includes('Apache License'));
});
