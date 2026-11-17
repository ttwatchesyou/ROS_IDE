'use strict';
// Shared by real teleop, Mapping and the individual-motor tool.
((root)=>{
  const canonical=['front_left','front_right','rear_left','rear_right'];
  function isMecanum(config){return config?.drive==='mecanum4'||config?.kinematics==='mecanum'||config?.robotDesign?.pattern==='mecanum'||config?.robotDesign?.hardwareTemplate==='mecanum_xy';}
  function controllerWheelOrder(config){
    const explicit=config?.controllerWheelOrder;
    if(Array.isArray(explicit)){
      if(explicit.length!==4||new Set(explicit).size!==4||explicit.some(role=>!canonical.includes(role)))throw Error('ลำดับช่อง Controller ไม่ถูกต้อง');
      return [...explicit];
    }
    // The real Mecanum XY controller's rear channels are RR then RL.
    // Reordering at the transport boundary keeps yaw and lateral kinematics distinct.
    return config?.robotDesign?.hardwareTemplate==='mecanum_xy'?['front_left','front_right','rear_right','rear_left']:[...canonical];
  }
  function rpmCommand(config,vx,vy,wz){
    const radius=Number(config.wheelDiameterMm)/2000,halfLength=Number(config.wheelBaseMm)/2000,halfWidth=Number(config.wheelTrackMm)/2000,limit=Number(config.motorMaxRpm);
    if(![radius,halfLength,halfWidth,limit].every(value=>Number.isFinite(value)&&value>0)||![vx,vy,wz].every(Number.isFinite))throw Error('ข้อมูลขนาดล้อ/ฐานล้อ Mecanum ไม่ครบ กรุณาบันทึก Hardware Config ก่อน');
    const turn=(halfLength+halfWidth)*wz,scale=60/(2*Math.PI*radius);
    const byRole={front_left:(vx-vy-turn)*scale,front_right:(vx+vy+turn)*scale,rear_left:(vx+vy-turn)*scale,rear_right:(vx-vy+turn)*scale};
    const values=controllerWheelOrder(config).map(role=>byRole[role]),peak=Math.max(...values.map(Math.abs)),factor=peak>limit?limit/peak:1;
    return 'R '+values.map(value=>(value*factor).toFixed(4)).join(' ');
  }
  function mappingCommand(command){
    const text=String(command||'').trim(),number='-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)',cmd=text.match(new RegExp('^CMD\\s+('+number+')\\s+('+number+')$'));
    if(text==='STOP')return 'STOP';
    if(cmd){const vx=Number(cmd[1]),wz=Number(cmd[2]);return Number.isFinite(vx)&&Number.isFinite(wz)?`CMD ${Math.max(-1.5,Math.min(1.5,vx))} ${Math.max(-10,Math.min(10,wz))}`:'';}
    if(!new RegExp('^R(?:\\s+'+number+'){4}$').test(text))return '';
    const rpm=text.split(/\s+/).slice(1).map(Number);
    return rpm.every(value=>Number.isFinite(value)&&Math.abs(value)<=5000)?'R '+rpm.map(value=>value.toFixed(4)).join(' '):'';
  }
  const api={isMecanum,controllerWheelOrder,rpmCommand,mappingCommand};root.RealDriveMotion=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
