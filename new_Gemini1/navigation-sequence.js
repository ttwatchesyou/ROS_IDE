'use strict';
// WebSocket payload validation for the real Nav2 sequence runner.
function validateSequence(input){
  const runId=String(input?.runId||''),points=input?.points;
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(runId)||!Array.isArray(points)||points.length<1||points.length>50)return null;
  const clean=[];
  for(const point of points){
    if(!point||['x','y','yaw'].some(key=>typeof point[key]!=='number'||!Number.isFinite(point[key])))return null;
    const wait=point.waitSeconds??0;
    if(typeof wait!=='number'||!Number.isFinite(wait)||wait<0||wait>3600||Math.abs(point.x)>10000||Math.abs(point.y)>10000)return null;
    clean.push({x:point.x,y:point.y,yaw:point.yaw,waitSeconds:wait});
  }
  return{runId,points:clean};
}
module.exports={validateSequence};
