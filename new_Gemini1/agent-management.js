'use strict';
const {ReadRequestCache}=require('./read-request-cache');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {VERSION}=require('./agent-runtime');
const NOTES=require('./agent-release-notes');
const {AgentUpdateJobs,terminal}=require('./agent-update-jobs');
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
function releaseInfo(root){
  try{const file=path.join(root,'releases','agent-release.json'),info=JSON.parse(fs.readFileSync(file,'utf8'));if(!/^\d+\.\d+\.\d+$/.test(info.version)||!/^[a-f0-9]{64}$/.test(info.sha256))return null;return info;}catch{return null;}
}
function mountAgentManagement(app,{auth,getOwnedSess,accessibleRobot,isSim,agents,agentReq,maintenanceReq=agentReq,webSockets,monSockets,pendingReqs,localRuntime,root,publicUrl=''}){
  const updates=new AgentUpdateJobs(localRuntime?null:path.join(root,'tmp','agent-updates')),polls=new Map();
  for(const job of updates.jobs.values())if(['preparing','checking'].includes(job.stage)&&!job.launchedAt)updates.change(job,'failed','เซิร์ฟเวอร์เริ่มใหม่ระหว่างเตรียมอัปเดต กรุณากดอัปเดตอีกครั้ง');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const busy=key=>!isSim(key)&&updates.busy(key);
  async function inspect(job){
    if(!job||terminal(job))return;
    if(polls.has(job.id))return polls.get(job.id);
    const run=(async()=>{
      const ag=agents.get(job.robotKey);
      if(ag&&ag.version===job.targetVersion&&ag.connectedAt>job.createdAt&&(job.stage==='ready'||job.legacy)){
        const status=await maintenanceReq(job.robotKey,'agent_status',{},5000);
        if(status.version===job.targetVersion&&(!job.targetSha256||status.releaseSha256===job.targetSha256))updates.change(job,'succeeded');
        return;
      }
      if(Date.now()-job.createdAt>30*60*1000){updates.change(job,'failed','รออัปเดตเกิน 30 นาที กรุณาตรวจเครือข่ายแล้วลองอีกครั้ง (ยังไม่ยืนยันว่าอัปเดตสำเร็จ)');return;}
      if(!ag||!job.launchedAt||Date.now()-(job.lastPoll||0)<3000)return;
      job.lastPoll=Date.now();
      const unit=job.legacy?'ros2ide-agent-update':`ros2ide-agent-update-${job.id}`;
      const result=await maintenanceReq(job.robotKey,'exec',{command:`systemctl --user show ${quote(unit)} --property=ActiveState --property=Result --property=LoadState --no-pager; if [ -f "$HOME/.ros2ide/update-progress.json" ]; then head -c 2048 "$HOME/.ros2ide/update-progress.json"; fi`,timeout:4000},6000);
      const record=result.stdout.match(/\{"jobId"[^\n]+/);if(record){try{const data=JSON.parse(record[0]);if(data.jobId===job.id&&['checking','downloading','verifying','installing','restarting','ready','failed'].includes(data.stage))updates.change(job,data.stage);}catch{}}
      if(!terminal(job)&&/Result=(exit-code|signal|timeout|resources|start-limit-hit)/.test(result.stdout))updates.change(job,'failed','อัปเดตไม่สำเร็จ ตัวติดตั้งหยุดทำงาน ตรวจการเชื่อมต่อ/Node.js/npm แล้วกด “ลองอัปเดตอีกครั้ง”');
      else if(!terminal(job)&&job.stage!=='ready'&&Date.now()-job.launchedAt>15000&&(/LoadState=not-found/.test(result.stdout)||/ActiveState=(inactive|failed)/.test(result.stdout)))updates.change(job,'failed','ตัวติดตั้งจบแล้ว แต่ยังไม่พบ Agent รุ่นใหม่เชื่อมกลับมา สามารถลองอัปเดตใหม่ได้');
    })().catch(()=>{}).finally(()=>polls.delete(job.id));polls.set(job.id,run);return run;
  }
  const physical=async(req,res)=>{
    let s;
    if(req.params?.id!==undefined){
      if(localRuntime){res.status(400).json({ok:false,error:'Update from Cloud'});return null;}
      const id=Number(req.params.id);
      const robot=Number.isSafeInteger(id)&&id>0?await accessibleRobot(req.user,id):null;
      s=robot?{robotKey:robot.robot_key}:null;
    }else s=getOwnedSess(req);
    if(!s){res.status(403).json({ok:false,error:'Robot or session not found or forbidden'});return null;}
    if(isSim(s.robotKey)){res.status(400).json({ok:false,error:'Physical robots only; Sim is unchanged'});return null;}
    return s;
  };
  const releaseInspection=new ReadRequestCache({ttlMs:1000,limit:4});
  const freshRelease=async(force=false)=>{if(force)releaseInspection.clear();return releaseInspection.get('release',async()=>{if(root===__dirname&&!localRuntime)await require('./build-agent-release').ensureRelease(root);return releaseInfo(root);});};
  app.get('/agent-release.json',async(_,res)=>{try{const info=await freshRelease();if(!info)return res.status(503).json({ok:false,error:'Agent release is not built'});res.json(info);}catch(error){res.status(503).json({ok:false,error:error.message});}});
  app.get('/agent-release.tar.gz',async(_,res)=>{try{const info=await freshRelease();if(!info)return res.status(503).end();const named=path.join(root,'releases',`agent-${info.sha256}.tar.gz`);res.sendFile(fs.existsSync(named)?named:path.join(root,'releases','agent-release.tar.gz'));}catch{res.status(503).end();}});
  app.get('/agent-release/:sha.tar.gz',(req,res)=>{const sha=String(req.params.sha||'');if(!/^[a-f0-9]{64}$/.test(sha))return res.status(404).end();const file=path.join(root,'releases',`agent-${sha}.tar.gz`);if(!fs.existsSync(file))return res.status(404).end();res.sendFile(file);});
  app.get('/agent-install.sh',(req,res)=>res.type('text/plain').sendFile(path.join(root,'agent-install.sh')));
  app.post('/api/agent-update/report',(req,res)=>{
    const job=updates.report(req.body?.jobId,req.headers['x-update-token'],req.body?.stage);
    if(!job)return res.status(403).json({ok:false,error:'Invalid update report'});
    res.json({ok:true});
  });
  const updateStatusHandler=async(req,res)=>{
    const s=await physical(req,res);if(!s)return;const job=updates.get(s.robotKey);await inspect(job);
    res.json({ok:true,update:updates.view(job),online:!!agents.get(s.robotKey),version:agents.get(s.robotKey)?.version||null});
  };
  app.post('/api/real/agent/update-status',auth,updateStatusHandler);
  app.post('/api/robots/:id/agent/update-status',auth,updateStatusHandler);
  const statusHandler=async(req,res)=>{
    const s=await physical(req,res);if(!s)return;
    const ag=agents.get(s.robotKey),modern=ag?.capabilities?.includes('local-ide');
    try{const job=updates.get(s.robotKey);await inspect(job);const detail=modern?await maintenanceReq(s.robotKey,'agent_status',{}):{};const release=await freshRelease();res.json({ok:true,version:ag?.version||'legacy / ไม่รายงานเวอร์ชัน',legacy:!modern,latestVersion:release?.version||VERSION,latestReleaseSha256:release?.sha256||null,releaseNotes:release?.notes||NOTES,updateAvailable:!!release&&(ag?.version!==release.version||detail.releaseSha256!==release.sha256),connection:localRuntime?'local':'online',update:updates.view(job),...detail});}
    catch(e){res.status(503).json({ok:false,error:e.message});}
  };
  app.post('/api/real/agent/status',auth,statusHandler);
  app.post('/api/robots/:id/agent/status',auth,statusHandler);
  app.post('/api/real/agent/mode',auth,async(req,res)=>{
    const s=await physical(req,res);if(!s)return;
    if(!agents.get(s.robotKey)?.capabilities?.includes('control-mode-v1'))return res.status(409).json({ok:false,error:'Legacy Agent remains Online; update Agent to enable Local mode'});
    try{const status=await agentReq(s.robotKey,'control_select',{mode:localRuntime?'local':'online',confirm:req.body.confirm===true});res.json({ok:true,...status});}
    catch(e){res.status(409).json({ok:false,error:e.message});}
  });
  app.post('/api/real/agent/auto-update',auth,async(req,res)=>{
    const s=await physical(req,res);if(!s)return;
    if(!agents.get(s.robotKey)?.capabilities?.includes('auto-update-v1'))return res.status(409).json({ok:false,error:'Update Agent manually once before enabling automatic updates'});
    try{res.json({ok:true,...await agentReq(s.robotKey,'auto_update_config',{topic:req.body.topic})});}
    catch(e){res.status(409).json({ok:false,error:e.message});}
  });
  for(const [route,action]of [['read','library_read'],['write','library_write']])app.post('/api/real/library/'+route,auth,async(req,res)=>{
    const s=await physical(req,res);if(!s)return;
    if(!agents.get(s.robotKey)?.capabilities?.includes('library-v1'))return res.status(409).json({ok:false,error:'Update Agent to store the shared library on this robot'});
    try{res.json({ok:true,...await agentReq(s.robotKey,action,req.body)});}catch(e){res.status(409).json({ok:false,error:e.message});}
  });
  const updateHandler=async(req,res)=>{
    const s=await physical(req,res);if(!s)return;
    if(localRuntime)return res.status(400).json({ok:false,error:'Update from Online mode or run the installer on the robot'});
    if(req.body.confirm!==true)return res.status(400).json({ok:false,error:'Confirm update with robot safely stopped'});
    let info;try{info=await freshRelease(true);}catch(e){return res.status(503).json({ok:false,error:e.message});}if(!info)return res.status(503).json({ok:false,error:'Agent release is not built'});
    const prior=updates.get(s.robotKey);if(!terminal(prior))return res.json({ok:true,accepted:true,update:updates.view(prior)});
    if(!agents.get(s.robotKey))return res.status(409).json({ok:false,error:'หุ่นยนต์ยังไม่เชื่อมต่อ กรุณารอให้เชื่อมต่อก่อน'});
    let origin;
    try{
      const browserOrigin=req.headers.origin&&new URL(req.headers.origin).host===req.headers.host?req.headers.origin:null;
      origin=new URL(process.env.PUBLIC_URL||publicUrl||browserOrigin||`${req.protocol}://${req.headers.host}`);
      if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new Error('Invalid server public URL');
    }catch(e){return res.status(400).json({ok:false,error:e.message});}
    const {job,token}=updates.create(s.robotKey,req.user.id,info.version,info.sha256);
    res.status(202).json({ok:true,accepted:true,update:updates.view(job)});
    (async()=>{
      // The user explicitly confirmed a stopped robot and closing tools in all tabs.
      for(const [id,socket] of [...webSockets.entries(),...monSockets.entries()])if(socket.robotKey===s.robotKey){
        try{agents.get(s.robotKey)?.ws?.send(JSON.stringify({type:'pty_close',termId:socket.termId||id}));}catch{}
        try{socket.send(JSON.stringify({type:'error',message:'กำลังอัปเดต Agent ปิดการเชื่อมต่อเครื่องมือนี้ชั่วคราว'}));socket.close(1008,'Agent updating');}catch{}
      }
      const deadline=Date.now()+90000;
      while([...pendingReqs.values()].some(cb=>cb.robotKey===s.robotKey)){if(Date.now()>deadline)throw new Error('งานเดิมยังไม่จบภายใน 90 วินาที ไม่ได้หยุด Build กลางทาง กรุณารอแล้วลองอัปเดตอีกครั้ง');await pause(250);}
      // Give WebSocket close/PTY cleanup a chance to reach the robot.
      await pause(350);
      if(agents.get(s.robotKey)?.capabilities?.includes('control-mode-v1')){
        const state=await maintenanceReq(s.robotKey,'agent_status',{});
        if(state.autoUpdate?.active)throw new Error('Agent กำลังอัปเดตอัตโนมัติอยู่แล้ว');
        if(state.busy||state.terminals)throw new Error('ยังมีงาน/Terminal บนหุ่นอยู่ กรุณาปิดก่อนอัปเดต');
        if(state.mode==='local')await maintenanceReq(s.robotKey,'control_select',{mode:'online',confirm:true},5000);
        else if(state.mode!=='online')throw new Error('ไม่ทราบโหมด Agent กรุณาตรวจสถานะอีกครั้ง');
      }
      updates.change(job,'checking');
      const old=await maintenanceReq(s.robotKey,'exec',{command:'systemctl --user is-active --quiet ros2ide-agent-update',timeout:4000},6000);
      if(old.code===0){job.legacy=true;job.launchedAt=Date.now();updates.change(job,'installing','กำลังติดตามคำขออัปเดตเดิม ไม่เริ่มติดตั้งซ้ำ');return;}
      const installer=fs.readFileSync(path.join(root,'agent-install.sh'));
      const digest=crypto.createHash('sha256').update(installer).digest('hex');
      const command=`set -e; task_dir=$(mktemp -d); curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 ${quote(origin.origin+'/agent-install.sh')} -o "$task_dir/install.sh"; printf '%s  %s\\n' ${quote(digest)} "$task_dir/install.sh" | sha256sum -c -; ROSIDE_UPDATE_JOB=${quote(job.id)} ROSIDE_UPDATE_TOKEN=${quote(token)} ROSIDE_UPDATE_REPORT=${quote(origin.origin+'/api/agent-update/report')} ROSIDE_EXPECT_SHA256=${quote(info.sha256)} CLOUD_URL=${quote(origin.origin)} ROSIDE_NONINTERACTIVE=1 bash "$task_dir/install.sh"`;
      // systemd owns the update so replacing/restarting the legacy Agent cannot kill it.
      job.launchedAt=Date.now();updates.save(job);
      const result=await maintenanceReq(s.robotKey,'exec',{command:`systemd-run --user --unit=ros2ide-agent-update-${job.id} /bin/bash -lc ${quote(command)}`,timeout:15000},20000);
      if(result.code!==0)throw new Error(result.stderr||result.stdout||'Unable to start updater');
      updates.save(job);
    })().catch(e=>updates.change(job,'failed',e.message));
  };
  app.post('/api/real/agent/update',auth,updateHandler);
  app.post('/api/robots/:id/agent/update',auth,updateHandler);
  const timer=!localRuntime?setInterval(()=>{for(const job of updates.jobs.values())if(!terminal(job))void inspect(job);},3000):null;timer?.unref?.();
  return{busy,close:()=>clearInterval(timer)};
}
module.exports={mountAgentManagement,releaseInfo};
