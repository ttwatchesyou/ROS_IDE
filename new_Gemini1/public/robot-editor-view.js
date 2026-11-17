/* Assembly view only. ROS (X,Y,Z) maps to Three (Z,X,Y).
 * No model, TF, package or runtime writes. TransformControls remains local
 * to the selected component; camera movement never changes its positive axes.
 */
(function(root) {
  'use strict';
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const shortestAngle=(from,to)=>from+Math.atan2(Math.sin(to-from),Math.cos(to-from));
  function orbit(cam,dx,dy,height) {
    const speed=2*Math.PI*.65/Math.max(1,height);
    // Our azimuth uses cos(theta) for X, unlike Three's spherical convention.
    cam.theta+=dx*speed;
    cam.phi=clamp(cam.phi-dy*speed,.015,Math.PI-.015);
  }
  function pan(cam,camera,dx,dy,height,THREE) {
    camera.updateMatrixWorld(true);
    const span=camera.isOrthographicCamera?(camera.top-camera.bottom)/camera.zoom:
      2*cam.radius*Math.tan(camera.fov*Math.PI/360)/camera.zoom;
    const scale=span/Math.max(1,height);
    const delta=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0).multiplyScalar(-dx*scale);
    delta.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1),dy*scale);
    for(const axis of ['x','y','z'])cam.target[axis]+=delta[axis];
  }
  function zoom(cam,pixels) { cam.radius=clamp(cam.radius*Math.exp(clamp(pixels,-400,400)*.0015),.08,200); }
  function fitRadius(size,aspect,fov=45) {
    const halfV=fov*Math.PI/360,halfH=Math.atan(Math.tan(halfV)*Math.max(.1,aspect));
    return clamp(Math.hypot(size.x,size.y,size.z)*.5/Math.sin(Math.min(halfV,halfH))*1.2,.08,200);
  }
  function positiveGizmo(tc,THREE) {
    const gizmo=tc._gizmo;
    if(!gizmo||gizmo.userData.positiveAxes)return;
    gizmo.userData.positiveAxes=true;
    // The stock r128 gizmo flips negative-facing handles toward the camera.
    // Undo only this instance's visual/picker mirroring, not drag-plane math
    // or any shared Three prototype used by Map Editor/other pages.
    const original=gizmo.updateMatrixWorld;
    gizmo.updateMatrixWorld=function(force) {
      original.call(this,force);
      if(this.mode!=='translate'&&this.mode!=='scale')return;
      for(const group of [this.gizmo[this.mode],this.picker[this.mode]])for(const handle of group.children){
        handle.scale.set(Math.abs(handle.scale.x),Math.abs(handle.scale.y),Math.abs(handle.scale.z));
        if(handle.tag==='bwd')handle.visible=false;
        else if(handle.tag==='fwd')handle.visible=handle.scale.lengthSq()>1e-15&&
          (!handle.name.includes('X')||this.showX)&&(!handle.name.includes('Y')||this.showY)&&(!handle.name.includes('Z')||this.showZ);
      }
      THREE.Object3D.prototype.updateMatrixWorld.call(this,force);
    };
    // Materials are shared among handles: recolour each once, not repeatedly.
    const seen=new Set(),colors={0xff0000:0x44ff66,0x00ff00:0x4488ff,0x0000ff:0xff4444};
    tc.traverse(object=>{for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(!material?.color||seen.has(material))continue;seen.add(material);
      const color=colors[material.color.getHex()];if(color!==undefined)material.color.setHex(color);
    }});
  }
  const api={orbit,pan,zoom,fitRadius,shortestAngle,positiveGizmo};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RobotEditorView=api;
})(typeof globalThis!=='undefined'?globalThis:this);
