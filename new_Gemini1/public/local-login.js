'use strict';
const message=document.getElementById('message');
const cloudLink=document.getElementById('cloud-link');
const post=async(url,body)=>{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok||!result.ok)throw new Error(result.error||'Connection failed');
  return result;
};
async function openLocal(){
  const result=await post('/api/connect',{robotId:1});
  await post('/api/real/agent/mode',{sessionId:result.sessionId,confirm:true});
  for(const[key,value]of Object.entries({session:result.sessionId,robotid:result.robotId,rosinfo:JSON.stringify(result.rosInfo),workspace:result.workspace,username:result.username,robotname:result.robotName,robotkey:result.robotKey,is_sim:'false'}))localStorage.setItem('ros2ide_'+key,String(value));
  localStorage.setItem('ros2ide_connection_route','local');
  location.assign('/app');
}
async function showCloudRoute(){
  try{
    const response=await fetch('/api/local/info');const info=await response.json();
    if(info.cloudUrl&&/^https?:\/\//.test(info.cloudUrl)){cloudLink.href=info.cloudUrl;cloudLink.hidden=false;}
  }catch{}
}
async function enterLocal(){
  const ticket=new URLSearchParams(location.hash.slice(1)).get('handoff');
  if(ticket){
    history.replaceState(null,'',location.pathname+location.search);
    message.textContent='กำลังยืนยันสิทธิ์จาก Cloud และเปิด Local IDE…';
    try{
      const login=await post('/api/local/handoff',{ticket});
      storeAuthSession(login.token,login.user);
      await openLocal();return;
    }catch(error){message.textContent=error.message;}
  }else if(getAuthToken()){
    try{
      const response=await fetch('/api/auth/me',{headers:authHeaders()});
      if(response.ok){message.textContent='กำลังเปิด Local IDE…';await openLocal();return;}
      clearAuthSession();
    }catch(error){message.textContent=error.message;}
  }
  try{
    const login=await post('/api/local/auto',{});
    storeAuthSession(login.token,login.user);
    message.textContent='เครื่องนี้คือหุ่นยนต์ กำลังเปิด Local IDE…';
    await openLocal();return;
  }catch(error){
    message.textContent='เปิด Local ตรงจาก URL ยังไม่ได้ กรุณากลับไปหน้า Cloud แล้วกดลิงก์ URL Local บนการ์ดหุ่นยนต์เพื่อยืนยันสิทธิ์';
    await showCloudRoute();
  }
}
enterLocal();
