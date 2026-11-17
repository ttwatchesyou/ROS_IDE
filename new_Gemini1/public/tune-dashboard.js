'use strict';

// A signal is identified by its position in a numeric controller frame, not
// by the robot's wheel template. New numeric frame kinds appear automatically.
const TUNE_DASHBOARD_COLORS=['#6285ff','#13b9d6','#a475ff','#19bd87','#eea640','#e95479','#11aaab','#d7bd38'];
const TUNE_DASHBOARD_STYLES=new Set(['line','points','bars','map']);
const TUNE_DASHBOARD_SIZES={small:190,normal:290,large:420};
const TUNE_DASHBOARD_LIMIT=12000;
const TUNE_DASHBOARD_MAX_CHARTS=8;
const TUNE_DASHBOARD_MAX_SIGNALS=6;
const tuneDashboardEscape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const tuneDashboardClamp=(value,min,max)=>Math.min(max,Math.max(min,value));

function tuneSignalDescriptors(kind,values){
  const name=String(kind||'').toUpperCase();
  if(!/^[A-Z][A-Z0-9_]{0,23}$/.test(name)||!Array.isArray(values)||!values.length||values.length>32)return [];
  if(values.some(value=>!Number.isFinite(Number(value))))return [];
  return values.map((_,index)=>{
    let label=`${name} · ค่า ${index+1}`,unit='';
    if(name==='RPM'&&values.length%2===0){label=`RPM ${Math.floor(index/2)+1} · ${index%2?'วัดจริง':'เป้าหมาย'}`;unit='rpm';}
    else if(name==='ENC'&&values.length===3){label=['FR · ticks','RL · ticks','PA0–PA7 · ระดับไฟ (0–255)'][index];}
    else if((name==='GYRO'||name==='IMU')&&values.length===3){label=`${name} · ${['X','Y','Z'][index]}`;unit='°/s';}
    else if(name==='ODOM'&&values.length===6){label=`ODOM · ${['X','Y','Yaw','Vx','Vy','Wz'][index]}`;unit=['m','m','°','m/s','m/s','rad/s'][index];}
    else if(name==='TRAVEL'&&values.length===1){label='ระยะทางสะสม';unit='m';}
    else if(name==='TURN'&&values.length===1){label='มุมหมุนสะสม';unit='°';}
    else if(name==='PID'&&values.length%3===0){label=`PID ${Math.floor(index/3)+1} · ${['Kp','Ki','Kd'][index%3]}`;}
    return{key:`${name}.${index}`,kind:name,index,label,unit};
  });
}

