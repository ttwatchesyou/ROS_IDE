'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{spawnSync}=require('node:child_process');
const {validateSequence}=require('../navigation-sequence');
const point={x:1,y:2,yaw:0,waitSeconds:0};
test('sequence requests validate finite coordinates, limits and correlation IDs',()=>{
  assert.deepEqual(validateSequence({runId:'job_1',points:[point]}),{runId:'job_1',points:[point]});
  for(const job of [{runId:'bad\nGOAL',points:[point]},{runId:'a',points:[]},{runId:'a',points:Array(51).fill(point)},{runId:'a',points:[{...point,x:'1'}]},{runId:'a',points:[{...point,y:NaN}]},{runId:'a',points:[{...point,waitSeconds:-1}]},{runId:'a',points:[{...point,waitSeconds:3601}]}])assert.equal(validateSequence(job),null);
});
test('Nav2 runner waits for success, honors dwell time, and never advances on failure or canceled goals',()=>{
  const code=`import importlib.util,types
spec=importlib.util.spec_from_file_location('sequence','navigation-sequence.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Future:
 def __init__(self): self.callbacks=[]; self.value=None
 def add_done_callback(self,callback): self.callbacks.append(callback)
 def result(self): return self.value
 def resolve(self,value):
  self.value=value
  for callback in list(self.callbacks): callback(self)
class Handle:
 def __init__(self,accepted=True): self.accepted=accepted; self.future=Future(); self.canceled=0
 def get_result_async(self): return self.future
 def cancel_goal_async(self): self.canceled+=1
class Client:
 def __init__(self): self.ready=True; self.requests=[]
 def server_is_ready(self): return self.ready
 def send_goal_async(self,goal):
  future=Future();self.requests.append((goal,future));return future
clock=[0.];stops=[];updates=[];client=Client()
runner=m.NavigationSequence(client,lambda:types.SimpleNamespace(),lambda *p:p,lambda:stops.append(True),updates.append,lambda:clock[0])
points=[{'x':1,'y':2,'yaw':0,'waitSeconds':2},{'x':3,'y':4,'yaw':1,'waitSeconds':0}]
assert runner.start('job1',points)
assert len(client.requests)==1 and runner.phase=='sending'
h=Handle();client.requests[0][1].resolve(h)
assert runner.phase=='active' and not runner.blocks_motion()
runner.tick();assert len(client.requests)==1
h.future.resolve(types.SimpleNamespace(status=4))
assert runner.phase=='waiting' and runner.blocks_motion() and runner.index==1
clock[0]=1.;runner.tick();assert len(client.requests)==1
clock[0]=2.;runner.tick();assert len(client.requests)==2 and runner.phase=='sending'
h2=Handle();client.requests[1][1].resolve(h2);h2.future.resolve(types.SimpleNamespace(status=4));runner.tick()
assert runner.phase=='succeeded' and runner.snapshot()['completed']==2
assert not runner.start('job1',points),'completed run must not replay'
assert runner.start('job2',points);late=client.requests[-1][1];runner.cancel();late_handle=Handle();late.resolve(late_handle)
assert late_handle.canceled==1 and runner.phase=='canceled'
assert runner.start('job3',points);h3=Handle();client.requests[-1][1].resolve(h3);before=len(client.requests);h3.future.resolve(types.SimpleNamespace(status=6));runner.tick()
assert runner.phase=='aborted' and len(client.requests)==before
assert runner.start('job4',points);h4=Handle(False);client.requests[-1][1].resolve(h4);assert runner.phase=='rejected'
assert runner.start('job5',points);h5=Handle();client.requests[-1][1].resolve(h5);runner.cancel();assert h5.canceled==1
assert runner.start('job6',points);generation=runner.generation;h5.future.resolve(types.SimpleNamespace(status=4))
assert runner.generation==generation and runner.phase=='sending' and runner.index==0
runner.cancel();client.ready=False;assert runner.start('job7',points);assert runner.phase=='server_unavailable'
print('Sequential goal, wait, cancel, late callback, failure and duplicate-run checks passed')`;
  const result=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('generated navigation bridge includes a valid sequence runner and blocks residual velocity while waiting',()=>{
  const source=fs.readFileSync('server.js','utf8'),section=source.indexOf("} else if(pathname==='/ws/navigation'){"),start=source.indexOf('const pyLines=[',section),end=source.indexOf('\n          ];',start)+14;
  const context=vm.createContext({port:'/dev/ttyUSB0',baud:115200,pidCommand:'',maxSpeed:.2,maxTurn:.6,minSpeed:.1,minTurn:.2,fs_node:fs,path,__dirname:path.resolve('.')});
  vm.runInContext(source.slice(start,end)+';globalThis.python=pyLines.join("\\n");',context);
  const code=`import ast,types,sys
source=sys.stdin.read();tree=ast.parse(source)
assert 'SEQUENCE ' in source and 'sequence.tick()' in source
assert 'sequence=state.get' in source
node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='cmd_cb')
sent=[]
sequence=types.SimpleNamespace(blocks_motion=lambda:True)
env={'sequence':sequence,'send':sent.append,'last_cmd':1}
exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'<nav>','exec'),env)
env['cmd_cb'](None)
assert sent==['S'] and env['last_cmd']==0
print('Generated Python parses and ignores residual Nav2 velocity during dwell/cancel')`;
  const result=spawnSync('python3',['-c',code],{input:context.python,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
