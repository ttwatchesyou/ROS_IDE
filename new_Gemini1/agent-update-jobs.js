'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const STAGES={preparing:[5,'กำลังปิดเครื่องมือและรอให้งานเดิมจบ'],checking:[12,'ตรวจสอบระบบบนหุ่นยนต์'],downloading:[25,'ดาวน์โหลด Agent รุ่นใหม่'],verifying:[40,'ตรวจสอบไฟล์ที่ดาวน์โหลด'],installing:[55,'ติดตั้ง dependencies — ขั้นตอนนี้อาจใช้เวลาหลายนาที'],restarting:[80,'รีสตาร์ต Agent การเชื่อมต่อจะขาดชั่วคราว'],ready:[95,'ติดตั้งแล้ว กำลังยืนยัน Agent เชื่อมกลับมา'],succeeded:[100,'อัปเดตสำเร็จ Agent รุ่นใหม่เชื่อมต่อแล้ว']};
const terminal=job=>!job||['succeeded','failed'].includes(job.stage);
const digest=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
class AgentUpdateJobs{
  constructor(directory){this.directory=directory;this.jobs=new Map();if(!directory)return;try{for(const name of fs.readdirSync(directory)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;try{const job=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));if(job.robotKey)this.jobs.set(job.robotKey,job);}catch{}}}catch{}}
  save(job){if(this.directory){fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const file=path.join(this.directory,digest(job.robotKey)+'.json');fs.writeFileSync(file+'.pending',JSON.stringify(job),{mode:0o600});fs.renameSync(file+'.pending',file);}this.jobs.set(job.robotKey,job);return job;}
  get(key){return this.jobs.get(key)||null;}
  busy(key){return !terminal(this.get(key));}
  create(key,userId,version,sha256=null){const token=crypto.randomBytes(32).toString('hex'),job={id:crypto.randomUUID(),robotKey:key,userId,targetVersion:version,targetSha256:sha256,tokenHash:digest(token),createdAt:Date.now(),updatedAt:Date.now(),stage:'preparing',progress:5,message:STAGES.preparing[1]};this.save(job);return{job,token};}
  change(job,stage,message){if(terminal(job)&&job.stage!==stage)return job;if(stage!=='failed'&&(!STAGES[stage]||STAGES[stage][0]<job.progress))return job;job.stage=stage;job.progress=stage==='failed'?job.progress:STAGES[stage][0];job.message=message||STAGES[stage]?.[1]||'อัปเดตไม่สำเร็จ';job.updatedAt=Date.now();if(stage==='restarting')job.restartingAt=Date.now();return this.save(job);}
  report(id,token,stage){const job=[...this.jobs.values()].find(j=>j.id===id);if(!job||typeof token!=='string'||digest(token)!==job.tokenHash)return null;if(!['checking','downloading','verifying','installing','restarting','ready','failed'].includes(stage))return null;
    const reasons={checking:'ตรวจระบบไม่ผ่าน: ต้องมี Node.js 20+, npm และ systemd user ที่ใช้งานได้',downloading:'ดาวน์โหลดไม่สำเร็จ: ตรวจว่าเครื่องหุ่นยนต์เข้าถึง URL ของ ROSIDE และอินเทอร์เน็ตได้',verifying:'ตรวจไฟล์ไม่ผ่าน: ไฟล์อาจไม่ครบหรือ release เปลี่ยนระหว่างดาวน์โหลด กรุณาลองใหม่',installing:'ติดตั้ง dependencies ไม่สำเร็จ: ตรวจอินเทอร์เน็ต พื้นที่ว่าง และเครื่องมือ build สำหรับ node-pty',restarting:'Agent ใหม่เริ่มทำงานไม่สำเร็จ: ตัวติดตั้งพยายามคืน service เดิมแล้ว'};
    if(!terminal(job))this.change(job,stage,stage==='failed'?(reasons[job.stage]||'ตัวติดตั้งทำงานไม่สำเร็จ ยังไม่ยืนยันว่าอัปเดตสำเร็จ กรุณาลองใหม่'):undefined);return job;}
  view(job){if(!job)return null;return{id:job.id,stage:job.stage,progress:job.progress,message:job.message,targetVersion:job.targetVersion,active:!terminal(job),createdAt:job.createdAt,updatedAt:job.updatedAt};}
}
module.exports={AgentUpdateJobs,STAGES,terminal};
