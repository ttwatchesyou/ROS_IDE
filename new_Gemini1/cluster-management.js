'use strict';
const crypto=require('node:crypto');
const bcrypt=require('bcrypt');
const fs=require('node:fs');
const path=require('node:path');
const {mountClusterProvisioning}=require('./cluster-provisioning');
const {masterMetrics}=require('./cluster-master-metrics');
const {mountClusterBootstrap,revokeClusterCodes}=require('./cluster-bootstrap');

const clusterId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const validName=value=>typeof value==='string'&&value.trim().length>=2&&value.trim().length<=100;
const validLimit=value=>Number.isSafeInteger(Number(value))&&Number(value)>=1&&Number(value)<=10000;

async function ensureClusterSchema(db){
  const [existing]=await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='clusters' LIMIT 1");
  await db.query(`CREATE TABLE IF NOT EXISTS clusters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cluster_key VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    kind ENUM('master','worker') NOT NULL DEFAULT 'worker',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    max_users INT NOT NULL DEFAULT 20,
    max_sims INT NOT NULL DEFAULT 2,
    secret_hash CHAR(64) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS cluster_user_access (
    cluster_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('admin','user') NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(cluster_id,user_id),
    INDEX idx_cluster_user(user_id,cluster_id),
    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS cluster_sim_leases (
    robot_id INT NOT NULL PRIMARY KEY,
    cluster_id INT NOT NULL,
    lease_token CHAR(48) NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX idx_cluster_sim_capacity(cluster_id,expires_at),
    FOREIGN KEY(robot_id) REFERENCES robots(id) ON DELETE CASCADE,
    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
  )`);
  const [columns]=await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='robots' AND column_name='cluster_id' LIMIT 1");
  if(!columns.length)await db.query('ALTER TABLE robots ADD COLUMN cluster_id INT NULL, ADD INDEX idx_robots_cluster (cluster_id)');
  await db.query("INSERT IGNORE INTO clusters(id,cluster_key,name,kind,enabled,max_users,max_sims) VALUES(1,'MASTER','Master · ROS Sim','master',1,10000,230)");
  await db.query("UPDATE robots SET cluster_id=1 WHERE robot_key LIKE 'SIM-%' AND cluster_id IS NULL");
  if(!existing.length)await db.query("INSERT IGNORE INTO cluster_user_access(cluster_id,user_id,role) SELECT 1,id,'user' FROM users WHERE role<>'admin'");
}

