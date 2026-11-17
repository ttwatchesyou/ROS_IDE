'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { genMapsimFiles, SIM_STATE_PUB, SimEngine, wsRoot, toAbs, writeTfPackage, writeOdomPackage, robotCollides, motionIsClear, domainFor, reserveDomain, releaseDomain, buildSimProcessEnvironment } = require('../sim');
const { buildProjectScanScript, parseProjectScanOutput, inspectSimulationMissionArtifacts, completeSimulationWizardMapping, completeSimulationWizardNavigation, resetSimulationWizardAfterFieldChange, readSimulationWizardProgress } = require('../project-scanner');
const { writeNavigationPackage, writeProjectInstaller } = require('../navigation-export');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function runIsolatedServerScenario(scenario,{timeout=6000,report=false}={}){
  const bootstrap=`
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const serverPath=${JSON.stringify(path.join(root,'server.js'))};
const routes=new Map();
const route=(method)=>(pathname,...handlers)=>{routes.set(method+' '+pathname,handlers);return app;};
const app={set(){return app;},use(){return app;},get:route('GET'),post:route('POST'),put:route('PUT'),patch:route('PATCH'),delete:route('DELETE')};
function express(){return app;}
const middleware=()=> (_req,_res,next)=>{if(next)next();};
express.raw=middleware;express.json=middleware;express.static=middleware;
const httpServer={on(){return httpServer;},listen(){return httpServer;},close(done){if(done)done();}};
class FakeWebSocketServer{
  constructor(){this.clients=new Set();this.handlers=new Map();}
  on(event,handler){const list=this.handlers.get(event)||[];list.push(handler);this.handlers.set(event,list);return this;}
  emit(event,...args){for(const handler of this.handlers.get(event)||[])handler(...args);}
  handleUpgrade(_req,_socket,_head,done){done(makeSocket(null));}
}
const WebSocket={OPEN:1,CLOSED:3,Server:FakeWebSocketServer};
const pool={
  query(sql,params=[]){if(!globalThis.__query)throw new Error('No fake DB query handler for '+sql);return globalThis.__query(sql,params);},
  async getConnection(){return{query:(sql,params=[])=>pool.query(sql,params),async beginTransaction(){},async commit(){},async rollback(){},release(){}};},
  async end(){},
};
const scannerStub={
  buildProjectScanScript(){return 'slow project scan';},
  parseProjectScanOutput(){return{capabilities:[{id:'urdf',detected:true},{id:'tf',detected:true},{id:'odom',detected:true}]};},
  scanLocalProject(){return{capabilities:[]};},inspectSimulationMissionArtifacts(){return[];},
  readSimulationWizardProgress(){return{completed:{}};},resetSimulationWizardAfterFieldChange(){},
  completeSimulationWizardMapping(){},completeSimulationWizardNavigation(){},
};
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  if(parent&&parent.filename===serverPath){
    if(request==='express')return express;
    if(request==='http')return{createServer(){return httpServer;}};
    if(request==='ws')return WebSocket;
    if(request==='cors')return middleware;
    if(request==='mysql2/promise')return{createPool(){return pool;}};
    if(request==='./project-scanner')return scannerStub;
    if(request==='./mapsim-host-lock'&&process.env.ROSIDE_TEST_ROS!=='1')return {acquireMapsimHostLock:async()=>async()=>{}};
  }
  return originalLoad.call(this,request,parent,isMain);
};
let serverSource=fs.readFileSync(serverPath,'utf8');
const startMarker='\\nstart();',startAt=serverSource.lastIndexOf(startMarker);
assert.ok(startAt>=0&&serverSource.slice(startAt+startMarker.length).trim()==='', 'server bootstrap changed; update the isolated regression harness');
serverSource=serverSource.slice(0,startAt)+'\\nmodule.exports.__regressionHooks={sessions,agents,pendingReqs,webSockets,monSockets,robotPresenceSockets,robotProgressCache,dashboardRuntimeCache,authSessionCache,membershipCache,applicationCatalogCache,simRvizStreams,simRvizStreamsByTerm,robotControlLeases,robotRuntimeOperations,robotOnlineUserCount,getDashboardRuntime,getMembership,tokenUser,getApplicationCatalog,agentReq,routeAgentPtyMessage,validateSimMapData,wss,WebSocket};\\n';
const compiled=new Module(serverPath,module);compiled.filename=serverPath;compiled.paths=Module._nodeModulePaths(path.dirname(serverPath));
try{compiled._compile(serverSource,serverPath);}finally{Module._load=originalLoad;}
const hooks=compiled.exports.__regressionHooks;
function makeSocket(user){
  const handlers=new Map();
  return{user,readyState:WebSocket.OPEN,bufferedAmount:0,sent:[],
    on(event,handler){const list=handlers.get(event)||[];list.push(handler);handlers.set(event,list);return this;},
    emit(event,...args){for(const handler of handlers.get(event)||[])handler(...args);},
    send(payload){this.sent.push(JSON.parse(String(payload)));},
    close(code,reason){if(this.readyState===WebSocket.CLOSED)return;this.closeCode=code;this.closeReason=reason;this.readyState=WebSocket.CLOSED;this.emit('close');},
  };
}
function invoke(method,pathname,request={}){
  const handlers=routes.get(method+' '+pathname);assert.ok(handlers,'missing route '+method+' '+pathname);
  const handler=handlers[handlers.length-1];request.body=request.body||{};request.params=request.params||{};request.query=request.query||{};
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('route timeout '+method+' '+pathname));}},globalThis.__routeTimeout||1500);
    const response={statusCode:200,headers:{},status(code){this.statusCode=code;return this;},setHeader(key,value){this.headers[key]=value;return this;},json(body){finish({status:this.statusCode,body});return this;},send(body){finish({status:this.statusCode,body});return this;}};
    try{Promise.resolve(handler(request,response)).catch(reject);}catch(error){reject(error);}
  });
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
`;
  const result=spawnSync(process.execPath,['-e',bootstrap+`\n(async()=>{${scenario}\n})().then(()=>process.exit(0)).catch(error=>{console.error(error&&error.stack||error);process.exit(1);});`],{cwd:root,encoding:'utf8',timeout});
  assert.equal(result.status,0,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  if(report)console.log(result.stdout);
}

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

test('simulation uses modern localhost discovery without inheriting the deprecated ROS setting', () => {
  const environment=buildSimProcessEnvironment({
    ROS_DOMAIN_ID:'42',
    ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST',
  },{
    PATH:'/usr/bin',
    ROS_LOCALHOST_ONLY:'1',
  });
  assert.equal(environment.ROS_DOMAIN_ID,'42');
  assert.equal(environment.ROS_AUTOMATIC_DISCOVERY_RANGE,'LOCALHOST');
  assert.equal(environment.ROS_LOCALHOST_ONLY,undefined);
});

test('simulation lifecycle never leaves MapSim and fallback publishers running together', () => {
  const sim=read('sim.js'),server=read('server.js');
  assert.match(sim,/PID=\$\(cat '\$\{root\}\/tmp\/_mapsim\.pid'/);
  assert.match(sim,/resetBackend=\(\)=>remote\?remoteRequest\('exec'/);
  assert.match(sim,/const backendReady=resetBackend\(\)\.then\(\(\)=>startBackend\(\)\)/);
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

test('active simulations reserve unique ROS domains and release capacity', () => {
  // Capacity tests need an empty lease pool, not the live users' 230 domains.
  const fixture=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'sim-domain-capacity-'));
  const Module=require('node:module'),filename=path.join(root,'sim.js'),isolated=new Module(filename,module);
  isolated.filename=filename;isolated.paths=Module._nodeModulePaths(root);
  isolated._compile(read('sim.js').replace("const SIM_WS_ROOT = path.join(__dirname, 'sim_ws');",`const SIM_WS_ROOT = ${JSON.stringify(fixture)};`),filename);
  const {reserveDomain,releaseDomain,domainFor}=isolated.exports;
  const prefix=`SIM-domain-regression-${process.pid}-${Date.now()}`;
  const keys=Array.from({length:230},(_,index)=>`${prefix}-${index}`);
  const overflow=`${prefix}-overflow`;
  try{
    const domains=keys.map(key=>reserveDomain(key));
    assert.equal(new Set(domains).size,230,'every active simulation must have a distinct ROS domain');
    assert.ok(domains.every(domain=>Number.isInteger(domain)&&domain>=1&&domain<=230));
    assert.equal(reserveDomain(keys[0]),domains[0],'reserving the same simulation must be idempotent');
    assert.equal(domainFor(keys[0]),domains[0]);
    assert.throws(()=>reserveDomain(overflow),error=>error?.code==='SIM_DOMAIN_CAPACITY_REACHED');

    const releasedIndex=73,releasedDomain=domains[releasedIndex];
    releaseDomain(keys[releasedIndex],releasedDomain);
    assert.equal(reserveDomain(overflow),releasedDomain,'a closed simulation must return its domain to the pool');
    assert.equal(domainFor(overflow),releasedDomain);
  }finally{
    keys.forEach(key=>releaseDomain(key));
    releaseDomain(overflow);
    fs.rmSync(fixture,{recursive:true,force:true});
  }
});

test('SIM runtime leases isolate separate server processes and recover after a crash', async () => {
  const key=`SIM-cross-process-${process.pid}-${Date.now()}`,simPath=path.join(root,'sim.js');
  const child=spawn(process.execPath,['-e',`const sim=require(${JSON.stringify(simPath)});const domain=sim.reserveDomain(${JSON.stringify(key)});if(process.send)process.send({domain});setInterval(()=>{},1000);`],{stdio:['ignore','ignore','inherit','ipc']});
  try{
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child lease timeout')),3000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',reject);});
    assert.ok(Number.isInteger(ready.domain));
    assert.throws(()=>reserveDomain(key),error=>error?.code==='SIM_RUNTIME_ALREADY_ACTIVE');
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}
  }
  const recovered=reserveDomain(key);
  assert.ok(Number.isInteger(recovered),'a dead process lease must be reclaimed');
  releaseDomain(key,recovered);
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
  assert.match(mapsim,/if v==0\.0 or motion_is_clear\(self\.x,self\.y,next_x,next_y\)/);
  assert.match(mapsim,/ชนสิ่งกีดขวาง หุ่นหยุดแล้ว/);
});

test('privileged HTTP APIs require authentication', () => {
  const source = read('server.js');
  for (const route of ['exec','dashboard','files/list','files/read','files/write','files/mkdir','files/rename','files/delete']) {
    const escaped=route.replace('/', '\\/');
    assert.match(source, new RegExp(`app\\.post\\('/api/${escaped}',\\s*auth`), route);
  }
});

