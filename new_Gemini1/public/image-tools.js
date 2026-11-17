'use strict';
(()=>{
const $=id=>document.getElementById(id),helper=document.documentElement.dataset.mode==='helper',fragment=new URLSearchParams(location.hash.slice(1));
const state={devices:[],cached:null,job:null,privileged:false,timer:null,polling:false,token:localStorage.getItem('roside_image_token')||''};
if(helper&&fragment.has('token')){state.token=fragment.get('token');localStorage.setItem('roside_image_token',state.token);}
if(helper&&location.hash)history.replaceState(null,'',location.pathname);
const bytes=n=>{let i=0;while(n>=1024&&i<4){n/=1024;i++;}return Number(n||0).toFixed(i?1:0)+' '+['B','KB','MB','GB','TB'][i];};
function message(t=''){$('message').textContent=t;$('message').hidden=!t;}
function next(step,t){document.querySelectorAll('[data-step]').forEach(n=>n.setAttribute('aria-current',+n.dataset.step===step?'step':'false'));$('next-action').textContent=t;}
async function guarded(fn){try{message();await fn();}catch(e){message(e.message);}}
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'X-Image-Token':state.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});const v=await r.json();if(!r.ok||!v.ok)throw Error(v.error||'ติดต่อ Helper ไม่สำเร็จ');return v;}
function target(){return state.devices.find(d=>d.id===$('target').value);}
function settings(){return {hostname:$('hostname').value,username:$('username').value,password:$('password').value,domainId:Number($('domain-id').value),ssid:$('ssid').value,wifiPassword:$('wifi-password').value,installAgent:$('install-agent').checked,cloudUrl:$('cloud-url').value};}
function refreshButtons(){const running=state.job?.state==='running',d=target(),s=settings();const valid=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s.hostname)&&/^[a-z][a-z0-9_-]{0,30}$/.test(s.username)&&s.password.length>=10&&s.password.length<=128&&Number.isInteger(s.domainId)&&s.domainId>=0&&s.domainId<=232&&(!s.ssid||s.wifiPassword.length>=8)&&(!s.installAgent||/^https:\/\//.test(s.cloudUrl));
$('flash').disabled=running||!state.privileged||!state.cached||!d||d.blocked||d.size<Math.max(30000000000,state.cached?.rawBytes||0)||!valid||$('confirm-disk').value!==d.id;
for(const id of ['download-image','scan-target','target','hostname','username','password','domain-id','ssid','wifi-password','install-agent','cloud-url','confirm-disk'])$(id).disabled=running;
$('cancel').disabled=!running;
$('image-details').textContent=state.cached?`${state.cached.file} · ดาวน์โหลด ${bytes(state.cached.fileBytes)} · ขนาดเมื่อแตก ${bytes(state.cached.rawBytes)} · SHA256 ตรวจสอบแล้ว`:'ยังไม่มี Image บนคอม · กดดาวน์โหลดก่อน Flash';
if(d){$('confirm-disk').placeholder='พิมพ์ '+d.id;$('erase-note').textContent=`จะลบข้อมูลทั้งหมดบน ${d.id} · ${d.label} · ${bytes(d.size)}${d.size<30000000000?' · ต้องใช้ SD 32 GB ขึ้นไป':''}`;}}
async function environment(){const v=await api('/api/environment');state.cached=v.cached;refreshButtons();}
async function scan(){state.devices=(await api('/api/disks')).devices;const select=$('target');select.replaceChildren();const add=(v,t,disabled=false)=>{const o=document.createElement('option');o.value=v;o.textContent=t;o.disabled=disabled;select.append(o);};add('',state.devices.length?'เลือก SD card ให้ถูกใบ':'ไม่พบ SD/USB ภายนอก');for(const d of state.devices)add(d.id,`${d.id} · ${d.label} · ${bytes(d.size)}${d.blocked?' · ห้ามใช้: '+d.reason:''}`,d.blocked);$('confirm-disk').value='';refreshButtons();next(3,'เลือก SD card ตั้งค่าบัญชี แล้วพิมพ์รหัสดิสก์เพื่อกด Flash');}
const phases={idle:'ยังไม่มีงานที่กำลังทำ',preflight:'ตรวจสอบก่อนเริ่ม',catalog:'ตรวจรุ่น Ubuntu',downloading:'ดาวน์โหลด Ubuntu จากเว็บไซต์ทางการ',checking:'ตรวจ SHA256 ของ Image',extracting:'แตก Image บนคอม',configuring:'ใส่ค่าหุ่นใหม่',writing:'เขียน SD card',verifying:'อ่าน SD กลับมาตรวจสอบ',complete:'เสร็จสมบูรณ์'};
function renderJob(job){const previous=state.job;state.job=job;
if(job.id!==previous?.id){$('new-key-panel').hidden=true;$('new-robot-key').value='';$('finish-result').textContent='รอผลการ Flash และตรวจสอบ SD';}
$('job-title').textContent=job.state==='failed'?'งานไม่สำเร็จ':job.state==='cancelled'?'ยกเลิกแล้ว':phases[job.phase]||job.phase;
const pct=job.state==='complete'?100:job.total?Math.min(100,100*job.done/job.total):0;$('progress').value=pct;$('percent').textContent=Math.floor(pct)+'%';$('bytes').textContent=bytes(job.done)+' / '+bytes(job.total);$('elapsed').textContent=job.startedAt?'ใช้เวลา '+Math.max(0,Math.floor((Date.now()/1000-job.startedAt)/60))+' นาที':'—';$('job-detail').textContent=job.error||job.result?.next||(job.state==='running'?'ทำงานบนคอมเครื่องนี้ รอให้เสร็จก่อนถอดการ์ด':'');
if(job.state==='running')next(job.operation==='environment-download'?2:3,phases[job.phase]||'กำลังทำงาน');
if(job.state==='failed'||job.state==='cancelled')message(job.error||'หยุดงานแล้ว การ์ดที่เขียนไม่ครบต้อง Flash ใหม่');
if(job.state==='complete'&&(previous?.id!==job.id||previous?.state!=='complete')){if(job.result?.kind==='download'){state.cached=job.result.image;next(3,'Image พร้อมแล้ว ตั้งค่าหุ่นใหม่และเลือก SD card');}else if(job.result?.kind==='flash'){const r=job.result;if(r.robotKey){$('new-key-panel').hidden=false;$('new-robot-key').value=r.robotKey;}$('finish-result').textContent=`Flash สำเร็จ · ${r.username}@${r.hostname}\n${r.next}`;$('password').value='';$('wifi-password').value='';next(4,'ถอด SD อย่างปลอดภัย ใส่ Pi และต่ออินเทอร์เน็ต รอจนติดตั้ง ROS เสร็จ');}}
refreshButtons();}
function schedule(){clearTimeout(state.timer);if(!document.hidden)state.timer=setTimeout(poll,state.job?.state==='running'?2000:15000);}
async function poll(){if(state.polling||document.hidden)return;state.polling=true;try{renderJob((await api('/api/status')).job);}catch(e){message(e.message);}finally{state.polling=false;schedule();}}
function osChoice(){const os=document.querySelector('input[name=os]:checked').value;$('launch-command').textContent=os==='Windows'?'powershell -NoProfile -ExecutionPolicy Bypass -File .\\Start-ImageHelper.ps1':os==='Darwin'?'sh Start-ImageHelper.command':'sh Start-ImageHelper.sh';$('launch-instruction').textContent=os==='Windows'?'เปิด PowerShell ในโฟลเดอร์ที่แตก ZIP แล้วรันคำสั่ง ยอมรับหน้าต่าง Administrator':'เปิด Terminal ในโฟลเดอร์ที่แตก ZIP แล้วรันคำสั่ง ใส่รหัสผ่าน sudo เมื่อถาม';}
  function tooltips(){
    let target=null;const box=$('tooltip');
    function hide(){box.hidden=true;if(target)target.removeAttribute('aria-describedby');target=null;}
    function show(event){const el=event.target.closest?.('[data-tip]');if(!el)return;target=el;box.textContent=el.dataset.tip;box.hidden=false;el.setAttribute('aria-describedby','tooltip');const r=el.getBoundingClientRect(),b=box.getBoundingClientRect();box.style.left=Math.max(8,Math.min(innerWidth-b.width-8,r.left))+'px';box.style.top=(r.bottom+b.height+14>innerHeight?Math.max(8,r.top-b.height-8):r.bottom+8)+'px';}
    document.querySelectorAll('[data-tip]').forEach(el=>{el.title=el.dataset.tip;});
    document.addEventListener('pointerover',show);document.addEventListener('focusin',show);document.addEventListener('pointerout',hide);document.addEventListener('focusout',hide);document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});window.addEventListener('scroll',hide,true);
  }
