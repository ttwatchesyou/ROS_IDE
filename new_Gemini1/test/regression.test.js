'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { genMapsimFiles, SIM_STATE_PUB, SimEngine, wsRoot, toAbs, writeTfPackage, writeOdomPackage, robotCollides, motionIsClear } = require('../sim');
const { buildProjectScanScript, parseProjectScanOutput, inspectSimulationMissionArtifacts, completeSimulationWizardMapping, completeSimulationWizardNavigation, resetSimulationWizardAfterFieldChange, readSimulationWizardProgress } = require('../project-scanner');
const { writeNavigationPackage, writeProjectInstaller } = require('../navigation-export');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('generated mapsim Python compiles and contains initialized runtime state', () => {
  const source = genMapsimFiles()['sim_robot_mapsim/mapsim.py'];
  const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.read(), 'mapsim.py', 'exec')"], {input:source, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(source, /self\.map_file=/);
  assert.match(source, /self\.x,self\.y,self\.th=/);
  assert.doesNotMatch(source, /len\(w\)>=4/);
  assert.doesNotMatch(source, /translation\.z=0;/);
  assert.match(source, /origin\.position\.x=float\(b\[0\]\)/);
  assert.match(source, /if b and not w:/);
  assert.match(source, /min\(xs\)-res/);
});

