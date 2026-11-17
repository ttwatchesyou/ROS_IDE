'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
test('native Blockly runtime: functions, fresh false vs missing, deadlines, parallel join/cancellation and fail-closed Python/motion',()=>{
  const source=fs.readFileSync('public/task-studio-runner.py','utf8')+'\n'+fs.readFileSync('public/task-studio-native.py','utf8');
  const script=`import ast,sys,time,math,threading,queue,json
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from itertools import chain
class Node: pass
tree=ast.parse(sys.stdin.read())
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name!='main'],type_ignores=[]),'native-runtime','exec'))
def fixture():
 n=BlocklyRunner.__new__(BlocklyRunner);n.dry=True;n.active=True;n.output=None;n.allow_python=False;n.cancel_workers=threading.Event();n.native_lock=threading.Lock();n.native_steps=0;n.start_at=time.monotonic();n.worker_events=queue.Queue(maxsize=256);n.workers=ThreadPoolExecutor(max_workers=2);n.native_pool=ThreadPoolExecutor(max_workers=1);n.native_future=None;n.native_inputs={'/detected':'std_msgs/msg/Bool'};n.native_outputs={('/task_studio/user/flag','std_msgs/msg/Bool')};n.samples={};n.safety_at=0;n.safety_ok=False;n.lanes={};n.current=None;n.last_debug=0;n.watch=lambda *args:None;n.report=lambda:None
 def finish(phase,message):n.active=False;n.phase=phase;n.message=message;n.cancel_workers.set()
 n.finish=finish
 return n
def messages(n):
 out=[]
 while not n.worker_events.empty():out.append(n.worker_events.get_nowait()[1])
 return out
n=fixture();ctx=BlocklyContext(n)
try:
 n.samples['/detected']=({'data':False},time.monotonic());assert ctx.read('/detected','data',.05) is False
 for data,age in [({'data':False},3),({'other':True},0),({'data':None},0)]:
  n.samples['/detected']=(data,time.monotonic()-age)
  try:ctx.read('/detected','data',.03);raise AssertionError('missing data accepted')
  except TimeoutError:pass
 n.samples={};began=time.monotonic()
 try:ctx.until(lambda:ctx.read('/detected','data',10),.04);raise AssertionError('outer timeout ignored')
 except TimeoutError:assert time.monotonic()-began<.2
 assert ctx.condition_deadline is None
 for lane in ['A','B']:
  try:BlocklyContext(n,lane).move(0,0,0,.1,30);raise AssertionError('motion allowed in lane')
  except RuntimeError:pass
 ctx.move(1,0,0,.1,30);assert any('skipped' in m['message'] for m in messages(n))
 for x in [float('nan'),101,True]:
  try:ctx.move(x,0,0,.1,30);raise AssertionError('invalid motion accepted')
  except ValueError:pass
 ctx.publish('/task_studio/user/flag','std_msgs/msg/Bool',False)
 for topic,kind,value in [('/cmd_vel','std_msgs/msg/Bool',True),('/task_studio/user/flag','std_msgs/msg/Bool','false')]:
  try:ctx.publish(topic,kind,value);raise AssertionError('unsafe publish accepted')
  except ValueError:pass
 for dry,enabled in [(True,True),(False,False)]:
  n.dry=dry;n.allow_python=enabled;n.safety_ok=True;n.safety_at=time.monotonic()
  try:ctx.python('raise AssertionError("MUST_NOT_EXECUTE")');raise AssertionError('Python was not gated')
  except RuntimeError:pass
 n.dry=True;n.allow_python=False
 barrier=threading.Barrier(2);seen=[]
 def lane(c):barrier.wait(timeout=1);c.wait(.05);seen.append(c.lane)
 ctx.parallel(lane,lane);assert sorted(seen)==['A','B']
 # Transitive procedures receive the lane context, never Main authority.
 def helper(c):c.move(0,0,0,.1,1)
 try:helper(BlocklyContext(n,'A'));raise AssertionError('indirect lane motion')
 except RuntimeError:pass
 def fail(c):raise ValueError('lane failure')
 began=time.monotonic()
 try:ctx.parallel(fail,lambda c:c.wait(30));raise AssertionError('failed lane ignored')
 except (ValueError,RuntimeError):pass
 assert n.cancel_workers.is_set() and time.monotonic()-began<.5
finally:n.close_workers()
# Exercise the executor tick, not only context helpers: Python functions, loops,
# variables, explicit lane contexts and terminal state without ROS/hardware.
n=fixture()
try:
 GENERATED_BLOCKLY_SOURCE='def twice(ctx, x):\\n  ctx.step("function", locals())\\n  return x*2\\nfor x in [1,2,3]:\\n  ctx.guard()\\n  ctx.step("body", locals())\\n  ctx.log(twice(ctx,x))\\n'
 for _ in range(100):
  n.tick()
  if not n.active:break
  time.sleep(.005)
 assert n.phase=='complete',getattr(n,'message','')
 assert n.lanes['Main']['message']=='6'
finally:n.close_workers()
n=fixture();n.dry=False
try:n.tick();assert n.phase=='failed' and 'safety' in n.message
finally:n.close_workers()
print('native execution and safety guards OK')
`;
  assert.match(execFileSync('python3',['-c',script],{input:source,timeout:7000,encoding:'utf8'}),/safety guards OK/);
});
