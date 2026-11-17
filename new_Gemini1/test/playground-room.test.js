'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const MapGeometry=require('../public/map-geometry');
class Group{constructor(){this.children=[];this.rotation={y:0};this.visible=true;this.fog=null;}add(...children){this.children.push(...children);}remove(child){this.children=this.children.filter(n=>n!==child);}}
function runtime(){
  const light={isLight:true,visible:true},grid=new Group(),mapLayer=new Group(),scene=new Group();scene.add(light,grid,mapLayer);
  const renderer={outputEncoding:3000,toneMapping:0,toneMappingExposure:1,shadowMap:{enabled:false,type:1}};
  const records={build:[],floors:[],disposed:[]};
  const context={MapGeometry,THREE:{Group,Fog:class{constructor(color,near,far){Object.assign(this,{color,near,far});}}},
    window:{addEventListener(){}},document:{getElementById(){return null;},querySelectorAll(){return [];}},getComputedStyle:()=>({getPropertyValue:()=>''}),
    rviz3d:{scene,renderer,camera:{fov:45,aspect:1.6,updateProjectionMatrix(){}},objects:{grid,mapLayer}},displayList:[{id:'grid',type:'Grid',enabled:true},{id:'mapLayer',type:'Map',enabled:true}],rvizCam:{},
    r2t:(x,y,z)=>({x:-y,y:z,z:-x}),rvizApplyWorkspaceTheme(){},sessionId:'session-a',mapData:{objects:[]},
    MapSceneAssets:{build(o,objects){records.build.push({o,objects});return new Group();},roomFloor(map){records.floors.push(map);return new Group();},lighting(){return{group:new Group()};},configureRenderer(r){Object.assign(r,{outputEncoding:3001,toneMapping:4,toneMappingExposure:.95});r.shadowMap.enabled=true;r.shadowMap.type=2;},dispose(g){records.disposed.push(g);}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/map3d.js'),'utf8'),context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/playground.js'),'utf8'),context);
  return{c:context,records,light,grid,mapLayer,renderer};
}
function saved(c){c.map3dBuildLivingDining();c.map3dNormalizeData();const map=JSON.parse(JSON.stringify(c.mapData));map.objects.find(o=>o.type==='door').openAngle=35;return map;}

test('Playground renders every saved asset, floor zone and door property with the editor builders',()=>{
  const {c,records}=runtime(),map=saved(c),before=JSON.stringify(map);
  c.playgroundRenderMapObjects(map);
  assert.equal(JSON.stringify(map),before,'loading does not rewrite the saved map');
  assert.deepEqual(JSON.parse(JSON.stringify(records.build.map(b=>b.o))),JSON.parse(JSON.stringify(c.map3dReadObjects(map).filter(o=>o.type!=='start'))));
  assert.equal(records.build.find(b=>b.o.type==='door').o.openAngle,35);
  assert.deepEqual(records.floors[0].floorZones,map.floorZones);assert.equal(records.floors[0].floorStyle,map.floorStyle);
  assert.equal(c.rviz3d.playgroundDecor.rotation.y,Math.PI/2);
  assert.equal(records.build.some(b=>b.o.type==='start'),false,'live RobotModel remains the only robot');
});

test('room appearance hides the occupancy overlay without stopping map updates; layers survive reload',()=>{
  const {c,grid,mapLayer}=runtime(),map=saved(c);c.playgroundRenderMapObjects(map);
  assert.equal(grid.visible,false);assert.equal(mapLayer.visible,false);assert.equal(c.displayList.find(d=>d.type==='Map').enabled,true);
  c.playgroundToggleLayer('Map',true);assert.equal(mapLayer.visible,true);
  c.playgroundToggleLayer('Environment',false);assert.equal(c.rviz3d.playgroundDecor.visible,false);assert.equal(grid.visible,true);
  c.playgroundRenderMapObjects(map);assert.equal(c.rviz3d.playgroundDecor.visible,false);assert.equal(mapLayer.visible,true);
  assert.equal(c.rviz3d.playgroundLighting.visible,true,'lighting remains for the live robot');
});

test('leaving Playground restores RViz lighting, fog, camera, grid and renderer settings',()=>{
  const {c,light,grid,mapLayer,renderer,records}=runtime(),original=JSON.stringify(renderer),map=saved(c);c.playgroundRenderMapObjects(map);
  assert.equal(light.visible,false);assert.equal(renderer.shadowMap.enabled,true);
  c.playgroundRenderMapObjects(map);c.playgroundClearDecor();
  assert.equal(JSON.stringify(renderer),original);assert.equal(light.visible,true);assert.equal(grid.visible,true);assert.equal(mapLayer.visible,true);
  assert.equal(c.rviz3d.camera.fov,45);assert.equal(c.rviz3d.scene.fog,null);assert.equal(c.rviz3d.scene.children.length,3);assert.equal(records.disposed.length,4);
});

test('legacy line maps use the same room geometry and camera centers on saved bounds',()=>{
  const {c,records}=runtime();c.playgroundRenderMapObjects({bounds:[10,20,16,28],walls:[[10,20,16,24]]});c.playgroundFitMapView();
  assert.equal(records.build.length,1);assert.equal(records.build[0].o.type,'wall');assert.equal(records.build[0].o.h,2.5);
  assert.deepEqual(JSON.parse(JSON.stringify(c.rvizCam.target)),{x:-24,y:0,z:-13});assert.ok(c.rvizCam.radius>8);
});

test('only the latest saved map response is rendered and failed loads clear the previous room',async()=>{
  const {c,records}=runtime(),pending=[];c.API=()=>new Promise(resolve=>pending.push(resolve));
  const map=saved(c),newer=JSON.parse(JSON.stringify(map));newer.floorStyle='concrete';
  const first=c.playgroundLoadMapInfo(),second=c.playgroundLoadMapInfo();pending[1]({ok:true,content:JSON.stringify(newer)});await second;pending[0]({ok:true,content:JSON.stringify(map)});await first;
  assert.equal(records.floors.length,1);assert.equal(records.floors[0].floorStyle,'concrete');
  const third=c.playgroundLoadMapInfo();pending[2]({ok:false});await third;assert.equal(c.rviz3d.playgroundDecor,null);
  const fourth=c.playgroundLoadMapInfo();c.sessionId='session-b';pending[3]({ok:true,content:JSON.stringify(map)});await fourth;assert.equal(c.rviz3d.playgroundDecor,null);
});

test('the public RViz resize hook fits its moved viewport and ignores hidden containers',()=>{
  const container={offsetWidth:1200,offsetHeight:800},sizes=[];
  const c={window:{addEventListener(){}},document:{addEventListener(){},getElementById:()=>container}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/rviz.js'),'utf8')+'\nglobalThis.state=rviz3d;',c);
  c.state.renderer={setSize:(w,h)=>sizes.push([w,h])};c.state.camera={aspect:1,updateProjectionMatrix(){}};
  c.rvizResize();assert.deepEqual(sizes,[[1200,800]]);assert.equal(c.state.camera.aspect,1.5);
  container.offsetHeight=0;c.rvizResize();assert.equal(sizes.length,1);assert.equal(c.state.camera.aspect,1.5);
});
