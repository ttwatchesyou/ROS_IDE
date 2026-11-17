'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const tf=require('../public/real-scan-transform');

function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-9,`${actual} should equal ${expected}`);}

test('LiDAR yaw and mounting offset follow the saved TF chain',()=>{
  const model=[
    {type:'base',name:'base_link'},
    {name:'mount',parent:'base_link',pos:{x:1,y:0,z:0},rpy:{r:0,p:0,y:90}},
    {type:'lidar',name:'laser',parent:'mount',pos:{x:1,y:0,z:0},rpy:{r:0,p:0,y:90}},
  ];
  const transform=tf.resolve(model,'laser');
  const local=tf.point(transform,2,0);
  near(local.x,-1);near(local.y,1);
  const world=tf.world(local,{x:5,y:6,yaw:Math.PI/2});
  near(world.x,4);near(world.y,5);
  assert.equal(tf.resolve(model,'missing'),null);
});

test('LiDAR pitch and roll are projected before drawing in base coordinates',()=>{
  const transform=tf.resolve([{type:'base',name:'base_link'},{type:'lidar',name:'laser',parent:'base_link',pos:{x:0,y:0,z:1},rpy:{r:90,p:60,y:0}}],'laser');
  const forward=tf.point(transform,2,0);
  near(forward.x,1);near(forward.y,0);near(forward.z,1-Math.sqrt(3));
});

test('all real robot 2D scan views use the same TF projection',()=>{
  for(const name of ['lidar','dashboard','mapping','navigation']){
    const source=fs.readFileSync(path.join(__dirname,'..','public',name+'.js'),'utf8');
    assert.match(source,/RealScanTF\.resolve\(/,name);
    assert.match(source,/RealScanTF\.point\(/,name);
  }
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(server,/out=\{'frame':m\.header\.frame_id,'angleMin'/);
  assert.match(server,/state\['scan'\]=\{'frame':m\.header\.frame_id,'angleMin'/);
});
