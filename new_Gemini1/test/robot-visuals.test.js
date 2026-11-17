'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const visuals=require('../public/robot-visuals');
const source=fs.readFileSync(path.join(__dirname,'../public/transformation.js'),'utf8');
const wheel=(style,handedness=1)=>({id:'wheel-test',type:'omni',name:'test_wheel',params:{radius:.09,width:.055,rollerR:.018,wheelStyle:style,handedness}});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const axis=([r,p,y])=>[Math.cos(y)*Math.sin(p)*Math.cos(r)+Math.sin(y)*Math.sin(r),Math.sin(y)*Math.sin(p)*Math.cos(r)-Math.cos(y)*Math.sin(r),Math.cos(p)*Math.cos(r)];

test('omni rollers occupy two staggered rows and rotate tangentially in the wheel plane',()=>{
  const rollers=visuals.parts(wheel('omni')).filter(p=>p.detail==='roller');
  assert.equal(rollers.length,16);
  const rows=[...new Set(rollers.map(p=>p.xyz[1]))];assert.equal(rows.length,2);near(rows[0],-rows[1]);
  for(const part of rollers){const d=axis(part.rpy);near(d[1],0);near(d[0]*part.xyz[0]+d[2]*part.xyz[2],0);}
  const angles=rows.map(y=>rollers.filter(p=>p.xyz[1]===y).map(p=>Math.atan2(p.xyz[0],p.xyz[2])));
  near(angles[1][0]-angles[0][0],Math.PI/8);
});

test('mecanum rollers are mirrored at 45 degrees while wheel axles remain parallel',()=>{
  for(const hand of [-1,1]){
    const parts=visuals.parts(wheel('mecanum',hand)),rollers=parts.filter(p=>p.detail==='roller');
    assert.equal(rollers.length,10);
    for(const part of rollers){const d=axis(part.rpy);near(d[1],hand/Math.SQRT2);near(d[0]*part.xyz[0]+d[2]*part.xyz[2],0);near(part.xyz[1],0);}
    for(const part of parts.filter(p=>p.detail==='axle-bore')) near(Math.abs(axis(part.rpy)[1]),1);
  }
});

test('hardware details scale proportionally and URDF carries materials, rollers and fasteners',()=>{
  const original=wheel('mecanum'),scaled=wheel('mecanum');
  for(const key of ['radius','width','rollerR'])scaled.params[key]*=2;
  const small=visuals.parts(original),large=visuals.parts(scaled);assert.equal(small.length,large.length);
  small.forEach((p,i)=>{p.xyz.forEach((v,k)=>near(large[i].xyz[k],v*2));if(p.radius)near(large[i].radius,p.radius*2);if(p.length)near(large[i].length,p.length*2);});
  const urdf=visuals.urdf(original);
  assert.ok((urdf.match(/<visual>/g)||[]).length>100);
  assert.ok((urdf.match(/<material/g)||[]).length>100);
  assert.doesNotMatch(urdf,/NaN|Infinity|undefined/);
});

function builder(simulation){
  const storage=new Map();
  const context={RobotVisuals:visuals,isSimWorkspace:simulation,sessionId:'test',
    window:{addEventListener(){},confirm:()=>true},document:{getElementById:()=>null,querySelectorAll:()=>[]},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    sbMsg(){},escH:String,encArg:encodeURIComponent,setTimeout,requestAnimationFrame(){},THREE:{MathUtils:{degToRad:d=>d*Math.PI/180}}};
  vm.runInNewContext(source+'\nglobalThis.state=tf;',context);return context;
}
test('SIM and real builders retain wheel style through templates, resize, save and reopen',()=>{
  for(const sim of [true,false]){
    const c=builder(sim);c.tfApplyRobotTemplate('mecanum');
    const wheels=c.state.comps.filter(p=>p.type==='omni');
    assert.equal(wheels.length,4);assert.ok(wheels.every(w=>w.rpy.y===0));
    assert.deepEqual(wheels.map(w=>w.params.handedness).join(','),'-1,1,1,-1');
    assert.equal(c.tfSuggestPattern(c.tfDetectWheels()),'mecanum');
    wheels[0].params=c.tfApplyScale(wheels[0],{x:2,y:2,z:2});
    assert.equal(wheels[0].params.wheelStyle,'mecanum');assert.equal(wheels[0].params.handedness,-1);assert.equal(wheels[0].params.rollerCount,10);near(wheels[0].params.radius,.18);
    const saved=c.tfBuildModelJSON();c.tfApplyComps(JSON.parse(saved));
    const restored=c.state.comps.find(p=>p.name==='mecanum_fl');assert.equal(restored.params.wheelStyle,'mecanum');near(restored.params.radius,.18);
    c.tfAddComp('mecanum');c.tfAddComp('mecanum');
    assert.equal(new Set(c.state.comps.map(p=>p.name)).size,c.state.comps.length);
    const urdf=c.tfBuildURDF();assert.doesNotMatch(urdf,/NaN|Infinity|undefined/);
    assert.match(urdf,/<collision><origin xyz="0 0 0" rpy="1.570796 0 0"\/><geometry><cylinder radius="0.180(?:000)?"/);
  }
});

test('legacy named Mecanum wheels are upgraded once without changing positions',()=>{
  const c=builder(true),old=wheel('omni');delete old.params.wheelStyle;
  Object.assign(old,{name:'mecanum_fl',pos:{x:.22,y:.23,z:.06},rpy:{r:0,p:0,y:45}});
  c.tfApplyComps([old]);const w=c.state.comps[0];assert.equal(w.params.wheelStyle,'mecanum');assert.equal(w.rpy.y,0);near(w.pos.x,.22);near(w.pos.y,.23);
  w.rpy.y=25;c.tfApplyComps(JSON.parse(c.tfBuildModelJSON()));assert.equal(c.state.comps[0].rpy.y,25);
});
