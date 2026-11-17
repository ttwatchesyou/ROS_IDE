'use strict';
(()=>{
  const M=TaskStudioModel,A=TaskStudioApplication,S=TaskStudioStandard;
  const titles={hello:'หุ่นยนต์ช่างทักทาย',parallel:'สองทีมช่วยกัน',topics:'สถานีส่งข้อความ',blank:'แอปใหม่ของฉัน'};
  function starter(kind='blank'){
    const b=(type,v={})=>({...M.block(type),...v}),p={version:1,name:'robot_task',main:[],functions:[]};
    if(kind==='hello')p.main=[b('repeat',{count:3,body:[b('log',{text:'สวัสดี! เราสร้างหุ่นยนต์ได้ 🤖'}),b('wait',{seconds:.3})]})];
    if(kind==='parallel')p.main=[b('parallel',{branches:[[b('log',{text:'ทีม A เริ่ม!'}),b('wait',{seconds:.5}),b('log',{text:'ทีม A เสร็จแล้ว'})],[b('log',{text:'ทีม B เริ่มพร้อมกัน!'}),b('wait',{seconds:.2}),b('log',{text:'ทีม B เสร็จแล้ว'})]]}),b('log',{text:'ทั้งสองทีมเสร็จแล้ว 🎉'})];
    const app=A.migrate(p);app.units[0].blockly=S.legacy(p);
    if(kind==='topics'){
      const topic='/task_studio/user/hello',type='std_msgs/msg/String';
      const a=A.unit({version:1,name:'speaker',main:[b('repeat',{count:4,body:[b('publish',{topic,msgType:type,value:'สวัสดีเพื่อน!'}),b('wait',{seconds:.3})]})],functions:[]},'greeting','speaker');
      const c=A.unit({version:1,name:'listener',main:[b('wait_topic',{topic,msgType:type,value:'สวัสดีเพื่อน!'}),b('log',{text:'ได้รับข้อความจากเพื่อนแล้ว 💌'})],functions:[]},'greeting','listener');
      app.units=[a,c];app.units.forEach(u=>u.blockly=S.legacy(u.program));
    }
    for(const u of app.units)S.walkState(u.blockly,b=>{b.id||=M.id();});
    return{id:M.id(),title:titles[kind]||titles.blank,icon:({hello:'🤖',parallel:'🤝',topics:'📡',blank:'🚀'})[kind]||'🚀',app};
  }
  function normalize(value){
    let p;if(value?.blocks&&Array.isArray(value.blocks.blocks)){p=starter('blank');p.title='บล็อกที่เปิดจากไฟล์';p.app.units[0].blockly=M.clone(value);}else if(value?.app)p=M.clone(value);else{p={id:M.id(),title:value?.name||'แอปที่เปิดจากไฟล์',icon:'🚀',app:A.migrate(value)};if(value?.version===1&&value.blockly)p.app.units[0].blockly=M.clone(value.blockly);}
    const errors=A.validateDraft(p.app);if(errors.length)throw Error(errors.join('\n'));
    const files=new Set();for(const u of p.app.units){if(files.has(u.package+'/'+u.file)||u.file==='task_runner')throw Error('ชื่อ Package / ไฟล์ Node ซ้ำหรือสงวนไว้');files.add(u.package+'/'+u.file);if(!u.blockly)u.blockly=S.legacyDrafts(u.program,Object.entries(p.app.drafts||{}).filter(([k])=>k.startsWith(u.id+':')).map(([,d])=>d));S.inspectState(u.blockly);S.walkState(u.blockly,b=>{b.id||=M.id();});const w=new Blockly.Workspace();Blockly.Events.disable();try{Blockly.serialization.workspaces.load(u.blockly,w);u.blockly=Blockly.serialization.workspaces.save(w);}finally{w.dispose();Blockly.Events.enable();}}
    p.id=/^b[a-z0-9]+$/.test(p.id)?p.id:M.id();p.title=String(p.title||'แอปของฉัน').slice(0,60);p.icon=['🚀','🤖','🤝','📡','🎨','🧩'].includes(p.icon)?p.icon:'🚀';return p;
  }
  function catalog(app,live=[]){return[...live,...app.topics.map(t=>({name:t.name,types:[t.msgType]})),...app.units.flatMap(u=>S.ports(u.blockly).filter(p=>p.direction==='out').map(p=>({name:p.topic,types:[p.msgType],source:'app'})))];}
  function compile(app,live=[]){const units=[],issues=[],types=new Map();for(const t of catalog(app,live)){const set=types.get(t.name)||new Set();t.types.forEach(v=>set.add(v));types.set(t.name,set);}S.setTopics(catalog(app,live));
    for(const u of app.units){const w=new Blockly.Workspace();Blockly.Events.disable();try{S.inspectState(u.blockly);Blockly.serialization.workspaces.load(u.blockly,w);S.setTopics(catalog(app,live),w);const c=S.compile(w);units.push({...u,...c});issues.push(...c.issues.map(e=>u.file+': '+e));}catch(e){issues.push(u.file+': '+e.message);}finally{w.dispose();Blockly.Events.enable();}}
    if(units.filter(u=>u.motion).length>1)issues.push('ให้มี Node สั่งวิ่งได้เพียงตัวเดียวในแอป');
    for(const u of units)for(const p of u.ports)if(types.get(p.topic)?.size>1)issues.push('ชนิดข้อความขัดแย้งบน '+p.topic);
    return{units,issues:[...new Set(issues)]};
  }
  function packageFiles(project,compiled,runner,extension,mode='app',selected){
    if(compiled.issues.length)throw Error(compiled.issues.join('\n'));const app=M.clone(project.app);app.links=[];
    for(const u of app.units){const c=compiled.units.find(c=>c.id===u.id);u.program=runtimeProgram(c);u.blockly=c.state;}
    const chosen=app.units.find(u=>u.id===selected)||app.units[0],files=A.packageFiles(app,runner,mode==='app'?null:chosen.package);
    for(const u of app.units){const path=`${u.package}/${u.package}/${u.file}.py`;if(!files[path])continue;const c=compiled.units.find(c=>c.id===u.id);files[path]=files[path].replace('node = TaskRunner()','node = BlocklyRunner()')+'\n\n'+extension+'\n\nGENERATED_BLOCKLY_SOURCE = '+JSON.stringify(c.python)+'\n';files[`${u.package}/flows/${u.file}.blockly.json`]=JSON.stringify(c.state,null,2);}
    const editable=M.clone(project);for(const u of editable.app.units)u.blockly=compiled.units.find(c=>c.id===u.id).state;
    files['project.studio.json']=JSON.stringify(editable,null,2);
    if(mode==='app')files[`${app.name}_bringup/flows/application.json`]=JSON.stringify(editable.app,null,2);
    files['README_BLOCKLY.md']='# Robot Task Studio · Standard Blockly\n\nImport project.studio.json to edit this project. Generated node .py files contain the Blockly Python source in GENERATED_BLOCKLY_SOURCE and the execution runtime. Each Node is a separate executable; each package has its own files. Run colcon build then source install/setup.bash. Launch files default to dry_run=true. Browser editing/preview does not install or execute anything on a robot.\n\nInputs use fresh ROS samples (missing is not false). Browser preview uses a temporary in-browser topic bus; ROS dry_run does not publish messages, so input topics require external publishers. Standard logic, loops, math, text, lists, variables and procedures use the official Blockly generators. Interactive prompt blocks work only in browser preview; replace them with input topics before deployment. Floating point/string conversion/random behavior may differ between JavaScript preview and Python. Parallel A/B uses two bounded I/O worker threads and joins before continuing. Do not mutate shared variables from both lanes. Motion and nested parallel blocks are forbidden in lanes. Threads do not guarantee CPU-bound speed-up.\n\n## Custom Python — adult review required\nThe browser NEVER executes custom Python and stops at that block, rather than pretending it succeeded. The ROS runtime also rejects custom Python in dry_run and unless allow_python=true is explicitly set along with commissioned real-execution safety. Python is full trusted code, NOT a sandbox; it may access files/network/hardware, bypass guards, hang a thread or prevent shutdown. Do not run untrusted/imported code. Review all code and use process isolation / an external safety supervisor for production. Declared Python Topic ports describe intended I/O, not proof that code actually uses them. ctx.read/publish/wait/log are available; ctx.scope persists custom variables between Python blocks on the same lane. Do not edit imported generated code expecting it to run in the browser: it is always regenerated from blocks.\n\n## Physical safety\nReal execution still requires fresh /task_studio/safety_ready, an independent safety arbiter and E-stop. Motion goes only to /task_studio/cmd_vel, never direct /cmd_vel. ODOM navigation has no obstacle avoidance. Zero velocity is requested on normal completion, cancellation and detected failure; hardware safety must not rely on Python threads or the browser stop button. Do not bypass the arbiter by topic remapping. Nothing was tested on physical motors by this editor.\n';
    if(mode==='node'){const keep=new Set([`${chosen.package}/${chosen.package}/${chosen.file}.py`,`${chosen.package}/flows/${chosen.file}.flow.json`,`${chosen.package}/flows/${chosen.file}.blockly.json`,'project.studio.json','README_BLOCKLY.md']);for(const path of Object.keys(files))if(!keep.has(path))delete files[path];files['README_BLOCKLY.md']+='\nNode-only export requires the matching installed ROS package/share directory. Use Package or Application export for buildable scaffolding.\n';}
    return files;
  }
  function runtimeProgram(c){if(c.ports.length>128)throw Error('รองรับสูงสุด 128 ช่อง Topic ต่อ Node');const main=c.ports.map((port,i)=>port.direction==='in'?{...M.block('wait_topic'),id:'bnativeport'+i,topic:port.topic,msgType:port.msgType,field:'data'}:{...M.block('publish'),id:'bnativeport'+i,topic:port.topic,msgType:port.msgType,value:({'std_msgs/msg/String':'','std_msgs/msg/Bool':false,'std_msgs/msg/Float64':0})[port.msgType]});if(c.motion)main.push({...M.block('odom_position'),id:'bnativemotion'});return{version:1,name:c.file,main,functions:[],native_ports:c.ports,blockly:c.state,generated_python:c.python};}
  window.TaskStudioProjects={starter,normalize,catalog,compile,packageFiles,runtimeProgram};
})();
