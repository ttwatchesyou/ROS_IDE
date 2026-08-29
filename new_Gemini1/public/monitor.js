// ══ MONITOR TOPICS — Phase 2 ══
// Depends on: common.js (sessionId, rosInfo, API, sbMsg, escH)

const MON = {
  topics: [],
  filtered: [],
  selected: null,
  subWs: null,
  subActive: false,
  msgs: [],
  MAX_MSGS: 200,
  autoRefresh: false,
  autoTimer: null,
  graphField: '',
  graphData: {},
  graphTimer: null,
  _hzTimer: null,    // interval for Hz badge update
  pubRepeatTimer: null,
  detTab: 'msg',
  monInited: false,
};

let monHzCount = 0, monHzLast = Date.now();
let _monRenderTimer = null;
let _graphRenderTimer = null;

// ══ Resize handle for list panel ══
(function(){
  const panel   = document.getElementById('mon-list-panel');
  const resizer = document.getElementById('mon-list-resizer');
  if(!panel||!resizer) return;
  let sx=0, sw=0, drag=false;
  resizer.addEventListener('mousedown',e=>{
    e.preventDefault(); drag=true; sx=e.clientX; sw=panel.offsetWidth;
    resizer.classList.add('dragging'); document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
  });
  document.addEventListener('mousemove',e=>{
    if(!drag) return;
    const nw=Math.min(440,Math.max(180,sw+(e.clientX-sx)));
    panel.style.width=nw+'px';
  });
  document.addEventListener('mouseup',()=>{
    if(!drag) return; drag=false;
    resizer.classList.remove('dragging');
    document.body.style.cursor=''; document.body.style.userSelect='';
  });
  resizer.addEventListener('dblclick',()=>panel.style.width='280px');
})();

// ══ Init when switching to monitor page ══
function initMonitor(){
  document.getElementById('btn-mon-refresh').disabled = !sessionId;
  if(sessionId && MON.topics.length===0) monRefresh();
}

// ══ Fetch topic list + hz ══
async function monRefresh(){
  if(!sessionId) return;
  const btn = document.getElementById('btn-mon-refresh');
  if(btn){ btn.disabled=true; btn.textContent='↻ Loading...'; }
  sbMsg('Loading topics...');

  try{
    const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
    const r = await API('/api/exec',{sessionId,
      command:`bash -lc "source ${src} 2>/dev/null && ros2 topic list -t 2>/dev/null"`,
      timeout:8000});

    const lines = (r.stdout||'').split('\n').filter(Boolean);
    MON.topics = lines.map(line=>{
      const m = line.match(/^(\S+)\s+\[(.+)\]$/);
      return m ? {name:m[1],type:m[2],hz:null,pubs:0,subs:0} : {name:line.trim(),type:'—',hz:null,pubs:0,subs:0};
    });

    // Get hz for top 10 topics in parallel (brief sample)
    const targets = MON.topics.filter(t=>!t.name.includes('/rosout')&&!t.name.includes('/parameter')).slice(0,10);
    const hzResults = await Promise.all(targets.map(t=>
      API('/api/exec',{sessionId,
        command:`bash -lc "source ${src} 2>/dev/null && timeout 1.0 ros2 topic hz ${t.name} 2>/dev/null | grep -m1 average | awk '{print \\$3}'"`,
        timeout:3000})
      .then(r=>({name:t.name, hz:parseFloat(r.stdout)||0}))
    ));
    hzResults.forEach(h=>{
      const t=MON.topics.find(x=>x.name===h.name);
      if(t) t.hz=h.hz;
    });

    monFilter();
    monUpdateBadges();
    sbMsg('');
  }catch(e){ sbMsg('Error: '+e.message,3000); }

  if(btn){ btn.disabled=!sessionId; btn.textContent='↻ Refresh'; }
}

function monUpdateBadges(){
  const total = MON.topics.length;
  const live  = MON.topics.filter(t=>t.hz&&t.hz>0).length;
  document.getElementById('mon-total-badge').textContent = total+' topics';
  document.getElementById('mon-pub-badge').textContent   = live+' live';
  const cnt = document.getElementById('mon-cnt');
  if(cnt){ cnt.textContent=total; cnt.classList.toggle('hidden',total===0); }
}

function monFilter(){
  const q = (document.getElementById('mon-search')?.value||'').toLowerCase();
  MON.filtered = q ? MON.topics.filter(t=>t.name.includes(q)||t.type.toLowerCase().includes(q)) : [...MON.topics];
  monRenderList();
}

