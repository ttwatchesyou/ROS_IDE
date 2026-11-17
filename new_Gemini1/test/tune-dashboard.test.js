'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {TuneDashboardModel,tuneSignalDescriptors}=require('../public/tune-dashboard');

function storage(){const values=new Map();return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}

test('signal combobox catalog follows numeric frames, independent of wheel template',()=>{
  assert.deepEqual(tuneSignalDescriptors('RPM',[1,2,3,4,5,6]).map(item=>item.key),['RPM.0','RPM.1','RPM.2','RPM.3','RPM.4','RPM.5']);
  assert.equal(tuneSignalDescriptors('RPM',[1,2])[1].label,'RPM 1 · วัดจริง');
  assert.equal(tuneSignalDescriptors('GYRO',[1,2,3])[2].unit,'°/s');
  assert.equal(tuneSignalDescriptors('ODOM',[1,2,3,4,5,6])[5].label,'ODOM · Wz');
  assert.deepEqual(tuneSignalDescriptors('CUSTOM',[2,7]).map(item=>item.key),['CUSTOM.0','CUSTOM.1']);
  assert.deepEqual(tuneSignalDescriptors('T:TEL',[1]),[]);
  assert.deepEqual(tuneSignalDescriptors('RPM',[Infinity]),[]);
});

test('charts accept selected signals, pan and zoom independently, reorder, and restore layout',()=>{
  const store=storage(),dashboard=new TuneDashboardModel(store,'robot-a');
  dashboard.ingest({kind:'CUSTOM',values:[10,20,30],receivedAt:100000});
  assert.deepEqual(dashboard.charts[0].signals,['CUSTOM.0','CUSTOM.1']);
  const first=dashboard.charts[0].id,second=dashboard.addChart().id;
  assert.equal(dashboard.addSignal(second,'CUSTOM.2'),true);
  assert.equal(dashboard.addSignal(second,'missing'),false);
  assert.equal(dashboard.setStyle(second,'points'),true);
  assert.equal(dashboard.setSize(second,'large'),true);
  assert.equal(dashboard.setColumns(2),true);
  dashboard.zoom(second,.5);
  assert.equal(dashboard.chart(second).windowMs,15000);
  dashboard.ingest({kind:'CUSTOM',values:[11,21,31],receivedAt:160000});
  dashboard.pan(second,100,200);
  assert.ok(dashboard.chart(second).offsetMs>0);
  assert.equal(dashboard.chart(first).offsetMs,0,'panning one chart does not move the other');
  dashboard.follow(second);assert.equal(dashboard.chart(second).offsetMs,0);
  assert.equal(dashboard.moveChart(second,first),true);
  assert.equal(dashboard.charts[0].id,second);
  const restored=new TuneDashboardModel(store,'robot-a');
  assert.deepEqual(restored.charts.map(chart=>chart.signals),[['CUSTOM.2'],['CUSTOM.0','CUSTOM.1']]);
  assert.equal(restored.charts[0].style,'points');assert.equal(restored.charts[0].size,'large');assert.equal(restored.charts[0].windowMs,15000);
  assert.equal(restored.columns,2);
  assert.equal(restored.removeChart(restored.charts[1].id),true);
  assert.equal(restored.charts.length,1);
});

test('signal samples stay bounded and the page contains dynamic chart controls',()=>{
  const dashboard=new TuneDashboardModel(storage(),'robot-b');
  for(let i=0;i<12010;i++)dashboard.ingest({kind:'RPM',values:[i,i-1],receivedAt:100000+i});
  assert.equal(dashboard.points.get('RPM.0').length,12000);
  assert.equal(dashboard.points.get('RPM.0')[0].v,10);
  dashboard.clearData();assert.equal(dashboard.points.size,0);assert.deepEqual(dashboard.charts[0].signals,['RPM.0','RPM.1']);
  const html=fs.readFileSync('public/tune.html','utf8');
  assert.match(html,/id="tune-dashboard"/);assert.match(html,/id="td-add-chart"/);assert.match(html,/id="td-columns"/);assert.match(html,/tune-dashboard\.js/);
  assert.doesNotMatch(html,/id="rpm-chart"|id="gyro-chart"/);
});

test('ODOM produces metres, yaw degrees, cumulative turns and an independent XY map',()=>{
  const dashboard=new TuneDashboardModel(storage(),'pose');
  assert.equal(dashboard.presetPose(),true);
  assert.deepEqual(dashboard.charts[0].signals,['ODOM.0','ODOM.1','ODOM.2']);
  dashboard.ingest({kind:'ODOM',values:[0,0,0,0,0,0],receivedAt:100000});
  dashboard.ingest({kind:'ODOM',values:[.1,0,Math.PI/2,0,0,0],receivedAt:101000});
  dashboard.ingest({kind:'ODOM',values:[.1,.2,Math.PI,0,0,0],receivedAt:102000});
  assert.ok(Math.abs(dashboard.pose.distance-.3)<1e-9);
  assert.equal(dashboard.pose.turnDeg,180);
  assert.equal(dashboard.points.get('ODOM.2').at(-1).v,180);
  assert.ok(Math.abs(dashboard.points.get('TRAVEL.0').at(-1).v-.3)<1e-9);
  assert.deepEqual(dashboard.path.map(({x,y})=>[x,y]),[[0,0],[.1,0],[.1,.2]]);
  const map=dashboard.addChart();dashboard.setStyle(map.id,'map');
  assert.equal(dashboard.mapZoom(map.id,2),true);assert.equal(map.mapScale,2);
  dashboard.mapPan(map.id,10,-5);assert.equal(map.mapPanX,10);assert.equal(map.mapPanY,-5);
  dashboard.mapReset(map.id);assert.equal(map.mapScale,1);assert.equal(map.mapPanX,0);
  assert.equal(new TuneDashboardModel(dashboard.storage,'pose').charts[1].style,'map');
  dashboard.clearData();assert.equal(dashboard.pose,null);assert.deepEqual(dashboard.path,[]);
  const html=fs.readFileSync('public/tune.html','utf8');
  assert.match(html,/id="td-add-map"/);assert.match(html,/id="pose-yaw"/);assert.match(html,/id="pose-distance"/);
});
