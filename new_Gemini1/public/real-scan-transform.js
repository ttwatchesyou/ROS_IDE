// Project a ROS LaserScan through the saved TF tree into base_link coordinates.
// TF editor angles are degrees; LaserScan and odometry angles are radians.
(function(root){
  'use strict';
  const identity=()=>({x:0,y:0,z:0,q:[0,0,0,1]});
  const multiply=(a,b)=>[
    a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
    a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
    a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
    a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]
  ];
  function rotate(q,v){
    const [x,y,z,w]=q,[vx,vy,vz]=v;
    const tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);
    return [vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx];
  }
  function local(node){
    const d=Math.PI/360,r=Number(node.rpy?.r||0)*d,p=Number(node.rpy?.p||0)*d,y=Number(node.rpy?.y||0)*d;
    const cr=Math.cos(r),sr=Math.sin(r),cp=Math.cos(p),sp=Math.sin(p),cy=Math.cos(y),sy=Math.sin(y);
    return {x:Number(node.pos?.x||0),y:Number(node.pos?.y||0),z:Number(node.pos?.z||0),q:[sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy,cr*cp*cy+sr*sp*sy]};
  }
  function resolve(model,frameId){
    if(!Array.isArray(model)||!model.length)return identity();
    const nodes=new Map(model.map(node=>[String(node.name||''),node]));
    const base=model.find(node=>node.type==='base')?.name||'base_link';
    const path=[],seen=new Set();let node=nodes.get(String(frameId||'laser_frame').replace(/^\//,''));
    while(node&&node.name!==base&&!seen.has(node.name)){seen.add(node.name);path.unshift(node);node=nodes.get(node.parent);}
    if(!node||node.name!==base)return null;
    let result=identity();
    for(const part of path){
      const next=local(part),offset=rotate(result.q,[next.x,next.y,next.z]);
      result={x:result.x+offset[0],y:result.y+offset[1],z:result.z+offset[2],q:multiply(result.q,next.q)};
    }
    return result;
  }
  function point(transform,range,angle){
    if(!transform||!Number.isFinite(range)||!Number.isFinite(angle))return null;
    const v=rotate(transform.q,[range*Math.cos(angle),range*Math.sin(angle),0]);
    return {x:transform.x+v[0],y:transform.y+v[1],z:transform.z+v[2]};
  }
  function world(pointInBase,pose){
    const yaw=Number(pose?.yaw)||0,c=Math.cos(yaw),s=Math.sin(yaw);
    return {x:(Number(pose?.x)||0)+pointInBase.x*c-pointInBase.y*s,y:(Number(pose?.y)||0)+pointInBase.x*s+pointInBase.y*c};
  }
  async function load(sessionId,workspace,request){
    let cached=[];
    try{cached=JSON.parse(localStorage.getItem('tf_model_'+sessionId)||'[]');}catch(_){}
    try{
      const path=String(workspace||'~/ros2_ws').replace(/\/$/,'')+'/src/sim_robot_tf/tf_model.json';
      const response=await request('/api/files/read',{sessionId,path});
      const model=JSON.parse(response?.content||'[]');
      if(Array.isArray(model)&&model.length)return model;
    }catch(_){}
    return Array.isArray(cached)?cached:[];
  }
  const api={resolve,point,world,load};
  root.RealScanTF=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
