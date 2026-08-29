'use strict';

const TOKEN=getAuthToken();
let USER=JSON.parse(localStorage.getItem('ros2ide_user')||'{}');
let applications=[];
let billing=null;
let editingId=null;
let ssoDebugUrl='';
let ssoDebugTimer=null;

if(!TOKEN){location.replace('/');throw new Error('Not authenticated');}

const byId=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const isImageUrl=value=>{try{return new URL(String(value)).protocol==='https:';}catch{return false;}};
const isUploadedImage=value=>/^\/uploads\/application-icons\/app-[0-9]+-[a-f0-9]{16}\.(?:png|jpg|webp|gif)$/.test(String(value));
const isImageSource=value=>isImageUrl(value)||isUploadedImage(value);
function renderAppLogo(value){return isImageSource(value)?`<img class="app-icon-image" src="${escapeHtml(value)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-app-logo>`:`<div class="app-icon">${escapeHtml(value||'🚀')}</div>`;}

async function api(url,options={}){
  const response=await fetch(url,{method:options.method||'GET',headers:{'Content-Type':'application/json',...authHeaders(TOKEN)},body:options.body===undefined?undefined:JSON.stringify(options.body)});
  const data=await response.json().catch(()=>({ok:false,error:'Invalid server response'}));
  if(response.status===401){await logout(false);throw new Error('Session expired');}
  if(!response.ok||!data.ok)throw new Error(data.error||'Request failed');
  return data;
}

function toast(message,error=false){
  const el=byId('toast');el.textContent=message;el.className=`toast show${error?' error':''}`;
  clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',3200);
}

