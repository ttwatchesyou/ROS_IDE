'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const EditorHistory = require('../public/editor-history');

test('history restores independent snapshots, drops a redo branch and bounds memory', () => {
  let data = {objects: []};
  const history = EditorHistory.create({capture: () => data, restore: value => { data = value; }, limit: 2});
  history.reset();
  assert.equal(history.canUndo, false);
  data.objects.push({x: 1}); history.record();
  data.objects[0].x = 2; history.record();
  history.undo(); assert.equal(data.objects[0].x, 1);
  history.undo(); assert.deepEqual(data.objects, []);
  history.redo(); data.objects[0].x = 3; history.record();
  assert.equal(history.canRedo, false);
  data.objects[0].x = 4; history.record();
  data.objects[0].x = 5; history.record();
  history.undo(); history.undo();
  assert.equal(data.objects[0].x, 3);
  assert.equal(history.undo(), false);
});

test('one drag or one field edit is one undo step; no-op actions preserve redo', () => {
  let value = 0;
  const history = EditorHistory.create({capture: () => value, restore: next => { value = next; }});
  history.reset(); history.begin();
  for (let i = 1; i <= 40; i++) { value = i; history.record(); }
  assert.equal(history.canUndo, false);
  history.end(); history.undo(); assert.equal(value, 0);
  history.record(); history.begin(); history.end();
  assert.equal(history.canRedo, true);
  history.redo();
  const input = {};
  value = 41; history.record(input); value = 42; history.record(input);
  history.breakMerge(); value = 43; history.record(input);
  history.undo(); assert.equal(value, 42);
  history.undo(); assert.equal(value, 40);
});

function runtime() {
  const nodes = new Map(), storage = new Map(), listeners = new Map();
  const context = {
    EditorHistory, RobotVisuals: require('../public/robot-visuals'), MapGeometry: require('../public/map-geometry'),
    sessionId: 'history-test', sbMsg() {}, mapStatus() {}, escH: String, encArg: encodeURIComponent,
    window: {confirm: () => true, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }},
    confirm: () => true, requestAnimationFrame() {}, setTimeout, console,
    document: {addEventListener() {}, activeElement: null, getElementById: id => nodes.get(id) || null, querySelectorAll: () => []},
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    THREE: {MathUtils: {degToRad: value => value * Math.PI / 180, radToDeg: value => value * 180 / Math.PI}},
  };
  vm.createContext(context);
  // Use the browser module in this context so its document helpers see the fake DOM.
  const run = source => vm.runInContext(source, context);
  const load = name => run(fs.readFileSync(require.resolve('../public/' + name), 'utf8'));
  load('editor-history.js'); load('transformation.js'); load('map.js'); load('map3d.js');
  run('globalThis.robot = tf; globalThis.room = mapData; globalThis.mapState = map3d;');
  for (const id of ['tf-undo', 'tf-redo', 'map3d-undo', 'map3d-redo']) nodes.set(id, {disabled: true});
  // Only replace rendering; mutations, persistence and history run unchanged.
  context.map3dRenderAll = () => {};
  context.map3dFocus = () => {};
  context.map3dCloseModal = () => {};
  context.map3dSelect = id => run(`map3d.selectedId = ${JSON.stringify(id)}; map3dHistory?.select();`);
  context.tfAddComp('base'); context.tfInitHistory();
  context.map3dNormalizeData(); context.mapSyncLidarInputs(); context.map3dInitHistory();
  return {c: context, nodes, storage, run, listeners};
}
const plain = value => JSON.parse(JSON.stringify(value));

