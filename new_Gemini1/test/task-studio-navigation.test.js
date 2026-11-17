'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const entry=fs.readFileSync('public/task-studio-entry.js','utf8');
const pages=['dashboard','editor','flow','transformation','lidar','monitor','run','rviz','status','terminal'];
function fixture(page,options={}){
  const clicks=[],replacements=[],context={URL,sessionId:options.session??'real',isSimWorkspace:options.sim??false,terminalPlanAccessResolved:options.resolved??true,terminalPlanAccess:options.paid??true,location:{href:'https://robot.example/app?keep=1'+(page===null?'':'&task_studio_page='+encodeURIComponent(page))+'#draft'},history:{state:{saved:true}},document:{getElementById:()=>null},window:null};
  context.switchPage=p=>clicks.push(p==='terminal'&&!context.terminalPlanAccess?'dashboard':p);
  context.document.querySelectorAll=()=>pages.map(p=>({getAttribute:()=>`switchPage('${p}'); existingInit()`,click:()=>context.switchPage(p)}));
  context.history.replaceState=(state,unused,url)=>{replacements.push({state,url});context.location.href=new URL(url,context.location.href).href;};
  context.setInterval=fn=>{context.tick=fn;return 1;};context.window=context;
  context.fetch=()=>{throw Error('Navigation must not call APIs');};context.document.querySelector=()=>null;
  vm.createContext(context);vm.runInContext(entry,context);return{context,clicks,replacements};
}
test('Task Studio return links select the existing Workspace menu only once after real-session readiness',()=>{
  for(const page of pages){const f=fixture(page,{session:''});assert.deepEqual(f.clicks,[]);f.context.sessionId='real';f.context.tick();assert.deepEqual(f.clicks,[page]);assert.equal(f.replacements[0].url,'/app?keep=1#draft');f.context.tick();assert.equal(f.clicks.length,1);}
});
test('navigation leaves normal opens, Sim, unknown pages and command-like values untouched',()=>{
  for(const page of [null,'map','playground','quickBuild','doDisconnect','https://example.com','editor\');quickBuild()']){const f=fixture(page);f.context.tick();assert.deepEqual(f.clicks,[]);assert.deepEqual(f.replacements,[]);}
  for(const page of pages){const f=fixture(page,{sim:true});f.context.tick();assert.deepEqual(f.clicks,[]);assert.deepEqual(f.replacements,[]);}
});
test('Terminal navigation waits for account permissions and does not bypass the existing guard',()=>{
  const f=fixture('terminal',{resolved:false,paid:false});assert.deepEqual(f.clicks,[]);f.context.tick();assert.deepEqual(f.clicks,[]);f.context.terminalPlanAccessResolved=true;f.context.tick();assert.deepEqual(f.clicks,['dashboard']);assert.equal(f.replacements.length,1);
});
test('standalone navigation links map to real Workspace pages and never duplicate executable app runtime',()=>{
  const html=fs.readFileSync('public/task-studio.html','utf8'),main=fs.readFileSync('public/index.html','utf8'),nav=fs.readFileSync('public/task-studio-navigation.js','utf8');
  const destinations=[...html.matchAll(/href="\/app\?task_studio_page=([a-z]+)"/g)].map(m=>m[1]);
  for(const page of pages){assert.ok(destinations.includes(page),page+' link');assert.ok(main.includes(`switchPage('${page}')`),page+' real handler');}
  assert.doesNotMatch(html,/<script[^>]*src=["'][^"']*\/(?:app|common|sim|playground)\.js/);
  assert.doesNotMatch(nav,/fetch\(|new WebSocket|\/api\/exec|quickBuild\(|doDisconnect\(/);
  assert.match(html,/id="ts-main-nav"/);assert.match(fs.readFileSync('public/task-studio-v3.js','utf8'),/id="ts-workspace-return"[^>]*>← ROS Wizzard/);
});
