'use strict';
const crypto=require('node:crypto');
function cleanMetrics(value){
  if(!value||typeof value!=='object')return null;
  const cpu=value.cpuPercent,used=value.memUsedMb,total=value.memTotalMb;
  if(!Number.isFinite(used)||!Number.isFinite(total)||total<=0||used<0||used>total||cpu!==null&&(!Number.isFinite(cpu)||cpu<0||cpu>100))return null;
  return{cpuPercent:cpu,memUsedMb:used,memTotalMb:total};
}

class ClusterWorkerBus{
  constructor({db,WebSocket}){this.db=db;this.WebSocket=WebSocket;this.workers=new Map();this.pending=new Map();this.ptyHandlers=new Map();this.watchdog=setInterval(()=>{for(const worker of this.workers.values())if(Date.now()-worker.lastSeen>=35000)worker.ws.close(1011,'Cluster heartbeat timed out');},10000);this.watchdog.unref?.();}
  connected(id){const entry=this.workers.get(Number(id));return Boolean(entry&&entry.ws.readyState===this.WebSocket.OPEN&&Date.now()-entry.lastSeen<35000);}
  details(id){const entry=this.workers.get(Number(id));return entry&&this.connected(id)?{connected:true,hostname:entry.hostname,version:entry.version,connectedAt:entry.connectedAt,metrics:entry.metrics&&Date.now()-entry.metricsAt<35000?entry.metrics:null}: {connected:false,metrics:null};}
  onPty(robotKey,handler){this.ptyHandlers.set(robotKey,handler);return()=>{if(this.ptyHandlers.get(robotKey)===handler)this.ptyHandlers.delete(robotKey);};}
  attach(ws){
    let clusterId=null;
    const timeout=setTimeout(()=>{if(!clusterId)ws.close(1008,'Cluster authentication timeout');},10000);timeout.unref?.();
    ws.on('message',async raw=>{
      let msg;try{msg=JSON.parse(String(raw));}catch{return ws.close(1008,'Invalid cluster message');}
      if(!clusterId){
        if(msg.type!=='cluster_auth'||!/^CL-[A-Za-z0-9_-]{20,60}$/.test(String(msg.clusterKey||''))||typeof msg.secret!=='string')return ws.close(1008,'Invalid cluster credentials');
        try{
          const [rows]=await this.db.query("SELECT id,secret_hash FROM clusters WHERE cluster_key=? AND kind='worker' AND enabled=1",[msg.clusterKey]);
          const expected=rows[0]?.secret_hash||'',actual=crypto.createHash('sha256').update(msg.secret).digest('hex');
          if(expected.length!==actual.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(actual)))return ws.close(1008,'Cluster authentication failed');
          clusterId=rows[0].id;clearTimeout(timeout);
          const old=this.workers.get(clusterId);if(old&&old.ws!==ws&&old.ws.readyState===this.WebSocket.OPEN)return ws.close(1008,'Cluster already connected');
          const metrics=cleanMetrics(msg.metrics);
          this.workers.set(clusterId,{ws,hostname:String(msg.hostname||'').slice(0,100),version:String(msg.version||'').slice(0,32),connectedAt:Date.now(),lastSeen:Date.now(),metrics,metricsAt:metrics?Date.now():0});
          ws.send(JSON.stringify({type:'cluster_auth_ok',clusterId}));
          this.onConnect?.(clusterId);
        }catch{ws.close(1011,'Cluster authentication unavailable');}
        return;
      }
      if(this.workers.get(clusterId)?.ws!==ws)return ws.close(1008,'Worker replaced');
      this.workers.get(clusterId).lastSeen=Date.now();
      if(msg.type==='reply'){
        const pending=this.pending.get(msg.id);if(!pending||pending.clusterId!==clusterId)return;
        this.pending.delete(msg.id);clearTimeout(pending.timer);
        msg.ok?pending.resolve(msg.result):pending.reject(new Error(String(msg.error||'Worker request failed')));
      }else if(msg.type==='pty_output'||msg.type==='pty_closed'){
        const handler=this.ptyHandlers.get(msg.robotKey);if(handler)handler(msg);
      }else if(msg.type==='heartbeat'){
        const metrics=cleanMetrics(msg.metrics);
        if(metrics){const entry=this.workers.get(clusterId);entry.metrics=metrics;entry.metricsAt=Date.now();}
        ws.send(JSON.stringify({type:'heartbeat_ack',at:Date.now()}));
      }
    });
    ws.on('close',()=>{
      clearTimeout(timeout);
      if(clusterId&&this.workers.get(clusterId)?.ws===ws){this.workers.delete(clusterId);for(const [id,pending] of this.pending)if(pending.clusterId===clusterId){clearTimeout(pending.timer);pending.reject(new Error('Cluster disconnected'));this.pending.delete(id);}this.onDisconnect?.(clusterId);}
    });
  }
  request(clusterId,action,payload={},timeoutMs=30000){
    clusterId=Number(clusterId);const entry=this.workers.get(clusterId);
    if(!entry||!this.connected(clusterId))return Promise.reject(new Error('Cluster offline'));
    if(!['exec','launch','pty_init','pty_input','pty_resize','pty_close','host_status'].includes(action))return Promise.reject(new Error('Unsupported cluster action'));
    return new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(),timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Cluster request timed out'));},Math.min(Math.max(Number(timeoutMs)||30000,1000),310000));
      this.pending.set(id,{clusterId,resolve,reject,timer});
      try{entry.ws.send(JSON.stringify({type:'command',id,action,payload}));}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  disconnect(id){const entry=this.workers.get(Number(id));if(entry)entry.ws.close(4002,'Cluster key rotated');}
}
module.exports={ClusterWorkerBus};
