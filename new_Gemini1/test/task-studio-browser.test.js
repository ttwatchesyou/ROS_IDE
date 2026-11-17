'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{spawn}=require('node:child_process'),WebSocket=require('ws');
test('Task Studio browser edits subfunctions, drops calls into Main, debugs and rejects Sim',{skip:process.env.ROSIDE_TEST_BROWSER!=='1',timeout:25000},async()=>{
  const publicRoot=path.join(__dirname,'..','public'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'roside-task-ui-'));
  const server=http.createServer((req,res)=>{const file=path.join(publicRoot,new URL(req.url,'http://localhost').pathname);if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/plain');res.end(fs.readFileSync(file));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});let socket;
  try{
    const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),8000);chrome.stderr.on('data',data=>{text+=data;const match=text.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});chrome.once('error',reject);});
    socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let seq=0;const pending=new Map();
    socket.on('message',raw=>{const result=JSON.parse(raw),entry=pending.get(result.id);if(entry){pending.delete(result.id);result.error?entry.reject(Error(JSON.stringify(result.error))):entry.resolve(result.result);}});
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
    const target=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true}),cdp=(method,params)=>send(method,params,sessionId);
    await cdp('Page.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    const errors=[];socket.on('message',raw=>{const e=JSON.parse(raw);if(e.method==='Runtime.exceptionThrown')errors.push(e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);});await cdp('Runtime.enable');
    const bootstrap=`
      const values={'ros2ide_token':'test','ros2ide_robotid':'42','ros2ide_username':'tester','ros2ide_theme':'light'};
      Object.defineProperty(window,'localStorage',{value:{getItem:k=>values[k]??null,setItem:(k,v)=>values[k]=String(v),removeItem:k=>delete values[k]}});
      window.calls=[];window.confirm=()=>true;window.prompt=()=> 'pickup';
      window.fetch=async(url,opts)=>{
        if(!String(url).startsWith('/api/'))return{ok:true,text:async()=>String(url).includes('runner.py')?window.runnerFixture:window.probeFixture};
        calls.push([url,JSON.parse(opts.body)]);
        const data=url==='/api/session/restore'
          ? {ok:true,isSim:localStorage.getItem('mock_sim')==='1',sessionId:'physical-test',robotId:42,workspace:'~/robot_ws'}
          : {ok:true,code:0,stdout:'TASK_STUDIO='+JSON.stringify(window.topicFixture)};
        return{ok:true,json:async()=>data};
      };`;
    const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    const {frameTree}=await cdp('Page.getFrameTree');
    // Explicitly exercise the retained v2 controller/editor as a compatibility
    // fixture. The actual served v3 page has its own standard-Blockly UI tests.
    const html=fs.readFileSync(path.join(publicRoot,'task-studio.html'),'utf8').replace('id="ts-legacy" hidden','id="ts-legacy"').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'').replace('</head>',`<style>${fs.readFileSync(path.join(publicRoot,'task-studio.css'),'utf8')}\n${fs.readFileSync(path.join(publicRoot,'task-studio-editor.css'),'utf8')}</style></head>`);
    // v2 compatibility fixture does not mount the standalone v3 navigation.
    await cdp('Page.setDocumentContent',{frameId:frameTree.frame.id,html:html.replace('</head>','<style>#ts-main-nav,#ts-nav-help{display:none!important}</style></head>')});
    await evaluate(bootstrap);await evaluate('window.probeFixture='+JSON.stringify(fs.readFileSync(path.join(publicRoot,'task-studio-probe.py'),'utf8')));
    await evaluate('window.runnerFixture='+JSON.stringify(fs.readFileSync(path.join(publicRoot,'task-studio-runner.py'),'utf8')));
    await evaluate('window.topicFixture='+JSON.stringify({topics:[{name:'/odom',types:['nav_msgs/msg/Odometry']},{name:'/object_detected',types:['std_msgs/msg/Bool']}],samples:{'/odom':{state:'received',data:{pose:{pose:{position:{x:1}}}},ageMs:0},'/object_detected':{state:'received',data:{data:true},ageMs:0}}}));
    for(const file of ['theme.js','auth-storage.js','task-studio-model.js','task-studio-application.js','task-blockly.js','task-blockly-th.js','task-studio-blocks.js','task-studio.js','task-studio-editor.js'])await evaluate(fs.readFileSync(path.join(publicRoot,file),'utf8'));
    await new Promise(r=>setTimeout(r,500));
    assert.match(await evaluate('document.getElementById("connection").textContent'),/หุ่นยนต์จริง/);
    const compact=await evaluate(`({top:document.getElementById('editor-mode').getBoundingClientRect().top,canvas:document.getElementById('blockly-canvas').clientHeight,height:innerHeight})`);
    assert.ok(compact.top<=145,`compact desktop toolbar: ${compact.top}px`);
    assert.ok(compact.canvas>=compact.height*.65,'canvas uses most of the desktop viewport');
    await evaluate(`document.querySelector('.studio-help summary').click()`);
    assert.equal(await evaluate(`document.getElementById('editor-mode').getBoundingClientRect().top`),compact.top,'help does not push the workspace down');
    await evaluate(`document.querySelector('.studio-help summary').click()`);
    await evaluate('document.getElementById("new-function").click()');
    await evaluate(`document.getElementById('function-params').value='delay';document.getElementById('function-params').dispatchEvent(new Event('change'));document.querySelector('[data-new="wait"]').click();document.querySelector('[data-prop="seconds"]').value='$delay';document.querySelector('[data-prop="seconds"]').dispatchEvent(new Event('change'));document.querySelector('[data-tab="Main"]').click()`);
    // Exercise a real HTML drag/drop payload into Main, not just the tap shortcut.
    await evaluate(`(()=>{const d=new DataTransfer();d.setData('text/task-studio','fn|pickup');document.querySelector('#steps .drop-zone:last-child').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));})()`);
    assert.match(await evaluate('document.getElementById("steps").textContent'),/pickup/);
    await evaluate(`document.querySelector('[data-arg="delay"]').value='0.1';document.querySelector('[data-arg="delay"]').dispatchEvent(new Event('change'));document.getElementById('check').click();document.getElementById('save').click()`);
    assert.match(await evaluate('document.getElementById("notice").textContent'),/บันทึกแอปครบ/);
    assert.ok(await evaluate('TaskStudioEditor.workspace.getAllBlocks(false).length>2'));
    const saved=await evaluate('JSON.parse(localStorage.getItem("roside_task_studio_tester_42_application_v2")).units[0].program');assert.equal(saved.main.at(-1).fn,'pickup');assert.equal(saved.functions.at(-1).body[0].seconds,'$delay');
    await evaluate('document.getElementById("run").click();new Promise(r=>setTimeout(r,2500))');
    assert.match(await evaluate('document.getElementById("debug-state").textContent'),/Dry Run จบ/);
    assert.match(await evaluate('document.getElementById("debug-log").textContent'),/Main → pickup/);
    assert.equal(await evaluate('calls.filter(c=>c[0]==="/api/exec").length'),0,'Dry run never executes robot commands');
    await evaluate(`document.getElementById('discover').click();new Promise(r=>setTimeout(r,200))`);
    assert.match(await evaluate('document.getElementById("topic-cards").textContent'),/ได้รับข้อมูลแล้ว/);
    const command=await evaluate('calls.find(c=>c[0]==="/api/exec")[1].command');assert.match(command,/timeout 6s python3/);assert.doesNotMatch(command,/cmd_vel|ros2 run/);
    const capture=async name=>{const result=await cdp('Page.captureScreenshot',{format:'png'}),file=path.join(profile,name+'.png');fs.writeFileSync(file,Buffer.from(result.data,'base64'));console.log('Task Studio screenshot:',file);};
    await evaluate(`document.querySelector('[data-tab="Main"]').click()`);await capture('desktop');
    await evaluate(`document.getElementById('step').click();new Promise(r=>setTimeout(r,200))`);assert.match(await evaluate('document.getElementById("debug-state").textContent'),/Step 1/);
    await evaluate(`document.getElementById('stop').click();new Promise(r=>setTimeout(r,200))`);assert.match(await evaluate('document.getElementById("debug-state").textContent'),/ยกเลิก/);
    // Migrate a saved pre-condition Blockly layout, preserving the original topic.
    await evaluate(`(()=>{const app=TaskStudioEditor.getApplication(),u=app.units[0],b={...TaskStudioModel.block('wait_topic'),topic:'/offline_sensor',msgType:'custom_msgs/msg/Reading'};u.program={version:1,name:u.file,main:[b],functions:[]};app.drafts={};app.drafts[u.id+':Main']={hash:JSON.stringify([b]),signature:'[]',state:{blocks:{languageVersion:0,blocks:[{type:'rt_start',fields:{TITLE:'เมื่อเริ่มโปรแกรม'},next:{block:{type:'rt_wait_topic',fields:{topic:b.topic,msgType:b.msgType,field:'data',op:'==',value:'true',timeout:'10'},data:JSON.stringify({id:b.id,source:b})}}}]}}};const input=document.getElementById('import-file'),data=new DataTransfer();data.items.add(new File([JSON.stringify(app)],'old.application.json',{type:'application/json'}));input.files=data.files;input.dispatchEvent(new Event('change'));})()`);
    await evaluate('new Promise(r=>setTimeout(r,150))');
    assert.equal(await evaluate(`TaskStudioEditor.workspace.getBlocksByType('rt_topic_condition').length`),1);
    assert.deepEqual(await evaluate(`(()=>{const c=TaskStudioEditor.workspace.getBlocksByType('rt_topic_condition')[0];return {dropdown:c.getField('topic') instanceof Blockly.FieldDropdown,boolean:c.outputConnection.getCheck(),previous:!!c.previousConnection,topic:c.getFieldValue('topic'),type:c.getFieldValue('msgType'),typeEditable:c.getField('msgType').EDITABLE}})()`),{dropdown:true,boolean:['Boolean'],previous:false,topic:'/offline_sensor',type:'custom_msgs/msg/Reading',typeEditable:false});
    assert.ok(await evaluate(`TaskStudioEditor.workspace.getBlocksByType('rt_topic_condition')[0].getField('topic').getOptions(false).some(x=>x[1]==='/odom')`));
    await evaluate(`TaskStudioEditor.workspace.getBlocksByType('rt_topic_condition')[0].setFieldValue('/odom','topic');new Promise(r=>setTimeout(r,100))`);
    assert.equal(await evaluate(`TaskStudioBridge.get().program.main[0].msgType`),'nav_msgs/msg/Odometry');
    // One reusable Boolean puzzle goes into an if/else. Preview uses only a local bus.
    await evaluate(`(()=>{const M=TaskStudioModel,p=TaskStudioBridge.get().program;const condition={...M.block('if_topic'),topic:'/task_studio/user/flag',msgType:'std_msgs/msg/Bool',body:[{...M.block('log'),text:'BRANCH_TRUE'}],elseBody:[{...M.block('log'),text:'BRANCH_FALSE'}]};p.main=[{...M.block('publish'),topic:condition.topic,msgType:condition.msgType,value:false},condition];TaskStudioBridge.replace(p);})()`);
    await evaluate(`document.getElementById('run').click();new Promise(r=>setTimeout(r,600))`);
    assert.match(await evaluate(`document.getElementById('debug-log').textContent`),/BRANCH_FALSE/);
    assert.doesNotMatch(await evaluate(`document.getElementById('debug-log').textContent`),/BRANCH_TRUE/);
    assert.match(await evaluate(`document.getElementById('debug-state').textContent`),/Dry Run จบ/);
    await capture('topic-condition');
    await evaluate(`(()=>{const c=TaskStudioEditor.workspace.getBlocksByType('rt_topic_condition')[0];c.unplug();})()`);
    await evaluate('new Promise(r=>setTimeout(r,100))');
    assert.match((await evaluate('TaskStudioEditor.errors()')).join(' '),/หกเหลี่ยม/);
    // Actual Blockly connection, field editing, detached-block protection and undo.
    await evaluate(`document.getElementById('starter').value='parallel';document.getElementById('starter').dispatchEvent(new Event('change'));new Promise(r=>setTimeout(r,100))`);
    assert.equal(await evaluate(`TaskStudioEditor.workspace.getBlocksByType('rt_parallel').length`),1);
    await evaluate(`(()=>{const w=TaskStudioEditor.workspace,b=w.newBlock('rt_log');b.initSvg();b.render();b.setFieldValue('บล็อกใหม่ของฉัน','text');window.addedBlock=b;})()`);
    await evaluate('new Promise(r=>setTimeout(r,100))');
    assert.match((await evaluate('TaskStudioEditor.errors()')).join(' '),/ยังไม่ได้ต่อ/);
    await evaluate(`document.getElementById('new-function').click();document.querySelector('[data-tab="Main"]').click();new Promise(r=>setTimeout(r,100))`);
    assert.equal(await evaluate('TaskStudioEditor.workspace.getTopBlocks(false).length'),2,'detached work survives creating a function and switching tabs');
    await evaluate(`window.addedBlock=TaskStudioEditor.workspace.getAllBlocks(false).find(b=>b.type==='rt_log'&&b.getFieldValue('text')==='บล็อกใหม่ของฉัน');undefined`);
    await evaluate(`(()=>{let last=TaskStudioEditor.workspace.getBlocksByType('rt_start')[0];while(last.getNextBlock())last=last.getNextBlock();last.nextConnection.connect(addedBlock.previousConnection);})()`);
    await evaluate('new Promise(r=>setTimeout(r,100))');
    assert.deepEqual(await evaluate('TaskStudioEditor.errors()'),[]);
    assert.equal(await evaluate('TaskStudioBridge.get().program.main.at(-1).text'),'บล็อกใหม่ของฉัน');
    await evaluate(`document.getElementById('run').click();new Promise(r=>setTimeout(r,2000))`);
    assert.match(await evaluate('document.getElementById("debug-state").textContent'),/Dry Run จบ/);
    const lanes=await evaluate('document.getElementById("debug-log").textContent');assert.match(lanes,/งาน A เสร็จแล้ว/);assert.match(lanes,/งาน B เริ่มก่อน/);assert.match(lanes,/ครบทั้งสองงาน/);
    await capture('blockly-parallel');
    await evaluate(`document.getElementById('starter').value='topics';document.getElementById('starter').dispatchEvent(new Event('change'));new Promise(r=>setTimeout(r,150))`);
    assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'),2);
    assert.equal(await evaluate('document.querySelectorAll("#graph-wires path").length'),1);
    const handle=await evaluate(`(()=>{const r=document.querySelector('.node-handle').getBoundingClientRect();return{x:r.x+70,y:r.y+25}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:handle.x,y:handle.y,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x+35,y:handle.y+30,button:'left',buttons:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x+35,y:handle.y+30,button:'left',clickCount:1});
    assert.equal(await evaluate('Object.values(TaskStudioEditor.getApplication().positions)[0].x'),60);
    await capture('application-graph');
    await evaluate(`document.querySelector('[data-unlink]').click();document.querySelector('.graph-port.out').click();document.querySelector('.graph-port.in').click();new Promise(r=>setTimeout(r,100))`);
    assert.deepEqual(await evaluate('TaskStudioEditor.errors()'),[]);
    assert.equal(await evaluate('TaskStudioEditor.getApplication().units[1].program.main[0].topic'),'/task_studio/user/hello');
    await evaluate(`document.getElementById('save').click();document.getElementById('view-code').click()`);
    await evaluate(`window.downloads=[];TaskStudioBridge.download=async(blob,name)=>downloads.push({name,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0,4))});document.getElementById('export-app').click();new Promise(r=>setTimeout(r,150))`);
    assert.deepEqual(await evaluate('downloads[0]'),{name:'my_robot_app.zip',bytes:[80,75,3,4]});
    assert.equal(await evaluate('calls.filter(c=>c[0]==="/api/exec").length'),1,'Editing, wiring and parallel preview add no robot calls');
    for(const width of [820,390]){await cdp('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`fits ${width}`);assert.ok(await evaluate(`document.getElementById('editor-mode').getBoundingClientRect().top<290`),`compact header at ${width}`);}
    await evaluate(`document.querySelector('.studio-help summary').click()`);
    assert.ok(await evaluate(`(()=>{const r=document.querySelector('.help-content').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`),'mobile help remains inside viewport');
    await evaluate(`document.querySelector('.studio-help summary').click()`);
    await capture('mobile');
    await evaluate('localStorage.setItem("mock_sim","1");calls=[]');await evaluate(fs.readFileSync(path.join(publicRoot,'task-studio.js'),'utf8'));await new Promise(r=>setTimeout(r,100));
    assert.match(await evaluate('document.getElementById("notice").textContent'),/เฉพาะหุ่นยนต์จริง/);
    assert.equal(await evaluate('document.getElementById("run").disabled'),true);assert.equal(await evaluate('calls.length'),1);
    assert.deepEqual(errors,[]);
    // Independent dashboard page: entry is one app card BELOW (not inside) missions.
    const entryTarget=await send('Target.createTarget',{url:'about:blank'}),attached=await send('Target.attachToTarget',{targetId:entryTarget.targetId,flatten:true});
    const entryCdp=(method,params)=>send(method,params,attached.sessionId);
    const entryEval=async expression=>{const r=await entryCdp('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await entryCdp('Page.enable');await entryCdp('Emulation.setDeviceMetricsOverride',{width:1280,height:950,deviceScaleFactor:1,mobile:false});
    const entryFrame=await entryCdp('Page.getFrameTree');
    await entryCdp('Page.setDocumentContent',{frameId:entryFrame.frameTree.frame.id,html:`<html><head><style>:root{--bg1:#fff;--bg2:#f5f7fb;--txt:#223148;--mt:#677993;--brd:#dce4ef;--acc:#2563eb;--adim:#edf3ff;--fn:system-ui}*{box-sizing:border-box}body{margin:18px;background:#f2f5fa;font:13px system-ui}.project-overview{border:1px solid #dce4ef;padding:20px;border-radius:16px;background:white}h2{font-size:18px}#project-capabilities-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.mission{padding:18px 12px;min-height:105px;border:1px solid #dce4ef;border-radius:12px;background:#f7f9fc}#agv-mission-count{color:#2563eb}@media(max-width:680px){#project-capabilities-grid{grid-template-columns:1fr 1fr}}</style></head><body><div id="topbar"><button id="task-studio-entry">ƒ</button></div><div id="page-dashboard"><div class="project-overview"><h2>แผนที่ภารกิจ ROS 2</h2><p id="agv-mission-count">4 / 8 สำเร็จ</p><div id="project-capabilities-grid">${['ตรวจความพร้อมระบบ','ประกอบหุ่น','ติดตั้งและทดสอบ LIDAR','เชื่อมฮาร์ดแวร์','จูนระบบหุ่นยนต์','ฝึกบังคับหุ่น','วาดแผนที่','ออกผจญภัย'].map((name,i)=>`<div class="mission" data-agv-step="${i}">${i<4?'✓':'○'} ${name}</div>`).join('')}</div></div></div></body></html>`});
    await entryEval("var sessionId='real',isSimWorkspace=false;window.setInterval=fn=>{window.entryTick=fn;return 1};window.fetch=()=>{throw Error('Entry must not call APIs')}");
    await entryEval(fs.readFileSync(path.join(publicRoot,'task-studio-entry.js'),'utf8'));
    await entryEval('entryTick();entryTick()');
    assert.equal(await entryEval('document.querySelectorAll("#real-special-apps").length'),1);
    assert.equal(await entryEval('document.querySelector(".project-overview").nextElementSibling.id'),'real-special-apps');
    assert.equal(await entryEval('document.querySelectorAll(".special-app-card").length'),1);
    assert.equal(await entryEval('document.querySelectorAll("#project-capabilities-grid [data-agv-step]").length'),8);
    assert.equal(await entryEval('document.getElementById("agv-mission-count").textContent'),'4 / 8 สำเร็จ');
    assert.equal(await entryEval('document.querySelector("#topbar #task-studio-entry")'),null);
    assert.equal(await entryEval('document.getElementById("task-studio-entry").getAttribute("href")'),'/task-studio.html');
    const entryShot=await entryCdp('Page.captureScreenshot',{format:'png'});const entryFile=path.join(profile,'special-app-card.png');fs.writeFileSync(entryFile,Buffer.from(entryShot.data,'base64'));console.log('Special app card screenshot:',entryFile);
    await entryCdp('Emulation.setDeviceMetricsOverride',{width:390,height:950,deviceScaleFactor:1,mobile:false});
    assert.equal(await entryEval('document.documentElement.scrollWidth<=innerWidth'),true);
    await entryEval('isSimWorkspace=true');
    assert.equal(await entryEval(`(()=>{const e=new MouseEvent('click',{bubbles:true,cancelable:true});document.getElementById('task-studio-entry').dispatchEvent(e);return e.defaultPrevented})()`),true);
    await entryEval('entryTick()');assert.equal(await entryEval('document.getElementById("real-special-apps").hidden'),true);
    await entryEval("isSimWorkspace=false;sessionId='';entryTick()");assert.equal(await entryEval('document.getElementById("real-special-apps").hidden'),true);
    await entryEval("sessionId='real';entryTick()");assert.equal(await entryEval('document.getElementById("real-special-apps").hidden'),false);
  }finally{socket?.close();chrome.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));}
});