function monRenderList(){
  const el = document.getElementById('mon-list-scroll');
  if(!el) return;
  if(MON.filtered.length===0){
    el.innerHTML='<div class="mon-placeholder" style="padding:40px 0"><div class="icon">🔍</div><div>ไม่พบ topic</div></div>';
    return;
  }
  el.innerHTML = MON.filtered.map(t=>{
    const hz = t.hz;
    const hzCls = hz===null?'dead':hz===0?'dead':hz<0.5?'slow':'live';
    const hzTxt = hz===null?'—':hz===0?'0':hz<0.1?'<0.1':hz.toFixed(1);
    const active = t.name===MON.selected ? 'active' : '';
    return `<div class="mon-row ${active}" onclick="monSelectTopic(decodeURIComponent('${encArg(t.name)}'),decodeURIComponent('${encArg(t.type)}'))">
      <div style="display:flex;align-items:center;min-width:0">
        <span class="mon-dot ${hzCls}"></span>
        <span class="mon-rname" title="${escH(t.name)}">${escH(t.name)}</span>
      </div>
      <div class="mon-rtype" title="${escH(t.type)}">${escH(t.type.split('/').pop())}</div>
      <div class="mon-rhz ${hzCls}">${hzTxt}</div>
    </div>`;
  }).join('');
}

// ══ Select a topic ══
async function monSelectTopic(name, type){
  // Stop previous subscription cleanly
  monStopSub();
  MON.selected = name;
  MON.msgs = [];
  MON.graphData = {};
  monHzCount = 0;
  monHzLast = Date.now();

  // Update UI
  monRenderList(); // re-highlight active
  document.getElementById('mon-det-hdr').classList.remove('hidden');
  document.getElementById('mon-det-tabs').classList.remove('hidden');
  document.getElementById('mon-no-topic').style.display='none';
  document.getElementById('mon-topic-title').textContent = name;
  document.getElementById('mon-topic-type').textContent  = type;
  document.getElementById('pub-topic-name').value        = name;
  document.getElementById('mon-hz-live').textContent     = '— Hz';
  const subBtn = document.getElementById('btn-sub-toggle');
  if(subBtn){ subBtn.textContent='▶ Subscribe'; subBtn.className='btn'; }

  // Clear message stream
  document.getElementById('mon-msgs').innerHTML =
    '<div class="mon-placeholder"><div class="icon">💬</div><div>กด Subscribe เพื่อดู messages</div></div>';

  // Switch to msg tab
  monDetTab('msg');

  // Load info
  monLoadInfo(name, type);

  // Build publish template
  monBuildPubTemplate(type);
}

// ══ Subscribe / Unsubscribe ══
function monToggleSub(){
  if(MON.subActive) monStopSub();
  else monStartSub();
}

function monStartSub(){
  if(!sessionId || !MON.selected) return;
  if(MON.subWs){ try{MON.subWs.close();}catch(e){} MON.subWs=null; }

  const proto = location.protocol==='https:'?'wss:':'ws:';
  const token = getAuthToken();
  const url   = `${proto}//${location.host}/ws/monitor`;

  // อัปเดต UI ทันทีที่กดเพื่อบอกผู้ใช้ว่ากำลังเชื่อมต่อ
  const btn = document.getElementById('btn-sub-toggle');
  if(btn){ btn.textContent = '⏳ Connecting...'; btn.disabled = true; }

  try{ MON.subWs = new WebSocket(url, ['ros2ide', token]); }
  catch(e){ console.error('WS monitor error:',e); monSetSubActive(false); return; }

  MON.subWs.onopen = () => {
    MON.subWs.send(JSON.stringify({
      type:'subscribe',
      sessionId,
      topic: MON.selected,
      setupBash: rosInfo?.setupBash||'/opt/ros/humble/setup.bash',
    }));
  };

  MON.subWs.onmessage = e => {
    let d;
    try{ d = JSON.parse(e.data); }catch(err){ return; }

    if(d.type==='ready'){
      monSetSubActive(true);
      // Start Hz watchdog
      monHzCount=0; monHzLast=Date.now();
      if(!MON._hzTimer){
        MON._hzTimer = setInterval(()=>{
          if(!MON.subActive){ clearInterval(MON._hzTimer); MON._hzTimer=null; return; }
          const elapsed = Date.now()-monHzLast;
          if(elapsed>3000){
            const badge=document.getElementById('mon-hz-live');
            if(badge) badge.textContent='0 Hz';
          }
        },1000);
      }
    }
    else if(d.type==='msg'){
      if(!MON.subActive) monSetSubActive(true);
      
      let obj = {};
      try { 
        obj = JSON.parse(d.data); 
      } catch(err) {
        // Fallback in case python sends unparseable text
        obj = { data: d.data };
      }
      
      monHandleMsg(obj, d.data);
    }
    else if(d.type==='no_publishers'){
      const el=document.getElementById('mon-msgs');
      if(el && MON.msgs.length===0)
        el.innerHTML='<div class="mon-placeholder"><div class="icon">⚠️</div>' +
          '<div>ไม่พบ publisher บน <code>'+escH(MON.selected)+'</code></div></div>';
    }
    else if(d.type==='closed'){
      monSetSubActive(false);
    }
    else if(d.type==='error'){
      sbMsg('Monitor error: '+d.message,3000);
      monSetSubActive(false);
    }
  };

  MON.subWs.onerror = () => {
    sbMsg('ไม่สามารถเปิด /ws/monitor ได้',3000);
    monSetSubActive(false);
  };

  MON.subWs.onclose = () => {
    if(MON.subActive) monSetSubActive(false);
  };
}

