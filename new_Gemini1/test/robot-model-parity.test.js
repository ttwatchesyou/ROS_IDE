'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const THREE=require('three'),RobotVisuals=require('../public/robot-visuals'),RobotAccessories=require('../public/robot-accessories'),RobotModelAssets=require('../public/robot-model-assets');
function builder(sim=false) {
  const storage=new Map(),calls=[],nodes=new Map();
  const c={THREE,RobotVisuals,RobotAccessories,RobotModelAssets,isSimWorkspace:sim,sessionId:'model-test',wsPath:'~/robot_ws',
    window:{addEventListener(){},confirm:()=>true},document:{getElementById:id=>nodes.get(id)||null,querySelectorAll:()=>[]},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    API:async(path,body)=>{calls.push({path,body});return {ok:true};},
    sbMsg(){},escH:String,encArg:encodeURIComponent,setTimeout(){},requestAnimationFrame(){},TextEncoder,console};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/transformation'),'utf8')+'\nglobalThis.state=tf;globalThis.presets=TF_COMPONENT_PRESETS;',c);
  c.tfAddComp('base');return {c,storage,calls,nodes};
}
const near=(a,b,eps=2e-6)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b} (tolerance ${eps})`);
const arr=v=>JSON.parse(JSON.stringify(v));
const attrs=text=>Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
const vector=(text,defaultValue='0 0 0')=>(text||defaultValue).split(/\s+/).map(Number);
function pose(xyz=[0,0,0],rpy=[0,0,0]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...xyz),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rpy,'ZYX')),new THREE.Vector3(1,1,1));
}
function origin(markup){const a=attrs(markup.match(/<origin\b[^>]*\/>/)?.[0]||'');return pose(vector(a.xyz),vector(a.rpy));}
// Independent, small parser for the URDF this builder exports. All math here
// is ROS-native (not TF/Three conversion functions from the application).
function parse(urdf,files) {
  const links=new Map(),joints=new Map();
  for(const m of urdf.matchAll(/<joint\b[^>]*>([\s\S]*?)<\/joint>/g)) {
    const text=m[1],parent=attrs(text.match(/<parent[^>]*\/>/)[0]).link,child=attrs(text.match(/<child[^>]*\/>/)[0]).link;
    joints.set(child,{parent,matrix:origin(text)});
  }
  const world=name=>{const j=joints.get(name);return j?world(j.parent).multiply(j.matrix):new THREE.Matrix4();};
  for(const m of urdf.matchAll(/<link name="([^"]+)">([\s\S]*?)<\/link>/g)) {
    const points=[];
    for(const visual of m[2].matchAll(/<visual\b[^>]*>([\s\S]*?)<\/visual>/g)) {
      const text=visual[1],geometry=text.match(/<geometry>([\s\S]*?)<\/geometry>/)[1],shape=geometry.match(/<(box|cylinder|sphere|mesh)\b([^>]*)/),a=attrs(shape[2]);
      const matrix=world(m[1]).multiply(origin(text));let geo;
      if(shape[1]==='box')geo=new THREE.BoxGeometry(...vector(a.size));
      else if(shape[1]==='cylinder'){geo=new THREE.CylinderGeometry(+a.radius,+a.radius,+a.length,32);geo.rotateX(Math.PI/2);}
      else if(shape[1]==='sphere')geo=new THREE.SphereGeometry(+a.radius,24,16);
      else {
        const name=a.filename.replace('package://sim_robot_tf/',''),data=files[name];assert.ok(data,'asset exists: '+name);
        for(const v of data.matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g))points.push(new THREE.Vector3(...v.slice(1).map(Number)).applyMatrix4(matrix));
        continue;
      }
      for(let i=0;i<geo.attributes.position.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(geo.attributes.position,i).applyMatrix4(matrix));geo.dispose();
    }
    links.set(m[1],new THREE.Box3().setFromPoints(points));
  }
  return links;
}
function displayed(c,component) {
  const root=new THREE.Group(),chain=[];let p=component;
  while(p){chain.unshift(p);p=c.state.comps.find(x=>x.name===p.parent);}
  let group=root;
  for(const item of chain){const next=new THREE.Group();next.position.set(item.pos.y,item.pos.z,item.pos.x);next.quaternion.copy(c.tfRosToQuat(item.rpy.r,item.rpy.p,item.rpy.y));group.add(next);group=next;}
  group.add(c.tfBuildMesh({...component}));root.updateMatrixWorld(true);
  const points=[];root.traverse(o=>{if(!o.isMesh)return;const a=o.geometry.attributes.position;for(let i=0;i<a.count;i++){const v=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld);points.push(new THREE.Vector3(v.z,v.x,v.y));}});
  RobotModelAssets.dispose(root);return new THREE.Box3().setFromPoints(points);
}
function assertParity(c,eps=2e-4) {
  const urdf=c.tfBuildURDF(),parsed=parse(urdf,c.state._exportMeshFiles);
  assert.doesNotMatch(urdf,/NaN|Infinity|undefined|<cone/);
  for(const part of c.state.comps) {
    const actual=displayed(c,part),expected=parsed.get(part.name),tolerance=part.type==='omni'?Math.max(eps,part.params.radius*.03):eps;
    for(const edge of ['min','max'])for(const axis of ['x','y','z']) {
      assert.ok(Math.abs(actual[edge][axis]-expected[edge][axis])<tolerance,`${part.name}: ${edge}.${axis}, TF ${actual[edge][axis]}, URDF ${expected[edge][axis]}`);
    }
  }
  return urdf;
}
test('all built-in TF object types, all accessory presets, nested rotations and saved URDF have the same ROS bounds',()=>{
  const {c}=builder();
  for(const type of ['box','cylinder','wheel','omni','mecanum','lidar','camera','imu','encoder'])c.tfAddComp(type);
  for(const preset of c.presets)c.tfAddPreset(preset.id);
  c.state.comps.slice(1).forEach((p,i)=>{p.pos={x:i*.05,y:(i%3)*.11,z:.42};p.rpy={r:13,p:-21,y:37};});
  const box=c.state.comps.find(p=>p.type==='box');box.params={sx:.28,sy:.09,sz:.055};
  c.state.comps.find(p=>p.type==='camera').parent=c.state.comps.find(p=>p.type==='wheel').name;
  assertParity(c);
  const model=c.tfBuildModelJSON(),original=c.tfBuildURDF();c.tfApplyComps(JSON.parse(model));
  assert.equal(c.tfBuildURDF(),original);assert.equal(c.tfBuildModelJSON(),model);assertParity(c);
});
test('non-square boxes and scale handles follow ROS XYZ in BOTH Sim and real workspaces',()=>{
  for(const sim of [false,true]){
    const {c}=builder(sim),box=c.tfCreateComp('box');box.params={sx:.28,sy:.09,sz:.055};
    const mesh=c.tfBuildMesh(box),size=new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    near(size.x,.09);near(size.y,.055);near(size.z,.28);
    const resized=c.tfApplyScale(box,{x:2,y:3,z:4});near(resized.sx,1.12);near(resized.sy,.18);near(resized.sz,.165);
    RobotModelAssets.dispose(mesh);
  }
});
test('all robot templates preserve geometry and fit the existing package-save request budget',()=>{
  const {c}=builder();
  for(const id of ['differential','skid','omni3','omni4','mecanum','mecanum_xy','rover6','arm6','humanoid','quadruped']){
    c.tfApplyRobotTemplate(id);const urdf=assertParity(c,3e-4);
    const payload=JSON.stringify({'urdf/robot.urdf':urdf,'tf_model.json':c.tfBuildModelJSON(),...c.state._exportMeshFiles});
    assert.ok(Buffer.byteLength(payload)<9*1024*1024,id+' fits 10 MB request including other scaffolding');
  }
});
test('eight real accessories retain recognizable details, color and identity after rename/copy/save',()=>{
  const {c}=builder();
  for(const [kind,color] of Object.entries(RobotAccessories.defaults)){
    c.tfAddPreset(kind);const part=c.state.comps.at(-1);assert.equal(part.params.accessory,kind);
    const specs=RobotAccessories.parts(part);assert.ok(specs.length>=7,kind+' is detailed');assert.ok(specs.some(p=>p.color===color));
    part.name='my_'+kind;assert.equal(RobotAccessories.kind(part),kind);part.color=0;assert.ok(RobotAccessories.parts(part).some(p=>p.color===0));
    const mesh=RobotVisuals.mesh(part,THREE,specs);assert.equal(new Set(mesh.children.map(m=>m.material)).size<=14,true,kind+' remains batched by material');RobotModelAssets.dispose(mesh);
  }
  const json=c.tfBuildModelJSON();c.tfApplyComps(JSON.parse(json));assert.equal(c.tfBuildModelJSON(),json);
  assert.ok(RobotAccessories.kind({name:'battery_2_copy_1',type:'box',params:{}})==='battery');
  assert.equal(RobotAccessories.kind({name:'battery_2',type:'custom',params:{}}),'');
  assert.equal(RobotAccessories.kind({name:'my_battery',type:'box',params:{}}),'');
});
test('custom primitives, composite colors, CAD, scale and bevels export their actual mesh and survive an empty browser library',()=>{
  const {c}=builder();
  const make=(shape,params,extra={})=>{
    const def={id:shape,name:shape+'_sensor',shape,params,color:0x123456,offset:{pos:{x:.2,y:.1,z:.4},rpy:{r:17,p:34,y:51}},...extra};
    c.state.userComps.push(def);c.tfAddCustomComp(def.id);
  };
  for(const shape of ['box','cylinder','sphere','cone','lidar','camera'])make(shape,{sx:.23,sy:.075,sz:.035,radius:.043,height:.071,w:.13,d:.04,h:.055});
  const triangles={pos:[0,0,0,.1,0,0,0,.2,0,0,0,0,0,0,.3,.1,0,0],nor:[],groups:[{start:0,count:3,color:0xff0000},{start:3,count:3,color:0x00ff00}]};
  make('cad',{}, {mesh:triangles,bbox:[.1,.2,.3]});
  make('composite',{}, {parts:[
    {shape:'box',params:{sx:.22,sy:.08,sz:.03},color:0,pos:{x:.025,y:-.03,z:.04},rpy:{r:12,p:34,y:56}},
    {shape:'cone',params:{radius:.024,height:.09},color:0xc15f37,pos:{x:.12,y:.07,z:.08},rpy:{r:-90,p:20,y:27}},
    {shape:'camera',params:{w:.08,d:.045,h:.03},color:0x204080,pos:{x:.17,y:.03,z:.08},rpy:{r:0,p:0,y:-90}},
  ]});
  const part=c.state.comps.at(-1);part.params=c.tfApplyScale(part,{x:2,y:.8,z:1.5});
  c.tfAddComp('box');Object.assign(c.state.comps.at(-1).params,{sx:.22,sy:.08,sz:.04,bevel:.008});
  const urdf=assertParity(c),saved=c.tfBuildModelJSON();assert.match(urdf,/<color rgba="0 0 0 1"/);
  assert.match(c.tfPkgSetupPy(),/glob\('meshes\/\*\.stl'\)/);assert.ok(Object.keys(c.state._exportMeshFiles).length>=10);
  const fresh=builder().c;fresh.tfApplyComps(JSON.parse(saved));assert.equal(fresh.state.userComps.length,0);
  assert.equal(fresh.tfBuildURDF(),urdf);assert.equal(fresh.tfBuildModelJSON(),saved);assertParity(fresh);
  const xml=spawnSync('python3',['-c','import sys,xml.etree.ElementTree as E; E.fromstring(sys.stdin.read())'],{input:urdf,encoding:'utf8'});assert.equal(xml.status,0,xml.stderr);
});
test('Save writes all visual assets and editable definitions through the existing package action, never exec/build/motion',async()=>{
  const {c,calls}=builder();
  c.state.userComps=[{id:'test',name:'cone_sensor',shape:'cone',params:{radius:.045,height:.1},color:0x112233,offset:{pos:{x:0,y:0,z:.2},rpy:{r:0,p:0,y:0}}}];c.tfAddCustomComp('test');
  await c.tfSaveToWorkspace();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/sim/save-tf-package');
  const files=calls[0].body.files;assert.ok(Object.keys(files).some(k=>k.startsWith('meshes/')));
  assert.match(files['setup.py'],/meshes/);assert.ok(JSON.parse(files['tf_model.json']).find(p=>p.type==='custom').customDef);
  for(const match of files['urdf/robot.urdf'].matchAll(/filename="package:\/\/sim_robot_tf\/([^"]+)"/g))assert.ok(files[match[1]]);
});
test('standalone URDF mesh ZIP is valid and its generated Python parses; textured geometry is never silently lost',()=>{
  const {c}=builder();c.tfAddComp('box');c.state.comps.at(-1).params.bevel=.02;
  const files={'sim_robot_tf/urdf/robot.urdf':c.tfBuildURDF(),'sim_robot_tf/setup.py':c.tfPkgSetupPy(),
    'sim_robot_tf/sim_robot_tf/tf.py':c.tfTfPy(),...Object.fromEntries(Object.entries(c.state._exportMeshFiles).map(([name,data])=>['sim_robot_tf/'+name,data]))};
  const bytes=RobotModelAssets.zip(files);
  const result=spawnSync('python3',['-c',`import sys,io,zipfile,ast,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
