'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {WebSocketServer,WebSocket}=require('ws');
const {ClusterWorkerBus}=require('../cluster-worker-bus');
const {createWorker}=require('../cluster-worker');

test('Worker authenticates to Master, runs only assigned Sim, and disconnects cleanly',async()=>{
  const mount=fs.mkdtempSync(path.join(os.tmpdir(),'roside-cluster-test-'));
  const key='SIM-C2-1234567890abcdef',masterRoot=`/master/sim_ws/CL-2/${key}`;
  fs.mkdirSync(path.join(mount,key));
  const secret=crypto.randomBytes(32).toString('base64url');
  const clusterKey='CL-'+crypto.randomBytes(20).toString('base64url');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  const db={query:async(_sql,params)=>[[{id:2,secret_hash:crypto.createHash('sha256').update(secret).digest('hex')}]]};
  const bus=new ClusterWorkerBus({db,WebSocket});
  server.on('connection',socket=>bus.attach(socket));
  await new Promise(resolve=>server.once('listening',resolve));
  const worker=createWorker({master_url:`ws://127.0.0.1:${server.address().port}`,cluster_key:clusterKey,cluster_secret:secret,workspace_root:mount});
  try{
    worker.start();
    const until=Date.now()+5000;
    while(!bus.connected(2)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(bus.connected(2),true);
    assert.equal(bus.details(2).version,'1.1.0');
    assert.ok(bus.details(2).metrics.memTotalMb>0);
    const result=await bus.request(2,'exec',{robotKey:key,masterRoot,domain:43,command:'printf "%s %s" "$ROS_DOMAIN_ID" "$HOME"'});
    assert.equal(result.code,0);
    assert.equal(result.stdout,`43 ${path.join(mount,key)}`);
    await assert.rejects(bus.request(2,'exec',{robotKey:'SIM-C3-1234567890abcdef',masterRoot,domain:43,command:'true'}),/not assigned/);
    assert.equal((await bus.request(2,'host_status',{robotKey:key,masterRoot})).stdout.includes('MEM='),true);
  }finally{
    worker.stop();bus.workers.get(2)?.ws.terminate();clearInterval(bus.watchdog);
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(mount,{recursive:true,force:true});
  }
});