class TuneDashboardModel{
  constructor(storage,key){
    this.storage=storage;this.key=key;this.catalog=new Map();this.points=new Map();this.latest=0;this.nextId=1;this.pose=null;this.path=[];
    this.charts=this.load();
  }
  load(){
    let saved;try{saved=JSON.parse(this.storage?.getItem(this.key)||'null');}catch{}
    this.columns=saved?.columns===2?2:1;
    const raw=saved?.version===1&&Array.isArray(saved.charts)?saved.charts:[];
    const charts=raw.slice(0,TUNE_DASHBOARD_MAX_CHARTS).filter(item=>item&&typeof item==='object').map(item=>({
      id:`c${this.nextId++}`,signals:Array.isArray(item.signals)?[...new Set(item.signals.filter(key=>/^[A-Z][A-Z0-9_]{0,23}\.[0-9]{1,2}$/.test(key)))].slice(0,TUNE_DASHBOARD_MAX_SIGNALS):[],
      style:TUNE_DASHBOARD_STYLES.has(item.style)?item.style:'line',size:Object.prototype.hasOwnProperty.call(TUNE_DASHBOARD_SIZES,item.size)?item.size:'normal',
      windowMs:tuneDashboardClamp(Number(item.windowMs)||30000,1000,180000),offsetMs:0,mapScale:1,mapPanX:0,mapPanY:0,autoPick:false
    }));
    return charts.length?charts:[this.newChart(true)];
  }
  newChart(autoPick=false){return{id:`c${this.nextId++}`,signals:[],style:'line',size:'normal',windowMs:30000,offsetMs:0,mapScale:1,mapPanX:0,mapPanY:0,autoPick};}
  save(){try{this.storage?.setItem(this.key,JSON.stringify({version:1,columns:this.columns,charts:this.charts.map(({signals,style,size,windowMs})=>({signals,style,size,windowMs}))}));}catch{}}
  chart(id){return this.charts.find(item=>item.id===id);}
  addChart(){if(this.charts.length>=TUNE_DASHBOARD_MAX_CHARTS)return null;const chart=this.newChart();this.charts.push(chart);this.save();return chart;}
  presetPose(){const first=this.charts[0];if(!first?.autoPick||first.signals.length)return false;first.signals=['ODOM.0','ODOM.1','ODOM.2'];first.autoPick=false;this.save();return true;}
  removeChart(id){const index=this.charts.findIndex(chart=>chart.id===id);if(index<0)return false;this.charts.splice(index,1);this.save();return true;}
  moveChart(from,to){const a=this.charts.findIndex(chart=>chart.id===from),b=this.charts.findIndex(chart=>chart.id===to);if(a<0||b<0||a===b)return false;this.charts.splice(b,0,this.charts.splice(a,1)[0]);this.save();return true;}
  addSignal(id,key){const chart=this.chart(id);if(!chart||!this.catalog.has(key)||chart.signals.includes(key)||chart.signals.length>=TUNE_DASHBOARD_MAX_SIGNALS)return false;chart.signals.push(key);chart.autoPick=false;this.save();return true;}
  removeSignal(id,key){const chart=this.chart(id);if(!chart||!chart.signals.includes(key))return false;chart.signals=chart.signals.filter(value=>value!==key);chart.autoPick=false;this.save();return true;}
  setStyle(id,style){const chart=this.chart(id);if(!chart||!TUNE_DASHBOARD_STYLES.has(style))return false;chart.style=style;this.save();return true;}
  setSize(id,size){const chart=this.chart(id);if(!chart||!Object.prototype.hasOwnProperty.call(TUNE_DASHBOARD_SIZES,size))return false;chart.size=size;this.save();return true;}
  setColumns(columns){if(columns!==1&&columns!==2)return false;this.columns=columns;this.save();return true;}
  earliest(){let earliest=Infinity;for(const points of this.points.values())if(points.length)earliest=Math.min(earliest,points[0].t);return Number.isFinite(earliest)?earliest:this.latest;}
  maxOffset(chart){return Math.max(0,this.latest-this.earliest()-chart.windowMs);}
  pan(id,pixels,width){const chart=this.chart(id);if(!chart||!Number.isFinite(pixels)||!(width>0))return false;chart.offsetMs=tuneDashboardClamp(chart.offsetMs+pixels/width*chart.windowMs,0,this.maxOffset(chart));return true;}
  zoom(id,factor,focus=.5){const chart=this.chart(id);if(!chart||!Number.isFinite(factor)||factor<=0)return false;const old=chart.windowMs,next=tuneDashboardClamp(old*factor,1000,180000),f=tuneDashboardClamp(focus,0,1);chart.windowMs=next;chart.offsetMs=tuneDashboardClamp(chart.offsetMs+(1-f)*(old-next),0,this.maxOffset(chart));this.save();return true;}
  follow(id){const chart=this.chart(id);if(!chart)return false;chart.offsetMs=0;return true;}
  mapZoom(id,factor){const chart=this.chart(id);if(!chart||chart.style!=='map')return false;chart.mapScale=tuneDashboardClamp(chart.mapScale*factor,.25,20);return true;}
  mapPan(id,dx,dy){const chart=this.chart(id);if(!chart||chart.style!=='map')return false;chart.mapPanX+=dx;chart.mapPanY+=dy;return true;}
  mapReset(id){const chart=this.chart(id);if(!chart||chart.style!=='map')return false;chart.mapScale=1;chart.mapPanX=chart.mapPanY=0;return true;}
  range(id){const chart=this.chart(id);if(!chart)return null;const end=(this.latest||Date.now())-chart.offsetMs;return{start:end-chart.windowMs,end};}
  ingest(frame){
    const descriptors=tuneSignalDescriptors(frame?.kind,frame?.values);
    if(!descriptors.length)return false;
    const at=Number(frame.receivedAt)||Date.now();if(!Number.isFinite(at))return false;
    if(frame.kind==='ODOM'&&frame.values.length===6){
      const [x,y,yaw]=frame.values.map(Number),previous=this.pose;
      const step=previous?Math.hypot(x-previous.x,y-previous.y):0;
      // A pose reset or corrupt jump starts a new path, not a long travelled segment.
      const elapsed=previous?Math.max(.02,(at-previous.t)/1000):0;
      const reset=previous&&step>Math.max(.08,4*elapsed+.02);
      if(reset)this.path=[];
      const distance=(reset?0:previous?.distance||0)+(!reset&&step>.0005?step:0);
      const yawStep=previous?Math.atan2(Math.sin(yaw-previous.yawRad),Math.cos(yaw-previous.yawRad)):0;
      const turnDeg=(reset?0:previous?.turnDeg||0)+(reset?0:Math.abs(yawStep)*180/Math.PI);
      this.pose={x,y,yawRad:yaw,yawDeg:yaw*180/Math.PI,distance,turnDeg,t:at};
      this.path.push({x,y,yaw,t:at});if(this.path.length>TUNE_DASHBOARD_LIMIT)this.path.shift();
    }
    this.latest=Math.max(this.latest,at);
    let catalogChanged=false;
    for(const descriptor of descriptors){
      if(!this.catalog.has(descriptor.key)){this.catalog.set(descriptor.key,descriptor);catalogChanged=true;}
      let points=this.points.get(descriptor.key);if(!points){points=[];this.points.set(descriptor.key,points);}
      points.push({t:at,v:descriptor.key==='ODOM.2'?Number(frame.values[2])*180/Math.PI:Number(frame.values[descriptor.index])});
      if(points.length>TUNE_DASHBOARD_LIMIT)points.splice(0,points.length-TUNE_DASHBOARD_LIMIT);
    }
    if(this.pose&&frame.kind==='ODOM'){
      for(const [kind,value] of [['TRAVEL',this.pose.distance],['TURN',this.pose.turnDeg]]){
        const descriptor=tuneSignalDescriptors(kind,[value])[0];
        if(!this.catalog.has(descriptor.key)){this.catalog.set(descriptor.key,descriptor);catalogChanged=true;}
        const points=this.points.get(descriptor.key)||[];points.push({t:at,v:value});
        if(points.length>TUNE_DASHBOARD_LIMIT)points.shift();this.points.set(descriptor.key,points);
      }
    }
    const first=this.charts[0];if(first?.autoPick&&!first.signals.length){first.signals=descriptors.slice(0,2).map(item=>item.key);first.autoPick=false;this.save();catalogChanged=true;}
    for(const chart of this.charts)chart.offsetMs=Math.min(chart.offsetMs,this.maxOffset(chart));
    return catalogChanged;
  }
  clearData(){this.points.clear();this.latest=0;this.pose=null;this.path=[];for(const chart of this.charts){chart.offsetMs=0;chart.mapScale=1;chart.mapPanX=chart.mapPanY=0;}}
}

