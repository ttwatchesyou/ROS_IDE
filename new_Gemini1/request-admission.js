'use strict';
// Admission applies only to request/response work; motor/STOP/PTY packets never
// enter this gate. No command is delayed and replayed when capacity frees up.
class RequestAdmission{
  constructor({maxTotal=1024,maxPerRobot=64,maxExecPerRobot=8}={}){this.maxTotal=maxTotal;this.maxPerRobot=maxPerRobot;this.maxExecPerRobot=maxExecPerRobot;this.total=0;this.robots=new Map();}
  enter(robotKey,action){
    if(action==='agent_status'||action==='control_select')return ()=>{};
    const current=this.robots.get(robotKey)||{total:0,exec:0},exec=action==='exec';
    if(this.total>=this.maxTotal||current.total>=this.maxPerRobot||(exec&&current.exec>=this.maxExecPerRobot)){
      const error=new Error('Agent มีงานค้างเต็มขีดจำกัด กรุณารอให้งานเดิมเสร็จก่อน');error.code='AGENT_BUSY';throw error;
    }
    this.total++;current.total++;if(exec)current.exec++;this.robots.set(robotKey,current);let released=false;
    return()=>{if(released)return;released=true;this.total--;current.total--;if(exec)current.exec--;if(!current.total)this.robots.delete(robotKey);};
  }
}
module.exports={RequestAdmission};
