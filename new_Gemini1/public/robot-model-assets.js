/* Portable visual assets for the REAL robot builder only.
 * STL vertices are baked from the displayed mesh into the link's ROS frame.
 * No commands or writes: the caller saves these strings using its existing
 * package-save action. RViz reads only these content-addressed package assets.
 */
(function(root) {
  'use strict';
  const number=v=>{if(!Number.isFinite(v))throw new Error('ชิ้นส่วนมีพิกัดที่ไม่ถูกต้อง');return Number(v.toFixed(8)).toString();};
  function hash(text) {
    let a=2166136261,b=5381;
    for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}
    return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
  }
  function fromMesh(object, THREE) {
    const batches=new Map();
    object.updateMatrixWorld(true);
    object.traverse(mesh=>{
      if(!mesh.isMesh || !mesh.geometry?.attributes.position)return;
      const geo=mesh.geometry,positions=geo.attributes.position,materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
      const groups=Array.isArray(mesh.material)?geo.groups:[{start:0,count:geo.index?geo.index.count:positions.count,materialIndex:0}];
      for(const group of groups) {
        const material=materials[group.materialIndex];if(!material)continue;
        // Imported bitmaps have no portable UV/texture export in this builder.
        // Never silently turn a textured part into a differently coloured box.
        if(material.map)throw new Error('ชิ้นส่วนมี Texture: กรุณาใช้สีวัสดุแทน Texture ก่อนส่งออก ROS');
        const color=material.color?.getHex() ?? 0x8aa0b5,opacity=material.opacity ?? 1,key=color+':'+opacity;
        if(!batches.has(key))batches.set(key,{color,opacity,facets:[]});
        const batch=batches.get(key),count=geo.index?geo.index.count:positions.count;
        for(let i=group.start;i<Math.min(group.start+group.count,count);i+=3) {
          const vertices=[];
          for(let j=0;j<3;j++) {
            const v=new THREE.Vector3().fromBufferAttribute(positions,geo.index?geo.index.getX(i+j):i+j).applyMatrix4(mesh.matrixWorld);
            vertices.push(new THREE.Vector3(v.z,v.x,v.y)); // inverse TF r2t
          }
          const [a,b,c]=vertices,n=new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).normalize();
          if(n.lengthSq()<1e-16)continue;
          batch.facets.push(`facet normal ${n.toArray().map(number).join(' ')}\n outer loop\n${vertices.map(v=>'  vertex '+v.toArray().map(number).join(' ')).join('\n')}\n endloop\nendfacet`);
        }
      }
    });
    const files={},visuals=[];
    for(const batch of batches.values()) {
      if(!batch.facets.length)continue;
      const content='solid roside\n'+batch.facets.join('\n')+'\nendsolid roside\n',name='tf_'+hash(content)+'.stl';
      files['meshes/'+name]=content;
      const geometry=`<mesh filename="package://sim_robot_tf/meshes/${name}"/>`;
      const rgba=[(batch.color>>16)&255,(batch.color>>8)&255,batch.color&255].map(v=>number(v/255)).join(' ')+' '+number(batch.opacity);
      const material=`<material name="mesh_${batch.color.toString(16)}_${number(batch.opacity).replace('.','_')}"><color rgba="${rgba}"/></material>`;
      visuals.push(`    <visual><origin xyz="0 0 0" rpy="0 0 0"/><geometry>${geometry}</geometry>${material}</visual>\n    <collision><geometry>${geometry}</geometry></collision>\n`);
    }
    if(!visuals.length)throw new Error('ไม่พบรูปทรงของชิ้นส่วนที่จะบันทึก');
    return {files,markup:visuals.join('')};
  }
  function dispose(object) {
    const materials=new Set();
    object.traverse(o=>{o.geometry?.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])if(m)materials.add(m);});
    for(const m of materials){m.map?.dispose();m.dispose();}
  }
  function parseSTL(text, THREE, scale=[1,1,1], rviz=true) {
    if(typeof text!=='string'||text.length>40*1024*1024||!/^solid\s/.test(text))throw new Error('Invalid generated STL');
    const vertices=[],pattern=/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g;let match;
    while((match=pattern.exec(text))) {
      const [x,y,z]=match.slice(1).map((v,i)=>Number(v)*scale[i]);
      if(![x,y,z].every(Number.isFinite)||vertices.length>=3000000)throw new Error('Invalid or oversized STL geometry');
      vertices.push(rviz?-y:y,z,rviz?-x:x);
    }
    if(!vertices.length||vertices.length%9)throw new Error('Incomplete STL geometry');
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geo.computeVertexNormals();return geo;
  }
  const pending=new Map();
  function load(geo,material,THREE,{sessionId,workspace,read,onError,isCurrent}) {
    const match=/^package:\/\/sim_robot_tf\/meshes\/(tf_[a-f0-9]{16}\.stl)$/.exec(geo.filename || '');
    if(!match)return null;
    const mesh=new THREE.Mesh(new THREE.BufferGeometry(),material);let disposed=false;
    mesh.userData.modelAssetStatus='loading';mesh.geometry.addEventListener('dispose',()=>{disposed=true;});
    const file=(workspace || '~/ros2_ws').replace(/\/$/,'')+'/src/sim_robot_tf/meshes/'+match[1],key=sessionId+':'+file;
    if(!pending.has(key)) {
      const request=Promise.resolve().then(()=>read('/api/files/read',{sessionId,path:file})).then(r=>{if(!r?.ok)throw new Error(r?.error || 'อ่านไฟล์โมเดลไม่ได้');return r.content;});
      pending.set(key,request);
      // Coalesce concurrent reads only; never retain another robot's model.
      request.then(()=>pending.delete(key),()=>pending.delete(key));
    }
    pending.get(key).then(text=>{
      if(disposed || (isCurrent&&!isCurrent()))return;
      const parsed=parseSTL(text,THREE,geo.scale || [1,1,1]);
      mesh.geometry.copy(parsed);parsed.dispose();mesh.userData.modelAssetStatus='ready';
    }).catch(error=>{if(!disposed){mesh.userData.modelAssetStatus='error';onError?.(error);}});
    return mesh;
  }
  // Store-only ZIP for standalone URDF downloads which need accompanying meshes.
  function zip(files) {
    const encoder=new TextEncoder(),chunks=[],central=[];let offset=0;
    const crc=data=>{let c=0xffffffff;for(const v of data){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
    const header=(size)=>{const bytes=new Uint8Array(size);return [bytes,new DataView(bytes.buffer)];};
    for(const [path,text] of Object.entries(files)) {
      const name=encoder.encode(path),data=encoder.encode(text),sum=crc(data),[h,v]=header(30);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,sum,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);
      chunks.push(h,name,data);
      const [c,w]=header(46);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint32(16,sum,true);w.setUint32(20,data.length,true);w.setUint32(24,data.length,true);w.setUint16(28,name.length,true);w.setUint32(42,offset,true);
      central.push(c,name);offset+=h.length+name.length+data.length;
    }
    const size=central.reduce((n,a)=>n+a.length,0),[end,v]=header(22);v.setUint32(0,0x06054b50,true);v.setUint16(8,Object.keys(files).length,true);v.setUint16(10,Object.keys(files).length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
    const result=new Uint8Array(offset+size+22);let at=0;for(const chunk of [...chunks,...central,end]){result.set(chunk,at);at+=chunk.length;}return result;
  }
  const api={fromMesh,dispose,parseSTL,load,zip};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RobotModelAssets=api;
})(typeof globalThis!=='undefined'?globalThis:this);