async function loadApplications(){
  try{
    const me=await api('/api/auth/me');USER=me.user;storeAuthUser(USER,me.encryptedUserId);
    byId('username').textContent=USER.username||'—';
    byId('add-app').style.display=USER.role==='admin'?'block':'none';
    const [result,billingResult]=await Promise.all([api('/api/applications'),api('/api/billing/plans')]);applications=result.applications;billing=billingResult;renderBilling();renderApplications();
  }catch(error){byId('apps-grid').innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
}

function formatDate(value){return value?new Date(value).toLocaleDateString('th-TH',{dateStyle:'long'}):'ไม่มีกำหนด';}
function renderBilling(){
  const membership=billing.membership,isAdmin=membership.planCode==='admin';
  byId('membership-badge').textContent=membership.name;
  byId('membership-dates').textContent=isAdmin?'บัญชีผู้ดูแลระบบ — สิทธิ์ไม่จำกัด':membership.planCode==='free'?'เริ่มต้นใช้งาน Free · อัปเกรดเป็น Pro ได้ทุกเมื่อ':`วันที่สมัคร ${formatDate(membership.startsAt)} · วันหมดอายุ ${formatDate(membership.expiresAt)}`;
  byId('plans').innerHTML=billing.plans.map(plan=>{const current=membership.planCode===plan.code,period=plan.interval==='month'?'/ เดือน':plan.interval==='year'?'/ ปี':plan.interval==='lifetime'?'ครั้งเดียว':'ตลอดการใช้งาน';return `<article class="plan${plan.code!=='free'?' pro':''}${current?' current':''}"><h3>${escapeHtml(plan.name)}</h3><div class="plan-price">฿${Number(plan.price).toLocaleString('th-TH')} <small>${period}</small></div><ul>${plan.features.map(feature=>`<li>${escapeHtml(feature)}</li>`).join('')}</ul><button type="button" data-plan="${plan.code}" ${current||plan.code==='free'||isAdmin||!billing.payment.configured?'disabled':''}>${current?'กำลังใช้งาน':plan.code==='free'?'แพ็กเกจเริ่มต้น':isAdmin?'Admin ไม่ต้องซื้อ':billing.payment.configured?'เลือกแพ็กเกจ':'ยังไม่เปิดรับชำระ'}</button></article>`;}).join('');
  byId('payment-note').textContent=billing.payment.configured?billing.payment.note:'ระบบแสดงแพ็กเกจและสิทธิ์แล้ว แต่ยังไม่เปิดรับชำระเงินจริง กรุณาตั้งค่า Stripe ในฝั่ง Server';
}

async function checkout(planCode){
  try{const result=await api('/api/billing/checkout',{method:'POST',body:{planCode}});location.assign(result.url);}
  catch(error){toast(error.message,true);}
}

function renderApplications(){
  const visible=applications.filter(app=>USER.role==='admin'||app.enabled);
  byId('app-count').textContent=`${visible.length} APPLICATION${visible.length===1?'':'S'}`;
  if(!visible.length){byId('apps-grid').innerHTML='<div class="empty">ยังไม่มีแอปพลิเคชันที่เปิดใช้งาน</div>';return;}
  byId('apps-grid').innerHTML=visible.map(app=>`
    <article class="app-card${app.enabled?'':' disabled'}" tabindex="0" role="link" data-launch="${app.id}" aria-label="เปิดแอปพลิเคชัน ${escapeHtml(app.name)}">
      ${USER.role==='admin'?`<div class="admin-actions"><button type="button" data-edit="${app.id}" title="แก้ไขแอป" aria-label="แก้ไข ${escapeHtml(app.name)}">✎</button></div>`:''}
      <div class="card-art"><span class="status${app.enabled?'':' disabled-badge'}">${app.enabled?'พร้อมใช้งาน':'ปิดใช้งาน'}</span>${renderAppLogo(app.icon)}</div>
      <div class="card-body"><div class="app-type">${escapeHtml(app.category)}</div><h2>${escapeHtml(app.name)}</h2><p>${escapeHtml(app.description||'เปิดแอปพลิเคชันเพื่อเริ่มต้นใช้งาน')}</p></div>
      <div class="open-row"><span>${app.enabled?'เข้าสู่แอปพลิเคชัน':'ปิดใช้งานอยู่'}</span><span class="arrow">→</span></div>
    </article>`).join('');
  byId('apps-grid').querySelectorAll('[data-app-logo]').forEach(image=>image.addEventListener('error',()=>image.replaceWith(Object.assign(document.createElement('div'),{className:'app-icon',textContent:'🚀'})),{once:true}));
}

function updateIconPreview(){
  const value=byId('app-icon').value.trim()||'🚀',preview=byId('app-icon-preview');preview.className='icon-preview';preview.replaceChildren();
  if(/^https?:\/\//i.test(value)||isUploadedImage(value)){
    if(!isImageSource(value)){preview.textContent='⚠';preview.classList.add('invalid');return;}
    const image=new Image();image.alt='ตัวอย่างโลโก้';image.referrerPolicy='no-referrer';image.onload=()=>preview.classList.remove('invalid');image.onerror=()=>{preview.replaceChildren();preview.textContent='⚠';preview.classList.add('invalid');};image.src=value;preview.append(image);
  }else preview.textContent=value;
}

async function pasteApplicationIcon(event){
  const item=[...(event.clipboardData?.items||[])].find(entry=>entry.kind==='file'&&entry.type.startsWith('image/'));
  if(!item)return;
  event.preventDefault();
  const file=item.getAsFile(),preview=byId('app-icon-preview');
  if(!file)return;
  if(file.size>5*1024*1024){toast('รูปโลโก้ต้องมีขนาดไม่เกิน 5 MB',true);return;}
  preview.className='icon-preview uploading';preview.textContent='กำลังอัปโหลด…';
  try{
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('อ่านรูปจาก Clipboard ไม่สำเร็จ'));reader.readAsDataURL(file);});
    const result=await api('/api/applications/icon-upload',{method:'POST',body:{dataUrl}});
    byId('app-icon').value=result.url;updateIconPreview();toast('อัปโหลดโลโก้แล้ว กดบันทึกเพื่อใช้งาน');
  }catch(error){preview.className='icon-preview invalid';preview.textContent='⚠';toast(error.message,true);}
}

async function launchApplication(id){
  const app=applications.find(item=>item.id===id);if(!app?.enabled){toast('แอปนี้ปิดใช้งานอยู่',true);return;}
  try{
    const result=await api(`/api/applications/${id}/launch`,{method:'POST',body:{}});
    if(result.ssoCode){
      const target=new URL(result.redirectUrl,location.href),code=result.ssoCode;
      if(!code)throw new Error('ไม่พบ SSO key ใน Redirect URL');
      showSsoDebug(code,target.toString());
      return;
    }
    location.assign(result.redirectUrl);
  }
  catch(error){toast(error.message,true);}
}