function mountClusterManagement(app,{db,auth,sessions,closeOperationalSockets,closeRobotPresence,releaseSimRuntimeIfUnused,refreshStatusAccess,clusterBus}){
  mountClusterProvisioning(app,{db,auth});
  mountClusterBootstrap(app,{db,auth,clusterBus});
  const respond=(fn)=>async(req,res)=>{try{await fn(req,res);}catch(error){res.status(error.status||500).json({ok:false,error:error.message});}};
  const access=async(user,id)=>{
    if(user.role==='admin')return 'master';
    const [rows]=await db.query('SELECT role FROM cluster_user_access WHERE cluster_id=? AND user_id=?',[id,user.id]);
    return rows[0]?.role||null;
  };
  const requireAdmin=async(req,res)=>{
    const id=clusterId(req.params.id);if(!id){res.status(400).json({ok:false,error:'Invalid cluster'});return null;}
    const role=await access(req.user,id);
    if(req.user.role!=='admin'&&role!=='admin'){res.status(403).json({ok:false,error:'Cluster admin only'});return null;}
    const [rows]=await db.query('SELECT * FROM clusters WHERE id=?',[id]);
    if(!rows.length){res.status(404).json({ok:false,error:'Cluster not found'});return null;}
    return rows[0];
  };
  function revokeSessions(userId,robotKeys){
    for(const [sessionId,session] of sessions)if(session.userId===userId&&robotKeys.has(session.robotKey)){
      sessions.delete(sessionId);
      closeOperationalSockets(userId,session.robotKey,'Cluster access revoked');
      closeRobotPresence(userId,session.robotKey);
      releaseSimRuntimeIfUnused(session.robotKey);
    }
    refreshStatusAccess(userId);
  }
  app.get('/api/clusters/worker-binary',auth,(req,res)=>{
    if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    const binary=path.join(__dirname,'dist','roside-cluster-worker');
    if(!fs.existsSync(binary))return res.status(404).json({ok:false,error:'Worker binary has not been built on Master'});
    res.download(binary,'roside-cluster-worker');
  });
  app.get('/api/clusters/worker-installer',auth,(req,res)=>{
    if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    res.download(path.join(__dirname,'cluster-worker-install.sh'),'install.sh');
  });
  app.get('/api/clusters',auth,respond(async(req,res)=>{
    const sql=req.user.role==='admin'
      ?'SELECT c.id,c.cluster_key,c.name,c.kind,c.enabled,c.max_users,c.max_sims,c.created_at,(SELECT COUNT(*) FROM cluster_user_access a WHERE a.cluster_id=c.id) user_count,(SELECT COUNT(*) FROM robots r WHERE r.cluster_id=c.id AND r.robot_key LIKE \'SIM-%\') sim_count FROM clusters c ORDER BY c.id'
      :'SELECT c.id,c.cluster_key,c.name,c.kind,c.enabled,c.max_users,c.max_sims,c.created_at,a.role membership_role,(SELECT COUNT(*) FROM cluster_user_access x WHERE x.cluster_id=c.id) user_count,(SELECT COUNT(*) FROM robots r WHERE r.cluster_id=c.id AND r.robot_key LIKE \'SIM-%\') sim_count FROM clusters c JOIN cluster_user_access a ON a.cluster_id=c.id AND a.user_id=? ORDER BY c.id';
    const [rows]=await db.query(sql,req.user.role==='admin'?[]:[req.user.id]);
    const mainMetrics=rows.some(row=>row.kind==='master')?masterMetrics():null;
    res.json({ok:true,clusters:rows.map(row=>({...row,...(row.kind==='master'?{connected:true,metrics:mainMetrics}:{...clusterBus.details(row.id)}),...(req.user.role==='admin'&&row.kind==='worker'?{masterWorkspace:path.join(__dirname,'sim_ws',`CL-${row.id}`)}:{})})),masterAdmin:req.user.role==='admin'});
  }));
  app.post('/api/clusters',auth,respond(async(req,res)=>{
    if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    const {name,maxUsers=20,maxSims=2}=req.body||{};
    if(!validName(name)||!validLimit(maxUsers)||!validLimit(maxSims))return res.status(400).json({ok:false,error:'Name or limits are invalid'});
    const key='CL-'+crypto.randomBytes(20).toString('base64url'),secret=crypto.randomBytes(32).toString('base64url');
    const [result]=await db.query('INSERT INTO clusters(cluster_key,name,kind,max_users,max_sims,secret_hash) VALUES(?,?,\'worker\',?,?,?)',[key,name.trim(),Number(maxUsers),Number(maxSims),crypto.createHash('sha256').update(secret).digest('hex')]);
    res.status(201).json({ok:true,cluster:{id:result.insertId,clusterKey:key,name:name.trim(),maxUsers:Number(maxUsers),maxSims:Number(maxSims)},secret});
  }));
  app.patch('/api/clusters/:id',auth,respond(async(req,res)=>{
    if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    const id=clusterId(req.params.id),[rows]=id?await db.query('SELECT * FROM clusters WHERE id=?',[id]):[[]],current=rows[0];
    if(!current)return res.status(404).json({ok:false,error:'Cluster not found'});
    const name=req.body?.name??current.name,maxUsers=req.body?.maxUsers??current.max_users,maxSims=req.body?.maxSims??current.max_sims,enabled=req.body?.enabled===undefined?current.enabled:req.body.enabled===true?1:0;
    if(!validName(name)||!validLimit(maxUsers)||!validLimit(maxSims)||current.kind==='master'&&!enabled)return res.status(400).json({ok:false,error:'Invalid cluster settings'});
    const [[usage]]=await db.query('SELECT COUNT(*) count FROM cluster_user_access WHERE cluster_id=?',[id]);
    if(Number(maxUsers)<Number(usage.count))return res.status(409).json({ok:false,error:'Remove users before lowering the user limit'});
    const [[running]]=await db.query('SELECT COUNT(*) count FROM cluster_sim_leases WHERE cluster_id=? AND expires_at>NOW()',[id]);
    if(Number(maxSims)<Number(running.count))return res.status(409).json({ok:false,error:'Stop running Sim instances before lowering the Sim limit'});
    await db.query('UPDATE clusters SET name=?,max_users=?,max_sims=?,enabled=? WHERE id=?',[name.trim(),Number(maxUsers),Number(maxSims),enabled,id]);
    if(!enabled&&current.kind==='worker'){clusterBus.disconnect(id);revokeClusterCodes(id);}
    res.json({ok:true});
  }));
  app.post('/api/clusters/:id/rotate-key',auth,respond(async(req,res)=>{
    if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    const id=clusterId(req.params.id),[rows]=id?await db.query('SELECT kind FROM clusters WHERE id=?',[id]):[[]];
    if(rows[0]?.kind!=='worker')return res.status(400).json({ok:false,error:'Worker cluster only'});
    const secret=crypto.randomBytes(32).toString('base64url');
    await db.query('UPDATE clusters SET secret_hash=? WHERE id=?',[crypto.createHash('sha256').update(secret).digest('hex'),id]);
    clusterBus.disconnect(id);
    revokeClusterCodes(id);
    res.json({ok:true,secret});
  }));
  app.get('/api/clusters/:id/users',auth,respond(async(req,res)=>{
    const cluster=await requireAdmin(req,res);if(!cluster)return;
    const [rows]=await db.query('SELECT u.id,u.username,u.created_at,u.last_login,a.role FROM cluster_user_access a JOIN users u ON u.id=a.user_id WHERE a.cluster_id=? ORDER BY a.role,u.username',[cluster.id]);
    res.json({ok:true,users:rows,cluster:{id:cluster.id,name:cluster.name,maxUsers:cluster.max_users}});
  }));
  app.post('/api/clusters/:id/users',auth,respond(async(req,res)=>{
    const cluster=await requireAdmin(req,res);if(!cluster)return;
    if(!cluster.enabled)return res.status(409).json({ok:false,error:'Cluster is disabled'});
    const {username,password,role='user'}=req.body||{};
    if(!/^[A-Za-z0-9_.-]{3,64}$/.test(username||'')||typeof password!=='string'||password.length<12||!['user','admin'].includes(role))return res.status(400).json({ok:false,error:'Username, password or role is invalid'});
    if(role==='admin'&&req.user.role!=='admin')return res.status(403).json({ok:false,error:'Only Master may assign a Cluster admin'});
    const hash=await bcrypt.hash(password,10),conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[locked]]=await conn.query('SELECT id,max_users FROM clusters WHERE id=? AND enabled=1 FOR UPDATE',[cluster.id]);
      if(!locked)throw Object.assign(new Error('Cluster is unavailable'),{status:409});
      const [[count]]=await conn.query('SELECT COUNT(*) total FROM cluster_user_access WHERE cluster_id=?',[cluster.id]);
      if(count.total>=locked.max_users)throw Object.assign(new Error('Cluster user limit reached'),{status:409});
      const [result]=await conn.query("INSERT INTO users(username,password,role) VALUES(?,?,'user')",[username,hash]);
      await conn.query('INSERT INTO cluster_user_access(cluster_id,user_id,role) VALUES(?,?,?)',[cluster.id,result.insertId,role]);
      await conn.commit();res.status(201).json({ok:true,id:result.insertId});
    }catch(error){await conn.rollback().catch(()=>{});if(error.code==='ER_DUP_ENTRY')error=Object.assign(new Error('Username already exists'),{status:409});throw error;}
    finally{conn.release();}
  }));
  app.post('/api/clusters/:id/members',auth,respond(async(req,res)=>{
    if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    const id=clusterId(req.params.id),username=String(req.body?.username||'').trim(),role=req.body?.role||'user';
    if(!id||!username||!['admin','user'].includes(role))return res.status(400).json({ok:false,error:'Invalid member'});
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[cluster]]=await conn.query('SELECT id,max_users FROM clusters WHERE id=? AND enabled=1 FOR UPDATE',[id]);
      if(!cluster)throw Object.assign(new Error('Cluster not found or disabled'),{status:404});
      const [[count]]=await conn.query('SELECT COUNT(*) total FROM cluster_user_access WHERE cluster_id=?',[id]);
      const [[user]]=await conn.query('SELECT id,role FROM users WHERE username=?',[username]);
      if(!user||user.role==='admin')throw Object.assign(new Error('User not found or is a Master admin'),{status:404});
      const [previous]=await conn.query('SELECT role FROM cluster_user_access WHERE cluster_id=? AND user_id=?',[id,user.id]);
      if(!previous.length&&count.total>=cluster.max_users)throw Object.assign(new Error('Cluster user limit reached'),{status:409});
      await conn.query('INSERT INTO cluster_user_access(cluster_id,user_id,role) VALUES(?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)',[id,user.id,role]);
      await conn.commit();res.json({ok:true,userId:user.id});
    }catch(error){await conn.rollback().catch(()=>{});throw error;}
    finally{conn.release();}
  }));
  app.post('/api/clusters/:id/users/:userId/password',auth,respond(async(req,res)=>{
    const cluster=await requireAdmin(req,res);if(!cluster)return;
    const userId=clusterId(req.params.userId),password=req.body?.password;
    if(!userId||typeof password!=='string'||password.length<12)return res.status(400).json({ok:false,error:'Invalid password'});
    const [rows]=await db.query('SELECT role FROM cluster_user_access WHERE cluster_id=? AND user_id=?',[cluster.id,userId]);
    if(!rows.length)return res.status(404).json({ok:false,error:'User not found in cluster'});
    if(rows[0].role==='admin'&&req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    await db.query('UPDATE users SET password=? WHERE id=?',[await bcrypt.hash(password,10),userId]);
    await db.query('DELETE FROM sessions WHERE user_id=?',[userId]);
    revokeSessions(userId,new Set([...sessions.values()].filter(session=>session.userId===userId).map(session=>session.robotKey)));
    res.json({ok:true});
  }));
  app.delete('/api/clusters/:id/users/:userId',auth,respond(async(req,res)=>{
    const cluster=await requireAdmin(req,res);if(!cluster)return;
    const userId=clusterId(req.params.userId);
    if(!userId||userId===req.user.id)return res.status(400).json({ok:false,error:'Cannot remove this user'});
    const [rows]=await db.query('SELECT role FROM cluster_user_access WHERE cluster_id=? AND user_id=?',[cluster.id,userId]);
    if(!rows.length)return res.status(404).json({ok:false,error:'User not found in cluster'});
    if(rows[0].role==='admin'&&req.user.role!=='admin')return res.status(403).json({ok:false,error:'Master admin only'});
    const [robots]=await db.query('SELECT robot_key FROM robots WHERE cluster_id=?',[cluster.id]);
    await db.query('DELETE FROM cluster_user_access WHERE cluster_id=? AND user_id=?',[cluster.id,userId]);
    revokeSessions(userId,new Set(robots.map(robot=>robot.robot_key)));
    res.json({ok:true});
  }));
  return {access};
}
module.exports={ensureClusterSchema,mountClusterManagement};