test('articulated templates preserve joint trees and limits through save, reload and undo, and stay out of SIM',()=>{
  const {c,run}=runtime();c.isSimWorkspace=false;
  for(const [kind,count] of [['arm6',6],['humanoid',14],['quadruped',12]]){
    c.tfApplyRobotTemplate(kind);
    const parts=c.robot.comps,joints=parts.filter(p=>p.joint),names=new Set(parts.map(p=>p.name));
    assert.equal(joints.length,count);assert.equal(names.size,parts.length);
    for(const part of parts){if(part.name==='base_link')continue;assert.ok(names.has(part.parent));let p=part,seen=new Set();while(p.parent){assert.ok(!seen.has(p.name));seen.add(p.name);p=parts.find(o=>o.name===p.parent);assert.ok(p);}}
    for(const part of joints){assert.ok(part.joint.lower<part.joint.upper);assert.ok(part.joint.effort>0);}
    const saved=c.tfBuildModelJSON(),urdf=c.tfBuildURDF();
    assert.equal((urdf.match(/type="revolute"/g)||[]).length,count);
    assert.equal((urdf.match(/<limit /g)||[]).length,count);
    c.tfApplyComps(JSON.parse(saved));assert.equal(c.tfBuildModelJSON(),saved);
    c.tfUndo();c.tfRedo();assert.equal(c.tfBuildModelJSON(),saved);
  }
  c.isSimWorkspace=true;const before=c.tfBuildModelJSON();
  c.tfApplyRobotTemplate('arm6');c.tfAddPreset('servo_joint');assert.equal(c.tfBuildModelJSON(),before);
  c.tfApplyRobotTemplate('differential');assert.doesNotMatch(c.tfBuildURDF(),/type="revolute"/);
});

test('robot add, delete, empty model and template replacement undo and redo with ODOM', () => {
  const {c, nodes, storage} = runtime();
  const base = c.tfBuildModelJSON();
  c.tfAddComp('lidar'); const lidar = c.robot.selected;
  assert.equal(nodes.get('tf-undo').disabled, false);
  c.tfUndo(); assert.equal(c.tfBuildModelJSON(), base);
  assert.equal(nodes.get('tf-redo').disabled, false);
  c.tfRedo(); assert.equal(c.robot.selected, lidar);
  c.tfDeleteComp(lidar); c.tfUndo(); assert.equal(c.robot.selected, lidar);
  c.tfUndo(); c.tfDeleteComp(c.robot.comps[0].id);
  assert.equal(c.robot.comps.length, 0);
  c.tfUndo(); assert.equal(c.tfBuildModelJSON(), base);
  c.tfRedo(); assert.equal(c.robot.comps.length, 0);
  c.tfUndo(); c.tfApplyRobotTemplate('mecanum');
  const template = c.tfBuildModelJSON();
  assert.equal(c.robot.odom.pattern, 'mecanum');
  c.tfUndo(); assert.equal(c.tfBuildModelJSON(), base);
  c.tfRedo(); assert.equal(c.tfBuildModelJSON(), template);
  assert.equal(c.robot.odom.pattern, 'mecanum');
  assert.equal(JSON.parse(storage.get('tf_odom_history-test')).pattern, 'mecanum');
  assert.deepEqual(JSON.parse(storage.get('tf_model_history-test')), JSON.parse(template));
});

test('robot properties and dragging restore dimensions, transforms, IDs and button state', () => {
  const {c, nodes, run} = runtime();
  c.tfAddWheelSet(4); const original = c.tfBuildModelJSON();
  run('tfHistory.begin()');
  c.robot.comps[1].pos.x = 4;
  c.robot.comps[1].rpy.y = 45;
  c.robot.comps[1].params.radius = .3;
  c.tfSave(); run('tfHistory.end()');
  c.tfUndo(); assert.equal(c.tfBuildModelJSON(), original);
  c.tfRedo(); assert.equal(c.robot.comps[1].params.radius, .3);
  c.tfUndo(); c.tfAddComp('camera');
  assert.equal(new Set(c.robot.comps.map(p => p.id)).size, c.robot.comps.length);
  assert.equal(nodes.get('tf-redo').disabled, true);
});

test('room template, door openings, floor zones, room size and start pose survive history', () => {
  const {c, nodes, storage} = runtime();
  const initial = plain(c.room);
  c.map3dUseTemplate('living-dining'); const template = plain(c.room);
  c.map3dUndo(); assert.deepEqual(plain(c.room), initial);
  c.map3dRedo(); assert.deepEqual(plain(c.room), template);
  c.map3dChangeFloor('concrete'); c.map3dUndo();
  assert.deepEqual(plain(c.room.floorZones), template.floorZones);
  nodes.set('map3d-room-w', {value: '5'}); nodes.set('map3d-room-d', {value: '4'});
  c.map3dApplyRoom(); c.map3dUndo(); assert.deepEqual(plain(c.room), template);
  const door = c.room.objects.find(o => o.type === 'door'); c.map3dSelect(door.id);
  nodes.set('map3d-door-angle', {value: '35'}); nodes.set('map3d-door-hinge', {value: 'right'});
  c.map3dApplyDoor(); const edited = plain(c.room);
  c.map3dUndo(); assert.deepEqual(plain(c.room), template);
  c.map3dRedo(); assert.deepEqual(plain(c.room), edited);
  assert.deepEqual(JSON.parse(storage.get('map_history-test')), edited);
});

