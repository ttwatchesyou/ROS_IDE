'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {angleForTravel,advance}=require('../public/robot-wheel-motion');
const visuals=require('../public/robot-visuals');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
// ROS +X is renderer -Z; a wheel's +Z axle after roll=90 is renderer +X.
const axle={x:1,y:0,z:0},point=(x=0,z=0)=>({x,y:0,z});
const state=(radius=.1)=>({radius,hand:0,angle:0,previous:null});

test('wheel angle follows distance/radius, reverses, and stops without command extrapolation',()=>{
  const wheel=state();advance(wheel,point(),axle,true,1/60);
  advance(wheel,point(0,-.2),axle,true,1/60);near(wheel.angle,-2);
  for(let i=0;i<120;i++)advance(wheel,point(0,-.2),axle,true,1/60);
  near(wheel.angle,-2);advance(wheel,point(),axle,true,1/60);near(wheel.angle,0);
  near(angleForTravel(point(0,-.2),axle,.2),-1);
});

test('turning in place spins left and right wheels in opposite directions',()=>{
  const left=state(),right=state(),halfTrack=.25,turn=.1;
  const nextAxle={x:Math.cos(turn),y:0,z:-Math.sin(turn)};
  advance(left,point(-halfTrack,0),axle,true,.02);
  advance(right,point(halfTrack,0),axle,true,.02);
  advance(left,point(-halfTrack*Math.cos(turn),halfTrack*Math.sin(turn)),nextAxle,true,.02);
  advance(right,point(halfTrack*Math.cos(turn),-halfTrack*Math.sin(turn)),nextAxle,true,.02);
  assert.ok(left.angle>0&&right.angle<0);near(left.angle,-right.angle);
  near(left.angle,2*halfTrack*Math.sin(turn/2)/left.radius);
});

test('rotated omni wheels project travel onto their own rolling direction',()=>{
  near(angleForTravel(point(0,-.2),{x:0,y:0,z:1},.1),0);
  near(angleForTravel(point(.2,0),{x:0,y:0,z:1},.1),-2);
  near(angleForTravel(point(0,-.2),{x:0,y:1,z:0},.1),0);
});

test('mirrored Mecanum wheels counter-rotate for lateral travel',()=>{
  near(angleForTravel(point(.2,0),axle,.1,-1),2);
  near(angleForTravel(point(.2,0),axle,.1,1),-2);
  near(angleForTravel(point(0,-.2),axle,.1,-1),-2);
  near(angleForTravel(point(0,-.2),axle,.1,1),-2);
});

test('pausing, hidden layers, reconnecting and discontinuities reset travel without a jump',()=>{
  const wheel=state();advance(wheel,point(),axle,true,.02);advance(wheel,point(0,-.1),axle,true,.02);near(wheel.angle,-1);
  advance(wheel,point(0,-.2),axle,false,.02);advance(wheel,point(0,-3),axle,true,.02);near(wheel.angle,-1);
  advance(wheel,point(0,-10),axle,true,.02);near(wheel.angle,-1);
  advance(wheel,point(0,-10.1),axle,true,1);near(wheel.angle,-1);
  advance(wheel,point(0,-10.2),axle,true,.02);near(wheel.angle,-2);
});

test('URDF visual names preserve renamed wheel type, radius and roller handedness',()=>{
  for(const style of ['standard','omni','mecanum']){
    const c={name:'custom_drive',type:style==='standard'?'wheel':'omni',params:{radius:.123,width:.04,wheelStyle:style,handedness:-1}};
    const xml=visuals.urdf(c);
    assert.ok(xml.includes(`name="roside_wheel_${style}_0.123000_-1"`));
    assert.equal((xml.match(/name="roside_wheel_/g)||[]).length,1);
  }
  assert.doesNotMatch(visuals.urdf({type:'lidar',params:{}}),/roside_wheel_/);
});
