'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const THREE=require('three'),View=require('../public/robot-editor-view');
const near=(a,b,tolerance=1e-6)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
function update(cam,camera){
  camera.position.set(cam.target.x+cam.radius*Math.sin(cam.phi)*Math.cos(cam.theta),cam.target.y+cam.radius*Math.cos(cam.phi),cam.target.z+cam.radius*Math.sin(cam.phi)*Math.sin(cam.theta));
  camera.lookAt(cam.target.x,cam.target.y,cam.target.z);camera.updateMatrixWorld(true);
}
test('assembly pan follows screen pixels at every view angle in perspective and orthographic, including below the robot',()=>{
  for(const ortho of [false,true])for(const theta of [0,Math.PI/2,Math.PI,-Math.PI/2,.7])for(const phi of [.015,1.1,Math.PI/2,Math.PI-.015]){
    const cam={theta,phi,radius:3,target:{x:.1,y:.2,z:.3}},camera=ortho?new THREE.OrthographicCamera(-2,2,1.5,-1.5,.01,100):new THREE.PerspectiveCamera(45,800/600,.01,100);
    update(cam,camera);const anchor=new THREE.Vector3(.1,.2,.3);
    View.pan(cam,camera,70,-40,600,THREE);update(cam,camera);
    const ndc=anchor.project(camera);near(ndc.x*400,70);near(-ndc.y*300,-40);
  }
});
test('orbit uses a consistent upright handedness, zoom is reversible, and fit accounts for tall narrow viewports',()=>{
  const cam={theta:0,phi:1,radius:3,target:{x:0,y:0,z:0}};
  View.orbit(cam,60,20,600);assert.ok(cam.theta>0);assert.ok(cam.phi<1);
  View.orbit(cam,0,1e6,600);assert.ok(cam.phi>0);View.orbit(cam,0,-1e6,600);assert.ok(cam.phi<Math.PI);
  View.zoom(cam,100);View.zoom(cam,-100);near(cam.radius,3);
  near(View.shortestAngle(2*Math.PI-.02,.02),2*Math.PI+.02);
  const box={x:.6,y:.3,z:.4};assert.ok(View.fitRadius(box,.5)>View.fitRadius(box,2));
});
test('only the assembly gizmo keeps positive handles and hit targets across camera hemispheres; local rotations and colors agree',()=>{
  const T={...THREE};vm.runInNewContext(fs.readFileSync(require.resolve('three/examples/js/controls/TransformControls'),'utf8'),{THREE:T,console});
  const dom={style:{},addEventListener(){},removeEventListener(){},ownerDocument:{addEventListener(){},removeEventListener(){}}};
  const camera=new T.PerspectiveCamera(45,1,.01,100),scene=new T.Scene(),parent=new T.Group(),object=new T.Group();
  parent.rotation.set(.2,.5,-.4);object.rotation.set(-.3,.4,.1);parent.add(object);scene.add(parent);
  const tc=new T.TransformControls(camera,dom),untouched=new T.TransformControls(camera,dom),original=untouched._gizmo.updateMatrixWorld;
  tc.setSpace('local');tc.attach(object);scene.add(tc);View.positiveGizmo(tc,T);
  assert.equal(untouched._gizmo.updateMatrixWorld,original);assert.notEqual(tc._gizmo.updateMatrixWorld,original);
  for(const mode of ['translate','scale'])for(const x of [-3,3])for(const y of [-2,2])for(const z of [-4,4]){
    tc.setMode(mode);camera.position.set(x,y,z);camera.lookAt(0,0,0);scene.updateMatrixWorld(true);
    for(const group of [tc._gizmo.gizmo[mode],tc._gizmo.picker[mode]])for(const handle of group.children){
      assert.ok(handle.scale.x>=0&&handle.scale.y>=0&&handle.scale.z>=0);
      if(handle.tag==='bwd')assert.equal(handle.visible,false);
      if(!handle.visible||handle.name.length!==1)continue;
      handle.geometry.computeBoundingBox();const center=handle.geometry.boundingBox.getCenter(new T.Vector3()).applyMatrix4(handle.matrixWorld).sub(tc.worldPosition);
      const direction=new T.Vector3().setComponent('XYZ'.indexOf(handle.name),1).applyQuaternion(tc.worldQuaternion);
      assert.ok(center.dot(direction)>0,mode+' '+handle.name+' points in its positive local direction');
    }
  }
  tc.setMode('translate');scene.updateMatrixWorld(true);
  const colors={X:0x44ff66,Y:0x4488ff,Z:0xff4444};
  for(const axis of ['X','Y','Z'])assert.equal(tc._gizmo.gizmo.translate.children.find(h=>h.name===axis&&h.tag==='fwd').material.color.getHex(),colors[axis]);
  tc.dispose();untouched.dispose();
});
test('camera preset animation takes the shortest turn and stops immediately when the user starts navigating',()=>{
  const frames=[],c={THREE,RobotEditorView:View,window:{addEventListener(){}},document:{querySelectorAll:()=>[],getElementById:()=>null},requestAnimationFrame:fn=>frames.push(fn)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/transformation'),'utf8')+'\nglobalThis.state=tf;',c);
  c.state.cam.theta=2*Math.PI-.02;c.tfAnimateCam(.02,1,3,{x:0,y:0,z:0});frames.shift()(0);frames.shift()(130);
  assert.ok(c.state.cam.theta>2*Math.PI-.02,'no long reverse spin');
  c.tfCancelCamAnimation();const stopped=JSON.stringify(c.state.cam);while(frames.length)frames.shift()(500);
  assert.equal(JSON.stringify(c.state.cam),stopped);
});
test('top and bottom plans put the robot forward direction up, and side presets look from the named ROS side',()=>{
  const frames=[],c={THREE,RobotEditorView:View,window:{addEventListener(){}},document:{querySelectorAll:()=>[],getElementById:()=>null},requestAnimationFrame:fn=>frames.push(fn)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/transformation'),'utf8')+'\nglobalThis.state=tf;',c);
  c.state.camera=c.state.perspCam=new THREE.PerspectiveCamera(45,1,.01,100);
  for(const view of ['top','bottom','front','back','left','right']){
    c.tfSetView(view);frames.shift()(0);frames.shift()(300);c.state.camera.updateMatrixWorld(true);
    if(view==='top'||view==='bottom'){
      const forward=c.tf_r2t(.1,0,0).project(c.state.camera),left=c.tf_r2t(0,.1,0).project(c.state.camera);
      assert.ok(forward.y>0);near(forward.x,0);assert.ok(view==='top'?left.x<0:left.x>0);
    }else {
      const axis=['front','back'].includes(view)?'z':'x',sign=['front','left'].includes(view)?1:-1;
      assert.ok(c.state.camera.position[axis]*sign>0);near(c.state.camera.position.y,0);
    }
  }
});