test('room LiDAR settings and grouped object movement have independent history from robot', () => {
  const {c, nodes, run} = runtime();
  nodes.set('map-lidar-brand', {value: 'slamtec'});
  nodes.set('map-lidar-model', {value: ''});
  c.mapLidarBrandChanged();
  nodes.get('map-lidar-model').value = 'rplidar_a1m8'; c.mapLidarModelChanged();
  c.map3dUndo(); assert.equal(c.room.lidar.model, '');
  c.map3dRedo(); assert.equal(c.room.lidar.model, 'rplidar_a1m8');
  c.map3dAdd('wall'); const wall = c.room.objects.find(o => o.type === 'wall');
  const x = wall.x;
  run('map3dHistory.begin()');
  for (let i = 0; i < 10; i++) { wall.x = i; c.map3dChanged(); }
  run('map3dHistory.end()');
  c.map3dUndo(); assert.equal(c.room.objects.find(o => o.id === wall.id).x, x);
  c.map3dRedo(); assert.equal(c.room.objects.find(o => o.id === wall.id).x, 9);
  c.map3dDeleteSelected(); c.map3dUndo(); assert.ok(c.room.objects.some(o => o.id === wall.id));
  assert.equal(nodes.get('tf-undo').disabled, true);
  c.tfAddComp('camera'); const room = plain(c.room); c.tfUndo(); assert.deepEqual(plain(c.room), room);
});

test('shortcuts act only on the visible editor and preserve native field editing', () => {
  const {c, nodes, listeners} = runtime();
  let active = 'transformation';
  for (const name of ['transformation', 'map']) nodes.set('page-' + name, {classList: {contains: () => active === name}});
  const key = (key, extra = {}) => {
    const e = {key, ctrlKey: true, target: {matches: () => false}, preventDefault() { this.defaultPrevented = true; }, ...extra};
    for (const listener of listeners.get('keydown')) listener(e);
    return e;
  };
  c.tfAddComp('camera');
  assert.equal(key('z', {target: {matches: () => true}}).defaultPrevented, undefined);
  assert.equal(key('z', {target: {isContentEditable: true}}).defaultPrevented, undefined);
  assert.equal(c.robot.comps.length, 2);
  key('z'); assert.equal(c.robot.comps.length, 1);
  key('z', {shiftKey: true}); assert.equal(c.robot.comps.length, 2);
  active = 'map'; key('z'); assert.equal(c.robot.comps.length, 2);
  active = 'transformation'; key('z', {ctrlKey: false, metaKey: true});
  key('y'); assert.equal(c.robot.comps.length, 2);
});

test('robot locks persist in both model formats, restore through history and block deletion of ancestors', () => {
  const {c, storage} = runtime();
  const baseId = c.robot.comps[0].id;
  c.tfAddComp('lidar'); const lidarId = c.robot.selected;
  c.tfToggleLock();
  assert.equal(c.robot.comps.find(p => p.id === lidarId).locked, true);
  assert.equal(JSON.parse(c.tfBuildModelJSON()).find(p => p.id === lidarId).locked, true);
  assert.equal(JSON.parse(storage.get('tf_model_history-test')).find(p => p.id === lidarId).locked, true);
  c.tfDeleteComp(lidarId); c.tfDeleteComp(baseId);
  assert.equal(c.robot.comps.length, 2);
  c.tfUndo(); assert.equal(c.robot.comps.find(p => p.id === lidarId).locked, false);
  c.tfRedo(); assert.equal(c.robot.comps.find(p => p.id === lidarId).locked, true);
  c.tfLoad(); assert.equal(c.robot.comps.find(p => p.id === lidarId).locked, true);
  c.tfToggleLock(lidarId); c.tfToggleLock(baseId);
  assert.equal(c.tfEditBlocker(c.robot.comps.find(p => p.id === lidarId)), undefined, 'a locked parent still permits editing its unlocked children');
  c.tfToggleLock(baseId); c.tfDeleteComp(baseId);
  assert.equal(c.robot.comps.length, 0);
});

