/* Small, static library thumbnails rendered from the actual accessory models.
 * One temporary WebGL context, no animation/network, cached for this page.
 */
(function(root) {
  'use strict';
  const images=Object.create(null);
  let attempted=false;
  function build(presets,THREE,visuals,accessories) {
    if(attempted)return images;
    attempted=true;let renderer;
    try {
      renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
      renderer.setSize(168,104,false);renderer.setClearColor(0x000000,0);
      renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.3;
      const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1.25,1.25,.78,-.78,.01,20);
      scene.add(new THREE.HemisphereLight(0xf1f6ff,0x718192,1.4));
      const key=new THREE.DirectionalLight(0xffffff,1.3);key.position.set(2,4,3);scene.add(key);
      const fill=new THREE.DirectionalLight(0xc8e5ff,.7);fill.position.set(-3,2,-1);scene.add(fill);
      camera.position.set(2,2.3,3);camera.lookAt(0,0,0);
      for(const preset of presets) {
        const c={id:'preview',name:preset.id+'_1',type:preset.type,params:{...preset.params,accessory:preset.id},color:accessories.defaults[preset.id]};
        const model=visuals.mesh(c,THREE,accessories.parts(c));if(!model)continue;
        const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),scale=1.65/Math.max(size.x,size.y,size.z);
        model.scale.setScalar(scale);model.position.copy(center).multiplyScalar(-scale);scene.add(model);
        renderer.render(scene,camera);images[preset.id]=renderer.domElement.toDataURL('image/png');scene.remove(model);
        const materials=new Set();model.traverse(o=>{o.geometry?.dispose();if(o.material)materials.add(o.material);});materials.forEach(m=>m.dispose());
      }
    } catch (_) {
      // Keep the labelled palette buttons usable when WebGL is unavailable.
    } finally {renderer?.dispose();renderer?.forceContextLoss();}
    return images;
  }
  root.RobotAccessoryPreviews={build};
})(typeof globalThis!=='undefined'?globalThis:this);
