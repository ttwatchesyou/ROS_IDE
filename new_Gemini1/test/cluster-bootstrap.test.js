'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const {mountClusterBootstrap}=require('../cluster-bootstrap');

test('temporary install code delivers only its Cluster config and revokes the previous code',async()=>{
  const secret=crypto.randomBytes(32).toString('base64url');
  const app=express();app.use(express.json());
  const db={query:async()=>[[{id:2,cluster_key:'CL-'+crypto.randomBytes(20).toString('base64url'),secret_hash:crypto.createHash('sha256').update(secret).digest('hex'),kind:'worker',enabled:1}]]};
  mountClusterBootstrap(app,{db,auth:(req,_res,next)=>{req.user={role:'admin'};next();},prepareWorkspace:()=>{}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const script=await fetch(base+'/api/cluster-bootstrap/bootstrap.sh');
    assert.equal(script.status,200);
    const scriptText=await script.text();
    assert.match(scriptText,/รหัสติดตั้งชั่วคราวจากหน้า Cluster/);
    assert.doesNotMatch(scriptText,/read -r -p 'NFS source/);
    const settings={masterUrl:'wss://master.example',workspaceRoot:'/srv/roside-cluster/workspaces',secret};
    const issue=()=>fetch(base+'/api/clusters/2/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}).then(response=>response.json());
    const first=await issue();
    assert.match(first.code,/^[A-Za-z0-9_-]{24}$/);
    const config=async code=>fetch(base+'/api/cluster-bootstrap/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const accepted=await config(first.code);
    assert.equal(accepted.status,200);
    const acceptedConfig=await accepted.json();
    assert.equal(acceptedConfig.cluster_secret,secret);
    assert.match(acceptedConfig.nfs_source,/^master\.example:.*\/sim_ws\/CL-2$/);
    assert.equal(acceptedConfig.workspace_gid,40002);
    const second=await issue();
    assert.notEqual(first.code,second.code);
    assert.equal((await config(first.code)).status,403);
    assert.equal((await config(second.code)).status,200);
    assert.equal((await config('invalid')).status,403);
    assert.equal((await fetch(base+'/api/cluster-bootstrap/worker')).status,403);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('install code can be issued after page reload without entering the Worker key',async()=>{
  const app=express();app.use(express.json());
  let secretHash=crypto.createHash('sha256').update('old-key').digest('hex');
  const db={query:async(sql,args=[])=>{
    if(sql.startsWith('UPDATE clusters')){secretHash=args[0];return [{}];}
    return [[{id:3,cluster_key:'CL-'+crypto.randomBytes(20).toString('base64url'),secret_hash:secretHash,kind:'worker',enabled:1}]];
  }};
  mountClusterBootstrap(app,{db,auth:(req,_res,next)=>{req.user={role:'admin'};next();},clusterBus:{connected:()=>false},prepareWorkspace:()=>{}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(base+'/api/clusters/3/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({masterUrl:'wss://master.example',workspaceRoot:'/srv/roside-cluster/workspaces'})});
    assert.equal(response.status,200);
    const {code}=await response.json();
    const configResponse=await fetch(base+'/api/cluster-bootstrap/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    assert.equal(configResponse.status,200);
    const config=await configResponse.json();
    assert.equal(crypto.createHash('sha256').update(config.cluster_secret).digest('hex'),secretHash);
    assert.notEqual(config.cluster_secret,'old-key');
    assert.match(config.nfs_source,/^master\.example:.*\/sim_ws\/CL-3$/);
    assert.equal(config.workspace_gid,40003);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
