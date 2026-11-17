/* Parametric robot hardware. All dimensions/poses are ROS metres/radians.
 * Shared by the assembly viewport and URDF export; no external mesh assets.
 * Mecanum remains an omni component with wheelStyle metadata for compatibility
 * with saved ODOM and Hardware Builder configurations.
 */
(function(root) {
  'use strict';
  const PI = Math.PI;
  const colors = { rubber:0x20252c, tread:0x353c45, alloy:0xb9c3cc, steel:0x798a9b, dark:0x17232f, blue:0x347ab6, gold:0xc29a50, pcb:0x176b52, glass:0x153c55 };
  const positive = (value, fallback) => Number.isFinite(+value) && +value > 0 ? +value : fallback;
  const wheelStyle = c => c.type === 'wheel' ? 'standard' :
    (c.params?.wheelStyle || (/^mecanum(?:_|$)/i.test(c.name || '') ? 'mecanum' : 'omni'));
  const handedness = c => Number(c.params?.handedness) === -1 ? -1 : Number(c.params?.handedness) === 1 ? 1 :
    (/^mecanum_(?:fl|rr)$/i.test(c.name || '') ? -1 : 1);
  const axisRPY = direction => [0, Math.acos(Math.max(-1, Math.min(1, direction[2]))), Math.atan2(direction[1], direction[0])];
  const mainColor = c => c.type === 'base' ? colors.blue : c.type === 'imu' ? colors.pcb :
    c.type === 'wheel' ? colors.alloy : c.type === 'omni' ? (wheelStyle(c) === 'mecanum' ? colors.gold : colors.blue) : colors.dark;
  function parts(c) {
    const p = c.params || {}, out = [];
    const add = (shape, dims, xyz, rpy, color, finish='metal', detail='') => {
      const part = {shape, ...dims, xyz:xyz || [0,0,0], rpy:rpy || [0,0,0], color,
        roughness:finish === 'rubber' ? .86 : finish === 'glass' ? .16 : .36,
        metalness:finish === 'rubber' ? .02 : finish === 'glass' ? .25 : .7, detail};
      out.push(part); return part;
    };
    const box = (size, xyz, color, rpy, finish) => add('box',{size},xyz,rpy,color,finish);
    const cyl = (radius, length, xyz, color, rpy, finish, detail) => add('cylinder',{radius,length},xyz,rpy,color,finish,detail);
    const bolt = (xyz, r, axis=[0,0,0]) => {
      cyl(r, r*.5, xyz, colors.steel, axis, 'metal', 'bolt');
      const dir = [Math.sin(axis[1])*Math.cos(axis[2]), Math.sin(axis[1])*Math.sin(axis[2]), Math.cos(axis[1])];
      // For the wheel axle we use roll=pi/2 (local Z points toward -Y).
      if (axis[0] === PI/2) { dir[0]=0; dir[1]=-1; dir[2]=0; }
      cyl(r*.4,r*.08,xyz.map((v,i)=>v+dir[i]*r*.27),colors.dark,axis,'rubber','socket');
    };
    if (c.type === 'wheel' || c.type === 'omni') {
      const R=positive(p.radius,.09), W=positive(p.width,.055), style=wheelStyle(c), axle=[PI/2,0,0];
      const rim=style === 'standard' ? colors.alloy : style === 'mecanum' ? colors.gold : colors.blue;
      if (style === 'standard') {
        cyl(R*.965,W*.82,[0,0,0],colors.rubber,axle,'rubber','tire');
        for(let i=0;i<32;i++) {
          const a=i*2*PI/32;
          box([R*.105,W*.80,R*.045],[Math.sin(a)*R*.975,0,Math.cos(a)*R*.975],colors.tread,[0,a,0],'rubber');
        }
      } else {
        const mecanum=style === 'mecanum', n=Math.max(6,Math.min(16,Math.round(positive(p.rollerCount,mecanum?10:8))));
        const rr=Math.min(positive(p.rollerR,R*.19),R*.23,W*(mecanum?.38:.24));
        const orbit=R-rr, length=mecanum ? Math.min(W*1.12,R*.72) : Math.min(2*orbit*Math.sin(PI/n)*.93,R*.64);
        const rows=mecanum ? [0] : [-W*.25,W*.25];
        rows.forEach((y,row)=>{
          for(let i=0;i<n;i++) {
            const a=(i+(row===1?.5:0))*2*PI/n;
            const radial=[Math.sin(a),0,Math.cos(a)], tangent=[Math.cos(a),0,-Math.sin(a)];
            const dir=mecanum ? [tangent[0]/Math.SQRT2,handedness(c)/Math.SQRT2,tangent[2]/Math.SQRT2] : tangent;
            const xyz=[radial[0]*orbit,y,radial[2]*orbit], rpy=axisRPY(dir);
            add('barrel',{radius:rr,length},xyz,rpy,colors.rubber,'rubber','roller');
            cyl(rr*.27,length*1.08,xyz,colors.steel,rpy,'metal','roller-axle');
            for(const sign of [-1,1]) {
              const end=xyz.map((v,k)=>v+dir[k]*sign*length*.47);
              cyl(rr*.65,length*.06,end,rim,rpy,'metal','roller-bearing');
            }
          }
        });
      }
      // Recessed hub, machined face plates, spokes and hex socket fasteners.
      cyl(R*.24,W*.98,[0,0,0],colors.alloy,axle);
      for(const side of [-1,1]) {
        const y=side*W*.43;
        cyl(R*.64,W*.09,[0,y,0],rim,axle);
        cyl(R*.48,W*.012,[0,y+side*W*.049,0],colors.dark,axle,'rubber');
        for(let i=0;i<6;i++) {
          const a=i*PI/3;
          box([R*.11,W*.04,R*.40],[Math.sin(a)*R*.37,y+side*W*.07,Math.cos(a)*R*.37],rim,[0,a,0]);
          bolt([Math.sin(a)*R*.56,y+side*W*.065,Math.cos(a)*R*.56],R*.032,axle);
        }
        cyl(R*.23,W*.07,[0,side*W*.46,0],colors.alloy,axle);
        cyl(R*.085,W*.008,[0,side*W*.499,0],colors.dark,axle,'rubber','axle-bore');
      }
    } else if (c.type === 'base') {
      const X=positive(p.sx,.6),Y=positive(p.sy,.4),Z=positive(p.sz,.25),t=Math.min(Z*.08,.012);
      box([X*.98,Y*.90,Z-t*2],[0,0,Z/2],colors.dark);
      for(const z of [t/2,Z-t/2]) box([X,Y,t],[0,0,z],colors.alloy);
      for(const side of [-1,1]) {
        box([X*.94,t,Z*.64],[0,side*(Y/2-t*.6),Z*.48],colors.blue);
        for(let i=0;i<10;i++) box([X*.034,t*.08,Z*.28],[(i-4.5)*X*.068,side*(Y/2-t*.04),Z*.50],colors.dark);
        for(const x of [-X*.44,X*.44]) bolt([x,side*Y*.41,Z-t*.12],Math.min(X,Y)*.016);
      }
      // Raised access panel and mounting slots, contained within chassis size.
      box([X*.55,Y*.61,t*.18],[0,0,Z-t*.12],colors.steel);
      for(let i=0;i<4;i++) for(const side of [-1,1]) box([X*.055,Y*.018,t*.05],[(i-1.5)*X*.12,side*Y*.21,Z-t*.01],colors.dark);
      box([t,Y*.72,Z*.22],[X/2-t*.5,0,Z*.35],colors.rubber,undefined,'rubber');
    } else if (c.type === 'lidar') {
      const R=positive(p.radius,.05),H=positive(p.height,.12);
      cyl(R,H*.20,[0,0,-H*.4],colors.alloy);
      cyl(R*.87,H*.50,[0,0,-H*.05],colors.dark);
      cyl(R*.9,H*.18,[0,0,H*.22],colors.glass,undefined,'glass');
      cyl(R*.94,H*.16,[0,0,H*.42],colors.dark);
      cyl(R*.5,H*.018,[0,0,H*.495],colors.blue);
      for(let i=0;i<3;i++) { const a=i*2*PI/3; bolt([R*.74*Math.cos(a),R*.74*Math.sin(a),-H*.28],R*.07); }
      box([R*.12,R*.28,H*.12],[R*.84,0,-H*.07],colors.gold);
    } else if (c.type === 'camera') {
      const X=positive(p.w,.06),Y=positive(p.d,.04),Z=positive(p.h,.05),R=Math.min(Y,Z)*.31,axis=[0,PI/2,0];
      box([X*.78,Y,Z],[-X*.11,0,0],colors.dark);
      box([X*.035,Y*.92,Z*.92],[X*.28,0,0],colors.alloy);
      cyl(R,X*.17,[X*.375,0,0],colors.dark,axis);
      cyl(R*.82,X*.03,[X*.473,0,0],colors.steel,axis);
      cyl(R*.68,X*.01,[X*.495,0,0],colors.glass,axis,'glass');
      cyl(R*.21,X*.012,[X*.50,0,0],0x326788,axis,'glass');
      for(const y of [-Y*.36,Y*.36]) for(const z of [-Z*.35,Z*.35]) bolt([X*.306,y,z],R*.10,axis);
      box([X*.25,Y*.42,Z*.025],[-X*.2,0,Z*.49],colors.steel);
    } else if (c.type === 'imu') {
      const S=positive(p.s,.04);
      box([S,S,S*.1],[0,0,-S*.12],colors.pcb,undefined,'rubber');
      box([S*.34,S*.34,S*.12],[0,0,0],colors.dark);
      for(let i=0;i<6;i++) for(const side of [-1,1]) {
        box([S*.05,S*.11,S*.035],[(i-2.5)*S*.115,side*S*.38,-S*.04],colors.gold);
        cyl(S*.021,S*.19,[(i-2.5)*S*.115,side*S*.38,S*.06],colors.gold);
      }
      for(const x of [-S*.39,S*.39]) for(const y of [-S*.22,S*.22]) {
        cyl(S*.063,S*.012,[x,y,-S*.058],colors.gold);
        cyl(S*.039,S*.015,[x,y,-S*.057],colors.dark,undefined,'rubber');
      }
      for(const x of [-S*.29,S*.29]) box([S*.09,S*.14,S*.07],[x,0,-S*.025],colors.alloy);
    } else if (c.type === 'encoder') {
      const R=positive(p.bodyR,.02),H=positive(p.bodyH,.03),SR=positive(p.shaftR,.004),SH=positive(p.shaftH,.04);
      cyl(R,H*.8,[0,0,0],colors.alloy);
      cyl(R*.98,H*.14,[0,0,-H*.43],colors.dark);
      cyl(R,H*.12,[0,0,H*.44],colors.gold);
      cyl(R*.44,H*.15,[0,0,H*.48],colors.steel);
      cyl(SR,SH,[0,0,H/2+SH/2],colors.alloy);
      for(let i=0;i<3;i++){const a=i*2*PI/3;bolt([R*.72*Math.cos(a),R*.72*Math.sin(a),H*.505],R*.07);}
      box([R*.65,R*.3,H*.26],[0,R*.85,-H*.1],colors.dark);
    }
    if (Number.isInteger(c.color) && c.color >= 0 && c.color <= 0xffffff) {
      const primary = mainColor(c);
      out.forEach(part => { if (part.color === primary) part.color = c.color; });
    }
    return out;
  }

  function mesh(c, THREE, specs=parts(c)) {
    if (!specs.length) return null;
    const group=new THREE.Group(), materials=new Map();
    for(const part of specs) {
      const key=[part.color,part.roughness,part.metalness].join(':');
      if(!materials.has(key)) {
        const mat=new THREE.MeshStandardMaterial({color:part.color,roughness:part.roughness,metalness:part.metalness});
        mat.color.convertSRGBToLinear(); materials.set(key,mat);
      }
      let geo;
      if(part.shape==='box') geo=new THREE.BoxGeometry(part.size[1],part.size[2],part.size[0]);
      else if(part.shape==='barrel') {
        const points=[];
        for(let i=0;i<=16;i++) {const t=i/16*2-1;points.push(new THREE.Vector2(part.radius*Math.sqrt(Math.max(0,1-t*t)),t*part.length/2));}
        geo=new THREE.LatheGeometry(points,16);
      } else geo=new THREE.CylinderGeometry(part.radius,part.radius,part.length,part.detail==='bolt'||part.detail==='socket'?6:32);
      const object=new THREE.Mesh(geo,materials.get(key));
      object.position.set(part.xyz[1],part.xyz[2],part.xyz[0]);
      // ROS URDF fixed-axis RPY = Rz(yaw) Ry(pitch) Rx(roll).
      const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rpy,'ZYX'));
      object.quaternion.set(q.y,q.z,q.x,q.w);
      object.userData.compId=c.id;object.userData.detail=part.detail;
      object.castShadow=true;object.receiveShadow=true;group.add(object);
    }
    // Merge the static detail by material, keeping one pickable group per
    // component. Hundreds of bolts/rollers then cost only a few draw calls.
    const batches=new Map();
    for(const object of group.children) {
      object.updateMatrix();
      const geo=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();
      geo.applyMatrix4(object.matrix);
      if(!batches.has(object.material))batches.set(object.material,[]);
      batches.get(object.material).push(geo);
      object.geometry.dispose();
    }
    group.clear();
    for(const [material,geometries] of batches) {
      const count=geometries.reduce((n,g)=>n+g.attributes.position.count,0);
      const positions=new Float32Array(count*3),normals=new Float32Array(count*3);let offset=0;
      for(const geo of geometries) {
        positions.set(geo.attributes.position.array,offset);normals.set(geo.attributes.normal.array,offset);
        offset+=geo.attributes.position.array.length;geo.dispose();
      }
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('normal',new THREE.BufferAttribute(normals,3));
      const object=new THREE.Mesh(geo,material);object.userData.compId=c.id;object.castShadow=true;object.receiveShadow=true;group.add(object);
    }
    group.userData.compId=c.id;
    c._mat=group.children[0].material;
    return group;
  }

  // URDF visual geometry uses the same poses, dimensions and material palette.
  // Rounded rubber rollers are represented by short cylinder sections because
  // standard URDF has no barrel primitive. Collision stays a simple envelope.
  function urdf(c, specs=parts(c)) {
    if(!specs.length)return null;
    let visualIndex=0;
    const n=v=>Number(v).toFixed(6),vec=v=>v.map(n).join(' ');
    const visual=(part,xyz=part.xyz,radius=part.radius,length=part.length)=>{
      // Legacy standard wheel TF has an extra roll=90deg. Transform the
      // visuals back into that frame so existing exported wheel TF stays valid.
      let pos=xyz,rpy=part.rpy;
      if(c.type==='wheel') {
        pos=[xyz[0],xyz[2],-xyz[1]];
        // Wheel details only use Ry(a), identity or Rx(pi/2).
        rpy=part.rpy[0]===PI/2?[0,0,0]:[-PI/2,0,-part.rpy[1]];
      }
      const geo=part.shape==='box'?`<box size="${vec(part.size)}"/>`:`<cylinder radius="${n(radius)}" length="${n(length)}"/>`;
      const rgb=[(part.color>>16)&255,(part.color>>8)&255,part.color&255].map(v=>n(v/255)).join(' ');
      // A standard URDF visual name preserves wheel identity after renaming a link.
      const wheelName=visualIndex++===0&&(c.type==='wheel'||c.type==='omni')
        ? ` name="roside_wheel_${wheelStyle(c)}_${n(positive(c.params?.radius,.09))}_${handedness(c)}"` : '';
      return `    <visual${wheelName}><origin xyz="${vec(pos)}" rpy="${vec(rpy)}"/><geometry>${geo}</geometry><material name="hardware_${part.color.toString(16)}"><color rgba="${rgb} 1"/></material></visual>\n`;
    };
    return specs.map(part=>{
      if(part.shape!=='barrel') return visual(part);
      const [r,p,y]=part.rpy,dir=[Math.cos(y)*Math.sin(p)*Math.cos(r)+Math.sin(y)*Math.sin(r),Math.sin(y)*Math.sin(p)*Math.cos(r)-Math.cos(y)*Math.sin(r),Math.cos(p)*Math.cos(r)];
      return Array.from({length:9},(_,i)=>{
        const t=(i+.5)/9*2-1,xyz=part.xyz.map((v,k)=>v+dir[k]*t*part.length/2);
        return visual(part,xyz,part.radius*Math.sqrt(1-t*t),part.length/9);
      }).join('');
    }).join('');
  }
  const api={parts,mesh,urdf,wheelStyle,handedness,mainColor};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.RobotVisuals=api;
})(typeof globalThis!=='undefined'?globalThis:this);
