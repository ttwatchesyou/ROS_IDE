'use strict';

(function initYoutubeHelp(){
  if(document.querySelector('.youtube-help'))return;
  let storedUser={};
  try{storedUser=JSON.parse(localStorage.getItem('ros2ide_user')||'{}');}catch{}
  const localUsername=storedUser.username||'';
  const isAdmin=storedUser.role==='admin';

  const widget=document.createElement('aside');
  widget.className='youtube-help';
  widget.setAttribute('aria-label','วิดีโอสอนใช้งาน ROS');
  widget.innerHTML=`
    <section class="youtube-help-player" aria-label="วิดีโอสอนใช้งาน" hidden>
      <header class="youtube-help-head">
        <svg viewBox="0 0 28 20" aria-hidden="true"><path fill="#ff0033" d="M27.4 3.1A3.5 3.5 0 0 0 25 0.7C22.8 0.1 14 0.1 14 0.1S5.2 0.1 3 0.7A3.5 3.5 0 0 0 .6 3.1C0 5.3 0 10 0 10s0 4.7.6 6.9A3.5 3.5 0 0 0 3 19.3c2.2.6 11 .6 11 .6s8.8 0 11-.6a3.5 3.5 0 0 0 2.4-2.4c.6-2.2.6-6.9.6-6.9s0-4.7-.6-6.9Z"/><path fill="#fff" d="m11.2 14.2 7.3-4.2-7.3-4.2v8.4Z"/></svg>
        <strong>วิดีโอสอนใช้งาน ROS</strong>
        <button class="youtube-help-close" type="button" aria-label="ย่อวิดีโอ" title="ย่อวิดีโอ">×</button>
      </header>
      <iframe class="youtube-help-frame" width="560" height="315" src="https://www.youtube.com/embed/CEDr7AG-w0c?si=9s20oEInjIxqv3BL" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      <section class="support-chat" aria-label="ห้องแชทแจ้งปัญหา">
        <div class="support-chat-title"><span>💬</span><div><strong>แชทแจ้งปัญหาถึง Admin</strong><small>ห้องรวม · สมาชิกทุกคนมองเห็นข้อความ</small></div><i class="support-chat-live" title="อัปเดตอัตโนมัติ"></i></div>
        <div class="support-chat-messages" role="log" aria-live="polite" aria-label="ข้อความในห้องแชท"><p class="support-chat-state">กำลังโหลดข้อความ…</p></div>
        <form class="support-chat-form">
          <input class="support-chat-input" type="text" maxlength="1000" autocomplete="off" placeholder="พิมพ์ปัญหาที่ต้องการแจ้ง…" aria-label="ข้อความถึง Admin">
          <button class="support-chat-send" type="submit" aria-label="ส่งข้อความ">➤</button>
        </form>
        <div class="support-chat-error" role="status" aria-live="polite"></div>
      </section>
    </section>
    ${isAdmin?`<section class="support-presence-panel" aria-label="ผู้ใช้งานออนไลน์" hidden>
      <header class="support-presence-head"><div><strong>ผู้ใช้งานออนไลน์</strong><small>กำลังใช้งานหน้า ROS หรือเลือกหุ่นยนต์</small></div><button class="support-presence-close" type="button" aria-label="ปิดรายชื่อ">×</button></header>
      <div class="support-presence-list"><p class="support-chat-state">กำลังตรวจสอบ…</p></div>
    </section>`:''}
    <div class="youtube-help-actions">
      ${isAdmin?`<button class="support-presence-button" type="button" aria-expanded="false" aria-label="ดูผู้ใช้งานออนไลน์" title="ผู้ใช้งานออนไลน์"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg><span class="support-presence-count" hidden>0</span></button>`:''}
      <button class="youtube-help-button" type="button" aria-expanded="false" aria-label="เปิดวิดีโอสอนใช้งาน ROS" title="วิดีโอสอนใช้งาน ROS">
        <svg viewBox="0 0 28 20" aria-hidden="true"><path fill="currentColor" d="M27.4 3.1A3.5 3.5 0 0 0 25 0.7C22.8 0.1 14 0.1 14 0.1S5.2 0.1 3 0.7A3.5 3.5 0 0 0 .6 3.1C0 5.3 0 10 0 10s0 4.7.6 6.9A3.5 3.5 0 0 0 3 19.3c2.2.6 11 .6 11 .6s8.8 0 11-.6a3.5 3.5 0 0 0 2.4-2.4c.6-2.2.6-6.9.6-6.9s0-4.7-.6-6.9Z"/><path fill="#fff" d="m11.2 14.2 7.3-4.2-7.3-4.2v8.4Z"/></svg>
        <span class="support-unread-badge" hidden>0</span>
      </button>
    </div>`;
  document.body.appendChild(widget);

  const player=widget.querySelector('.youtube-help-player');
  const button=widget.querySelector('.youtube-help-button');
  const close=widget.querySelector('.youtube-help-close');
  const messagesElement=widget.querySelector('.support-chat-messages');
  const chatForm=widget.querySelector('.support-chat-form');
  const chatInput=widget.querySelector('.support-chat-input');
  const chatSend=widget.querySelector('.support-chat-send');
  const chatError=widget.querySelector('.support-chat-error');
  const unreadBadge=widget.querySelector('.support-unread-badge');
  const presencePanel=widget.querySelector('.support-presence-panel');
  const presenceButton=widget.querySelector('.support-presence-button');
  const presenceClose=widget.querySelector('.support-presence-close');
  const presenceList=widget.querySelector('.support-presence-list');
  const presenceCount=widget.querySelector('.support-presence-count');
  const token=typeof getAuthToken==='function'?getAuthToken():'';
  const headers=()=>({'Content-Type':'application/json',...(typeof authHeaders==='function'?authHeaders(token):{'x-auth-token':token})});
  let lastMessageId=0,chatLoaded=false,chatLoading=false,pollTimer=null,presenceTimer=null,presenceListTimer=null,unreadCount=0,audioContext=null;

  const setUnread=count=>{
    unreadCount=Math.max(0,count);
    unreadBadge.hidden=unreadCount===0;
    unreadBadge.textContent=unreadCount>99?'99+':String(unreadCount);
  };
  const unlockAudio=()=>{
    try{audioContext=audioContext||new(window.AudioContext||window.webkitAudioContext)();if(audioContext.state==='suspended')audioContext.resume();}catch{}
  };
  const playNotificationSound=()=>{
    try{
      unlockAudio();if(!audioContext||audioContext.state!=='running')return;
      const oscillator=audioContext.createOscillator(),gain=audioContext.createGain(),now=audioContext.currentTime;
      oscillator.type='sine';oscillator.frequency.setValueAtTime(720,now);oscillator.frequency.setValueAtTime(920,now+.09);
      gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.14,now+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+.2);
      oscillator.connect(gain);gain.connect(audioContext.destination);oscillator.start(now);oscillator.stop(now+.21);
    }catch{}
  };
  document.addEventListener('pointerdown',unlockAudio,{once:true,capture:true});

  const formatTime=value=>{
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit'}).format(date);
  };
  const appendMessage=message=>{
    if(messagesElement.querySelector(`[data-message-id="${message.id}"]`))return;
    messagesElement.querySelector('.support-chat-state')?.remove();
    const item=document.createElement('article');
    item.className=`support-chat-message${message.username===localUsername?' mine':''}${message.role==='admin'?' admin':''}`;
    item.dataset.messageId=String(message.id);
    const meta=document.createElement('div');
    meta.className='support-chat-meta';
    const name=document.createElement('strong');name.textContent=message.username;
    const role=document.createElement('span');role.textContent=message.role==='admin'?'ADMIN':'';
    const time=document.createElement('time');time.textContent=formatTime(message.createdAt);
    meta.append(name);if(message.role==='admin')meta.append(role);meta.append(time);
    const body=document.createElement('p');body.textContent=message.message;
    item.append(meta,body);messagesElement.appendChild(item);
    lastMessageId=Math.max(lastMessageId,Number(message.id)||0);
  };
  const loadMessages=async(silent=false)=>{
    if(chatLoading||!token)return;
    chatLoading=true;
    try{
      const response=await fetch(`/api/support-chat/messages${chatLoaded?`?after=${lastMessageId}`:''}`,{headers:headers()});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error||'โหลดแชทไม่สำเร็จ');
      const incoming=chatLoaded?result.messages.filter(message=>message.username!==localUsername):[];
      result.messages.forEach(appendMessage);
      if(!chatLoaded&&!result.messages.length)messagesElement.innerHTML='<p class="support-chat-state">ยังไม่มีข้อความ เริ่มแจ้งปัญหาได้เลยครับ</p>';
      if(result.messages.length)messagesElement.scrollTop=messagesElement.scrollHeight;
      if(incoming.length){
        if(player.hidden)setUnread(unreadCount+incoming.length);
        playNotificationSound();
      }
      chatLoaded=true;chatError.textContent='';
    }catch(error){if(!silent)chatError.textContent=error.message;}
    finally{chatLoading=false;}
  };
  const setOpen=open=>{
    player.hidden=!open;
    button.setAttribute('aria-expanded',String(open));
    button.setAttribute('aria-label',open?'ย่อวิดีโอสอนใช้งาน ROS':'เปิดวิดีโอสอนใช้งาน ROS');
    if(open){if(presencePanel)presencePanel.hidden=true;if(presenceButton)presenceButton.setAttribute('aria-expanded','false');setUnread(0);loadMessages();setTimeout(()=>chatInput.focus(),180);}
  };
  button.addEventListener('click',()=>setOpen(player.hidden));
  close.addEventListener('click',()=>{setOpen(false);button.focus();});
  document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!player.hidden)setOpen(false);if(presencePanel&&!presencePanel.hidden){presencePanel.hidden=true;presenceButton.setAttribute('aria-expanded','false');}});
  chatForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const message=chatInput.value.trim();if(!message||!token)return;
    chatSend.disabled=true;chatInput.disabled=true;chatError.textContent='';
    try{
      const response=await fetch('/api/support-chat/messages',{method:'POST',headers:headers(),body:JSON.stringify({message})});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error||'ส่งข้อความไม่สำเร็จ');
      appendMessage(result.message);chatInput.value='';messagesElement.scrollTop=messagesElement.scrollHeight;
    }catch(error){chatError.textContent=error.message;}
    finally{chatSend.disabled=false;chatInput.disabled=false;chatInput.focus();}
  });
  const currentPage=()=>location.pathname==='/robots'?'เลือกหุ่นยนต์':(document.querySelector('.page.show')?.id||'page-ros').replace(/^page-/,'ROS: ');
  const sendPresence=()=>fetch('/api/support-chat/presence',{method:'POST',headers:headers(),body:JSON.stringify({page:currentPage()})}).catch(()=>null);
  const loadPresence=async()=>{
    if(!isAdmin||!token)return;
    try{
      const response=await fetch('/api/support-chat/presence',{headers:headers()}),result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error||'โหลดรายชื่อไม่สำเร็จ');
      presenceCount.hidden=result.users.length===0;presenceCount.textContent=String(result.users.length);
      presenceList.replaceChildren();
      if(!result.users.length){presenceList.innerHTML='<p class="support-chat-state">ยังไม่มีผู้ใช้งานออนไลน์</p>';return;}
      result.users.forEach(user=>{
        const item=document.createElement('article');item.className='support-presence-user';
        const avatar=document.createElement('span');avatar.className='support-presence-avatar';avatar.textContent=(user.username||'?').slice(0,1).toUpperCase();
        const detail=document.createElement('div'),name=document.createElement('strong'),page=document.createElement('small'),online=document.createElement('i');
        name.textContent=user.username+(user.role==='admin'?' · Admin':'');page.textContent=user.page;online.title='ออนไลน์';
        detail.append(name,page);item.append(avatar,detail,online);presenceList.appendChild(item);
      });
    }catch(error){if(!presencePanel?.hidden){presenceList.replaceChildren();const state=document.createElement('p');state.className='support-chat-state';state.textContent=error.message;presenceList.appendChild(state);}}
  };
  if(presenceButton){
    presenceButton.addEventListener('click',()=>{
      const open=presencePanel.hidden;setOpen(false);presencePanel.hidden=!open;presenceButton.setAttribute('aria-expanded',String(open));if(open)loadPresence();
    });
    presenceClose.addEventListener('click',()=>{presencePanel.hidden=true;presenceButton.setAttribute('aria-expanded','false');presenceButton.focus();});
  }
  if(token){
    loadMessages(true);pollTimer=setInterval(()=>loadMessages(true),4000);
    sendPresence().then(()=>{if(isAdmin)loadPresence();});presenceTimer=setInterval(sendPresence,20000);
    if(isAdmin)presenceListTimer=setInterval(loadPresence,10000);
  }
  window.addEventListener('pagehide',()=>{[pollTimer,presenceTimer,presenceListTimer].forEach(timer=>{if(timer)clearInterval(timer);});},{once:true});
})();
