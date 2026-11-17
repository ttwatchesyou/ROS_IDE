'use strict';
// Extends the existing real Nav2 map/connection page; only this page loads it.
let sequenceBusy=false,sequenceRunId='',sequenceSnapshot=null,sequencePlanId='',sequenceMap='',sequenceLastView='';
const sequenceEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sequenceLabels={pending:'รอ',sending:'กำลังส่ง',active:'กำลังเดิน',waiting:'รอที่จุดหมาย',succeeded:'สำเร็จ',canceled:'ยกเลิก',aborted:'ไปไม่สำเร็จ',rejected:'ถูกปฏิเสธ',server_unavailable:'Nav2 ไม่พร้อม',interrupted:'การเชื่อมต่อหลุด'};
function sequenceStorageKey(){return `roside_navigation_sequences:${localStorage.getItem('ros2ide_robotid')||'default'}`;}
function sequencePlans(){try{const value=JSON.parse(localStorage.getItem(sequenceStorageKey())||'[]');return Array.isArray(value)?value.filter(plan=>plan&&typeof plan.id==='string'&&typeof plan.map==='string'&&Array.isArray(plan.points)):[];}catch(_){return [];}}
function sequenceId(){return globalThis.crypto?.randomUUID?.()||'seq_'+Date.now()+'_'+Math.random().toString(36).slice(2);}
function sequenceValidatePoints(points){
  if(!Array.isArray(points)||points.length<1||points.length>50)throw Error('เพิ่มขั้นตอนอย่างน้อย 1 จุด และไม่เกิน 50 จุด');
  return points.map((p,i)=>{const x=Number(p.x),y=Number(p.y),yaw=Number(p.yaw??0),waitSeconds=Number(p.waitSeconds??0);if(![x,y,yaw,waitSeconds].every(Number.isFinite)||Math.abs(x)>10000||Math.abs(y)>10000||waitSeconds<0||waitSeconds>3600)throw Error(`พิกัดหรือเวลารอของขั้นตอน ${i+1} ไม่ถูกต้อง`);return{x,y,yaw,waitSeconds,name:String(p.name||`จุดที่ ${i+1}`).slice(0,80)};});
}
function sequenceLibrary(){
  const mapName=$('map-select').value,select=$('sequence-saved'),selected=select.value;
  if(sequenceMap&&mapName!==sequenceMap&&!sequenceBusy){routePoints=[];sequencePlanId='';sequenceSnapshot=null;$('sequence-name').value='';sequenceRender();}
  sequenceMap=mapName;
  select.innerHTML='<option value="">เลือกแผนการเดินทาง</option>'+sequencePlans().filter(plan=>plan.map===mapName).map(plan=>`<option value="${sequenceEscape(plan.id)}">${sequenceEscape(plan.name)} · ${plan.points.length} จุด</option>`).join('');
  if([...select.options].some(option=>option.value===(sequencePlanId||selected)))select.value=sequencePlanId||selected;
}
function sequenceProgress(){
  const snapshot=sequenceSnapshot,total=snapshot?.total||routePoints.length,completed=snapshot?.completed||0;
  $('sequence-count').textContent=`${routePoints.length} / 50 จุด`;$('sequence-progress').max=Math.max(1,total);$('sequence-progress').value=completed;$('sequence-progress-text').textContent=`${completed} / ${total} สำเร็จ`;
  const phase=snapshot?.phase;
  $('sequence-phase').textContent=phase==='waiting'?`รอ ${Math.ceil(snapshot.waitRemaining||0)} วินาที`:phase==='active'||phase==='sending'?`ขั้นตอน ${Math.min(total,(snapshot.index||0)+1)} · ${sequenceLabels[phase]}`:phase?(sequenceLabels[phase]||phase):'พร้อมสร้างแผน';
  for(const id of ['route-mode','pose-mode','sequence-add','undo-route','clear-route','sequence-load','sequence-delete','sequence-saved','sequence-name','sequence-save'])$(id).disabled=sequenceBusy;
  $('run-route').disabled=sequenceBusy||!running||!pose||!routePoints.length||socket?.readyState!==WebSocket.OPEN;
  $('cancel').disabled=!sequenceBusy;$('sequence-emergency').disabled=!sequenceBusy;
}
function sequenceRender(){
  const statuses=sequenceSnapshot?.steps||[];
  $('route-list').innerHTML=routePoints.length?routePoints.map((point,index)=>{const status=statuses[index]||'pending';return `<article class="sequence-step" data-status="${sequenceEscape(status)}"><div class="step-head"><b class="step-number">${index+1}</b><input data-sequence-index="${index}" data-sequence-field="name" aria-label="ชื่อขั้นตอน ${index+1}" maxlength="80" value="${sequenceEscape(point.name||`จุดที่ ${index+1}`)}" ${sequenceBusy?'disabled':''}><span class="step-status">${sequenceLabels[status]||status}</span></div><div class="step-fields">${[['x','X (m)',point.x],['y','Y (m)',point.y],['yaw','ทิศ (°)',(Number(point.yaw)||0)*180/Math.PI],['waitSeconds','รอ (วินาที)',point.waitSeconds||0]].map(([field,label,value])=>`<label>${label}<input type="number" step="${field==='waitSeconds'?'1':'.01'}" ${field==='waitSeconds'?'min="0" max="3600"':''} data-sequence-index="${index}" data-sequence-field="${field}" aria-label="${label} ขั้นตอน ${index+1}" value="${Number(value).toFixed(field==='waitSeconds'?0:2)}" ${sequenceBusy?'disabled':''}></label>`).join('')}</div><div class="step-actions"><button data-sequence-action="up" data-sequence-index="${index}" ${sequenceBusy||index===0?'disabled':''}>↑ เลื่อนขึ้น</button><button data-sequence-action="down" data-sequence-index="${index}" ${sequenceBusy||index===routePoints.length-1?'disabled':''}>↓ เลื่อนลง</button><button data-sequence-action="remove" data-sequence-index="${index}" ${sequenceBusy?'disabled':''}>ลบจุด</button></div></article>`;}).join(''):'ยังไม่มีขั้นตอน · เพิ่มจุดบนแผนที่หรือกรอกพิกัดเอง';
  $('goal-position').textContent=`${routePoints.length} จุดตามลำดับ`;sequenceProgress();requestDraw();
}
function sequenceEdit(action,index){
  if(sequenceBusy)return;
  sequenceSnapshot=null;
  if(action==='remove')routePoints.splice(index,1);
  if(action==='up'&&index>0)[routePoints[index-1],routePoints[index]]=[routePoints[index],routePoints[index-1]];
  if(action==='down'&&index<routePoints.length-1)[routePoints[index+1],routePoints[index]]=[routePoints[index],routePoints[index+1]];
  sequenceRender();
}
function sequenceAdd(point={x:pose?.x||0,y:pose?.y||0}){
  if(sequenceBusy||routePoints.length>=50)return;
  sequenceSnapshot=null;routePoints.push({...point,yaw:Number(point.yaw)||0,waitSeconds:0,name:`จุดที่ ${routePoints.length+1}`});sequenceRender();
}
function sequenceStart(){
  if(sequenceBusy||!running||socket?.readyState!==WebSocket.OPEN)return;
  if(!pose||Date.now()-lastPose>3000){$('goal-info').textContent='ตั้งตำแหน่งเริ่มและรอ Localization สดก่อนเริ่มลำดับ';return;}
  try{
    const points=sequenceValidatePoints(routePoints);sequenceRunId=sequenceId();sequenceBusy=true;sequenceLastView='';sequenceSnapshot={runId:sequenceRunId,total:points.length,completed:0,index:0,phase:'sending',steps:points.map(()=> 'pending')};
    socket.send(JSON.stringify({type:'sequence',runId:sequenceRunId,points}));goal=points[0];pathData=[];navStartedAt=Date.now();navPhase='sending';pickMode='';
    $('goal-info').textContent=`เริ่ม ${points.length} ขั้นตอน · ถึงจุดปัจจุบันก่อนจึงไปจุดถัดไป`;log(`เริ่มลำดับ ${points.length} ขั้นตอน`);sequenceRender();
  }catch(error){$('goal-info').textContent=error.message;}
}
function sequenceCancel(){if(!sequenceBusy)return;send('CANCEL');$('goal-info').textContent='ส่งคำสั่งหยุดลำดับแล้ว · กำลังรอยืนยันจาก Nav2';$('cancel').disabled=true;}
function sequenceSave(){
  if(sequenceBusy)return;
  try{const name=$('sequence-name').value.trim(),map=$('map-select').value;if(!name||!map)throw Error('เลือก Saved Map และตั้งชื่อแผนก่อนบันทึก');const points=sequenceValidatePoints(routePoints),plans=sequencePlans();if(!sequencePlanId)sequencePlanId=sequenceId();const plan={id:sequencePlanId,name,map,points},index=plans.findIndex(item=>item.id===sequencePlanId);if(index>=0)plans[index]=plan;else plans.push(plan);localStorage.setItem(sequenceStorageKey(),JSON.stringify(plans));sequenceLibrary();$('goal-info').textContent=`บันทึก “${name}” ในเบราว์เซอร์นี้แล้ว`;}
  catch(error){$('goal-info').textContent=error.message;}
}
function sequenceLoad(){
  if(sequenceBusy)return;
  const plan=sequencePlans().find(item=>item.id===$('sequence-saved').value&&item.map===$('map-select').value);if(!plan)return;
  try{routePoints=sequenceValidatePoints(plan.points);sequencePlanId=plan.id;sequenceSnapshot=null;$('sequence-name').value=plan.name;sequenceRender();$('goal-info').textContent='โหลดแผนแล้ว · ตรวจจุดและตั้ง START ก่อนกดเริ่ม';}catch(error){$('goal-info').textContent=error.message;}
}
const sequenceBaseFrame=frame;
frame=function(data){
  sequenceBaseFrame(data);
  if(data.event==='sequence_error'){sequenceBusy=false;sequenceSnapshot={...(sequenceSnapshot||{}),phase:'rejected',error:data.message};$('goal-info').textContent=data.message;sequenceRender();return;}
  const next=data.sequence;
  if(next&&next.runId===sequenceRunId){sequenceSnapshot=next;sequenceBusy=['sending','active','waiting'].includes(next.phase);const view=JSON.stringify({...next,waitRemaining:Math.ceil(next.waitRemaining||0)});if(view!==sequenceLastView){sequenceLastView=view;sequenceRender();}if(next.error)$('goal-info').textContent=next.error;else if(next.phase==='succeeded')$('goal-info').textContent='เดินครบทุกขั้นตอนแล้ว';else if(['aborted','rejected','server_unavailable'].includes(next.phase))$('goal-info').textContent=`หยุดที่ขั้นตอน ${next.index+1} · ${sequenceLabels[next.phase]}`;if(sequenceBusy&&next.index<routePoints.length)goal=routePoints[next.index];}
  sequenceProgress();
};
const sequenceBaseRuntime=runtime;
runtime=function(on,label){sequenceBaseRuntime(on,label);if(!on&&sequenceBusy){sequenceBusy=false;sequenceSnapshot={...(sequenceSnapshot||{}),phase:'interrupted'};sequenceRender();}else sequenceProgress();};
const sequenceBaseRefresh=refresh;
refresh=async function(){await sequenceBaseRefresh();sequenceLibrary();sequenceProgress();};
renderRoute=sequenceRender;runRoute=sequenceStart;
$('run-route').onclick=sequenceStart;$('cancel').onclick=sequenceCancel;$('sequence-emergency').onclick=sequenceCancel;$('sequence-save').onclick=sequenceSave;$('sequence-load').onclick=sequenceLoad;$('sequence-add').onclick=()=>sequenceAdd();
$('sequence-delete').onclick=()=>{if(sequenceBusy)return;const id=$('sequence-saved').value;if(!id)return;localStorage.setItem(sequenceStorageKey(),JSON.stringify(sequencePlans().filter(item=>item.id!==id)));if(sequencePlanId===id)sequencePlanId='';sequenceLibrary();};
$('route-list').addEventListener('click',event=>{const button=event.target.closest('[data-sequence-action]');if(button)sequenceEdit(button.dataset.sequenceAction,Number(button.dataset.sequenceIndex));});
$('route-list').addEventListener('change',event=>{const input=event.target,index=Number(input.dataset.sequenceIndex),field=input.dataset.sequenceField;if(sequenceBusy||!routePoints[index]||!field)return;sequenceSnapshot=null;const value=field==='name'?input.value:Number(input.value);routePoints[index][field]=field==='yaw'?value*Math.PI/180:value;sequenceProgress();requestDraw();});
$('map-select').addEventListener('change',()=>{if(sequenceBusy)return;if(sequenceMap!==$('map-select').value){sequenceMap=$('map-select').value;routePoints=[];sequencePlanId='';sequenceSnapshot=null;$('sequence-name').value='';sequenceRender();}sequenceLibrary();});
const sequenceBasePointerDown=pointerDown;
$('nav-canvas').onpointerdown=function(event){if(sequenceBusy)return;if(pickMode==='route'&&mapData){if(event.button>0)return;const point=canvasPoint(event);if(point){event.preventDefault();sequenceAdd(point);}return;}sequenceBasePointerDown(event);};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&sequenceBusy){event.preventDefault();sequenceCancel();}});
sequenceLibrary();sequenceRender();