test('room locks block edits, deletion and stale gizmo events while allowing windows on a locked wall', () => {
  const {c, storage} = runtime();
  c.map3dUseTemplate('empty-room');
  const window = c.room.objects.find(o => o.type === 'window'), wall = c.room.objects.find(o => o.id === window.wallId);
  c.map3dSelect(wall.id); c.map3dToggleLock(); const before = plain(wall);
  const position = {x:99,y:99,z:99,set(x,y,z){Object.assign(this,{x,y,z});}};
  c.mapState.roots.set(wall.id, {position, rotation:{y:2}});
  c.map3dTransformChanged(); c.map3dApplyProps(); c.map3dDeleteSelected();
  assert.deepEqual(plain(c.room.objects.find(o => o.id === wall.id)), before);
  assert.equal(position.x, wall.x); assert.equal(position.y, wall.z); assert.equal(position.z, -wall.y);
  assert.equal(c.map3dCanEdit(window), true);
  const oldWindowX = window.x;
  window.x += .5; c.MapGeometry.attach(window, c.room.objects); c.map3dChanged();
  assert.notEqual(window.x, oldWindowX);
  assert.deepEqual(plain(wall), before, 'adjusting a window must not move its locked host wall');
  assert.equal(JSON.parse(storage.get('map_history-test')).objects.find(o => o.id === wall.id).locked, true);
});

test('ray picking prefers an unlocked opening over its locked wall, with locked objects still selectable', () => {
  const {c} = runtime();
  c.map3dUseTemplate('empty-room');
  const opening = c.room.objects.find(o => o.type === 'window'), wall = c.room.objects.find(o => o.id === opening.wallId);
  const wallRoot = {userData:{mapObjectId:wall.id}}, openingRoot = {userData:{mapObjectId:opening.id}};
  wall.locked = true;
  const hits = [{object:{userData:{},parent:wallRoot}}, {object:openingRoot}];
  assert.equal(c.map3dPickRoot(hits), openingRoot);
  assert.equal(c.map3dPickRoot(hits.slice(0,1)), wallRoot);
  opening.locked = true;
  assert.equal(c.map3dPickRoot(hits), wallRoot);
});

test('room lock and unlock choices survive workspace reload, explicit load and undo/redo', async () => {
  const {c} = runtime();
  c.map3dUseTemplate('empty-room');
  const wall = c.room.objects.find(o => o.type === 'wall'), saved = plain(c.room);
  c.map3dSelect(wall.id); c.map3dToggleLock();
  c.map3dUndo(); assert.equal(c.room.objects.find(o => o.id === wall.id).locked, false);
  c.map3dRedo(); assert.equal(c.room.objects.find(o => o.id === wall.id).locked, true);
  c.API = async () => ({ok:true,content:JSON.stringify(saved)});
  assert.equal(await c.map3dAutoLoad(), 'workspace'); c.map3dNormalizeData();
  assert.equal(c.room.objects.find(o => o.id === wall.id).locked, true, 'server map cannot discard a newer local lock');
  const lockedSave = plain(c.room);
  c.map3dSelect(wall.id); c.map3dToggleLock();
  c.API = async () => ({ok:true,content:JSON.stringify(lockedSave)});
  await c.map3dLoad();
  assert.equal(c.room.objects.find(o => o.id === wall.id).locked, false, 'explicit unlock is retained too');
});

test('locked attachments protect their host and shrinking a room cannot relocate a locked robot start', () => {
  const {c,nodes} = runtime();
  c.map3dUseTemplate('empty-room');
  const opening = c.room.objects.find(o => o.type === 'window'), wall = c.room.objects.find(o => o.id === opening.wallId);
  opening.locked = true;
  assert.equal(c.map3dEditBlocker(wall), opening);
  c.map3dSelect(wall.id); c.map3dDeleteSelected();
  assert.ok(c.room.objects.includes(wall));
  const start = c.room.objects.find(o => o.type === 'start'); start.locked = true;
  const before = plain(c.room);
  nodes.set('map3d-room-w', {value:'1'}); nodes.set('map3d-room-d', {value:'1'});
  c.map3dApplyRoom(); assert.deepEqual(plain(c.room), before);
});