function showSsoDebug(code,redirectUrl){
  ssoDebugUrl=redirectUrl;byId('sso-debug-code').textContent=code;byId('sso-debug').hidden=false;
  let seconds=60;const expiry=byId('sso-debug-expiry');expiry.textContent=`หมดอายุใน ${seconds} วินาที`;
  clearInterval(ssoDebugTimer);ssoDebugTimer=setInterval(()=>{seconds-=1;expiry.textContent=seconds>0?`หมดอายุใน ${seconds} วินาที`:'หมดอายุแล้ว — กดแอปเพื่อสร้าง Key ใหม่';if(seconds<=0)clearInterval(ssoDebugTimer);},1000);
}

function closeSsoDebug(){byId('sso-debug').hidden=true;clearInterval(ssoDebugTimer);}

function openApplicationModal(id=null){
  editingId=id;const app=applications.find(item=>item.id===id);
  byId('modal-title').textContent=app?'แก้ไขแอปพลิเคชัน':'เพิ่มแอปพลิเคชัน';
  byId('app-name').value=app?.name||'';byId('app-icon').value=app?.icon||'🚀';byId('app-category').value=app?.category||'Application';
  byId('app-order').value=app?.sort_order??0;byId('app-url').value=app?.redirect_url||'';byId('app-description').value=app?.description||'';
  byId('app-session').value=app?.session_mode||'none';byId('app-enabled').checked=app?Boolean(app.enabled):true;byId('delete-app').style.display=app?'block':'none';
  updateIconPreview();
  byId('app-modal').classList.add('show');setTimeout(()=>byId('app-name').focus(),0);
}

function closeApplicationModal(){byId('app-modal').classList.remove('show');editingId=null;}

async function saveApplication(event){
  event.preventDefault();
  const body={name:byId('app-name').value,icon:byId('app-icon').value,category:byId('app-category').value,sort_order:Number(byId('app-order').value),redirect_url:byId('app-url').value,description:byId('app-description').value,session_mode:byId('app-session').value,enabled:byId('app-enabled').checked};
  try{await api(editingId?`/api/applications/${editingId}`:'/api/applications',{method:editingId?'PUT':'POST',body});closeApplicationModal();await loadApplications();toast('บันทึกแอปพลิเคชันแล้ว');}
  catch(error){toast(error.message,true);}
}

async function deleteApplication(){
  if(!editingId||!confirm('ลบแอปพลิเคชันนี้ออกจากรายการใช่หรือไม่?'))return;
  try{await api(`/api/applications/${editingId}`,{method:'DELETE'});closeApplicationModal();await loadApplications();toast('ลบแอปพลิเคชันแล้ว');}
  catch(error){toast(error.message,true);}
}

async function logout(callApi=true){
  if(callApi){try{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders(TOKEN)}})}catch{}}
  clearAuthSession();
  location.replace('/');
}

byId('add-app').addEventListener('click',()=>openApplicationModal());
byId('app-form').addEventListener('submit',saveApplication);
byId('app-icon').addEventListener('input',updateIconPreview);
byId('app-icon').addEventListener('paste',pasteApplicationIcon);
byId('app-icon-preview').addEventListener('paste',pasteApplicationIcon);
byId('delete-app').addEventListener('click',deleteApplication);
byId('sso-debug-close').addEventListener('click',closeSsoDebug);
byId('sso-debug-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(byId('sso-debug-code').textContent);toast('คัดลอก SSO Key แล้ว');}catch{toast('คัดลอกไม่สำเร็จ กรุณาเลือกข้อความแล้วคัดลอก',true);}});
byId('sso-debug-open').addEventListener('click',()=>{if(ssoDebugUrl)location.assign(ssoDebugUrl);});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',closeApplicationModal));
byId('app-modal').addEventListener('click',event=>{if(event.target===event.currentTarget)closeApplicationModal();});
byId('apps-grid').addEventListener('click',event=>{const edit=event.target.closest('[data-edit]');if(edit){event.stopPropagation();openApplicationModal(Number(edit.dataset.edit));return;}const card=event.target.closest('[data-launch]');if(card)launchApplication(Number(card.dataset.launch));});
byId('apps-grid').addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-launch]')){event.preventDefault();launchApplication(Number(event.target.dataset.launch));}});
byId('plans').addEventListener('click',event=>{const button=event.target.closest('[data-plan]');if(button&&!button.disabled)checkout(button.dataset.plan);});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeApplicationModal();});
const billingStatus=new URLSearchParams(location.search).get('billing');if(billingStatus==='success')toast('รับข้อมูลการชำระแล้ว ระบบจะอัปเดต Pro หลัง Stripe ยืนยัน');else if(billingStatus==='cancel')toast('ยกเลิกการชำระแล้ว',true);
loadApplications();
