'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {genMapsimFiles}=require('../sim');
const {getSimHostStatus,scopedSimProcesses}=require('../sim-host-status');

test('indexed LiDAR matches brute force including axis-aligned rays and measures dense-field cost',()=>{
  const result=spawnSync('python3',['-c',`
import math,random,time,json,sys
exec(sys.stdin.read())
random.seed(142)
walls=[]
for x in range(-10,10):
    for y in range(-10,10):
        a,b=x*.6,y*.6
        walls.extend([(a,b,a+.2,b),(a+.2,b,a+.2,b+.2),(a+.2,b+.2,a,b+.2),(a,b+.2,a,b)])
index=WallIndex(walls)
def brute(ox,oy,angle,limit):
    dx,dy,best=math.cos(angle),math.sin(angle),limit
    for x1,y1,x2,y2 in walls:
        sx,sy=x2-x1,y2-y1; den=dx*sy-dy*sx
        if abs(den)<1e-9: continue
        t=((x1-ox)*sy-(y1-oy)*sx)/den; u=((x1-ox)*dy-(y1-oy)*dx)/den
        if 0<t<best and 0<=u<=1: best=t
    return best
rays=[(random.uniform(-8,8),random.uniform(-8,8),random.uniform(-math.pi,math.pi),10) for _ in range(1000)]
rays.extend((0,0,a,10) for a in (0,math.pi/2,math.pi,-math.pi/2))
t=time.perf_counter(); expected=[brute(*r) for r in rays]; old=time.perf_counter()-t
t=time.perf_counter(); actual=[index.ray(*r) for r in rays]; new=time.perf_counter()-t
assert all(abs(a-b)<1e-7 for a,b in zip(actual,expected))
assert WallIndex([]).ray(0,0,0,10)==10
print(json.dumps({'walls':len(walls),'rays':len(rays),'bruteMs':round(old*1000),'indexedMs':round(new*1000),'speedup':round(old/new,2)}))
`],{input:fs.readFileSync(path.join(__dirname,'../sim-spatial.py'),'utf8'),encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);console.log('LiDAR benchmark:',result.stdout.trim());
});

test('Python grid rejects expanded walls before allocating occupancy data',()=>{
  const source=genMapsimFiles()['sim_robot_mapsim/mapsim.py'];
  const result=spawnSync('python3',['-c',`
import ast,sys,math,json,io
tree=ast.parse(sys.stdin.read())
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='MapSimNode')
method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='_load_map')
scope={'math':math,'json':json,'open':lambda *args:io.StringIO(json.dumps({'bounds':[-3,-3,3,3],'walls':[[9000,9000,9001,9000]]}))}
exec(compile(ast.Module(body=[method],type_ignores=[]),'grid.py','exec'),scope)
class Dummy: map_file='unused'
try: scope['_load_map'](Dummy())
except ValueError as e: assert 'grid limit' in str(e)
else: raise AssertionError('oversized grid accepted')
`],{input:source,encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
});

test('twenty dashboards share host metrics and process results stay workspace-scoped',async()=>{
  const promises=Array.from({length:20},()=>getSimHostStatus());assert.ok(promises.every(p=>p===promises[0]));
  const snapshot=await promises[0];assert.match(snapshot.stdout,/CPU=[\d.]+\nMEM=\d+ \d+/);
  const fixture={processes:[{pid:1,cwd:'/sim/a',command:'ros2 run package node'},{pid:2,cwd:'/sim/b',command:'ros2 launch package file'},{pid:3,cwd:'/sim/ab',command:'python mapsim'}]};
  assert.equal(scopedSimProcesses(fixture,'/sim/a'),'1 ros2 run package node');
});