test('generated state publisher Python compiles', () => {
  const result = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.read(), 'state_pub.py', 'exec')"], {input:SIM_STATE_PUB, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

test('simulation lifecycle never leaves MapSim and fallback publishers running together', () => {
  const sim=read('sim.js'),server=read('server.js');
  assert.match(sim,/PID=\$\(cat '\$\{root\}\/tmp\/_mapsim\.pid'/);
  assert.ok((sim.match(/install\/\.\*\/\[m\]apsim/g)||[]).length>=3);
  assert.match(sim,/fss\.writeFileSync\(simPubPidFile, String\(simPubChild\.pid\)\)/);
  assert.match(server,/_sim_state_pub\[\.\]py/);
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

test('simulation physics stops the robot body at walls and furniture outlines',()=>{
  const walls=[[1,-1,1,1],[2,-1,2,1]];
  assert.equal(robotCollides(.8,0,walls,.24),true);
  assert.equal(robotCollides(0,0,walls,.24),false);
  assert.equal(motionIsClear(0,0,1.5,0,walls,.24),false);
  assert.equal(motionIsClear(0,0,0,.5,walls,.24),true);
  const mapsim=genMapsimFiles()['sim_robot_mapsim/mapsim.py'];
  assert.match(mapsim,/ROBOT_RADIUS = 0\.24/);
  assert.match(mapsim,/def motion_is_clear/);
  assert.match(mapsim,/if motion_is_clear\(self\.x,self\.y,next_x,next_y\)/);
  assert.match(mapsim,/ชนสิ่งกีดขวาง หุ่นหยุดแล้ว/);
});

test('privileged HTTP APIs require authentication', () => {
  const source = read('server.js');
  for (const route of ['exec','dashboard','files/list','files/read','files/write','files/mkdir','files/rename','files/delete']) {
    const escaped=route.replace('/', '\\/');
    assert.match(source, new RegExp(`app\\.post\\('/api/${escaped}',\\s*auth`), route);
  }
});

test('robots are listed newest first for admins and regular users', () => {
  const source = read('server.js');
  assert.equal((source.match(/ORDER BY r\.created_at DESC, r\.id DESC/g) || []).length, 2);
});

test('Robots page reports ROS Wizzard progress from each configured workspace', () => {
  const server=read('server.js'),robots=read('public/robots.html'),scanner=read('project-scanner.js');
  assert.match(server,/const SIMULATION_WIZARD_ORDER=\['urdf','tf','odom','lidar','control','mapping','navigation'\]/);
  assert.match(server,/const REAL_ROBOT_WIZARD_ORDER=\['urdf','lidar','hardware','pid','control','mapping','navigation'\]/);
  assert.match(server,/const REAL_ROBOT_OPTIONAL_ORDER=\[\]/);
  assert.match(server,/function inspectRobotWizardProgress\(robot\)/);
  assert.match(server,/scanLocalProject\(workspace\)/);
  assert.match(server,/inspectSimulationMissionArtifacts\(workspace\)/);
  assert.match(server,/wizardProgress:await inspectRobotWizardProgress\(robot\)/);
  assert.match(scanner,/function scanLocalProject\(workspace\)/);
  assert.match(robots,/function renderRobotProgress\(robot\)/);
  assert.match(robots,/role="progressbar"/);
  assert.match(robots,/ความคืบหน้าเฉลี่ย/);
  assert.match(robots,/เชื่อมต่อหุ่นยนต์เพื่อดูความคืบหน้า/);
});

test('free users keep robot limits while admins and active Pro users are unlimited', () => {
  const server=read('server.js'),robots=read('public/robots.html');
  assert.match(server,/const ROBOT_LIMITS=Object\.freeze\(\{simulation:2,real:2,activeConnections:2\}\)/);
  assert.match(server,/GET_LOCK\(\?,5\)/);
  assert.match(server,/SIMULATION_LIMIT_REACHED/);
  assert.match(server,/REAL_ROBOT_LIMIT_REACHED/);
  assert.match(server,/ACTIVE_ROBOT_LIMIT_REACHED/);
  assert.match(server,/if\(!membership\.isUnlimited\)/);
  assert.match(server,/unlimited:\{simulation:isUnlimited,real:isUnlimited,activeConnections:false\}/);
  assert.match(server,/isOwn:Number\(robot\.added_by\)===Number\(req\.user\.id\)/);
  assert.match(server,/const activeSessionReservations = new Map\(\)/);
  assert.match(server,/app\.post\('\/api\/robots\/:id\/disconnect',auth/);
  assert.match(server,/connected:activeByRobot\.has\(robot\.id\)/);
  assert.match(robots,/id="robot-quota-note"/);
  assert.match(robots,/data-quota-kind="simulation"/);
  assert.match(robots,/data-quota-kind="real"/);
  assert.match(robots,/function renderQuota\(\)/);
  assert.match(robots,/function renderRobotGroup\(/);
  assert.match(robots,/หุ่นยนต์ของผู้ใช้อื่น/);
  assert.match(robots,/quotaExhausted\('simulation'\)/);
  assert.match(robots,/async function disconnectRobot\(robotId\)/);
});

test('membership plans use verified Stripe webhooks and expose subscription dates', () => {
  const server=read('server.js'),schema=read('schema.sql'),html=read('public/applications.html'),client=read('public/applications.js');
  assert.match(server,/pro_monthly:\{code:'pro_monthly',name:'Pro รายเดือน',price:99/);
  assert.match(server,/pro_yearly:\{code:'pro_yearly',name:'Pro รายปี',price:999/);
  assert.match(server,/pro_lifetime:\{code:'pro_lifetime',name:'Pro ตลอดชีพ',price:9999/);
  assert.match(server,/app\.post\('\/api\/billing\/webhook',express\.raw/);
  assert.match(server,/verifyStripeEvent\(req\.body,req\.headers\['stripe-signature'\]\)/);
  assert.match(server,/app\.post\('\/api\/billing\/checkout',auth/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS user_subscriptions/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS payment_events/);
  assert.match(html,/id="membership-dates"/);
  assert.match(client,/วันที่สมัคร/);
  assert.match(client,/วันหมดอายุ/);
});

test('Terminal menu is hidden for Free users and shown for paid plans and admins', () => {
  const server=read('server.js'),html=read('public/index.html'),common=read('public/common.js'),app=read('public/app.js');
  assert.match(server,/membership:await getMembership\(req\.user\)/);
  assert.match(html,/id="terminal-menu" data-paid-feature="terminal" hidden/);
  assert.match(common,/Boolean\(membership && membership\.planCode !== 'free'\)/);
  assert.match(common,/menu\.hidden = !terminalPlanAccess/);
  assert.match(app,/if\(p==='terminal'&&!terminalPlanAccess\)/);
  assert.match(app,/loadTerminalPlanAccess\(\)/);
});

test('admin manages the application catalog and launches use one-time SSO codes', () => {
  const server=read('server.js'),html=read('public/applications.html'),client=read('public/applications.js'),schema=read('schema.sql');
  assert.match(schema,/CREATE TABLE IF NOT EXISTS applications/);
  assert.match(server,/app\.post\('\/api\/applications',auth,adminOnly/);
  assert.match(server,/app\.put\('\/api\/applications\/:id',auth,adminOnly/);
  assert.match(server,/app\.delete\('\/api\/applications\/:id',auth,adminOnly/);
  assert.match(server,/app\.post\('\/api\/applications\/:id\/launch',auth/);
  assert.match(server,/applicationLaunchTickets\.set\(code/);
  assert.match(server,/SHOW_SSO_DEBUG_KEY/);
  assert.match(server,/ssoCode:SHOW_SSO_DEBUG_KEY\?ssoCode:null,ssoExpiresIn:60/);
  assert.match(server,/app\.post\('\/api\/application-sessions\/exchange'/);
  assert.doesNotMatch(server,/searchParams\.set\([^,]+req\.headers\['x-auth-token'\]/);
  assert.match(html,/id="add-app"/);
  assert.match(html,/id="app-session"/);
  assert.match(html,/id="sso-debug-code"/);
  assert.match(client,/showSsoDebug\(code,target\.toString\(\)\)/);
  assert.match(client,/USER\.role==='admin'/);
  assert.match(client,/data-edit=/);
});

test('application logos accept HTTPS images with live preview and retain emoji fallback', () => {
  const server=read('server.js'),schema=read('schema.sql'),html=read('public/applications.html'),client=read('public/applications.js');
  assert.match(schema,/icon\s+VARCHAR\(2048\)/);
  assert.match(server,/Logo image URL must use https:\/\//);
  assert.match(server,/ALTER TABLE applications MODIFY icon VARCHAR\(2048\)/);
  assert.match(server,/img-src 'self' https: data: blob:/);
  assert.match(html,/id="app-icon-preview"/);
  assert.match(html,/id="app-icon" maxlength="2048"/);
  assert.match(client,/function updateIconPreview\(\)/);
  assert.match(client,/function renderAppLogo\(value\)/);
  assert.match(client,/referrerpolicy="no-referrer"/);
});

test('admins can paste clipboard images into persistent application logo storage', () => {
  const server=read('server.js'),html=read('public/applications.html'),client=read('public/applications.js');
  assert.match(server,/app\.post\('\/api\/applications\/icon-upload',auth,adminOnly/);
  assert.match(server,/data\.length>5\*1024\*1024/);
  for(const type of ['png','jpeg','webp','gif'])assert.match(server,new RegExp(type));
  assert.match(server,/APPLICATION_ICON_DIR/);
  assert.match(html,/Copy Image จากเว็บ/);
  assert.match(html,/id="app-icon-preview" tabindex="0"/);
  assert.match(client,/async function pasteApplicationIcon\(event\)/);
  assert.match(client,/entry\.kind==='file'&&entry\.type\.startsWith\('image\/'\)/);
  assert.match(client,/readAsDataURL\(file\)/);
  assert.match(client,/\/api\/applications\/icon-upload/);
});

test('IDE refresh restores or renews the selected robot session automatically',()=>{
  const server=read('server.js'),app=read('public/app.js'),robots=read('public/robots.html');
  assert.match(server,/app\.post\('\/api\/session\/restore',auth/);
  assert.match(server,/function createRobotSession\(robot,user/);
  assert.match(server,/robot_connections WHERE user_id=\? AND disconnected_at IS NULL/);
  assert.match(app,/API\('\/api\/session\/restore',\{sessionId:saved\.sessionId,robotId:saved\.robotId\}\)/);
  assert.match(app,/localStorage\.setItem\('ros2ide_robotid'/);
  assert.match(robots,/localStorage\.setItem\('ros2ide_robotid'/);
});

test('browser WebSockets include the authentication token', () => {
  for (const file of ['public/terminal.js','public/monitor.js','public/robots.html']) {
    const source=read(file);
    assert.match(source, /\['ros2ide',\s*(TOKEN|token)\]/, file);
  }
  const server=read('server.js');
  assert.match(server,/function webSocketAuthToken\(protocolHeader\)/);
  assert.match(server,/value&&value!=='ros2ide'/);
  assert.match(server,/tokenUser\(webSocketAuthToken\(req\.headers\['sec-websocket-protocol'\]\)\)/);
  assert.doesNotMatch(server,/protocols\.find\(p=>\/\^\[a-f0-9\]\{64\}\$\//);
});

test('Terminal keeps the remote PTY size synchronized without duplicate resize handlers', () => {
  const terminal=read('public/terminal.js'),html=read('public/index.html');
  assert.match(terminal,/let _termWindowResizeBound = false/);
  assert.match(terminal,/window\.addEventListener\('resize', termFitActive\)/);
  assert.match(terminal,/function termFitTab\(t\)[\s\S]+type: 'resize',[\s\S]+cols: t\.term\.cols, rows: t\.term\.rows/);
  assert.match(html,/terminal\.js\?v=20260812-terminal-fix2/);
  assert.match(terminal,/function termResetTabs\(\)/);
  assert.match(terminal,/Terminal หลุดการเชื่อมต่อ/);
});

test('Terminal opens inside the configured workspace and simulation PTY returns output', async () => {
  const server=read('server.js');
  assert.match(server,/configuredWorkspace=String\(sess\.workspace\|\|'~\/ros2_ws'\)/);
  assert.match(server,/cd "\$ROSIDE_WS"[\s\S]+source install\/setup\.bash/);
  const key=`SIM-terminal-regression-${process.pid}`;
  const messages=[],webSockets=new Map(),id='term_regression';
  webSockets.set(id,{readyState:1,send:raw=>messages.push(JSON.parse(raw))});
  const agent=require('../sim').createSimAgent(key,{pendingReqs:new Map(),monSockets:new Map(),webSockets,WebSocket:{OPEN:1}});
  try{
    agent.ws.send(JSON.stringify({type:'pty_init',termId:id,cols:90,rows:24}));
    await new Promise(resolve=>setTimeout(resolve,350));
    agent.ws.send(JSON.stringify({type:'pty_input',termId:id,data:'printf "TERMINAL_REGRESSION_OK\\n"\n'}));
    await new Promise(resolve=>setTimeout(resolve,650));
    const output=messages.filter(message=>message.type==='pty_output').map(message=>Buffer.from(message.data,'base64').toString()).join('');
    assert.match(output,/TERMINAL_REGRESSION_OK/);
  }finally{
    agent.ws.close();
    fs.rmSync(wsRoot(key),{recursive:true,force:true});
  }
});

test('API wrapper reports an HTML server response without leaking a JSON parser error', async () => {
  const source=read('public/common.js')+'\n;globalThis.__testAPI=API;';
  const context={
    localStorage:{getItem:()=>null},
    getAuthToken:()=> 'token',authHeaders:()=>({Authorization:'Bearer token'}),
    clearAuthSession:()=>{},window:{location:{replace:()=>{}}},document:{getElementById:()=>null},
    fetch:async()=>({status:404,headers:{get:()=> 'text/html'},text:async()=> '<!DOCTYPE html><title>Not Found</title>'}),
    setTimeout,JSON,Error,encodeURIComponent,btoa:globalThis.btoa,
  };
  vm.runInNewContext(source,context);
  await assert.rejects(
    context.__testAPI('/api/missing',{}),
    error=>error.code==='INVALID_API_RESPONSE'&&/รีสตาร์ต server/.test(error.message)&&!/Unexpected token/.test(error.message)
  );
});

test('Robot Config package writers create both TF/model and ODOM packages', () => {
  const key='robot-config-save-test-'+process.pid,workspace=wsRoot(key);
  try{
    const tfResult=writeTfPackage(key,{
      'package.xml':'<package><name>sim_robot_tf</name></package>',
      'urdf/robot.urdf':'<robot name="test_robot"/>',
      'tf_model.json':'[{"id":"base"}]',
    });
    const odomResult=writeOdomPackage(key,{
      'package.xml':'<package><name>sim_robot_odom</name></package>',
      'sim_robot_odom/odom.py':'def main(): pass\n',
      'odom_config.json':'{"wheels":[]}',
    });
    assert.deepEqual(tfResult.written,['package.xml','urdf/robot.urdf','tf_model.json']);
    assert.deepEqual(odomResult.written,['package.xml','sim_robot_odom/odom.py','odom_config.json']);
    for(const file of ['src/sim_robot_tf/urdf/robot.urdf','src/sim_robot_tf/tf_model.json','src/sim_robot_odom/sim_robot_odom/odom.py','src/sim_robot_odom/odom_config.json']){
      assert.equal(fs.existsSync(path.join(workspace,file)),true,file);
    }
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('generated Python packages declare ament indexes and runnable entry points', () => {
  const transformation=read('public/transformation.js'),sim=read('sim.js');
  assert.equal((transformation.match(/<build_type>ament_python<\/build_type>/g)||[]).length>=2,true);
  assert.match(sim,/src\/sim_robot\/resource/);
  assert.match(sim,/<export><build_type>ament_python<\/build_type><\/export>/);
  assert.match(sim,/talker = sim_robot\.talker:main/);
  assert.match(sim,/executable='talker'/);
});

test('login session is shared under public storage keys and cleared on logout',()=>{
  const storage=read('public/auth-storage.js');
  for(const key of ['encrypted_user_id','token','session_id','ros2ide_token'])assert.match(storage,new RegExp(`['"]${key}['"]`));
  assert.match(storage,/function storeAuthSession/);
  assert.match(storage,/localStorage\.setItem\('encrypted_user_id', encryptedUserId\)/);
  assert.match(storage,/function clearAuthSession/);
  for(const page of ['login.html','register.html','applications.html','robots.html','index.html']){
    assert.match(read(`public/${page}`),/auth-storage\.js/,page);
  }
});

test('browser stores an encrypted user reference and APIs accept bearer authorization',()=>{
  const server=read('server.js');
  assert.match(server,/function localSecret\(name\)/);
  assert.match(server,/process\.env\.ENC_KEY \|\| localEncSecret/);
  assert.match(server,/signAuthToken/);
  assert.match(server,/function encryptedUserReference/);
  assert.match(server,/encryptedUserId:encryptedUserReference/);
  assert.match(server,/Authorization|authorization/);
  assert.match(server,/timingSafeEqual/);
  assert.match(server,/req\.authSessionId/);
});

test('main login application defaults to port 3001',()=>{
  assert.match(read('server.js'),/process\.env\.PORT \|\| 3001/);
  assert.match(read('.env.example'),/^PORT=3001$/m);
  assert.doesNotMatch(read('README.md'),/3009|localhost:3000/);
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
  fs.writeFileSync(path.join(pkg,'build_verified.json'),JSON.stringify({status:'compiled',capability:'micro_ros'}));
  try {
    const script64=Buffer.from(buildProjectScanScript(fixture)).toString('base64');
    const result=spawnSync('python3',['-c',`import base64;exec(base64.b64decode('${script64}'))`],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const summary=parseProjectScanOutput(result.stdout);
    assert.equal(summary.packageCount,1);
    assert.deepEqual(summary.packages,['demo_robot']);
    for(const id of ['tf','odom','urdf','publisher','hardware']) {
      const capability=summary.capabilities.find(item=>item.id===id);
      assert.equal(capability.detected,true,id);
      assert.ok(capability.files.length>0,id);
    }
    assert.equal(summary.capabilities.find(item=>item.id==='lidar').detected,false);
  } finally {
    fs.rmSync(fixture,{recursive:true,force:true});
  }
});

test('simulation Mapping and Navigation follow explicit Robot Playground actions only', () => {
  const fixture=fs.mkdtempSync('/tmp/roside-wizard-artifacts-');
  try {
    let [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(mapping.detected,false);
    assert.equal(navigation.detected,false);

    const mapDir=path.join(fixture,'maps','school');
    fs.mkdirSync(mapDir,{recursive:true});
    fs.writeFileSync(path.join(mapDir,'map.pgm'),'P5\n10 1\n255\n'+String.fromCharCode(...Array(10).fill(254)),'binary');
    fs.writeFileSync(path.join(mapDir,'map.yaml'),'image: map.pgm\nresolution: 0.05\n');
    fs.writeFileSync(path.join(mapDir,'map.json'),JSON.stringify({width:10,height:1,resolution:.05,data:[0,-1,-1,-1,-1,-1,-1,-1,-1,-1]}));
    [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(mapping.detected,false,'workspace files alone must not complete the mission');
    assert.equal(navigation.detected,false);

    completeSimulationWizardMapping(fixture,'school');
    [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(mapping.detected,true);
    assert.equal(navigation.detected,false);

    completeSimulationWizardNavigation(fixture,'school');
    [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(navigation.detected,true);

    fs.renameSync(mapDir,path.join(fixture,'maps','school_removed'));
    [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(mapping.detected,false,'missing maps/<mapName> folder must clear Mapping');
    assert.equal(navigation.detected,false,'Navigation cannot stay complete without its map folder');

    fs.writeFileSync(path.join(fixture,'.roside','ros_wizard_progress.json'),JSON.stringify({version:1,completed:{mapping:{completedAt:'legacy',mapName:'school_removed'},navigation:{completedAt:'legacy',mapName:'school_removed',started:true}}}));
    [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(mapping.detected,false,'legacy progress created by the old rules must be ignored');
    assert.equal(navigation.detected,false);

    resetSimulationWizardAfterFieldChange(fixture);
    [mapping,navigation]=inspectSimulationMissionArtifacts(fixture);
    assert.equal(mapping.detected,false);
    assert.equal(navigation.detected,false);
    assert.ok(readSimulationWizardProgress(fixture).completed.lidar);
  } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
  const server=read('server.js'),dashboard=read('public/dashboard.js'),playground=read('public/playground.js');
  assert.match(server,/inspectSimulationMissionArtifacts\(wsRoot\(session\.robotKey\)\)/);
  assert.match(server,/app\.post\('\/api\/sim\/start-navigation-mission'/);
  assert.match(server,/resetSimulationWizardAfterFieldChange\(wsRoot\(s\.robotKey\)\)/);
  assert.match(server,/completeSimulationWizardMapping\(root,mapName\)/);
  assert.match(playground,/API\('\/api\/sim\/start-navigation-mission',\{sessionId,mapName:playgroundSelectedMap\}\)/);
  assert.doesNotMatch(playground,/complete-navigation-mission/);
  assert.match(dashboard,/capability\.mapCheck \|\| capability\.resultCheck/);
});

test('dashboard renders project capability cards from backend scan data', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js');
  assert.match(html,/id="project-capabilities-grid"/);
  assert.match(dashboard,/renderProjectCapabilities\(d\.project\)/);
  assert.match(dashboard,/PROJECT_CAPABILITY_META/);
});

test('ROS Wizzard is separated from runtime status cards', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js');
  const wizard=html.slice(html.indexOf('id="page-dashboard"'),html.indexOf('id="page-status"'));
  const status=html.slice(html.indexOf('id="page-status"'),html.indexOf('id="page-monitor"'));
  assert.match(wizard,/ROS Wizzard/);
  assert.doesNotMatch(wizard,/id="dc-nodes"|id="nodes-grid"/);
  for(const id of ['dc-nodes','dc-topics','dc-cpu','dc-mem','nodes-grid']) assert.match(status,new RegExp(`id="${id}"`),id);
  assert.match(dashboard,/SIMULATION_WIZARD_ORDER = \['urdf','tf','odom','lidar','control','mapping','navigation'\]/);
  assert.match(dashboard,/REAL_ROBOT_WIZARD_ORDER = \['urdf','lidar','hardware','pid','control','mapping','navigation'\]/);
  assert.match(dashboard,/REAL_ROBOT_OPTIONAL_ORDER = \[\]/);
  assert.doesNotMatch(dashboard,/publisher:\s*\{/);
  assert.match(dashboard,/function openAgvWizardStep/);
  for(const id of ['urdf','tf','odom']) assert.match(dashboard,new RegExp(`${id}:\\s+\\{[^\\n]+page:'transformation'`),id);
  assert.match(dashboard,/control:\s+\{[^\n]+page:'playground', playgroundMode:'control'/);
  assert.match(dashboard,/lidar:\s+\{[^\n]+page:'lidar'/);
  assert.match(dashboard,/mapping:\s+\{[^\n]+page:'playground', playgroundMode:'mapping'/);
  assert.match(dashboard,/navigation:\s+\{[^\n]+page:'playground', playgroundMode:'navigation'/);
  assert.match(dashboard,/info\.page==='playground'[\s\S]+playgroundOpenMode\(info\.playgroundMode\)/);
  assert.match(read('public/playground.js'),/function playgroundOpenMode\(mode\)[\s\S]+window\.switchPage\('playground'\)/);
  assert.match(dashboard,/id==='odom'.*tfOpenOdom/);
  assert.match(html,/hideOnPages = \['dashboard', 'status'/);
  assert.match(html,/#page-dashboard \.agv-step-card\{min-height:180px/);
  assert.match(html,/\.agv-action-btn\{min-width:270px;min-height:76px/);
  assert.match(dashboard,/class="agv-action-btn"/);
});

test('Motion Control stays locked until the LiDAR field is ready in Simulation', () => {
  const source=read('public/dashboard.js')+'\n;globalThis.__dependencies=applyAgvWizardDependencies;';
  const context={window:{},document:{addEventListener:()=>{}},console,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(source,context);
  const blocked=[{id:'lidar',detected:false},{id:'control',detected:true,files:['controller.py']}];
  context.__dependencies(blocked,true);
  assert.equal(blocked[1].detected,false);
  assert.equal(blocked[1].sourceDetected,true);
  assert.equal(blocked[1].dependencyBlocked,true);
  assert.match(blocked[1].dependencyMessage,/สร้างและบันทึกสนามให้ LiDAR/);
  const ready=[{id:'lidar',detected:true},{id:'control',detected:true}];
  context.__dependencies(ready,true);
  assert.equal(ready[1].detected,true);
  assert.equal(ready[1].dependencyBlocked,undefined);
  const realRobot=[{id:'lidar',detected:false},{id:'control',detected:true}];
  context.__dependencies(realRobot,false);
  assert.equal(realRobot[1].detected,false);
  assert.equal(realRobot[1].dependencyBlocked,true);
  assert.match(realRobot[1].dependencyMessage,/จูนค่า PID/);
});

test('ROS Wizzard rejects scanner-only Mapping and Navigation results', () => {
  const dashboard=read('public/dashboard.js'),html=read('public/index.html');
  const source=dashboard+'\n;globalThis.__dependencies=applyAgvWizardDependencies;';
  const context={isSimWorkspace:true,window:{addEventListener:()=>{}},document:{addEventListener:()=>{}},localStorage:{setItem:()=>{}},console,Math,Object,Array,setInterval:()=>0,clearInterval:()=>{}};
  vm.runInNewContext(source,context);
  const stale=context.__dependencies([{id:'lidar',detected:true},{id:'mapping',detected:true},{id:'navigation',detected:true}],true);
  assert.equal(stale.find(item=>item.id==='mapping').detected,false);
  assert.equal(stale.find(item=>item.id==='navigation').detected,false);
  const verified=context.__dependencies([
    {id:'lidar',detected:true},
    {id:'mapping',detected:true,wizardActionCheck:true,progressVersion:2,mapFolderExists:true},
    {id:'navigation',detected:true,wizardActionCheck:true,progressVersion:2,mapFolderExists:true},
  ],true);
  assert.equal(verified.find(item=>item.id==='mapping').detected,true);
  assert.equal(verified.find(item=>item.id==='navigation').detected,true);
  assert.match(dashboard,/capability\.wizardActionCheck===true&&capability\.progressVersion===2&&capability\.mapFolderExists===true/);
  assert.match(html,/dashboard\.js\?v=20260828-drive-center3/);
});

test('real robot wizard contains only the navigation commissioning path in dependency order', () => {
  const dashboard=read('public/dashboard.js'),server=read('server.js');
  const expected="['urdf','lidar','hardware','pid','control','mapping','navigation']";
  assert.ok(dashboard.includes(`REAL_ROBOT_WIZARD_ORDER = ${expected}`));
  assert.ok(server.includes(`REAL_ROBOT_WIZARD_ORDER=${expected}`));
  for(const removed of ['safety','diagnostics','automation','deployment','camera','perception','manipulation','imu','calibration','localization']){
    assert.equal(expected.includes(`'${removed}'`),false,removed);
  }
  for(const dependency of ["block('pid',['hardware']","block('control',['hardware','pid']","block('mapping',['control','lidar']","block('navigation',['pid','mapping']"]){
    assert.ok(dashboard.includes(dependency),dependency);
  }
  assert.match(server,/block\('navigation',\['pid','mapping'\]\)/);
  assert.match(dashboard,/name:'ประกอบหุ่น', tech:'Robot Model · TF · Odometry'/);
  assert.match(dashboard,/assemblyParts\.every\(part=>part\.detected===true\)/);
  assert.match(server,/\['urdf','tf','odom'\]\.every\(id=>byId\[id\]\?\.detected===true\)/);
  assert.match(dashboard,/pid:\s*\{ icon:'🎛️', name:'จูนระบบหุ่นยนต์', tech:'Wheel PID Tuning'/);
  assert.match(read('project-scanner.js'),/pid: \[String\.raw`\\bPID/);
  assert.match(dashboard,/custom_package:\{ icon:'🐍', name:'สร้างโปรแกรมหุ่นยนต์', tech:'Custom Python Package'/);
  assert.match(read('project-scanner.js'),/custom_package: \[String\.raw`Generated by Mecha Rayong/);
});

test('real robot LiDAR step installs a selected driver into workspace src and plots /scan in 2D',()=>{
  const html=read('public/index.html'),dashboard=read('public/dashboard.js'),lidar=read('public/lidar.js'),server=read('server.js');
  assert.match(html,/id="page-lidar"/);
  assert.match(html,/id="lidar-model-grid"/);
  assert.match(html,/id="lidar-canvas"/);
  assert.match(lidar,/ติดตั้งและ Build อัตโนมัติ/);
  assert.match(html,/id="lidar-port-select"/);
  assert.match(html,/id="lidar-port-state"/);
  assert.doesNotMatch(html,/id="lidar-sudo-password"/);
  assert.match(html,/id="lidar-baud-input"/);
  assert.match(html,/id="lidar-scan-button"[^>]+hidden/);
  assert.match(html,/Driver Console/);
  assert.match(html,/id="lidar-runtime-log"/);
  assert.match(html,/data-stage="tools"/);
  assert.match(dashboard,/id==='lidar'&&!isSimWorkspace/);
  assert.match(lidar,/install\?'\/api\/lidar\/install':'\/api\/lidar\/build'/);
  assert.match(lidar,/new WebSocket\(`\$\{proto\}\/\/\$\{location\.host\}\/ws\/lidar`/);
  assert.match(lidar,/lidar-stat-interval/);
  assert.doesNotMatch(lidar,/setTimeout\(lidarPoll,700\)/);
  assert.match(lidar,/API\('\/api\/lidar\/driver'/);
  assert.match(lidar,/function lidarRenderDriverDiagnostic/);
  assert.match(lidar,/API\('\/api\/lidar\/status'/);
  assert.match(lidar,/API\(endpoint/);
  assert.match(lidar,/ros2ide_lidar_/);
  assert.match(lidar,/result\.savedSelection/);
  assert.match(lidar,/connectButton\.hidden=!result\.installed/);
  assert.match(lidar,/function lidarDrawScan\(scan\)/);
  assert.match(lidar,/function lidarBindZoom\(\)/);
  assert.match(lidar,/shadowBlur=0/);
  assert.match(html,/id="lidar-zoom-value"/);
  assert.match(server,/app\.post\('\/api\/lidar\/install'/);
  assert.match(server,/app\.post\('\/api\/lidar\/scan'/);
  assert.match(server,/ros2ide_lidar_live/);
  assert.match(server,/pathname==='\/ws\/lidar'/);
  assert.match(server,/app\.post\('\/api\/lidar\/status'/);
  assert.match(server,/app\.post\('\/api\/lidar\/build'/);
  assert.match(server,/app\.post\('\/api\/lidar\/driver'/);
  assert.match(server,/ROSIDE_PROCESS=running/);
  assert.match(server,/tail -120/);
  assert.match(server,/usermod -aG dialout/);
  assert.match(server,/chmod 660/);
  assert.match(server,/sg dialout -c/);
  assert.match(server,/exec bash -lc/);
  assert.match(server,/ไม่สามารถ source workspace setup/);
  assert.match(server,/80008004/);
  assert.match(server,/python3-colcon-common-extensions/);
  assert.match(server,/async function lidarSudoExec/);
  assert.match(server,/mkfifo -m 600/);
  assert.match(server,/sudo -S -p ''/);
  assert.match(server,/requiresSudo/);
  assert.match(server,/function decrypt\(t\)/);
  assert.match(server,/sudoPassword:decrypt\(robot\.ssh_pass\)/);
  assert.match(server,/function lidarDirectLaunchCommand/);
  assert.match(server,/rosdep install --from-paths/);
  assert.match(server,/robot@roside\.local/);
  assert.match(server,/reportedDistro&&reportedDistro!=='unknown'/);
  assert.match(server,/export ROS_DISTRO="\$\{distro\}" ROS_PYTHON_VERSION=3/);
  assert.match(server,/colcon build --symlink-install --packages-up-to/);
  assert.match(server,/\[AUTO REPAIR\] Driver ยังไม่พร้อมใช้งาน/);
  assert.match(server,/test -f install\/setup\.bash/);
  assert.match(server,/ros2 pkg prefix roside_lidar_setup/);
  assert.match(server,/REAL_LIDAR_CATALOG/);
  assert.match(server,/saveGeneratedRobotPackage\(s,'roside_lidar_setup'/);
  assert.match(server,/sensor_msgs\/msg\/LaserScan/);
});

test('Flow Editor provides an easy custom Python package and code block workflow',()=>{
  const html=read('public/index.html'),flow=read('public/flow.js'),guide=read('public/guide.js');
  assert.match(html,/id="btn-flow-wizard-main"[^>]+flowOpenQuickPackage\(\)/);
  assert.match(html,/flowQuickPythonBlock\(\)/);
  assert.match(html,/Custom ROS 2 Package/);
  assert.match(html,/flow\.js\?v=20260813-quick-package4/);
  assert.match(flow,/python_code:\s*\{/);
  assert.match(flow,/label:'Python Code'/);
  assert.match(flow,/defaultProps:\{icon:'🐍', title:'Custom logic', code:/);
  assert.match(flow,/function flowQuickPythonBlock\(\)/);
  assert.match(flow,/function genPythonCodeBlock\(/);
  assert.match(flow,/value = \$\{inputExpression\}/);
  assert.match(flow,/out_msg\.data = result/);
  assert.match(guide,/Custom Python Flow/);
  assert.match(html,/โปรแกรมหุ่นของฉัน/);
  assert.match(html,/เริ่มง่ายๆ ด้วย ทำซ้ำ/);
  assert.doesNotMatch(html,/id="flow-tutorial"/);
  assert.doesNotMatch(html,/onclick="flowShowTutorial\(\)"/);
  assert.doesNotMatch(flow,/th\.id = 'flow-touch-hint'/);
  assert.match(flow,/Tutorial popup intentionally disabled/);
  assert.match(flow,/1 · เริ่มจากตรงนี้/);
  assert.match(flow,/2 · ให้หุ่นคิด/);
  assert.match(flow,/3 · ดูหรือส่งคำตอบ/);
  assert.match(html,/id="modal-flow-quick-package"/);
  assert.match(html,/name="flow-quick-template" value="timer"/);
  assert.match(html,/name="flow-quick-template" value="topic"/);
  assert.match(flow,/function flowCreateQuickPackage\(\)/);
  assert.match(flow,/function flowQuickTemplate\(kind\)/);
  assert.match(flow,/ament_python/);
  assert.match(flow,/nodeName}\.flow\.json/);
  assert.match(flow,/function flowSelectTopic\(nodeId,topicName\)/);
  assert.match(flow,/flowDisplayMsgType\(topic\.type\)/);
  assert.match(flow,/<optgroup label=/);
  assert.match(flow,/จัดกลุ่มตาม Message Type/);
});

test('real robot Hardware Builder follows saved Robot Model and ODOM after design is complete', () => {
  const index=read('public/index.html'),html=read('public/hardware.html'),hardware=read('public/hardware.js'),dashboard=read('public/dashboard.js'),server=read('server.js');
  assert.doesNotMatch(index,/id="hardware-builder-modal"/);
  assert.match(server,/app\.get\('\/hardware'.+hardware\.html/);
  assert.match(dashboard,/window\.location\.assign\('\/hardware'\)/);
  for(const group of ['STM32F103C8T6','driverLabel','Encoder ·','MPU6050 IMU'])assert.match(hardware,new RegExp(group),group);
  for(const accessory of ['mpu6050','bno055','hcsr04','servo'])assert.match(html,new RegExp(`value="${accessory}"`),accessory);
  assert.doesNotMatch(html,/value="rplidar"/);
  assert.doesNotMatch(hardware,/accessories\.has\('rplidar'\)/);
  assert.match(html,/Hardware Wiring Workspace/);
  assert.match(html,/class="wire-layer"|id="wiring-board"/);
  assert.match(dashboard,/const designReady=\['urdf','tf','odom','lidar'\]\.every/);
  assert.match(dashboard,/hardware\.dependencyMessage='ทำ Robot Model, TF, ODOM และติดตั้ง LIDAR ให้สำเร็จก่อน/);
  assert.match(hardware,/sim_robot_tf\/tf_model\.json/);
  assert.match(hardware,/sim_robot_odom\/odom_config\.json/);
  assert.match(hardware,/pattern==='differential'&&motorCount===2\?'diff2'/);
  assert.match(hardware,/function renderDiagram\(\)/);
  assert.match(html,/Controller Pinout Diagram/);
  assert.match(hardware,/function pinoutCard\(/);
  assert.match(hardware,/function drawPinoutLines\(\)/);
  assert.match(hardware,/BLUE PILL · SERIAL BRIDGE/);
  assert.match(hardware,/Motor Driver|driverLabel/);
  assert.match(hardware,/Encoder · \$\{encoder\.name\}/);
  assert.match(hardware,/configuredEncoders\.find\(item=>item\.name===component\.name\)\|\|configuredEncoders\[index\]/);
  assert.match(hardware,/<option value="">\$\{esc\(encoder\.name\)\}<\/option>/);
  assert.match(hardware,/<small>frame_id<\/small>/);
  assert.match(html,/hardware\.js\?v=20260828-control-mode10/);
  assert.match(hardware,/function hardwareApplyAssignmentAccordions\(\)/);
  assert.match(html,/\.assignment-accordion/);
  assert.equal((html.match(/class="card sidebar-card"/g)||[]).length,3);
  assert.match(hardware,/querySelectorAll\('\.sidebar-card\[open\]'\)/);
  assert.match(html,/id="controller-board"/);
  assert.match(html,/Cycron Driver · PWML \/ PWMR/);
  assert.match(hardware,/`PWM\$\{channel\}`/);
  assert.match(html,/id="imu-combo"/);
  assert.match(html,/id="sensor-combo"/);
  assert.match(html,/type="checkbox" name="imu-model" value="mpu6050"/);
  assert.match(html,/type="checkbox" name="imu-model" value="bno055"/);
  assert.match(hardware,/function updateMultiCombos\(\)/);
  assert.match(hardware,/kMpu6050Address = 0x68/);
  assert.match(hardware,/kBno055Address = 0x28/);
  assert.match(html,/id="code-modal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.doesNotMatch(html,/id="code-button"/);
  assert.match(hardware,/function openCodeModal\(mode='preview'\)/);
  assert.match(hardware,/function compileHardwareCode\(\)/);
  assert.match(hardware,/platformio-core-installer\/master\/get-platformio\.py/);
  assert.match(hardware,/\.platformio\/penv\/bin\/platformio/);
  assert.match(hardware,/Preflight: checking build requirements on the connected machine/);
  assert.match(hardware,/python3 -m venv/);
  assert.match(hardware,/apt-get install -y python3-venv/);
  assert.match(hardware,/sudo -n true/);
  assert.match(hardware,/bootstrap\.pypa\.io\/virtualenv\.pyz/);
  assert.match(hardware,/platformio>=6,<7/);
  assert.match(hardware,/user-local PlatformIO environment/);
  assert.match(hardware,/PlatformIO Core installation failed/);
  assert.match(hardware,/src\/main\.cpp is missing/);
  assert.match(hardware,/Preflight ไม่ผ่าน.+ROSIDE ERROR/);
  assert.match(hardware,/new WebSocket\(`/);
  assert.match(hardware,/\/ws\/terminal/);
  assert.match(hardware,/ROSIDE_BUILD_DONE_/);
  assert.match(hardware,/new TextDecoder\(\)/);
  assert.match(hardware,/decode\(bytes,\{stream:true\}\)/);
  assert.doesNotMatch(hardware,/PIO_BIN.+run.+--verbose/);
  assert.match(hardware,/armInactivityTimer/);
  assert.match(hardware,/ไม่มี output นานเกิน 10 นาที/);
  assert.match(hardware,/ใช้เวลาเกิน 45 นาที/);
  const helperStart=hardware.indexOf('function shellPath'),helperEnd=hardware.indexOf('async function runPlatformioStream');
  const helperContext={};
  vm.runInNewContext(hardware.slice(helperStart,helperEnd)+`;globalThis.generatedTask=platformioTaskScript('~/ros2_ws/src/roside_stm32_base/firmware','', 'ROSIDE_TEST_DONE_');`,helperContext);
  const shellCheck=spawnSync('bash',['-n'],{input:helperContext.generatedTask,encoding:'utf8'});
  assert.equal(shellCheck.status,0,shellCheck.stderr);
  assert.match(hardware,/\.roside-platformio-build\.sh/);
  assert.match(hardware,/api\('\/api\/files\/write'/);
  assert.match(hardware,/bash \$\{shellPath\(scriptPath\)\} 2>&1/);
  assert.match(html,/data-build-step="files"/);
  assert.match(html,/data-build-step="toolchain"/);
  assert.match(html,/data-build-step="compile"/);
  assert.match(html,/data-build-step="debug"/);
  assert.match(html,/data-build-step="upload"/);
  assert.match(html,/id="upload-port"/);
  assert.match(html,/id="upload-button"[^>]+disabled/);
  assert.match(html,/Build & Debug/);
  assert.match(hardware,/function setBuildStep\(/);
  assert.match(hardware,/function debugSummary\(/);
  assert.match(hardware,/HTTPClientError/);
  assert.doesNotMatch(hardware,/adafruit\/Adafruit BNO055@/);
  assert.doesNotMatch(hardware,/adafruit\/Adafruit MPU6050@/);
  assert.match(hardware,/PIO_BIN.+run/);
  assert.match(hardware,/function updatePlatformioLiveStatus\(/);
  assert.match(hardware,/function refreshSerialPorts\(/);
  assert.match(hardware,/function validSerialPort\(/);
  assert.match(hardware,/function uploadHardwareCode\(/);
  assert.match(hardware,/--target upload --upload-port/);
  assert.match(hardware,/board_upload\.before_reset = default_reset/);
  assert.match(hardware,/board_upload\.after_reset = hard_reset/);
  assert.match(hardware,/stty -F "\$UPLOAD_PORT" -hupcl/);
  assert.match(hardware,/DTR→GPIO0, RTS→EN/);
  assert.match(html,/id="pid-ki"[^>]+value="0\.000"/);
  assert.match(hardware,/ROSIDE_UPLOAD_DONE_/);
  assert.match(hardware,/\.roside-platformio-upload\.sh/);
  assert.match(hardware,/api\('\/api\/serial\/ports'/);
  assert.match(server,/patterns=\['\/dev\/ttyUSB\*','\/dev\/ttyACM\*'/);
  for(const phase of ['Installing','Compiling','Linking','Checking size','RAM:','Flash:','FAILED'])assert.match(hardware,new RegExp(phase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(hardware,/openCodeModal\('generated'\)/);
  assert.match(server,/Math\.min\(300000,Math\.trunc\(requestedTimeout\)\)/);
  assert.match(server,/timeout\+5000/);
  assert.match(hardware,/\.roside\/hardware\.json/);
  assert.match(hardware,/bluepill_f103c8/);
  assert.match(hardware,/kCommandTimeoutMs = 300/);
  assert.match(hardware,/kWheelRadiusM/);
  assert.match(hardware,/kTrackWidthM/);
  assert.match(hardware,/kWheelBaseM/);
  assert.match(hardware,/function firmwareSource\(config\)/);
  assert.match(hardware,/calculateWheelTargets/);
  assert.match(hardware,/updateOdometry/);
  assert.match(hardware,/Mecanum inverse kinematics/);
  assert.match(hardware,/Two-wheel differential inverse kinematics/);
  assert.match(hardware,/api\('\/api\/files\/write'/);
  assert.doesNotMatch(read('public/transformation.js'),/function tfApplyHardwareConfig\(config\)/);
  assert.match(html,/id="hardware-assignments"/);
  assert.match(html,/hardware\.js\?v=20260828-control-mode10/);
  assert.match(hardware,/function writeHardwareBuildEvidence\(base,state,config=null\)/);
  assert.match(hardware,/build_verified\.json/);
  assert.match(hardware,/capability:'serial_bridge'/);
  assert.match(hardware,/transport:'python_serial'/);
  assert.match(html,/id="bridge-serial-port"/);
  assert.match(html,/id="pid-kp"/);
  assert.match(html,/id="pid-control-enabled"[^>]+checked/);
  assert.match(html,/data-code-file="controller_bridge\.py"/);
  assert.match(hardware,/robotDesign\.drive!==\'diff2\'/);
  assert.match(hardware,/function controllerBridgePython\(\)/);
  assert.match(hardware,/src\/roside_controller_bridge/);
  assert.match(hardware,/create_subscription\(Twist, '\/cmd_vel'/);
  assert.match(hardware,/\/controller\/tune_rpm/);
  assert.match(hardware,/\/controller\/pid_gains/);
  assert.match(hardware,/\/controller\/wheel_rpm/);
  assert.match(hardware,/Serial\.print\(\"RPM \"\)/);
  assert.match(hardware,/sscanf\(line, \"P %f %f %f %f %f %f\"/);
  assert.match(hardware,/velocity_kp\[kMotorCount\]/);
  assert.match(hardware,/left_kp/);
  assert.match(hardware,/right_kp/);
  assert.match(hardware,/writeHardwareBuildEvidence\(evidenceBase,'building'\)/);
  assert.match(hardware,/writeHardwareBuildEvidence\(base,'compiled',config\)/);
  assert.match(hardware,/การ์ด Hardware เป็นสีเขียวแล้ว/);
  assert.match(hardware,/const MOTOR_ROLES=/);
  assert.match(hardware,/const ENCODER_ROLES=/);
  assert.match(hardware,/function renderAssignments\(\)/);
  assert.match(hardware,/function firmwareSourceWithAssignments\(config\)/);
  assert.match(hardware,/kEncoderEnabled\[kMotorCount\]/);
  assert.match(hardware,/kPidControlEnabled/);
  assert.match(hardware,/kPidControlEnabled && kEncoderEnabled\[i\]/);
  assert.match(hardware,/pidControl:\$\('pid-control-enabled'\)/);
  assert.match(hardware,/pid_control_enabled/);
  assert.match(hardware,/kEncoderPpr\[kMotorCount\]/);
  assert.match(hardware,/function encoderDecodeMultiplier\(\)\{return 1;\}/);
  assert.match(hardware,/ticks=motors\.map\(encoderTicksPerRevolution\)/);
  assert.match(hardware,/kEncoderDecodeMultiplier = 1/);
  assert.match(hardware,/channel A RISING only/);
  assert.match(hardware,/robotDesign\.drive==='diff2'&&encoderEnabled\?'odom_x'/);
  assert.match(hardware,/if\(robotDesign\.drive==='diff2'\)/);
  assert.match(hardware,/function odomRpmY|float odomRpmY/);
  assert.match(hardware,/odomRpmAny/);
  assert.match(hardware,/assignments,encoderAssignments,controller/);
  const transformation=read('public/transformation.js');
  assert.match(transformation,/function tfOdomSetAssignment\(/);
  assert.match(transformation,/PID \+ ODOM แกน X\/Y/);
  assert.match(transformation,/motor: \{ enabled: w\.motorEnabled/);
  assert.match(transformation,/encoder: \{ enabled: w\.encoderEnabled/);
  assert.match(index,/transformation\.js\?v=20260813-all-encoders3/);
  assert.match(transformation,/function tfDetectEncoders\(/);
  assert.match(transformation,/Encoder ทั้งหมดจาก Robot Model/);
  assert.match(transformation,/encoders:\(o\.encoders\|\|\[\]\)\.map/);
  assert.match(hardware,/sourceEncoders/);
  assert.match(hardware,/ENCODER จาก MODEL/);
  assert.match(hardware,/encoderAssignments/);
  assert.match(hardware,/มี Encoder ติดท้ายมอเตอร์/);
  assert.match(hardware,/encoderEnabled=encoder\?!!encoder\.enabled:!!wheel\.encoderEnabled/);
  assert.match(hardware,/ppr:encoder\?\.ppr\|\|wheel\.ppr\|\|600/);
  assert.match(hardware,/version:13/);
  assert.match(hardware,/encoderEnabled,encoderRole,ppr,channels,invert/);
  assert.match(hardware,/กลับทิศ Encoder \(Invert\)/);
  assert.match(hardware,/key==='invert'.+value\?-1:1/);
  assert.match(hardware,/migrate2wdOdom/);
  assert.match(hardware,/velocity_x = 0\.5f \* \(left_mps \+ right_mps\)/);
  assert.match(hardware,/velocity_yaw = \(right_mps - left_mps\) \/ kTrackWidthM/);
  assert.match(hardware,/pose_x \+= \(velocity_x \* cos_yaw - velocity_y \* sin_yaw\) \* dt/);
  assert.match(hardware,/pose_yaw \+= velocity_yaw \* dt/);
  assert.match(hardware,/motors\.filter\(motor=>motor\.encoderEnabled\)/);
  assert.match(hardware,/\[\['ENC A',motor\.encA\],\['ENC B',motor\.encB\],\['VCC','ตามสเปก'\],\['GND','GND ร่วม'\]\]/);
  assert.match(hardware,/wheelName:wheel\.name/);
  assert.match(hardware,/unresolvedEncoders/);
});

test('ESP32 Hardware upload prepares Linux and esptool automatic boot mode', () => {
  const hardware=read('public/hardware.js'),html=read('public/hardware.html');
  assert.match(html,/hardware\.js\?v=20260828-control-mode10/);
  assert.match(html,/NodeMCU-32S · ESP32 Auto BOOT/);
  assert.match(hardware,/NodeMCU-32S \(Auto BOOT\)/);
  assert.match(hardware,/esp32:\['espressif32','nodemcu-32s',''\]/);
  assert.match(hardware,/\[env:\$\{environment\}\]/);
  assert.match(hardware,/board_upload\.before_reset = default_reset/);
  assert.match(hardware,/board_upload\.after_reset = hard_reset/);
  assert.match(hardware,/stty -F "\$UPLOAD_PORT" -hupcl/);
  assert.match(hardware,/DTR→GPIO0, RTS→EN/);
  assert.doesNotMatch(hardware,/\['16','17','25','34','35'\]/);
  const helperStart=hardware.indexOf('function shellPath'),helperEnd=hardware.indexOf('async function runPlatformioStream');
  const helperContext={};
  vm.runInNewContext(hardware.slice(helperStart,helperEnd)+`;globalThis.uploadTask=platformioTaskScript('~/ros2_ws/src/roside_stm32_base/firmware','/dev/ttyUSB1','ROSIDE_TEST_DONE_');`,helperContext);
  const shellCheck=spawnSync('bash',['-n'],{input:helperContext.uploadTask,encoding:'utf8'});
  assert.equal(shellCheck.status,0,shellCheck.stderr);
  assert.match(helperContext.uploadTask,/--target upload --upload-port '\/dev\/ttyUSB1'/);
});

test('robot tuning follows motor count, verifies controller protocol, and handles serial permissions', () => {
  const html=read('public/tune.html'),tune=read('public/tune.js'),hardware=read('public/hardware.js'),dashboard=read('public/dashboard.js'),server=read('server.js'),scanner=read('project-scanner.js');
  assert.match(server,/app\.get\('\/tune'.+tune\.html/);
  assert.match(dashboard,/robotTune:true/);
  assert.match(dashboard,/window\.location\.assign\('\/tune'\)/);
  assert.ok(dashboard.indexOf("'hardware','pid','control'")>0);
  assert.match(html,/id="tune-port"/);
  assert.match(html,/id="protocol-state"/);
  assert.match(html,/id="rpm-chart"/);
  assert.match(html,/id="gyro-chart"/);
  assert.match(html,/id="gyro-x"/);
  assert.match(html,/tune\.js\?v=20260828-control-mode10/);
  assert.match(html,/data-test="forward"/);
  assert.match(tune,/\/ws\/controller-tune/);
  assert.match(tune,/data\.event==='port_open'/);
  assert.match(tune,/data\.event!==\'frame\'/);
  assert.match(tune,/data\.kind==='RPM'/);
  assert.match(tune,/data\.kind==='GYRO'/);
  assert.match(tune,/function drawGyroChart\(/);
  assert.match(tune,/function configuredGyro\(config\)/);
  assert.match(tune,/pidControlEnabled=hardwareConfig\.pidControl!==false/);
  assert.match(tune,/\$\('pid-card'\)\.hidden=!pidControlEnabled/);
  assert.match(tune,/!pidControlEnabled\|\|pidAcks>0/);
  assert.match(tune,/hasEncoder/);
  assert.match(tune,/gyroCapability\.enabled/);
  assert.match(tune,/state\('gyro-state','NO DATA'/);
  assert.match(tune,/state\('rpm-state','NO DATA'/);
  assert.match(html,/id="gyro-card"/);
  assert.match(html,/id="pid-card"/);
  assert.match(html,/id="gyro-state-row"/);
  assert.match(tune,/motorList\(config\)/);
  assert.match(tune,/motorCount:motors\.length/);
  assert.match(tune,/P \$\{values\.join\(' '\)\}/);
  assert.match(tune,/data\.event==='permission_denied'/);
  assert.match(tune,/fixSerialPermission/);
  assert.match(tune,/api\('\/api\/serial\/prepare'/);
  assert.match(hardware,/api\('\/api\/serial\/prepare'/);
  assert.match(server,/app\.post\('\/api\/serial\/prepare'/);
  assert.match(server,/ensureRobotSerialAccess/);
  assert.match(tune,/api\('\/api\/serial\/ports'/);
  assert.match(server,/app\.post\('\/api\/serial\/ports'/);
  assert.match(server,/discoverRobotSerialPorts/);
  assert.match(tune,/controller_tune\.json/);
  assert.match(tune,/src\/roside_controller_bridge\/config\/controller\.yaml/);
  assert.match(tune,/protocolVerified:true/);
  assert.match(server,/\/ws\/controller-tune/);
  assert.match(server,/kind=='RPM'.+motor_count\*2/);
  assert.match(server,/kind=='ODOM'.+len\(fields\)==7/);
  assert.match(server,/kind=='PID'.+motor_count\*3/);
  assert.match(server,/kind in \('GYRO','IMU'\)/);
  assert.match(server,/serial_buffer\.split\(b'\\\\n',1\)/);
  assert.doesNotMatch(server,/ser\.readline\(\)\.decode\('ascii'/);
  assert.match(server,/event='permission_denied' if denied else 'error'/);
  assert.match(scanner,/tuneVerified/);
  assert.match(hardware,/P <Lkp> <Lki> <Lkd> <Rkp> <Rki> <Rkd>/);
  assert.match(hardware,/left_kp/);
  assert.match(hardware,/right_kd/);
  assert.match(hardware,/function applyGyroTelemetry\(/);
  assert.match(hardware,/Serial\.print\("GYRO "\)/);
  assert.match(hardware,/ledcSetup\(i, 20000, 8\)/);
  assert.match(hardware,/kRpmFilterAlpha = 0\.22f/);
  assert.match(hardware,/feedforward_pwm/);
  assert.match(hardware,/integral_limit/);
  assert.match(hardware,/applyMotorSlew/);

  const fixture=fs.mkdtempSync('/tmp/roside-tune-evidence-');
  fs.mkdirSync(path.join(fixture,'src','demo'),{recursive:true});
  fs.writeFileSync(path.join(fixture,'src','demo','pid.py'),'kp=1.0\nki=2.0\nkd=0.0\n');
  const scan=()=>{const script64=Buffer.from(buildProjectScanScript(fixture)).toString('base64'),result=spawnSync('python3',['-c',`import base64;exec(base64.b64decode('${script64}'))`],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return parseProjectScanOutput(result.stdout).capabilities.find(item=>item.id==='pid');};
  try{
    assert.equal(scan().tuneVerified,false);
    fs.mkdirSync(path.join(fixture,'.roside'),{recursive:true});
    fs.writeFileSync(path.join(fixture,'.roside','controller_tune.json'),JSON.stringify({drive:'diff2',protocolVerified:true,leftPid:{kp:1,ki:2,kd:0},rightPid:{kp:1.1,ki:2.1,kd:0}}));
    assert.equal(scan().tuneVerified,true);
    fs.writeFileSync(path.join(fixture,'.roside','controller_tune.json'),JSON.stringify({drive:'diff2',protocolVerified:true,pidControl:false,rpmFrames:4}));
    assert.equal(scan().tuneVerified,true);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});}
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

test('SIM LiDAR mission opens Map Editor and stores an installable hardware choice', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js'), map=read('public/map.js'), server=read('server.js');
  assert.match(server,/robotName:robot\.name,isSim:isSim\(robot\.robot_key\)/);
  assert.match(server,/rosInfo:s\.rosInfo,isSim:isSim\(s\.robotKey\)/);
  assert.match(dashboard,/id === 'lidar' && isSimWorkspace/);
  assert.match(dashboard,/page: 'map'/);
  assert.match(dashboard,/action: 'เปิด Map Editor'/);
  assert.match(dashboard,/info\.page==='map'.*initMapEditor/);
  assert.match(html,/id="map-lidar-brand"[^>]+mapLidarBrandChanged/);
  assert.match(html,/id="map-lidar-model"[^>]+mapLidarModelChanged/);
  assert.match(html,/id="map-lidar-driver"[^>]+mapOpenLidarDriver\(\)/);
  assert.match(map,/const MAP_LIDAR_CATALOG/);
  assert.match(map,/lidar: \{ brand:'', model:'', sensorType:'', driverPackage:'', driverRepository:'' \}/);
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

test('3D Map Editor stores metric objects and keeps legacy simulation walls', () => {
  const html=read('public/index.html'), editor=read('public/map3d.js'), server=read('server.js'), dashboard=read('public/dashboard.js');
  assert.match(html,/id="map3d-container"/);
  assert.match(editor,/const MAP3D_ASSETS=/);
  const assetBlock=editor.slice(editor.indexOf('const MAP3D_ASSETS=['),editor.indexOf('].map(([id,type,label,icon,category,defaults={}])'));
  assert.equal((assetBlock.match(/\['[^']+','[^']+','[^']+'/g)||[]).length,39);
  for (const asset of ['wall','door','table','chair','sofa','double-bed','refrigerator','whiteboard','charging-station','start']) assert.match(editor,new RegExp(`'${asset}'`),asset);
  assert.match(html,/id="map3d-palette"/);
  assert.match(html,/id="map3d-robot-config-layout"/);
  assert.match(html,/class="map3d-library"/);
  assert.match(html,/class="map3d-library-scroll"/);
  assert.match(html,/class="map3d-save-top"/);
  assert.match(html,/id="map3d-save"[^>]*>[\s\S]*?บันทึกแผนที่ simulation/);
  assert.match(html,/class="map3d-stage-badge"/);
  assert.match(editor,/window\.addEventListener\('roside-theme-change',map3dApplyWorkspaceTheme\)/);
  assert.match(html,/id="map3d-template-modal"/);
  assert.match(html,/map3dOpenTemplates\(\)/);
  assert.doesNotMatch(html,/onclick="map3dLoad\(\)"/);
  assert.doesNotMatch(html,/onclick="map3dApplyToSim\(\)"/);
  assert.match(editor,/บ้าน 2 ห้องนอน \+ 2 ห้องนั่งเล่น/);
  assert.match(editor,/function map3dBuildFamilyHome/);
  assert.equal((editor.match(/build:map3dBuild[A-Za-z]+/g)||[]).length,6);
  assert.match(html,/id="map3d-unit"[\s\S]+value="m"[\s\S]+value="cm"[\s\S]+value="mm"/);
  assert.match(html,/id="map3d-lidar-modal"/);
  assert.match(html,/hideOnPages = \[[^\]]+'map'/);
  assert.match(editor,/mapData\.units='m'/);
  assert.match(editor,/mapData\.editorUnit=map3d\.unit/);
  assert.match(editor,/mapData\.walls=lines/);
  assert.match(editor,/mapData\.start=start\?/);
  assert.match(editor,/mapData\.start=start\?\[map3dRound\(start\.x\),map3dRound\(start\.y\)\]:\[0,0\]/);
  assert.match(editor,/mapData\.startPose=start\?/);
  assert.match(editor,/function map3dSyncLegacy/);
  assert.match(editor,/function map3dApplyProps/);
  assert.match(editor,/function map3dAutoLoad/);
  assert.match(editor,/function map3dReturnToWizard\(\)[\s\S]+window\.switchPage\('dashboard'\)[\s\S]+loadDashboard\(\)/);
  assert.match(editor,/บันทึกและรัน \/sim_robot_mapsim แล้ว[\s\S]{0,160}map3dReturnToWizard\(\)/);
  assert.match(editor,/path:'~\/map\.json'/);
  assert.match(editor,/\/api\/sim\/apply-map/);
  assert.match(editor,/\/api\/sim\/run-mapsim/);
  assert.match(server,/app\.post\('\/api\/sim\/run-mapsim'/);
  assert.match(server,/cat install\/\.colcon_install_layout/);
  assert.match(server,/= \"merged\"/);
  assert.match(server,/colcon build --merge-install --packages-select sim_robot_mapsim/);
  assert.match(server,/colcon build --packages-select sim_robot_mapsim/);
  assert.match(server,/node:'\/sim_robot_mapsim'/);
  assert.match(dashboard,/pkg:'sim_robot_mapsim', exe:'mapsim'/);
  assert.match(genMapsimFiles()['setup.cfg'],/install_scripts=\$base\/lib\/sim_robot_mapsim/);
  assert.match(genMapsimFiles()['package.xml'],/<license>Apache-2\.0<\/license>/);
  assert.match(genMapsimFiles()['package.xml'],/<build_type>ament_python<\/build_type>/);
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

test('RViz page uses a desktop-compatible shell without replacing visualization logic', () => {
  const html=read('public/index.html'), rviz=read('public/rviz.js');
  assert.match(html,/class="rviz-menubar"/);
  assert.match(html,/class="rviz-desktop-toolbar"/);
  assert.match(html,/id="rviz-panel"[^>]+aria-label="Displays"/);
  assert.match(html,/id="rviz-views-panel"[^>]+aria-label="Views"/);
  assert.match(html,/class="rviz-time-panel"/);
  assert.match(html,/id="rviz-3d-container"/);
  for(const id of ['btn-rviz-connect','rviz-fixed-frame-sel','rviz-display-list','rviz-teleop','rv-pos','rv-yaw','rv-scan-pts']) {
    assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);
  }
  assert.match(rviz,/rvizAddDisplay\('RobotModel'/);
  assert.match(rviz,/if\(p\.desc[\s\S]{0,200}_applyRobotDescription/);
  assert.match(rviz,/function rvizSelectSavedView/);
  for(const tool of ['interact','move','select','focus','measure','initialpose','goal','point']) assert.match(html,new RegExp(`data-rviz-tool="${tool}"`),tool);
  assert.match(html,/id="rviz-toolbar-frame"/);
  assert.match(html,/Tool Properties/);
  assert.match(rviz,/geometry_msgs\/msg\/PoseWithCovarianceStamped/);
  assert.match(rviz,/geometry_msgs\/msg\/PoseStamped/);
  assert.match(rviz,/geometry_msgs\/msg\/PointStamped/);
  assert.match(rviz,/function _toolGroundPoint/);
  assert.match(rviz,/showAxes/);
  assert.match(rviz,/showArrows/);
});

test('Robot Playground reuses RViz runtime and starts the saved MapSim world', () => {
  const html=read('public/index.html'),app=read('public/app.js'),rviz=read('public/rviz.js'),playground=read('public/playground.js'),server=read('server.js'),sim=read('sim.js');
  assert.match(html,/id="page-playground"/);
  assert.match(html,/Robot Playground/);
  assert.match(html,/switchPage\('playground'\)/);
  assert.match(html,/id="playground-view-host"/);
  assert.match(app,/p==='playground'/);
  assert.match(playground,/playgroundUseViewport/);
  assert.match(playground,/rvizUseDesktopLayout/);
  assert.match(playground,/path:'~\/map\.json'/);
  assert.match(playground,/\/api\/sim\/run-mapsim/);
  assert.match(playground,/rvizTeleopSet/);
  assert.match(playground,/setPointerCapture/);
  assert.match(playground,/lostpointercapture/);
  assert.match(rviz,/function _smoothDynamicVisuals/);
  assert.match(rviz,/renderFrames/);
  assert.match(sim,/src\/sim_robot_tf\/urdf\/robot\.urdf/);
  assert.match(sim,/self\.desc_timer=self\.create_timer\(2\.0,self\._publish_description\)/);
  assert.doesNotMatch(playground,/button\.addEventListener\('pointerleave'/);
  assert.match(playground,/function playgroundRenderMapObjects/);
  assert.match(rviz,/Map:\{label:'Map'/);
  assert.match(rviz,/OccupancyGrid/);
  assert.match(rviz,/function _applyMap/);
  assert.match(playground,/d\.type==='TF'&&d\.enabled/);
  assert.match(rviz,/lastMapSig===sig/);
  assert.match(rviz,/cy=w-1-x/);
  assert.match(playground,/mesh\.rotation\.y=rotation\*Math\.PI\/180/);
  assert.match(rviz,/const TELEOP_RATE = 60/);
  assert.match(rviz,/_teleopWriteChain=_teleopWriteChain/);
  assert.match(rviz,/rvizTeleop\.curLin = 0; rvizTeleop\.curAng = 0/);
  assert.match(server,/_sim_state_pub\[\.\]py/);
  assert.match(sim,/self\.odom_pub=self\.create_publisher\(Odometry,'\/odom'/);
  assert.match(sim,/self\.map_pub=self\.create_publisher\(OccupancyGrid,'\/map',ST\)/);
  assert.match(sim,/map_tf\.header\.frame_id='map'; map_tf\.child_frame_id='odom'/);
  assert.match(sim,/laser_tf\.header\.frame_id='base_link'; laser_tf\.child_frame_id='laser_frame'/);
  assert.match(sim,/self\.br\.sendTransform\(\[map_tf,tf,laser_tf\]\)/);
  assert.match(sim,/laser_x=self\.x\+0\.2\*math\.cos\(self\.th\)/);
  assert.match(sim,/return float\('inf'\)/);
  assert.match(rviz,/if\(!framePose\)\{geo\.setDrawRange\(0,0\)/);
});

test('Robot Config follows the app theme and saves TF, model, and wheel odometry packages', () => {
  const html=read('public/index.html'),transformation=read('public/transformation.js');
  assert.match(html,/id="tf-theme-linked"/);
  assert.match(html,/class="btn tf-primary-save tf-save-action"/);
  assert.match(transformation,/window\.addEventListener\('roside-theme-change', tfApplyWorkspaceTheme\)/);
  assert.match(transformation,/async function tfSaveToWorkspace\(\)/);
  assert.match(transformation,/'urdf\/robot\.urdf':\s+tfBuildURDF\(\)/);
  assert.match(transformation,/'tf_model\.json':\s+tfBuildModelJSON\(\)/);
  assert.match(transformation,/API\('\/api\/sim\/save-tf-package'/);
  assert.match(transformation,/API\('\/api\/sim\/save-odom-package'/);
  assert.match(transformation,/const odomFiles = .*tfOdomPackageFiles\(\)/);
  assert.match(transformation,/window\.switchPage\('dashboard'\)/);
  assert.match(transformation,/typeof loadDashboard === 'function'/);
  assert.match(read('server.js'),/app\.post\('\/api\/sim\/save-robot-config'/);
});

test('Robot Config templates replace old 3D objects and create the expected drive layouts', () => {
  const html=read('public/index.html');
  const transformation=read('public/transformation.js');
  const source=transformation+'\n;globalThis.__tf=tf;globalThis.__templates=TF_ROBOT_TEMPLATES;globalThis.__apply=tfApplyRobotTemplate;globalThis.__clear=tfClearRenderedComponents;';
  const storage=new Map(),context={
    window:{addEventListener:()=>{},confirm:()=>true},
    document:{getElementById:()=>null,querySelectorAll:()=>[]},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    requestAnimationFrame:()=>{},performance:{now:()=>0},setTimeout,
    sbMsg:()=>{},escH:value=>String(value),encArg:value=>String(value),
    console,JSON,Math,Object,Array,Set,Map,parseInt,isNaN,
  };
  vm.runInNewContext(source,context);
  const expected={differential:[2,'differential'],skid:[4,'skid'],omni3:[3,'omni3'],omni4:[4,'omni4'],mecanum:[4,'mecanum'],rover6:[6,'skid']};
  for(const [kind,[wheelCount,pattern]] of Object.entries(expected)){
    context.__apply(kind);
    const wheels=context.__tf.comps.filter(part=>part.type==='wheel'||part.type==='omni');
    assert.equal(wheels.length,wheelCount,kind);
    assert.equal(context.__tf.odom.pattern,pattern,kind);
    assert.ok(wheels.every(wheel=>wheel.parent==='base_link'),kind);
    assert.ok(context.__tf.comps.some(part=>part.type==='lidar'),kind+' lidar');
    assert.ok(context.__tf.comps.some(part=>part.type==='imu'),kind+' imu');
  }
  let removed=0,geometryDisposed=0,materialDisposed=0,textureDisposed=0;
  const oldGroup={parent:{remove:target=>{assert.equal(target,oldGroup);removed++}},traverse:visit=>visit({geometry:{dispose:()=>geometryDisposed++},material:{map:{dispose:()=>textureDisposed++},dispose:()=>materialDisposed++}})};
  const stale=context.__tf.comps[0];stale.group=oldGroup;stale.label={};stale._mat={};
  context.__clear(context.__tf.comps);
  assert.equal(removed,1);
  assert.equal(geometryDisposed,1);
  assert.equal(materialDisposed,1);
  assert.equal(textureDisposed,1);
  assert.equal(stale.group,null);
  assert.equal(stale.label,null);
  const applyBlock=transformation.slice(transformation.indexOf('function tfApplyRobotTemplate'),transformation.indexOf('// เพิ่มคู่ เอนโคเดอร์'));
  assert.ok(applyBlock.indexOf('tfClearRenderedComponents(tf.comps)')<applyBlock.indexOf('tf.comps=['));
  assert.match(transformation,/function tfBuildScene\(\)[\s\S]{0,100}tfClearRenderedComponents\(tf\.comps\)/);
  assert.equal(Object.keys(context.__templates).length,6);
  assert.match(html,/class="tf-panel-scroll"/);
  assert.match(html,/id="tf-template-modal"/);
  assert.match(html,/onclick="tfOpenTemplateModal\(\)"/);
});

test('Robot Playground builds a progressive SLAM map and exports a Nav2 package', () => {
  const html=read('public/index.html'),playground=read('public/playground.js'),rviz=read('public/rviz.js'),sim=read('sim.js'),server=read('server.js');
  assert.match(html,/Robot Playground — Drive, Map & Navigate/);
  for(const id of ['pg-slam-percent','pg-slam-progress','pg-map-name','pg-save-map-btn','pg-save-result'])assert.match(html,new RegExp(`id="${id}"`),id);
  for(const layer of ['Environment','Map','RobotModel','LaserScan','Odometry','TF'])assert.match(html,new RegExp(`playgroundToggleLayer\\('${layer}'`),layer);
  assert.match(playground,/['"]\/slam_map['"]/);
  assert.match(playground,/function playgroundUpdateSlamProgress/);
  assert.match(playground,/\/api\/sim\/save-slam-map/);
  assert.match(rviz,/known.*occupied/);
  assert.match(sim,/create_publisher\(OccupancyGrid,'\/slam_map',ST\)/);
  assert.match(sim,/create_service\(Trigger,'\/save_slam_map'/);
  assert.match(sim,/def _integrate_slam_scan/);
  assert.match(sim,/sim_robot_nav_map/);
  assert.match(sim,/map\.pgm/);
  assert.match(sim,/map\.yaml/);
  assert.match(server,/app\.post\('\/api\/sim\/save-slam-map'/);
  assert.match(server,/colcon build[^\n]+sim_robot_nav_map/);
});

test('Robot Playground separates mapping and kid-friendly Navigation missions', () => {
  const html=read('public/index.html'),playground=read('public/playground.js'),rviz=read('public/rviz.js'),sim=read('sim.js'),server=read('server.js');
  for(const mode of ['mapping','navigation'])assert.match(html,new RegExp(`data-mode="${mode}"`));
  for(const id of ['pg-nav-speed','pg-nav-obstacle','pg-nav-tolerance','pg-nav-distance'])assert.match(html,new RegExp(`id="${id}"`));
  for(const preset of ['safe','balanced','sport'])assert.match(html,new RegExp(`data-preset="${preset}"`));
  assert.match(playground,/function playgroundStartNavigation/);
  assert.match(playground,/function playgroundApplyNavParams/);
  assert.match(playground,/API\('\/api\/sim\/configure-navigation'/);
  assert.match(server,/app\.post\('\/api\/sim\/configure-navigation'/);
  assert.match(sim,/_check_web_nav_config/);
  assert.match(playground,/if\(playgroundNavStarting\)/);
  assert.match(playground,/playgroundNavStarting=true/);
  assert.match(server,/const mapsimLaunches = new Set\(\)/);
  assert.match(server,/mapsimLaunches\.has\(s\.robotKey\)/);
  assert.match(rviz,/playgroundPosePublished/);
  assert.match(rviz,/playgroundUpdateNavPose/);
  assert.match(sim,/create_subscription\(PoseStamped,'\/goal_pose'/);
  assert.match(sim,/create_subscription\(PoseWithCovarianceStamped,'\/initialpose'/);
  assert.match(sim,/create_service\(Trigger,'\/cancel_navigation'/);
  assert.match(sim,/def _nav_command/);
  assert.match(sim,/moving=abs\(float\(msg\.linear\.x\)\)>1e-4/);
  assert.match(sim,/self\.last_cmd_time=time\.time\(\) if moving else 0\.0/);
  for(const id of ['pg-nav-map-select','pg-nav-ready-badge','pg-nav-checks','pg-nav-error'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(playground,/function playgroundLoadNavMaps/);
  assert.match(playground,/function playgroundSelectNavMap/);
  assert.match(playground,/if\(!playgroundSelectedMap\|\|!playgroundNavReady\)/);
  assert.match(server,/app\.post\('\/api\/sim\/navigation-readiness'/);
  assert.match(server,/app\.post\('\/api\/sim\/select-navigation-map'/);
  assert.match(server,/app\.post\('\/api\/sim\/navigation-goal'/);
  assert.match(server,/_nav_goal_ack\.json/);
  assert.match(sim,/def _load_selected_nav_map/);
  assert.match(sim,/def _check_web_goal/);
  assert.match(rviz,/\/api\/sim\/navigation-goal/);
  assert.match(sim,/def _plan_nav_path/);
  assert.match(sim,/heapq\.heappush/);
  assert.match(sim,/nav_inflation_radius/);
  assert.match(sim,/create_publisher\(Path,'\/plan'/);
  for(const id of ['pg-nav-inflation','pg-nav-lookahead'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(rviz,/function _applyPath/);
});

test('Motion Control mission opens the drive-only Robot Playground mode',()=>{
  const html=read('public/index.html'),playground=read('public/playground.js'),dashboard=read('public/dashboard.js');
  assert.match(dashboard,/control:\s+\{[^\n]+page:'playground', playgroundMode:'control'/);
  assert.match(html,/data-mode="control"[^>]+playgroundSetMode\('control'\)/);
  assert.match(html,/data-pg-mode="mapping control"[^>]*>[\s\S]*pg-drive-btn/);
  assert.match(playground,/\['control','mapping','navigation'\]\.includes\(mode\)/);
  assert.match(playground,/function playgroundStartControl\(\)/);
  assert.match(playground,/playgroundMode==='control'\?playgroundStartControl\(\)/);
});

test('Navigation mode exports a portable Nav2 package and install guide',()=>{
  const fixture=fs.mkdtempSync('/tmp/roside-nav-export-'),mapDir=path.join(fixture,'maps','school_map');
  fs.mkdirSync(mapDir,{recursive:true});fs.writeFileSync(path.join(mapDir,'map.pgm'),'P5\n1 1\n255\n\xff','binary');fs.writeFileSync(path.join(mapDir,'map.yaml'),'image: map.pgm\nresolution: 0.05\norigin: [0, 0, 0]\n');
  fs.writeFileSync(path.join(fixture,'map.json'),JSON.stringify({lidar:{brand:'ydlidar',model:'x4',driverPackage:'ydlidar'}}));
  try{
    const result=writeNavigationPackage(fixture,'school_map',{speed:.7,inflation:.35,lookahead:.5,tolerance:.18});
    const pkg=path.join(fixture,'src','mecha_rayong_nav');
    for(const file of ['package.xml','CMakeLists.txt','launch/navigation.launch.py','config/nav2_params.yaml','maps/map.pgm','maps/map.yaml','install_dependencies.sh','README.md'])assert.equal(fs.existsSync(path.join(pkg,file)),true,file);
    assert.match(fs.readFileSync(path.join(pkg,'launch/navigation.launch.py'),'utf8'),/bringup_launch\.py/);
    assert.match(fs.readFileSync(path.join(pkg,'config/nav2_params.yaml'),'utf8'),/desired_linear_vel: 0\.70/);
    assert.match(fs.readFileSync(path.join(pkg,'install_dependencies.sh'),'utf8'),/ros-\$\{ROS_DISTRO\}-nav2-bringup/);
    assert.equal(result.packageName,'mecha_rayong_nav');
    writeProjectInstaller(fixture,'school_map');
    assert.match(fs.readFileSync(path.join(fixture,'install_project.sh'),'utf8'),/rosdep install --from-paths src/);
    assert.match(fs.readFileSync(path.join(fixture,'install_project.sh'),'utf8'),/install_lidar_driver\.sh/);
    const lidarInstaller=fs.readFileSync(path.join(fixture,'install_lidar_driver.sh'),'utf8');
    assert.match(lidarInstaller,/https:\/\/github\.com\/YDLIDAR\/ydlidar_ros2/);
    assert.match(lidarInstaller,/startup.*initenv\.sh/s);
    assert.equal(spawnSync('bash',['-n',path.join(fixture,'install_lidar_driver.sh')],{encoding:'utf8'}).status,0);
    assert.equal(spawnSync('bash',['-n',path.join(fixture,'install_project.sh')],{encoding:'utf8'}).status,0);
    assert.match(fs.readFileSync(path.join(fixture,'INSTALL_PROJECT.md'),'utf8'),/complete ROS 2 source workspace export/);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});}
  const html=read('public/index.html'),playground=read('public/playground.js'),server=read('server.js');
  assert.match(html,/id="btn-nav-export"[^>]+playgroundOpenNavExport\(\)/);
  assert.match(html,/id="pg-nav-export-modal"[^>]+role="dialog"/);
  assert.match(html,/id="pg-install-command"/);
  assert.match(playground,/function playgroundExportNavigation\(\)/);
  assert.match(playground,/function playgroundPrepareNavigationPackage\(/);
  assert.match(playground,/mode==='navigation'[\s\S]{0,250}playgroundPrepareNavigationPackage\(\)/);
  assert.match(server,/app\.post\('\/api\/sim\/prepare-navigation-package',auth/);
  assert.match(playground,/\/api\/sim\/export-navigation-project/);
  assert.match(server,/app\.post\('\/api\/sim\/export-navigation-project',auth/);
  assert.match(server,/res\.download\(archive,path\.basename\(archive\)\)/);
  assert.match(server,/mecha_rayong_project_\$\{mapName\}\.zip/);
  assert.match(server,/zip -qr[^\n]+src maps install_project\.sh install_lidar_driver\.sh INSTALL_PROJECT\.md/);
});

test('LiDAR selection links to the requested repositories and exports the RPLIDAR ROS 2 branch',()=>{
  const map=read('public/map.js'),html=read('public/index.html'),fixture=fs.mkdtempSync('/tmp/roside-rplidar-export-');
  try{
    fs.writeFileSync(path.join(fixture,'map.json'),JSON.stringify({lidar:{brand:'slamtec',model:'rplidar_a1m8'}}));
    const generated=writeProjectInstaller(fixture,'school_map');
    const script=fs.readFileSync(generated.lidarInstaller,'utf8');
    assert.match(script,/https:\/\/github\.com\/CreedyNZ\/rplidar_ros2/);
    assert.match(script,/DRIVER_BRANCH="ros2"/);
    assert.match(script,/--packages-select "\$DRIVER_PACKAGE"/);
    assert.equal(spawnSync('bash',['-n',generated.lidarInstaller],{encoding:'utf8'}).status,0);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});}
  assert.match(map,/https:\/\/github\.com\/YDLIDAR\/ydlidar_ros2/);
  assert.match(map,/https:\/\/github\.com\/CreedyNZ\/rplidar_ros2/);
  assert.match(map,/function mapOpenLidarDriver\(\)/);
  assert.match(html,/id="map-lidar-driver"[^>]+mapOpenLidarDriver\(\)/);
});

test('RViz pose and goal tools work with one-finger tablet gestures', () => {
  const html=read('public/index.html'),rviz=read('public/rviz.js');
  assert.match(html,/playground-mode #rviz-3d-container[^\{]*\{touch-action:none\}/);
  assert.match(rviz,/let touchToolActive=false,touchLast=null/);
  assert.match(rviz,/\['focus','measure','initialpose','goal','point','select'\]\.includes\(tool\)/);
  assert.match(rviz,/changedTouches\[0\]/);
  assert.match(rviz,/if\(b&&\(tool==='initialpose'\|\|tool==='goal'\)\)_finishPoseTool\(tool,a,b\)/);
});

test('top bar provides an active ROS Wizzard icon shortcut', () => {
  const html=read('public/index.html'), app=read('public/app.js');
  assert.match(html,/id="btn-wizard"[^>]+switchPage\('dashboard'\)[^>]+aria-label="เปิด ROS Wizzard"/);
  assert.match(app,/btn-wizard.+classList\.toggle\('active',p==='dashboard'\)/);
});

test('real robot connections hide and block every simulation workspace entry', () => {
  const html=read('public/index.html'),app=read('public/app.js'),dashboard=read('public/dashboard.js'),playground=read('public/playground.js');
  for(const id of ['btn-nav-export','page-playground','page-map']){
    assert.match(html,new RegExp(`id="${id}"[^>]*data-simulation-only|data-simulation-only[^>]*id="${id}"`),id);
  }
  assert.equal((html.match(/class="td-item" data-simulation-only/g)||[]).length,2);
  assert.match(html,/\.real-robot-mode \[data-simulation-only\]\{display:none!important\}/);
  assert.match(app,/const SIMULATION_PAGES = new Set\(\['map', 'playground'\]\)/);
  assert.match(app,/if\(!isSimWorkspace && SIMULATION_PAGES\.has\(p\)\)/);
  assert.match(app,/function applySimulationVisibility\(\)/);
  assert.match(dashboard,/typeof d\.isSim === 'boolean' \? d\.isSim : simFromProject/);
  assert.match(dashboard,/info\.simulationOnly && !isSimWorkspace/);
  assert.match(playground,/function initRobotPlayground\(\)\{\n  if\(!isSimWorkspace\)return;/);
});

test('real robot Motion Control connects Controller and LiDAR with ODOM driving view',()=>{
  const html=read('public/index.html'),dashboard=read('public/dashboard.js');
  for(const id of ['real-teleop-modal','real-teleop-stop','real-teleop-linear','real-teleop-angular','real-controller-port','real-controller-connect','real-lidar-model','real-lidar-port','real-teleop-map','real-odom-x','real-odom-y','real-odom-yaw'])assert.match(html,new RegExp(`id="${id}"`),id);
  assert.match(html,/ฝึกบังคับหุ่นยนต์จริง/);
  assert.equal((html.match(/class="real-teleop-btn" data-dir=/g)||[]).length,4);
  assert.match(dashboard,/realTeleop: true/);
  assert.match(dashboard,/function openRealRobotTeleop\(\)/);
  assert.match(dashboard,/addEventListener\('pointercancel',up\)/);
  assert.match(dashboard,/addEventListener\('lostpointercapture',up\)/);
  assert.match(dashboard,/window\.addEventListener\('blur'/);
  assert.match(dashboard,/\/ws\/controller-tune/);
  assert.match(dashboard,/\/ws\/lidar/);
  assert.match(dashboard,/API\('\/api\/serial\/ports'/);
  assert.match(dashboard,/API\('\/api\/serial\/prepare'/);
  assert.match(dashboard,/API\('\/api\/lidar\/driver'/);
  assert.match(dashboard,/data\.kind==='ODOM'/);
  assert.match(dashboard,/realOdomTrail\.push/);
  assert.match(dashboard,/function realTeleopDrawMap\(\)/);
  assert.match(dashboard,/w:'fwd'.+a:'left'.+d:'right'/);
  assert.match(dashboard,/event\.code==='Space'/);
  assert.match(dashboard,/V \$\{vx\.toFixed\(4\)\} 0 \$\{wz\.toFixed\(4\)\}/);
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

test('every main workspace page has a contextual beginner guide', () => {
  const html=read('public/index.html'),app=read('public/app.js'),guide=read('public/guide.js');
  for(const id of ['editor','terminal','dashboard','status','monitor','flow','run','playground','rviz','transformation','map','3dcomp']){
    assert.match(html,new RegExp(`id="page-${id}"`),id);
    assert.match(guide,new RegExp(`(?:^|\\s|,)(?:'${id}'|${id}):\\{`),id+' guide');
  }
  for(const id of ['btn-page-guide','page-guide-overlay','page-guide-heading','page-guide-body','page-guide-auto'])assert.match(html,new RegExp(`id="${id}"`),id);
  assert.match(app,/typeof pageGuidePageChanged==='function'\) pageGuidePageChanged\(p\)/);
  assert.match(guide,/function openPageGuide\(/);
  assert.match(guide,/function closePageGuide\(/);
  assert.match(guide,/function pageGuidePageChanged\(/);
  assert.match(guide,/ros2ide_page_guide_seen_/);
  assert.match(guide,/ต้องไป Robot Playground โหมด Mapping และกด Save Map/);
  assert.match(html,/guide\.js\?v=20260812-guide1/);
});

test('every tool page exposes a top-right return to ROS Wizzard', () => {
  const html=read('public/index.html'),app=read('public/app.js');
  assert.match(html,/id="pages"[\s\S]{0,300}id="workspace-wizard-return"/);
  assert.match(html,/id="workspace-wizard-return"[^>]+onclick="returnToRosWizard\(\)"[^>]+aria-label="กลับไปหน้า ROS Wizzard"/);
  assert.match(html,/\.workspace-wizard-return\{position:absolute;z-index:110;top:10px;right:12px/);
  assert.match(app,/positionWorkspaceWizardReturn\(p\)/);
  assert.match(app,/function returnToRosWizard\(\)\{[\s\S]+switchPage\('dashboard'\);[\s\S]+loadDashboard\(true\)/);
  for(const selector of ['#btn-save','#btn-flow-save','#tf-right-panel .tf-save-action','#map3d-save','#dc-save-component'])assert.ok(app.includes(`'${selector}'`),selector);
  assert.match(app,/page==='playground'[\s\S]+#page-playground \.pg-head-actions[\s\S]+playground-header-action/);
  assert.match(app,/page==='terminal'[\s\S]+#page-terminal \.term-head-actions[\s\S]+terminal-header-action/);
  assert.doesNotMatch(app,/playground:'#pg-save-map-btn'/);
  assert.match(app,/function positionWorkspaceWizardReturn\(page\)/);
  assert.match(app,/save\.insertAdjacentElement\('afterend',button\);button\.classList\.add\('docked'\)/);
  assert.match(html,/\.workspace-wizard-return\.docked\{position:static/);
  assert.match(html,/id="dc-save-component"/);
});

test('shared support chat uses authenticated usernames and appears with the video helper',()=>{
  const server=read('server.js'),chat=read('public/youtube-help.js'),css=read('public/youtube-help.css'),schema=read('schema.sql');
  assert.match(server,/app\.get\('\/api\/support-chat\/messages',auth/);
  assert.match(server,/app\.post\('\/api\/support-chat\/messages',auth/);
  assert.match(server,/INSERT INTO support_chat_messages\(user_id,message\)/);
  assert.match(server,/req\.user\.id,message/);
  assert.doesNotMatch(server,/req\.body\?\.username/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS support_chat_messages/);
  assert.match(chat,/แชทแจ้งปัญหาถึง Admin/);
  assert.match(chat,/ห้องรวม · สมาชิกทุกคนมองเห็นข้อความ/);
  assert.match(chat,/setInterval\(\(\)=>loadMessages\(true\),4000\)/);
  assert.match(css,/\.support-chat-messages/);
  assert.match(server,/app\.post\('\/api\/support-chat\/presence',auth/);
  assert.match(server,/app\.get\('\/api\/support-chat\/presence',auth,adminOnly/);
  assert.match(chat,/class="support-unread-badge"/);
  assert.match(chat,/playNotificationSound\(\)/);
  assert.match(chat,/storedUser\.role==='admin'/);
  assert.match(chat,/class="support-presence-button"/);
  assert.match(chat,/setInterval\(sendPresence,20000\)/);
  for(const file of ['public/index.html','public/robots.html'])assert.match(read(file),/youtube-help\.js\?v=20260814-5/,file);
});

test('Robot Playground follows the workspace theme and updates its 3D background', () => {
  const html=read('public/index.html'),rviz=read('public/rviz.js'),playground=read('public/playground.js');
  assert.match(html,/Robot Playground — theme-aware workspace/);
  assert.match(html,/#page-playground\{[\s\S]+var\(--bg0\);color:var\(--txt\)/);
  assert.match(html,/#page-playground \.pg-side[^{]*\{[^}]+var\(--bg1\)/);
  assert.match(html,/workspace-wizard-return\.playground-header-action/);
  assert.match(rviz,/function rvizWorkspaceBackground\(\)[\s\S]+getPropertyValue\('--bg0'\)/);
  assert.match(rviz,/window\.addEventListener\('roside-theme-change',rvizApplyWorkspaceTheme\)/);
  assert.match(rviz,/setClearColor\(rvizWorkspaceBackground\(\),1\)/);
  assert.match(playground,/typeof rvizApplyWorkspaceTheme==='function'/);
});

test('real robot Mapping page collects SLAM layers and saves Nav2 map evidence',()=>{
  const server=read('server.js'),dashboard=read('public/dashboard.js'),html=read('public/mapping.html'),js=read('public/mapping.js'),scanner=read('project-scanner.js');
  assert.match(server,/app\.get\('\/mapping'/);
  assert.match(server,/app\.post\('\/api\/mapping\/runtime'/);
  assert.match(server,/app\.post\('\/api\/mapping\/save'/);
  assert.match(server,/ros2 launch slam_toolbox online_async_launch\.py/);
  assert.match(server,/map_saver_cli -f/);
  assert.match(server,/pathname==='\/ws\/mapping'/);
  for(const layer of ['map','scan','trail','robot'])assert.match(html,new RegExp(`data-layer="${layer}" checked`));
  assert.match(html,/ความเร็วตรง/);
  assert.match(html,/id="controller-port"/);
  assert.match(html,/id="lidar-port"/);
  assert.match(html,/id="refresh-ports"/);
  assert.match(js,/controllerPort/);
  assert.match(server,/req\.body\.controllerPort/);
  assert.match(server,/req\.body\.lidarPort/);
  assert.match(js,/CMD \$\{linear\} 0/);
  assert.match(html,/id="controller-state"/);
  assert.match(server,/serial\.Serial\(PORT,BAUD,timeout=0\)/);
  assert.match(server,/send\('V %\.4f 0 %\.4f'/);
  assert.match(js,/driveTimer=setInterval\(\(\)=>sendDrive\(kind\),100\)/);
  assert.match(js,/Controller TX →/);
  assert.match(html,/NO MAP DATA/);
  assert.match(dashboard,/realMapping: true/);
  assert.match(scanner,/mapping_result\.json/);
});

test('real robot Nav2 page reuses Mapping map and drives controller from cmd_vel',()=>{
  const server=read('server.js'),dashboard=read('public/dashboard.js'),html=read('public/navigation.html'),js=read('public/navigation.js');
  assert.match(server,/app\.get\('\/navigation'/);
  assert.match(server,/app\.post\('\/api\/navigation\/maps'/);
  assert.match(server,/app\.post\('\/api\/navigation\/runtime'/);
  assert.match(server,/nav2_bringup bringup_launch\.py/);
  assert.match(server,/NavigateToPose/);
  assert.match(server,/NavigateThroughPoses/);
  assert.match(server,/navigate_through_poses/);
  assert.match(server,/create_subscription\(Twist,'\/cmd_vel'/);
  assert.match(server,/pathname==='\/ws\/navigation'/);
  assert.match(dashboard,/realNavigation:\s*true/);
  assert.match(dashboard,/window\.location\.assign\('\/navigation'\)/);
  for(const id of ['map-select','controller-port','lidar-port','pose-mode','goal-mode','route-mode','run-route','nav-canvas'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/mapping_result\.json/);
  assert.match(js,/`POSE \$\{p\.x\}/);
  assert.match(js,/`GOAL \$\{p\.x\}/);
  assert.match(js,/send\('CANCEL'\)/);
  assert.match(js,/type:'route',points/);
});