function monStartPolling(){
  // Legacy fallback
  monStartSub();
}

function monStopSub(){
  MON.subActive = false;
  if(MON.subWs){ try{MON.subWs.close();}catch(e){} MON.subWs=null; }
  if(MON.graphTimer){ clearInterval(MON.graphTimer); MON.graphTimer=null; }
  if(MON._hzTimer)  { clearInterval(MON._hzTimer);  MON._hzTimer=null;  }
  monSetSubActive(false);
}

function monSetSubActive(active){
  MON.subActive = active;
  const btn = document.getElementById('btn-sub-toggle');
  if(btn){
    btn.disabled = false;
    btn.textContent = active ? '⏹ Unsubscribe' : '▶ Subscribe';
    btn.className   = active ? 'btn btn-r' : 'btn';
  }
  const hzBadge = document.getElementById('mon-hz-live');
  if(hzBadge){
    if(!active){ hzBadge.textContent='— Hz'; hzBadge.className='mon-tag mon-tag-hz'; }
    else        { hzBadge.className='mon-tag mon-tag-pub'; } // green tint when active
  }
  // Reset Hz counters on new subscription
  if(active){ monHzCount=0; monHzLast=Date.now(); }
}

// ══ Handle incoming message ══
function monHandleMsg(msg, rawText){
  const ts = new Date().toLocaleTimeString('th',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:2});

  // Hz calculation
  monHzCount++;
  const now = Date.now();
  const elapsed = now - monHzLast;
  if(elapsed >= 1000){
    const hz = (monHzCount * 1000 / elapsed);
    const hzStr = hz.toFixed(hz < 1 ? 2 : 1) + ' Hz';
    const hzBadge = document.getElementById('mon-hz-live');
    if(hzBadge) hzBadge.textContent = hzStr;
    const t = MON.topics.find(x=>x.name===MON.selected);
    if(t){ t.hz = hz; }
    const rows = document.querySelectorAll('.mon-row.active .mon-rhz');
    rows.forEach(el=>{ el.textContent=hzStr; el.className='mon-rhz live'; });
    const dots = document.querySelectorAll('.mon-row.active .mon-dot');
    dots.forEach(d=>{ d.className='mon-dot live'; });
    monHzCount=0; monHzLast=now;
  }

  // Buffer messages
  MON.msgs.unshift({ts, msg, raw:rawText});
  if(MON.msgs.length>MON.MAX_MSGS) MON.msgs.length=MON.MAX_MSGS;

  // Only update DOM if on msg tab & visible (Throttled for performance)
  if(MON.detTab==='msg' && document.getElementById('page-monitor').classList.contains('show')){
    if(!_monRenderTimer){
      _monRenderTimer = requestAnimationFrame(()=>{
        monRenderMsgs();
        _monRenderTimer = null;
      });
    }
  }

  // Graph data
  if(MON.graphField){
    const val = monGetFieldValue(msg, MON.graphField);
    if(val!==null && !isNaN(val)){
      if(!MON.graphData[MON.graphField]) MON.graphData[MON.graphField]=[];
      MON.graphData[MON.graphField].push({t:now, v:parseFloat(val)});
      
      // Trim old data efficiently
      const win = parseInt(document.getElementById('mon-graph-window')?.value||60)*1000;
      while(MON.graphData[MON.graphField].length > 0 && now - MON.graphData[MON.graphField][0].t > win + 1000) {
          MON.graphData[MON.graphField].shift();
      }

      if(MON.detTab==='graph') {
         if(!_graphRenderTimer){
            _graphRenderTimer = requestAnimationFrame(()=>{
               monGraphRedraw();
               _graphRenderTimer = null;
            });
         }
      }
    }
  }

  // Update field selector on first message
  if(MON.msgs.length===1 && msg) monBuildFieldSelector(msg);
}

