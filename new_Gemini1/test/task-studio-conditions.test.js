'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const M=require('../public/task-studio-model'),A=require('../public/task-studio-application'),runner=fs.readFileSync('public/task-studio-runner.py','utf8');
test('Topic if/else validates both branches, participates in graph ports and preserves export',()=>{
  const condition={...M.block('if_topic'),msgType:'std_msgs/msg/Bool',body:[{...M.block('log'),text:'true branch'}],elseBody:[{...M.block('call'),fn:'fallback',args:{}}]},p={version:1,name:'decide',main:[condition],functions:[{name:'fallback',params:{},body:[M.block('wait')]}]};
  assert.deepEqual(M.validate(p),[]);const app=A.migrate(p),u=app.units[0];assert.deepEqual(A.validateDraft(app),[]);assert.equal(A.ports(app,u)[0].id,condition.id);assert.equal(A.endpoint(app,u.id,condition.id,false).topic,condition.topic);
  const files=A.packageFiles(app,runner);assert.deepEqual(JSON.parse(files['decide/flows/main_node.flow.json']).main[0].elseBody,condition.elseBody);
  p.main=[{...M.block('parallel'),branches:[[condition],[]]}];p.functions[0].body.push(M.block('odom_position'));assert.match(M.validate(p).join(),/เคลื่อนที่ออก/);
  p.functions[0].body=[{...M.block('call'),fn:'fallback',args:{}}];assert.match(M.validate(p).join(),/วนกลับ/);
});
test('exported conditions distinguish true, false and missing data in main and worker lanes',()=>{
  execFileSync('python3',['-c',`import ast,sys,time,math,threading,queue
from itertools import chain
class Node: pass
tree=ast.parse(sys.stdin.read())
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name!='main'],type_ignores=[]),'runtime','exec'))
block={'id':'b1','type':'if_topic','topic':'/detected','msgType':'std_msgs/msg/Bool','field':'data','op':'==','value':True,'timeout':1,'body':[{'id':'b2','type':'log','text':'YES'}],'elseBody':[{'id':'b3','type':'log','text':'NO'}]}
def fixture(value,age=0):
 n=TaskRunner.__new__(TaskRunner);n.program={'name':'test','main':[block],'functions':[]};n.dry=True;n.active=True;n.current=None;n.output=None;n.iterator=events(n.program,n.program['main']);n.event_count=0;n.start_at=n.last_debug=0;n.samples={} if value is None else {'/detected':({'data':value},time.monotonic()-age)};n.watch=lambda *args:None;n.cancel_workers=threading.Event();n.worker_events=queue.Queue(maxsize=256);n.seen=[];n.report=lambda:n.seen.append(n.current[0].get('text')) if n.current and n.current[3]=='enter' else None;return n
for value,wanted,unwanted in [(True,'YES','NO'),(False,'NO','YES')]:
 n=fixture(value)
 for _ in range(12):n.tick()
 assert n.phase=='succeeded' and wanted in n.seen and unwanted not in n.seen,(n.phase,n.seen)
 n=fixture(value);n.run_lane([block],{},['Main'],'A');messages=[]
 while not n.worker_events.empty():messages.append(n.worker_events.get_nowait()[1]['message'])
 assert wanted in messages and unwanted not in messages
for value,age in [(None,0),(False,3)]:
 n=fixture(value,age);assert n.topic_condition(block) is None;n.tick();assert n.active and not n.seen.count('NO');n.start_at-=2;n.tick();assert n.phase=='failed' and 'NO' not in n.seen
n=fixture(True);n.samples['/detected']=({'other':True},time.monotonic());assert n.topic_condition(block) is None
assert condition(False,'==',False) and not condition(1,'>',True)
`],{input:runner,timeout:5000});
});
