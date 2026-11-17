'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Small math doubles keep lifecycle tests independent of WebGL; browser checks use real Three.js.
class Vec{
  constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}set(x,y,z){Object.assign(this,{x,y,z});return this;}clone(){return new Vec(this.x,this.y,this.z);}copy(v){return this.set(v.x,v.y,v.z);}
  add(v){return this.set(this.x+v.x,this.y+v.y,this.z+v.z);}sub(v){return this.set(this.x-v.x,this.y-v.y,this.z-v.z);}addScaledVector(v,s){return this.add(new Vec(v.x*s,v.y*s,v.z*s));}
  lengthSq(){return this.x**2+this.y**2+this.z**2;}length(){return Math.sqrt(this.lengthSq());}normalize(){const n=this.length()||1;return this.set(this.x/n,this.y/n,this.z/n);}lerp(v,a){return this.addScaledVector(v.clone().sub(this),a);}
  applyQuaternion(q){const p=new Quat(this.x,this.y,this.z,0),r=q.clone().multiply(p).multiply(new Quat(-q.x,-q.y,-q.z,q.w));return this.set(r.x,r.y,r.z);}
}
class Quat{
  constructor(x=0,y=0,z=0,w=1){Object.assign(this,{x,y,z,w});}clone(){return new Quat(this.x,this.y,this.z,this.w);}copy(q){Object.assign(this,q);return this;}
  multiply(q){const {x,y,z,w}=this;return this.copy(new Quat(w*q.x+x*q.w+y*q.z-z*q.y,w*q.y-x*q.z+y*q.w+z*q.x,w*q.z+x*q.y-y*q.x+z*q.w,w*q.w-x*q.x-y*q.y-z*q.z));}
  premultiply(q){return this.copy(q.clone().multiply(this));}slerp(q,a){if(a===0)return this;if(a===1)return this.copy(q);let dot=this.x*q.x+this.y*q.y+this.z*q.z+this.w*q.w,b=q.clone();if(dot<0){for(const k of ['x','y','z','w'])b[k]*=-1;dot=-dot;}const theta=Math.acos(Math.min(1,dot));const p=theta<1e-6?1-a:Math.sin((1-a)*theta)/Math.sin(theta),r=theta<1e-6?a:Math.sin(a*theta)/Math.sin(theta);for(const k of ['x','y','z','w'])this[k]=this[k]*p+b[k]*r;return this;}
}
function context(){
  let active=true,wallDistance=null;
  const camera={position:new Vec(),fov:48,near:.01,updateProjectionMatrix(){},lookAt(p){this.target=p.clone();}};
  const c={THREE:{Vector3:Vec,Quaternion:Quat,Box3:class{setFromObject(){return{max:{y:.6}};}},Raycaster:class{intersectObject(){return wallDistance===null?[]:[{distance:wallDistance,object:{isMesh:true}}];}}},
    document:{getElementById:id=>id==='page-playground'?{classList:{contains:()=>active}}:null,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},
    rviz3d:{camera,objects:{},worldTFs:new Map(),robotPos:{},fixedFrame:'map'},rvizCam:{theta:.4,phi:.8,radius:12,target:{x:2,y:0,z:-3}},displayList:[],_live:false,sessionId:'sim-a',
    playgroundMapData:{start:[2,3],startPose:{x:2,y:3,z:0,yaw:90},objects:[{type:'start',x:2,y:3,z:0,r:90,h:.45}]},
    r2t:(x,y,z)=>new Vec(-y,z,-x),rq2tq:(x,y,z,w)=>new Quat(-y,z,-x,w),rvizActivateTool(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/playground-camera.js'),'utf8')+'\nglobalThis.state=playgroundCamera;',c);
  return{c,camera,setActive:v=>active=v,setWall:v=>wallDistance=v};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);
const yaw=r=>new Quat(0,Math.sin(r/2),0,Math.cos(r/2));

test('first person previews from saved spawn with ROS forward direction, never world origin',()=>{
  const {c,camera}=context();c.playgroundSetCameraView('first');assert.equal(c.playgroundUpdateCamera(),true);
  near(camera.position.x,-3);near(camera.position.z,-2);near(camera.position.y,.55);near(camera.target.x,-8);near(camera.target.z,-2);assert.equal(camera.fov,72);assert.equal(camera.near,.025);
});

test('first and third person track live TF turns and third person remains behind the robot',()=>{
  const {c,camera}=context();c._live=true;c.rviz3d.worldTFs.set('base_link',{pos:new Vec(5,0,-4),quat:yaw(0)});c.playgroundSetCameraView('third');c.playgroundUpdateCamera();
  near(camera.position.x,5);near(camera.position.z,-1.8);near(camera.target.z,-4);
  c.rviz3d.worldTFs.set('base_link',{pos:new Vec(6,0,-4),quat:yaw(Math.PI/2)});
  for(let i=0;i<100;i++)c.playgroundUpdateCamera(1/60);
  near(camera.position.x,8.2);near(camera.position.z,-4);near(camera.target.x,6);
  c.playgroundSetCameraView('first');c.playgroundUpdateCamera();near(camera.position.x,6);near(camera.target.x,1);near(camera.target.z,-4);
});

test('camera follows interpolated model poses and restores the current Robot layer choice',()=>{
  const {c,camera}=context();c._live=true;
  const link={userData:{frame:'base_link',smoothReady:true},getWorldPosition:()=>new Vec(1,0,-2),getWorldQuaternion:()=>yaw(0)};
  const model={children:[link],visible:true};c.rviz3d.objects.robot=model;c.displayList=[{id:'robot',type:'RobotModel',enabled:true,props:{baseFrame:'base_link'}}];c.rviz3d.worldTFs.set('base_link',{pos:new Vec(10,0,-2),quat:yaw(0)});
  c.playgroundSetCameraView('first');c.playgroundUpdateCamera();near(camera.position.x,1);near(camera.position.y,.7);assert.equal(model.visible,false);
  c.playgroundSetCameraView('third');c.playgroundUpdateCamera();assert.equal(model.visible,true);
  c.playgroundSetCameraView('first');c.playgroundUpdateCamera();c.displayList[0].enabled=false;
  for(let i=0;i<100;i++)c.playgroundUpdateCamera(1/60);
  near(camera.position.x,10);near(camera.position.y,.7);
  c.playgroundSetCameraView('free');assert.equal(model.visible,false);
  c.rviz3d.worldTFs.clear();c.displayList[0].enabled=true;
  const beforeTF=c.playgroundCameraRobotPose();near(beforeTF.pos.x,-3);near(beforeTF.pos.z,-2);
});

test('returning to Free hand restores the last orbit, projection and mouse controls',()=>{
  const {c,camera}=context(),orbit=JSON.stringify(c.rvizCam);c.playgroundSetCameraView('first');c.playgroundUpdateCamera();c.rvizCam.radius=50;c.rvizCam.target={x:99,y:0,z:99};c.playgroundSetCameraView('third');c.playgroundUpdateCamera();c.playgroundSetCameraView('free');
  assert.equal(JSON.stringify({theta:c.rvizCam.theta,phi:c.rvizCam.phi,radius:c.rvizCam.radius,target:c.rvizCam.target}),orbit);assert.equal(camera.fov,48);assert.equal(camera.near,.01);assert.equal(c.playgroundUpdateCamera(),false);assert.equal(c.playgroundCameraZoom(2),false);
});

test('third person shortens camera distance before a wall and wheel zoom stays bounded',()=>{
  const {c,camera,setWall}=context();c.rviz3d.playgroundDecor={visible:true,updateWorldMatrix(){}};setWall(.75);c.playgroundSetCameraView('third');c.playgroundUpdateCamera();near(camera.position.clone().sub(camera.target).length(),.63);
  c.playgroundCameraZoom(100);assert.equal(c.state.distance,8);c.playgroundCameraZoom(.001);assert.equal(c.state.distance,.8);
});

test('leaving Playground restores RViz and switching sessions clears the following mode',()=>{
  const {c,camera,setActive}=context();c.playgroundCameraEnter();c.playgroundSetCameraView('first');c.playgroundUpdateCamera();setActive(false);assert.equal(c.playgroundUpdateCamera(),false);assert.equal(camera.fov,48);assert.equal(camera.near,.01);
  setActive(true);c.sessionId='sim-b';c.playgroundCameraEnter();assert.equal(c.state.mode,'free');c.playgroundSetCameraView('invalid');assert.equal(c.state.mode,'free');
});

test('odom fallback applies the map transform and ignores odom before its first sample',()=>{
  const {c}=context();c._live=true;c.rviz3d.robotPos={received:true,x:1,y:0,yaw:0};c.rviz3d.worldTFs.set('odom',{pos:new Vec(3,0,4),quat:yaw(Math.PI/2)});
  let p=c.playgroundCameraRobotPose();near(p.pos.x,2);near(p.pos.z,4);near(new Vec(0,0,-1).applyQuaternion(p.quat).x,-1);
  c.rviz3d.robotPos.received=false;p=c.playgroundCameraRobotPose();near(p.pos.x,-3);near(p.pos.z,-2);
});