test('room clipboard is an independent snapshot, pastes repeatedly without selection and survives undo', () => {
  const {c, storage} = runtime();
  c.map3dAdd('sofa'); const source = c.map3dObject();
  c.map3dChangeColor('#e83f72'); c.map3dCopy();
  c.map3dChangeColor('#000000'); c.map3dDeleteSelected();
  c.map3dSelect(null); c.map3dPaste(); const first = plain(c.map3dObject());
  c.map3dSelect(null); c.map3dPaste(); const second = plain(c.map3dObject());
  assert.equal(first.color, 0xe83f72); assert.equal(second.color, first.color);
  assert.notEqual(first.id, source.id); assert.notEqual(first.id, second.id);
  assert.notEqual(first.name, second.name); assert.ok(second.x > first.x);
  assert.equal(second.colorCustomized, true);
  c.map3dUndo(); assert.ok(!c.room.objects.some(o => o.id === second.id));
  c.map3dRedo(); assert.deepEqual(plain(c.map3dObject()), second);
  assert.deepEqual(JSON.parse(storage.get('map_history-test')).objects.find(o => o.id === second.id), second);
  c.map3dUndo(); c.map3dSelect(null); c.map3dPaste();
  assert.equal(c.map3dObject().color, first.color);
});

test('copied walls retain openings on each new host, and robot start remains unique', () => {
  const {c} = runtime(); c.map3dUseTemplate('empty-room');
  const opening = c.room.objects.find(o => o.type === 'door'), host = c.room.objects.find(o => o.id === opening.wallId);
  c.map3dSelect(host.id); c.map3dCopy();
  for (let i = 0; i < 2; i++) {
    c.map3dSelect(null); c.map3dPaste();
    const wall = c.map3dObject(), door = c.room.objects.find(o => o.wallId === wall.id);
    assert.equal(wall.type, 'wall'); assert.notEqual(wall.id, host.id);
    assert.equal(door.type, 'door'); assert.notEqual(door.id, opening.id);
    assert.equal(door.openAngle, opening.openAngle); assert.equal(door.wallOffset, opening.wallOffset);
  }
  assert.equal(new Set(c.room.objects.map(o => o.id)).size, c.room.objects.length);
  c.map3dSelect(c.room.objects.find(o => o.type === 'start').id);
  assert.equal(c.map3dCopy(), false); c.map3dDuplicate();
  assert.equal(c.room.objects.filter(o => o.type === 'start').length, 1);
});

test('robot cut preserves its branch for paste and can be undone; locked parts cannot be cut', () => {
  const {c}=runtime();c.tfAddComp('lidar');
  const id=c.robot.selected,before=c.tfBuildModelJSON();
  c.tfCut();assert.ok(!c.robot.comps.some(o=>o.id===id));
  c.tfUndo();assert.equal(c.tfBuildModelJSON(),before);
  c.tfPaste();assert.equal(c.robot.comps.length,3);
  const selected=c.robot.comps.find(o=>o.id===c.robot.selected);selected.locked=true;
  const count=c.robot.comps.length;c.tfCut();assert.equal(c.robot.comps.length,count);
});

test('robot clipboard remaps child frames, preserves colors and can paste after removing the source', () => {
  const {c} = runtime();
  const base = c.robot.comps[0]; c.tfAddComp('lidar');
  c.tfChangeColor('#a342ff'); const sensorName = c.robot.comps.find(o => o.id === c.robot.selected).name;
  c.tfSelect(base.id); c.tfCopy(); c.tfDeleteComp(base.id);
  for (let i = 0; i < 2; i++) {
    c.tfSelect(null); c.tfPaste();
    const root = c.robot.comps.find(o => o.id === c.robot.selected);
    const sensor = c.robot.comps.find(o => o.parent === root.name);
    assert.equal(root.parent, ''); assert.notEqual(root.name, base.name);
    assert.ok(sensor.name.startsWith(sensorName + '_copy_')); assert.equal(sensor.color, 0xa342ff);
  }
  assert.equal(new Set(c.robot.comps.map(o => o.id)).size, 4);
  assert.equal(new Set(c.robot.comps.map(o => o.name)).size, 4);
  const saved = c.tfBuildModelJSON(); c.tfUndo(); assert.equal(c.robot.comps.length, 2);
  c.tfRedo(); assert.equal(c.tfBuildModelJSON(), saved);
  c.tfApplyComps(JSON.parse(saved)); assert.equal(c.robot.comps.filter(o => o.color === 0xa342ff).length, 2);
});

