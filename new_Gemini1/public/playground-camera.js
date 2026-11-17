'use strict';
// Camera poses use the same fixed-frame Three.js coordinates as the live robot.
const playgroundCamera={mode:'free',session:null,engaged:false,free:null,projection:null,
  position:null,quaternion:null,look:null,distance:2.2,metrics:null,hiddenModels:new Map()};
const PLAYGROUND_CAMERA_LABELS={free:'อิสระ · Free hand',first:'บุคคลที่ 1',third:'บุคคลที่ 3'};

function playgroundCameraFollowing(){
  return playgroundCamera.mode!=='free'&&Boolean(document.getElementById('page-playground')?.classList.contains('show'));
}
function playgroundCameraSyncMenu(){
  const label=document.getElementById('pg-camera-label');if(label)label.textContent=PLAYGROUND_CAMERA_LABELS[playgroundCamera.mode];
  document.querySelectorAll('[data-pg-camera]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.pgCamera===playgroundCamera.mode)));
}
function playgroundCameraRestoreModels(){
  for(const [object,visible] of playgroundCamera.hiddenModels){
    const display=displayList.find(d=>rviz3d.objects[d.id]===object);object.visible=display?display.enabled:visible;
  }
  playgroundCamera.hiddenModels.clear();
}
function playgroundCameraSuspend(){
  playgroundCameraRestoreModels();
  if(playgroundCamera.engaged&&rviz3d.camera&&playgroundCamera.projection){Object.assign(rviz3d.camera,playgroundCamera.projection);rviz3d.camera.updateProjectionMatrix();}
  playgroundCamera.engaged=false;playgroundCamera.position=null;playgroundCamera.quaternion=null;playgroundCamera.look=null;
}
function playgroundSetCameraView(mode){
  if(!Object.hasOwn(PLAYGROUND_CAMERA_LABELS,mode))return;
  const previous=playgroundCamera.mode;
  if(previous==='free'&&mode!=='free')playgroundCamera.free={theta:rvizCam.theta,phi:rvizCam.phi,radius:rvizCam.radius,target:{...rvizCam.target}};
  playgroundCameraSuspend();playgroundCamera.mode=mode;
  if(mode==='free'&&previous!=='free'&&playgroundCamera.free)Object.assign(rvizCam,{...playgroundCamera.free,target:{...playgroundCamera.free.target}});
  rvizCam.drag=false;rvizCam.rightDrag=false;
  if(mode!=='free'&&typeof rvizActivateTool==='function')rvizActivateTool('move');
  const menu=document.getElementById('pg-camera-menu');if(menu)menu.open=false;
  playgroundCameraSyncMenu();
  if(rviz3d.camera&&typeof _camUpdate==='function')_camUpdate(1/60);
}
function playgroundCameraEnter(){
  if(playgroundCamera.session!==sessionId){playgroundSetCameraView('free');playgroundCamera.free=null;playgroundCamera.metrics=null;playgroundCamera.distance=2.2;playgroundCamera.session=sessionId;}
  playgroundCameraSyncMenu();
}
function playgroundCameraZoom(factor){
  if(!playgroundCameraFollowing())return false;
  if(playgroundCamera.mode==='third')playgroundCamera.distance=Math.max(.8,Math.min(8,playgroundCamera.distance*factor));
  return true;
}

function playgroundCameraRobotPose(){
  const models=displayList.filter(d=>d.type==='RobotModel');
  const baseFrame=models[0]?.props?.baseFrame||'base_link';
  if(_live){
    // Follow the displayed (interpolated) base, avoiding jitter between TF ticks.
    for(const display of models){
      const frame=display.props?.baseFrame||'base_link';
      // Disabled displays stop interpolating; their last pose is no longer live.
      if(!display.enabled||!rviz3d.worldTFs?.has(frame))continue;
      const model=rviz3d.objects[display.id],link=model?.children.find(n=>n.userData.frame===frame&&n.userData.smoothReady);
      if(link){return {pos:link.getWorldPosition(new THREE.Vector3()),quat:link.getWorldQuaternion(new THREE.Quaternion()),model,smoothed:true};}
    }
    for(const frame of [baseFrame,'base_link','base_footprint']){
      const pose=rviz3d.worldTFs?.get(frame);if(pose)return {pos:pose.pos.clone(),quat:pose.quat.clone(),smoothed:false};
    }
    // Odom alone is usable only when its transform into the fixed frame is known.
    if(rviz3d.robotPos.received){
      const frame=rviz3d.worldTFs?.get('odom');
      if(frame||rviz3d.fixedFrame==='odom'){
        const robot=rviz3d.robotPos,pos=r2t(robot.x,robot.y,0),quat=rq2tq(0,0,Math.sin(robot.yaw/2),Math.cos(robot.yaw/2));
        if(frame){pos.applyQuaternion(frame.quat).add(frame.pos);quat.premultiply(frame.quat);}
        return {pos,quat,smoothed:false};
      }
    }
  }
  // Before starting Sim, preview from the saved spawn instead of the world origin.
  const start=playgroundMapData?.objects?.find(o=>o.type==='start'),saved=playgroundMapData?.startPose,point=playgroundMapData?.start||[0,0];
  const x=Number(start?.x??saved?.x??point[0])||0,y=Number(start?.y??saved?.y??point[1])||0,z=Number(start?.z??saved?.z)||0,yaw=(Number(start?.r??saved?.yaw)||0)*Math.PI/180;
  return {pos:r2t(x,y,z),quat:rq2tq(0,0,Math.sin(yaw/2),Math.cos(yaw/2)),smoothed:false};
}
function playgroundCameraRobotHeight(pose){
  const model=pose.model,key=model?.children[0];
  if(key&&playgroundCamera.metrics?.key!==key){
    const bounds=new THREE.Box3().setFromObject(model),height=bounds.max.y-pose.pos.y;
    playgroundCamera.metrics={key,height:Number.isFinite(height)?Math.max(.25,Math.min(3,height)):.45};
  }
  if(key)return playgroundCamera.metrics.height;
  if(playgroundCamera.metrics)return playgroundCamera.metrics.height;
  return Math.max(.25,Math.min(3,Number(playgroundMapData?.objects?.find(o=>o.type==='start')?.h)||.45));
}
function playgroundCameraAvoidWalls(target,eye){
  const room=rviz3d.playgroundDecor;if(!room||!room.visible)return eye;
  const direction=eye.clone().sub(target),length=direction.length();if(length<.01)return eye;
  room.updateWorldMatrix(true,true);
  const ray=new THREE.Raycaster(target,direction.normalize(),.02,length+.12),hit=ray.intersectObject(room,true).find(hit=>hit.object.isMesh);
  if(hit)return target.clone().addScaledVector(direction,Math.max(.025,Math.min(length,hit.distance-.12)));
  return eye;
}
function playgroundUpdateCamera(dt=1/60){
  if(!playgroundCameraFollowing()||!rviz3d.camera){if(playgroundCamera.engaged)playgroundCameraSuspend();return false;}
  const state=playgroundCamera,camera=rviz3d.camera,pose=playgroundCameraRobotPose(),alpha=1-Math.exp(-18*Math.min(.1,Math.max(0,dt)));
  if(!state.engaged){state.projection={fov:camera.fov,near:camera.near};state.engaged=true;state.position=pose.pos.clone();state.quaternion=pose.quat.clone();camera.near=.025;camera.fov=state.mode==='first'?72:55;camera.updateProjectionMatrix();}
  if(pose.smoothed){state.position.copy(pose.pos);state.quaternion.copy(pose.quat);}
  else{state.position.lerp(pose.pos,alpha);state.quaternion.slerp(pose.quat,alpha);}
  const forward=new THREE.Vector3(0,0,-1).applyQuaternion(state.quaternion);forward.y=0;if(forward.lengthSq()<1e-8)forward.set(0,0,-1);forward.normalize();
  const height=playgroundCameraRobotHeight(pose);
  if(state.mode==='first'){
    for(const d of displayList.filter(d=>d.type==='RobotModel')){const obj=rviz3d.objects[d.id];if(obj){if(!state.hiddenModels.has(obj))state.hiddenModels.set(obj,obj.visible);obj.visible=false;}}
    camera.position.copy(state.position).add(new THREE.Vector3(0,height+.1,0));
    camera.lookAt(camera.position.clone().addScaledVector(forward,5));
  }else{
    playgroundCameraRestoreModels();
    const target=state.position.clone().add(new THREE.Vector3(0,height*.65,0));
    const desired=state.position.clone().addScaledVector(forward,-state.distance).add(new THREE.Vector3(0,height+.85,0));
    // Resolve obstructions every frame, including while reversing toward a wall.
    camera.position.copy(playgroundCameraAvoidWalls(target,desired));camera.lookAt(target);
  }
  return true;
}

// Native details/summary handles keyboard and touch activation of the view menu.
document.addEventListener('click',event=>{const menu=document.getElementById('pg-camera-menu');if(menu?.open&&!menu.contains(event.target))menu.open=false;});
window.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=document.getElementById('pg-camera-menu');if(menu?.open){menu.open=false;menu.querySelector('summary')?.focus();}});
