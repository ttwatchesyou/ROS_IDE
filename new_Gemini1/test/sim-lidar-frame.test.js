'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {SimEngine,wsRoot}=require('../sim');

test('Sim fallback publishes scan from the saved LiDAR frame, offset and pitch',()=>{
  const key=`SIM-lidar-frame-${process.pid}-${Date.now()}`;
  const root=wsRoot(key),folder=path.join(root,'src','sim_robot_tf');
  fs.mkdirSync(folder,{recursive:true});
  try{
    fs.writeFileSync(path.join(folder,'tf_model.json'),JSON.stringify([
      {type:'base',name:'base_link'},
      {type:'lidar',name:'tilted_laser',parent:'base_link',pos:{x:1,y:0,z:.2},rpy:{r:0,p:60,y:0}},
    ]));
    const sim=new SimEngine(key,{walls:[[2,-2,2,2]],bounds:[-3,-3,3,3],start:[0,0]});
    sim.x=0;sim.y=0;sim.th=0;sim.rvizOn=true;sim.tick();
    assert.equal(sim.msgFor('/scan').header.frame_id,'tilted_laser');
    assert.equal(sim.rvizBuf.at(-1)&&JSON.parse(sim.rvizBuf.at(-1)).scan.frame,'tilted_laser');
    assert.equal(sim.lidar.edges[0].frame,'tilted_laser');
    assert.ok(Math.abs(sim.scan.ranges[180]-2)<.03,'60 degree pitch halves the horizontal ray component');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