test('color editing supports black, protects locked objects and preserves custom legacy colors', () => {
  const {c} = runtime();
  c.tfChangeColor('#000000'); assert.equal(c.robot.comps[0].color, 0);
  c.tfUndo(); assert.equal(c.robot.comps[0].color, undefined);
  c.tfRedo(); assert.equal(c.robot.comps[0].color, 0);
  assert.match(c.tfBuildURDF(), /<material name="hardware_0"><color rgba="0\.0+ 0\.0+ 0\.0+ 1"/);
  c.tfToggleLock(); c.tfChangeColor('#ffffff'); assert.equal(c.robot.comps[0].color, 0);
  c.map3dAdd('plant'); c.map3dChangeColor('#000000');
  assert.equal(c.map3dObject().color, 0); c.map3dToggleLock();
  c.map3dChangeColor('#ffffff'); assert.equal(c.map3dObject().color, 0);
  const restored = c.map3dReadObjects({version:3,objects:[{...plain(c.map3dObject()),color:0x46b978}]});
  assert.equal(restored[0].color, 0x46b978); assert.equal(restored[0].colorCustomized, true);
});

test('clipboard shortcuts preserve text editing and use the active editor clipboard', () => {
  const {c, nodes, listeners} = runtime(); let active = 'map';
  for (const name of ['transformation','map']) nodes.set('page-' + name, {classList:{contains:() => active === name}});
  const key = (key, target = {matches:() => false}) => {
    const e = {key,metaKey:true,target,preventDefault(){this.defaultPrevented=true;}};
    listeners.get('keydown').forEach(listener => listener(e)); return e;
  };
  c.map3dAdd('pallet'); key('c'); c.map3dSelect(null);
  assert.equal(key('v', {matches:() => true}).defaultPrevented, undefined);
  assert.equal(c.room.objects.length, 2); key('v'); key('v');
  assert.equal(c.room.objects.length, 4);
  active = 'transformation'; key('v'); assert.equal(c.robot.comps.length, 1);
  key('c'); c.tfSelect(null); key('v'); assert.equal(c.robot.comps.length, 2);
  assert.equal(c.room.objects.length, 4);
});

test('save keeps the written map when simulation times out and allows retry', async () => {
  const {c,nodes,storage} = runtime(),messages=[];let returned=false;
  c.mapStatus=message=>messages.push(message);c.map3dReturnToWizard=()=>{returned=true;};
  nodes.set('map3d-save',{disabled:false,innerHTML:'Save map'});
  c.map3dAdd('sofa');c.map3dChangeColor('#00ab77');const saved=plain(c.room),requests=[];
  c.API=async(path,body,options)=>{requests.push({path,body});options?.onAccepted?.({saved:true});return path==='/api/sim/run-mapsim'?{ok:false,error:'Timeout'}:{ok:true};};
  assert.equal(await c.map3dSave(),false);
  assert.deepEqual(plain(requests[0].body.map),saved);
  assert.deepEqual(JSON.parse(storage.get('map_history-test')),saved);
  assert.match(messages.at(-1),/บันทึกแผนที่แล้ว.*timeout/);
  assert.equal(returned,false);assert.equal(nodes.get('map3d-save').disabled,false);
  c.API=async()=>({ok:true});assert.equal(await c.map3dSave(),true);assert.equal(returned,true);
});

test('save uses a stable snapshot, blocks overlapping saves and keeps edits made while waiting', async () => {
  const {c} = runtime(),requests=[];let finishWrite,returned=false;
  c.map3dReturnToWizard=()=>{returned=true;};c.map3dAdd('plant');const snapshot=plain(c.room);
  c.API=async(path,body)=>{requests.push({path,body});return new Promise(resolve=>{finishWrite=resolve;});};
  const first=c.map3dSave();assert.equal(await c.map3dSave(),false);assert.equal(requests.length,1);
  c.map3dChangeColor('#cc0000');finishWrite({ok:true});assert.equal(await first,true);
  assert.deepEqual(plain(requests.find(r=>r.path==='/api/sim/run-mapsim').body.map),snapshot);
  assert.equal(requests.some(r=>r.path==='/api/sim/apply-map'),false,'save must not launch a fallback outside the build queue');
  assert.equal(c.map3dObject().color,0xcc0000);assert.equal(returned,false);
});
