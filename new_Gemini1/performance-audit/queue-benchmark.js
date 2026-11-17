'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {MapsimJobStore}=require('../mapsim-job-store');
const results=[];
for(const count of [20,100,230]){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-queue-audit-'));
  const original=fs.readFileSync;
  try{
    const store=new MapsimJobStore(directory),ids=[];
    for(let i=0;i<count;i++){const id=crypto.randomUUID();ids.push(id);store.write({id,key:'benchmark-'+i,order:String(i).padStart(24,'0'),state:'queued',phase:'queued',createdAt:Date.now()});}
    let reads=0;fs.readFileSync=function(file,...args){if(String(file).startsWith(directory)||String(file).startsWith('/proc/'))reads++;return original.call(this,file,...args);};
    const start=performance.now();for(let i=0;i<20;i++)store.position(ids.at(-1));const elapsed=performance.now()-start;
    results.push({queuedJobs:count,positionLookups:20,totalMs:elapsed,msPerLookup:elapsed/20,readsPerLookup:reads/20});
  }finally{fs.readFileSync=original;fs.rmSync(directory,{recursive:true,force:true});}
}
console.log(JSON.stringify(results,null,2));
