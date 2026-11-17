'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const settings=require('../public/navigation-settings');
const {genMapsimFiles}=require('../sim');
const planner=fs.readFileSync(path.join(__dirname,'../sim-navigation.py'),'utf8');
function python(code,input=planner){
  const result=spawnSync('python3',['-c',code],{input,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  if(result.stdout)console.log(result.stdout.trim());
}

test('navigation templates never shrink the physical footprint and UI fields match the API',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  for(const p of Object.values(settings.presets)){
    assert.ok(p.radius>=.24);assert.ok(p.clearance>=.02);assert.ok(p.inflation>=p.radius+p.clearance);
  }
  assert.ok(settings.presets.sport.speed<settings.presets.balanced.speed);
  const p=settings.normalize({radius:-10,clearance:.4,inflation:.1,budget:999,speed:Infinity});
  assert.equal(p.radius,.24);assert.equal(p.inflation,.64);assert.equal(p.budget,150);assert.equal(p.speed,.45);
  for(const [name,field] of Object.entries(settings.fields)){
    assert.match(html,new RegExp(`id="pg-nav-${name}"`));
    assert.equal(settings.rosConfig(p)[field.ros],p[name]);
  }
  for(const match of html.matchAll(/<button[^>]*class="(?:pg-drive-btn|real-teleop-btn|rv-tp-btn)"[^>]*data-dir="(?:fwd|back|left|right)"[^>]*>(.*?)<\/button>/g)){
    assert.match(match[0],/aria-label=/);assert.match(match[1],/<svg/);
    assert.equal(match[1].replace(/<[^>]*>/g,''),'');
  }
});

test('costmap distances are exact and conservative, cached, and reject unsafe or unreachable goals',()=>python(`
import sys,random
exec(sys.stdin.read())
random.seed(30)
for n in (1,2,8,31):
    for _ in range(30):
        values=[0 if random.random()<.3 else 1e12 for _ in range(n)]
        assert _nav_edt(values)==[min(v+(i-j)**2 for j,v in enumerate(values)) for i in range(n)]
w=h=100; data=[0]*(w*h)
for y in range(25,75):
    for x in range(45,55): data[y*w+x]=100
grid=NavigationGrid(data,w,h,.1,(0,0))
grid.configure(); d=id(grid.distance); b=id(grid.blocked)
route=grid.plan((2,5),(8,5),150)
assert route,grid.error
assert all(grid.line_free(a,b) for a,b in zip(route,route[1:])),route
assert not grid.line_free((2,5),(8,5))
assert not grid.plan((2,5),(4.4,5)), 'inflated obstacle goal was accepted'
assert not grid.plan((-.01,5),(8,5)), 'out-of-bounds start was snapped into grid'
for _ in range(20):
    grid.configure()
    assert grid.plan((2,5),(8,5),150),grid.error
assert grid.builds==1 and id(grid.blocked)==b and id(grid.distance)==d
grid.configure(clearance=.3)
assert grid.builds==2 and id(grid.distance)==d
assert not grid.plan((2,5),(8,5),150,max_expansions=5)
assert grid.expansions==5 and 'CPU' in grid.error
data=[0]*(w*h)
for y in range(h):data[y*w+50]=100
grid=NavigationGrid(data,w,h,.1,(0,0));grid.configure()
assert not grid.plan((2,5),(8,5),150)
try: NavigationGrid([],1001,1000,.1,(0,0))
except ValueError: pass
else: raise AssertionError('oversized grid accepted')
# A saved map missing an object must still respect the actual world walls.
grid=NavigationGrid([0]*(w*h),w,h,.1,(0,0),[(5,0,5,10)]);grid.configure()
assert not grid.plan((2,5),(8,5),150)
`));

test('controller follows paths around objects without corner cutting and aligns goal yaw',()=>{
  python(`
import sys,ast,types,json
payload=json.loads(sys.stdin.read()); exec(payload['planner'])
tree=ast.parse(payload['mapsim'])
node=next(n for n in tree.body if isinstance(n,ast.ClassDef) and any(isinstance(m,ast.FunctionDef) and m.name=='_nav_command' for m in n.body))
names={'_prepare_nav_grid','_plan_nav_path','_accept_nav_goal','_nav_command'}
node.bases=[];node.decorator_list=[];node.body=[n for n in node.body if isinstance(n,ast.FunctionDef) and n.name in names]
exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'controller','exec'))
WALLS=[(-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,-1)]
for preset in payload['presets'].values():
    n=globals()[node.name]();n.x,n.y,n.th=-3.,0.,0.;n.nav_goal=None;n.nav_path=[]
    params={payload['fields'][key]['ros']:value for key,value in preset.items()}
    params.update(nav_enabled=True,nav_allow_unknown=False)
    n.get_parameter=lambda key:types.SimpleNamespace(value=params[key])
    n._nav_grid=None;n._nav_grid_source=None;n._nav_error='';n._publish_nav_path=lambda:None
    states=[];n._set_nav_status=lambda state,*args:states.append(state)
    n.nav_map_data=None;n.map_data=types.SimpleNamespace(data=[0]*10000,info=types.SimpleNamespace(width=100,height=100,resolution=.1,origin=types.SimpleNamespace(position=types.SimpleNamespace(x=-5,y=-5))))
    n._ray=lambda x,y,a,rng: rng
    ok,error=n._accept_nav_goal(3.,0.,1.0);assert ok,error
    for i in range(5000):
        x,y=n.x,n.y;v,w=n._nav_command();n.th+=w*.1;n.x+=v*math.cos(n.th)*.1;n.y+=v*math.sin(n.th)*.1
        assert n._nav_grid.line_free((x,y),(n.x,n.y)), (i,n.x,n.y)
        if n.nav_goal is None:break
    assert states[-1]=='succeeded',(states[-1],n.x,n.y,n.th,i)
    assert math.hypot(n.x-3,n.y)<=preset['tolerance']+.001
    assert abs(math.atan2(math.sin(n.th-1),math.cos(n.th-1)))<=preset['yaw']
    assert n._nav_grid.builds==1
    print('Navigation template passed:',preset['speed'],'m/s,',i,'ticks')
`,JSON.stringify({planner,mapsim:genMapsimFiles()['sim_robot_mapsim/mapsim.py'],presets:settings.presets,fields:settings.fields}));
});
