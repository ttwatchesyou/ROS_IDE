'use strict';
(()=>{
  const M=TaskStudioModel,$=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let program=M.sample(),tab='Main',selected=null,session='',workspace='',storage='',saved='',dirty=false,ready=false;
  let running=false,paused=false,credits=0,runToken=0,activeId=null,remoteId=null,monitoring=false,probeBusy=false,probeSource='',runnerSource='',timer=null,watching=['/odom'],samples={},graph=[],remoteHash='',lastRuntimeAt=0;
  const note=text=>$('notice').textContent=text;
  const body=()=>tab==='Main'?program.main:program.functions.find(f=>f.name===tab)?.body||program.main;
  function find(id,lists=[program.main,...program.functions.map(f=>f.body)]){for(const list of lists)for(let index=0;index<list.length;index++){const b=list[index];if(b.id===id)return{b,list,index};const found=find(id,[...(b.body?[b.body]:[]),...(b.elseBody?[b.elseBody]:[]),...(b.branches||[])]);if(found)return found;}return null;}
  function listFor(key){return key==='Main'?program.main:key.startsWith('fn:')?program.functions.find(f=>f.name===key.slice(3))?.body:find(key)?.b.body;}
  function changed(){dirty=true;$('save-state').textContent='ยังไม่บันทึก';remoteHash='';remoteId=null;render();}
  function summary(b){if(b.type==='call')return `${b.fn}(${Object.entries(b.args||{}).map(([k,v])=>k+'='+v).join(', ')})`;if(b.type==='wait')return `${b.seconds} วินาที`;if(b.type==='log')return b.text;if(b.type==='repeat')return `${b.count} รอบ`;if(b.type==='odom_position')return `odom · X ${b.x} m · Y ${b.y} m · ${b.yaw}° · ${b.speed} m/s`;return `${b.topic} → ${b.field} ${b.op} ${b.value}`;}
  function renderList(list,key){return list.map((b,i)=>`<div class="drop-zone" data-list="${esc(key)}" data-index="${i}">วางบล็อกตรงนี้</div><article class="step-card ${selected===b.id?'selected':''} ${activeId===b.id?'running':''} ${remoteId===b.id?'remote':''}" data-block="${b.id}" draggable="${!running}"><div class="step-top"><span class="step-number">${i+1}</span><strong>${M.types[b.type].icon} ${esc(M.types[b.type].label)}</strong><div class="step-tools"><button data-move="-1" data-id="${b.id}" aria-label="เลื่อนขึ้น">↑</button><button data-move="1" data-id="${b.id}" aria-label="เลื่อนลง">↓</button><button data-delete="${b.id}" aria-label="ลบบล็อก">×</button></div></div><p class="step-summary">${esc(summary(b))}</p>${b.type==='repeat'?`<div class="nested">${renderList(b.body,b.id)}</div>`:''}</article>`).join('')+`<div class="drop-zone" data-list="${esc(key)}" data-index="${list.length}">＋ ลากบล็อกมาวาง / แตะบล็อกในคลัง</div>`;}
  function render(){
    $('program-name').value=program.name;
    $('tabs').innerHTML=['Main',...program.functions.map(f=>f.name)].map(n=>`<button data-tab="${esc(n)}" class="${tab===n?'active':''}">${n==='Main'?'▤ Main':'ƒ '+esc(n)}</button>`).join('');
    $('function-list').innerHTML=program.functions.map(f=>`<div class="function-item"><button draggable="${!running}" data-function="${f.name}" title="ลากเพื่อเรียกฟังก์ชัน หรือแตะเพื่อเพิ่ม">ƒ ${f.name}</button><button data-tab="${f.name}" title="เปิดแก้ไข">↗</button></div>`).join('')||'<p>ยังไม่มีฟังก์ชันย่อย</p>';
    const fn=program.functions.find(f=>f.name===tab);
    $('function-settings').innerHTML=fn?`<label>พารามิเตอร์ตัวเลข (คั่นด้วย ,)<input id="function-params" value="${esc(Object.keys(fn.params).join(', '))}" placeholder="distance, delay"></label><small>ใช้ $ชื่อพารามิเตอร์ ในช่องตัวเลขของบล็อก · ค่าเริ่มต้น 0 · เรียกฟังก์ชันนี้จาก Main</small><button id="delete-function" class="danger">ลบฟังก์ชัน ${esc(fn.name)}</button>`:'';
    if(fn)for(const[name,value]of Object.entries(fn.params))$('function-settings').insertAdjacentHTML('beforeend',`<label>ค่าเริ่มต้น ${esc(name)} <input data-param-default="${esc(name)}" type="number" value="${value}" step="any"></label>`);
    $('steps').innerHTML=renderList(body(),tab==='Main'?'Main':'fn:'+tab);$('block-count').textContent=body().length+' บล็อก';properties();
    for(const el of document.querySelectorAll('.library button,.toolbar button,.toolbar input,#function-settings input,#function-settings button,.step-tools button,#properties input,#properties select'))el.disabled=running;
    $('run').disabled=running||!ready;$('pause').disabled=!running;$('stop').disabled=!running;$('pause').textContent=paused?'ทำต่อ':'พัก';
    $('function-params')?.addEventListener('change',event=>{const names=event.target.value.split(',').map(v=>v.trim()).filter(Boolean);if(names.some(n=>!M.name(n))||new Set(names).size!==names.length){note('ชื่อพารามิเตอร์ต้องเป็นภาษาอังกฤษตัวเล็ก ไม่ซ้ำ');render();return;}fn.params=Object.fromEntries(names.map(n=>[n,fn.params[n]??0]));changed();});
    for(const input of document.querySelectorAll('[data-param-default]'))input.onchange=()=>{const n=Number(input.value);if(!Number.isFinite(n)||Math.abs(n)>1e6||input.value.trim()===''){note('ค่าเริ่มต้นต้องเป็นตัวเลขระหว่าง -1000000 ถึง 1000000');render();return;}fn.params[input.dataset.paramDefault]=n;changed();};
    $('delete-function')?.addEventListener('click',()=>{if(confirm('ลบฟังก์ชันนี้? บล็อกที่เรียกจะต้องแก้ก่อนรัน')){program.functions=program.functions.filter(f=>f!==fn);tab='Main';selected=null;changed();}});
    window.dispatchEvent(new Event('task-studio-render'));
  }
  function properties(){
    const b=find(selected)?.b;if(!b){$('properties').innerHTML='<p>เลือกบล็อกเพื่อแก้ไข · ค่าตัวเลขใช้ $พารามิเตอร์ ได้</p>';return;}
    const fields={log:['text'],wait:['seconds'],odom_position:['x','y','yaw','speed','timeout'],wait_topic:['topic','field','op','value','timeout'],if_topic:['topic','field','op','value','timeout'],repeat:['count'],call:['fn'],parallel:[],publish:['topic','value']}[b.type]||[];
    const labels={text:'ข้อความ',seconds:'เวลา (วินาที)',x:'X ใน odom (เมตร)',y:'Y ใน odom (เมตร)',yaw:'มุมหัน (องศา)',speed:'ความเร็วสูงสุด (0.01–0.2 m/s)',timeout:'เวลาสูงสุด (วินาที)',topic:'ROS Topic',field:'ฟิลด์ เช่น data',op:'เปรียบเทียบ',value:'ค่าเป้าหมาย (ตัวเลข / true / false / ข้อความ)',count:'จำนวนรอบ',fn:'ฟังก์ชันย่อย'};
    $('properties').innerHTML=`<p>${M.types[b.type].icon} ${esc(M.types[b.type].label)} · ${esc(b.id)}</p>`+fields.map(k=>`<label class="property">${labels[k]}${k==='fn'?`<select data-prop="fn">${program.functions.map(f=>`<option ${f.name===b.fn?'selected':''}>${esc(f.name)}</option>`).join('')}</select>`:k==='op'?`<select data-prop="op">${['==','!=','>','<','>=','<='].map(v=>`<option ${v===b.op?'selected':''}>${esc(v)}</option>`).join('')}</select>`:`<input data-prop="${k}" value="${esc(b[k])}" maxlength="500">`}</label>`).join('');
    if(b.type==='call')for(const[k,v]of Object.entries(program.functions.find(f=>f.name===b.fn)?.params||{}))$('properties').insertAdjacentHTML('beforeend',`<label class="property">ค่า ${esc(k)}<input data-arg="${esc(k)}" value="${esc(b.args[k]??v)}"></label>`);
    for(const input of $('properties').querySelectorAll('input,select'))input.onchange=()=>{
      if(running)return;const k=input.dataset.prop,v=input.value;
      const number=v=>v.startsWith('$')?v:v.trim()===''?null:Number(v);
      if(input.dataset.arg)b.args[input.dataset.arg]=number(v);
      else if(k==='fn'){b.fn=v;b.args={};}
      else if(k==='value'){try{b[k]=JSON.parse(v);}catch{b[k]=v;}}
      else b[k]=['text','topic','field','op'].includes(k)?v:number(v);changed();
    };
  }
  function add(type,fn,list=body(),at=list.length){if(running||!ready)return;const b=M.block(type);if(type==='call'){b.fn=fn||program.functions[0]?.name||'missing';b.args={};}list.splice(at,0,b);selected=b.id;changed();}
  function drop(payload,list,index){if(!list||running)return;const[mode,value]=payload.split('|');if(mode==='new'&&M.types[value])add(value,null,list,index);else if(mode==='fn'&&program.functions.some(f=>f.name===value))add('call',value,list,index);else if(mode==='move'){
    const found=find(value);if(!found)return;const contains=b=>b.body===list||(b.body||[]).some(contains);if(contains(found.b))return;
    found.list.splice(found.index,1);if(found.list===list&&found.index<index)index--;list.splice(index,0,found.b);changed();
  }}
  const save=()=>{if(running)return false;const current=localStorage.getItem(storage)||'';if(current!==saved&&!confirm('อีกแท็บมีการบันทึกใหม่ ต้องการแทนที่ด้วยโปรแกรมหน้านี้หรือไม่?'))return false;const text=JSON.stringify(program,null,2);localStorage.setItem(storage,text);saved=text;dirty=false;$('save-state').textContent='บันทึกในเบราว์เซอร์แล้ว';return true;};
  function download(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function check(){const errors=[...M.validate(program),...(window.TaskStudioEditor?.errors()||[])];note(errors.length?errors.join('\n'):'✓ ต่อบล็อกถูกต้องแล้ว — ยังไม่ใช่การรับรองความปลอดภัยของเส้นทาง');return !errors.length;}
  function log(text){const li=document.createElement('li');li.textContent=new Date().toLocaleTimeString()+' · '+text;$('debug-log').prepend(li);while($('debug-log').children.length>150)$('debug-log').lastChild.remove();}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function gate(token){while(paused&&credits===0){if(token!==runToken)throw Error('ยกเลิก Dry Run');await sleep(60);}if(token!==runToken)throw Error('ยกเลิก Dry Run');if(paused)credits--;}
  async function dryRun(single=false){
    if(running||!ready||!check())return;running=true;paused=single;credits=single?1:0;const token=++runToken,p=M.clone(program);let count=0;render();$('debug-log').replaceChildren();
    const bus={};
    async function execute(events,lane='Main'){for(const event of events){
      if(event.phase==='exit'){log('จบ '+event.block.id);continue;}if(++count>10000)throw Error('จำนวน Step เกินขีดจำกัด');await gate(token);
      const b=event.block;activeId=b.id;const owner=event.stack.filter(n=>p.functions.some(f=>f.name===n)).at(-1);tab=owner||'Main';render();
      $('debug-state').textContent=`Dry Run · Step ${count} · ${M.types[b.type].label}`;$('call-stack').textContent=event.stack.join(' → ');$('variables').textContent=JSON.stringify(event.env,null,2);log('เริ่ม '+b.id+' · '+event.stack.join(' → '));
      if(b.type==='parallel')await Promise.all(b.branches.map((branch,index)=>execute(M.steps(p,branch,event.env,[...event.stack,index?'งาน B':'งาน A']),index?'B':'A')));
      if(b.type==='publish'){bus[b.topic]={data:{data:b.value},state:'received',receivedAt:Date.now()};log(lane+' · ทดลองส่ง '+b.topic+' (ในเบราว์เซอร์เท่านั้น)');}
      if(['wait','wait_topic','if_topic'].includes(b.type)){
        let elapsed=0,last=performance.now(),decision=null;while(true){if(token!==runToken)throw Error('ยกเลิก Dry Run');const now=performance.now();elapsed+=(now-last)/1000;last=now;
          if(b.type==='wait'&&elapsed>=b.seconds)break;
          if(b.type==='wait_topic'||b.type==='if_topic'){
            const sample=bus[b.topic]||samples[b.topic],value=sample?.state==='received'&&Date.now()-sample.receivedAt<2000?M.field(sample.data,b.field):undefined;
            if(value!==undefined&&value!==null){decision=M.compare(value,b.op,b.value);if(decision||b.type==='if_topic')break;}
            if(elapsed>b.timeout)throw Error('รอ Topic หมดเวลา: '+b.topic+' (ต้องเริ่มติดตามข้อมูลจริง)');
          }
          await sleep(60);
        }
        if(b.type==='if_topic'){log('เงื่อนไข '+b.topic+' → '+(decision?'จริง':'เท็จ'));await execute(M.steps(p,decision?b.body:b.elseBody,event.env,[...event.stack,decision?'ถ้า: จริง':'มิฉะนั้น']),lane);}
      }
      if(b.type==='odom_position')log('ข้ามการเคลื่อนที่ — ไม่ได้ยืนยันว่าไปถึงเป้าหมาย');
      if(b.type==='log')log(lane+' · '+b.text);await sleep(80);
    }}
    try{await execute(M.steps(p));$('debug-state').textContent='✓ Dry Run จบ · ไม่ได้สั่งให้หุ่นยนต์วิ่ง';}
    catch(error){runToken++;$('debug-state').textContent='■ '+error.message;log(error.message);}
    finally{running=false;paused=false;activeId=null;render();}
  }
  async function api(path,body){if(!ready&&path!=='/api/session/restore')throw Error('ยังไม่ยืนยันหุ่นยนต์จริง');const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',...authHeaders()},body:JSON.stringify({sessionId:session,...body})});const data=await r.json();if(!r.ok||!data.ok)throw Error(data.error||'Request failed');return data;}
  const base64=s=>{const bytes=new TextEncoder().encode(s);let out='';for(const b of bytes)out+=String.fromCharCode(b);return btoa(out);};
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  async function template(file){const r=await fetch('/'+file);if(!r.ok)throw Error('โหลด '+file+' ไม่สำเร็จ');return r.text();}
  async function probe(){
    if(probeBusy||!ready)return;probeBusy=true;$('live-state').textContent='กำลังอ่านจากหุ่นยนต์…';const started=Date.now();
    try{
      probeSource=probeSource||await template('task-studio-probe.py');const code=base64(probeSource.replace('__TOPICS_BASE64__',base64(JSON.stringify(watching))));
      const source="if [ -f /opt/ros/\"${ROS_DISTRO:-none}\"/setup.bash ]; then source /opt/ros/\"$ROS_DISTRO\"/setup.bash; elif [ -f /opt/ros/jazzy/setup.bash ]; then source /opt/ros/jazzy/setup.bash; elif [ -f /opt/ros/humble/setup.bash ]; then source /opt/ros/humble/setup.bash; fi; ";
      const ws=workspace.startsWith('~/')?'"$HOME"/'+quote(workspace.slice(2)):quote(workspace);
      const command=source+`if [ -f ${ws}/install/setup.bash ]; then source ${ws}/install/setup.bash; fi; timeout 6s python3 -c "import base64;exec(base64.b64decode('${code}'))"`;
      const result=await api('/api/exec',{command,timeout:8000}),line=String(result.stdout||'').split('\n').find(s=>s.startsWith('TASK_STUDIO='));
      if(result.code!==0||!line)throw Error((result.stderr||'ไม่พบ ROS environment / ไม่มีข้อมูลตอบกลับ').slice(0,350));
      const data=JSON.parse(line.slice(12));graph=data.topics||[];
      for(const name of watching){const sample=data.samples[name]||{state:'missing'};samples[name]={...sample,receivedAt:started-(sample.ageMs||0)};}
      const chosen=$('topic-choice').value;$('topic-choice').innerHTML='<option value="">เลือก Topic</option>'+graph.filter(t=>M.topicName(t.name)).map(t=>`<option value="${esc(t.name)}">${esc(t.name)} · ${esc(t.types.join(', '))}</option>`).join('');$('topic-choice').value=chosen;
      $('live-state').textContent=`อ่านล่าสุด ${new Date().toLocaleTimeString()} · ${Date.now()-started} ms`;renderTopics();await runtimeDebug();window.dispatchEvent(new Event('task-studio-topics'));
    }catch(error){for(const name of watching)samples[name]={state:'error',error:error.message};remoteId=null;note(error.message);$('live-state').textContent='อ่านไม่สำเร็จ — ไม่มีข้อมูลสด';renderTopics();}
    finally{probeBusy=false;if(monitoring)timer=setTimeout(probe,1500);}
  }
  function renderTopics(){
    const leaves=(value,prefix='',depth=0)=>depth>7?[]:Object.entries(value||{}).flatMap(([k,v])=>{const path=prefix?prefix+'.'+k:k;return v&&typeof v==='object'&&!Array.isArray(v)?leaves(v,path,depth+1):['number','boolean','string'].includes(typeof v)?[{path,value:v}]:[];}).slice(0,12);
    $('topic-cards').innerHTML=watching.map(topic=>{const s=samples[topic]||{state:'waiting'},fresh=s.state==='received'&&Date.now()-s.receivedAt<4000;
      return `<article class="topic-card"><strong>${esc(topic)}</strong><small class="${fresh?'received':'stale'}">${fresh?'● ได้รับข้อมูลแล้ว':s.state==='received'?'ข้อมูลเก่า — รอรอบใหม่':esc(s.state)} ${s.error?esc(s.error):''}</small><pre>${esc(s.data?JSON.stringify(s.data,null,2):'ยังไม่มีข้อมูล')}</pre>${leaves(s.data).map(f=>`<button data-bind="${esc(topic)}" data-field="${esc(f.path)}" title="เลือกฟิลด์นี้ในบล็อกรอ Topic">↳ ${esc(f.path)}</button>`).join('')}<button data-bind="${esc(topic)}">ใช้ในบล็อกรอ Topic</button><button data-unwatch="${esc(topic)}">นำออก</button></article>`;}).join('');
  }
  async function runtimeDebug(){
    const debugTopic=window.TaskStudioEditor?.debugTopic()||'/task_studio/debug',s=samples[debugTopic];if(s?.state!=='received'||typeof s.data?.data!=='string')return;
    let d;try{d=JSON.parse(s.data.data);}catch{return;}
    if(window.TaskStudioV3?.runtimeDebug){await window.TaskStudioV3.runtimeDebug(d,s.receivedAt);return;}
    if(!remoteHash){if(globalThis.crypto?.subtle){const bytes=new TextEncoder().encode(JSON.stringify(program,null,2)),hash=await crypto.subtle.digest('SHA-256',bytes);remoteHash=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}else remoteHash='unavailable';}
    const matches=d.program_hash===remoteHash;remoteId=matches&&!running?d.step:null;lastRuntimeAt=Date.now();
    $('runtime-state').textContent=`ROS ${d.dry_run?'DRY RUN (ไม่เคลื่อนที่)':'REAL RUNTIME'} · ${d.program} · ${d.phase}\n${(d.stack||[]).join(' → ')} · ${d.step||'—'} · ${d.message||''}\n${matches?'ตรงกับโปรแกรมที่เปิดอยู่':remoteHash==='unavailable'?'ใช้ HTTPS หรือ localhost เพื่อตรวจ revision และไฮไลต์บล็อก':'โปรแกรมคนละ revision — ไม่ไฮไลต์บล็อกเพื่อป้องกันสับสน'}`;
    for(const[lane,event]of Object.entries(d.lanes||{}))$('runtime-state').textContent+=`\nงาน ${lane} · ${event.step||'—'} · ${event.phase} · ${event.message||''}`;
    for(const el of document.querySelectorAll('[data-block]'))el.classList.toggle('remote',el.dataset.block===remoteId);
    window.dispatchEvent(new Event('task-studio-render'));
  }
  async function init(){
    if(!getAuthToken()){location.replace('/');return;}
    try{
      const result=await api('/api/session/restore',{sessionId:localStorage.getItem('ros2ide_session'),robotId:localStorage.getItem('ros2ide_robotid')});
      if(result.isSim)throw Error('โหมดนี้ใช้เฉพาะหุ่นยนต์จริง ไม่เปิดใน Sim');
      session=result.sessionId;workspace=result.workspace||localStorage.getItem('ros2ide_workspace')||'~/ros2_ws';ready=true;
      storage='roside_task_studio_'+(localStorage.getItem('ros2ide_username')||'user')+'_'+(result.robotId||localStorage.getItem('ros2ide_robotid')||session);
      saved=localStorage.getItem(storage)||'';if(saved){try{const parsed=JSON.parse(saved);if(M.validate(parsed).length)throw Error('invalid');program=parsed;}catch{note('Draft เดิมไม่ถูกต้อง เก็บไว้โดยไม่เขียนทับ ใช้ส่งออกสำเนาก่อนบันทึกใหม่');}}
      $('connection').textContent='หุ่นยนต์จริง · '+(localStorage.getItem('ros2ide_robotname')||'เชื่อมต่อแล้ว');
      $('palette').innerHTML=Object.entries(M.types).map(([type,m])=>`<button class="palette-block" data-new="${type}" draggable="true"><span>${m.icon}</span>${m.label}</button>`).join('');
      render();
    }catch(error){ready=false;note(error.message);$('connection').textContent='ไม่พร้อมใช้งาน';document.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);return;}
    $('theme').onclick=()=>toggleTheme();$('save').onclick=()=>{try{save();}catch(e){note(e.message);}};
    $('program-name').onchange=event=>{program.name=event.target.value.trim();changed();};
    $('new-function').onclick=()=>{const name=prompt('ชื่อฟังก์ชันภาษาอังกฤษ เช่น pickup');if(name===null)return;if(!M.name(name)||program.functions.some(f=>f.name===name)){note('ชื่อไม่ถูกต้องหรือซ้ำ');return;}program.functions.push({name,params:{},body:[]});tab=name;selected=null;changed();};
    $('check').onclick=check;$('run').onclick=()=>dryRun();$('step').onclick=()=>{if(!running)dryRun(true);else{paused=true;credits++;render();}};
    $('pause').onclick=()=>{paused=!paused;if(!paused)credits=0;render();note('พักที่ขอบเขต Step — บล็อกรอที่เริ่มไปแล้วจะจบก่อนพัก');};$('stop').onclick=()=>{runToken++;paused=false;note('หยุดเฉพาะ Dry Run ในเบราว์เซอร์ ไม่ใช่ E-stop ของหุ่นยนต์');};
    $('json').onclick=()=>download(new Blob([JSON.stringify(program,null,2)],{type:'application/json'}),program.name+'.flow.json');
    $('export').onclick=async()=>{if(!check())return;try{const p=M.clone(program);runnerSource=runnerSource||await template('task-studio-runner.py');download(M.zip(M.packageFiles(p,runnerSource)),p.name+'.zip');note('ส่งออก ROS Package แล้ว · ค่าเริ่มต้น dry_run=true · ไม่ติดตั้งหรือสั่งวิ่งอัตโนมัติ');}catch(e){note(e.message);}};
    $('import').onclick=()=>$('import-file').click();$('import-file').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>150000)throw Error('ไฟล์เกิน 150 KB');const p=JSON.parse(await file.text()),errors=M.validate(p);if(errors.length)throw Error(errors.join('\n'));if(dirty&&!confirm('แทนที่โปรแกรมที่ยังไม่บันทึก?'))return;program=p;tab='Main';selected=null;changed();}catch(e){note(e.message);}finally{event.target.value='';}};
    document.addEventListener('click',event=>{
      const el=event.target.closest('button');if(el?.dataset.tab){tab=el.dataset.tab;selected=null;render();return;}
      if(running)return;
      if(el?.dataset.new)add(el.dataset.new);
      if(el?.dataset.function)add('call',el.dataset.function);
      if(el?.dataset.delete){const f=find(el.dataset.delete);f.list.splice(f.index,1);selected=null;changed();return;}
      if(el?.dataset.move){const f=find(el.dataset.id),to=f.index+Number(el.dataset.move);if(to>=0&&to<f.list.length){[f.list[f.index],f.list[to]]=[f.list[to],f.list[f.index]];changed();}return;}
      const block=event.target.closest('[data-block]');if(block&&!el){selected=block.dataset.block;render();}
    });
    document.addEventListener('dragstart',event=>{if(running){event.preventDefault();return;}const el=event.target.closest('[data-new],[data-function],[data-block]');if(!el)return;event.stopPropagation();event.dataTransfer.setData('text/task-studio',el.dataset.new?'new|'+el.dataset.new:el.dataset.function?'fn|'+el.dataset.function:'move|'+el.dataset.block);});
    $('steps').ondragover=event=>{const zone=event.target.closest('.drop-zone');if(zone&&!running){event.preventDefault();zone.classList.add('over');}};$('steps').ondragleave=event=>event.target.closest('.drop-zone')?.classList.remove('over');
    $('steps').ondrop=event=>{event.preventDefault();const zone=event.target.closest('.drop-zone');if(zone)drop(event.dataTransfer.getData('text/task-studio'),listFor(zone.dataset.list),Number(zone.dataset.index));};
    const watch=topic=>{if(!M.topicName(topic))return;if(watching.length>=8&&!watching.includes(topic)){note('ติดตามได้สูงสุด 8 Topics ต่อรอบ');return;}if(!watching.includes(topic))watching.push(topic);renderTopics();};
    $('discover').onclick=probe;$('watch').onclick=()=>watch($('topic-choice').value);$('runtime-watch').onclick=()=>{watch(window.TaskStudioEditor?.debugTopic()||'/task_studio/debug');probe();};
    $('monitor').onclick=()=>{monitoring=!monitoring;$('monitor').textContent=monitoring?'หยุดติดตาม':'เริ่มติดตาม';if(monitoring)probe();else{clearTimeout(timer);note('หยุดอ่าน Topic แล้ว ข้อมูลที่เห็นเป็นค่ารอบล่าสุด');}};
    $('topic-cards').onclick=event=>{const el=event.target.closest('button');if(el?.dataset.unwatch){watching=watching.filter(t=>t!==el.dataset.unwatch);delete samples[el.dataset.unwatch];renderTopics();}if(el?.dataset.bind&&!running){if(window.TaskStudioV3?.bindTopic)return window.TaskStudioV3.bindTopic(el.dataset.bind,el.dataset.field);let b=find(selected)?.b;if(!['wait_topic','if_topic'].includes(b?.type)){add('wait_topic');b=find(selected).b;}b.topic=el.dataset.bind;if(el.dataset.field){b.field=el.dataset.field;const value=M.field(samples[b.topic]?.data||{},b.field);if(['number','boolean','string'].includes(typeof value))b.value=value;}changed();}};
    window.addEventListener('beforeunload',event=>{if(dirty||running){event.preventDefault();event.returnValue='';}});
    setInterval(()=>{renderTopics();if(lastRuntimeAt&&Date.now()-lastRuntimeAt>6000){remoteId=null;$('runtime-state').textContent='สถานะ ROS Package เก่า — ยังไม่ยืนยันว่าโปรแกรมหยุดหรือสำเร็จ';document.querySelectorAll('.step-card.remote').forEach(el=>el.classList.remove('remote'));}},2000);
    renderTopics();
    window.dispatchEvent(new Event('task-studio-ready'));
  }
  window.TaskStudioBridge={get:()=>({program,tab,running,ready,storage,graph,samples,activeId,remoteId}),body,
    replace(p,nextTab='Main'){if(running)return;program=p;tab=nextTab;selected=null;changed();},
    edit(blocks){if(running)return;if(tab==='Main')program.main=blocks;else program.functions.find(f=>f.name===tab).body=blocks;dirty=true;remoteHash='';$('save-state').textContent='ยังไม่บันทึก';},
    selectTab(name){tab=name;selected=null;render();},note,download,template,changed,render,
    markSaved(){dirty=false;$('save-state').textContent='บันทึกแอปในเบราว์เซอร์แล้ว';},
    select(id){selected=id;properties();},log};
  init();
})();
