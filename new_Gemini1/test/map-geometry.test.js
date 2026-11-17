'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const geometry=require('../public/map-geometry');
const {motionIsClear,robotCollides,SimEngine}=require('../sim');
const wall=(props={})=>({id:'wall',type:'wall',x:0,y:0,z:0,w:6,d:.2,h:2.7,r:0,...props});
const door=(props={})=>({id:'door',type:'door',asset:'door',x:0,y:0,z:0,w:1.05,d:.14,h:2.15,r:0,openAngle:90,hinge:'left',...props});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);
function ray(x,y,angle,lines){
  let best=20;const dx=Math.cos(angle),dy=Math.sin(angle);
  for(const [x1,y1,x2,y2] of lines){const sx=x2-x1,sy=y2-y1,det=dx*sy-dy*sx;if(Math.abs(det)<1e-9)continue;const t=((x1-x)*sy-(y1-y)*sx)/det,u=((x1-x)*dy-(y1-y)*dx)/det;if(t>0&&u>=0&&u<=1)best=Math.min(best,t);}
  return best;
}
function scene(objects){geometry.reconcile(objects);return geometry.segments(objects);}

test('an open door cuts a real wall opening for both robot motion and laser rays',()=>{
  const w=wall(),d=door(),lines=scene([w,d]);
  assert.equal(d.wallId,w.id);
  assert.equal(motionIsClear(0,-1,0,1,lines),true);
  assert.equal(ray(0,-1,Math.PI/2,lines),20);
  assert.equal(motionIsClear(1,-1,1,1,lines),false);
  near(ray(1,-1,Math.PI/2,lines),.9);
  const parts=geometry.wallParts(w,[w,d]);
  assert.ok(parts.some(p=>p.z>=d.h&&p.h>0),'lintel remains above door');
  assert.equal(parts.some(p=>p.z===0&&Math.abs(p.x)<p.w/2),false,'no wall occupies opening');
});

test('closed and partly open door leaves block motion and scans; jambs retain clearance limits',()=>{
  const w=wall(),d=door({openAngle:0});let lines=scene([w,d]);
  assert.equal(motionIsClear(0,-1,0,1,lines),false);assert.ok(ray(0,-1,Math.PI/2,lines)<1.1);
  d.openAngle=30;lines=scene([w,d]);assert.equal(motionIsClear(0,-1,0,1,lines),false);
  d.openAngle=90;lines=scene([w,d]);assert.equal(motionIsClear(0,-1,0,1,lines),true);
  assert.equal(robotCollides(.4,0,lines),true);
  assert.equal(motionIsClear(0,-1,0,1,lines,.55),false,'an oversized robot cannot fit');
  assert.ok(ray(-.465,-1,Math.PI/2,lines)<1.1,'the opened leaf remains a physical obstacle');
});

test('snapping, rotated walls, moving hosts and resizing retain matching geometry',()=>{
  for(const r of [0,37,90,135,270]){
    const w=wall({x:3,y:-2,r}),p=geometry.world(w,.7,.2),d=door(p);geometry.attach(d,[w,d]);near(d.r,r);near(d.wallOffset,.7);
    let a=geometry.world(w,.7,-1.2),b=geometry.world(w,.7,1.2),lines=scene([w,d]);assert.equal(motionIsClear(a.x,a.y,b.x,b.y,lines),true);
    w.x+=2;w.y-=1;w.r+=15;lines=scene([w,d]);const expected=geometry.world(w,.7,0);near(d.x,expected.x);near(d.y,expected.y);near(d.r,w.r);
    d.w=1.4;lines=scene([w,d]);a=geometry.world(w,.7,-1.2);b=geometry.world(w,.7,1.2);assert.equal(motionIsClear(a.x,a.y,b.x,b.y,lines),true);
  }
});

test('moving or deleting a door repairs its old wall and preserves the wall after reload',()=>{
  const w=wall(),d=door();scene([w,d]);
  d.x=1.5;geometry.attach(d,[w,d]);let lines=scene([w,d]);assert.equal(motionIsClear(0,-1,0,1,lines),false);assert.equal(motionIsClear(1.5,-1,1.5,1,lines),true);
  const saved=JSON.parse(JSON.stringify([w,d]));assert.deepEqual(scene(saved),lines);
  d.y=2;geometry.attach(d,[w,d]);lines=scene([w,d]);assert.equal(d.wallId,undefined);assert.equal(motionIsClear(1.5,-1,1.5,1,lines),false);
  assert.equal(motionIsClear(0,-1,0,1,scene([w])),false);
});

test('double doors respect both hinge choices and multiple openings preserve wall sections',()=>{
  const w=wall({w:9}),left=door({id:'left',x:-2}),right=door({id:'right',asset:'double-door',w:1.8,x:2});
  for(const hinge of ['left','right']){right.hinge=hinge;const lines=scene([w,left,right]);assert.equal(motionIsClear(-2,-1,-2,1,lines),true);assert.equal(motionIsClear(2,-1,2,1,lines),true);assert.equal(motionIsClear(0,-1,0,1,lines),false);}
  right.openAngle=0;assert.equal(motionIsClear(2,-1,2,1,scene([w,left,right])),false);
});

