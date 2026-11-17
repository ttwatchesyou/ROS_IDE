'use strict';
// Build ONLY a distributable source/UI bundle. Never include .env, DB or Sim workspaces.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const NOTES=require('./agent-release-notes');
const SOURCES=['image-tools.js','image-tools/helper.py','image-tools/adapters.py','image-tools/fat_marker.py','image-tools/prepare.py','image-tools/first_boot.py','image-tools/fat_seed.py','image-tools/passwords.py','image-tools/environment.py','image-tools/env_install.py','image-tools/Start-ImageHelper.ps1','image-tools/Start-ImageHelper.sh','image-tools/Start-ImageHelper.command','image-tools/README.md','image-tools/ICONS-LICENSE.txt','request-admission.js','pty-output-batcher.js','pty-json-stream.js','read-request-cache.js','navigation-sequence.js','navigation-sequence.py','agent.js','agent-native-check.js','agent-native-install.sh','agent-release-smoke.js','agent-runtime.js','agent-auto-update.js','agent-safe-update.py','agent-release-notes.js','agent-management.js','agent-update-jobs.js','local-runtime.js','lan-routing.js','server.js','sim.js','project-scanner.js','navigation-export.js','mapsim-runtime.js','mapsim-queue.js','mapsim-host-lock.js','sim-host-status.js','mapsim-job-store.js','real-robot-system.js','sim-navigation.py','sim-spatial.py','agent-install.sh','ONLINE_LOCAL_README.md','MECANUM_XY_README.md'];
const LOCAL_HARDWARE_ASSETS=['navigation-sequence.html','navigation-sequence.js','navigation-sequence.css','real-drive-motion.js','motor-control.html','motor-control.js','motor-control.css','hardware.html','hardware.js','transformation.js','mecanum-xy.js','mecanum-xy-source.js'];
const ASSETS={
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js':'xterm.js',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css':'xterm.css',
  'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js':'xterm-addon-fit.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js':'three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js':'OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js':'TransformControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/LICENSE':'THREE-LICENSE.txt',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/LICENSE':'XTERM-LICENSE.txt',
  'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/LICENSE':'XTERM-FIT-LICENSE.txt',
};
async function sourceDigest(root=__dirname){
  const hash=crypto.createHash('sha256');
  const files=[...SOURCES,'agent/package.json','agent/package-lock.json'];
  for(const entry of await fs.readdir(path.join(root,'public'),{withFileTypes:true}))if(entry.isFile()&&entry.name!=='index_backup.html')files.push('public/'+entry.name);
  for(const file of files.sort()){hash.update(file+'\0');hash.update(await fs.readFile(path.join(root,file)));}
  hash.update(JSON.stringify(ASSETS));
  return hash.digest('hex');
}
async function releaseVersion(root){
  const manifest=JSON.parse(await fs.readFile(path.join(root,'agent','package.json'),'utf8'));
  const lock=JSON.parse(await fs.readFile(path.join(root,'agent','package-lock.json'),'utf8'));
  const runtime=await fs.readFile(path.join(root,'agent-runtime.js'),'utf8');
  const declared=runtime.match(/const VERSION='([^']+)'/);
  if(!/^\d+\.\d+\.\d+$/.test(manifest.version)||declared?.[1]!==manifest.version||lock.version!==manifest.version||lock.packages?.['']?.version!==manifest.version)throw new Error('Agent version differs between runtime, package.json, and package-lock.json');
  return manifest.version;
}
async function build(root=__dirname,{quiet=false}={}){
  const version=await releaseVersion(root);
  const before=await sourceDigest(root);
  const stage=await fs.mkdtemp(path.join(os.tmpdir(),'roside-release-'));
  await fs.mkdir(path.join(stage,'public','vendor'),{recursive:true});
  for(const file of SOURCES){await fs.mkdir(path.dirname(path.join(stage,file)),{recursive:true});await fs.copyFile(path.join(root,file),path.join(stage,file));}
  for(const file of ['package.json','package-lock.json'])await fs.copyFile(path.join(root,'agent',file),path.join(stage,file));
  const hashes={};
  const previousArchive=path.join(root,'releases','agent-release.tar.gz');
  let previousAssets={};
  try{previousAssets=JSON.parse(execFileSync('tar',['-xOzf',previousArchive,'./public/vendor/manifest.json'],{maxBuffer:1024*1024}).toString());}catch{}
  await Promise.all(Object.entries(ASSETS).map(async([url,name])=>{
    let data;
    try{const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);data=Buffer.from(await response.arrayBuffer());}
    catch(error){
      if(previousAssets[name]?.url!==url)throw new Error(`Asset ${name}: ${error.message}`);
      data=execFileSync('tar',['-xOzf',previousArchive,'./public/vendor/'+name],{maxBuffer:8*1024*1024});
      if(crypto.createHash('sha256').update(data).digest('hex')!==previousAssets[name].sha256)throw new Error(`Cached asset ${name} failed checksum`);
    }
    if(data.length<50)throw new Error('Invalid asset '+name);
    await fs.writeFile(path.join(stage,'public','vendor',name),data);hashes[name]={url,sha256:crypto.createHash('sha256').update(data).digest('hex')};
  }));
  for(const entry of await fs.readdir(path.join(root,'public'),{withFileTypes:true})){
    if(!entry.isFile()||entry.name==='index_backup.html')continue;
    const from=path.join(root,'public',entry.name),to=path.join(stage,'public',entry.name);
    if(/\.(html|js|css)$/.test(entry.name)){
      let content=await fs.readFile(from,'utf8');
      for(const[url,name]of Object.entries(ASSETS))content=content.replaceAll(url,'/vendor/'+name);
      // System font fallbacks work on a fresh offline tablet, without Google Fonts.
      content=content.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^'"]*['"]\s*\)\s*;/g,'').replace(/<link\b[^>]*https:\/\/fonts\.googleapis\.com[^>]*>/g,'');
      await fs.writeFile(to,content);
    }else await fs.copyFile(from,to);
  }
  for(const file of LOCAL_HARDWARE_ASSETS){
    const content=await fs.readFile(path.join(stage,'public',file),'utf8');
    if(!content.trim())throw new Error('Missing Local hardware asset: '+file);
  }
  const after=await sourceDigest(root);
  if(before!==after)throw new Error('Agent source changed during release build; retry');
  await fs.writeFile(path.join(stage,'public','vendor','manifest.json'),JSON.stringify(hashes,null,2));
  const output=path.join(root,'releases');await fs.mkdir(output,{recursive:true});
  const archive=path.join(output,'agent-release.tar.gz.pending');
  execFileSync('tar',['-czf',archive,'-C',stage,'.']);
  const data=await fs.readFile(archive),digest=crypto.createHash('sha256').update(data).digest('hex'),info={version,sha256:digest,sourceSha256:after,archive:`/agent-release/${digest}.tar.gz`,bytes:data.length,builtAt:new Date().toISOString(),notes:NOTES};
  await fs.rename(archive,path.join(output,`agent-${digest}.tar.gz`));
  await fs.copyFile(path.join(output,`agent-${digest}.tar.gz`),path.join(output,'agent-release.tar.gz.pending'));
  await fs.rename(path.join(output,'agent-release.tar.gz.pending'),path.join(output,'agent-release.tar.gz'));
  await fs.writeFile(path.join(output,'agent-release.json.pending'),JSON.stringify(info,null,2));await fs.rename(path.join(output,'agent-release.json.pending'),path.join(output,'agent-release.json'));
  if(!quiet)console.log(JSON.stringify({...info,stage},null,2));return{...info,stage};
}
let building=null;
async function ensureRelease(root=__dirname){
  if(building)return building;
  building=(async()=>{
    const version=await releaseVersion(root);
    const digest=await sourceDigest(root);
    try{const info=JSON.parse(await fs.readFile(path.join(root,'releases','agent-release.json'),'utf8'));
      if(info.version===version&&info.sourceSha256===digest&&/^[a-f0-9]{64}$/.test(info.sha256)){
        const archive=await fs.readFile(path.join(root,'releases',`agent-${info.sha256}.tar.gz`));
        if(crypto.createHash('sha256').update(archive).digest('hex')===info.sha256)return info;
      }
    }catch{}
    return build(root,{quiet:true});
  })().finally(()=>{building=null;});
  return building;
}
if(require.main===module)build().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={build,ensureRelease,sourceDigest,SOURCES,ASSETS};