// ══ Render messages ══
function monRenderMsgs(){
  const el = document.getElementById('mon-msgs');
  if(!el) return;
  if(MON.msgs.length===0){
    el.innerHTML='<div class="mon-placeholder"><div class="icon">⏳</div><div>กำลังรอ message...</div></div>';
    return;
  }
  el.innerHTML = MON.msgs.slice(0,50).map((m,i)=>`
    <div class="msg-block">
      <div class="msg-ts">${m.ts}${i===0?' <span style="color:var(--acc);font-size:10px">← latest</span>':''}</div>
      <div style="font-family:var(--mono);font-size:11px;line-height:1.7">${monFormatObj(m.msg, 0)}</div>
    </div>`).join('');
  el.scrollTop=0;
}

function monFormatObj(obj, depth){
  if(obj===null||obj===undefined) return '<span class="msg-sep">null</span>';
  if(typeof obj==='number') return `<span class="msg-val">${obj}</span>`;
  if(typeof obj==='string') return `<span class="msg-str">"${escH(obj)}"</span>`;
  if(typeof obj==='boolean') return `<span class="msg-val">${obj}</span>`;
  if(Array.isArray(obj)){
    if(obj.length===0) return '<span class="msg-sep">[]</span>';
    if(obj.length>4) return `<span class="msg-sep">[${obj.length} items]</span>`;
    return '['+obj.map(v=>monFormatObj(v,depth+1)).join(', ')+']';
  }
  if(typeof obj==='object' && depth<4){
    return Object.entries(obj).map(([k,v])=>`
      <div style="padding-left:${(depth+1)*12}px"><span class="msg-key">${escH(k)}</span>: ${monFormatObj(v,depth+1)}</div>`
    ).join('');
  }
  return `<span class="msg-sep">${escH(String(obj))}</span>`;
}

function monClearMsgs(){
  MON.msgs=[];
  document.getElementById('mon-msgs').innerHTML=
    '<div class="mon-placeholder"><div class="icon">💬</div><div>Messages cleared</div></div>';
}

// ══ Get nested field value ══
function monGetFieldValue(obj, path){
  try{
    const parts=path.split('.');
    let cur=obj;
    for(const p of parts){ if(cur===null||typeof cur!=='object') return null; cur=cur[p]; }
    return typeof cur==='number'?cur:null;
  }catch(e){ return null; }
}

// ══ Build field selector for graph ══
function monBuildFieldSelector(msg, prefix=''){
  const sel = document.getElementById('mon-graph-field');
  if(!sel) return;
  const fields=[];
  function walk(obj, pre){
    if(typeof obj==='number') fields.push(pre);
    else if(typeof obj==='object'&&obj!==null&&Object.keys(obj).length<20){
      Object.entries(obj).forEach(([k,v])=>walk(v,pre?pre+'.'+k:k));
    }
  }
  walk(msg,'');
  if(fields.length===0) return;
  sel.innerHTML='<option value="">— เลือก field ที่ต้องการ plot —</option>'+
    fields.map(f=>`<option value="${escH(f)}"${f===MON.graphField?' selected':''}>${escH(f)}</option>`).join('');
}

// ══ Graph ══
function monGraphField(){
  MON.graphField = document.getElementById('mon-graph-field')?.value||'';
  MON.graphData  = {};
  monGraphRedraw();
}

function monGraphClear(){ MON.graphData={}; monGraphRedraw(); }

