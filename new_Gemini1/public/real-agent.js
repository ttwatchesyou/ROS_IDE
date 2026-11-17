'use strict';
// Physical robot UI only. No API calls or controls are added to Sim workspaces.
(()=>{
  let dialog=null,state=null,libraryRevision,libraryRobot=null,refreshing=false,update=null,updateTimer=null,starting=false,updateSession=null,returnTimer=null;
  const updateReturnKey='roside_agent_manual_update_return';
  const currentRobotKey=()=>{try{return localStorage.getItem('ros2ide_robotkey');}catch{return null;}};
  const real=()=>typeof sessionId!=='undefined'&&sessionId&&typeof isSimWorkspace!=='undefined'&&!isSimWorkspace;
  const icons={robot:'M8 4h8v3H8z M5 7h14v13H5z M9 12h.01 M15 12h.01 M9 16h6 M2 11v5 M22 11v5',cloud:'M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 3 3.5 3.5 0 0 1-1 7Z',local:'M3 4h18v12H3z M8 21h8 M12 16v5',refresh:'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 6 M4 12l2 6a7 7 0 0 0 12-1',download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',upload:'M12 16V4 M7 9l5-5 5 5 M4 16v5h16v-5',box:'m12 3 9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M7 5l9 5',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',arrow:'M7 17 17 7 M7 7h10v10',close:'m6 6 12 12 M6 18 18 6'};
  const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]}"></path></svg>`;
  const request=async(url,body={})=>{if(!real())throw new Error('Physical robot only');const result=await API(url,{sessionId,...body});if(!result.ok)throw new Error(result.error||'Request failed');return result;};
  async function refresh(){
    if(refreshing||!real())return;refreshing=true;
    const started=performance.now(),refreshButton=dialog.querySelector('[data-refresh]');refreshButton.disabled=true;
    try{
      state=await request('/api/real/agent/status');
      const connection=(state.connection||'online').toUpperCase(),mode=(state.mode||'online').toUpperCase();
      dialog.querySelector('[data-status]').textContent=`หน้านี้เชื่อมต่อผ่าน ${connection}`;
      dialog.querySelector('[data-version]').textContent=state.legacy?'Legacy':`v${state.version}`;
      dialog.querySelector('[data-web-revision]').textContent=state.releaseSha256?`เว็บบนหุ่น: ${state.releaseSha256.slice(0,12)} · Cloud: ${state.latestReleaseSha256?.slice(0,12)||'ไม่ทราบ'}`:'เว็บบนหุ่น: ยังไม่รายงานชุดไฟล์';
      dialog.querySelector('[data-latest]').textContent=state.latestVersion?`รุ่นล่าสุด v${state.latestVersion}`:'ยังไม่มีไฟล์อัปเดต';
      const notes=dialog.querySelector('[data-release-notes]');notes.replaceChildren();
      for(const line of state.releaseNotes||[]){const item=document.createElement('li');item.textContent=line;notes.append(item);}
      if(!notes.children.length){const item=document.createElement('li');item.textContent='ยังไม่มีรายการเปลี่ยนแปลง';notes.append(item);}
      const topic=dialog.querySelector('[data-auto-topic]');if(document.activeElement!==topic)topic.value=state.autoUpdate?.topic||'';
      dialog.querySelector('[data-auto-status]').textContent=state.legacy?'Agent รุ่นเดิมต้องอัปเดตด้วยตนเองหนึ่งครั้ง':state.autoUpdate?.active?'กำลังอัปเดตอัตโนมัติ · '+(state.autoUpdate.stage||'เตรียมติดตั้ง'):state.autoUpdate?.error?'อัปเดตอัตโนมัติไม่สำเร็จ: '+state.autoUpdate.error:state.autoUpdate?.enabled?'เปิดใช้งาน · ตรวจรุ่นทุก 5 นาที เมื่อว่างและสัญญาณปลอดภัย':'ยังไม่เปิดใช้งาน · ระบุ ROS Bool topic ที่ยืนยันว่ามอเตอร์ปิดและห้ามรับคำสั่ง';
      dialog.querySelector('[data-auto-save]').disabled=state.legacy||!!state.autoUpdate?.active;
      dialog.querySelector('[data-mode]').textContent=mode;
      dialog.querySelector('[data-latency]').textContent=`${Math.round(performance.now()-started)} ms`;
      dialog.querySelector('[data-terminals]').textContent=state.legacy?'—':state.terminals||0;
      dialog.querySelector('[data-busy]').textContent=state.legacy?'—':state.busy||0;
      dialog.querySelector('[data-connection]').textContent=connection;
      const routeBadge=document.getElementById('control-route');if(routeBadge){routeBadge.dataset.route=connection.toLowerCase();routeBadge.textContent=connection==='LOCAL'?'Local':'Cloud';}
      const links=dialog.querySelector('[data-links]');links.replaceChildren();
      for(const value of state.localUrls||[]){let url;try{url=new URL(value);}catch{continue;}if(!['http:','https:'].includes(url.protocol))continue;const label=document.createElement('span');label.textContent=url.host;links.append(label);}
      if(!links.children.length){const empty=document.createElement('span');empty.className='ra-muted';empty.textContent=state.legacy?'อัปเดต Agent เพื่อใช้งาน Local':'ยังไม่มีที่อยู่ Local จาก Agent';links.append(empty);}
      dialog.querySelector('[data-select-label]').textContent=`ใช้ ${connection} ควบคุม`;
      renderUpdate(state.update);
    }catch(error){dialog.querySelector('[data-status]').textContent='ตรวจสอบการเชื่อมต่อไม่สำเร็จ';show(error.message);}finally{refreshing=false;refreshButton.disabled=false;}
  }
  const show=text=>{dialog.querySelector('[data-message]').textContent=text;};
  function returnAfterManualUpdate(job){
    let pending;try{pending=JSON.parse(sessionStorage.getItem(updateReturnKey)||'null');}catch{return;}
    if(!pending?.robotKey||pending.id!==job?.id||pending.robotKey!==currentRobotKey())return;
    if(job.stage==='failed'){sessionStorage.removeItem(updateReturnKey);return;}
    if(job.stage!=='succeeded'||returnTimer)return;
    returnTimer=setTimeout(()=>{
      sessionStorage.removeItem(updateReturnKey);
      window.location.replace('/robots');
    },1200);
  }
  function renderUpdate(job){
    update=job||null;window.rosideAgentUpdating=!!update?.active;
    const locked=starting||!!update?.active,button=dialog.querySelector('[data-update]');
    button.disabled=locked||(state?.connection!=='local'&&!state?.updateAvailable&&update?.stage!=='failed');
    button.querySelector('span').textContent=locked?'กำลังอัปเดต…':state?.connection==='local'?'เปิด Cloud เพื่ออัปเดต':update?.stage==='succeeded'?'อัปเดตสำเร็จ ✓':update?.stage==='failed'?'ลองอัปเดตอีกครั้ง':!state?.updateAvailable?'เป็นเวอร์ชันล่าสุด':'อัปเดต Agent';
    dialog.querySelector('[data-update-summary]').textContent=locked?'กำลังดำเนินการให้โดยอัตโนมัติ':state?.connection==='local'?'กดเพื่อเปิดหน้าเลือกหุ่นยนต์บน Cloud แล้วอัปเดต Agent':state?.updateAvailable?`พร้อมอัปเดต${state.latestVersion?'เป็น v'+state.latestVersion:''} · เก็บค่าตั้งเดิมไว้`:'Agent พร้อมใช้งาน ไม่ต้องอัปเดตเพิ่ม';
    dialog.querySelector('[data-select]').disabled=locked||!!state?.legacy;
    for(const item of dialog.querySelectorAll('[data-library]'))item.disabled=locked||!!state?.legacy;
    const section=dialog.querySelector('[data-update-progress]');section.hidden=!update;
    if(update){
      section.dataset.stage=update.stage;
      const progress=dialog.querySelector('progress');progress.value=update.progress;
      dialog.querySelector('[data-update-label]').textContent=`${update.progress}% · ${update.message}`;
      dialog.querySelector('[data-update-note]').textContent=update.stage==='succeeded'?`ยืนยัน Agent ${update.targetVersion} เชื่อมกลับมาแล้ว เปิดเครื่องมือที่ต้องการใหม่ได้`:
        update.stage==='failed'?'ยังไม่ยืนยันว่าอัปเดตสำเร็จ กรุณาดูข้อความด้านบนแล้วลองอีกครั้ง':'ความคืบหน้าตามขั้นตอนติดตั้ง ไม่ใช่เปอร์เซ็นต์ของเวลา ระหว่างรีสตาร์ตจะรอ Agent เชื่อมกลับให้อัตโนมัติ';
    }
    if(update?.active&&!updateTimer){updateSession=sessionId;updateTimer=setTimeout(pollUpdate,1500);}
    if(!update?.active&&updateTimer){clearTimeout(updateTimer);updateTimer=null;}
    returnAfterManualUpdate(update);
  }
  async function pollUpdate(){
    updateTimer=null;if(!real()||sessionId!==updateSession){window.rosideAgentUpdating=false;return;}
    try{const result=await request('/api/real/agent/update-status');renderUpdate(result.update);if(result.update&&!result.update.active)await refresh();}
    catch(error){show('กำลังรอตรวจสถานะอีกครั้ง: '+error.message+' (ยังไม่ถือว่าอัปเดตสำเร็จ)');if(update?.active)updateTimer=setTimeout(pollUpdate,3000);}
  }
  async function act(button,fn){button.disabled=true;try{await fn();}catch(error){show(error.message);}finally{button.disabled=false;await refresh();}}
  function libraryKey(){return typeof tfCustomKey==='function'?tfCustomKey():'tf_custom_'+(localStorage.getItem('ros2ide_username')||'default');}
  function ensureDialog(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.id='real-agent-dialog';dialog.setAttribute('aria-labelledby','ra-title');
    const style=document.createElement('style');style.textContent=`
      #real-agent-dialog{--ra-bg:#fff;--ra-panel:#f7f9fc;--ra-line:#e3e9f2;--ra-text:#202d43;--ra-muted:#65748b;--ra-blue:#2563eb;--ra-tint:#edf4ff;--ra-green:#167458;width:min(640px,calc(100vw - 24px));max-height:calc(100dvh - 32px);margin:auto;padding:0;overflow:auto;border:1px solid var(--ra-line);border-radius:22px;background:var(--ra-bg);color:var(--ra-text);font:13px/1.6 system-ui,sans-serif;box-shadow:0 24px 90px #101e3440;color-scheme:light}
      [data-theme="dark"] #real-agent-dialog{--ra-bg:#171e2b;--ra-panel:#1e2838;--ra-line:#303e52;--ra-text:#e8eef9;--ra-muted:#a3b2c9;--ra-blue:#83adff;--ra-tint:#203455;--ra-green:#73dfb7;color-scheme:dark}
      #real-agent-dialog::backdrop{background:#0f172a70;backdrop-filter:blur(5px)}
      #real-agent-dialog *{box-sizing:border-box}#real-agent-dialog [hidden]{display:none!important}
      #real-agent-dialog svg{width:18px;height:18px;flex-shrink:0}#real-agent-dialog p{margin:0}#real-agent-dialog h3{margin:0;font-size:20px;letter-spacing:-.4px;color:var(--ra-text)}#real-agent-dialog h4{margin:0;font-size:13px;color:var(--ra-text)}
      #real-agent-dialog .ra-muted,#real-agent-dialog small{color:var(--ra-muted);font-size:12px}#real-agent-dialog .ra-header{display:flex;align-items:center;gap:12px;padding:22px 24px 18px;border-bottom:1px solid var(--ra-line)}
      #real-agent-dialog .ra-logo{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:var(--ra-tint);color:var(--ra-blue)}#real-agent-dialog .ra-logo svg{width:26px;height:26px}
      #real-agent-dialog .ra-header form{margin:0 0 0 auto}#real-agent-dialog button{display:inline-flex;justify-content:center;align-items:center;gap:7px;min-height:40px;margin:0;padding:8px 12px;border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-bg);color:var(--ra-text);font:500 12px/1.5 system-ui;cursor:pointer;transition:background .15s,border-color .15s}
      #real-agent-dialog button:hover:not(:disabled){background:var(--ra-tint);border-color:var(--ra-blue)}#real-agent-dialog button:disabled{opacity:.5;cursor:not-allowed}#real-agent-dialog button:focus-visible,#real-agent-dialog a:focus-visible{outline:3px solid var(--ra-blue);outline-offset:3px}
      #real-agent-dialog .ra-icon-button{width:40px;padding:8px}#real-agent-dialog .ra-body{padding:20px 24px;display:grid;gap:16px}
      #real-agent-dialog .ra-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px}#real-agent-dialog .ra-status-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:650}
      #real-agent-dialog .ra-version{font:600 11px/1.6 ui-monospace,monospace;padding:2px 7px;border-radius:6px;background:var(--ra-panel);border:1px solid var(--ra-line);color:var(--ra-muted)}
      #real-agent-dialog .ra-metrics{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:1px;background:var(--ra-line);border:1px solid var(--ra-line);border-radius:12px;overflow:hidden}
      #real-agent-dialog .ra-metric{background:var(--ra-panel);padding:11px 14px;display:grid;gap:2px}#real-agent-dialog .ra-metric strong{font-size:17px;line-height:1.5;font-variant-numeric:tabular-nums;font-weight:650}
      #real-agent-dialog .ra-routes{display:grid;grid-template-columns:1fr 1fr;gap:12px}#real-agent-dialog .ra-card{border:1px solid var(--ra-line);border-radius:13px;padding:14px;min-width:0}
      #real-agent-dialog .ra-card-title{display:flex;gap:8px;align-items:center;margin-bottom:8px}#real-agent-dialog .ra-card-title>svg{color:var(--ra-blue)}#real-agent-dialog .ra-card p{font-size:12px;color:var(--ra-muted)}
      #real-agent-dialog .ra-mode{font-weight:650;color:var(--ra-green)}#real-agent-dialog [data-select]{margin-top:12px;width:100%;background:var(--ra-tint);border-color:transparent;color:var(--ra-blue)}
      #real-agent-dialog [data-links]{display:grid;gap:5px;margin-bottom:8px}#real-agent-dialog [data-links] a{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:30px;padding:3px 7px;border-radius:6px;background:var(--ra-panel);color:var(--ra-blue);text-decoration:none;font-size:12px;font-variant-numeric:tabular-nums}#real-agent-dialog [data-links] a:hover{background:var(--ra-tint)}#real-agent-dialog [data-links] span{overflow-wrap:anywhere}#real-agent-dialog [data-links] svg{width:14px;height:14px}
      #real-agent-dialog .ra-update{background:var(--ra-panel)}#real-agent-dialog .ra-update-row{display:flex;align-items:center;justify-content:space-between;gap:14px}#real-agent-dialog .ra-update .ra-card-title{margin-bottom:3px}
      #real-agent-dialog [data-update]{flex-shrink:0;background:#2563eb;color:#fff;border-color:#2563eb;min-height:42px}#real-agent-dialog [data-update]:hover:not(:disabled){background:#1d4ed8;border-color:#1d4ed8}
      #real-agent-dialog [data-update-progress]{margin-top:14px;padding-top:12px;border-top:1px solid var(--ra-line)}#real-agent-dialog [data-update-label]{font-size:12px;font-weight:600}#real-agent-dialog progress{display:block;width:100%;height:7px;margin:10px 0;border:0;border-radius:8px;overflow:hidden;appearance:none;background:var(--ra-line);accent-color:#2563eb}
      #real-agent-dialog progress::-webkit-progress-bar{background:var(--ra-line);border-radius:8px}#real-agent-dialog progress::-webkit-progress-value{background:#2563eb;border-radius:8px;transition:width .3s}#real-agent-dialog progress::-moz-progress-bar{background:#2563eb;border-radius:8px}
      #real-agent-dialog [data-stage="succeeded"]{color:var(--ra-green)}#real-agent-dialog [data-stage="succeeded"] progress::-webkit-progress-value{background:#18a577}#real-agent-dialog [data-stage="failed"]{color:#d16b39}#real-agent-dialog [data-stage="failed"] progress::-webkit-progress-value{background:#d16b39}
      #real-agent-dialog .ra-library-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}#real-agent-dialog [data-message]{padding:10px 12px;background:var(--ra-tint);border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ra-text);font-size:12px}#real-agent-dialog [data-message]:empty{display:none}
      #real-agent-dialog [data-auto-topic]{width:100%;min-height:40px;padding:8px;border:1px solid var(--ra-line);border-radius:9px;background:var(--ra-bg);color:var(--ra-text);font:12px system-ui}#real-agent-dialog [data-release-notes]{margin:6px 0 0;padding-left:20px;color:var(--ra-muted);font-size:12px}
      #real-agent-dialog .ra-footer{display:flex;gap:9px;align-items:flex-start;padding:14px 24px;border-top:1px solid var(--ra-line);background:var(--ra-panel);color:var(--ra-muted);font-size:11px}#real-agent-dialog .ra-footer svg{width:16px;height:16px;margin-top:2px}
      @media(max-width:520px){#real-agent-dialog{border-radius:16px;max-height:calc(100dvh - 20px)}#real-agent-dialog .ra-header{padding:16px}#real-agent-dialog .ra-body{padding:16px;gap:12px}#real-agent-dialog .ra-footer{padding:12px 16px}#real-agent-dialog .ra-routes{grid-template-columns:1fr}#real-agent-dialog .ra-metric{padding:9px}#real-agent-dialog .ra-update-row{align-items:stretch;flex-direction:column;gap:10px}#real-agent-dialog h3{font-size:18px}#real-agent-dialog button{min-height:44px}#real-agent-dialog .ra-library-actions{gap:6px}#real-agent-dialog .ra-library-actions button{padding:8px 6px;font-size:11px}}
      @media(prefers-reduced-motion:reduce){#real-agent-dialog *{transition:none!important}}
    `;document.head.append(style);
    dialog.innerHTML=`<header class="ra-header"><div class="ra-logo">${icon('robot')}</div><div><h3 id="ra-title">Robot Agent</h3><p class="ra-muted">จัดการการเชื่อมต่อและอัปเดตหุ่นยนต์</p></div><form method="dialog"><button class="ra-icon-button" aria-label="ปิด">${icon('close')}</button></form></header>
      <div class="ra-body">
        <div class="ra-status-row"><div><div class="ra-status-title">สถานะ Agent <span class="ra-version" data-version>—</span></div><p class="ra-muted" data-status role="status">กำลังตรวจสอบ…</p></div><button data-refresh class="ra-icon-button" title="ตรวจสอบสถานะใหม่" aria-label="ตรวจสอบสถานะใหม่">${icon('refresh')}</button></div>
        <p class="ra-muted" data-web-revision>กำลังตรวจสอบชุดไฟล์เว็บ…</p>
        <div class="ra-metrics"><div class="ra-metric" title="เวลาไปกลับ Browser → backend → Agent → Browser"><small>ตรวจสถานะไป–กลับ</small><strong data-latency>—</strong></div><div class="ra-metric"><small>Terminal / stream</small><strong data-terminals>—</strong></div><div class="ra-metric"><small>งานที่กำลังทำ</small><strong data-busy>—</strong></div></div>
        <div class="ra-routes"><section class="ra-card"><div class="ra-card-title">${icon('cloud')}<h4>เส้นทางควบคุม</h4></div><p>เปิดหน้านี้ผ่าน <strong data-connection>—</strong></p><p>โหมดที่ใช้งาน <span class="ra-mode" data-mode>—</span></p><button data-select disabled>${icon('arrow')}<span data-select-label>เลือกโหมด</span></button></section>
        <section class="ra-card"><div class="ra-card-title">${icon('local')}<h4>เชื่อมต่อ Local</h4></div><div data-links><span class="ra-muted">กำลังค้นหาที่อยู่…</span></div><p>กลับไปหน้าหุ่นยนต์แล้วกด “เริ่มภารกิจ” ระบบจะเลือก Local อัตโนมัติเมื่อ LAN พร้อม</p></section></div>
        <section class="ra-card ra-update"><div class="ra-update-row"><div><div class="ra-card-title">${icon('download')}<h4>อัปเดตซอฟต์แวร์</h4></div><p data-update-summary>กำลังตรวจสอบเวอร์ชัน…</p></div><button data-update disabled>${icon('download')}<span>อัปเดต Agent</span></button></div>
        <section data-update-progress hidden><div data-update-label role="status" aria-live="polite"></div><progress max="100" value="0" aria-label="ความคืบหน้าการอัปเดต Agent"></progress><small data-update-note></small></section></section>
        <section class="ra-card"><div class="ra-card-title">${icon('shield')}<h4>อัปเดตอัตโนมัติ</h4></div><p data-auto-status role="status">กำลังตรวจสอบ…</p><p class="ra-muted" data-latest></p><ul data-release-notes></ul><p>ระบบเฝ้า <code>/cmd_vel</code> อัตโนมัติ: ต้องไม่มีคำสั่งขับเคลื่อน และยังต้องยืนยันว่ามอเตอร์ปิด</p><label for="ra-auto-topic">สัญญาณยืนยันมอเตอร์ปิด ชนิด std_msgs/msg/Bool ค่า true = ปิดและห้ามรับคำสั่ง</label><input id="ra-auto-topic" data-auto-topic placeholder="/robot/update_safe" autocomplete="off"><button data-auto-save>บันทึกสัญญาณปลอดภัย</button><p class="ra-muted">ล้างชื่อ topic แล้วบันทึกเพื่อปิดอัปเดตอัตโนมัติ</p></section>
        <section class="ra-card"><div class="ra-card-title">${icon('box')}<h4>คลังชิ้นส่วนร่วม</h4></div><p>เก็บบนหุ่นยนต์ตัวนี้ ใช้ร่วมกันได้ทั้ง Online และ Local</p><div class="ra-library-actions"><button data-library="read" disabled>${icon('download')}<span>โหลดจากหุ่นยนต์</span></button><button data-library="write" disabled>${icon('upload')}<span>บันทึกไปหุ่นยนต์</span></button></div></section>
        <p data-message role="status"></p>
      </div><footer class="ra-footer">${icon('shield')}<span>หยุดหุ่นยนต์และบันทึกงานก่อนอัปเดต ระบบจะปิดเครื่องมือ Online และรอเชื่อมกลับให้อัตโนมัติ ไม่สั่งให้หุ่นยนต์เคลื่อนที่<br>ก่อนสลับโหมด ให้ปิด Terminal/เครื่องมือก่อน ไม่มีการสลับเส้นทางอัตโนมัติ</span></footer>`;
    document.body.append(dialog);
    dialog.querySelector('[data-refresh]').onclick=refresh;
    dialog.querySelector('[data-auto-save]').onclick=event=>act(event.currentTarget,async()=>{
      const topic=dialog.querySelector('[data-auto-topic]').value.trim();
      await request('/api/real/agent/auto-update',{topic});show(topic?'บันทึก topic แล้ว Agent จะรอสัญญาณปลอดภัยก่อนอัปเดต':'ปิดอัปเดตอัตโนมัติแล้ว');
    });
    dialog.querySelector('[data-select]').onclick=event=>act(event.currentTarget,async()=>{
      if(!confirm('หยุดหุ่นยนต์ ปิด Terminal/Monitor/เครื่องมือควบคุม และรอ Build จบแล้ว ต้องการใช้เส้นทางของหน้านี้หรือไม่?'))return;
      await request('/api/real/agent/mode',{confirm:true});show('เปลี่ยนโหมดแล้ว กรุณาเปิดเครื่องมือที่ต้องการใหม่');
    });
    dialog.querySelector('[data-update]').onclick=async()=>{
      if(starting||update?.active)return;
      if(state?.connection==='local'){window.open('/robots','_blank','noopener');return;}
      if(!confirm('ยืนยันว่าหุ่นยนต์และมอเตอร์หยุดแล้ว และบันทึกงานแล้ว? ระบบจะปิด Terminal/เครื่องมือ Online ของหุ่นยนต์นี้ทุกแท็บ รวมถึงผู้ใช้อื่น งานใน Terminal อาจถูกหยุด แล้วอัปเดตให้อัตโนมัติ โดยเก็บ Robot Key และค่าตั้งเดิมไว้'))return;
      starting=true;renderUpdate(update);show('กำลังส่งคำขออัปเดต…');
      try{
        const result=await request('/api/real/agent/update',{confirm:true});
        if(typeof termResetTabs==='function')termResetTabs();if(typeof termRenderTabs==='function')termRenderTabs();
        const robotKey=currentRobotKey();
        if(result.update?.id&&robotKey)try{sessionStorage.setItem(updateReturnKey,JSON.stringify({id:result.update.id,robotKey}));}catch{}
        show('');renderUpdate(result.update);
      }catch(error){show(error.message);}
      finally{starting=false;renderUpdate(update);}
    };
    dialog.querySelector('[data-library="read"]').onclick=event=>act(event.currentTarget,async()=>{
      const result=await request('/api/real/library/read');
      if(!confirm('ใช้คลังจากหุ่นยนต์แทนคลังในเบราว์เซอร์นี้? จะเก็บสำเนาคลังเบราว์เซอร์ไว้ก่อน'))return;
      const key=libraryKey();localStorage.setItem(key+'_before_robot_'+Date.now(),localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(result.items));
      libraryRevision=result.revision;libraryRobot=localStorage.getItem('ros2ide_robotkey');
      if(typeof tfLoadCustom==='function')tfLoadCustom();if(typeof tfRenderAddGrid==='function')tfRenderAddGrid();if(typeof dcRenderLibrary==='function')dcRenderLibrary();show('โหลดคลังจากหุ่นยนต์แล้ว');
    });
    dialog.querySelector('[data-library="write"]').onclick=event=>act(event.currentTarget,async()=>{
      const robot=localStorage.getItem('ros2ide_robotkey');
      if(libraryRevision===undefined||libraryRobot!==robot){const current=await request('/api/real/library/read');if(current.items.length&&!confirm('หุ่นยนต์มีคลังเดิมอยู่แล้ว ต้องการแทนด้วยคลังจากเบราว์เซอร์นี้หรือไม่?'))return;libraryRevision=current.revision;libraryRobot=robot;}
      const items=JSON.parse(localStorage.getItem(libraryKey())||'[]');
      const result=await request('/api/real/library/write',{items,ifRevision:libraryRevision});libraryRevision=result.revision;show('บันทึกคลังไว้บนหุ่นยนต์แล้ว เปิดอีกโหมดแล้วกด “โหลดคลังจากหุ่นยนต์” เพื่อใช้ร่วมกัน');
    });
  }
  function install(){
    let button=document.getElementById('real-agent-button');
    const routeBadge=document.getElementById('control-route');
    if(!real()){if(button)button.hidden=true;if(routeBadge)routeBadge.hidden=true;return;}
    if(routeBadge){const route=localStorage.getItem('ros2ide_connection_route')==='local'?'local':'cloud';routeBadge.hidden=false;routeBadge.dataset.route=route;routeBadge.textContent=route==='local'?'Local':'Cloud';routeBadge.title=route==='local'?'ควบคุมผ่าน Local บนหุ่นยนต์':'ควบคุมผ่าน Cloud';}
    let routeWarning=false;
    try{routeWarning=sessionStorage.getItem('roside_cloud_route_warning')===localStorage.getItem('ros2ide_robotkey');}catch{}
    if(routeWarning&&!document.getElementById('real-agent-network-warning')){
      const warning=document.createElement('div');warning.id='real-agent-network-warning';warning.setAttribute('role','status');warning.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:9990;max-width:720px;margin:auto;padding:12px 16px;border:1px solid #d89524;border-radius:12px;background:#fff4d6;color:#523809;box-shadow:0 8px 28px #0002;font:600 13px/1.5 system-ui,sans-serif';
      warning.textContent='⚠️ ใช้งานผ่าน Cloud เพราะตรวจไม่พบเส้นทาง LAN ที่ยืนยันได้ โปรแกรมควบคุมและข้อมูลสดอาจล่าช้าหรือทำงานไม่สมบูรณ์เมื่ออินเทอร์เน็ตไม่เสถียร';
      document.body.append(warning);
    }
    if(!button){const target=document.querySelector('#topbar .top-actions');if(!target)return;button=document.createElement('button');button.id='real-agent-button';button.className='top-icon-action';button.textContent='⇄';button.title='Agent version · Online / Local · คลังร่วม';button.setAttribute('aria-label',button.title);button.onclick=()=>{ensureDialog();show('');dialog.showModal();refresh();};target.prepend(button);}
    button.hidden=false;
  }
  // Does not poll the backend; checks only session state in this tab.
  setInterval(install,2000);install();
})();