for name in z.namelist():
 if name.endswith('.py'): ast.parse(z.read(name))
 if name.endswith('.urdf'): E.fromstring(z.read(name))
assert any(name.endswith('.stl') for name in z.namelist())`],{input:Buffer.from(bytes),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const textured=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({map:new THREE.Texture()}));
  assert.throws(()=>RobotModelAssets.fromMesh(textured,THREE),/Texture/);RobotModelAssets.dispose(textured);
});
test('an invalid visual export reports the issue and cannot be downloaded; non-visual TF exports still work',()=>{
  const {c,nodes}=builder(),textarea={value:''};nodes.set('tf-export-text',textarea);
  const original=c.tfBuildURDF;c.tfBuildURDF=()=>{throw new Error('Texture is not exportable');};
  c.tfSetExportTab('urdf');assert.match(textarea.value,/Texture/);assert.ok(c.state.exportError);
  // These would attempt browser clipboard/download APIs if not blocked.
  assert.doesNotThrow(()=>c.tfDownloadExport());assert.doesNotThrow(()=>c.tfCopyExport());
  c.tfSetExportTab('json');assert.equal(c.state.exportError,'');assert.ok(JSON.parse(textarea.value).frames);
  c.tfBuildURDF=original;c.tfSetExportTab('urdf');assert.equal(c.state.exportError,'');assert.match(textarea.value,/<robot/);
});
test('SIM exports the refreshed accessories using its existing primitive URDF/package format',()=>{
  const {c}=builder(true);c.tfAddPreset('battery');const box=c.state.comps.at(-1);
  assert.equal(box.params.accessory,'battery');assert.ok(c.tfAccessoryParts(box).length>40);
  assert.equal(c.tfBuildMesh(box).type,'Group');
  const urdf=c.tfBuildURDF();assert.doesNotMatch(urdf,/package:\/\/sim_robot_tf\/meshes/);
  assert.equal(Object.keys(c.state._exportMeshFiles).length,0);assert.doesNotMatch(c.tfPkgSetupPy(),/meshes/);
  assert.doesNotMatch(c.tfBuildModelJSON(),/customDef/);
  c.tfSetView('front');assert.equal(c.tfRealGeometry(),false);
});
test('SIM fixes the reported 90-degree box error for all accessory models and standalone/composite boxes',()=>{
  const {c}=builder(true);for(const kind of Object.keys(RobotAccessories.defaults))c.tfAddPreset(kind);
  for(const type of ['cylinder','wheel','omni','mecanum','lidar','camera','imu','encoder'])c.tfAddComp(type);
  c.tfAddComp('box');c.state.comps.at(-1).params={sx:.31,sy:.12,sz:.06};
  c.state.userComps=[{id:'custom_box',name:'custom_box',shape:'box',color:0x123456,params:{sx:.19,sy:.07,sz:.04},offset:{pos:{x:.1,y:.2,z:.4},rpy:{r:10,p:20,y:37}}},
    {id:'custom_stack',name:'custom_stack',shape:'composite',color:0x123456,params:{},offset:{pos:{x:-.1,y:.2,z:.4},rpy:{r:0,p:0,y:25}},parts:[{shape:'box',color:0x123456,params:{sx:.17,sy:.05,sz:.03},pos:{x:.05,y:0,z:.02},rpy:{r:15,p:25,y:45}}]}];
  c.tfAddCustomComp('custom_box');c.tfAddCustomComp('custom_stack');
  c.state.comps.slice(1).forEach((p,i)=>{p.pos.x+=i*.1;p.rpy={r:13,p:21,y:-37};});
  // Sim retains its existing millimetre TF-origin serialization. Compare
  // geometry within that precision, without changing the motion generators.
  const original=assertParity(c,.0007),model=c.tfBuildModelJSON();c.tfApplyComps(JSON.parse(model));assert.equal(c.tfBuildURDF(),original);
  assertParity(c,.0007);
});
test('accessory details remain inside the configured envelope, with readable battery labels on both sides',()=>{
  const {c}=builder(true);
  for(const preset of c.presets.filter(p=>Object.hasOwn(RobotAccessories.defaults,p.id))){
    c.tfAddPreset(preset.id);const part=c.state.comps.at(-1),p=part.params,mesh=c.tfBuildMesh(part);
    const bounds=new THREE.Box3().setFromObject(mesh),limits=part.type==='box'?[p.sy/2,p.sz/2,p.sx/2]:[p.radius,p.height/2,p.radius];
    for(const [i,axis]of ['x','y','z'].entries()){
      assert.ok(bounds.min[axis]>=-limits[i]-1e-6,preset.id+' min '+axis);
      assert.ok(bounds.max[axis]<=limits[i]+1e-6,preset.id+' max '+axis);
    }
    RobotModelAssets.dispose(mesh);
    if(preset.id==='battery'){
      const specs=RobotAccessories.parts(part);
      for(const detail of ['carry-handle','polarity-plus','polarity-minus','terminal','sealed-lid','printed-DC','printed-POWER'])assert.ok(specs.some(s=>s.detail===detail),detail);
      const left=specs.filter(s=>s.detail==='printed-POWER'&&s.xyz[1]>0),right=specs.filter(s=>s.detail==='printed-POWER'&&s.xyz[1]<0);
      assert.equal(left.length,right.length);left.forEach((s,i)=>near(s.xyz[0],-right[i].xyz[0]));
    }
  }
});
test('legacy Sim accessories upgrade appearance once without rotating frames, resizing bodies or overwriting custom colors',()=>{
  const {c}=builder(true);const old={id:'b',type:'box',name:'battery_2_copy_1',parent:'base_link',pos:{x:.25,y:.1,z:.34},rpy:{r:0,p:0,y:45},params:{sx:.22,sy:.15,sz:.085},color:0x536b46};
  c.tfApplyComps([JSON.parse(c.tfBuildModelJSON())[0],old]);const b=c.state.comps[1];
  assert.deepEqual(arr(b.pos),old.pos);assert.deepEqual(arr(b.rpy),old.rpy);assert.equal(b.params.sx,.22);assert.equal(b.params.accessoryRevision,2);assert.equal(b.color,RobotAccessories.defaults.battery);
  b.name='my_power_unit';b.color=0x536b46;const saved=c.tfBuildModelJSON();c.tfApplyComps(JSON.parse(saved));assert.equal(c.tfBuildModelJSON(),saved,'explicit colours remain editable after the upgrade');
  const colored={...old,name:'battery_7',params:{...old.params},color:0xa73550};RobotAccessories.upgrade(colored);assert.equal(colored.color,0xa73550);
  const generic={...old,name:'box_1',params:{...old.params}};assert.equal(RobotAccessories.upgrade(generic),false);
});
test('SIM TF package remains stable while ODOM scan uses the selected LiDAR frame',()=>{
  const {c}=builder(true);c.tfApplyRobotTemplate('differential');for(const id of ['battery','controller','motor_housing'])c.tfAddPreset(id);
  const updatedOdom=c.tfOdomPackageFiles();
  // wheel_odom embeds the URDF as data, so its appearance is expected to
  // change. Reconstruct the old visual input for the frozen baseline hash.
  c.tfAccessoryParts=()=>[];
  const oldColors={battery:0x536b46,controller:0x327eab,motor_housing:0x909ca7};
  c.state.comps.forEach(part=>{if(Object.hasOwn(oldColors,part.params.accessory))part.color=oldColors[part.params.accessory];});
  const hashes={tfBuildSTP:'47c8c77398fa4f6491a67ce05dce78e039788d4db804e9f2da33643b0221cd64',tfTfPy:'4dcefa7533877352910210923769e54d69bcf4d72fe187cbce8a33460cdf0c09',tfBuildJSON:'c4cc25bf38d7ef7c0bcb3717f84d9a9f7ba4c6ad8de52180eb1967e55c3c16d3',tfPkgSetupPy:'373e33b88a2501b4579fe13e6b3f7ccacd016aa1184821ebc22f3756b46864fc'};
  for(const [fn,hash]of Object.entries(hashes)){const data=c[fn]();assert.equal(require('node:crypto').createHash('sha256').update(typeof data==='string'?data:JSON.stringify(data)).digest('hex'),hash,fn);}
  assert.match(updatedOdom['sim_robot_odom/wheel_odom.py']||Object.values(updatedOdom).find(text=>text.includes('LASER_FRAME')), /LASER_FRAME = /);
  const withoutVisual=data=>data.replace(/URDF = r'''[\s\S]*?'''/,"URDF = r'''<visual-model/>'''");
  for(const [file,data]of Object.entries(c.tfOdomPackageFiles()))assert.equal(withoutVisual(updatedOdom[file]),withoutVisual(data),file+' only changes its embedded visual data');
});
test('nested LiDAR TF controls scan origin and full orientation in generated Sim node',()=>{
  const {c}=builder(true);
  const base=JSON.parse(c.tfBuildModelJSON()).find(part=>part.type==='base');
  const mount={id:'mount',type:'box',name:'sensor_mount',parent:base.name,pos:{x:1,y:0,z:.2},rpy:{r:0,p:0,y:90},params:{sx:.1,sy:.1,sz:.1}};
  const lidar={id:'sensor',type:'lidar',name:'front_scan',parent:'sensor_mount',pos:{x:.2,y:0,z:.3},rpy:{r:30,p:20,y:10},params:{radius:.05,height:.12}};
  c.tfApplyComps([base,mount,lidar]);
  const pose=c.tfLidarPoseInBase();
  assert.equal(pose.frame,'front_scan');
  assert.ok(Math.abs(pose.offset[0]-1)<1e-9);
  assert.ok(Math.abs(pose.offset[1]-.2)<1e-9);
  assert.ok(Math.abs(pose.offset[2]-.5)<1e-9);
  assert.equal(pose.edges.length,2);
  assert.ok(pose.quat.slice(0,3).some(value=>Math.abs(value)>.05));
  const py=c.tfBuildOdomPy();
  assert.match(py,/LASER_FRAME = "front_scan"/);
  assert.match(py,/qrot\(LASER_Q,/);
  assert.match(py,/rayCast\(ox,oy,dx,dy,/);
  assert.equal(require('node:child_process').spawnSync('python3',['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:py,encoding:'utf8'}).status,0);
});
test('generated mesh loader reads only allowlisted real-package assets and drops results after disposal/session switch',async()=>{
  const sample=new THREE.Mesh(new THREE.BoxGeometry(.1,.2,.3),new THREE.MeshBasicMaterial({color:0}));
  const {files}=RobotModelAssets.fromMesh(sample,THREE),name=Object.keys(files)[0];const geo={filename:'package://sim_robot_tf/'+name,scale:[1,1,1]};
  let calls=0,resolve;const read=()=>{calls++;return new Promise(r=>{resolve=r;});};
  const opts={sessionId:'alpha',workspace:'~/custom_ws',read};
  assert.equal(RobotModelAssets.load({...geo,filename:'package://sim_robot_tf/meshes/../../secret.stl'},null,THREE,opts),null);
  assert.equal(RobotModelAssets.load({...geo,filename:'https://foreign.invalid/model.stl'},null,THREE,opts),null);assert.equal(calls,0);
  const a=RobotModelAssets.load(geo,new THREE.MeshBasicMaterial(),THREE,opts),b=RobotModelAssets.load(geo,new THREE.MeshBasicMaterial(),THREE,opts);
  await Promise.resolve();assert.equal(calls,1);a.geometry.dispose();resolve({ok:true,content:files[name]});
  await new Promise(r=>setImmediate(r));assert.equal(a.geometry.attributes.position,undefined);assert.equal(b.userData.modelAssetStatus,'ready');
  const size=new THREE.Box3().setFromObject(b).getSize(new THREE.Vector3());near(size.x,.1);near(size.y,.2);near(size.z,.3);
  assert.throws(()=>RobotModelAssets.parseSTL('solid bad\nvertex NaN 0 0\n',THREE),/Invalid/);
  const stale=RobotModelAssets.load(geo,new THREE.MeshBasicMaterial(),THREE,{...opts,sessionId:'beta',isCurrent:()=>false});
  await Promise.resolve();resolve({ok:true,content:files[name]});await new Promise(r=>setImmediate(r));
  assert.equal(stale.geometry.attributes.position,undefined,'discard old session result');
});