function monGraphRedraw(){
  const canvas = document.getElementById('mon-chart');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('mon-canvas-wrap');
  const W = canvas.width  = wrap.offsetWidth;
  const H = canvas.height = Math.max(160, wrap.offsetHeight - 30);

  // Background
  const isDark = document.documentElement.getAttribute('data-theme')!=='light';
  ctx.fillStyle = isDark?'#0d0f14':'#f8f7f2';
  ctx.fillRect(0,0,W,H);

  const data = MON.graphData[MON.graphField]||[];
  if(data.length<2){
    ctx.fillStyle = isDark?'#3d4261':'#b0b3c4';
    ctx.font = '12px JetBrains Mono,monospace';
    ctx.textAlign='center';
    ctx.fillText(MON.graphField?'รอข้อมูล...':'เลือก field ก่อน', W/2, H/2);
    return;
  }

  const minV = Math.min(...data.map(p=>p.v));
  const maxV = Math.max(...data.map(p=>p.v));
  const rangeV = maxV-minV||1;

  const pad={t:20,r:20,b:28,l:54};
  const gW=W-pad.l-pad.r, gH=H-pad.t-pad.b;

  // Grid lines
  const gridColor = isDark?'rgba(255,255,255,0.05)':'rgba(0,0,0,0.06)';
  ctx.strokeStyle=gridColor; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const y=pad.t+gH*i/4;
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke();
    // Y label
    const val=(maxV-rangeV*i/4).toFixed(3);
    ctx.fillStyle=isDark?'#3d4261':'#a0a3b4';
    ctx.font='10px JetBrains Mono,monospace';ctx.textAlign='right';
    ctx.fillText(val,pad.l-4,y+4);
  }

  // X axis time labels
  ctx.fillStyle=isDark?'#3d4261':'#a0a3b4';
  ctx.font='10px JetBrains Mono,monospace';ctx.textAlign='center';
  for(let i=0;i<=4;i++){
    const t = data[0].t + (data[data.length-1].t-data[0].t)*i/4;
    const x = pad.l + gW*i/4;
    const d = new Date(t);
    ctx.fillText(`${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`,x,H-pad.b+14);
  }

  // Plot line
  const colors=['#4f8ef7','#3ecf8e','#f5a623','#9f7aea','#f06767'];
  const color = colors[0];
  ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';
  data.forEach((p,i)=>{
    const x=pad.l+gW*(p.t-data[0].t)/(data[data.length-1].t-data[0].t||1);
    const y=pad.t+gH*(1-(p.v-minV)/rangeV);
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  ctx.stroke();

  // Fill under line
  ctx.lineTo(pad.l+gW,pad.t+gH);ctx.lineTo(pad.l,pad.t+gH);ctx.closePath();
  ctx.fillStyle=isDark?'rgba(79,142,247,0.08)':'rgba(26,110,245,0.07)';
  ctx.fill();

  // Current value dot
  const last=data[data.length-1];
  const lx=pad.l+gW*(last.t-data[0].t)/(data[data.length-1].t-data[0].t||1);
  const ly=pad.t+gH*(1-(last.v-minV)/rangeV);
  ctx.beginPath();ctx.arc(lx,ly,4,0,Math.PI*2);
  ctx.fillStyle=color;ctx.fill();

  // Legend
  const leg=document.getElementById('mon-chart-legend');
  if(leg) leg.innerHTML=`<div class="chart-leg-item"><div class="chart-leg-dot" style="background:${color}"></div>${escH(MON.graphField)} = <strong>${last.v.toFixed(4)}</strong></div>`;
}

// ══ Detail tabs ══
function monDetTab(tab){
  MON.detTab=tab;
  ['msg','graph','info','pub'].forEach(t=>{
    document.getElementById('mdt-'+t)?.classList.toggle('active',t===tab);
    const el=document.getElementById('mon-tab-'+t);
    if(el) el.style.display=t===tab?'flex':'none';
  });
  if(tab==='msg') monRenderMsgs();
  if(tab==='graph') monGraphRedraw();
}

// ══ Info panel ══
async function monLoadInfo(name, type){
  const el=document.getElementById('mon-info');
  if(!el||!sessionId) return;
  el.innerHTML='<div class="mon-placeholder"><div>Loading...</div></div>';
  const src=rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
  const [infoR,hzR] = await Promise.all([
    API('/api/exec',{sessionId,command:`bash -lc "source ${src} 2>/dev/null && ros2 topic info -v ${name} 2>/dev/null"`,timeout:6000}),
    API('/api/exec',{sessionId,command:`bash -lc "source ${src} 2>/dev/null && timeout 1.5 ros2 topic hz ${name} 2>/dev/null | grep -m1 average | awk '{print \\$3}'"`,timeout:4000}),
  ]);
  const raw=infoR.stdout||'';
  // Parse publishers/subscribers count
  const pubMatch=raw.match(/Publisher count:\s*(\d+)/);
  const subMatch=raw.match(/Subscription count:\s*(\d+)/);
  const pubList=(raw.match(/Node name:[\s\S]*?(?=Node name:|$)/g)||[]).slice(0,10);

  el.innerHTML=`
  <div class="info-section">
    <div class="info-sec-title">Topic Info</div>
    <div class="info-row"><div class="info-key">Name</div><div class="info-val">${escH(name)}</div></div>
    <div class="info-row"><div class="info-key">Type</div><div class="info-val">${escH(type)}</div></div>
    <div class="info-row"><div class="info-key">Hz (sampled)</div><div class="info-val">${hzR.stdout||'—'} Hz</div></div>
    <div class="info-row"><div class="info-key">Publishers</div><div class="info-val">${pubMatch?pubMatch[1]:'—'}</div></div>
    <div class="info-row"><div class="info-key">Subscribers</div><div class="info-val">${subMatch?subMatch[1]:'—'}</div></div>
  </div>
  <div class="info-section">
    <div class="info-sec-title">Raw Info</div>
    <pre style="font-size:10px;line-height:1.6;color:var(--mt);white-space:pre-wrap;word-break:break-all">${escH(raw||'—')}</pre>
  </div>`;
}

// ══ Publish ══
function monBuildPubTemplate(type){
  const templates={
    'geometry_msgs/msg/Twist':'{"linear":{"x":0.0,"y":0.0,"z":0.0},"angular":{"x":0.0,"y":0.0,"z":0.0}}',
    'std_msgs/msg/String':'{"data":"hello"}',
    'std_msgs/msg/Bool':'{"data":true}',
    'std_msgs/msg/Float64':'{"data":0.0}',
    'std_msgs/msg/Int32':'{"data":0}',
    'sensor_msgs/msg/LaserScan':'{"header":{"frame_id":"laser"}}',
  };
  const tpl = templates[type] || '{}';
  const ta = document.getElementById('pub-msg-json');
  if(ta && !ta.value) ta.value = JSON.stringify(JSON.parse(tpl),null,2);
}

async function monPublish(){
  if(!sessionId||!MON.selected) return;
  const json = document.getElementById('pub-msg-json')?.value||'{}';
  const src = rosInfo?.setupBash||'/opt/ros/humble/setup.bash';
  const topic = MON.selected;
  const topicObj = MON.topics.find(t=>t.name===topic);
  const type = topicObj?.type||'std_msgs/msg/String';
  const status = document.getElementById('pub-status');

  try{
    JSON.parse(json); // validate
    if(status) status.textContent='Publishing...';
    const escaped = json.replace(/"/g,'\\"');
    const r = await API('/api/exec',{sessionId,
      command:`bash -lc "source ${src} 2>/dev/null && ros2 topic pub --once ${topic} ${type} '${escaped}' 2>&1 | tail -3"`,
      timeout:5000});
    if(status) status.textContent = r.code===0?'✓ Published!':'Error: '+r.stderr.slice(0,80);
    setTimeout(()=>{ if(status) status.textContent=''; },3000);
  }catch(e){
    if(status) status.textContent='JSON error: '+e.message;
  }
}

let pubRepeatActive=false;
function monPublishRepeat(){
  const btn=document.getElementById('btn-pub-repeat');
  if(pubRepeatActive){
    clearInterval(MON.pubRepeatTimer);MON.pubRepeatTimer=null;
    pubRepeatActive=false;
    if(btn){btn.textContent='▶ Repeat (1Hz)';btn.className='btn btn-g';}
  } else {
    pubRepeatActive=true;
    if(btn){btn.textContent='⏹ Stop';btn.className='btn btn-r';}
    MON.pubRepeatTimer=setInterval(()=>monPublish(),1000);
  }
}

// ══ Auto-refresh toggle ══
function monToggleAuto(){
  const btn=document.getElementById('btn-mon-auto');
  MON.autoRefresh=!MON.autoRefresh;
  if(MON.autoRefresh){
    monRefresh();
    MON.autoTimer=setInterval(monRefresh,10000);
    if(btn){btn.textContent='Auto ON';btn.className='btn btn-g';}
  } else {
    clearInterval(MON.autoTimer);MON.autoTimer=null;
    if(btn){btn.textContent='Auto OFF';btn.className='btn';}
  }
}
