'use strict';
// Navigation only. Never starts a ROS tool/build, disconnects, or changes a robot.
// Main Workspace consumes an allowlisted page request in task-studio-entry.js.
(()=>{
  const nav=document.getElementById('ts-main-nav');if(!nav)return;
  const menus=[...nav.querySelectorAll('details')];
  function closeMenus(except=null){for(const menu of menus)if(menu!==except)menu.open=false;}
  for(const menu of menus){
    menu.addEventListener('toggle',()=>{if(menu.open)closeMenus(menu);});
    menu.addEventListener('keydown',event=>{
      const items=[...menu.querySelectorAll('.ts-shell-dropdown a,.ts-shell-dropdown button')];
      if(!items.length||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      event.preventDefault();menu.open=true;closeMenus(menu);
      const index=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(index+1)%items.length:(index<=0?items.length:index)-1;
      items[next].focus();
    });
  }
  document.addEventListener('pointerdown',event=>{if(!nav.contains(event.target))closeMenus();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const open=menus.find(menu=>menu.open&&menu.contains(document.activeElement));closeMenus();open?.querySelector('summary').focus();}});
  nav.addEventListener('click',event=>{if(event.target.closest('a'))closeMenus();});
  document.getElementById('ts-shell-theme').addEventListener('click',()=>window.toggleTheme?.());
  const themeLabel=()=>{const dark=document.documentElement.dataset.theme==='dark',button=document.getElementById('ts-shell-theme');button.title=dark?'ใช้ธีมสว่าง':'ใช้ธีมมืด';button.setAttribute('aria-label',button.title);};
  window.addEventListener('roside-theme-change',themeLabel);themeLabel();
  document.getElementById('ts-shell-help').addEventListener('click',()=>{closeMenus();document.getElementById('ts-nav-help').showModal();});
  function sessionStatus(){
    const ready=window.TaskStudioBridge?.get().ready===true,robot=localStorage.getItem('ros2ide_robotname')||'หุ่นยนต์จริง';
    const icon=document.getElementById('ts-shell-robot'),state=document.getElementById('ts-shell-connection');
    icon.title=ready?'หุ่นยนต์: '+robot:'รอยืนยันเซสชันหุ่นยนต์';icon.setAttribute('aria-label',icon.title);
    state.classList.toggle('ready',ready);state.title=ready?'ยืนยันเซสชันหุ่นยนต์แล้วเมื่อเปิดหน้านี้ · ดูสถานะล่าสุดในหน้าสถานะระบบ':'ยังไม่ยืนยันเซสชันหุ่นยนต์';state.setAttribute('aria-label',state.title);
    let user;try{user=JSON.parse(localStorage.getItem('ros2ide_user')||'null')?.username;}catch{}
    document.getElementById('ts-shell-user').textContent=user||localStorage.getItem('ros2ide_username')||'ผู้ใช้ปัจจุบัน';
    // The legacy auth guard disables all page buttons on errors. Navigation,
    // help and returning to Workspace must remain available even in that state.
    for(const button of nav.querySelectorAll('button'))button.disabled=false;
    document.querySelector('#ts-nav-help button').disabled=false;
  }
  window.addEventListener('task-studio-ready',sessionStatus);sessionStatus();
  const status=document.getElementById('connection');if(status)new MutationObserver(sessionStatus).observe(status,{subtree:true,childList:true,characterData:true});
  const measure=()=>document.documentElement.style.setProperty('--ts-main-nav-height',nav.getBoundingClientRect().height+'px');
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>{measure();if(window.TaskStudioV3?.workspace)Blockly.svgResize(TaskStudioV3.workspace);}).observe(nav);
  window.addEventListener('resize',measure);measure();
})();
