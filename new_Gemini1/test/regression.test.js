'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { genMapsimFiles, SIM_STATE_PUB, SimEngine, wsRoot, toAbs } = require('../sim');
const { buildProjectScanScript, parseProjectScanOutput } = require('../project-scanner');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('generated mapsim Python compiles and contains initialized runtime state', () => {
  const source = genMapsimFiles()['sim_robot_mapsim/mapsim.py'];
  const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.read(), 'mapsim.py', 'exec')"], {input:source, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(source, /self\.map_file=/);
  assert.match(source, /self\.x,self\.y,self\.th=/);
  assert.doesNotMatch(source, /len\(w\)>=4/);
});

test('generated state publisher Python compiles', () => {
  const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.read(), 'state_pub.py', 'exec')"], {input:SIM_STATE_PUB, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

test('sim workspace keys cannot escape the sim root', () => {
  const result = wsRoot('../../outside');
  assert.equal(path.dirname(result), path.join(root, 'sim_ws'));
});

test('sim file paths cannot traverse outside their workspace', () => {
  const workspace=path.join(root,'sim_ws','SIM-test');
  assert.equal(toAbs(workspace,'','../../etc/passwd'),workspace);
  assert.equal(toAbs(workspace,'src','../../../outside'),workspace);
});

test('sim engine applies map walls and start pose consistently', () => {
  const eng=new SimEngine('SIM-test',{bounds:[-2,-2,2,2],walls:[[0,-1,0,1]],start:[1,1]});
  try{
    assert.deepEqual([eng.x,eng.y],[1,1]);
    assert.deepEqual(eng.walls,[[0,-1,0,1]]);
    eng.applyMap({bounds:[-3,-3,3,3],walls:[],start:[-1,0]});
    assert.deepEqual([eng.x,eng.y],[-1,0]);
    assert.equal(eng.walls.length,4);
  }finally{eng.destroy();}
});

test('privileged HTTP APIs require authentication', () => {
  const source = read('server.js');
  for (const route of ['exec','dashboard','files/list','files/read','files/write','files/mkdir','files/rename','files/delete']) {
    const escaped=route.replace('/', '\\/');
    assert.match(source, new RegExp(`app\\.post\\('/api/${escaped}',\\s*auth`), route);
  }
});

test('browser WebSockets include the authentication token', () => {
  for (const file of ['public/terminal.js','public/monitor.js','public/robots.html']) {
    const source=read(file);
    assert.match(source, /\['ros2ide',\s*(TOKEN|token)\]/, file);
  }
});

test('sim state publisher initializes exactly three pose fields', () => {
  const source=read('sim.js');
  assert.match(source, /self\.x,self\.y,self\.th=float/);
  assert.doesNotMatch(source, /self\.x,self,y,self\.th/);
});

test('installer and agent have no temporary tunnel URL', () => {
  const installer=read('install.sh'), server=read('server.js');
  assert.match(installer, /__CLOUD_URL__/);
  assert.match(server, /replaceAll\('__CLOUD_URL__'/);
  assert.doesNotMatch(installer+read('agent.js'), /trycloudflare\.com/);
  assert.equal(read('agent.js'),read('agent/agent.js'));
});

test('legacy file paths are encoded before entering inline handlers', () => {
  const source=read('public/app.js');
  assert.doesNotMatch(source, /openFilePath\('\$\{fp/);
  assert.match(source, /openFilePath\(decodeURIComponent\('\$\{encArg\(fp/);
});

test('project scanner detects ROS capabilities and reports evidence files', () => {
  const fixture=fs.mkdtempSync('/tmp/roside-project-scan-');
  const pkg=path.join(fixture,'src','demo_robot');
  fs.mkdirSync(path.join(pkg,'urdf'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.xml'),'<package><name>demo_robot</name></package>');
  fs.writeFileSync(path.join(pkg,'robot_node.py'),[
    'from nav_msgs.msg import Odometry',
    'from tf2_ros import TransformBroadcaster',
    "pub = self.create_publisher(Odometry, '/odom', 10)",
  ].join('\n'));
  fs.writeFileSync(path.join(pkg,'urdf','robot.urdf'),'<robot name="demo"></robot>');
  try {
    const script64=Buffer.from(buildProjectScanScript(fixture)).toString('base64');
    const result=spawnSync('python3',['-c',`import base64;exec(base64.b64decode('${script64}'))`],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const summary=parseProjectScanOutput(result.stdout);
    assert.equal(summary.packageCount,1);
    assert.deepEqual(summary.packages,['demo_robot']);
    for(const id of ['tf','odom','urdf','publisher']) {
      const capability=summary.capabilities.find(item=>item.id===id);
      assert.equal(capability.detected,true,id);
      assert.ok(capability.files.length>0,id);
    }
    assert.equal(summary.capabilities.find(item=>item.id==='lidar').detected,false);
  } finally {
    fs.rmSync(fixture,{recursive:true,force:true});
  }
});

test('dashboard renders project capability cards from backend scan data', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js');
  assert.match(html,/id="project-capabilities-grid"/);
  assert.match(dashboard,/renderProjectCapabilities\(d\.project\)/);
  assert.match(dashboard,/PROJECT_CAPABILITY_META/);
});

test('AGV wizard is separated from runtime status cards', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js');
  const wizard=html.slice(html.indexOf('id="page-dashboard"'),html.indexOf('id="page-status"'));
  const status=html.slice(html.indexOf('id="page-status"'),html.indexOf('id="page-monitor"'));
  assert.match(wizard,/AGV Learning Wizard/);
  assert.doesNotMatch(wizard,/id="dc-nodes"|id="nodes-grid"/);
  for(const id of ['dc-nodes','dc-topics','dc-cpu','dc-mem','nodes-grid']) assert.match(status,new RegExp(`id="${id}"`),id);
  assert.match(dashboard,/AGV_WIZARD_ORDER = \['urdf','tf','odom','control','lidar','mapping','navigation'\]/);
  assert.doesNotMatch(dashboard,/publisher:\s*\{/);
  assert.match(dashboard,/function openAgvWizardStep/);
  for(const id of ['urdf','tf','odom']) assert.match(dashboard,new RegExp(`${id}:\\s+\\{[^\\n]+page:'transformation'`),id);
  for(const id of ['control','lidar','mapping','navigation']) assert.match(dashboard,new RegExp(`${id}:\\s+\\{[^\\n]+page:null`),id);
  assert.match(dashboard,/id==='odom'.*tfOpenOdom/);
  assert.match(html,/hideOnPages = \['dashboard', 'status'/);
  assert.match(html,/#page-dashboard \.agv-step-card\{min-height:180px/);
  assert.match(html,/\.agv-action-btn\{min-width:270px;min-height:76px/);
  assert.match(dashboard,/class="agv-action-btn"/);
});

test('AGV mission details open on demand in an accessible modal', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js');
  assert.match(html,/id="agv-mission-modal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html,/id="agv-mission-close"[^>]+onclick="closeAgvMission\(\)"/);
  assert.match(dashboard,/function openAgvWizardStep\(id\)[\s\S]+modal\.classList\.remove\('hidden'\)/);
  assert.match(dashboard,/function closeAgvMission\(\)/);
  assert.match(dashboard,/event\.key==='Escape'.+closeAgvMission\(\)/);
  assert.doesNotMatch(dashboard,/openAgvWizardStep\(initial\)/);
});

test('SIM LiDAR mission opens Map Editor and stores a future hardware choice', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js'), map=read('public/map.js'), server=read('server.js');
  assert.match(server,/robotName:robot\.name,isSim:isSim\(robot\.robot_key\)/);
  assert.match(server,/rosInfo:s\.rosInfo,isSim:isSim\(s\.robotKey\)/);
  assert.match(dashboard,/id === 'lidar' && isSimWorkspace/);
  assert.match(dashboard,/page: 'map'/);
  assert.match(dashboard,/action: 'เปิด Map Editor'/);
  assert.match(dashboard,/info\.page==='map'.*initMapEditor/);
  assert.match(html,/id="map-lidar-brand"[^>]+mapLidarBrandChanged/);
  assert.match(html,/id="map-lidar-model"[^>]+mapLidarModelChanged/);
  assert.match(html,/ดาวน์โหลดไดรเวอร์[^<]+<small>เร็ว ๆ นี้<\/small>/);
  assert.match(map,/const MAP_LIDAR_CATALOG/);
  assert.match(map,/lidar: \{ brand:'', model:'', sensorType:'', driverPackage:'' \}/);
  assert.match(map,/function mapLidarBrandChanged/);
  assert.match(map,/function mapLidarModelChanged/);
  assert.match(map,/localStorage\.setItem\(mapStoreKey\(\), JSON\.stringify\(mapData\)\)/);
});

test('SIM LiDAR card explains the mission before navigation and requires a valid map.json', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js'), server=read('server.js'), map=read('public/map.js');
  assert.match(dashboard,/function activateAgvWizardStep\(id\) \{\s+openAgvWizardStep\(id\)/);
  assert.match(dashboard,/onclick="activateAgvWizardStep\('\$\{capability\.id\}'\)"/);
  assert.match(dashboard,/title:'ทำอะไร'/);
  assert.match(dashboard,/title:'ทำไมต้องทำ'/);
  assert.match(dashboard,/title:'ทำแล้วได้อะไร'/);
  assert.match(dashboard,/class="agv-explanation-grid"/);
  assert.match(html,/\.agv-explanation-grid\{display:grid/);
  assert.match(dashboard,/simFromProject = \/\(\?:\^\|\[\\\\\/\]\)sim_ws/);
  assert.match(dashboard,/capability\.mapCheck[\s\S]+validationMessage/);
  assert.match(server,/function validateSimMapData\(data\)/);
  assert.match(server,/function inspectSimMapCapability\(robotKey\)/);
  assert.match(server,/summary\.capabilities\[index\]=mapCapability/);
  assert.match(server,/generate-mapsim-package[\s\S]+inspectSimMapCapability\(s\.robotKey\)[\s\S]+!mapCapability\.detected/);
  assert.match(server,/apply-map[\s\S]+validateSimMapData\(req\.body\.map\)/);
  assert.match(map,/ตรวจ map\.json แล้ว พร้อมใช้กับ Sim และผ่านภารกิจ LiDAR/);
});

test('top bar uses an icon status shortcut instead of duplicate menu and ROS pill', () => {
  const html=read('public/index.html'), app=read('public/app.js');
  assert.match(html,/id="btn-status"[^>]+switchPage\('status'\)/);
  assert.match(html,/id="btn-build"[^>]+aria-label="Build โปรเจกต์"/);
  assert.match(html,/id="badge-conn"[^>]+role="status"/);
  assert.doesNotMatch(html,/id="ros-pill"/);
  const workspaceMenu=html.slice(html.indexOf('<div class="top-menus">'),html.indexOf('<div class="top-actions">'));
  assert.doesNotMatch(workspaceMenu,/switchPage\('status'\)/);
  assert.match(app,/btn-status.+classList\.toggle\('active',p==='status'\)/);
});

test('top bar provides an active AGV wizard icon shortcut', () => {
  const html=read('public/index.html'), app=read('public/app.js');
  assert.match(html,/id="btn-wizard"[^>]+switchPage\('dashboard'\)[^>]+aria-label="เปิด AGV Learning Wizard"/);
  assert.match(app,/btn-wizard.+classList\.toggle\('active',p==='dashboard'\)/);
});

test('theme preference is shared by every standalone web page', () => {
  const theme=read('public/theme.js'), common=read('public/common.js');
  for(const file of ['public/index.html','public/login.html','public/register.html','public/robots.html']) {
    assert.match(read(file),/<script src="\/theme\.js"><\/script>/,file);
  }
  assert.match(theme,/THEME_KEY = 'ros2ide_theme'/);
  assert.match(theme,/LEGACY_THEME_KEY = 'ros2ide-theme'/);
  assert.match(theme,/addEventListener\('storage'/);
  assert.doesNotMatch(common,/function toggleTheme|localStorage\.setItem\('ros2ide-theme'/);
  assert.doesNotMatch(read('public/index.html'),/id="btn-refresh-dash"/);
});
