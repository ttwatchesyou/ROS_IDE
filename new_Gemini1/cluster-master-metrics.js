'use strict';
const fs=require('node:fs');
const os=require('node:os');
let previousCpu=null;
function masterMetrics(){
  const cpu=os.cpus().reduce((sum,core)=>({idle:sum.idle+core.times.idle,total:sum.total+Object.values(core.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
  const before=previousCpu;previousCpu=cpu;
  const cpuPercent=before&&cpu.total>before.total?Math.max(0,Math.min(100,100*(1-(cpu.idle-before.idle)/(cpu.total-before.total)))):null;
  const memory=fs.readFileSync('/proc/meminfo','utf8');
  const value=name=>Number(memory.match(new RegExp('^'+name+':\\s+(\\d+)','m'))?.[1]||0);
  const total=value('MemTotal'),available=value('MemAvailable');
  return{cpuPercent:cpuPercent===null?null:Math.round(cpuPercent*10)/10,memUsedMb:Math.round((total-available)/1024),memTotalMb:Math.round(total/1024)};
}
module.exports={masterMetrics};
