'use strict';
// Additive entry point. Never alters the wizard, Flow Editor, or Simulation.
(()=>{
  // Add future special apps here; they never become wizard capabilities/missions.
  const apps=[{id:'task-studio-entry',href:'/task-studio.html',icon:'ƒ',name:'Robot Task Studio',description:'ลากบล็อกสร้างโปรแกรม เรียกฟังก์ชันย่อย และดู Debug ทีละ Step',tags:['Main + Functions','ROS Topics','ROS Package']}];
  const isReal=()=>typeof sessionId!=='undefined'&&sessionId&&typeof isSimWorkspace!=='undefined'&&!isSimWorkspace;
  // Only explicit links from Task Studio request a destination. Normal opens
  // and Simulation sessions keep their existing behavior untouched.
  function returnPage(){
    if(!isReal()||typeof switchPage!=='function')return;
    const url=new URL(location.href),page=url.searchParams.get('task_studio_page');
    const allowed=new Set(['dashboard','editor','flow','transformation','lidar','monitor','run','rviz','status','terminal']);
    if(!allowed.has(page))return;
    if(page==='terminal'&&typeof terminalPlanAccessResolved!=='undefined'&&!terminalPlanAccessResolved)return;
    const button=[...document.querySelectorAll('#topbar [onclick]')].find(el=>el.getAttribute('onclick').includes("switchPage('"+page+"')"));
    if(!button)return;
    url.searchParams.delete('task_studio_page');history.replaceState(history.state,'',url.pathname+url.search+url.hash);
    // Reuse existing menu handlers and entitlement checks; never dispatch a
    // build, disconnect, command, or simulation action from this navigation link.
    button.click();
  }
  function styles(){
    if(document.getElementById('real-special-apps-style'))return;
    const style=document.createElement('style');style.id='real-special-apps-style';style.textContent=`
      #real-special-apps{margin-top:20px;border:1px solid var(--brd,#dce4ef);border-radius:16px;background:var(--bg1,#fff);overflow:hidden;color:var(--txt,#243247)}
      #real-special-apps[hidden]{display:none!important}
      #real-special-apps .special-heading{display:flex;align-items:center;gap:12px;padding:17px 20px;border-bottom:1px solid var(--brd,#dce4ef);background:linear-gradient(100deg,rgba(115,93,220,.09),transparent)}
      #real-special-apps .special-symbol{display:grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border-radius:12px;background:var(--adim,#edf2ff);color:var(--acc,#356cf3);font-size:23px}
      #real-special-apps h2{margin:0;font:700 16px/1.5 var(--fn,system-ui)}
      #real-special-apps .special-heading p{margin:3px 0 0;font-size:11px;line-height:1.5;color:var(--mt,#66758e)}
      #real-special-apps .special-badge{margin-left:auto;flex-shrink:0;padding:5px 9px;border:1px solid var(--brd,#dce4ef);border-radius:20px;color:var(--mt,#66758e);font-size:10px}
      #real-special-apps .special-app-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;padding:20px}
      #real-special-apps .special-app-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:18px;border:1px solid var(--brd,#dce4ef);border-radius:13px;background:linear-gradient(145deg,var(--bg1,#fff),var(--bg2,#f7f9fc));text-decoration:none;color:inherit;transition:border-color .15s,box-shadow .15s}
      #real-special-apps .special-app-card:hover{border-color:var(--acc,#356cf3);box-shadow:0 6px 20px rgba(57,90,158,.12)}
      #real-special-apps .special-app-card:focus-visible{outline:3px solid var(--acc,#356cf3);outline-offset:3px}
      #real-special-apps .special-app-title{display:flex;align-items:center;gap:11px;font-size:14px;line-height:1.5}
      #real-special-apps .special-app-icon{display:grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border-radius:12px;background:var(--adim,#edf2ff);color:var(--acc,#356cf3);font:italic bold 27px Georgia}
      #real-special-apps .special-app-card p{margin:0;color:var(--mt,#66758e);font-size:12px;line-height:1.7}
      #real-special-apps .special-tags{display:flex;gap:5px;flex-wrap:wrap}
      #real-special-apps .special-tags span{padding:3px 6px;border-radius:6px;background:var(--bg2,#f1f4f9);color:var(--mt,#66758e);font-size:9px}
      #real-special-apps .special-open{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto;padding-top:10px;border-top:1px solid var(--brd,#dce4ef);color:var(--acc,#356cf3);font-size:12px;font-weight:600;min-height:38px}
      @media(max-width:1250px){#real-special-apps .special-app-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:680px){#real-special-apps .special-app-grid{grid-template-columns:1fr;padding:14px}#real-special-apps .special-heading{padding:14px;flex-wrap:wrap}#real-special-apps .special-badge{margin-left:54px}#real-special-apps h2{font-size:15px}}
      @media(prefers-reduced-motion:reduce){#real-special-apps .special-app-card{transition:none}}
    `;document.head.append(style);
  }
  function install(){
    returnPage();
    let section=document.getElementById('real-special-apps');
    if(!isReal()){if(section)section.hidden=true;return;}
    const missions=document.getElementById('project-capabilities-grid')?.closest('.project-overview');
    if(!missions)return;
    document.querySelector('#topbar #task-studio-entry')?.remove();
    if(!section){
      styles();section=document.createElement('section');section.id='real-special-apps';section.setAttribute('aria-labelledby','special-apps-title');
      section.innerHTML='<div class="special-heading"><span class="special-symbol" aria-hidden="true">✦</span><div><h2 id="special-apps-title">โหมดพิเศษ</h2><p>แอปเสริมสำหรับหุ่นยนต์จริง · เลือกใช้งานได้แยกจากภารกิจหลัก</p></div><span class="special-badge">ไม่นับรวมความคืบหน้าภารกิจ</span></div><div class="special-app-grid"></div>';
      for(const app of apps){
        const card=document.createElement('a');card.id=app.id;card.className='special-app-card';card.href=app.href;card.setAttribute('aria-label','เปิด '+app.name);
        card.innerHTML=`<div class="special-app-title"><span class="special-app-icon" aria-hidden="true">${app.icon}</span><strong>${app.name}</strong></div><p>${app.description}</p><div class="special-tags">${app.tags.map(tag=>`<span>${tag}</span>`).join('')}</div><span class="special-open">เปิดใช้งาน <span aria-hidden="true">↗</span></span>`;
        card.addEventListener('click',event=>{if(!isReal())event.preventDefault();});
        section.querySelector('.special-app-grid').append(card);
      }
    }
    if(missions.nextElementSibling!==section)missions.after(section);
    section.hidden=false;
  }
  install();setInterval(install,2000);
})();