function createTuneDashboard({root,addButton,columnsSelect,storage,robotId,win=window}){
  const model=new TuneDashboardModel(storage,`roside_tune_dashboard_${robotId||'default'}`);
  let dragId='',pointer=null,drawPending=false,lastDraw=0,cursor=null;
  const catalog=()=>[...model.catalog.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.index-b.index);
  function signalOptions(chart){
    const known=catalog(),missing=chart.signals.filter(key=>!model.catalog.has(key)).map(key=>({key,label:`${key} · รอข้อมูล`}));
    return '<option value="">เลือกข้อมูลที่จะแสดง…</option>'+[...missing,...known].filter(item=>!chart.signals.includes(item.key)||!model.catalog.has(item.key)).map(item=>`<option value="${tuneDashboardEscape(item.key)}">${tuneDashboardEscape(item.label)}</option>`).join('');
  }
  function render(){
    addButton.disabled=model.charts.length>=TUNE_DASHBOARD_MAX_CHARTS;
    root.classList.toggle('columns-2',model.columns===2);
    if(columnsSelect)columnsSelect.value=String(model.columns);
    root.innerHTML=model.charts.length?model.charts.map((chart,index)=>`<article class="td-chart card" data-chart="${chart.id}">
      <div class="td-head"><span class="td-drag" draggable="true" data-drag="${chart.id}" title="ลากเพื่อย้ายกราฟ">☰</span><div class="td-title"><strong>กราฟ ${index+1}</strong><small class="td-range" data-range="${chart.id}">รอข้อมูล</small></div><button class="btn td-icon" data-action="remove-chart" data-chart="${chart.id}" aria-label="ลบกราฟ">✕</button></div>
      <div class="td-tools"><label ${chart.style==='map'?'hidden':''}>ข้อมูล<select data-action="add-signal" data-chart="${chart.id}">${signalOptions(chart)}</select></label><label>รูปแบบ<select data-action="style" data-chart="${chart.id}"><option value="line" ${chart.style==='line'?'selected':''}>เส้น</option><option value="points" ${chart.style==='points'?'selected':''}>จุด</option><option value="bars" ${chart.style==='bars'?'selected':''}>แท่ง</option><option value="map" ${chart.style==='map'?'selected':''}>แผนที่ X/Y</option></select></label><label>ขนาด<select data-action="size" data-chart="${chart.id}"><option value="small" ${chart.size==='small'?'selected':''}>เล็ก</option><option value="normal" ${chart.size==='normal'?'selected':''}>กลาง</option><option value="large" ${chart.size==='large'?'selected':''}>ใหญ่</option></select></label><div class="td-zoom"><button class="btn" data-action="zoom-in" data-chart="${chart.id}" title="ซูมเข้า">＋</button><button class="btn" data-action="zoom-out" data-chart="${chart.id}" title="ซูมออก">－</button><button class="btn" data-action="follow" data-chart="${chart.id}" title="กลับสู่ข้อมูลล่าสุด">${chart.style==='map'?'พอดีจอ':'ล่าสุด'}</button></div></div>
      <div class="td-chips">${chart.style==='map'?'<span class="td-empty">เส้นทางจาก ODOM X/Y · หัวลูกศรแสดง Yaw</span>':chart.signals.length?chart.signals.map((key,i)=>`<span class="td-chip" style="--signal-color:${TUNE_DASHBOARD_COLORS[i%TUNE_DASHBOARD_COLORS.length]}">${tuneDashboardEscape(model.catalog.get(key)?.label||key)} <b data-value="${chart.id}:${tuneDashboardEscape(key)}">—</b><button data-action="remove-signal" data-chart="${chart.id}" data-signal="${tuneDashboardEscape(key)}" aria-label="ลบข้อมูล">×</button></span>`).join(''):'<span class="td-empty">เลือกข้อมูลจาก combobox เพื่อเริ่มดูกราฟ</span>'}</div>
      <canvas class="td-canvas" data-canvas="${chart.id}" style="height:${TUNE_DASHBOARD_SIZES[chart.size]}px" aria-label="${chart.style==='map'?'แผนที่เส้นทาง ODOM X Y':'กราฟข้อมูล Controller'}"></canvas><div class="td-hint">${chart.style==='map'?'ลากแผนที่เพื่อเลื่อน · หมุนล้อเมาส์หรือกด ＋/－ เพื่อซูม · พอดีจอเพื่อรีเซ็ต':'ลากในกราฟเพื่อเลื่อนเวลา · หมุนล้อเมาส์หรือกด ＋/－ เพื่อซูม · ลาก ☰ เพื่อจัดลำดับ'}</div>
    </article>`).join(''):'<div class="card td-empty-board">ยังไม่มีกราฟ กด “เพิ่มกราฟ” เพื่อเริ่มเลือกข้อมูล</div>';
    requestDraw();
  }
  function drawChart(chart){
    const canvas=root.querySelector(`[data-canvas="${chart.id}"]`);if(!canvas)return;
    const rect=canvas.getBoundingClientRect(),width=Math.max(200,Math.round(rect.width)),height=TUNE_DASHBOARD_SIZES[chart.size],ratio=Math.min(win.devicePixelRatio||1,2);
    if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}
    const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
    const css=win.getComputedStyle?.(root),line=css?.getPropertyValue('--line')||'#dce3ec',fg=css?.getPropertyValue('--muted')||'#66738b';
    if(chart.style==='map'){
      const path=model.path,pad=34,usableW=width-pad*2,usableH=height-pad*2;
      ctx.fillStyle=fg;ctx.font='11px sans-serif';
      if(!path.length){ctx.textAlign='center';ctx.fillText('รอข้อมูล ODOM X/Y จากบอร์ด',width/2,height/2);ctx.textAlign='start';return;}
      const xs=path.map(point=>point.x),ys=path.map(point=>point.y);
      const minX=Math.min(0,...xs),maxX=Math.max(0,...xs),minY=Math.min(0,...ys),maxY=Math.max(0,...ys);
      const span=Math.max(maxX-minX,maxY-minY,.5),pixelsPerMeter=Math.min(usableW,usableH)/span*.8*chart.mapScale;
      const centerX=(minX+maxX)/2,centerY=(minY+maxY)/2;
      const project=point=>[width/2+(point.x-centerX)*pixelsPerMeter+chart.mapPanX,height/2-(point.y-centerY)*pixelsPerMeter+chart.mapPanY];
      ctx.strokeStyle=line;ctx.lineWidth=1;const gridStep=Math.pow(10,Math.floor(Math.log10(span/5)));
      for(let x=Math.floor(minX/gridStep)*gridStep;x<=maxX+gridStep;x+=gridStep){const [px]=project({x,y:0});ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,height);ctx.stroke();}
      for(let y=Math.floor(minY/gridStep)*gridStep;y<=maxY+gridStep;y+=gridStep){const [,py]=project({x:0,y});ctx.beginPath();ctx.moveTo(0,py);ctx.lineTo(width,py);ctx.stroke();}
      ctx.strokeStyle='#19bd87';ctx.lineWidth=2.5;ctx.beginPath();path.forEach((point,index)=>{const [px,py]=project(point);if(index)ctx.lineTo(px,py);else ctx.moveTo(px,py);});ctx.stroke();
      const [sx,sy]=project(path[0]),last=path.at(-1),[px,py]=project(last);
      ctx.fillStyle='#6285ff';ctx.beginPath();ctx.arc(sx,sy,4,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.translate(px,py);ctx.rotate(-last.yaw);ctx.fillStyle='#eea640';ctx.beginPath();ctx.moveTo(12,0);ctx.lineTo(-8,-7);ctx.lineTo(-5,0);ctx.lineTo(-8,7);ctx.closePath();ctx.fill();ctx.restore();
      ctx.fillStyle=fg;ctx.fillText(`X ${last.x.toFixed(2)} m   Y ${last.y.toFixed(2)} m   Yaw ${(last.yaw*180/Math.PI).toFixed(1)}°`,8,height-8);
      const range=root.querySelector(`[data-range="${chart.id}"]`);if(range)range.textContent=`เส้นทาง ${model.pose.distance.toFixed(2)} m · ${path.length} จุด`;
      return;
    }
    const left=49,right=12,top=15,bottom=29,plotWidth=width-left-right,plotHeight=height-top-bottom,{start,end}=model.range(chart.id);
    const series=chart.signals.map((key,index)=>({key,index,points:(model.points.get(key)||[]).filter(point=>point.t>=start&&point.t<=end)}));
    let min=Infinity,max=-Infinity;for(const item of series)for(const point of item.points){if(point.v<min)min=point.v;if(point.v>max)max=point.v;}
    const hasData=Number.isFinite(min);if(!hasData){min=0;max=1;}
    const pad=Math.max((max-min)*.12,Math.abs(max)*.03,.05);min-=pad;max+=pad;
    ctx.strokeStyle=line;ctx.fillStyle=fg;ctx.font='10px sans-serif';ctx.lineWidth=1;
    for(let i=0;i<=4;i++){const y=top+i*plotHeight/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();ctx.fillText((max-(max-min)*i/4).toFixed(Math.abs(max-min)<10?2:0),3,y+3);}
    for(let i=0;i<=5;i++){const x=left+i*plotWidth/5;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+plotHeight);ctx.stroke();}
    ctx.fillText(new Date(start).toLocaleTimeString('th-TH'),left,height-8);const endLabel=new Date(end).toLocaleTimeString('th-TH');ctx.fillText(endLabel,width-right-ctx.measureText(endLabel).width,height-8);
    if(!chart.signals.length||!hasData){ctx.fillStyle=fg;ctx.textAlign='center';ctx.fillText(!chart.signals.length?'เลือกข้อมูลจาก combobox':'รอข้อมูลจากบอร์ด',width/2,height/2);ctx.textAlign='start';}
    for(const item of series){
      const points=item.points,step=Math.max(1,Math.ceil(points.length/(plotWidth*2))),color=TUNE_DASHBOARD_COLORS[item.index%TUNE_DASHBOARD_COLORS.length];ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2;ctx.beginPath();
      let started=false;for(let i=0;i<points.length;i+=step){const point=points[i],x=left+(point.t-start)/(end-start)*plotWidth,y=top+(max-point.v)/(max-min)*plotHeight;
        if(chart.style==='points'){ctx.fillRect(x-2,y-2,4,4);}
        else if(chart.style==='bars'){const zero=top+(max-tuneDashboardClamp(0,min,max))/(max-min)*plotHeight;ctx.fillRect(x-1,Math.min(y,zero),Math.max(2,plotWidth/Math.max(points.length,1)),Math.max(1,Math.abs(zero-y)));}
        else{if(started)ctx.lineTo(x,y);else{ctx.moveTo(x,y);started=true;}}
      }
      if(chart.style==='line')ctx.stroke();
      const latest=model.points.get(item.key)?.at(-1),value=root.querySelector(`[data-value="${chart.id}:${item.key}"]`);if(value)value.textContent=latest?`${latest.v.toFixed(3)} ${model.catalog.get(item.key)?.unit||''}`:'—';
    }
    if(cursor?.id===chart.id&&cursor.x>=left&&cursor.x<=width-right){ctx.strokeStyle=fg;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(cursor.x,top);ctx.lineTo(cursor.x,top+plotHeight);ctx.stroke();ctx.setLineDash([]);}
    const range=root.querySelector(`[data-range="${chart.id}"]`);if(range)range.textContent=`${(chart.windowMs/1000).toFixed(chart.windowMs<10000?1:0)} วินาที${chart.offsetMs?' · เลื่อนย้อนหลัง':' · สด'}`;
  }
  function draw(){lastDraw=Date.now();drawPending=false;for(const chart of model.charts)drawChart(chart);}
  function requestDraw(){if(drawPending)return;drawPending=true;const wait=Math.max(0,50-(Date.now()-lastDraw));win.setTimeout(()=>win.requestAnimationFrame(draw),wait);}
  root.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');if(!button)return;const id=button.dataset.chart,action=button.dataset.action;
    if(action==='remove-chart')model.removeChart(id);
    else if(action==='remove-signal')model.removeSignal(id,button.dataset.signal);
    else if(action==='zoom-in')model.chart(id)?.style==='map'?model.mapZoom(id,1.3):model.zoom(id,.7);
    else if(action==='zoom-out')model.chart(id)?.style==='map'?model.mapZoom(id,1/1.3):model.zoom(id,1/.7);
    else if(action==='follow')model.chart(id)?.style==='map'?model.mapReset(id):model.follow(id);
    if(action==='remove-chart'||action==='remove-signal')render();else requestDraw();
  });
  root.addEventListener('change',event=>{
    const select=event.target.closest('select[data-action]');if(!select)return;const id=select.dataset.chart;
    if(select.dataset.action==='add-signal'){if(model.addSignal(id,select.value))render();else select.value='';}
    else if(select.dataset.action==='style'){model.setStyle(id,select.value);render();}
    else if(select.dataset.action==='size'){model.setSize(id,select.value);render();}
  });
  root.addEventListener('dragstart',event=>{const handle=event.target.closest('[data-drag]');if(!handle)return;dragId=handle.dataset.drag;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragId);});
  root.addEventListener('dragover',event=>{if(dragId&&event.target.closest('[data-chart]'))event.preventDefault();});
  root.addEventListener('drop',event=>{const target=event.target.closest('article[data-chart]');if(!target||!dragId)return;event.preventDefault();model.moveChart(dragId,target.dataset.chart);dragId='';render();});
  root.addEventListener('dragend',()=>{dragId='';});
  root.addEventListener('pointerdown',event=>{const canvas=event.target.closest('canvas[data-canvas]');if(!canvas)return;pointer={id:canvas.dataset.canvas,x:event.clientX,y:event.clientY,width:canvas.getBoundingClientRect().width};canvas.setPointerCapture?.(event.pointerId);});
  root.addEventListener('pointermove',event=>{const canvas=event.target.closest('canvas[data-canvas]');if(!canvas)return;cursor={id:canvas.dataset.canvas,x:event.clientX-canvas.getBoundingClientRect().left};if(pointer?.id===canvas.dataset.canvas){if(model.chart(pointer.id)?.style==='map')model.mapPan(pointer.id,event.clientX-pointer.x,event.clientY-pointer.y);else model.pan(pointer.id,event.clientX-pointer.x,pointer.width);pointer.x=event.clientX;pointer.y=event.clientY;}requestDraw();});
  root.addEventListener('pointerup',()=>{pointer=null;});root.addEventListener('pointercancel',()=>{pointer=null;});
  root.addEventListener('wheel',event=>{const canvas=event.target.closest('canvas[data-canvas]');if(!canvas)return;event.preventDefault();const rect=canvas.getBoundingClientRect();if(model.chart(canvas.dataset.canvas)?.style==='map')model.mapZoom(canvas.dataset.canvas,event.deltaY>0?1/1.2:1.2);else model.zoom(canvas.dataset.canvas,event.deltaY>0?1.2:1/1.2,(event.clientX-rect.left)/rect.width);requestDraw();},{passive:false});
  addButton.addEventListener('click',()=>{if(model.addChart())render();});
  root.parentElement?.querySelector('#td-add-map')?.addEventListener('click',()=>{const chart=model.addChart();if(chart){model.setStyle(chart.id,'map');render();}});
  columnsSelect?.addEventListener('change',()=>{model.setColumns(Number(columnsSelect.value));render();});
  if(win.ResizeObserver)new win.ResizeObserver(requestDraw).observe(root);
  render();
  return{model,presetPose(){if(model.presetPose())render();},ingest(frame){const changed=model.ingest(frame);if(changed)render();else requestDraw();},clearData(){model.clearData();requestDraw();},resize:requestDraw};
}

if(typeof module!=='undefined'&&module.exports)module.exports={TuneDashboardModel,tuneSignalDescriptors,createTuneDashboard};
if(typeof window!=='undefined')window.TuneDashboard={create:createTuneDashboard};
