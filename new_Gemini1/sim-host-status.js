'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
let cached,previousCpu;

// All simulations on this server share the same host metrics and process
// snapshot. Only their ROS graph still needs a workspace-specific probe.
function getSimHostStatus(){
  if(cached&&cached.expiresAt>Date.now())return cached.promise;
  const promise=(async()=>{
    const [memory,disk,entries]=await Promise.all([fs.readFile('/proc/meminfo','utf8'),fs.statfs('/'),fs.readdir('/proc')]);
    const cpu=os.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
    const previous=previousCpu||cpu;previousCpu=cpu;
    const usage=cpu.total>previous.total?100*(1-(cpu.idle-previous.idle)/(cpu.total-previous.total)):0;
    const kb=name=>Number(memory.match(new RegExp('^'+name+':\\s+(\\d+)','m'))?.[1]||0);
    const total=kb('MemTotal'),available=kb('MemAvailable'),usedDisk=(disk.blocks-disk.bfree)*disk.bsize,totalDisk=disk.blocks*disk.bsize;
    const stdout=`CPU=${Math.max(0,Math.min(100,usage)).toFixed(1)}\nMEM=${Math.round((total-available)/1024)} ${Math.round(total/1024)}\nDISK=${(usedDisk/1073741824).toFixed(1)}G ${(totalDisk/1073741824).toFixed(1)}G ${Math.round(usedDisk/totalDisk*100)}%\nUPTIME=up ${Math.floor(os.uptime()/60)} minutes\n`;
    const processes=[];
    // Small batches prevent a large host process table exhausting descriptors.
    const pids=entries.filter(id=>/^\d+$/.test(id));
    for(let offset=0;offset<pids.length;offset+=24)await Promise.all(pids.slice(offset,offset+24).map(async pid=>{
      try{
        const [raw,cwd]=await Promise.all([fs.readFile(`/proc/${pid}/cmdline`,'utf8'),fs.readlink(`/proc/${pid}/cwd`)]);
        const command=raw.replace(/\0/g,' ').trim();
        if(command)processes.push({pid,command,cwd});
      }catch{} // A process exiting during the snapshot is normal.
    }));
    return {stdout,processes};
  })();
  const entry={expiresAt:Infinity,promise};cached=entry;
  promise.then(()=>{entry.expiresAt=Date.now()+5000;},()=>{if(cached===entry)cached=null;});
  return promise;
}
function scopedSimProcesses(snapshot,root){
  root=path.resolve(root);
  return snapshot.processes.filter(p=>(p.cwd===root||p.cwd.startsWith(root+path.sep))&&!/\b(?:grep|ps -eo|bash -c)\b/.test(p.command)).map(p=>`${p.pid} ${p.command}`).join('\n');
}
module.exports={getSimHostStatus,scopedSimProcesses};
