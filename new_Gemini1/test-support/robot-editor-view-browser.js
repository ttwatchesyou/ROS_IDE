'use strict';
const assert=require('node:assert/strict');
module.exports=async function checkEditorView({evaluate,cdp,capture}) {
  const near=(a,b,tolerance=.05)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
  const pause=()=>evaluate('new Promise(r=>setTimeout(r,80))');
  const mouse=(type,x,y,button='none',modifiers=0)=>cdp('Input.dispatchMouseEvent',{type,x,y,button,buttons:type==='mouseReleased'?0:button==='left'?1:button==='right'?2:button==='middle'?4:0,clickCount:type==='mouseMoved'?0:1,modifiers});
  const drag=async(point,dx,dy,button='left',modifiers=0)=>{
    await mouse('mouseMoved',point.x,point.y);await mouse('mousePressed',point.x,point.y,button,modifiers);
    for(let i=1;i<=8;i++)await mouse('mouseMoved',point.x+dx*i/8,point.y+dy*i/8,button,modifiers);
    await mouse('mouseReleased',point.x+dx,point.y+dy,button,modifiers);await pause();
  };
  await evaluate(`tfCancelCamAnimation();window.viewModelBefore=tfBuildModelJSON();window.viewCamBefore=JSON.parse(JSON.stringify(tf.cam));window.viewSelectedBefore=tf.selected;`);
  const rect=await evaluate(`(()=>{const r=tf.renderer.domElement.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`),blank={x:rect.x+35,y:rect.y+170};
  const before=await evaluate(`JSON.parse(JSON.stringify(tf.cam))`);
  await drag(blank,65,25);
  const orbit=await evaluate(`JSON.parse(JSON.stringify(tf.cam))`);
  assert.ok(orbit.theta>before.theta);assert.ok(orbit.phi<before.phi);assert.deepEqual(orbit.target,before.target);
  assert.equal(await evaluate(`tfBuildModelJSON()===viewModelBefore&&tf.selected===viewSelectedBefore`),true,'orbit cannot change the selected object or its TF');

  await evaluate(`window.panAnchor=new THREE.Vector3(tf.cam.target.x,tf.cam.target.y,tf.cam.target.z);`);
  await drag(blank,48,-32,'right');
  const pan=await evaluate(`(()=>{const p=panAnchor.clone().project(tf.camera);return {x:p.x,y:p.y,menu:!!tfContextMenu};})()`);
  near(pan.x*rect.width/2,48);near(-pan.y*rect.height/2,-32);assert.equal(pan.menu,false,'right-drag is not a context-menu click');
  await mouse('mousePressed',blank.x,blank.y,'right');await mouse('mouseReleased',blank.x,blank.y,'right');
  assert.equal(await evaluate(`!!tfContextMenu`),true);await evaluate('tfCloseContextMenu()');

  // The camera is behind +ROS X: the positive arrow must stay on the positive
  // side AND its actual mouse hit target must remain on that same side.
  await evaluate(`tf.cam={...viewCamBefore,theta:-Math.PI/4,phi:1};tfCamUpdate();tf.scene.updateMatrixWorld(true);`);
  const handle=()=>evaluate(`(()=>{
    tf.scene.updateMatrixWorld(true);const tc=tf.transformControls,h=tc._gizmo.gizmo.translate.children.find(h=>h.name==='Z'&&h.tag==='fwd');
    h.geometry.computeBoundingBox();const point=h.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(h.matrixWorld);
    const direction=new THREE.Vector3(0,0,1).applyQuaternion(tc.worldQuaternion),next=point.clone().addScaledVector(direction,.06);
    const screen=p=>{p.project(tf.camera);return{x:${rect.x}+(p.x+1)*${rect.width}/2,y:${rect.y}+(1-p.y)*${rect.height}/2};};
    const a=screen(point),b=screen(next);return {...a,dx:b.x-a.x,dy:b.y-a.y};
  })()`);
  let h=await handle();await mouse('mouseMoved',h.x,h.y);await pause();
  assert.equal(await evaluate(`tf.transformControls.axis`),'Z','visible positive ROS-X arrow has its matching picker');
  await drag(h,25,18,'left',8); // Shift uses bit 8 in CDP.
  assert.equal(await evaluate(`tfBuildModelJSON()===viewModelBefore`),true,'Shift-drag over a gizmo pans, never translates a part');
  await evaluate(`tf.cam={...viewCamBefore,theta:-Math.PI/4,phi:1};tfCamUpdate();`);h=await handle();
  const oldPose=await evaluate(`JSON.parse(JSON.stringify(tf.comps.find(c=>c.id===tf.selected).pos))`),oldTheta=await evaluate('tf.cam.theta');
  await drag(h,h.dx,h.dy);
  const newPose=await evaluate(`JSON.parse(JSON.stringify(tf.comps.find(c=>c.id===tf.selected).pos))`);
  near(newPose.x,oldPose.x+.06,.002);near(newPose.y,oldPose.y,.002);near(newPose.z,oldPose.z,.002);near(await evaluate('tf.cam.theta'),oldTheta,1e-8);
  await capture('positive-axes-rear-view');
  await evaluate(`tfApplyComps(JSON.parse(viewModelBefore));tfSelect(viewSelectedBefore);tf.cam={...viewCamBefore};tfCamUpdate();`);

  const touch=(type,points)=>cdp('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({...p,radiusX:5,radiusY:5,force:1}))});
  await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const first={id:1,x:blank.x+20,y:blank.y+80};
  const touchTheta=await evaluate('tf.cam.theta');
  await touch('touchStart',[first]);await touch('touchMove',[{...first,x:first.x+60,y:first.y+20}]);await touch('touchEnd',[]);await pause();
  assert.ok(await evaluate('tf.cam.theta')>touchTheta,'one finger orbits');
  const pinchStart=await evaluate(`({radius:tf.cam.radius,theta:tf.cam.theta})`);
  const second={id:2,x:first.x+100,y:first.y};
  await touch('touchStart',[first,second]);await touch('touchMove',[{...first,x:first.x-20},{...second,x:second.x+20}]);await touch('touchEnd',[]);await pause();
  assert.ok(await evaluate('tf.cam.radius')<pinchStart.radius,'two fingers zoom in');near(await evaluate('tf.cam.theta'),pinchStart.theta,1e-8);
  assert.equal(await evaluate(`tf.transformControls.enabled&&!tf.cam.drag&&getComputedStyle(tf.renderer.domElement).touchAction==='none'`),true);
  assert.equal(await evaluate(`tfBuildModelJSON()===viewModelBefore`),true,'touch navigation cannot change TF');
  await touch('touchStart',[first]);await evaluate('new Promise(r=>setTimeout(r,620))');
  assert.equal(await evaluate('!!tfContextMenu'),true,'long press still opens the existing context menu');
  await touch('touchEnd',[]);await evaluate('tfCloseContextMenu()');
  await cdp('Emulation.setTouchEmulationEnabled',{enabled:false});

  await evaluate(`tfFocusSelection();new Promise(r=>setTimeout(r,350));`);
  const focus=await evaluate(`(()=>{const p=tf.comps.find(c=>c.id===tf.selected),m=p.group.children.find(o=>o.userData.compId===p.id),b=new THREE.Box3().setFromObject(m);return {target:tf.cam.target,center:b.getCenter(new THREE.Vector3()),radius:tf.cam.radius};})()`);
  for(const axis of ['x','y','z'])near(focus.target[axis],focus.center[axis],1e-8);assert.ok(focus.radius<before.radius);
  await evaluate(`tfResetView();new Promise(r=>setTimeout(r,350));`);
  const fit=await evaluate(`(()=>{const points=[];for(const c of tf.comps){const m=c.group.children.find(o=>o.userData.compId===c.id),b=new THREE.Box3().setFromObject(m);for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z])points.push(new THREE.Vector3(x,y,z).project(tf.camera));}return points.every(p=>Math.abs(p.x)<1&&Math.abs(p.y)<1);})()`);
  assert.equal(fit,true,'Home/reset actually fits the robot, not just the previous empty target');
  await evaluate(`tfSetView('back');`);await drag(blank,28,-12);const stopped=await evaluate('tf.cam.theta');
  await evaluate('new Promise(r=>setTimeout(r,350))');near(await evaluate('tf.cam.theta'),stopped,1e-8);
  assert.equal(await evaluate(`tfBuildModelJSON()===viewModelBefore`),true);
  await evaluate(`tfApplyComps(JSON.parse(viewModelBefore));tfSelect(viewSelectedBefore);tfCancelCamAnimation();tf.cam={...viewCamBefore};tfCamUpdate();`);
};