test('real-robot mapping save and Nav2 checks are bounded and exposed by the backend', () => {
  const server=read('server.js'),mapping=read('public/mapping.js');
  assert.match(server,/app\.post\('\/api\/mapping\/check',auth/);
  assert.match(server,/timeout --signal=TERM 18s ros2 run nav2_map_server map_saver_cli/);
  assert.match(mapping,/api\('\/api\/mapping\/save',[\s\S]*?,25000\)/);
  assert.match(mapping,/finally\{button\.disabled=!mapData;\}/);
  assert.match(mapping,/Server ยังไม่ได้โหลด API ตรวจแผนที่ กรุณารีสตาร์ต backend/);
});

test('real-robot Nav2 installation never builds an ros-unknown package name', () => {
  const server=read('server.js');
  assert.match(server,/function rosDistroForSession\(s,setupPath=''/);
  assert.match(server,/\['unknown','undefined','null','none'\]\.includes\(value\)/);
  assert.match(server,/distro=rosDistroForSession\(s,p\.setup\)/);
  assert.doesNotMatch(server,/distro=\(String\(s\.rosInfo\?\.distro/);
  assert.match(server,/source "\$setup"[\s\S]+ROS_DISTRO=/);
  assert.match(server,/dpkg --configure -a/);
  assert.match(server,/Acquire::Retries=3/);
  assert.match(server,/error\.commandTimedOut=timedOut/);
  assert.match(server,/const NAV2_INSTALL_JOB=/);
  assert.match(server,/async function startNavigationInstall/);
  assert.match(server,/roside-nav2-install[\s\S]+nohup bash/);
  assert.match(server,/res\.status\(202\)\.json\(\{ok:true,[^}]+installing:true/);
  assert.match(server,/ROSIDE_NAV2_PACKAGES=ready/);
  assert.match(server,/--no-install-recommends/);
  assert.match(server,/3600s apt-get/);
  assert.match(server,/status==='FAILED:124'/);
  assert.match(server,/holder_age[\s\S]+-ge 120/);
  assert.match(server,/install -y ros-\$\{distro\}-nav2-bringup ros-\$\{distro\}-nav2-amcl/);
  const navigation=read('public/navigation.js');
  assert.match(navigation,/action:'install-status'/);
  assert.match(navigation,/watchNavInstall\(\)/);
  assert.match(navigation,/function installProgressLine/);
  assert.match(navigation,/คุณไม่ต้องกดปุ่มซ้ำ/);
});

test('dashboard does not block system status on the source-code scan', () => {
  const server=read('server.js'),dashboard=read('public/dashboard.js');
  assert.match(server,/projectViewPromise=Promise\.race/);
  assert.match(server,/pending:true,workspace/);
  assert.match(server,/getDashboardRuntime\(s\),projectViewPromise/);
  assert.match(server,/expiresAt:Number\.POSITIVE_INFINITY/);
  assert.match(server,/timeout 3 ros2 node list/);
  assert.match(dashboard,/project\?\.pending/);
  assert.match(dashboard,/ผลภารกิจจะอัปเดตอัตโนมัติ/);
  assert.match(server,/app\.post\('\/api\/dashboard\/project'/);
  assert.match(dashboard,/void finishProjectScan\(\)/);
  assert.match(dashboard,/progressPercent\.textContent='…'/);
});

test('robots are listed newest first for admins and regular users', () => {
  const source = read('server.js');
  assert.match(source,/LEFT JOIN users u ON r\.added_by=u\.id ORDER BY r\.created_at DESC, r\.id DESC/);
  assert.match(source,/WHERE rua\.user_id=\? AND \(r\.robot_key NOT LIKE 'SIM-%' OR \(cua\.user_id IS NOT NULL AND c\.enabled=1\)\) ORDER BY rua\.created_at DESC, r\.id DESC/);
});

test('real robots are canonical while access is unique per user and SIM keys stay exclusive', () => {
  const schema=read('schema.sql'),server=read('server.js');
  assert.match(schema,/CREATE TABLE IF NOT EXISTS robot_user_access/);
  assert.match(schema,/(?:PRIMARY KEY|UNIQUE KEY[^\n(]*)\s*\(\s*robot_id\s*,\s*user_id\s*\)/);
  assert.match(schema,/FOREIGN KEY\s*\(robot_id\)\s*REFERENCES robots\s*\(id\)/);
  assert.match(server,/CREATE TABLE IF NOT EXISTS robot_user_access/);
  assert.match(server,/SIMULATION_KEY_EXISTS/);
  assert.match(server,/ROBOT_ALREADY_ADDED/);

  runIsolatedServerScenario(`
    const state={robots:[],access:[],nextRobotId:1};
    const normalized=sql=>String(sql).replace(/\\s+/g,' ').trim().toLowerCase();
    globalThis.__query=async(sql,params=[])=>{
      const text=normalized(sql);
      if(text.includes('get_lock('))return[[{acquired:1}],[]];
      if(text.includes('release_lock('))return[[{released:1}],[]];
      if(text.startsWith('select plan_code,status,starts_at'))return[[],[]];
      if(text.startsWith('select c.id from clusters c join cluster_user_access'))return[[{id:1}],[]];
      if(text.startsWith('select * from robots where robot_key='))return[[...state.robots.filter(robot=>robot.robot_key===params[0])],[]];
      if(text.startsWith('select 1 from robot_user_access'))return[[...state.access.filter(item=>item.robot_id===Number(params[0])&&item.user_id===Number(params[1])).map(()=>({'1':1}))],[]];
      if(text.startsWith('insert into robots(')){
        const id=state.nextRobotId++;state.robots.push({id,robot_key:params[0],name:params[1],ssh_user:params[2],ssh_pass:params[3],workspace:params[4],description:params[5],added_by:Number(params[6])});
        return[{insertId:id,affectedRows:1},[]];
      }
      if(text.startsWith('insert into robot_user_access')){
        const robot_id=Number(params[0]),user_id=Number(params[1]);
        if(state.access.some(item=>item.robot_id===robot_id&&item.user_id===user_id))throw Object.assign(new Error('duplicate access'),{code:'ER_DUP_ENTRY'});
        state.access.push({robot_id,user_id,alias:params.length>2?params[2]:null});return[{affectedRows:1},[]];
      }
      if(text.includes('sum(r.robot_key like')&&text.includes('from robot_user_access')){
        const userId=Number(params[0]),owned=state.access.filter(item=>item.user_id===userId).map(item=>state.robots.find(robot=>robot.id===item.robot_id)).filter(Boolean);
        return[[{simulation_count:owned.filter(robot=>robot.robot_key.startsWith('SIM-')).length,real_count:owned.filter(robot=>!robot.robot_key.startsWith('SIM-')).length}],[]];
      }
      throw new Error('Unhandled fake DB query: '+sql+' params='+JSON.stringify(params));
    };
    const user1={id:11,username:'one',role:'user'},user2={id:22,username:'two',role:'user'};
    const add=(user,robot_key,name)=>invoke('POST','/api/robots',{user,body:{robot_key,name,ssh_user:'ubuntu',ssh_pass:'secret',workspace:'~/ros2_ws',description:''}});
    const sharedKey='REAL-shared-robot-0001';
    const first=await add(user1,sharedKey,'Owner robot');
    assert.equal(first.status,200);assert.equal(first.body.ok,true);assert.equal(first.body.attached,false);
    const attached=await add(user2,sharedKey,'Team alias');
    assert.equal(attached.status,200);assert.equal(attached.body.ok,true);assert.equal(attached.body.attached,true);assert.equal(attached.body.id,first.body.id);
    const duplicate=await add(user1,sharedKey,'Duplicate');
    assert.equal(duplicate.status,409);assert.equal(duplicate.body.ok,false);assert.equal(duplicate.body.code,'ROBOT_ALREADY_ADDED');

    const simKey='SIM-exclusive-domain-0001';
    const simOwner=await add(user1,simKey,'Private simulation');
    assert.equal(simOwner.body.ok,true);
    const simDuplicate=await add(user2,simKey,'Must not attach');
    assert.equal(simDuplicate.status,409);assert.equal(simDuplicate.body.code,'SIMULATION_KEY_EXISTS');
    const lowercaseSim=await add(user2,'sim-prefix-bypass-00001','Invalid lowercase SIM');
    assert.equal(lowercaseSim.status,400);assert.equal(lowercaseSim.body.error,'Invalid robot key');
    const mixedCaseSim=await add(user2,'Sim-prefix-bypass-00002','Invalid mixed-case SIM');
    assert.equal(mixedCaseSim.status,400);assert.equal(mixedCaseSim.body.error,'Invalid robot key');
    assert.equal(state.robots.length,2,'shared real robot must keep one canonical robots row');
    assert.deepEqual(state.access.map(item=>[item.robot_id,item.user_id]),[[1,11],[1,22],[2,11]]);
  `);
});

test('robot presence is authorized, counts distinct live users, and robot lists never await project scans', () => {
  const server=read('server.js');
  assert.match(server,/function robotOnlineUserCount\(robotKey\)/);
  assert.match(server,/SELECT r\.robot_key FROM robot_user_access rua JOIN robots r ON r\.id=rua\.robot_id LEFT JOIN cluster_user_access cua/);
  assert.match(server,/app\.post\('\/api\/robots\/progress',auth/);

  runIsolatedServerScenario(`
    const shared={id:7,robot_key:'REAL-presence-robot-0001',name:'Shared',ssh_user:'ubuntu',ssh_pass:'',workspace:'~/ros2_ws',description:'',added_by:101};
    const hidden={id:8,robot_key:'REAL-hidden-robot-00001',name:'Hidden',ssh_user:'ubuntu',ssh_pass:'',workspace:'~/ros2_ws',description:'',added_by:303};
    const robots=[shared,hidden],access=[{robot_id:7,user_id:101,alias:null},{robot_id:7,user_id:202,alias:'Team Shared'},{robot_id:8,user_id:303,alias:null}];
    const normalized=sql=>String(sql).replace(/\\s+/g,' ').trim().toLowerCase();
    const rowsFor=userId=>access.filter(item=>item.user_id===Number(userId)).map(item=>({...robots.find(robot=>robot.id===item.robot_id),access_alias:item.alias,added_by_name:'owner'}));
    globalThis.__query=async(sql,params=[])=>{
      const text=normalized(sql);
      if(text.startsWith('select plan_code,status,starts_at'))return[[],[]];
      if(text.includes('sum(r.robot_key like')&&text.includes('from robot_user_access')){
        const owned=rowsFor(params[0]);return[[{simulation_count:0,real_count:owned.length}],[]];
      }
      if(text.includes('select r.*,rua.alias access_alias')&&text.includes('where rua.user_id=?'))return[rowsFor(params[0]),[]];
      if(text.startsWith('select r.robot_key from robot_user_access')&&text.includes('where rua.user_id=?'))return[rowsFor(params[0]).map(robot=>({robot_key:robot.robot_key})),[]];
      if(text.startsWith('select r.* from robot_user_access')&&text.includes('r.id in')){
        const userId=Number(params[0]),ids=params.slice(1).map(Number);return[rowsFor(userId).filter(robot=>ids.includes(robot.id)),[]];
      }
      throw new Error('Unhandled fake DB query: '+sql+' params='+JSON.stringify(params));
    };

    hooks.agents.set(shared.robot_key,{ws:{readyState:WebSocket.OPEN,send(raw){
      const request=JSON.parse(String(raw));
      if(request.type==='request')setTimeout(()=>hooks.pendingReqs.get(request.reqId)?.({ok:true,data:{stdout:'delayed scan'}}),350);
    }}});
    const user1={id:101,username:'owner',role:'user'},user2={id:202,username:'team',role:'user'},outsider={id:404,username:'outsider',role:'user'};
    const expiresAt=Date.now()+60000;
    hooks.sessions.set('owner-session',{userId:101,robotKey:shared.robot_key,robotDbId:shared.id,expiresAt});
    hooks.sessions.set('team-session',{userId:202,robotKey:shared.robot_key,robotDbId:shared.id,expiresAt});
    const openStatus=async user=>{const socket=makeSocket(user);hooks.wss.emit('connection',socket,'/ws/robot-status');await tick();await tick();return socket;};
    const ownerSocket1=await openStatus(user1),ownerSocket2=await openStatus(user1),teamSocket=await openStatus(user2),outsiderSocket=await openStatus(outsider);
    ownerSocket1.emit('message',JSON.stringify({type:'watch',sessionId:'owner-session'}));
    ownerSocket2.emit('message',JSON.stringify({type:'watch',sessionId:'owner-session'}));
    teamSocket.emit('message',JSON.stringify({type:'watch',sessionId:'team-session'}));
    outsiderSocket.emit('message',JSON.stringify({type:'watch',sessionId:'owner-session'}));
    assert.equal(hooks.robotOnlineUserCount(shared.robot_key),2,'two sockets from one user must still count as one user');
    assert.equal(hooks.robotOnlineUserCount(hidden.robot_key),0,'a socket without access must not create presence');
    assert.ok(outsiderSocket.sent.some(message=>message.type==='presence_error'),'a user must not watch another user session');

    const started=performance.now();
    const listed=await invoke('GET','/api/robots',{user:user1});
    const elapsed=performance.now()-started;
    assert.equal(listed.body.ok,true);assert.equal(listed.body.robots.length,1);
    assert.equal(listed.body.robots[0].onlineUsers,2);
    assert.equal(listed.body.robots[0].wizardProgress.pending,true);
    assert.ok(elapsed<180,'robot list waited '+elapsed.toFixed(1)+'ms for a 350ms project scan');

    const authorized=await invoke('POST','/api/robots/progress',{user:user1,body:{robotIds:[7,8]}});
    assert.deepEqual(authorized.body.robots.map(robot=>robot.id),[7],'progress polling must filter inaccessible robot ids');
    const forbidden=await invoke('POST','/api/robots/progress',{user:outsider,body:{robotIds:[7]}});
    assert.deepEqual(forbidden.body.robots,[]);

    ownerSocket1.close();assert.equal(hooks.robotOnlineUserCount(shared.robot_key),2);
    ownerSocket2.close();assert.equal(hooks.robotOnlineUserCount(shared.robot_key),1);
    teamSocket.close();assert.equal(hooks.robotOnlineUserCount(shared.robot_key),0);
    outsiderSocket.close();
  `);
});

test('revoked sessions reject operational websocket input and disconnect closes their streams', () => {
  runIsolatedServerScenario(`
    globalThis.__query=async(sql)=>String(sql).startsWith('UPDATE robot_connections')?[{affectedRows:1},[]]:(()=>{throw new Error('Unhandled fake DB query: '+sql);})();
    const robotKey='REAL-operational-0001',user={id:51,username:'operator',role:'user'},agentMessages=[];
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){agentMessages.push(JSON.parse(String(raw)));}}});
    const session={userId:user.id,robotKey,robotDbId:9,rosInfo:{setupBash:'/opt/ros/humble/setup.bash'},workspace:'~/ros2_ws',expiresAt:Date.now()+60000};

    hooks.sessions.set('revoked-session',session);
    const revokedSocket=makeSocket(user);hooks.wss.emit('connection',revokedSocket,'/ws/terminal');
    revokedSocket.emit('message',JSON.stringify({type:'init',sessionId:'revoked-session',cols:100,rows:30}));
    assert.ok(revokedSocket.termId);assert.equal(hooks.webSockets.get(revokedSocket.termId),revokedSocket);
    hooks.sessions.delete('revoked-session');
    revokedSocket.emit('message',JSON.stringify({type:'data',data:'DANGEROUS_COMMAND\\n'}));
    assert.equal(revokedSocket.readyState,WebSocket.CLOSED);assert.equal(revokedSocket.closeCode,1008);
    assert.ok(revokedSocket.sent.some(message=>message.type==='error'&&message.message==='Session expired or revoked'));
    assert.equal(agentMessages.some(message=>message.type==='pty_input'&&message.data==='DANGEROUS_COMMAND\\n'),false,'revoked input reached the robot agent');

    hooks.sessions.set('disconnect-session',{...session,expiresAt:Date.now()+60000});
    const disconnectedSocket=makeSocket(user);hooks.wss.emit('connection',disconnectedSocket,'/ws/terminal');
    disconnectedSocket.emit('message',JSON.stringify({type:'init',sessionId:'disconnect-session'}));
    assert.ok(disconnectedSocket.termId);
    const response=await invoke('POST','/api/disconnect',{user,body:{sessionId:'disconnect-session'}});
    assert.equal(response.status,200);assert.equal(response.body.ok,true);
    assert.equal(hooks.sessions.has('disconnect-session'),false);
    assert.equal(disconnectedSocket.readyState,WebSocket.CLOSED);assert.equal(disconnectedSocket.closeCode,1008);
    assert.ok(disconnectedSocket.sent.some(message=>message.type==='error'&&message.message==='Session disconnected'));
  `);
});

test('dashboard runtime coalesces concurrent and short-lived cached agent requests', () => {
  runIsolatedServerScenario(`
    const robotKey='REAL-dashboard-cache-0001',requests=[];
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){requests.push(JSON.parse(String(raw)));}}});
    const session={robotKey,workspace:'~/ros2_ws',rosInfo:{setupBash:'/opt/ros/humble/setup.bash'}};
    const first=hooks.getDashboardRuntime(session),concurrent=hooks.getDashboardRuntime({...session});
    assert.equal(first,concurrent,'concurrent callers must share the same in-flight promise');
    assert.equal(requests.length,2,'one dashboard refresh should issue only metrics and process RPCs');
    for(const request of requests){
      const callback=hooks.pendingReqs.get(request.reqId);assert.ok(callback,'missing pending dashboard RPC');
      hooks.pendingReqs.delete(request.reqId);callback({ok:true,data:{stdout:''}});
    }
    const [firstValue,concurrentValue]=await Promise.all([first,concurrent]);
    assert.equal(firstValue,concurrentValue);
    const cached=hooks.getDashboardRuntime({...session});
    assert.equal(cached,first,'the fulfilled short-lived cache must retain the original promise');
    assert.equal(requests.length,2,'a cache hit must not issue new robot RPCs');
    assert.equal(await cached,firstValue);
  `);
});

test('account and application lookups coalesce safe non-realtime database reads', () => {
  runIsolatedServerScenario(`
    const calls={membership:0,session:0,applications:0};
    globalThis.__query=async(sql,params=[])=>{
      sql=String(sql);
      if(sql.includes('FROM user_subscriptions WHERE user_id=')){calls.membership++;return[[{plan_code:'pro_monthly',status:'active',starts_at:new Date(),expires_at:null,provider:'stripe'}],[]];}
      if(sql.includes('FROM sessions s JOIN users u')){calls.session++;return[[{user_id:71,username:'cached-user',role:'user'}],[]];}
      if(sql.includes('FROM applications')){calls.applications++;return[[{id:1,name:'Cached app',enabled:1}],[]];}
      if(sql.startsWith('INSERT INTO applications'))return[{insertId:2,affectedRows:1},[]];
      if(sql.startsWith('DELETE FROM sessions'))return[{affectedRows:1},[]];
      throw new Error('Unhandled fake DB query: '+sql+' '+JSON.stringify(params));
    };
    const user={id:71,username:'cached-user',role:'user'};
    const memberships=await Promise.all([hooks.getMembership(user),hooks.getMembership({...user}),hooks.getMembership(user)]);
    assert.equal(calls.membership,1,'concurrent membership reads must share one query');
    assert.ok(memberships.every(value=>value.isPro));
    const sessions=await Promise.all([hooks.tokenUser('legacy-session-token'),hooks.tokenUser('legacy-session-token')]);
    assert.equal(calls.session,1,'concurrent auth reads must share one query');
    assert.ok(sessions.every(value=>value?.id===user.id));
    const catalogs=await Promise.all([hooks.getApplicationCatalog(false),hooks.getApplicationCatalog(false)]);
    assert.equal(calls.applications,1,'concurrent catalog reads must share one query');
    assert.equal(catalogs[0][0].name,'Cached app');
    const created=await invoke('POST','/api/applications',{user:{...user,role:'admin'},body:{name:'New app',redirect_url:'/new-app'}});assert.equal(created.status,201);
    await hooks.getApplicationCatalog(false);assert.equal(calls.applications,2,'catalog mutation must invalidate cached rows');
    const loggedOut=await invoke('POST','/api/auth/logout',{user,authSessionId:'legacy-session-token'});assert.equal(loggedOut.body.ok,true);
    assert.equal(hooks.authSessionCache.has('legacy-session-token'),false,'logout must invalidate the auth cache immediately');
  `);
});

test('simulation RViz viewers share one bridge and late viewers receive the latest snapshot', () => {
  runIsolatedServerScenario(`
    const robotKey='SIM-shared-rviz-cache-0001',sessionId='shared-rviz-session',user={id:72,username:'sim-user',role:'user'},agentMessages=[];
    const agentSocket={readyState:WebSocket.OPEN,send(raw){agentMessages.push(JSON.parse(String(raw)));}};
    hooks.agents.set(robotKey,{ws:agentSocket});
    hooks.sessions.set(sessionId,{userId:user.id,robotKey,robotDbId:72,rosInfo:{setupBash:'/opt/ros/jazzy/setup.bash'},expiresAt:Date.now()+60000});
    const start={type:'start',sessionId,odom:'/odom',laser:'/scan',map:'/slam_map',path:'/plan'};
    const first=makeSocket(user),second=makeSocket(user);
    hooks.wss.emit('connection',first,'/ws/rviz');hooks.wss.emit('connection',second,'/ws/rviz');
    first.emit('message',JSON.stringify(start));second.emit('message',JSON.stringify(start));
    assert.equal(hooks.simRvizStreams.size,1);
    assert.equal(agentMessages.filter(message=>message.type==='pty_init').length,1,'two viewers created duplicate PTYs');
    const writeRequest=agentMessages.find(message=>message.type==='request'&&message.action==='fs_write');assert.ok(writeRequest);
    hooks.pendingReqs.get(writeRequest.reqId)({ok:true,data:{}});await tick();await tick();
    const compileRequest=agentMessages.find(message=>message.type==='request'&&message.action==='exec');assert.ok(compileRequest);
    hooks.pendingReqs.get(compileRequest.reqId)({ok:true,data:{code:0,stdout:'',stderr:''}});await tick();await tick();
    assert.ok(first.sent.some(message=>message.type==='ready'));assert.ok(second.sent.some(message=>message.type==='ready'));
    const stream=[...hooks.simRvizStreams.values()][0],state={stream:'ready',odom:{x:1.25,y:-2},scan:{ranges:[1,2,3]}};
    hooks.routeAgentPtyMessage({type:'pty_output',termId:stream.termId,data:Buffer.from(JSON.stringify(state)+'\\n').toString('base64')});
    assert.ok(first.sent.some(message=>message.type==='data'&&message.data?.odom?.x===1.25));
    assert.ok(second.sent.some(message=>message.type==='data'&&message.data?.scan?.ranges?.length===3));
    const late=makeSocket(user);hooks.wss.emit('connection',late,'/ws/rviz');late.emit('message',JSON.stringify(start));
    assert.ok(late.sent.some(message=>message.type==='ready'));
    assert.ok(late.sent.some(message=>message.type==='data'&&message.data?.odom?.x===1.25),'late viewer did not receive cached state');
    assert.equal(agentMessages.filter(message=>message.type==='pty_init').length,1,'late viewer created another PTY');
    first.close();second.close();late.close();
  `);
});

test('agent disconnect immediately rejects its pending RPC work', () => {
  runIsolatedServerScenario(`
    const robot={id:17,robot_key:'REAL-agent-drop-000001',name:'Drop test'},requests=[];
    globalThis.__query=async(sql,params=[])=>{
      if(String(sql).startsWith('SELECT * FROM robots WHERE robot_key='))return[params[0]===robot.robot_key?[robot]:[],[]];
      throw new Error('Unhandled fake DB query: '+sql);
    };
    const agentSocket=makeSocket(null);agentSocket.send=function(raw){this.sent.push(JSON.parse(String(raw)));requests.push(this.sent.at(-1));};
    hooks.wss.emit('connection',agentSocket,'/ws/agent');
    agentSocket.emit('message',JSON.stringify({type:'auth',robotKey:robot.robot_key}));
    await tick();await tick();
    assert.equal(hooks.agents.get(robot.robot_key)?.ws,agentSocket);

    const pending=assert.rejects(hooks.agentReq(robot.robot_key,'exec',{command:'never finishes'},5000),/Robot disconnected/);
    assert.ok(requests.some(message=>message.type==='request'&&message.payload?.command==='never finishes'));
    agentSocket.close(1006,'network lost');
    assert.equal([...hooks.pendingReqs.values()].some(callback=>callback.robotKey===robot.robot_key),false,'disconnect must synchronously drain pending work');
    await pending;
    assert.equal(hooks.agents.has(robot.robot_key),false);
  `);
});

test('legacy Agents need no version fields and every new management operation rejects Sim',()=>{
  runIsolatedServerScenario(`
    const robot={id:19,robot_key:'REAL-legacy-local-test-00001',name:'Legacy'},user={id:7};
    globalThis.__query=async(sql)=>{if(sql.startsWith('SELECT * FROM robots WHERE robot_key='))return[[robot],[]];throw new Error(sql);};
    const agent=makeSocket(null);hooks.wss.emit('connection',agent,'/ws/agent');
    agent.emit('message',JSON.stringify({type:'auth',robotKey:robot.robot_key,username:'ubuntu'}));await tick();await tick();
    assert.ok(agent.sent.some(packet=>packet.type==='auth_ok'));
    const probe=agent.sent.find(packet=>packet.type==='request');assert.ok(probe);assert.equal(probe.epoch,undefined);
    agent.emit('message',JSON.stringify({type:'response',reqId:probe.reqId,ok:true,data:{stdout:'ROS_DISTRO=humble\\nSETUP=/opt/ros/humble/setup.bash',stderr:'',code:0}}));
    hooks.sessions.set('legacy',{robotKey:robot.robot_key,robotDbId:19,userId:7});
    const status=await invoke('POST','/api/real/agent/status',{user,body:{sessionId:'legacy'}});assert.equal(status.body.ok,true);assert.equal(status.body.legacy,true);
    const mode=await invoke('POST','/api/real/agent/mode',{user,body:{sessionId:'legacy',confirm:true}});assert.equal(mode.status,409);
    const notConfirmed=await invoke('POST','/api/real/agent/update',{user,body:{sessionId:'legacy'}});assert.equal(notConfirmed.status,400);
    hooks.sessions.set('sim-unchanged',{robotKey:'SIM-no-agent-update',userId:7});
    for(const endpoint of ['agent/status','agent/mode','agent/update','library/read','library/write']){
      const result=await invoke('POST','/api/real/'+endpoint,{user,body:{sessionId:'sim-unchanged',confirm:true}});assert.equal(result.status,400,endpoint);
    }
    assert.equal(hooks.agents.has('SIM-no-agent-update'),false);
    agent.close(1000,'done');
  `);
});

test('a control lease rejects a second user until the active controller disconnects', () => {
  runIsolatedServerScenario(`
    const robotKey='REAL-control-lease-0001',agentMessages=[];
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){
      const message=JSON.parse(String(raw));agentMessages.push(message);
      if(message.type==='request')queueMicrotask(()=>{const callback=hooks.pendingReqs.get(message.reqId);if(callback){hooks.pendingReqs.delete(message.reqId);callback({ok:true,data:{}});}});
    }}});
    const expiresAt=Date.now()+60000,user1={id:61,username:'one'},user2={id:62,username:'two'};
    hooks.sessions.set('control-one',{userId:user1.id,robotKey,robotDbId:21,workspace:'~/ros2_ws',rosInfo:{setupBash:'/opt/ros/humble/setup.bash'},expiresAt});
    hooks.sessions.set('control-two',{userId:user2.id,robotKey,robotDbId:21,workspace:'~/ros2_ws',rosInfo:{setupBash:'/opt/ros/humble/setup.bash'},expiresAt});

    const first=makeSocket(user1);hooks.wss.emit('connection',first,'/ws/lidar');
    first.emit('message',JSON.stringify({type:'start',sessionId:'control-one'}));
    assert.equal(hooks.robotControlLeases.get(robotKey)?.ws,first);

    const blocked=makeSocket(user2);hooks.wss.emit('connection',blocked,'/ws/lidar');
    blocked.emit('message',JSON.stringify({type:'start',sessionId:'control-two'}));
    assert.equal(blocked.readyState,WebSocket.CLOSED);assert.equal(blocked.closeCode,1008);
    assert.ok(blocked.sent.some(message=>message.type==='error'&&message.code==='ROBOT_BUSY'));
    assert.equal(hooks.robotControlLeases.get(robotKey)?.ws,first,'a rejected controller must not steal the lease');

    first.close();assert.equal(hooks.robotControlLeases.has(robotKey),false);
    const replacement=makeSocket(user2);hooks.wss.emit('connection',replacement,'/ws/lidar');
    replacement.emit('message',JSON.stringify({type:'start',sessionId:'control-two'}));
    assert.equal(replacement.readyState,WebSocket.OPEN);
    assert.equal(hooks.robotControlLeases.get(robotKey)?.ws,replacement);
    replacement.close();await tick();
    assert.equal(hooks.robotControlLeases.has(robotKey),false);
  `);
});

test('LiDAR and controller share one session without releasing or duplicating motor control', () => {
  runIsolatedServerScenario(`
    const robotKey='REAL-teleop-pair-0001',user={id:61},expiresAt=Date.now()+60000;
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){
      const message=JSON.parse(String(raw));
      if(message.type==='request')queueMicrotask(()=>{const callback=hooks.pendingReqs.get(message.reqId);if(callback){hooks.pendingReqs.delete(message.reqId);callback({ok:true,data:{}});}});
    }}});
    for(const id of ['paired','another-tab'])hooks.sessions.set(id,{userId:user.id,robotKey,workspace:'~/ros2_ws',rosInfo:{setupBash:'/dev/null'},expiresAt});
    const open=(pathname,sessionId='paired')=>{const ws=makeSocket(user);hooks.wss.emit('connection',ws,pathname);ws.emit('message',JSON.stringify({type:'start',sessionId,port:'/dev/ttyUSB1',baud:115200,motorCount:2}));return ws;};
    for(const order of [['/ws/lidar','/ws/controller-tune'],['/ws/controller-tune','/ws/lidar']]){
      const first=open(order[0]),second=open(order[1]);
      assert.equal(first.readyState,WebSocket.OPEN);assert.equal(second.readyState,WebSocket.OPEN);
      assert.equal(hooks.robotControlLeases.get(robotKey).streams.size,2);
      for(const endpoint of ['/api/mapping/runtime','/api/navigation/runtime']){
        const result=await invoke('POST',endpoint,{user,body:{sessionId:'paired',action:'start'}});
        assert.equal(result.status,409,'a new mission must not clean up devices belonging to active teleop');
        assert.equal(result.body.code,'ROBOT_BUSY');
      }
      const otherLidar=await invoke('POST','/api/lidar/driver',{user,body:{sessionId:'another-tab',modelId:'rplidar_c1',action:'start'}});
      assert.equal(otherLidar.status,409,'another session must not restart the active LiDAR driver');
      for(const route of ['/ws/controller-tune','/ws/mapping','/ws/navigation','/ws/lidar']){
        const duplicate=open(route);assert.equal(duplicate.readyState,WebSocket.CLOSED,route);
        assert.ok(duplicate.sent.some(message=>message.code==='ROBOT_BUSY'));
      }
      first.close();assert.equal(hooks.robotControlLeases.get(robotKey).ws,second,'closing one stream must keep the companion lease');
      const otherTab=open(order[0],'another-tab');assert.equal(otherTab.readyState,WebSocket.CLOSED);
      const replacement=open(order[0]);assert.equal(replacement.readyState,WebSocket.OPEN);
      second.close();assert.equal(hooks.robotControlLeases.get(robotKey).ws,replacement);
      replacement.close();assert.equal(hooks.robotControlLeases.has(robotKey),false);
    }
    await tick();
  `);
});

test('runtime start/stop is exclusive per robot before any control websocket exists', () => {
  runIsolatedServerScenario(`
    const user={id:61},held=[],messages=[];
    for(const robotKey of ['REAL-start-lock-0001','REAL-start-lock-0002']){
      hooks.sessions.set(robotKey,{userId:user.id,robotKey,workspace:'~/ros2_ws',rosInfo:{setupBash:'/dev/null'},expiresAt:Date.now()+60000});
      hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){const message=JSON.parse(String(raw));messages.push(message);if(message.type==='request')held.push(message);}}});
    }
    const sessionId='REAL-start-lock-0001',request={user,body:{sessionId,action:'start',controllerPort:'/dev/ttyAMA0',lidarPort:'/dev/ttyUSB0',lidarModelId:'rplidar_c1'}};
    const first=invoke('POST','/api/mapping/runtime',request);assert.equal(held.length,1);
    for(const endpoint of ['/api/mapping/runtime','/api/navigation/runtime','/api/lidar/driver'])for(const action of ['start','stop']){
      const result=await invoke('POST',endpoint,{user,body:{sessionId,action,modelId:'rplidar_c1'}});
      assert.equal(result.status,409,endpoint+' '+action);assert.equal(result.body.code,'ROBOT_BUSY');
    }
    assert.equal(held.length,1,'blocked requests must never reach the robot');
    for(const route of ['/ws/mapping','/ws/navigation','/ws/controller-tune','/ws/lidar']){
      const ws=makeSocket(user);hooks.wss.emit('connection',ws,route);ws.emit('message',JSON.stringify({type:'start',sessionId,port:'/dev/ttyAMA0',baud:115200}));
      assert.equal(ws.readyState,WebSocket.CLOSED);assert.ok(ws.sent.some(m=>m.code==='ROBOT_BUSY'));
      assert.equal(ws.sent.find(m=>m.code==='ROBOT_BUSY').retryable,route==='/ws/mapping','only the matching mission may retry its pending operation');
    }
    assert.equal(messages.some(m=>m.type==='pty_init'),false);
    const status=await invoke('POST','/api/mapping/runtime',{user,body:{sessionId,action:'status'}});assert.equal(held.length,1,'busy status is immediate and must not probe half-started processes');
    assert.equal(status.body.ok,true);assert.equal(status.body.runtimeBusy,true);assert.equal(status.body.runtimeRetryable,true);assert.equal(status.body.runtimeAction,'start');
    hooks.sessions.set('another-mapping-tab',{...hooks.sessions.get(sessionId)});
    const foreignStatus=await invoke('POST','/api/mapping/runtime',{user,body:{sessionId:'another-mapping-tab',action:'status'}});
    assert.equal(foreignStatus.body.runtimeRetryable,false,'another session must not auto-attach when the operation completes');
    const reply=(message,data)=>{const callback=hooks.pendingReqs.get(message.reqId);hooks.pendingReqs.delete(message.reqId);callback(data);};
    assert.equal(hooks.robotRuntimeOperations.has(sessionId),true,'status must not release the running operation');
    const other=invoke('POST','/api/mapping/runtime',{user,body:{...request.body,sessionId:'REAL-start-lock-0002'}});assert.equal(held.length,2,'different robots remain independent');
    reply(held[0],{ok:false,error:'fixture failure'});await first;
    assert.equal(hooks.robotRuntimeOperations.has(sessionId),false,'failure releases its reservation');
    assert.equal(hooks.robotRuntimeOperations.has('REAL-start-lock-0002'),true);
    reply(held[1],{ok:false,error:'fixture failure'});await other;
    const retry=invoke('POST','/api/mapping/runtime',request);assert.equal(held.length,3);
    reply(held[2],{ok:false,error:'fixture failure'});await retry;assert.equal(hooks.robotRuntimeOperations.size,0);
  `);
});

test('Nav2 busy status is read-only and a dead bridge closes the browser lease with diagnostics',()=>{
  runIsolatedServerScenario(`
    const {spawnSync}=require('node:child_process'),user={id:61},robotKey='REAL-navigation-exit-0001',sessionId='nav-session',messages=[],writes=[];
    hooks.sessions.set(sessionId,{userId:user.id,robotKey,workspace:'~/ros2_ws',rosInfo:{setupBash:'/opt/ros/jazzy/setup.bash'},expiresAt:Date.now()+60000});
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){const message=JSON.parse(raw);messages.push(message);if(message.type==='request')queueMicrotask(()=>{
      const callback=hooks.pendingReqs.get(message.reqId);hooks.pendingReqs.delete(message.reqId);
      if(message.action==='fs_write'){writes.push(message.payload);callback({ok:true,data:{}});}else callback({ok:true,data:{code:0,stdout:'',stderr:''}});
    });}}});
    hooks.robotRuntimeOperations.set(robotKey,{sessionId,userId:user.id,pathname:'/ws/navigation',action:'start'});
    const status=await invoke('POST','/api/navigation/runtime',{user,body:{sessionId,action:'status'}});
    assert.equal(status.body.runtimeBusy,true);assert.equal(status.body.runtimeRetryable,true);assert.equal(messages.length,0);
    const blocked=makeSocket(user);hooks.wss.emit('connection',blocked,'/ws/navigation');blocked.emit('message',JSON.stringify({type:'start',sessionId}));
    assert.equal(blocked.sent.find(m=>m.code==='ROBOT_BUSY').retryable,true);
    hooks.robotRuntimeOperations.delete(robotKey);
    const ws=makeSocket(user);hooks.wss.emit('connection',ws,'/ws/navigation');
    ws.emit('message',JSON.stringify({type:'start',sessionId,controllerPort:'/dev/ttyAMA0',controllerBaud:115200,maxSpeed:.2,maxTurn:.6,minSpeed:.05,minTurn:.1}));
    await tick();await tick();assert.equal(writes.length,1);
    const python=spawnSync('python3',['-c','import sys; compile(sys.stdin.read(),"nav.py","exec")'],{input:writes[0].content,encoding:'utf8'});assert.equal(python.status,0,python.stderr);
    const setup=messages.find(m=>m.type==='pty_input');assert.ok(setup);assert.match(setup.data,/exec python3 -u/);assert.match(setup.data,/bridge[.]log/);
    assert.equal(spawnSync('bash',['-n'],{input:setup.data,encoding:'utf8'}).status,0);
    const termId=ws.termId;assert.equal(hooks.robotControlLeases.has(robotKey),true);
    hooks.routeAgentPtyMessage({type:'pty_closed',termId});
    assert.equal(ws.readyState,WebSocket.CLOSED);assert.ok(ws.sent.some(m=>m.code==='NAV_BRIDGE_EXIT'));
    assert.equal(hooks.robotControlLeases.has(robotKey),false);assert.equal(hooks.webSockets.has(termId),false);
  `);
});

test('pending LiDAR startup still allows its separate UART controller but not a competing mission', () => {
  runIsolatedServerScenario(`
    const user={id:61},robotKey='REAL-lidar-lock-0001';let build;
    hooks.sessions.set('paired',{userId:user.id,robotKey,workspace:'~/ros2_ws',rosInfo:{setupBash:'/dev/null'},expiresAt:Date.now()+60000});
    hooks.sessions.set('other-tab',{userId:user.id,robotKey,workspace:'~/ros2_ws',rosInfo:{setupBash:'/dev/null'},expiresAt:Date.now()+60000});
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){const message=JSON.parse(String(raw));if(message.type!=='request')return;
      if(message.payload?.command?.includes('needs_build=0')){build=message;return;}
      queueMicrotask(()=>{const callback=hooks.pendingReqs.get(message.reqId);if(callback){hooks.pendingReqs.delete(message.reqId);callback({ok:true,data:{code:0,stdout:'',stderr:''}});}});
    }}});
    const start=invoke('POST','/api/lidar/driver',{user,body:{sessionId:'paired',action:'start',modelId:'rplidar_c1',port:'/dev/ttyUSB0'}});
    await tick();assert.ok(build);assert.equal(hooks.robotRuntimeOperations.size,1);
    const open=(sessionId,port,route='/ws/controller-tune')=>{const ws=makeSocket(user);hooks.wss.emit('connection',ws,route);ws.emit('message',JSON.stringify({type:'start',sessionId,port,baud:115200,motorCount:2}));return ws;};
    assert.equal(open('paired','/dev/ttyUSB0').readyState,WebSocket.CLOSED,'same serial port must not be claimed while LiDAR starts');
    assert.equal(open('other-tab','/dev/ttyAMA0').readyState,WebSocket.CLOSED);
    assert.equal(open('paired','/dev/ttyAMA0','/ws/mapping').readyState,WebSocket.CLOSED);
    const controller=open('paired','/dev/ttyAMA0');assert.equal(controller.readyState,WebSocket.OPEN);
    const callback=hooks.pendingReqs.get(build.reqId);hooks.pendingReqs.delete(build.reqId);callback({ok:true,data:{code:2,stdout:'',stderr:'fixture build failed'}});
    assert.equal((await start).body.ok,false);assert.equal(hooks.robotRuntimeOperations.size,0);controller.close();await tick();
  `);
});

test('RViz websocket builds a scoped Python stream for map, path, TF, odom, and scan', () => {
  runIsolatedServerScenario(`
    const {spawnSync}=require('node:child_process'),robotKey='REAL-rviz-stream-00001',user={id:71,username:'viewer'},writes=[],compileRequests=[],agentMessages=[];
    hooks.agents.set(robotKey,{ws:{readyState:WebSocket.OPEN,send(raw){
      const message=JSON.parse(String(raw));agentMessages.push(message);
      if(message.type!=='request')return;
      queueMicrotask(()=>{
        const callback=hooks.pendingReqs.get(message.reqId);if(!callback)return;
        hooks.pendingReqs.delete(message.reqId);
        if(message.action==='fs_write'){writes.push(message.payload);callback({ok:true,data:{}});return;}
        if(message.action==='exec'){compileRequests.push(message.payload);callback({ok:true,data:{stdout:'',stderr:'',code:0}});return;}
        callback({ok:false,error:'Unexpected fake-agent action: '+message.action});
      });
    }}});
    hooks.sessions.set('rviz-session',{userId:user.id,robotKey,robotDbId:31,workspace:'~/ros2_ws',rosInfo:{setupBash:'/opt/ros/humble/setup.bash'},expiresAt:Date.now()+60000});
    const socket=makeSocket(user);hooks.wss.emit('connection',socket,'/ws/rviz');
    socket.emit('message',JSON.stringify({type:'start',sessionId:'rviz-session',odom:'/odom',laser:'/scan',map:'/map',path:'/plan'}));
    await tick();await tick();await tick();await tick();
    assert.equal(writes.length,1);assert.ok(writes[0].path.startsWith('/tmp/_rviz_rt_'));assert.ok(writes[0].path.endsWith('.py'));
    assert.match(writes[0].content,/def cb_map/);assert.match(writes[0].content,/def cb_path/);assert.match(writes[0].content,/^  with lk:$/m);
    assert.match(writes[0].content,/out=\{'stream':'ready'\}/,'bridge readiness must be repeated with telemetry');
    const compiled=spawnSync('python3',['-c',"import sys; compile(sys.stdin.read(), 'rviz_stream.py', 'exec')"],{input:writes[0].content,encoding:'utf8'});
    assert.equal(compiled.status,0,compiled.stderr);
    assert.equal(compileRequests.length,1);assert.ok(compileRequests[0].command.startsWith("python3 -m py_compile '/tmp/_rviz_rt_"));
    const launch=agentMessages.find(message=>message.type==='pty_input');assert.ok(launch);assert.ok(launch.data.includes("python3 -u '/tmp/_rviz_rt_"));assert.doesNotMatch(launch.data,/pkill/);
    assert.ok(socket.sent.some(message=>message.type==='ready'));socket.close();
  `);
});

test('fake SIM RViz PTY telemetry is parsed across chunks and routed as browser data', () => {
  assert.match(read('server.js'),/createSimAgent\(k,\s*\{[^}]+forwardPtyMessage:routeAgentPtyMessage/);
  runIsolatedServerScenario(`
    const termId='rviz_sim_telemetry_0001',browser=makeSocket({id:72,username:'sim-viewer'});
    hooks.webSockets.set(termId,browser);
    const telemetry={
      tf:[{frame:'base_link',parent:'odom',x:1.25,y:-0.5,z:0,qx:0,qy:0,qz:0,qw:1}],
      odom:{x:1.25,y:-0.5,qz:0,qw:1},
      desc:'<robot name="sim">{nested-json-text}</robot>'
    };
    const serialized=JSON.stringify(telemetry),split=Math.floor(serialized.length/2);
    const emit=chunk=>hooks.routeAgentPtyMessage({type:'pty_output',termId,data:Buffer.from(chunk).toString('base64')});
    emit('sim-shell-prompt$ '+serialized.slice(0,split));
    assert.equal(browser.sent.length,0,'an incomplete PTY JSON object must stay buffered');
    emit(serialized.slice(split)+'\\r\\n');
    assert.equal(browser.sent.length,1);
    assert.deepEqual(browser.sent[0],{type:'data',data:telemetry});
    hooks.webSockets.delete(termId);
  `);
});

test('SIM map validation rejects oversized maps, excessive walls, and a start pose on a wall', () => {
  runIsolatedServerScenario(`
    const valid={bounds:[-5,-5,5,5],start:[0,0],walls:[[2,-1,2,1]],objects:[]};
    assert.equal(hooks.validateSimMapData(valid),null);

    const oversized={bounds:[0,0,70,70],start:[1,1],walls:[],objects:[]};
    assert.match(hooks.validateSimMapData(oversized),/ใหญ่เกิน/);

    const detailedMap={...valid,walls:Array.from({length:644},(_,index)=>[-4,index/1000-2,-3,index/1000-2])};
    assert.equal(hooks.validateSimMapData(detailedMap),null,'furniture can produce more than 512 collision edges');
    const excessiveWalls={...valid,walls:Array.from({length:16385},()=>[-4,-2,-3,-2])};
    assert.match(hooks.validateSimMapData(excessiveWalls),/เส้นขอบ.*มากเกิน/);
    assert.match(hooks.validateSimMapData({...valid,objects:Array.from({length:513},()=>({}))}),/วัตถุ.*มากเกิน/);

    const collidingStart={bounds:[-5,-5,5,5],start:[0,0],walls:[[0,-2,0,2]],objects:[]};
    assert.match(hooks.validateSimMapData(collidingStart),/จุดเริ่มหุ่นทับกำแพง/);
    assert.match(hooks.validateSimMapData({...valid,walls:[[9000,9000,9001,9000]]}),/พื้นที่จริง/);
    assert.match(hooks.validateSimMapData({...valid,startPose:{yaw:NaN}}),/มุมเริ่ม/);
  `);
});

test('map apply waits for backend replacement and reports write/restart errors', () => {
  runIsolatedServerScenario(`
    const key='SIM-map-apply-'+process.pid,sessionId='map-apply',user={id:301};
    hooks.sessions.set(sessionId,{robotKey:key,userId:user.id});
    let finish,settled=false;
    hooks.agents.set(key,{respawnBackend:()=>new Promise(resolve=>{finish=resolve;})});
    const body={sessionId,map:{bounds:[-5,-5,5,5],start:[0,0],walls:[],objects:[]}};
    const response=invoke('POST','/api/sim/apply-map',{user,body}).then(result=>{settled=true;return result;});
    await tick();assert.equal(settled,false,'do not launch MapSim before fallback cleanup finishes');
    finish();assert.equal((await response).body.ok,true);
    hooks.agents.get(key).respawnBackend=()=>Promise.reject(new Error('map write failed'));
    const failed=await invoke('POST','/api/sim/apply-map',{user,body});
    assert.equal(failed.body.ok,false);assert.match(failed.body.error,/map write failed/);
  `);
});

test('MapSim save reuses its build and verifies with one bounded DDS probe', () => {
  runIsolatedServerScenario(`
    const {wsRoot}=require(${JSON.stringify(path.join(root,'sim.js'))});
    const key='SIM-map-save-'+process.pid,workspace=wsRoot(key),sessionId='map-save',user={id:302},requests=[];
    fs.mkdirSync(workspace,{recursive:true});
    fs.writeFileSync(path.join(workspace,'map.json'),JSON.stringify({bounds:[-5,-5,5,5],start:[0,0],walls:[],objects:[]}));
    const installed=path.join(workspace,'install/sim_robot_mapsim/lib/sim_robot_mapsim/mapsim');
    fs.mkdirSync(path.dirname(installed),{recursive:true});fs.writeFileSync(installed,'test executable');
    hooks.sessions.set(sessionId,{robotKey:key,userId:user.id,rosInfo:{setupBash:'/opt/ros/jazzy/setup.bash'}});
    let failBuild=true;
    hooks.agents.set(key,{ws:{readyState:1,send(raw){
      const message=JSON.parse(raw),payload=message.payload;requests.push(payload);
      const callback=hooks.pendingReqs.get(message.reqId);hooks.pendingReqs.delete(message.reqId);
      if(failBuild&&payload.command.includes('colcon build'))return callback({ok:false,error:'Timeout'});
      callback({ok:true,data:{code:0,stdout:payload.command.includes('roside_mapsim_readiness')?'/sim_robot_mapsim':'',stderr:''}});
    }}});
    try{
      const failed=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId}});
      assert.equal(failed.body.phase,'build');assert.match(failed.body.error,/Build MapSim.*ไฟล์แผนที่ยังบันทึกอยู่/);
      assert.ok(fs.existsSync(path.join(workspace,'map.json')));
      failBuild=false;requests.length=0;
      const started=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId}});
      assert.equal(started.body.ok,true);assert.equal(started.body.running,true);
      const probe=requests.find(p=>p.command.includes('roside_mapsim_readiness'));
      assert.ok(probe);assert.equal(probe.timeout,30000);assert.match(probe.command,/timeout --signal=TERM --kill-after=2s 25s/);
      assert.ok(!probe.command.includes('ros2 node list'),'no daemon-dependent polling loop');
      requests.length=0;
      const repeated=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId}});
      assert.equal(repeated.body.ok,true);assert.equal(repeated.body.buildCached,true);
      assert.equal(requests.some(p=>p.command.includes('colcon build')),false);
    }finally{fs.rmSync(workspace,{recursive:true,force:true});}
  `);
});

test('queued MapSim HTTP jobs return immediately, share duplicate work and hide other users jobs',()=>{
  runIsolatedServerScenario(`
    const {wsRoot}=require(${JSON.stringify(path.join(root,'sim.js'))});
    const key='SIM-queued-save-'+process.pid,workspace=wsRoot(key),user={id:401},sessionId='queued-save';
    const map={bounds:[-3,-3,3,3],start:[0,0],walls:[],objects:[]};
    fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'map.json'),JSON.stringify(map));
    hooks.sessions.set(sessionId,{robotKey:key,userId:user.id});
    let finishBuild,builds=0,applied=0;
    hooks.agents.set(key,{applyMapWithoutRestart:async()=>{applied++;},ws:{readyState:1,send(raw){
      const msg=JSON.parse(raw),cb=hooks.pendingReqs.get(msg.reqId);hooks.pendingReqs.delete(msg.reqId);
      if(msg.payload.command.includes('colcon build')){builds++;finishBuild=()=>cb({ok:true,data:{code:0,stdout:'',stderr:''}});return;}
      cb({ok:true,data:{code:0,stdout:msg.payload.command.includes('roside_mapsim_readiness')?'/sim_robot_mapsim':'',stderr:''}});
    }}});
    try{
      const submitted=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId,map,async:true}});
      assert.equal(submitted.status,202);const jobId=submitted.body.job.id;
      const duplicate=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId,map,async:true}});
      assert.equal(duplicate.body.job.id,jobId);
      const changed={...map,start:[1,1]};
      const conflict=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId,map:changed,async:true}});
      assert.equal(conflict.status,409);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'map.json'),'utf8')),map,'rejected save must not overwrite accepted map');
      const direct=await invoke('POST','/api/files/write',{user,body:{sessionId,path:'~/map.json',content:JSON.stringify(changed)}});
      assert.equal(direct.status,409);
      const slam=await invoke('POST','/api/sim/save-slam-map',{user,body:{sessionId,mapName:'other',async:true}});
      assert.equal(slam.status,409,'SLAM cannot build inside a running MapSim job');
      const forbidden=await invoke('POST','/api/sim/mapsim-job',{user:{id:402},body:{sessionId,jobId}});
      assert.equal(forbidden.status,403);
      for(let i=0;i<100&&!finishBuild;i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(builds,1);assert.equal(applied,1);
      const status=await invoke('POST','/api/sim/mapsim-job',{user,body:{sessionId,jobId}});
      assert.equal(status.body.job.phase,'build');finishBuild();
      let completed;
      for(let i=0;i<100;i++){
        completed=await invoke('POST','/api/sim/mapsim-job',{user,body:{sessionId,jobId}});
        if(completed.body.job.state==='succeeded')break;
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(completed.body.job.result.running,true);
    }finally{fs.rmSync(workspace,{recursive:true,force:true});}
  `);
});

test('real ROS MapSim save, restart and RViz streams deliver all Playground data', {skip:process.env.ROSIDE_TEST_ROS!=='1'}, () => {
  runIsolatedServerScenario(`
    globalThis.__routeTimeout=160000;
    const {createSimAgent,wsRoot}=require(${JSON.stringify(path.join(root,'sim.js'))});
    const key='SIM-playground-live-'+process.pid,workspace=wsRoot(key),sessionId='playground-live',user={id:303};
    const setup=process.env.ROSIDE_TEST_SETUP||'/opt/ros/jazzy/setup.bash';
    const map=process.env.ROSIDE_MAP_FIXTURE?JSON.parse(fs.readFileSync(process.env.ROSIDE_MAP_FIXTURE,'utf8')):{bounds:[-3,-3,3,3],start:[0,-2],walls:[[-3,-3,3,-3],[3,-3,3,3],[3,3,-3,3],[-3,3,-3,-3]],objects:[]};
    fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'map.json'),JSON.stringify(map));
    const agent=createSimAgent(key,{pendingReqs:hooks.pendingReqs,monSockets:hooks.monSockets,webSockets:hooks.webSockets,WebSocket,forwardPtyMessage:hooks.routeAgentPtyMessage});
    hooks.agents.set(key,agent);hooks.sessions.set(sessionId,{robotKey:key,userId:user.id,rosInfo:{setupBash:setup}});
    let socket;
    try{
      const applied=await invoke('POST','/api/sim/apply-map',{user,body:{sessionId,map}});
      assert.equal(applied.body.ok,true,JSON.stringify(applied.body));
      for(const topic of ['/map','/slam_map']){
        const began=Date.now();
        const started=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId}});
        assert.equal(started.body.ok,true,JSON.stringify(started.body));
        if(topic==='/slam_map')assert.equal(started.body.buildCached,true);
        socket=makeSocket(user);hooks.wss.emit('connection',socket,'/ws/rviz');
        socket.emit('message',JSON.stringify({type:'start',sessionId,odom:'/odom',laser:'/scan',map:topic,path:'/plan'}));
        const received=new Set(),deadline=Date.now()+35000;
        while(Date.now()<deadline&&received.size<6){
          for(const message of socket.sent.splice(0)){
            assert.notEqual(message.type,'error',JSON.stringify(message));
            if(message.type==='data'){
              const data=message.data;if(data.stream==='ready')received.add('runtime');
              for(const name of ['tf','odom','scan','map','desc'])if(data[name])received.add(name);
            }
          }
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        assert.deepEqual([...received].sort(),['desc','map','odom','runtime','scan','tf']);
        console.log('Live Playground '+topic+' ready in '+(Date.now()-began)+'ms');
        socket.close();socket=null;
      }
      const configured=await invoke('POST','/api/sim/configure-navigation',{user,body:{sessionId,radius:.26,clearance:.08,inflation:.1}});
      assert.equal(configured.body.ok,true,JSON.stringify(configured));
      const parameters=await invoke('POST','/api/sim/navigation-parameters',{user,body:{sessionId}});
      assert.equal(parameters.body.parameters.radius,.26);assert.equal(parameters.body.parameters.inflation,.34);
      const canceled=await invoke('POST','/api/sim/navigation-goal',{user,body:{sessionId,cancel:true}});
      assert.equal(canceled.body.ok,true,JSON.stringify(canceled));
      const slam=await invoke('POST','/api/sim/save-slam-map',{user,body:{sessionId,mapName:'regression_map'}});
      assert.equal(slam.body.ok,true,JSON.stringify(slam));
      assert.ok(fs.existsSync(path.join(workspace,'maps','regression_map','map.yaml')));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'map.json'),'utf8')),map);
    }finally{
      socket?.close();agent.ws.close();
      await new Promise(resolve=>setTimeout(resolve,6000));
      fs.rmSync(workspace,{recursive:true,force:true});
    }
  `,{timeout:240000});
});

test('twenty real ROS workspaces queue saves and stream RViz concurrently', {skip:process.env.ROSIDE_TEST_MULTIUSER!=='1'},()=>{
  runIsolatedServerScenario(`
    const {createSimAgent,wsRoot}=require(${JSON.stringify(path.join(root,'sim.js'))});
    const clients=[],startedAt=Date.now(),setup='/opt/ros/jazzy/setup.bash',userCount=Math.max(1,Math.min(60,Number(process.env.ROSIDE_TEST_MULTIUSER_COUNT)||20));
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const hostSample=()=>{
      const times=fs.readFileSync('/proc/stat','utf8').split('\\n')[0].trim().split(/\\s+/).slice(1,9).map(Number);
      return {total:times.reduce((a,b)=>a+b,0),idle:times[3]+times[4],available:Number(fs.readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\\s+(\\d+)/)[1])};
    };
    try{
      for(let i=0;i<userCount;i++){
        const key='SIM-multiuser-test-'+process.pid+'-'+i,sessionId='multiuser-'+i,user={id:800+i},workspace=wsRoot(key);
        const map={bounds:[-5,-5,5,5],start:[-3.6+(i%10)*.8,-3],startPose:{yaw:90},walls:[[-5,-5,5,-5],[5,-5,5,5],[5,5,-5,5],[-5,5,-5,-5],[-2,0,-1,0],[-1,0,-1,1],[-1,1,-2,1],[-2,1,-2,0],[1,0,2,0],[2,0,2,1],[2,1,1,1],[1,1,1,0]],objects:[]};
        const agent=createSimAgent(key,{pendingReqs:hooks.pendingReqs,monSockets:hooks.monSockets,webSockets:hooks.webSockets,WebSocket,forwardPtyMessage:hooks.routeAgentPtyMessage});
        hooks.agents.set(key,agent);hooks.sessions.set(sessionId,{robotKey:key,userId:user.id,rosInfo:{setupBash:setup}});
        const client={key,sessionId,user,workspace,agent,map,seen:new Set(),samples:0};clients.push(client);
        const submitted=await invoke('POST','/api/sim/run-mapsim',{user,body:{sessionId,map,async:true}});
        assert.equal(submitted.status,202,JSON.stringify(submitted));client.jobId=submitted.body.job.id;
      }
      assert.equal(new Set(clients.map(c=>c.agent._domainId)).size,userCount);
      const deadline=Date.now()+Math.max(300000,userCount*9000);
      while(clients.some(c=>!c.ready)&&Date.now()<deadline){
        for(const c of clients.filter(c=>!c.ready)){
          const status=await invoke('POST','/api/sim/mapsim-job',{user:c.user,body:{sessionId:c.sessionId,jobId:c.jobId}});
          assert.equal(status.body.ok,true);assert.notEqual(status.body.job.state,'failed',JSON.stringify(status.body.job));
          if(status.body.job.state==='succeeded'){
            c.ready=true;c.readyMs=Date.now()-startedAt;
            c.socket=makeSocket(c.user);hooks.wss.emit('connection',c.socket,'/ws/rviz');
            c.socket.emit('message',JSON.stringify({type:'start',sessionId:c.sessionId,odom:'/odom',laser:'/scan',map:'/slam_map',path:'/plan'}));
          }
        }
        await wait(500);
      }
      assert.ok(clients.every(c=>c.ready),'not all 20 builds completed');
      const collect=()=>{
        for(const c of clients)for(const message of c.socket.sent.splice(0)){
          assert.notEqual(message.type,'error',JSON.stringify(message));
          if(message.type==='data'){
            const d=message.data;
            for(const name of ['tf','odom','scan','map','desc'])if(d[name])c.seen.add(name);
            if(d.odom){c.samples++;c.lastOdom=d.odom;}
            if(d.nav_status)c.navStatus=d.nav_status;
          }
        }
      };
      const streamDeadline=Date.now()+35000;
      while(clients.some(c=>c.seen.size<5)&&Date.now()<streamDeadline){collect();await wait(100);}
      assert.ok(clients.every(c=>c.seen.size===5),'one or more clients missed a stream');
      const before=hostSample();clients.forEach(c=>{c.samples=0;});
      for(let i=0;i<100;i++){collect();await wait(100);}
      const after=hostSample();
      assert.ok(clients.every(c=>c.samples>=20),'a concurrent stream stalled');
      for(const c of clients){
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.workspace,'map.json'),'utf8')),c.map);
        assert.ok(Math.abs(c.lastOdom.x-c.map.start[0])<.02,'pose crossed workspace boundaries');
        assert.ok(Math.abs(Math.abs(c.lastOdom.qz)-Math.SQRT1_2)<.02,'saved yaw was not applied');
      }
      console.log('MULTIUSER_RESULT '+JSON.stringify({users:userCount,streams:100,firstReadyMs:Math.min(...clients.map(c=>c.readyMs)),lastReadyMs:Math.max(...clients.map(c=>c.readyMs)),minOdomHz:Math.min(...clients.map(c=>c.samples))/10,hostCpuPercent:Math.round(100*(1-(after.idle-before.idle)/(after.total-before.total))),hostAvailableMiB:Math.round(after.available/1024)}));
      if(process.env.ROSIDE_TEST_MULTIUSER_NAV==='1'){
        const configured=await Promise.all(clients.map(c=>invoke('POST','/api/sim/configure-navigation',{user:c.user,body:{sessionId:c.sessionId,speed:.45}})));
        assert.ok(configured.every(r=>r.body.ok),JSON.stringify(configured));
        const started=Date.now(),goals=await Promise.all(clients.map(c=>invoke('POST','/api/sim/navigation-goal',{user:c.user,body:{sessionId:c.sessionId,x:c.map.start[0],y:2.2,yaw:0}})));
        assert.ok(goals.every(r=>r.body.ok),JSON.stringify(goals));
        const navBefore=hostSample();clients.forEach(c=>{c.samples=0;});
        const navDeadline=Date.now()+60000;
        while(clients.some(c=>c.navStatus?.state!=='succeeded')&&Date.now()<navDeadline){
          collect();
          for(const c of clients){
            assert.notEqual(c.navStatus?.state,'failed',JSON.stringify({key:c.key,status:c.navStatus,pose:c.lastOdom}));
            assert.notEqual(c.navStatus?.state,'blocked',JSON.stringify({key:c.key,status:c.navStatus,pose:c.lastOdom}));
            if(c.lastOdom){
              const {x,y}=c.lastOdom;
              for(const [x1,y1,x2,y2] of c.map.walls){
                const dx=x2-x1,dy=y2-y1,t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)));
                assert.ok(Math.hypot(x-(x1+dx*t),y-(y1+dy*t))>=.319,'clearance violation '+JSON.stringify({key:c.key,x,y}));
              }
            }
          }
          await wait(100);
        }
        const navAfter=hostSample();
        assert.ok(clients.every(c=>c.navStatus?.state==='succeeded'),JSON.stringify(clients.map(c=>({key:c.key,status:c.navStatus,pose:c.lastOdom}))));
        console.log('NAVIGATION_MULTIUSER_RESULT '+JSON.stringify({users:userCount,succeeded:clients.filter(c=>c.navStatus?.state==='succeeded').length,elapsedMs:Date.now()-started,minOdomHz:Math.round(Math.min(...clients.map(c=>c.samples))*10000/(Date.now()-started))/10,hostCpuPercent:Math.round(100*(1-(navAfter.idle-navBefore.idle)/(navAfter.total-navBefore.total)))}));
      }
    }finally{
      clients.forEach(c=>{c.socket?.close();c.agent.ws.close();hooks.sessions.delete(c.sessionId);});
      await wait(6500);
      for(const c of clients)fs.rmSync(c.workspace,{recursive:true,force:true});
    }
  `,{timeout:Math.max(360000,(Number(process.env.ROSIDE_TEST_MULTIUSER_COUNT)||20)*10000+120000),report:true});
});

test('Robots page reports ROS Wizzard progress from each configured workspace', () => {
  const server=read('server.js'),robots=read('public/robots.html'),scanner=read('project-scanner.js');
  assert.match(server,/const SIMULATION_WIZARD_ORDER=\['urdf','lidar','control','mapping','navigation'\]/);
  assert.match(server,/const REAL_ROBOT_WIZARD_ORDER=\['system','urdf','lidar','hardware','pid','control','mapping','navigation'\]/);
  assert.match(server,/block\('urdf',\['system'\]\)/);
  assert.match(server,/if\(isSim\(s\.robotKey\)\)return res\.status\(400\)\.json\(\{ok:false,error:'ภารกิจตรวจระบบใช้สำหรับหุ่นยนต์จริงเท่านั้น'\}\)/);
  assert.match(server,/const REAL_ROBOT_OPTIONAL_ORDER=\[\]/);
  assert.match(server,/function inspectRobotWizardProgress\(robot\)/);
  assert.match(server,/buildProjectScanScript\(workspace\)/);
  assert.match(server,/parseProjectScanOutput\(result\.stdout\)/);
  assert.match(server,/inspectSimulationMissionArtifacts\(workspace\)/);
  assert.match(server,/wizardProgress:robotWizardProgressView\(robot\)/);
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
  assert.match(server,/const isOwner=Number\(robot\.added_by\)===Number\(req\.user\.id\)/);
  assert.match(server,/isOwn:req\.user\.role==='admin'\?isOwner:true/);
  assert.match(server,/FROM robot_user_access rua JOIN robots r ON r\.id=rua\.robot_id WHERE rua\.user_id=\?/);
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

test('simulation completes map replacement and honors an exec timeout before the request expires', async () => {
  const key=`SIM-save-timeout-regression-${process.pid}`,pendingReqs=new Map();
  const agent=require('../sim').createSimAgent(key,{pendingReqs,monSockets:new Map(),webSockets:new Map(),WebSocket:{OPEN:1}});
  try{
    const map={bounds:[-4,-4,4,4],start:[0,0],walls:[],objects:[]};
    await agent.respawnBackend(map);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(wsRoot(key),'map.json'),'utf8')),map);
    const began=Date.now();
    const response=await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('exec did not honor its shorter timeout')),4000);
      pendingReqs.set('timeout-test',result=>{clearTimeout(deadline);resolve(result);});
      agent.ws.send(JSON.stringify({type:'request',reqId:'timeout-test',action:'exec',payload:{command:'sleep 10 & echo $!; wait',timeout:1000}}));
    });
    assert.equal(response.ok,true);assert.notEqual(response.data.code,0);
    assert.match(response.data.stderr,/timed out/);assert.ok(Date.now()-began<4000);
    const childPid=Number(response.data.stdout.trim());assert.ok(childPid>0);
    let childState;
    for(let attempt=0;attempt<25;attempt++){
      childState=undefined;try{childState=fs.readFileSync(`/proc/${childPid}/stat`,'utf8').split(') ')[1][0];}catch{}
      if(!childState||childState==='Z')break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(!childState||childState==='Z','timed-out shell must not leave its child running');
  }finally{
    agent.ws.close();fs.rmSync(wsRoot(key),{recursive:true,force:true});
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
  assert.match(dashboard,/SIMULATION_WIZARD_ORDER = \['urdf','lidar','control','mapping','navigation'\]/);
  assert.match(dashboard,/REAL_ROBOT_WIZARD_ORDER = \['system','urdf','lidar','hardware','pid','control','mapping','navigation'\]/);
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
  assert.match(realRobot[1].dependencyMessage,/Hardware/);
});

test('real wizard skips tuning and selects mission 5 without fabricating PID verification', () => {
  const context={window:{},document:{addEventListener:()=>{}},console,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(read('public/dashboard.js')+'\n;globalThis.dependencies=applyAgvWizardDependencies;',context);
  const backend=read('server.js'),serverContext={};
  vm.runInNewContext(backend.slice(backend.indexOf('const SIMULATION_WIZARD_ORDER='),backend.indexOf('const ROBOT_LIMITS='))+'\n'+backend.slice(backend.indexOf('function summarizeRobotWizard('),backend.indexOf('async function inspectRealRobotSystem('))+'\n;globalThis.summarize=summarizeRobotWizard;',serverContext);
  const fixture=()=>['system','urdf','tf','odom','lidar','hardware','pid','control','mapping','navigation'].map(id=>({id,detected:!['pid','control','mapping','navigation'].includes(id),tuneVerified:false}));
  const capabilities=context.dependencies(fixture(),false);
  const pid=capabilities.find(item=>item.id==='pid');
  assert.equal(pid.skipped,true);
  assert.equal(pid.detected,false);
  assert.equal(pid.tuneVerified,false);
  assert.notEqual(capabilities.find(item=>item.id==='control').dependencyBlocked,true);
  const next=capabilities.filter(item=>!item.skipped&&!['tf','odom'].includes(item.id)).find(item=>!item.detected);
  assert.equal(next.id,'control');
  const summary=serverContext.summarize(fixture(),false);
  assert.equal(summary.next,'control');
  assert.equal(summary.total,7);
  const complete=fixture().map(item=>({...item,detected:item.id!=='pid',mappingVerified:true}));
  assert.equal(serverContext.summarize(complete,false).percent,100);
  const withoutHardware=fixture().map(item=>({...item,detected:item.id==='hardware'?false:item.detected}));
  assert.equal(context.dependencies(withoutHardware,false).find(item=>item.id==='control').dependencyBlocked,true);
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
  assert.match(html,/dashboard\.js\?v=[A-Za-z0-9-]+/);
});

test('real robot wizard starts with system readiness before the navigation commissioning path', () => {
  const dashboard=read('public/dashboard.js'),server=read('server.js');
  const expected="['system','urdf','lidar','hardware','pid','control','mapping','navigation']";
  assert.ok(dashboard.includes(`REAL_ROBOT_WIZARD_ORDER = ${expected}`));
  assert.ok(server.includes(`REAL_ROBOT_WIZARD_ORDER=${expected}`));
  for(const removed of ['safety','diagnostics','automation','deployment','camera','perception','manipulation','imu','calibration','localization']){
    assert.equal(expected.includes(`'${removed}'`),false,removed);
  }
  for(const dependency of ["block('urdf',['system']","block('pid',['hardware']","block('control',['hardware']","block('mapping',['control','lidar']","block('navigation',['mapping']"]){
    assert.ok(dashboard.includes(dependency),dependency);
  }
  assert.match(server,/block\('navigation',\['mapping'\]\)/);
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
  assert.match(server,/ROSIDE_LOG_STATE=missing/);
  assert.match(server,/platform\.log/);
  assert.match(server,/ROSIDE_PLATFORM_LOG_BEGIN/);
  assert.match(server,/FAILED stage=\$\{currentStage\}/);
  assert.match(server,/action==='start'&&!processRunning/);
  assert.match(server,/action==='start'&&!topicReady/);
  assert.match(server,/command:conflictingRuntimeStop,timeout:10000/);
  assert.doesNotMatch(server,/\$\{stopCommand\}; \$\{conflictingRuntimeStop\}; : > \$\{remoteShellPath\(paths\.log\)\}/);
  assert.match(lidar,/result\.action==='status'\?\[result\.platformLog/);
  assert.match(html,/เปิด Driver \+ ทดสอบ/);
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
  assert.match(server,/sudoPassword:decrypt\(currentRobot\.ssh_pass\)/);
  assert.match(server,/function lidarDirectLaunchCommand/);
  assert.match(server,/USB LiDARs must never silently fall back to the board UART/);
  assert.match(server,/USB\|ACM\)\\d\+/);
  assert.match(server,/channel_type:=serial[\s\S]+scan_mode:=Standard/);
  assert.match(server,/async function ensureSllidarChannelFix/);
  assert.match(server,/Result<nullptr_t> ans = SL_RESULT_OK/);
  assert.match(server,/ans = RESULT_OK/);
  assert.match(server,/packages-select sllidar_ros2/);
  assert.match(server,/sllidar-channel-fix-v1/);
  assert.match(server,/function lidarSerialPreflightCommand/);
  assert.match(server,/ROSIDE_SERIAL_PREFLIGHT=failed/);
  assert.match(server,/async function resetRobotUsbSerial/);
  assert.match(server,/ROSIDE_USB_RESET=begin/);
  assert.match(server,/cp210x\|ch341\|ftdi_sio\|usbserial/);
  assert.match(server,/fcntl\.ioctl\(fd,21780,0\)/);
  assert.match(server,/resetRobotUsbSerial\(session,port,password,'device'\)/);
  assert.match(server,/async function restoreDetachedUsbSerial/);
  assert.match(server,/detached_silicon_labs_candidates/);
  assert.match(server,/\/sys\/class\/tty\/ttyUSB\*\/device/);
  assert.match(server,/ROSIDE_USB_RESTORE=ready/);
  assert.match(server,/async function runLidarStartWithUsbRecovery/);
  assert.match(server,/Errno 5\|Input\\\/output error/);
  assert.match(server,/conflictingRuntimeStop/);
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
  assert.match(dashboard,/const designReady=\['urdf','lidar'\]\.every/);
  assert.match(dashboard,/hardware\.dependencyMessage='ทำ Robot Model, TF, ODOM และติดตั้ง LIDAR ให้สำเร็จก่อน/);
  assert.match(hardware,/sim_robot_tf\/tf_model\.json/);
  assert.match(hardware,/sim_robot_odom\/odom_config\.json/);
  assert.match(hardware,/pattern==='differential'&&motorCount===2\?'diff2'/);
  assert.match(hardware,/function renderDiagram\(\)/);
  assert.match(html,/Controller Pinout Diagram/);
  assert.match(hardware,/function pinoutCard\(/);
  assert.match(hardware,/function drawPinoutLines\(\)/);
  assert.match(hardware,/BLUE PILL · UART1 PA9\/PA10/);
  assert.match(hardware,/HardwareSerial SerialBridge\(PA10, PA9\)/);
  assert.match(hardware,/\['PB14','PB15','PB0','PA2','PA3'\]/);
  assert.doesNotMatch(hardware,/\['PB14','PB15','PA9','PA2','PA3'\]/);
  assert.match(hardware,/trig:'PA11',echo:'PA12'/);
  assert.match(hardware,/Motor Driver|driverLabel/);
  assert.match(hardware,/Encoder · \$\{encoder\.name\}/);
  assert.match(hardware,/configuredEncoders\.find\(item=>item\.name===component\.name\)\|\|\(!xy\?configuredEncoders\[index\]:null\)/);
  assert.match(hardware,/<option value="">\$\{esc\(encoder\.name\)\}<\/option>/);
  assert.match(hardware,/<small>frame_id<\/small>/);
  assert.match(html,/hardware\.js\?v=[A-Za-z0-9-]+/);
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
  const modalMarkup=html.slice(html.indexOf('<div class="code-modal"'),html.indexOf('<script src="/hardware-visuals.js'));
  assert.ok(modalMarkup.indexOf('id="upload-port"')<modalMarkup.indexOf('class="code-tabs"'),'COM port and Build/Upload controls should lead the modal');
  assert.match(html,/\.code-modal\{display:flex;align-items:center;justify-content:center/);
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
  assert.match(html,/hardware\.js\?v=[A-Za-z0-9-]+/);
  assert.match(hardware,/function writeHardwareBuildEvidence\(base,state,config=null\)/);
  assert.match(hardware,/build_verified\.json/);
  assert.match(hardware,/capability:'serial_bridge'/);
  assert.match(hardware,/transport:'python_serial'/);
  assert.match(html,/id="bridge-serial-port"/);
  assert.match(html,/id="pid-kp"/);
  assert.match(html,/id="pid-control-enabled"[^>]+checked/);
  assert.match(html,/data-code-file="controller_bridge\.py"/);
  assert.match(hardware,/if\(!hardwareSupported\(\)\)/);
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
  assert.match(index,/transformation\.js\?v=20261015-mecanum-xy2/);
  assert.match(transformation,/function tfDetectEncoders\(/);
  assert.match(transformation,/Encoder ทั้งหมดจาก Robot Model/);
  assert.match(transformation,/encoders:\(o\.encoders\|\|\[\]\)\.map/);
  assert.match(hardware,/sourceEncoders/);
  assert.match(hardware,/ENCODER จาก MODEL/);
  assert.match(hardware,/encoderAssignments/);
  assert.match(hardware,/มี Encoder ติดท้ายมอเตอร์/);
  assert.match(hardware,/encoderEnabled=isMecanumXY\(\)\?false:\(encoder\?!!encoder\.enabled:!!wheel\.encoderEnabled\)/);
  assert.match(hardware,/ppr:encoder\?\.ppr\|\|wheel\.ppr\|\|600/);
  assert.match(hardware,/version:18/);
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
  assert.match(html,/hardware\.js\?v=[A-Za-z0-9-]+/);
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
  assert.match(html,/id="tune-dashboard"/);
  assert.match(html,/id="td-add-chart"/);
  assert.match(html,/tune-dashboard\.js\?v=20261016-pose-dashboard/);
  assert.match(html,/tune\.js\?v=20261016-pose-dashboard/);
  assert.match(html,/data-test="forward"/);
  assert.match(tune,/\/ws\/controller-tune/);
  assert.match(tune,/data\.event==='port_open'/);
  assert.match(tune,/data\.event!==\'frame\'/);
  assert.match(tune,/data\.kind==='RPM'/);
  assert.match(tune,/data\.kind==='GYRO'/);
  assert.match(tune,/tuneDashboard\?\.ingest\(data\)/);
  assert.match(tune,/function configuredGyro\(config\)/);
  assert.match(tune,/pidControlEnabled=!positionOnly&&hardwareConfig\.pidControl!==false/);
  assert.match(tune,/\$\('pid-card'\)\.hidden=!pidControlEnabled/);
  assert.match(tune,/!pidControlEnabled\|\|pidAcks>0/);
  assert.match(tune,/hasEncoder/);
  assert.match(tune,/gyroCapability=configuredGyro\(hardwareConfig\)/);
  assert.match(tune,/state\('gyro-state','NO DATA'/);
  assert.match(tune,/state\('rpm-state','NO DATA'/);
  assert.doesNotMatch(html,/id="gyro-card"/);
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

test('real robot mission zero selects Humble or Jazzy without changing the SIM order', () => {
  const dashboard=read('public/dashboard.js'),server=read('server.js');
  assert.match(dashboard,/const SIMULATION_WIZARD_ORDER = \['urdf','lidar','control','mapping','navigation'\]/);
  assert.match(dashboard,/const REAL_ROBOT_WIZARD_ORDER = \['system','urdf','lidar','hardware','pid','control','mapping','navigation'\]/);
  assert.match(dashboard,/name:'ตรวจความพร้อมระบบ'/);
  assert.match(dashboard,/runRealSystemCheck\(false\)/);
  assert.match(dashboard,/runRealSystemCheck\(true\)/);
  assert.match(server,/inspectRealRobotSystem\(session\.robotKey\)/);
  assert.match(server,/buildRealSystemInstallCommand\(distro\)/);
  assert.match(server,/rosdep update --rosdistro \$\{distro\}/);
  assert.match(dashboard,/Ubuntu 22\.04 LTS \(Jammy\).*ROS 2 Humble/);
});

test('SIM LiDAR mission opens Map Editor and stores an installable hardware choice', () => {
  const html=read('public/index.html'), dashboard=read('public/dashboard.js'), map=read('public/map.js'), server=read('server.js');
  assert.match(server,/robotName:robot\.access_alias\|\|robot\.name,isSim:isSim\(robot\.robot_key\)/);
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
  assert.equal((assetBlock.match(/\['[^']+','[^']+','[^']+'/g)||[]).length,51);
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
  assert.match(editor,/\/api\/sim\/run-mapsim/);
  assert.match(server,/app\.post\('\/api\/sim\/run-mapsim'/);
  assert.match(server,/cat install\/\.colcon_install_layout/);
  assert.match(server,/= \"merged\"/);
  assert.match(server,/colcon build --merge-install --executor sequential --parallel-workers 1 --packages-select sim_robot_mapsim/);
  assert.match(server,/colcon build --executor sequential --parallel-workers 1 --packages-select sim_robot_mapsim/);
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
  assert.match(playground,/function playgroundConnectRuntime/);
  assert.match(playground,/await playgroundConnectRuntime\(\)/);
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
  assert.match(playground,/MapSceneAssets\.build\(obj,objects\)/);
  assert.match(playground,/group\.rotation\.y=Math\.PI\/2/);
  assert.match(rviz,/const TELEOP_RATE = 30/);
  assert.match(rviz,/const TELEOP_IDLE_STOP_MS = 5000/);
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
  const source=transformation+'\n;globalThis.__tf=tf;globalThis.__templates=TF_ROBOT_TEMPLATES;globalThis.__apply=tfApplyRobotTemplate;globalThis.__applyComps=tfApplyComps;globalThis.__buildUrdf=tfBuildURDF;globalThis.__buildModel=tfBuildModelJSON;globalThis.__clear=tfClearRenderedComponents;';
  const storage=new Map(),context={
    window:{addEventListener:()=>{},confirm:()=>true},
    document:{getElementById:()=>null,querySelectorAll:()=>[]},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    requestAnimationFrame:()=>{},performance:{now:()=>0},setTimeout,
    sbMsg:()=>{},escH:value=>String(value),encArg:value=>String(value),
    THREE:{MathUtils:{degToRad:value=>value*Math.PI/180}},
    RobotVisuals:require('../public/robot-visuals'),
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
    const base=context.__tf.comps.find(part=>part.type==='base');
    assert.equal(base.pos.z,0,kind+' base_link Z');
    assert.equal(base.baseOrigin,'bottom_center',kind+' base origin convention');
  }
  const urdf=context.__buildUrdf();
  assert.match(urdf,/<link name="base_link">\s*<visual><origin xyz="0\.000000 0\.000000 0\.090000"/);
  assert.match(urdf,/<collision><origin xyz="0\.000 0\.000 0\.090"/);

  const legacy=[
    {id:'legacy-base',type:'base',name:'base_link',parent:'',pos:{x:.2,y:-.1,z:.12},rpy:{r:0,p:0,y:0},params:{sx:.58,sy:.4,sz:.18}},
    {id:'legacy-lidar',type:'lidar',name:'laser_link',parent:'base_link',pos:{x:.12,y:0,z:.15},rpy:{r:0,p:0,y:0},params:{radius:.055,height:.09}},
  ];
  context.__applyComps(legacy);
  assert.deepEqual(context.__tf.comps[0].pos,{x:.2,y:-.1,z:0},'legacy base keeps X/Y but moves to Z=0');
  assert.equal(context.__tf.comps[1].pos.z,.24,'legacy child is shifted once to preserve its chassis-relative placement');
  context.__applyComps(JSON.parse(context.__buildModel()));
  assert.equal(context.__tf.comps[1].pos.z,.24,'bottom-origin models must not be migrated twice');
  const chassisParts=context.RobotVisuals.parts(context.__tf.comps[0]).filter(p=>p.shape==='box');
  assert.ok(chassisParts.every(p=>p.xyz[2]-p.size[2]/2>=-1e-8),'chassis geometry stays above base_link');
  assert.match(transformation,/c\.pos\.z = c\.type === 'base' \? 0/);
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
  assert.equal(Object.values(context.__templates).filter(t=>!t.articulated).length,7);
  assert.equal(Object.values(context.__templates).filter(t=>t.articulated).length,3);
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
  assert.match(sim,/if self\.nav_goal is None and tick_now-self\._last_slam_publish>=0\.5 and scan_pose!=self\._slam_pose:\n\s+self\._last_slam_publish=tick_now\n\s+self\._integrate_slam_scan/);
  assert.match(sim,/sim_robot_nav_map/);
  assert.match(sim,/map\.pgm/);
  assert.match(sim,/map\.yaml/);
  assert.match(server,/app\.post\('\/api\/sim\/save-slam-map'/);
  assert.match(server,/colcon build[^\n]+sim_robot_nav_map/);
  assert.match(server,/function cleanupStaleSimMapBuilds\(root\)/);
  assert.match(server,/CMakeCache[.]txt/);
  assert.match(server,/removedStaleArtifacts/);
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
  assert.match(server,/const mapsimQueue = new MapsimQueue\(/);
  assert.match(server,/mapsimQueue\.enqueue\(s\.robotKey/);
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
  assert.match(read('sim-navigation.py'),/heapq\.heappush/);
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
  assert.equal((html.match(/class="real-teleop-btn" data-dir=/g)||[]).length,6);
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
  const keySource=dashboard.slice(dashboard.indexOf('function realTeleopKeyDirection('),dashboard.indexOf('function realTeleopSendDrive('));
  for(const mecanum of [false,true]){const context=vm.createContext({realTeleopIsMecanum:()=>mecanum});vm.runInContext(keySource,context);assert.equal(context.realTeleopKeyDirection('a'),mecanum?'strafe-left':'left');assert.equal(context.realTeleopKeyDirection('d'),mecanum?'strafe-right':'right');}
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
  assert.match(html,/guide\.js\?v=20260912-real-ros-distros/);
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
  assert.match(html,/id="lidar-model"/);
  assert.match(html,/RPLIDAR C1 · 460800/);
  assert.match(html,/id="refresh-ports"/);
  assert.match(js,/controllerPort/);
  assert.match(server,/req\.body\.controllerPort/);
  assert.match(server,/req\.body\.lidarPort/);
  const commandSource=js.slice(js.indexOf('function commandFor('),js.indexOf('function sendDrive('));
  const commandContext=vm.createContext({mappingHardware:{drive:'diff2'},RealDriveMotion:require('../public/real-drive-motion'),$:id=>({value:id==='linear'?'.2':'.6'})});vm.runInContext(commandSource,commandContext);assert.equal(commandContext.commandFor('forward'),'CMD 0.2 0');assert.equal(commandContext.commandFor('left'),'CMD 0 0.6');
  assert.match(html,/id="controller-state"/);
  assert.match(server,/serial\.Serial\(PORT,BAUD,timeout=0\)/);
  assert.match(server,/send\('V %\.4f 0 %\.4f'/);
  assert.match(js,/driveTimer=setInterval\(\(\)=>sendDrive\(kind\),100\)/);
  assert.match(js,/Controller TX →/);
  assert.match(html,/NO MAP DATA/);
  assert.match(html,/#empty\[hidden\]\{display:none!important\}/);
  assert.match(js,/const renderMappingBase=draw/);
  assert.match(server,/lidarPid:'~\/\.roside\/mapping-runtime\/lidar\.pid'/);
  assert.match(server,/lidarLog:'~\/\.roside\/mapping-runtime\/lidar\.log'/);
  assert.match(server,/ROSIDE_MAPPING_LIDAR_CLEANUP_BEGIN/);
  assert.match(server,/ROSIDE_MAPPING_LIDAR_DIED_BEFORE_SCAN/);
  assert.match(server,/ROSIDE_MAPPING_SCAN_WAIT_FAILED/);
  assert.match(server,/ROSIDE_LIDAR_CONFIG model=/);
  assert.match(server,/เปิด serial ได้ แต่ LiDAR ไม่ตอบ DeviceInfo/);
  assert.match(server,/lidarTfLaunchCommands/);
  assert.match(server,/timeout 8s ros2 run tf2_ros static_transform_publisher[\s\S]*frame-id odom --child-frame-id base_link[\s\S]*roside_odom_bootstrap/);
  assert.doesNotMatch(server,/ros2 launch sim_robot_tf tf_static\.launch\.py/);
  assert.match(js,/function checkMappingDiagnostics/);
  assert.match(js,/result\.lidarRunning===false/);
  assert.match(js,/status\.processRunning&&status\.lidarRunning/);
  assert.match(js,/lidarModelId/);
  assert.match(server,/requestedLidarModelId/);
  assert.match(server,/lidarModelId:req\.body\.lidarModelId/);
  assert.match(js,/function enforceMappingUsbLidarPort/);
  assert.match(js,/RECOVERED ระบบบนหุ่นยนต์ทำงานอยู่จริง/);
  assert.match(js,/\/dev\/ttyUSB0 · รอกู้การเชื่อมต่อ USB/);
  assert.match(dashboard,/realMapping: true/);
  assert.match(scanner,/mapping_result\.json/);
});

test('real robot Nav2 page reuses Mapping map and drives controller from cmd_vel',()=>{
  const server=read('server.js'),dashboard=read('public/dashboard.js'),html=read('public/navigation.html'),js=read('public/navigation.js');
  assert.match(server,/app\.get\('\/navigation'/);
  assert.match(server,/app\.post\('\/api\/navigation\/maps'/);
  assert.match(server,/app\.post\('\/api\/navigation\/map-data'/);
  assert.match(server,/source:'saved-map-files'/);
  assert.match(server,/app\.post\('\/api\/navigation\/runtime'/);
  assert.match(server,/nav2_bringup bringup_launch\.py/);
  assert.match(server,/sed 's\/base_footprint\/base_link\/g'/);
  assert.match(server,/params_file:=\$\{remoteShellPath\(navParams\)\}/);
  assert.match(server,/for _ in range\(3\).*initial_pub\.publish/);
  assert.match(server,/\{requireSlam:false,lidarModelId:req\.body\.lidarModelId\}/);
  assert.match(server,/timeout 4s ros2 topic echo --once \/scan/);
  assert.match(server,/lidarPid:'~\/\.roside\/navigation-runtime\/lidar\.pid'/);
  assert.match(server,/lidarLog:'~\/\.roside\/navigation-runtime\/lidar\.log'/);
  assert.match(server,/ROSIDE_LIDAR=running/);
  assert.match(server,/stage:'launch-lidar'/);
  assert.match(server,/lidarRunning,lidarLog/);
  assert.match(server,/fuser -k/);
  assert.match(server,/pkill -KILL -f \$\{staleLidarPattern\}/);
  assert.match(server,/ROSIDE_LIDAR_CLEANUP_BEGIN/);
  assert.match(server,/ROSIDE_OLD_NAV_NODES_BEGIN/);
  assert.match(server,/ROSIDE_NAV_CLEANUP_REMAINING_BEGIN/);
  assert.match(server,/\[c\]ontroller_server/);
  assert.match(server,/\[c\]ontroller_bridge\.py --ros-args/);
  assert.match(server,/grep -E '\[r\]oside_navigation_live\|\[c\]ontroller_bridge/);
  assert.match(server,/nav_script=\/tmp\/_roside_navigation_\\\$\(printf live\)\.py/);
  assert.match(server,/frame_id:=\$\{frame\}/);
  assert.match(server,/lidarTfLaunchCommands/);
  assert.match(server,/ros2 topic echo --once \/scan --qos-reliability best_effort/);
  assert.match(server,/scan_ok=\$\(\(scan_ok\+1\)\)/);
  assert.match(server,/ROSIDE_LIDAR_START_FAILED/);
  assert.match(server,/ROSIDE_SCAN_WAIT_FAILED/);
  assert.match(server,/ROSIDE_SCAN_TOPICS=/);
  assert.match(server,/scanPublisherCount/);
  assert.match(server,/scanTopicPresent/);
  assert.match(server,/NavigateToPose/);
  assert.match(server,/NavigateThroughPoses/);
  assert.match(server,/navigate_through_poses/);
  assert.match(server,/create_subscription\(Twist,'\/cmd_vel'/);
  assert.match(server,/MIN_SPEED=\$\{minSpeed\}/);
  assert.match(server,/def commanded_speed/);
  assert.match(server,/from nav_msgs\.srv import GetMap/);
  assert.match(server,/map_client=n\.create_client\(GetMap,'\/map_server\/map'\)/);
  assert.match(server,/map_future=map_client\.call_async\(GetMap\.Request\(\)\)/);
  assert.match(server,/event='bridge_ready'/);
  assert.match(server,/vx=commanded_speed\(m\.linear\.x,MAX_SPEED\)/);
  assert.match(server,/wz=commanded_speed\(m\.angular\.z,MAX_TURN\)/);
  assert.match(server,/math\.copysign\(target,value\) if abs\(value\)>1e-5 else 0\.0/);
  assert.match(server,/navMaxSpeedYaml=navMaxSpeed\.toFixed\(6\)/);
  assert.match(server,/\[\$\{navMaxSpeedYaml\}, 0\.0, \$\{navMaxTurnYaml\}\]/);
  assert.match(js,/เชื่อม Nav2 stream แล้ว/);
  assert.match(server,/minSpeed>\s*Math\.min\(10,maxSpeed\)/);
  assert.match(js,/minSpeed:Number\(\$\('min-speed'\)\.value\)/);
  assert.match(server,/pathname==='\/ws\/navigation'/);
  assert.match(dashboard,/realNavigation:\s*true/);
  assert.match(dashboard,/window\.location\.assign\('\/navigation'\)/);
  for(const id of ['map-select','controller-port','lidar-port','lidar-model','pose-mode','goal-mode','route-mode','run-route','nav-canvas'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/lidarModelId/);
  assert.match(html,/#empty\[hidden\]\{display:none!important\}/);
  assert.match(js,/onpointerdown=pointerDown/);
  assert.match(js,/poseDraft=\{\.\.\.p,yaw:0,dragged:false\}/);
  assert.match(js,/function pointerUp/);
  assert.match(js,/Math\.atan2\(dy,dx\)/);
  assert.match(js,/ยังไม่ได้รับ \/amcl_pose จึงยังวางแผนไม่ได้/);
  assert.match(js,/function sendInitialPoseUntilLocalized/);
  assert.match(js,/poseRetryCount<5/);
  assert.match(js,/function updatePlanningProgress/);
  assert.match(js,/ยังไม่ได้เส้นทางหลัง/);
  assert.match(js,/function checkNavigationDiagnostics/);
  assert.match(js,/function loadSavedMap/);
  assert.match(js,/\/api\/navigation\/map-data/);
  assert.match(js,/action:'status'/);
  assert.match(js,/lidarRunning===false/);
  assert.match(js,/LIDAR ERROR/);
  assert.match(js,/รันอยู่แต่ยังไม่ได้ข้อมูล \/scan/);
  assert.match(js,/scanPublisherCount/);
  assert.match(js,/function enforceNavigationUsbLidarPort/);
  assert.match(js,/mapping_result\.json/);
  assert.match(js,/`POSE \$\{initialPose\.x\}/);
  assert.match(js,/`GOAL \$\{draft\.x\} \$\{draft\.y\} \$\{draft\.yaw\}`/);
  assert.match(js,/`SPEED \$\{maxSpeed\}/);
  assert.match(html,/id="speed"[^>]+max="10\.00"/);
  assert.match(html,/id="turn"[^>]+max="10\.00"/);
  assert.match(html,/id="speed"[^>]+value="2\.00"/);
  assert.match(html,/id="turn"[^>]+value="2\.00"/);
  assert.match(html,/id="min-speed"[^>]+max="10\.00"/);
  assert.match(html,/id="min-turn"[^>]+max="10\.00"/);
  assert.match(server,/maxSpeed>10/);
  assert.match(server,/maxTurn>10/);
  assert.match(server,/f\[0\]=='SPEED'/);
  assert.match(server,/function apply_nav_speed|def apply_nav_speed/);
  assert.match(server,/FollowPath\.desired_linear_vel/);
  assert.match(server,/FollowPath\.max_vel_theta/);
  assert.match(server,/AsyncParameterClient/);
  assert.match(server,/max_vel_x\|max_speed_xy\|desired_linear_vel/);
  assert.match(server,/max_vel_theta\|rotate_to_heading_angular_vel/);
  assert.match(js,/requestAnimationFrame/);
  assert.match(js,/mapBitmap=document\.createElement\('canvas'\)/);
  assert.match(js,/send\('CANCEL'\)/);
  assert.match(js,/type:'route',points/);
});