test('windows cut above their sill and invalid oversized doors cannot erase walls',()=>{
  const w=wall(),window=door({type:'window',z:.95,h:1.2,w:1.5});const lines=scene([w,window]);
  assert.equal(motionIsClear(0,-1,0,1,lines),false);
  const pieces=geometry.wallParts(w,[w,window]);assert.ok(pieces.some(p=>p.x===0&&p.z===0&&p.h===.95));assert.ok(pieces.some(p=>p.z>=2.15));
  const huge=door({w:7});assert.equal(geometry.attach(huge,[w,huge]),null);assert.equal(geometry.wallParts(w,[w,huge]).length,1);
});

test('locked openings retain their pose through snapping and reconciliation until explicitly unlocked',()=>{
  const w=wall(),window=door({type:'window',z:.95,h:1.2,w:1.5});
  geometry.attach(window,[w,window]);window.locked=true;
  const original=JSON.parse(JSON.stringify(window));
  geometry.attach(window,[w,window]);geometry.reconcile([w,window]);
  assert.deepEqual(window,original);
  w.x+=1;geometry.reconcile([w,window]);assert.deepEqual(window,original);
  window.locked=false;geometry.attach(window,[w,window]);geometry.reconcile([w,window]);
  assert.equal(window.wallId,w.id);
  const free=door({id:'free',locked:true,x:1,y:.15});
  geometry.reconcile([w,free]);assert.equal(free.wallId,undefined);near(free.y,.15);
});

function editor(){
  const context={MapGeometry:geometry,mapData:{bounds:[-4,-4,4,4],objects:[],walls:[]},window:{addEventListener(){}},document:{getElementById(){return null;}},mapSaveLocal(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/map3d.js'),'utf8')+'\nglobalThis.templates=MAP3D_TEMPLATES;',context);return context;
}
test('all six furnished templates have clear robot starts and attached usable doorways',()=>{
  const c=editor();
  for(const template of c.templates){
    c.mapData.objects=[];template.build();c.map3dSyncLegacy();
    const {objects,walls,start}=c.mapData;
    assert.equal(robotCollides(...start,walls),false,template.id+' spawn');
    for(const d of objects.filter(o=>o.type==='door')){
      assert.ok(d.wallId,template.id+' attached door');
      const p=geometry.world(d,0,-.3),q=geometry.world(d,0,.3);
      assert.equal(motionIsClear(p.x,p.y,q.x,q.y,walls),true,`${template.id}: ${d.name} doorway`);
    }
    const sim=new SimEngine('SIM-map-geometry-test',JSON.parse(JSON.stringify(c.mapData)));
    assert.equal(motionIsClear(...start,start[0]+.01,start[1],sim.walls),true);
  }
});

test('editor serialization retains door angles, attachments, custom colors and metric dimensions',()=>{
  const c=editor();c.mapData.objects=[wall({color:0}),door({openAngle:35,hinge:'right'})];c.map3dNormalizeData();
  const saved=JSON.parse(JSON.stringify(c.mapData));c.mapData=saved;c.map3dNormalizeData();
  const d=c.mapData.objects.find(o=>o.type==='door');assert.equal(d.openAngle,35);assert.equal(d.hinge,'right');assert.equal(d.wallId,'wall');near(d.w,1.05);assert.equal(c.mapData.objects[0].color,0);
  assert.equal(motionIsClear(0,-1,0,1,c.mapData.walls),false);
  c.mapData={bounds:[-3,-3,3,3],walls:[[-3,0,3,0]],start:[0,-1]};c.map3dNormalizeData();assert.equal(c.mapData.objects.filter(o=>o.type==='wall').length,1);assert.equal(motionIsClear(0,-1,0,1,c.mapData.walls),false);
});

test('the ROS MapSim and fallback Python engines use the saved openings for motion and laser scans',()=>{
  const {spawnSync}=require('node:child_process');
  const {genMapsimFiles,SIM_STATE_PUB}=require('../sim');
  const opened=scene([wall(),door()]),closed=scene([wall(),door({openAngle:0})]);
  const sources=[{source:genMapsimFiles()['sim_robot_mapsim/mapsim.py'],ray:'ray_cast',motion:'motion_is_clear',names:['ray_cast','point_segment_distance','robot_collides','motion_is_clear']},{source:SIM_STATE_PUB,ray:'rayCast',motion:'motionIsClear',names:['rayCast','pointSegmentDistance','robotCollides','motionIsClear']}];
  const result=spawnSync('python3',['-c',`
import ast,json,math,sys
payload=json.load(sys.stdin)
for engine in payload['engines']:
    tree=ast.parse(engine['source'])
    functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in engine['names']]
    assert len(functions)==4
    functions += [node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='WallIndex']
    scope={'math':math,'ROBOT_RADIUS':.24,'WALLS':payload['opened']}
    exec(compile(ast.Module(body=functions,type_ignores=[]),'simulation.py','exec'),scope)
    scope['WALL_INDEX']=scope['WallIndex'](scope['WALLS'])
    assert scope[engine['motion']](0,-1,0,1)
    assert scope[engine['ray']](0,-1,math.pi/2,20)==20
    assert not scope[engine['motion']](1,-1,1,1)
    scope['WALLS']=payload['closed']
    scope['WALL_INDEX']=scope['WallIndex'](scope['WALLS'])
    assert not scope[engine['motion']](0,-1,0,1)
    assert scope[engine['ray']](0,-1,math.pi/2,20)<1.1
print('Both Python simulators preserve open and closed door geometry')
`],{input:JSON.stringify({engines:sources,opened,closed}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