tooltips();
if(!helper){const platform=(navigator.userAgentData?.platform||navigator.platform||'').toLowerCase();document.querySelector(`input[name=os][value="${platform.includes('win')?'Windows':platform.includes('mac')?'Darwin':'Linux'}"]`).checked=true;osChoice();document.querySelectorAll('input[name=os]').forEach(n=>n.onchange=osChoice);$('copy-command').onclick=()=>guarded(async()=>{await navigator.clipboard.writeText($('launch-command').textContent);message('คัดลอกคำสั่งแล้ว');});$('download').onclick=()=>next(1,'แตก ZIP แล้วรัน Helper บนคอมที่เสียบ SD');$('open-helper').href='http://127.0.0.1:3088/#cloud='+encodeURIComponent(location.origin);if(location.protocol==='http:')fetch('/api/local/info',{cache:'no-store'}).then(r=>r.json()).then(info=>{if(info.local&&info.cloudUrl)$('open-helper').href='http://127.0.0.1:3088/#cloud='+encodeURIComponent(new URL(info.cloudUrl).origin);}).catch(()=>{});return;}
$('cloud-panel').hidden=true;$('helper-panel').hidden=false;$('back').hidden=true;$('location-badge').textContent='ทำงานบนคอมเครื่องนี้';$('cloud-url').value=fragment.get('cloud')||'https://server-ubuntu-mechatronic.taile47ae6.ts.net:8443';next(2,'กดดาวน์โหลด Ubuntu ก่อน แล้วตั้งค่าหุ่นและเลือก SD card');
$('download-image').onclick=()=>guarded(async()=>{renderJob((await api('/api/environment/download',{})).job);schedule();});$('scan-target').onclick=()=>guarded(scan);
$('flash').onclick=()=>guarded(async()=>{const d=target();if(!d)throw Error('เลือก SD card ก่อน');renderJob((await api('/api/environment/flash',{...settings(),deviceId:d.id,fingerprint:[d.id,d.path,d.size,d.serial||'',d.label],confirm:$('confirm-disk').value})).job);schedule();});
$('cancel').onclick=()=>guarded(async()=>{await api('/api/cancel',{});message('กำลังหยุดงาน รอให้ Helper ยืนยันก่อนถอดการ์ด');});$('copy-robot-key').onclick=()=>guarded(async()=>{await navigator.clipboard.writeText($('new-robot-key').value);message('คัดลอก Robot Key แล้ว ไปเพิ่มหุ่นจริงใน ROSIDE');});
for(const id of ['target','hostname','username','password','domain-id','ssid','wifi-password','install-agent','cloud-url','confirm-disk'])$(id).addEventListener('input',refreshButtons);
document.addEventListener('visibilitychange',()=>{clearTimeout(state.timer);if(!document.hidden)poll();});window.addEventListener('pagehide',()=>clearTimeout(state.timer));
guarded(async()=>{const info=await api('/api/info');state.privileged=info.privileged;$('computer-info').textContent=`${info.os} · ${info.privileged?'สิทธิ์พร้อม Flash':'เปิดด้วย Administrator / sudo เพื่อ Flash'}`;$('output-folder').textContent=info.folder;await environment();await poll();});
})();
