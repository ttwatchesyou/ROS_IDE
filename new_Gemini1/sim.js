'use strict';
// ═══════════════════════════════════════════════════════════════
//  sim.js — ROS2 Simulation Engine (no real robot needed)
//  ไม่ต้องมีหุ่นยนต์จริงเชื่อมต่อมา แต่ถ้า server รันบนเครื่องที่มี ROS
//  จะรันคำสั่งจริง (bash / colcon build) ใน workspace ของหุ่นแต่ละตัว
//  เสียบตัวเองเป็น "fake agent" ใน agents map → flow เดิมของ server ไม่ต้องแก้
//  แต่ละ SIM robot มี workspace จริงบนดิสก์ แยกตาม robot_key (รองรับหลาย user)
// ═══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs   = require('fs').promises;
const fss  = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const SIM_SPATIAL_PY=fss.readFileSync(path.join(__dirname,'sim-spatial.py'),'utf8');
const SIM_NAVIGATION_PY=fss.readFileSync(path.join(__dirname,'sim-navigation.py'),'utf8');
const NAVIGATION_SETTINGS=require('./public/navigation-settings');

const SIM_WS_ROOT = path.join(__dirname, 'sim_ws');   // ทุก workspace ของ sim อยู่ที่นี่
function isSim(k) { return typeof k === 'string' && k.startsWith('SIM-'); }
function clusterIdForSim(k){const match=String(k||'').match(/^SIM-C([1-9]\d*)-/);return match?Number(match[1]):1;}

// ROS_LOCALHOST_ONLY is deprecated in newer ROS 2 releases.  Delete it rather
// than merely overriding it: an enabled value inherited by the server makes
// rcl reject/ignore the newer discovery settings and can stop the simulation.
function buildSimProcessEnvironment(overrides={}, inheritedEnvironment=process.env) {
  const environment={...inheritedEnvironment,...overrides};
  delete environment.ROS_LOCALHOST_ONLY;
  return environment;
}

// ── โลกจำลอง: ห้อง 8x8m + สิ่งกีดขวาง (เส้นตรง [x1,y1,x2,y2]) ──
const WALLS = [
  [-4,-4, 4,-4],[4,-4, 4,4],[4,4, -4,4],[-4,4, -4,-4], // ผนังห้อง
  [-1,-1, 1,-1],[1,-1, 1,1],[1,1, -1,1],[-1,1, -1,-1],   // กล่องกลางห้อง
  [2.5,-3, 2.5,-1],                                       // แผงกั้น
];

function rayCast(ox, oy, ang, maxR, walls=WALLS) {
  let best = maxR;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  for (const [x1,y1,x2,y2] of walls) {
    const sx = x2-x1, sy = y2-y1;
    const den = dx*sy - dy*sx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x1-ox)*sy - (y1-oy)*sx) / den;
    const u = ((x1-ox)*dy - (y1-oy)*dx) / den;
    if (t > 0 && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}
function rayCastVector(ox,oy,dx,dy,maxR,walls=WALLS){
  let best=maxR;
  for(const [x1,y1,x2,y2] of walls){
    const sx=x2-x1,sy=y2-y1,den=dx*sy-dy*sx;
    if(Math.abs(den)<1e-9)continue;
    const t=((x1-ox)*sy-(y1-oy)*sx)/den,u=((x1-ox)*dy-(y1-oy)*dx)/den;
    if(t>0&&t<best&&u>=0&&u<=1)best=t;
  }
  return best;
}
function simQuatMul(a,b){const [x,y,z,w]=a,[X,Y,Z,W]=b;return[w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z];}
function simQuatRot(q,v){const [x,y,z,w]=q,[vx,vy,vz]=v,tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);return[vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx];}
function simQuatRPY(angles){const[r,p,y]=angles.map(deg=>deg*Math.PI/360),cr=Math.cos(r),sr=Math.sin(r),cp=Math.cos(p),sp=Math.sin(p),cy=Math.cos(y),sy=Math.sin(y);return[sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy,cr*cp*cy+sr*sp*sy];}
function simLidarModel(robotKey){
  const fallback={frame:'laser_frame',edges:[{frame:'laser_frame',parent:'base_link',x:0,y:0,z:.1,qx:0,qy:0,qz:0,qw:1}],offset:[0,0,.1],quat:[0,0,0,1]};
  try{
    const comps=JSON.parse(fss.readFileSync(path.join(wsRoot(robotKey),'src/sim_robot_tf/tf_model.json'),'utf8'));
    const byName=new Map(comps.map(c=>[c.name,c])),base=comps.find(c=>c.type==='base')?.name||'base_link',lidar=comps.find(c=>c.type==='lidar');
    if(!lidar)return fallback;
    const pathToSensor=[],seen=new Set();let current=lidar;
    while(current&&current.name!==base&&!seen.has(current.name)){seen.add(current.name);pathToSensor.unshift(current);current=byName.get(current.parent);}
    if(!current||current.name!==base)return fallback;
    let offset=[0,0,0],quat=[0,0,0,1];const edges=[];
    for(const c of pathToSensor){
      const pos=[c.pos.x,c.pos.y,c.pos.z].map(Number),rpy=[c.rpy.r,c.rpy.p,c.rpy.y].map(Number);
      if([...pos,...rpy].some(n=>!Number.isFinite(n)))return fallback;
      const q=simQuatRPY(rpy),rotated=simQuatRot(quat,pos);
      offset=offset.map((n,i)=>n+rotated[i]);quat=simQuatMul(quat,q);
      edges.push({frame:c.name,parent:c.parent,x:pos[0],y:pos[1],z:pos[2],qx:q[0],qy:q[1],qz:q[2],qw:q[3]});
    }
    return{frame:lidar.name,edges,offset,quat};
  }catch(_){return fallback;}
}

const ROBOT_RADIUS = 0.24;
function pointSegmentDistance(px,py,x1,y1,x2,y2){
  const dx=x2-x1,dy=y2-y1,length2=dx*dx+dy*dy;
  if(length2<1e-12)return Math.hypot(px-x1,py-y1);
  const t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/length2));
  return Math.hypot(px-(x1+t*dx),py-(y1+t*dy));
}
function robotCollides(x,y,walls=WALLS,radius=ROBOT_RADIUS){
  return walls.some(([x1,y1,x2,y2])=>pointSegmentDistance(x,y,x1,y1,x2,y2)<radius);
}
function motionIsClear(x1,y1,x2,y2,walls=WALLS,radius=ROBOT_RADIUS){
  const steps=Math.max(1,Math.ceil(Math.hypot(x2-x1,y2-y1)/0.05));
  for(let i=1;i<=steps;i++){const t=i/steps;if(robotCollides(x1+(x2-x1)*t,y1+(y2-y1)*t,walls,radius))return false;}
  return true;
}

// ── Seed ต่อหุ่น: ให้แต่ละ simulation (robot_key) มีสถานะเริ่มต้นต่างกัน ──
// ไม่ให้ topic / ข้อมูลของ sim หนึ่งไปปรากฏในอีก sim หนึ่ง (ดูเหมือน "ทับกัน")
function hashSeed(k) {
  let h = 2166136261 >>> 0;
  const s = String(k || 'SIM');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── ROS_DOMAIN_ID ต่อ active simulation ──
// การ hash robot key ลง 230 domain โดยตรงมี birthday collision ได้ง่ายมาก
// และทำให้ /tf, /odom, /scan ของคนละ workspace ปนกัน จึงใช้ hash
// เป็นเพียงจุดเริ่มค้นหา แล้วจอง domain ที่ยังว่างแบบไม่ซ้ำกันอีกชั้น
const SIM_DOMAIN_MIN = 1;
const SIM_DOMAIN_MAX = 230;
const domainsByRobot = new Map();
const robotsByDomain = new Map();
const leasesByRobot = new Map();
const SIM_LEASE_ROOT = path.join(SIM_WS_ROOT, '.runtime-leases');

function processStartId(pid) {
  try {
    const stat=fss.readFileSync(`/proc/${pid}/stat`,'utf8'),tail=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    return tail[19]||''; // field 22 (starttime); tail starts at field 3
  } catch { return ''; }
}
const leaseOwner={pid:process.pid,processStart:processStartId(process.pid)};

function leaseOwnerIsAlive(lease) {
  const pid=Number(lease?.pid);
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);}catch(error){if(error?.code!=='EPERM')return false;}
  return !lease.processStart||processStartId(pid)===String(lease.processStart);
}

function readLease(file) {
  try{return JSON.parse(fss.readFileSync(file,'utf8'));}catch{return null;}
}

function acquireLeaseFile(file,payload) {
  fss.mkdirSync(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<4;attempt++){
    let fd;
    try{
      fd=fss.openSync(file,'wx',0o600);
      fss.writeFileSync(fd,JSON.stringify(payload));
      fss.closeSync(fd);fd=undefined;
      return true;
    }catch(error){
      if(fd!==undefined)try{fss.closeSync(fd);}catch{}
      if(error?.code!=='EEXIST')throw error;
      const stale=readLease(file);
      if(stale&&leaseOwnerIsAlive(stale))return false;
      // Re-read the token immediately before unlinking so a process which won
      // stale recovery is not accidentally removed by this contender.
      const latest=readLease(file);
      if((latest?.token||null)!==(stale?.token||null))continue;
      try{fss.unlinkSync(file);}catch(unlinkError){if(unlinkError?.code!=='ENOENT')continue;}
    }
  }
  return false;
}

function releaseLeaseFile(file,token) {
  const lease=readLease(file);
  if(!lease||lease.token!==token)return;
  try{fss.unlinkSync(file);}catch{}
}

function preferredDomainFor(robotKey) {
  return (hashSeed(robotKey || 'SIM') % SIM_DOMAIN_MAX) + SIM_DOMAIN_MIN;
}

function reserveDomain(robotKey) {
  const key=String(robotKey||'');
  if(domainsByRobot.has(key))return domainsByRobot.get(key);
  const token=crypto.randomBytes(18).toString('hex');
  const robotHash=crypto.createHash('sha256').update(key).digest('hex');
  const robotLeaseFile=path.join(SIM_LEASE_ROOT,'robots',`${robotHash}.json`);
  const payload={...leaseOwner,token,robotKey:key,createdAt:Date.now()};
  if(!acquireLeaseFile(robotLeaseFile,payload)){
    const error=new Error('Simulation workspace is already active in another server process');
    error.code='SIM_RUNTIME_ALREADY_ACTIVE';
    throw error;
  }
  const preferred=preferredDomainFor(key),count=SIM_DOMAIN_MAX-SIM_DOMAIN_MIN+1;
  for(let offset=0;offset<count;offset++){
    const candidate=SIM_DOMAIN_MIN+((preferred-SIM_DOMAIN_MIN+offset)%count);
    if(robotsByDomain.has(candidate))continue;
    const domainLeaseFile=path.join(SIM_LEASE_ROOT,'domains',`${candidate}.json`);
    if(!acquireLeaseFile(domainLeaseFile,{...payload,domain:candidate}))continue;
    domainsByRobot.set(key,candidate);robotsByDomain.set(candidate,key);
    leasesByRobot.set(key,{token,robotLeaseFile,domainLeaseFile});
    return candidate;
  }
  releaseLeaseFile(robotLeaseFile,token);
  const error=new Error(`Simulation capacity reached (${count} isolated ROS domains are active)`);
  error.code='SIM_DOMAIN_CAPACITY_REACHED';
  throw error;
}

function releaseDomain(robotKey,domainId) {
  const key=String(robotKey||''),reserved=domainsByRobot.get(key);
  if(reserved===undefined||domainId!==undefined&&reserved!==domainId)return;
  domainsByRobot.delete(key);
  if(robotsByDomain.get(reserved)===key)robotsByDomain.delete(reserved);
  const lease=leasesByRobot.get(key);leasesByRobot.delete(key);
  if(lease){releaseLeaseFile(lease.domainLeaseFile,lease.token);releaseLeaseFile(lease.robotLeaseFile,lease.token);}
}

function domainFor(robotKey) {
  return domainsByRobot.get(String(robotKey||''))||preferredDomainFor(robotKey);
}

// ═══════════════════════════════════════════════════════════════
//  SimEngine — สถานะ + ฟิสิกส์ต่อหุ่น 1 ตัว (แยกกันตาม robot_key)
// ═══════════════════════════════════════════════════════════════
class SimEngine {
  constructor(robotKey, mapData=null) {
    // ถอด seed จาก robot_key → แต่ละ sim มีจุดเริ่ม/เส้นทาง/สัญญาณต่างกัน (ไม่ทับกัน)
    const seed = hashSeed(robotKey);
    const rng  = mulberry32(seed);
    this._rng = rng;                                  // PRNG เฉพาะหุ่น (แทน Math.random)
    const bounds=Array.isArray(mapData?.bounds)&&mapData.bounds.length>=4?mapData.bounds.map(Number):[-4,-4,4,4];
    const corners = [[bounds[0]+1,bounds[1]+1],[bounds[2]-1,bounds[1]+1],[bounds[2]-1,bounds[3]-1],[bounds[0]+1,bounds[3]-1]];
    const si = seed % 4;                              // เลือกมุมเริ่มตาม seed
    this.x = corners[si][0] + (rng() - 0.5) * 0.6;    // เริ่มที่มุม + เลื่อนเล็กน้อย
    this.y = corners[si][1] + (rng() - 0.5) * 0.6;
    this.th = rng() * Math.PI * 2;                    // หันทิศ随机
    if(Array.isArray(mapData?.start)&&mapData.start.length>=2){this.x=Number(mapData.start[0])||0;this.y=Number(mapData.start[1])||0;}
    this.walls=this._wallsFromMap(mapData);
    this.goal = null;
    this.v = 0; this.w = 0;
    this.scan = { amin:-Math.PI, ainc:(2*Math.PI)/360, ranges:new Array(360).fill(0) };
    this.robotKey=robotKey;this.lidar=simLidarModel(robotKey);this._lidarReadAt=Date.now();
    this.rvizBuf = [];
    this.rvizOn = false;
    // เส้นทางลาดตระเวนหมุนตาม seed → sim ต่างกันวิ่งต่างกัน
    this._patrol = [...corners.slice(si), ...corners.slice(0, si)];
    this._pi = 0;
    this.tick = this.tick.bind(this);
    // ROS Python is the live simulation owner. Keep this lightweight engine
    // dormant until the synthetic monitor asks for fallback data.
    this._timer = null;
    this._lastTick = Date.now();
  }
  setGoal(x, y) { this.goal = { x:+x, y:+y }; }
  _wallsFromMap(mapData){
    if(Array.isArray(mapData?.walls)){
      const walls=mapData.walls.filter(w=>Array.isArray(w)&&w.length>=4).map(w=>w.slice(0,4).map(Number)).filter(w=>w.every(Number.isFinite));
      if(walls.length)return walls;
    }
    if(Array.isArray(mapData?.bounds)&&mapData.bounds.length>=4){const[x1,y1,x2,y2]=mapData.bounds.map(Number);if([x1,y1,x2,y2].every(Number.isFinite))return[[x1,y1,x2,y1],[x2,y1,x2,y2],[x2,y2,x1,y2],[x1,y2,x1,y1]];}
    return WALLS.map(w=>w.slice());
  }
  applyMap(mapData){
    this.walls=this._wallsFromMap(mapData);
    if(Array.isArray(mapData?.start)&&mapData.start.length>=2){this.x=Number(mapData.start[0])||0;this.y=Number(mapData.start[1])||0;this.goal=null;}
  }

  tick() {
    const dt = 0.1;
    let tgt = this.goal;
    if (!tgt) { const p = this._patrol[this._pi]; tgt = { x:p[0], y:p[1] }; }
    const dx = tgt.x - this.x, dy = tgt.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      if (this.goal) this.goal = null;
      else this._pi = (this._pi + 1) % this._patrol.length;
      this.v = 0; this.w = 0;
    } else {
      const desired = Math.atan2(dy, dx);
      let err = desired - this.th;
      while (err > Math.PI) err -= 2*Math.PI;
      while (err < -Math.PI) err += 2*Math.PI;
      this.w = Math.max(-1.2, Math.min(1.2, 2.0 * err));
      this.v = Math.abs(err) < 0.3 ? Math.min(0.5, dist) : 0.05;
    }
    this.th += this.w * dt;
    const nextX=this.x+this.v*Math.cos(this.th)*dt,nextY=this.y+this.v*Math.sin(this.th)*dt;
    if(motionIsClear(this.x,this.y,nextX,nextY,this.walls)){this.x=nextX;this.y=nextY;}
    else this.v=0;

    if(Date.now()-this._lidarReadAt>2000){this.lidar=simLidarModel(this.robotKey);this._lidarReadAt=Date.now();}
    const heading=[0,0,Math.sin(this.th/2),Math.cos(this.th/2)],origin=simQuatRot(heading,this.lidar.offset);
    for (let i = 0; i < 360; i++) {
      const a=this.scan.amin+i*this.scan.ainc;
      const direction=simQuatRot(heading,simQuatRot(this.lidar.quat,[Math.cos(a),Math.sin(a),0]));
      const r = rayCastVector(this.x+origin[0],this.y+origin[1],direction[0],direction[1],12,this.walls);
      this.scan.ranges[i] = r >= 12 ? 0 : +(r + (this._rng()-0.5)*0.02).toFixed(3);
    }
    if (this.rvizOn) {
      const qz = Math.sin(this.th/2), qw = Math.cos(this.th/2);
      this.rvizBuf.push(JSON.stringify({
        tf: [
          { frame:'odom',        parent:'map',       x:0, y:0, z:0, qx:0,qy:0,qz:0,qw:1 },
          { frame:'base_link',   parent:'odom',      x:this.x, y:this.y, z:0, qx:0,qy:0,qz:qz,qw:qw },
          ...this.lidar.edges,
        ],
        odom: { x:this.x, y:this.y, qz, qw },
        scan: { frame:this.lidar.frame, amin:this.scan.amin, ainc:this.scan.ainc, ranges:this.scan.ranges.slice() },
      }));
      if (this.rvizBuf.length > 20) this.rvizBuf.shift();
    }
  }

  msgFor(topic) {
    const now=Date.now(),steps=Math.min(5,Math.floor((now-this._lastTick)/100));
    for(let i=0;i<steps;i++)this.tick();
    if(steps)this._lastTick+=steps*100;
    const qz = Math.sin(this.th/2), qw = Math.cos(this.th/2);
    if (/scan/.test(topic))
      return { header:{frame_id:this.lidar.frame}, angle_min:this.scan.amin, angle_increment:this.scan.ainc,
               range_min:0.1, range_max:12.0, ranges:this.scan.ranges.slice(0,20).concat(['...']) };
    if (/odom/.test(topic))
      return { header:{frame_id:'odom'}, pose:{pose:{position:{x:+this.x.toFixed(3),y:+this.y.toFixed(3),z:0},
               orientation:{x:0,y:0,z:+qz.toFixed(3),w:+qw.toFixed(3)}}},
               twist:{twist:{linear:{x:+this.v.toFixed(3),y:0,z:0},angular:{x:0,y:0,z:+this.w.toFixed(3)}}} };
    if (/cmd_vel/.test(topic))
      return { linear:{x:+this.v.toFixed(3),y:0,z:0}, angular:{x:0,y:0,z:+this.w.toFixed(3)} };
    return { stamp:Date.now(), note:`sim data for ${topic}` };
  }
  destroy() { if(this._timer)clearInterval(this._timer); }
}

const SIM_NODES = ['/robot_state_publisher','/joint_state_publisher','/map_server','/amcl',
  '/controller_server','/planner_server','/behavior_server','/bt_navigator','/waypoint_follower',
  '/lifecycle_manager','/rviz2'];
const SIM_TOPICS = [
  ['/tf','tf2_msgs/msg/TFMessage'],['/tf_static','tf2_msgs/msg/TFMessage'],
  ['/odom','nav_msgs/msg/Odometry'],['/scan','sensor_msgs/msg/LaserScan'],
  ['/cmd_vel','geometry_msgs/msg/Twist'],['/map','nav_msgs/msg/OccupancyGrid'],
  ['/goal_pose','geometry_msgs/msg/PoseStamped'],['/initialpose','geometry_msgs/msg/PoseWithCovarianceStamped'],
  ['/plan','nav_msgs/msg/Path'],['/clicked_point','geometry_msgs/msg/PointStamped'],
];

// ── Sim Robot State Publisher ──
// หุ่นจำลองที่เดินลาดตระเวนในห้อง + เผยแพร่ TF/Odom/Scan/robot_description จริงบน ROS
// (รันใน ROS_DOMAIN_ID ของ sim นี้) เพื่อให้ RViz bridge (subscriber หา topic จริง) มีข้อมูลให้ดึง
// ถ้าไม่มี publisher นี้ RViz จะว่างเปล่า เพราะแพ็กเกจ sim_robot ของ sim รันแค่ /chatter
const SIM_STATE_PUB = `#!/usr/bin/env python3
# sim_robot_state_publisher - ขับหุ่นยนต์ด้วย /cmd_vel (Teleop) + เผยแพร่ TF/Odom/Scan/Description ให้ RViz
# หุ่นจะเคลื่อนที่ตามคำสั่ง /cmd_vel (linear.x=ความเร็วเชิงเส้น, angular.z=ความเร็วเชิงมุม) ที่ผู้ใช้ส่งจากแผง Teleop
# หากไม่ได้รับ /cmd_vel ภายใน CMD_TIMEOUT วินาที จะหยุดนิ่ง (กันหุ่นวิ่งทิ้งหลังตัดการควบคุม)
import rclpy, math, time
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from geometry_msgs.msg import TransformStamped, Twist, Point
from tf2_ros import TransformBroadcaster, StaticTransformBroadcaster
from nav_msgs.msg import Odometry
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from visualization_msgs.msg import Marker

BE = QoSProfile(depth=10, reliability=QoSReliabilityPolicy.BEST_EFFORT)
ST = QoSProfile(depth=10, reliability=QoSReliabilityPolicy.RELIABLE, durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)

CMD_TIMEOUT = 0.5   # วินาที — หยุดหุ่นถ้าไม่ได้รับ /cmd_vel ใหม่ภายในเวลานี้
ROBOT_RADIUS = 0.24

${SIM_SPATIAL_PY}

WALLS = [(-4,-4,4,-4),(4,-4,4,4),(4,4,-4,4),(-4,4,-4,-4),
         (-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,-1),(2.5,-3,2.5,-1)]
def rayCast(ox,oy,ang,maxR):
    return WALL_INDEX.ray(ox,oy,ang,maxR)

def rayCastVector(ox,oy,dx,dy,maxR):
    best=maxR
    for x1,y1,x2,y2 in WALLS:
        sx,sy=x2-x1,y2-y1; den=dx*sy-dy*sx
        if abs(den)<1e-9: continue
        t=((x1-ox)*sy-(y1-oy)*sx)/den
        u=((x1-ox)*dy-(y1-oy)*dx)/den
        if 0<t<best and 0<=u<=1: best=t
    return best

def quatMul(a,b):
    x,y,z,w=a; X,Y,Z,W=b
    return (w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z)

def quatRot(q,v):
    x,y,z,w=q; vx,vy,vz=v
    tx=2*(y*vz-z*vy); ty=2*(z*vx-x*vz); tz=2*(x*vy-y*vx)
    return (vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx)

def quatRPY(r,p,y):
    r,p,y=[math.radians(a)/2 for a in (r,p,y)]
    cr,sr=math.cos(r),math.sin(r); cp,sp=math.cos(p),math.sin(p); cy,sy=math.cos(y),math.sin(y)
    return (sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy,cr*cp*cy+sr*sp*sy)

def pointSegmentDistance(px,py,x1,y1,x2,y2):
    dx,dy=x2-x1,y2-y1; length2=dx*dx+dy*dy
    if length2<1e-12: return math.hypot(px-x1,py-y1)
    t=max(0.0,min(1.0,((px-x1)*dx+(py-y1)*dy)/length2))
    return math.hypot(px-(x1+t*dx),py-(y1+t*dy))

def robotCollides(x,y): return any(pointSegmentDistance(x,y,*wall)<ROBOT_RADIUS for wall in WALLS)
def motionIsClear(x1,y1,x2,y2):
    steps=max(1,int(math.ceil(math.hypot(x2-x1,y2-y1)/0.05)))
    return all(not robotCollides(x1+(x2-x1)*i/steps,y1+(y2-y1)*i/steps) for i in range(1,steps+1))

CORNERS=[(-3.0,-3.0),(3.0,-3.0),(3.0,3.0),(-3.0,3.0)]
# ── โหลดแผนที่จาก ~/map.json (ถ้ามี) → กำแพง/ขอบเขต/จุดเริ่ม ของ simulation ──
_MAP_START=(-3.0,-3.0)
_MAP_YAW=0.0
try:
    import json as _json, os as _os
    with open(_os.path.expanduser('~/map.json')) as _mf:
        _map=_json.load(_mf)
    _w=_map.get('walls') or []
    if _w:
        WALLS=[(float(w[0]),float(w[1]),float(w[2]),float(w[3])) for w in _w]
    else:
        _b=_map.get('bounds')
        if _b:
            WALLS=[(_b[0],_b[1],_b[2],_b[1]),(_b[2],_b[1],_b[2],_b[3]),(_b[2],_b[3],_b[0],_b[3]),(_b[0],_b[3],_b[0],_b[1])]
    _b=_map.get('bounds')
    if _b: CORNERS=[(_b[0]+0.5,_b[1]+0.5),(_b[2]-0.5,_b[1]+0.5),(_b[2]-0.5,_b[3]-0.5),(_b[0]+0.5,_b[3]-0.5)]
    _s=_map.get('start')
    if _s: _MAP_START=(float(_s[0]),float(_s[1]))
    _MAP_YAW=math.radians(float(_map.get('startPose',{}).get('yaw',0.0)))
except Exception:
    pass
WALL_INDEX=WallIndex(WALLS)
URDF='''<?xml version="1.0"?>
<robot name="sim_robot">
  <link name="base_link"><visual><geometry><box size="0.4 0.3 0.2"/></geometry><material name="c"><color rgba="0.2 0.6 1.0 1"/></material></visual><collision><geometry><box size="0.4 0.3 0.2"/></geometry></collision></link>
  <link name="laser_frame"/>
  <joint name="laser_joint" type="fixed"><parent link="base_link"/><child link="laser_frame"/><origin xyz="0 0 0.1"/></joint>
</robot>'''

def loadLidarModel():
    fallback=('laser_frame',[("base_link","laser_frame",(0,0,0.1),(0,0,0,1))],(0,0,0.1),(0,0,0,1))
    try:
        import json, os
        filename=os.path.expanduser('~/src/sim_robot_tf/tf_model.json')
        with open(filename,encoding='utf-8') as stream: comps=json.load(stream)
        by_name={c['name']:c for c in comps if isinstance(c,dict) and isinstance(c.get('name'),str)}
        base=next((c['name'] for c in comps if c.get('type')=='base'),'base_link')
        lidar=next((c for c in comps if c.get('type')=='lidar'),None)
        if not lidar: return fallback
        path=[]; seen=set(); current=lidar
        while current and current['name']!=base and current['name'] not in seen:
            seen.add(current['name']); path.insert(0,current); current=by_name.get(current.get('parent'))
        if not current or current['name']!=base: return fallback
        pos=(0.0,0.0,0.0); quat=(0.0,0.0,0.0,1.0); edges=[]
        for c in path:
            origin=tuple(float(c['pos'][axis]) for axis in ('x','y','z'))
            angles=tuple(float(c['rpy'][axis]) for axis in ('r','p','y'))
            q=quatRPY(*angles); rotated=quatRot(quat,origin)
            pos=tuple(pos[i]+rotated[i] for i in range(3)); quat=quatMul(quat,q)
            edges.append((c['parent'],c['name'],origin,q))
        return lidar['name'],edges,pos,quat
    except (OSError,ValueError,KeyError,TypeError,StopIteration): return fallback

LASER_FRAME,LASER_EDGES,LASER_OFFSET,LASER_Q=loadLidarModel()
try:
    import os
    with open(os.path.expanduser('~/src/sim_robot_tf/urdf/robot.urdf'),encoding='utf-8') as model: URDF=model.read()
except OSError: pass

class SimState(Node):
    def __init__(self):
        super().__init__('sim_robot_state_pub')
        self.br=TransformBroadcaster(self)            # publish /tf เป็น tf2_msgs/msg/TFMessage (มาตรฐาน)
        self.static_br=StaticTransformBroadcaster(self) # publish /tf_static เป็น TFMessage
        self.odom_pub=self.create_publisher(Odometry,'/odom',10)
        self.scan_pub=self.create_publisher(LaserScan,'/scan',10)
        self.desc_pub=self.create_publisher(String,'/robot_description',ST)
        # Publisher for map simulation visualization
        self.map_pub=self.create_publisher(Marker,'/map_simulation',10)
        self.x,self.y,self.th=float(_MAP_START[0]),float(_MAP_START[1]),_MAP_YAW
        self.v,self.w=0.0,0.0
        # คำสั่งความเร็วล่าสุดจาก /cmd_vel (Teleop)
        self.cmd_v=0.0
        self.cmd_w=0.0
        self.cmd_t=0.0   # เวลา (time.time) ที่ได้รับ /cmd_vel ล่าสุด
        self._scan_tick=0
        # ลำดับมุมลาดตระเวน (เดินวนรอบห้อง) — หุ่นจะเคลื่อนที่เองเมื่อไม่มีคำสั่ง Teleop
        # กันหุ่น "ยืนนิ่งเฉย" หลังเปิด RViz (ดูเหมือนระบบพัง)
        self._patrol=CORNERS
        self._pi=0
        m=TransformStamped(); m.header.frame_id='map'; m.child_frame_id='odom'; m.transform.rotation.w=1.0; self._map_odom=m
        self._laser_tfs=[]
        for parent,child,origin,q in LASER_EDGES:
            b=TransformStamped(); b.header.frame_id=parent; b.child_frame_id=child
            b.transform.translation.x,b.transform.translation.y,b.transform.translation.z=origin
            b.transform.rotation.x,b.transform.rotation.y,b.transform.rotation.z,b.transform.rotation.w=q
            self._laser_tfs.append(b)
        self.desc_pub.publish(String(data=URDF))
        self.static_br.sendTransform([self._map_odom]+self._laser_tfs)
        # รับคำสั่งความเร็วจากแผง Teleop (/cmd_vel)
        self.cmd_sub=self.create_subscription(Twist,'/cmd_vel',self.cb_cmd,BE)
        self.create_timer(0.05,self.tick)
    def cb_cmd(self,msg):
        # รับคำสั่งจากแผง Teleop: linear.x = ความเร็วเชิงเส้น, angular.z = ความเร็วเชิงมุม
        self.cmd_v=float(msg.linear.x)
        self.cmd_w=float(msg.angular.z)
        self.cmd_t=time.time()
    def tick(self):
        # ถ้ามี /cmd_vel ใหม่ภายใน CMD_TIMEOUT → ตามคำสั่ง Teleop (ขับด้วยแผงควบคุม)
        # No fresh command: stay stopped, including before a field is launched.
        if time.time()-self.cmd_t <= CMD_TIMEOUT:
            self.v=self.cmd_v
            self.w=self.cmd_w
        else:
            self.v=0.0; self.w=0.0
        self.th+=self.w*0.05
        next_x=self.x+self.v*math.cos(self.th)*0.05; next_y=self.y+self.v*math.sin(self.th)*0.05
        if self.v==0.0 or motionIsClear(self.x,self.y,next_x,next_y): self.x,self.y=next_x,next_y
        else: self.v=0.0; self.cmd_v=0.0
        now=self.get_clock().now().to_msg()
        qz=math.sin(self.th/2); qw=math.cos(self.th/2)
        tf=TransformStamped(); tf.header.stamp=now; tf.header.frame_id='odom'; tf.child_frame_id='base_link'
        tf.transform.translation.x=self.x; tf.transform.translation.y=self.y
        tf.transform.rotation.z=qz; tf.transform.rotation.w=qw
        self.br.sendTransform(tf)
        o=Odometry(); o.header.stamp=now; o.header.frame_id='odom'; o.child_frame_id='base_link'
        o.pose.pose.position.x=self.x; o.pose.pose.position.y=self.y
        o.pose.pose.orientation.z=qz; o.pose.pose.orientation.w=qw
        o.twist.twist.linear.x=self.v; o.twist.twist.angular.z=self.w
        self.odom_pub.publish(o)
        self._scan_tick+=1
        if self._scan_tick % 2 == 0:
            s=LaserScan(); s.header.stamp=now; s.header.frame_id=LASER_FRAME
            s.angle_min=-math.pi; s.angle_max=math.pi; s.angle_increment=2*math.pi/360.0
            s.range_min=0.1; s.range_max=12.0
            pose=(self.x,self.y,self.th)
            if pose!=getattr(self,'_scan_pose',None):
                heading=(0,0,math.sin(self.th/2),math.cos(self.th/2))
                offset=quatRot(heading,LASER_OFFSET)
                ox,oy=self.x+offset[0],self.y+offset[1]
                values=[]
                for i in range(360):
                    a=s.angle_min+i*s.angle_increment
                    direction=quatRot(heading,quatRot(LASER_Q,(math.cos(a),math.sin(a),0)))
                    values.append(float(rayCastVector(ox,oy,direction[0],direction[1],s.range_max)))
                self._scan_ranges=values
                self._scan_pose=pose
            s.ranges=self._scan_ranges
            self.scan_pub.publish(s)

def main():
    rclpy.init()
    n=SimState()
    try: rclpy.spin(n)
    except Exception: pass
    try: n.destroy_node()
    except Exception: pass
    rclpy.shutdown()

if __name__=='__main__':
    main()
`;

// ═══════════════════════════════════════════════════════════════
//  Workspace helpers — โฟลเดอร์จริงแยกตาม robot_key
// ═══════════════════════════════════════════════════════════════
function wsRoot(robotKey) {
  const safe = String(robotKey).replace(/[^A-Za-z0-9_-]/g, '_');
  const clusterId=clusterIdForSim(robotKey);
  return clusterId===1?path.join(SIM_WS_ROOT,safe):path.join(SIM_WS_ROOT,`CL-${clusterId}`,safe);
}
function seed(root) {
  try {
    // เรียบแบน: workspace คือ root เอง (ไม่มีโฟลเดอร์ ros2_ws ซ้อน) → ลบ ros2_ws ที่อาจค้าง
    // จากเวอร์ชันก่อน ทั้ง symlink และ directory จริง (ต้องทำก่อนเช็ค marker)
    const rp = path.join(root, 'ros2_ws');
    try {
      if (fss.existsSync(rp)) {
        if (fss.lstatSync(rp).isSymbolicLink()) fss.unlinkSync(rp);
        else fss.rmSync(rp, { recursive: true, force: true });
      }
    } catch (e) { console.error('[SIM] cleanup ros2_ws failed', root, e.message); }
    // ใน sim: ~/ros2_ws คือ workspace และสัมพันธ์กับ root ของหุ่นนี้โดยตรง (sim_ws/SIM-xxx)
    const marker = path.join(root, 'src', 'sim_robot');
    if (fss.existsSync(marker)) return;   // เคย seed แล้ว
    const dirs = ['src/sim_robot/sim_robot','src/sim_robot/launch','src/sim_robot/resource','build','install','log'];
    dirs.forEach(d => fss.mkdirSync(path.join(root, d), { recursive:true }));
    fss.writeFileSync(path.join(root, 'src/sim_robot/package.xml'),
      `<?xml version="1.0"?>\n<package format="3">\n  <name>sim_robot</name>\n  <version>0.1.0</version>\n  <description>ROS2 IDE Sim sample package</description>\n  <maintainer email="sim@ros2ide.local">sim</maintainer>\n  <license>Apache-2.0</license>\n  <buildtool_depend>ament_python</buildtool_depend>\n  <exec_depend>rclpy</exec_depend>\n  <exec_depend>std_msgs</exec_depend>\n  <exec_depend>launch_ros</exec_depend>\n  <export><build_type>ament_python</build_type></export>\n</package>\n`);
    fss.writeFileSync(path.join(root, 'src/sim_robot/setup.py'),
      `from setuptools import setup\nfrom glob import glob\npackage_name='sim_robot'\nsetup(name=package_name,version='0.1.0',packages=[package_name],data_files=[('share/ament_index/resource_index/packages',['resource/'+package_name]),('share/'+package_name,['package.xml']),('share/'+package_name+'/launch',glob('launch/*.launch.py'))],entry_points={'console_scripts':['talker = sim_robot.talker:main']},install_requires=['setuptools'],zip_safe=False)\n`);
    fss.writeFileSync(path.join(root, 'src/sim_robot/setup.cfg'), '[develop]\nscript_dir=$base/lib/sim_robot\n[install]\ninstall_scripts=$base/lib/sim_robot\n');
    fss.writeFileSync(path.join(root, 'src/sim_robot/resource/sim_robot'), '');
    fss.writeFileSync(path.join(root, 'src/sim_robot/sim_robot/__init__.py'), '');
    fss.writeFileSync(path.join(root, 'src/sim_robot/sim_robot/talker.py'),
      `import rclpy\nfrom rclpy.node import Node\nfrom std_msgs.msg import String\n\nclass Talker(Node):\n    def __init__(self):\n        super().__init__('talker')\n        self.pub = self.create_publisher(String, '/chatter', 10)\n        self.i = 0\n        self.timer = self.create_timer(1.0, self.cb)\n    def cb(self):\n        msg = String(); msg.data = f'hello sim {self.i}'; self.i += 1\n        self.pub.publish(msg); self.get_logger().info(f'Pub: {msg.data}')\n\ndef main():\n    rclpy.init(); node=Talker()\n    try: rclpy.spin(node)\n    finally: node.destroy_node(); rclpy.shutdown()\n\nif __name__ == '__main__': main()\n`);
    fss.writeFileSync(path.join(root, 'src/sim_robot/launch/sim.launch.py'),
      `from launch import LaunchDescription\nfrom launch_ros.actions import Node\n\ndef generate_launch_description():\n    return LaunchDescription([\n        Node(package='sim_robot', executable='talker', name='talker'),\n    ])\n`);
    fss.writeFileSync(path.join(root, 'README.md'), '# SIM Workspace\nแก้ไข/รันไฟล์ได้เลย โดยไม่ต้องมี ROS จริง\n');
    // ── copy Gazebo sim package (robot urdf/world/controllers/launcher) ──
    try {
      const srcDir = path.join(__dirname, 'sim_gazebo');
      const dstDir = path.join(root, 'src', 'sim_gazebo');
      if (fss.existsSync(srcDir)) {
        fss.mkdirSync(dstDir, { recursive: true });
        fss.cpSync(srcDir, dstDir, { recursive: true });
      }
    } catch (e) { console.error('[SIM] seed sim_gazebo failed', root, e.message); }
  } catch (e) {
    console.error('[SIM] seed failed for', root, e.message);
  }
}
// แปลง path จาก terminal/UI → absolute ภายใน root (กัน escape ออกโฟลเดอร์)
// ใน sim: ~/ros2_ws คือ workspace และสัมพันธ์กับ root (sim_ws/SIM-xxx) โดยตรง
function toAbs(root, cwd, p) {
  let base = cwd ? path.join(root, cwd) : root;
  let t;
  if (!p || p === '~' || p === '~/') t = root;
  else if (p.startsWith('~/ros2_ws')) t = path.join(root, p.slice('~/ros2_ws'.length).replace(/^[/\\]+/, ''));
  else if (p.startsWith('~/')) t = path.join(root, p.slice(2));
  else if (path.isAbsolute(p)) t = path.join(root, p.replace(/^[/\\]+/, ''));
  else t = path.join(base, p);
  const rel = path.relative(root, t);
  if (rel.startsWith('..') || path.isAbsolute(rel)) t = root;
  return t;
}

// ═══════════════════════════════════════════════════════════════
//  FakeAgent — พูดโปรโตคอลเดียวกับ agent.js เพื่อเสียบ agents map
// ═══════════════════════════════════════════════════════════════
function createSimAgent(robotKey, deps) {
  const { pendingReqs, monSockets, webSockets, WebSocket, forwardPtyMessage, remote } = deps;
  const root = wsRoot(robotKey);
  const domain = reserveDomain(robotKey);      // unique among active runtimes; released by ws.close()
  const simRosEnvironment={ROS_DOMAIN_ID:String(domain),ROS_AUTOMATIC_DISCOVERY_RANGE:'LOCALHOST'};
  const remoteRequest=(action,payload={},timeout=30000)=>remote.request(action,{robotKey,masterRoot:root,domain,...payload},timeout);
  let initialMap=null;try{initialMap=JSON.parse(fss.readFileSync(path.join(root,'map.json'),'utf8'));}catch{}
  const eng  = new SimEngine(robotKey,initialMap);
  seed(root);

  // ── Sim backend (dummy-primary): เปิด sim ด้วย dummy kinematic (SIM_STATE_PUB) เสมอ ──
  //  หุ่นที่ user ออกแบบ (src/sim_robot_odom/scripts/wheel_odom) จะ "ไม่" รันอัตโนมัติอีกต่อไป
  //  → ผู้ใช้กด "▶ Run in Sim" ในแผง Odometry (หน้า Robot Config) เพื่อรัน odom เอง (เปิดด้วยตัวเอง ทุก package)
  //  dummy fallback: กล่องชั่วคราว กันหน้าว่างก่อนออกแบบ + รองรับ Teleop (/cmd_vel)
  //  (Gazebo auto-start ปิดไปตามนโยบาย dummy-primary; โฟลเดอร์ sim_gazebo/ ยังคงอยู่บนดิสก์ หากต้องการรันเอง)
  try { fss.mkdirSync(path.join(root, 'tmp'), { recursive: true }); } catch (e) {}
  const simPubPidFile = path.join(root, 'tmp', '_sim_state_pub.pid');
  let _rosSetup = '';
  try { const ds = fss.readdirSync('/opt/ros').filter(d => /^[a-z]+$/.test(d)).sort(); if (ds.length) _rosSetup = `/opt/ros/${ds[ds.length - 1]}/setup.bash`; } catch (e) {}
  // ฆ่า backend ตัวเก่าที่ค้างทุกชนิดก่อนรัน fallback ใหม่ → ให้หนึ่ง
  // simulation มีเจ้าของ /tf, /odom และ /scan เพียง process เดียวเสมอ
  // ⚠️ ต้องรอ pkill จบก่อน spawn ใหม่ (รัน spawn ใน callback ของ exec)
  //    ถ้าสั่ง pkill แล้ว spawn ต่อกันแบบ async → pkill จะฆ่า node ที่เพิ่ง spawn ไปเอง (race → sim ว่างเปล่า)
  const startBackend = async () => {
    if(closed)return;
    // ⚠️ ไม่ auto-start wheel_odom (หุ่นที่ user ออกแบบ) — ผู้ใช้รันเองผ่าน "▶ Run in Sim"
    //    ดังนั้นเปิด sim ด้วย dummy fallback (SIM_STATE_PUB) เสมอ (กล่องชั่วคราว + Teleop)
    try { fss.writeFileSync(path.join(root, 'tmp', '_sim_state_pub.py'), SIM_STATE_PUB); } catch (e) {}
    const _pubPy = path.join(root, 'tmp', '_sim_state_pub.py');
    const _pubLog = path.join(root, 'tmp', '_sim_state.log');
    let _pubStdio = ['ignore', 'ignore', 'ignore'],logFd;
    try { logFd=fss.openSync(_pubLog, 'a'); _pubStdio = ['ignore', logFd, logFd]; } catch (e) {}
    if(remote){
      const result=await remoteRequest('launch',{command:`setup=$(ls /opt/ros/*/setup.bash 2>/dev/null | tail -1); [ -n "$setup" ] && source "$setup"; exec python3 -u ${_pubPy}`,log:_pubLog},10000);
      fss.writeFileSync(simPubPidFile,String(result.pid));
      return;
    }
    let simPubChild;
    try{simPubChild = spawn('bash', ['-lc', `source ${_rosSetup} 2>/dev/null; exec python3 -u ${_pubPy}`], {
      cwd: root,
      env: buildSimProcessEnvironment({ HOME: root, TERM: 'xterm-256color', ...simRosEnvironment }),
      detached: true,
      stdio: _pubStdio,
    });}finally{if(logFd!==undefined)fss.closeSync(logFd);}
    simPubChild.on('error',error=>console.error('[SIM] state publisher failed:',error.message));
    try { fss.writeFileSync(simPubPidFile, String(simPubChild.pid)); } catch (e) {}
    simPubChild.unref();
    console.log('[SIM] dummy SIM_STATE_PUB fallback for', robotKey, '(wheel_odom เปิดด้วยตัวเองผ่าน Run in Sim)');
  };
  const resetCommand=`PID=$(cat '${root}/tmp/_mapsim.pid' 2>/dev/null); [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null; pkill -9 -f '${root}/install/.*/[m]apsim' 2>/dev/null; pkill -f '${root}/.*_sim_state_pub[.]py' 2>/dev/null; pkill -f '${root}/.*[w]heel_odom' 2>/dev/null; rm -f '${root}/tmp/_mapsim.pid'`;
  const resetBackend=()=>remote?remoteRequest('exec',{command:resetCommand,timeout:8000},10000):new Promise(resolve=>exec(resetCommand,{timeout:8000},()=>resolve()));
  const backendReady=resetBackend().then(()=>startBackend());

  const cwdState = new Map();               // termId → relative path (cwd)
  const termState = new Map();              // termId → { line } (terminal buffer)
  const shells = new Map();                 // termId → child_process (shell จริง บน server)

  // `script` เป็นแค่ PTY wrapper; kill เฉพาะ wrapper จะทิ้ง bash/Python ลูกให้รันต่อ
  // จึงเปิด PTY แต่ละตัวเป็น process group และปิดทั้งกลุ่มเมื่อ WebSocket จบ
  function stopShell(child) {
    if (!child || child._rosideStopping) return;
    child._rosideStopping = true;
    const pid=child.pid;
    try { child.stdin.write('\x03'); } catch {}
    try { process.kill(-pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch {} }
    const force=setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    }, 750);
    force.unref?.();
  }

  const reply = (reqId, ok, data, error) => {
    const cb = pendingReqs.get(reqId);
    if (cb) { cb({ ok, data, error }); pendingReqs.delete(reqId); }
  };

  // รันคำสั่งจริงบน server (มี ROS) ภายใน workspace ของหุ่น
  function realExec(cmd, cwd = root, requestedTimeout = 120000) {
    // ใน sim: ~/ros2_ws คือ alias ของ root → แปลให้ชี้มาที่ ~ (root) เหมือนทาง terminal
    // ป้องกันคำสั่งเช่น `mkdir -p ~/ros2_ws/src` สร้างโฟลเดอร์ ros2_ws ซ้อนซ้ำ
    cmd = cmd.replace(/~\/ros2_ws(?=\/|\s|$)/g, '~');
    // แปล /tmp/... ให้ชี้เข้า workspace ของหุ่น (root/tmp/...) → ไฟล์ rviz/monitor ไม่ปนกันบน /tmp กลาง
    const tmpRoot = path.join(root, 'tmp') + '/';
    cmd = cmd.replace(/(^|[\s'";&|()])(\/tmp\/)/g, '$1' + tmpRoot);
    try { fss.mkdirSync(tmpRoot, { recursive:true }); } catch (e) {}
    if(remote)return remoteRequest('exec',{command:cmd,timeout:requestedTimeout},Math.min(310000,Math.max(1000,Number(requestedTimeout)||120000)+5000));
    return new Promise(resolve => {
      const timeout=Math.max(1000, Math.min(300000, Number(requestedTimeout) || 120000));
      // exec does not forward detached to its child. setsid makes the shell's
      // PID a process-group ID so the timeout can also stop ROS descendants.
      const groupedCommand=`exec setsid bash -c '${cmd.replace(/'/g, `'\\''`)}'`;
      const child = exec(groupedCommand, {
        shell: '/bin/bash', cwd,
        timeout, maxBuffer: 20 * 1024 * 1024,
        // ⚠️ ต้องมี ROS_DOMAIN_ID เสมอ (ก่อนหน้านี้ env ถูกเขียนซ้ำสองรอบ → key หลังทับ front ทำให้
        //    ROS_DOMAIN_ID หาย → คำสั่งพวก ros2 node list / rviz bridge ไปรันใน domain 0
        //    ไม่ตรงกับ node ที่รันใน terminal (domain ของ sim) → dashboard/rviz ไม่เจอ node)
        env: buildSimProcessEnvironment({ HOME: cwd, TERM: 'xterm-256color', ...simRosEnvironment }),
      }, (err, stdout, stderr) => {
        clearTimeout(groupTimeout);
        // exec's timeout kills only bash by default; ROS grandchildren would
        // keep consuming CPU after the request has already failed.
        if(err?.killed){try{process.kill(-child.pid,'SIGKILL');}catch{}}
        resolve({
          stdout: (stdout || '').trim(),
          stderr: (stderr || (err?.killed ? 'Simulation command timed out' : err?.message) || '').trim(),
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        });
      });
      // Do not wait for exec's callback: a grandchild holding stdout open can
      // prevent that callback from ever arriving after bash was terminated.
      const groupTimeout=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},timeout+100);
      groupTimeout.unref?.();
    });
  }

  // exec สำหรับ ros2 / dashboard / rviz / goal (ไม่รวม shell builtin)
  // ⚠️ สำคัญ: simulation รัน ROS จริงบน server โดยใช้ ROS_DOMAIN_ID ของหุ่นนี้ (ดู realExec)
  //    ดังนั้น rviz / topic list / node list ต้องรันคำสั่งจริงเพื่ออ่าน topic ที่ package ของผู้ใช้กำลัง publish
  //    ไม่ใช้ข้อมูลจำลองอีกต่อไป (กัน rviz "ไม่ตรงตาม package ที่รัน" และ topic ชนกันระหว่าง sim)
  async function runExec(cmd, requestedTimeout) {
    // ⚠️ ห้าม block คำสั่ง pkill — ก่อนหน้านี้มีการ short-circuit ทุกคำสั่งที่มี "pkill"
    //    ซึ่งทำให้คำสั่งเริ่ม rviz (startCmd ที่มี `pkill ...; nohup python3 ... &`) ถูกยกเลิก silently
    //    ผลคือ bridge (_rviz_rt.py) ไม่ได้รันเลย → หน้า RVIZ ไม่มีข้อมูล TF
    //    ตอนนี้ pkill รันได้ปกติ (จริงบน server) และ realExec จะ rewrite /tmp/ ให้ชี้มาที่
    //    root/tmp ของ sim นี้ ทำให้ฆ่า/เริ่ม bridge ได้ถูกต้องโดยไม่ไปกระทบ sim อื่น
    // ตรวจ ROS_DISTRO จริงบน server (ไม่ฮาร์ดโค้ด humble)
    if (/ROS_DISTRO=/.test(cmd)) {
      if(remote)return realExec(cmd,root,requestedTimeout);
      let setup = '';
      try {
        const ds = fss.readdirSync('/opt/ros').filter(d => /^[a-z]+$/.test(d)).sort();
        if (ds.length) setup = `/opt/ros/${ds[ds.length-1]}/setup.bash`;
      } catch {}
      if (setup) return { stdout: `ROS_DISTRO=${path.basename(path.dirname(setup))}\nSETUP=${setup}`, stderr:'', code:0 };
      return { stdout:'ROS_DISTRO=unknown\nSETUP=/opt/ros/humble/setup.bash', stderr:'', code:0 };
    }
    // ทุกคำสั่งอื่น (ros2 run/launch, ros2 topic/node list, rviz streamer, colcon build, ls ...)
    // → รันจริงบน server พร้อม ROS_DOMAIN_ID ของหุ่นนี้ (แยก topic ไม่ให้ชน simulation อื่น)
    return realExec(cmd, root, requestedTimeout);
  }

  // shell builtin (ls/cd/cat/pwd/colcon) + delegate ไป runExec
  async function shell(line, termId) {
    line = (line || '').trim();
    if (!line) return '';
    // รองรับคำสั่งต่อเนื่อง cd src && ls ; pwd
    if (/&&|\|\||;/.test(line)) {
      const parts=line.split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*/).map(s=>s.trim()).filter(Boolean);
      const output=await Promise.all(parts.map(p=>shell(p,termId)));
      return output.filter(Boolean).join('\n');
    }
    const parts = line.split(/\s+/);
    const c = parts[0];
    const cur = cwdState.get(termId) || '';
    if (c === 'pwd')  return '~/ros2_ws' + (cur ? '/' + cur : '');
    if (c === 'cd') {
      const d = parts[1] || '';
      let nc;
      if (!d || d === '~' || d === '~/') nc = '';
      else if (d === '~/ros2_ws' || d === '~/ros2_ws/') nc = '';
      else if (d.startsWith('~/ros2_ws/')) nc = d.slice('~/ros2_ws/'.length);
      else if (d.startsWith('~/')) nc = d.slice(2);
      else if (path.isAbsolute(d)) nc = d.replace(/^[/\\]+/, '');
      else nc = path.join(cur || '.', d);
      const segs = [];
      for (const s of nc.split('/')) { if (s === '.' || !s) continue; if (s === '..') segs.pop(); else segs.push(s); }
      cwdState.set(termId, segs.join('/'));
      return '';
    }
    if (c === 'ls' || c === 'dir') {
      const target = parts.slice(1).find(p => !p.startsWith('-')) || '.';
      const dir = toAbs(root, cur, target);
      try { return fss.readdirSync(dir).join('   '); }
      catch { return 'ls: cannot access ' + target; }
    }
    if (c === 'cat') {
      const f = parts[1]; if (!f) return '';
      try { return fss.readFileSync(toAbs(root, cur, f), 'utf8'); }
      catch { return 'cat: ' + f + ': No such file'; }
    }
    if (c === 'source' || c === '.') return '';   // mocked: โหลด env จำลอง ไม่ทำอะไร
    if (c === 'echo') return parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
    if (c === 'colcon' && parts[1] === 'build')
      return 'Starting >>>\n[0.123s] colcon: Identifying packages... [1]\n[0.456s] ... sim_robot\nFinished <<< sim_robot [2.34s]\n\nSummary: 1 package finished [2.5s]';
    return (await runExec(line)).stdout;
  }

  // fs จริงบนดิสก์
  async function runFs(action, p) {
    switch (action) {
      case 'fs_list': {
        const dir = toAbs(root, '', p.path || '~');
        let es;
        try { es = await fs.readdir(dir, { withFileTypes:true }); }
        catch { return { items: [] }; }   // โฟลเดอร์ไม่มีจริง → คืนว่างแทน throw ENOENT
        const items = [];
        for (const e of es) {
          let size = 0; try { size = (await fs.stat(path.join(dir, e.name))).size; } catch {}
          items.push({ name:e.name, isDir:e.isDirectory(), size, mtime:Date.now()/1000 });
        }
        return { items };
      }
      case 'fs_read':  return { content: await fs.readFile(toAbs(root, '', p.path), 'utf8') };
      case 'fs_write': { const fp = toAbs(root, '', p.path); await fs.mkdir(path.dirname(fp), { recursive:true }); await fs.writeFile(fp, p.content ?? ''); return {}; }
      case 'fs_mkdir': await fs.mkdir(toAbs(root, '', p.path), { recursive:true }); return {};
      case 'fs_rename': await fs.rename(toAbs(root, '', p.from), toAbs(root, '', p.to)); return {};
      case 'fs_delete': await fs.rm(toAbs(root, '', p.path), { recursive:true, force:true }); return {};
      default: throw new Error('Unknown action: ' + action);
    }
  }

  let closed=false;
  const ws = {
    readyState: WebSocket.OPEN,
    send(str) {
      let msg; try { msg = JSON.parse(str); } catch { return; }
      const { type } = msg;

      if (type === 'request') {
        const { reqId, action, payload } = msg;
        Promise.resolve(action === 'exec' ? runExec(payload.command || '', payload.timeout) : runFs(action, payload || {}))
          .then(data => reply(reqId, true, action === 'exec' ? data : data))
          .catch(e => reply(reqId, false, null, e.message));
      }

      else if (type === 'pty_init') {
        const id = msg.termId;
        if(remote){void remoteRequest('pty_init',{termId:id},10000).catch(error=>console.error('[CLUSTER] Terminal:',error.message));return;}
        if (shells.has(id)) return;
        // สปาวน์ shell จริงบน server (มี PTY ผ่าน `script`) → colcon build / คำสั่งรันได้จริง
        const child = spawn('script', ['-qec', 'bash -i', '/dev/null'], {
          cwd: root,
          detached: true, // process-group leader เพื่อปิด Python/ROS descendants ได้ครบ
          // ⚠️ ต้องเซ็ต ROS_DOMAIN_ID ให้ shell ของ terminal ด้วย
          //    ก่อนหน้านี้ shell นี้ไม่ได้ตั้ง → node ที่รันผ่าน Run manager ตกอยู่ใน default domain (0)
          //    ขณะที่ dashboard ใช้ ros2 node list ใน domain ของ sim นี้ → เลยมองไม่เห็น node ที่รันจาก Run manager
          //    และการ Kill ผ่าน ros2 node kill ก็ไปฆ่า domain ผิดตัว ผลคือ "กด kill แล้ว node ไม่ตาย"
          env: buildSimProcessEnvironment({ HOME: root, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...simRosEnvironment }),
        });
        const sockOf = () => { const s = webSockets.get(id); return (s && s.readyState === WebSocket.OPEN) ? s : null; };
        const route = message => {
          if(typeof forwardPtyMessage==='function')return forwardPtyMessage(message);
          // Standalone/test fallback. Production injects the shared server
          // parser so SIM and physical agents use the same browser protocol.
          const s=sockOf();if(s)s.send(JSON.stringify(message));
        };
        const fwd = d => route({ type:'pty_output', termId:id, data: Buffer.from(d).toString('base64') });
        child.stdout.on('data', fwd);
        child.stderr.on('data', fwd);
        child.on('exit', () => {
          shells.delete(id);
          route({ type:'pty_closed', termId:id });
        });
        child.on('error', () => { shells.delete(id); });
        shells.set(id, child);
      }

      else if (type === 'pty_input') {
        const id = msg.termId, data = msg.data || '';
        // terminal ปกติ → ส่งเข้า shell จริง
        // workspace คือ root เอง → แปล alias ~/ros2_ws ให้ชี้มาที่ ~ (root) และ
        // scope /tmp เข้า workspace เดียวกับ fs_write/exec เพื่อให้ PTY อ่านไฟล์ bridge ถูกตัว
        if(remote){const scopedData=data.replace(/~\/ros2_ws(?=\/|\s|$)/g,'~').replace(/(^|[\s'";&|()])\/tmp\//g,(_,prefix)=>prefix+path.join(root,'tmp')+'/');void remoteRequest('pty_input',{termId:id,data:scopedData},10000).catch(error=>console.error('[CLUSTER] Terminal input:',error.message));return;}
        const sh = shells.get(id);
        if (sh) {
          const scopedData=data
            .replace(/~\/ros2_ws(?=\/|\s|$)/g, '~')
            .replace(/(^|[\s'";&|()])\/tmp\//g,(_,prefix)=>prefix+path.join(root,'tmp')+'/');
          sh.stdin.write(scopedData);
        }
      }

      else if (type === 'pty_close') {
        const id = msg.termId;
        if(remote)void remoteRequest('pty_close',{termId:id},10000).catch(()=>{});
        const sh = shells.get(id);
        if (sh) { stopShell(sh); shells.delete(id); }
        cwdState.delete(id);
        termState.delete(id);
      }
    },
    close() {
      if(closed)return;
      closed=true;
      ws.readyState=WebSocket.CLOSED??3;
      eng.destroy();
      if(remote)remote.clearPty?.();
      shells.forEach(stopShell);
      // ฆ่า Sim Robot State Publisher ของ sim นี้
      try {
        if (fss.existsSync(simPubPidFile)) {
          const pid = parseInt(fss.readFileSync(simPubPidFile, 'utf8').trim());
          if (pid&&!remote) try { process.kill(pid, 'SIGKILL'); } catch (e) {}
        }
      } catch (e) {}
      // Keep the ROS domain lease until every workspace-owned process has
      // stopped. Releasing it first lets a new simulation reuse the domain
      // while an old MapSim/teleop/RViz publisher is still emitting data.
      let released=false;
      const finish=()=>{if(released)return;released=true;releaseDomain(robotKey,domain);};
      const pidFiles=['_mapsim.pid','_sim_state_pub.pid','_teleop.pid'].map(name=>`'${root}/tmp/${name}'`).join(' ');
      const cleanup=`for pf in ${pidFiles}; do pid=$(cat "$pf" 2>/dev/null || true); if printf '%s' "$pid" | grep -Eq '^[0-9]+$' && tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fq '${root}'; then kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; fi; done; sleep 0.25; pkill -KILL -f '${root}/install/.*/[m]apsim' 2>/dev/null || true; pkill -KILL -f '${root}/.*[_]sim_state_pub[.]py' 2>/dev/null || true; pkill -KILL -f '${root}/.*[w]heel_odom' 2>/dev/null || true; pkill -KILL -f '${root}/.*[_]teleop_pub[.]py' 2>/dev/null || true; pkill -KILL -f '${root}/.*[_]rviz_rt_.*[.]py' 2>/dev/null || true; pkill -KILL -f '${root}/.*[_]mon_.*[.]py' 2>/dev/null || true; rm -f ${pidFiles}`;
      if(remote)remoteRequest('exec',{command:cleanup,timeout:5000},7000).then(finish,finish);
      else try { exec(cleanup,{timeout:5000},finish); } catch { finish(); }
      const releaseFallback=setTimeout(finish,5500);releaseFallback.unref?.();
    },
  };

  // ── รีสตาร์ท backend ให้โหลด ~/map.json ใหม่ (เรียกจาก endpoint /api/sim/apply-map) ──
  async function respawnBackend(mapJson) {
    fss.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    if (mapJson != null) {
      fss.writeFileSync(path.join(root, 'map.json'), typeof mapJson === 'string' ? mapJson : JSON.stringify(mapJson));
      eng.applyMap(typeof mapJson==='string'?JSON.parse(mapJson):mapJson);
    }
    // Map apply also changes the kinematic owner back to exactly one fallback.
    // Resolve after the replacement has started so run-mapsim cannot race the
    // asynchronous cleanup and have its freshly launched process killed.
    await backendReady;
    await resetBackend();
    if(closed)throw new Error('Simulation closed while applying map');
    await startBackend();
  }

  async function applyMapWithoutRestart(mapJson) {
    await backendReady;
    if(closed)throw new Error('Simulation closed while applying map');
    const target=path.join(root,'map.json'),pending=target+'.pending';
    fss.writeFileSync(pending,JSON.stringify(mapJson));fss.renameSync(pending,target);
    eng.applyMap(mapJson);
  }

  if(remote)remote.clearPty=remote.onPty(robotKey,message=>{
    if(message.type==='pty_output')forwardPtyMessage?.({type:'pty_output',termId:message.termId,data:Buffer.from(message.data||'').toString('base64')});
    else if(message.type==='pty_closed')forwardPtyMessage?.({type:'pty_closed',termId:message.termId});
  });
  return { ws, lastSeen: Date.now(), _sim: true, _engine: eng, _domainId:domain, respawnBackend, applyMapWithoutRestart };
}

// ── Save the Transformation-page model as a real `sim_robot_tf` package ──
// files: { 'package.xml': '...', 'urdf/robot.urdf': '...', ... }  (relative to the package dir)
// If the package already exists it is edited (overwritten); otherwise it is created.
function writeTfPackage(robotKey, files) {
  const root = wsRoot(robotKey);
  seed(root);                                   // make sure the workspace exists
  const pkgDir = path.join(root, 'src', 'sim_robot_tf');
  const existed = fss.existsSync(path.join(pkgDir, 'package.xml'));
  fss.mkdirSync(pkgDir, { recursive: true });
  const written = [];
  for (const [rel, content] of Object.entries(files || {})) {
    if (typeof content !== 'string') continue;
    const fp = path.join(pkgDir, rel);
    // guard: never write outside the package directory
    const rel2 = path.relative(pkgDir, fp);
    if (rel2.startsWith('..') || path.isAbsolute(rel2)) continue;
    fss.mkdirSync(path.dirname(fp), { recursive: true });
    fss.writeFileSync(fp, content);
    // executable scripts must have the +x bit so launch_ros/ros2 run `which()` finds them
    if (/\.py$/.test(rel) || /(^|\/)scripts\//.test(rel)) { try { fss.chmodSync(fp, 0o755); } catch (e) {} }
    written.push(rel);
  }
  return { created: !existed, written, pkgDir: 'src/sim_robot_tf' };
}

// ── Save the Transformation-page odometry model as a real `sim_robot_odom` ROS2 package ──
// เหมือน writeTfPackage ทุกประการ แต่เขียนลง src/sim_robot_odom (แพ็กเกจแยกต่างหาก)
// files: { 'package.xml': '...', 'sim_robot_odom/odom.py': '...', ... } (relative to the package dir)
// If the package already exists it is edited (overwritten); otherwise it is created.
function writeOdomPackage(robotKey, files) {
  const root = wsRoot(robotKey);
  seed(root);                                   // make sure the workspace exists
  const pkgDir = path.join(root, 'src', 'sim_robot_odom');
  const existed = fss.existsSync(path.join(pkgDir, 'package.xml'));
  fss.mkdirSync(pkgDir, { recursive: true });
  const written = [];
  for (const [rel, content] of Object.entries(files || {})) {
    if (typeof content !== 'string') continue;
    const fp = path.join(pkgDir, rel);
    // guard: never write outside the package directory
    const rel2 = path.relative(pkgDir, fp);
    if (rel2.startsWith('..') || path.isAbsolute(rel2)) continue;
    fss.mkdirSync(path.dirname(fp), { recursive: true });
    fss.writeFileSync(fp, content);
    // executable scripts must have the +x bit so launch_ros/ros2 run `which()` finds them
    if (/\.py$/.test(rel) || /(^|\/)scripts\//.test(rel)) { try { fss.chmodSync(fp, 0o755); } catch (e) {} }
    written.push(rel);
  }
  return { created: !existed, written, pkgDir: 'src/sim_robot_odom' };
}

// ── Save the Map Editor model as a real `sim_robot_mapsim` ROS2 package ──
// แพ็กเกจ Python สำหรับแผนที่จำลอง (map editor) + laser + TF tree
// files: { 'package.xml': '...', 'sim_robot_mapsim/mapsim.py': '...', ... } (relative to the package dir)
function writeMapsimPackage(robotKey, files) {
  const root = wsRoot(robotKey);
  seed(root);
  const pkgDir = path.join(root, 'src', 'sim_robot_mapsim');
  const existed = fss.existsSync(path.join(pkgDir, 'package.xml'));
  fss.mkdirSync(pkgDir, { recursive: true });
  const written = [];
  for (const [rel, content] of Object.entries(files || {})) {
    if (typeof content !== 'string') continue;
    const fp = path.join(pkgDir, rel);
    const rel2 = path.relative(pkgDir, fp);
    if (rel2.startsWith('..') || path.isAbsolute(rel2)) continue;
    fss.mkdirSync(path.dirname(fp), { recursive: true });
    fss.writeFileSync(fp, content);
    if (/\.py$/.test(rel) || /(^|\/)scripts\//.test(rel)) { try { fss.chmodSync(fp, 0o755); } catch (e) {} }
    written.push(rel);
  }
  return { created: !existed, written, pkgDir: 'src/sim_robot_mapsim' };
}

// ── Generate sim_robot_mapsim package files (used by server.js endpoint) ──
// Returns a files map ready for writeMapsimPackage / writeTfPackage / writeOdomPackage
function genMapsimFiles() {
  // Python node that publishes /map + /scan + TF + responds to /cmd_vel
  const mapsimPy = `#!/usr/bin/env python3
"""sim_robot_mapsim - Static map publisher + laser simulator + TF tree for RViz"""
import json, math, os, time, heapq
import rclpy
from rclpy.node import Node
from rclpy.parameter import Parameter
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from geometry_msgs.msg import TransformStamped, Twist, PoseStamped, PoseWithCovarianceStamped
from tf2_ros import StaticTransformBroadcaster, TransformBroadcaster
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid, Odometry, Path
from std_msgs.msg import String
from std_srvs.srv import Trigger

BE = QoSProfile(depth=10, reliability=QoSReliabilityPolicy.BEST_EFFORT)
ST = QoSProfile(depth=1, reliability=QoSReliabilityPolicy.RELIABLE, durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)
CMD_TIMEOUT = 0.5
ROBOT_RADIUS = 0.24

${SIM_SPATIAL_PY}
${SIM_NAVIGATION_PY}

WALLS = [(-4,-4,4,-4),(4,-4,4,4),(4,4,-4,4),(-4,4,-4,-4),
         (-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,1),(2.5,-3,2.5,-1)]
def ray_cast(ox,oy,ang,max_r):
    return WALL_INDEX.ray(ox,oy,ang,max_r)

def point_segment_distance(px,py,x1,y1,x2,y2):
    dx,dy=x2-x1,y2-y1; length2=dx*dx+dy*dy
    if length2<1e-12: return math.hypot(px-x1,py-y1)
    t=max(0.0,min(1.0,((px-x1)*dx+(py-y1)*dy)/length2))
    return math.hypot(px-(x1+t*dx),py-(y1+t*dy))

def robot_collides(x,y,radius=ROBOT_RADIUS):
    return any(point_segment_distance(x,y,*wall)<radius for wall in WALLS)

def motion_is_clear(x1,y1,x2,y2):
    steps=max(1,int(math.ceil(math.hypot(x2-x1,y2-y1)/0.05)))
    return all(not robot_collides(x1+(x2-x1)*i/steps,y1+(y2-y1)*i/steps) for i in range(1,steps+1))

MAP_START=(0.0,0.0)
MAP_YAW=0.0
try:
    with open(os.path.expanduser('~/map.json')) as _f: _m=json.load(_f)
    w=_m.get('walls') or []
    if w: WALLS=[tuple(float(v) for v in wall[:4]) for wall in w if len(wall)>=4]
    b=_m.get('bounds')
    if b and not w: WALLS=[(b[0],b[1],b[2],b[1]),(b[2],b[1],b[2],b[3]),(b[2],b[3],b[0],b[3]),(b[0],b[3],b[0],b[1])]
    s=_m.get('start')
    if s: MAP_START=(float(s[0]),float(s[1]))
    MAP_YAW=math.radians(float(_m.get('startPose',{}).get('yaw',0.0)))
except Exception:
    pass
WALL_INDEX=WallIndex(WALLS)

URDF='''<?xml version="1.0"?>
<robot name="map_sim_robot">
  <link name="base_link"><visual><origin xyz="0 0 0.12"/><geometry><box size="0.42 0.32 0.24"/></geometry><material name="kid_blue"><color rgba="0.18 0.58 0.96 1"/></material></visual></link>
  <link name="laser_frame"/>
  <joint name="laser_joint" type="fixed"><parent link="base_link"/><child link="laser_frame"/><origin xyz="0.20 0 0.20"/></joint>
</robot>'''

class MapSimNode(Node):
    def __init__(self):
        super().__init__('sim_robot_mapsim')
        self.declare_parameter('map_file', str(os.path.expanduser('~/map.json')))
        self.map_file=self.get_parameter('map_file').get_parameter_value().string_value
        self.map_pub=self.create_publisher(OccupancyGrid,'/map',ST)
        self.slam_pub=self.create_publisher(OccupancyGrid,'/slam_map',ST)
        self.scan_pub=self.create_publisher(LaserScan,'/scan',1)
        self.odom_pub=self.create_publisher(Odometry,'/odom',10)
        self.desc_pub=self.create_publisher(String,'/robot_description',ST)
        self.nav_status_pub=self.create_publisher(String,'/nav_status',ST)
        self.nav_path_pub=self.create_publisher(Path,'/plan',ST)
        self.cmd_vel_sub=self.create_subscription(Twist,'/cmd_vel',self._cmd_vel_cb,1)
        self.goal_sub=self.create_subscription(PoseStamped,'/goal_pose',self._goal_cb,10)
        self.initial_pose_sub=self.create_subscription(PoseWithCovarianceStamped,'/initialpose',self._initial_pose_cb,10)
        self.save_map_srv=self.create_service(Trigger,'/save_slam_map',self._save_slam_map)
        self.cancel_nav_srv=self.create_service(Trigger,'/cancel_navigation',self._cancel_navigation)
        self.declare_parameter('nav_enabled',False)
${Object.values(NAVIGATION_SETTINGS.fields).map(field=>`        self.declare_parameter('${field.ros}',${Number(field.value).toFixed(2)})`).join('\n')}
        self.declare_parameter('nav_allow_unknown',False)
        self.static_br=StaticTransformBroadcaster(self)
        self.br=TransformBroadcaster(self)
        self.x,self.y,self.th=float(MAP_START[0]),float(MAP_START[1]),MAP_YAW
        self.last_cmd=Twist(); self.last_cmd_time=0.0
        self.nav_goal=None; self.nav_path=[]; self.nav_path_index=0; self._last_replan=0.0; self._nav_status='ready'; self._last_nav_status_time=0.0
        self._web_goal_file=os.path.expanduser('~/tmp/_nav_goal.json')
        try: self._web_goal_mtime=os.stat(self._web_goal_file).st_mtime_ns
        except FileNotFoundError: self._web_goal_mtime=0
        self._web_nav_config_file=os.path.expanduser('~/tmp/_nav_config.json'); self._web_nav_config_mtime=0
        self._nav_grid=None; self._nav_grid_source=None; self._nav_error=''; self._nav_progress=(self.x,self.y,time.monotonic())
        self.map_data=None; self.nav_map_data=None; self.nav_map_name=None; self._load_map(); self._load_selected_nav_map()
        self._init_slam_map()
        self._publish_static_tfs()
        # /map and the model are latched: subscribers receive them once without
        # rebuilding a large texture on every simulation tick.
        published_map=self.nav_map_data or self.map_data
        published_map.header.stamp=self.get_clock().now().to_msg()
        self.map_pub.publish(published_map)
        self._publish_slam_map()
        # Use the model saved by Robot Config; the built-in box is only a
        # fallback for workspaces which do not have a saved robot yet.
        robot_urdf=URDF
        for urdf_path in [os.path.expanduser('~/src/sim_robot_tf/urdf/robot.urdf'),os.path.expanduser('~/ros2_ws/src/sim_robot_tf/urdf/robot.urdf')]:
            try:
                if os.path.isfile(urdf_path):
                    with open(urdf_path,'r') as urdf_file: loaded_urdf=urdf_file.read()
                    # Older Robot Config versions persisted XML quotes as \".
                    # Normalize that exact legacy encoding and validate the XML;
                    # an invalid saved model must never make the robot disappear.
                    candidate=loaded_urdf.replace(chr(92)+chr(34),chr(34))
                    if '<robot' in candidate:
                        import xml.etree.ElementTree as _xml_tree
                        _xml_tree.fromstring(candidate)
                        robot_urdf=candidate; break
            except Exception as e: self.get_logger().warning(f'Cannot load Robot Config URDF: {e}')
        self._robot_urdf=robot_urdf
        self.desc_pub.publish(String(data=self._robot_urdf))
        self.desc_timer=self.create_timer(2.0,self._publish_description)
        self.get_logger().info('Robot model: Robot Config' if robot_urdf != URDF else 'Robot model: MapSim fallback')
        self._last_tick=time.monotonic()
        self._last_slam_publish=0.0
        self._scan_pose=None; self._slam_pose=None
        self.timer=self.create_timer(0.1,self._tick)
        self.get_logger().info('sim_robot_mapsim started')
    def _publish_description(self): self.desc_pub.publish(String(data=self._robot_urdf))
    def _set_nav_status(self,state,message,distance=None):
        now=time.monotonic()
        if state!=self._nav_status or now-self._last_nav_status_time>1.0:
            self._nav_status=state; self._last_nav_status_time=now
            self.nav_status_pub.publish(String(data=json.dumps({'state':state,'message':message,'distance':distance})))
    def _goal_cb(self,msg):
        q=msg.pose.orientation; yaw=2.0*math.atan2(q.z,q.w)
        self._accept_nav_goal(float(msg.pose.position.x),float(msg.pose.position.y),yaw)
    def _check_web_goal(self):
        try:
            modified=os.stat(self._web_goal_file).st_mtime_ns
            if modified==self._web_goal_mtime: return
            self._web_goal_mtime=modified
            with open(self._web_goal_file,'r') as goal_file: goal=json.load(goal_file)
            goal_id=str(goal.get('id','')); x=float(goal['x']); y=float(goal['y']); yaw=float(goal.get('yaw',0.0))
            if not all(math.isfinite(value) for value in (x,y,yaw)): raise ValueError('goal contains non-finite values')
            if goal.get('cancel'):
                self.nav_goal=None; self.nav_path=[]; self._publish_nav_path(); self._set_nav_status('canceled','ยกเลิกภารกิจนำทางแล้ว')
                accepted,error=True,''
            else: accepted,error=self._accept_nav_goal(x,y,yaw)
            ack_path=os.path.expanduser('~/tmp/_nav_goal_ack.json')
            with open(ack_path,'w') as ack_file: json.dump({'id':goal_id,'accepted':accepted,'error':error,'x':x,'y':y},ack_file)
            if accepted: self.get_logger().info('Robot Playground goal planned: %.2f, %.2f (%d points)'%(x,y,len(self.nav_path)))
        except FileNotFoundError: pass
        except Exception as error: self.get_logger().warning('Cannot accept Robot Playground goal: '+str(error))
    def _check_web_nav_config(self):
        try:
            modified=os.stat(self._web_nav_config_file).st_mtime_ns
            if modified==self._web_nav_config_mtime: return
            self._web_nav_config_mtime=modified
            with open(self._web_nav_config_file,'r') as config_file: config=json.load(config_file)
            config_id=str(config.get('id','')); allowed={'nav_enabled':bool,${Object.values(NAVIGATION_SETTINGS.fields).map(field=>`'${field.ros}':float`).join(',')}}
            params=[]
            for name,value_type in allowed.items():
                if name in config: params.append(Parameter(name,value=value_type(config[name])))
            results=self.set_parameters(params); errors=[result.reason for result in results if not result.successful]
            ack={'id':config_id,'ok':not errors,'error':'; '.join(errors)}
            with open(os.path.expanduser('~/tmp/_nav_config_ack.json'),'w') as ack_file: json.dump(ack,ack_file)
            if errors: self.get_logger().warning('Navigation config rejected: '+ack['error'])
            else:
                self.nav_path=[]; self._publish_nav_path()
                self.get_logger().info('Navigation config applied')
        except FileNotFoundError: pass
        except Exception as error:
            try:
                with open(os.path.expanduser('~/tmp/_nav_config_ack.json'),'w') as ack_file: json.dump({'id':locals().get('config_id',''),'ok':False,'error':str(error)},ack_file)
            except Exception: pass
            self.get_logger().warning('Cannot apply Navigation config: '+str(error))
    def _initial_pose_cb(self,msg):
        pose=msg.pose.pose; self.x=float(pose.position.x); self.y=float(pose.position.y)
        self.th=2.0*math.atan2(pose.orientation.z,pose.orientation.w); self.nav_goal=None; self.nav_path=[]
        self._set_nav_status('localized','ตั้งตำแหน่งเริ่มต้นแล้ว')
    def _cancel_navigation(self,request,response):
        self.nav_goal=None; self.nav_path=[]; self._publish_nav_path(); self._set_nav_status('canceled','ยกเลิกภารกิจนำทางแล้ว')
        response.success=True; response.message='navigation canceled'; return response
    def _publish_nav_path(self):
        message=Path(); message.header.frame_id='map'; message.header.stamp=self.get_clock().now().to_msg()
        for x,y in self.nav_path:
            pose=PoseStamped(); pose.header=message.header; pose.pose.position.x=x; pose.pose.position.y=y; pose.pose.orientation.w=1.0; message.poses.append(pose)
        self.nav_path_pub.publish(message)
    def _prepare_nav_grid(self):
        grid=self.nav_map_data or self.map_data
        if self._nav_grid_source is not grid:
            self._nav_grid=NavigationGrid(grid.data,grid.info.width,grid.info.height,grid.info.resolution,
                (grid.info.origin.position.x,grid.info.origin.position.y),WALLS,
                bool(self.get_parameter('nav_allow_unknown').value))
            self._nav_grid_source=grid
        self._nav_grid.configure(float(self.get_parameter('nav_robot_radius').value),
            float(self.get_parameter('nav_safety_margin').value),float(self.get_parameter('nav_inflation_radius').value),
            float(self.get_parameter('nav_cost_scaling').value))
        return self._nav_grid
    def _plan_nav_path(self,gx,gy):
        try:
            grid=self._prepare_nav_grid()
            points=grid.plan((self.x,self.y),(gx,gy),float(self.get_parameter('nav_planning_budget_ms').value))
            self._nav_error=grid.error
            return points
        except Exception as error:
            self._nav_error='วางแผนไม่สำเร็จ: '+str(error)
            return []
    def _accept_nav_goal(self,x,y,yaw):
        self._set_nav_status('planning','กำลังคำนวณเส้นทางพร้อมระยะปลอดภัย')
        planned=self._plan_nav_path(x,y)
        if not planned:
            self.nav_goal=None; self.nav_path=[]; self._publish_nav_path(); self._set_nav_status('failed',self._nav_error)
            return False,self._nav_error
        self.nav_goal=(x,y,yaw); self.nav_path=planned; self.nav_path_index=1 if len(planned)>1 else 0
        self._last_replan=time.monotonic(); self._nav_progress=(self.x,self.y,time.monotonic())
        self._publish_nav_path(); self._set_nav_status('navigating','สร้างเส้นทางแล้ว กำลังเดินทาง',math.hypot(x-self.x,y-self.y)); return True,''
    def _nav_command(self):
        if not self.get_parameter('nav_enabled').value or self.nav_goal is None: return 0.0,0.0
        gx,gy,gyaw=self.nav_goal; distance=math.hypot(gx-self.x,gy-self.y)
        tolerance=float(self.get_parameter('nav_goal_tolerance').value); turn=float(self.get_parameter('nav_turn_speed').value)
        if distance<=tolerance:
            error=math.atan2(math.sin(gyaw-self.th),math.cos(gyaw-self.th))
            if abs(error)>float(self.get_parameter('nav_yaw_tolerance').value):
                self._set_nav_status('aligning','ถึงตำแหน่งแล้ว กำลังปรับมุมปลายทาง',distance)
                return 0.0,max(-turn,min(turn,error*2))
            self.nav_goal=None; self.nav_path=[]; self._publish_nav_path(); self._set_nav_status('succeeded','ถึงจุดหมายแล้ว!',0.0); return 0.0,0.0
        if not self.nav_path:
            accepted,_=self._accept_nav_goal(gx,gy,gyaw)
            if not accepted: return 0.0,0.0
        grid=self._nav_grid; position=(self.x,self.y); now=time.monotonic()
        lookahead=float(self.get_parameter('nav_lookahead_distance').value)
        while self.nav_path_index<len(self.nav_path)-1:
            point=self.nav_path[self.nav_path_index]
            if math.hypot(point[0]-self.x,point[1]-self.y)>=lookahead: break
            if not grid.line_free(position,self.nav_path[self.nav_path_index+1]): break
            self.nav_path_index+=1
        tx,ty=self.nav_path[self.nav_path_index]; target=math.atan2(ty-self.y,tx-self.x)
        error=math.atan2(math.sin(target-self.th),math.cos(target-self.th))
        px,py,progress_time=self._nav_progress
        if math.hypot(self.x-px,self.y-py)>.04: self._nav_progress=(self.x,self.y,now)
        elif now-progress_time>20:
            self.nav_goal=None; self.nav_path=[]; self._publish_nav_path()
            self._set_nav_status('failed','หุ่นไม่คืบหน้า 20 วินาที: หยุดเพื่อความปลอดภัย กรุณาตรวจ Map และระยะเผื่อ',distance)
            return 0.0,0.0
        if not grid.line_free(position,(tx,ty)):
            if now-self._last_replan>=float(self.get_parameter('nav_replan_interval').value):
                replanned=self._plan_nav_path(gx,gy); self._last_replan=now
                if replanned: self.nav_path=replanned; self.nav_path_index=1; self._publish_nav_path()
            self._set_nav_status('replanning','ทางไม่มีระยะปลอดภัย หยุดรอวางแผนใหม่',distance)
            return 0.0,0.0
        wz=max(-turn,min(turn,error*2.0))
        if abs(error)>.25: return 0.0,wz
        max_speed=float(self.get_parameter('nav_max_speed').value)
        slow_distance=float(self.get_parameter('nav_obstacle_distance').value)
        radius=max(.24,float(self.get_parameter('nav_robot_radius').value))
        front=max(0,self._ray(self.x,self.y,self.th,rng=radius+slow_distance)-radius)
        v=min(max_speed,distance*.8)*max(.15,1-abs(error)/.3)*max(.15,min(1,front/slow_distance))
        # Validate the actual next motion, not only the path's waypoint centres.
        predicted=(self.x+v*.25*math.cos(self.th+wz*.1),self.y+v*.25*math.sin(self.th+wz*.1))
        if not grid.line_free(position,predicted): return 0.0,wz
        self._set_nav_status('navigating','กำลังตามเส้นทางพร้อมระยะปลอดภัย',distance)
        return v,wz
    def _init_slam_map(self):
        self.slam_grid=[-1]*(self.map_data.info.width*self.map_data.info.height)
        self.slam_data=OccupancyGrid(); self.slam_data.header.frame_id='map'
        self.slam_data.info=self.map_data.info
    def _publish_slam_map(self):
        self.slam_data.header.stamp=self.get_clock().now().to_msg()
        self.slam_data.data=self.slam_grid
        self.slam_pub.publish(self.slam_data)
    def _world_cell(self,x,y):
        return (int((x-self.map_data.info.origin.position.x)/self.map_data.info.resolution),int((y-self.map_data.info.origin.position.y)/self.map_data.info.resolution))
    def _integrate_slam_scan(self,ox,oy,angles,ranges,max_range):
        width,height,res=self.map_data.info.width,self.map_data.info.height,self.map_data.info.resolution
        sx,sy=self._world_cell(ox,oy)
        for angle,rng in zip(angles,ranges):
            hit=math.isfinite(rng) and rng<max_range
            distance=float(rng) if hit else max_range
            ex,ey=self._world_cell(ox+distance*math.cos(angle),oy+distance*math.sin(angle))
            dx,dy=ex-sx,ey-sy; steps=max(abs(dx),abs(dy),1)
            free_steps=steps if not hit else max(0,steps-1)
            for step in range(free_steps+1):
                t=step/steps; cx=int(round(sx+dx*t)); cy=int(round(sy+dy*t))
                if 0<=cx<width and 0<=cy<height and self.slam_grid[cy*width+cx]!=100: self.slam_grid[cy*width+cx]=0
            if hit and 0<=ex<width and 0<=ey<height: self.slam_grid[ey*width+ex]=100
    def _save_slam_map(self,request,response):
        try:
            name='slam_map'
            try:
                with open(os.path.expanduser('~/tmp/_slam_map_name'),'r') as name_file: requested=name_file.read().strip()
                if requested and all(ch.isalnum() or ch in '_-' for ch in requested): name=requested[:40]
            except Exception: pass
            home=os.path.expanduser('~'); export_dir=os.path.join(home,'maps',name); pkg=os.path.join(home,'src','sim_robot_nav_map')
            os.makedirs(export_dir,exist_ok=True); os.makedirs(os.path.join(pkg,'maps'),exist_ok=True); os.makedirs(os.path.join(pkg,'launch'),exist_ok=True)
            try: os.unlink(os.path.join(pkg,'CMakeLists.txt'))
            except FileNotFoundError: pass
            width,height=self.map_data.info.width,self.map_data.info.height
            pixels=bytearray()
            for y in range(height-1,-1,-1):
                for x in range(width):
                    value=self.slam_grid[y*width+x]; pixels.append(0 if value>=65 else (254 if value==0 else 205))
            pgm=b'P5\\n%d %d\\n255\\n'%(width,height)+bytes(pixels)
            ox=self.map_data.info.origin.position.x; oy=self.map_data.info.origin.position.y; resolution=self.map_data.info.resolution
            yaml='image: map.pgm\\nmode: trinary\\nresolution: %.6f\\norigin: [%.6f, %.6f, 0.0]\\nnegate: 0\\noccupied_thresh: 0.65\\nfree_thresh: 0.25\\n'%(resolution,ox,oy)
            for directory in [export_dir,os.path.join(pkg,'maps')]:
                with open(os.path.join(directory,'map.pgm'),'wb') as pgm_file: pgm_file.write(pgm)
                with open(os.path.join(directory,'map.yaml'),'w') as yaml_file: yaml_file.write(yaml)
            with open(os.path.join(export_dir,'map.json'),'w') as json_file: json.dump({'resolution':resolution,'width':width,'height':height,'origin':[ox,oy,0.0],'data':self.slam_grid},json_file)
            package_xml='''<?xml version="1.0"?><package format="3"><name>sim_robot_nav_map</name><version>0.0.1</version><description>SLAM map saved from Robot Playground</description><maintainer email="sim@ros2ide.local">sim</maintainer><license>Apache-2.0</license><buildtool_depend>ament_python</buildtool_depend><exec_depend>rclpy</exec_depend><exec_depend>nav_msgs</exec_depend><exec_depend>ament_index_python</exec_depend><exec_depend>launch_ros</exec_depend><export><build_type>ament_python</build_type></export></package>'''
            setup_py='''from setuptools import setup\nfrom glob import glob\nimport os\npackage_name='sim_robot_nav_map'\nsetup(name=package_name,version='0.0.1',packages=[package_name],data_files=[('share/ament_index/resource_index/packages',['resource/'+package_name]),('share/'+package_name,['package.xml']),('share/'+package_name+'/maps',glob('maps/*')),('share/'+package_name+'/launch',glob('launch/*'))],entry_points={'console_scripts':['map_server = sim_robot_nav_map.map_server:main']},install_requires=['setuptools'],zip_safe=False)\n'''
            setup_cfg='''[develop]\nscript_dir=$base/lib/sim_robot_nav_map\n[install]\ninstall_scripts=$base/lib/sim_robot_nav_map\n'''
            map_server_py='''import os\nimport rclpy\nfrom rclpy.node import Node\nfrom rclpy.qos import QoSProfile,QoSReliabilityPolicy,QoSDurabilityPolicy\nfrom nav_msgs.msg import OccupancyGrid\nfrom ament_index_python.packages import get_package_share_directory\nclass PlaygroundMapServer(Node):\n    def __init__(self):\n        super().__init__('playground_map_server')\n        share=get_package_share_directory('sim_robot_nav_map'); yaml_path=os.path.join(share,'maps','map.yaml')\n        values={}\n        with open(yaml_path) as stream:\n            for line in stream:\n                if ':' in line:\n                    key,value=line.split(':',1); values[key.strip()]=value.strip()\n        resolution=float(values.get('resolution','0.1')); origin=[float(v.strip()) for v in values.get('origin','[0,0,0]').strip('[]').split(',')]\n        pgm_path=os.path.join(os.path.dirname(yaml_path),values.get('image','map.pgm'))\n        with open(pgm_path,'rb') as pgm:\n            if pgm.readline().strip()!=b'P5': raise RuntimeError('Only P5 PGM is supported')\n            dims=pgm.readline().split(); width,height=int(dims[0]),int(dims[1]); pgm.readline(); pixels=pgm.read(width*height)\n        data=[]\n        for row in range(height-1,-1,-1):\n            for value in pixels[row*width:(row+1)*width]: data.append(100 if value<65 else (0 if value>240 else -1))\n        self.map=OccupancyGrid(); self.map.header.frame_id='map'; self.map.info.resolution=resolution; self.map.info.width=width; self.map.info.height=height\n        self.map.info.origin.position.x=origin[0]; self.map.info.origin.position.y=origin[1]; self.map.info.origin.orientation.w=1.0; self.map.data=data\n        qos=QoSProfile(depth=1,reliability=QoSReliabilityPolicy.RELIABLE,durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)\n        self.publisher=self.create_publisher(OccupancyGrid,'/map',qos); self.timer=self.create_timer(1.0,self.publish_map); self.publish_map()\n        self.get_logger().info('Saved SLAM map is ready on /map')\n    def publish_map(self): self.map.header.stamp=self.get_clock().now().to_msg(); self.publisher.publish(self.map)\ndef main(args=None):\n    rclpy.init(args=args); node=PlaygroundMapServer()\n    try: rclpy.spin(node)\n    finally: node.destroy_node(); rclpy.shutdown()\n'''
            launch_py='''from launch import LaunchDescription\nfrom launch_ros.actions import Node\ndef generate_launch_description():\n    return LaunchDescription([Node(package='sim_robot_nav_map',executable='map_server',name='playground_map_server',output='screen')])\n'''
            with open(os.path.join(pkg,'package.xml'),'w') as package_file: package_file.write(package_xml)
            with open(os.path.join(pkg,'setup.py'),'w') as setup_file: setup_file.write(setup_py)
            with open(os.path.join(pkg,'setup.cfg'),'w') as setup_cfg_file: setup_cfg_file.write(setup_cfg)
            os.makedirs(os.path.join(pkg,'resource'),exist_ok=True); os.makedirs(os.path.join(pkg,'sim_robot_nav_map'),exist_ok=True)
            with open(os.path.join(pkg,'resource','sim_robot_nav_map'),'w') as resource_file: resource_file.write('')
            with open(os.path.join(pkg,'sim_robot_nav_map','__init__.py'),'w') as init_file: init_file.write('')
            with open(os.path.join(pkg,'sim_robot_nav_map','map_server.py'),'w') as server_file: server_file.write(map_server_py)
            with open(os.path.join(pkg,'launch','map_server.launch.py'),'w') as launch_file: launch_file.write(launch_py)
            response.success=True; response.message='~/maps/%s + src/sim_robot_nav_map'%name
        except Exception as error:
            response.success=False; response.message=str(error)
        return response
    def _load_map(self):
        try:
            with open(self.map_file,'r') as f: data=json.load(f)
        except Exception as e:
            self.get_logger().error(f'Failed to load map: {e}')
            data={'bounds':[-4,-4,4,4],'walls':[],'start':[0,0]}
        b=list(data.get('bounds',[-4,-4,4,4])); res=0.1
        walls=data.get('walls',[])
        if walls:
            xs=[float(v) for wall in walls if len(wall)>=4 for v in (wall[0],wall[2])]
            ys=[float(v) for wall in walls if len(wall)>=4 for v in (wall[1],wall[3])]
            if xs and ys: b=[min(float(b[0]),min(xs)-res),min(float(b[1]),min(ys)-res),max(float(b[2]),max(xs)+res),max(float(b[3]),max(ys)+res)]
        w=int(math.ceil(abs(b[2]-b[0])/res)); h=int(math.ceil(abs(b[3]-b[1])/res))
        if not(0<w<=1000 and 0<h<=1000 and w*h<=400000):
            raise ValueError('Map exceeds simulation grid limit (including wall bounds)')
        grid=[0]*(w*h)
        for wall in data.get('walls',[]):
            if len(wall)<4: continue
            x1,y1,x2,y2=wall[:4]
            mx1=int((x1-b[0])/res); my1=int((y1-b[1])/res)
            mx2=int((x2-b[0])/res); my2=int((y2-b[1])/res)
            dx=mx2-mx1; dy=my2-my1; steps=max(abs(dx),abs(dy),1)
            for i in range(steps+1):
                t=i/steps; mx=int(mx1+dx*t); my=int(my1+dy*t)
                if 0<=mx<w and 0<=my<h: grid[my*w+mx]=100
        from std_msgs.msg import Header
        self.map_data=OccupancyGrid()
        self.map_data.header=Header(frame_id='map')
        self.map_data.info.resolution=res; self.map_data.info.width=w; self.map_data.info.height=h
        self.map_data.info.origin.position.x=float(b[0]); self.map_data.info.origin.position.y=float(b[1])
        self.map_data.info.origin.orientation.w=1.0; self.map_data.data=grid
    def _load_selected_nav_map(self):
        try:
            with open(os.path.expanduser('~/tmp/_nav_map_selection'),'r') as selection_file: name=selection_file.read().strip()
            if not name or not all(ch.isalnum() or ch in '_-' for ch in name): return
            with open(os.path.expanduser('~/maps/%s/map.json'%name),'r') as map_file: saved=json.load(map_file)
            width=int(saved['width']); height=int(saved['height']); resolution=float(saved['resolution']); origin=saved.get('origin',[0,0,0]); data=[int(value) for value in saved['data']]
            if not(0<width<=1000 and 0<height<=1000 and width*height<=400000) or len(data)!=width*height or not math.isfinite(resolution) or resolution<=0: raise ValueError('invalid occupancy grid size')
            self.nav_map_data=OccupancyGrid(); self.nav_map_data.header.frame_id='map'; self.nav_map_data.info.width=width; self.nav_map_data.info.height=height; self.nav_map_data.info.resolution=resolution
            self.nav_map_data.info.origin.position.x=float(origin[0]); self.nav_map_data.info.origin.position.y=float(origin[1]); self.nav_map_data.info.origin.orientation.w=1.0; self.nav_map_data.data=data; self.nav_map_name=name
            self.get_logger().info('Navigation map selected: '+name)
        except FileNotFoundError: pass
        except Exception as error: self.get_logger().warning('Cannot load selected Navigation map: '+str(error))
    def _publish_static_tfs(self):
        # laser_frame is truly static. map -> odom is deliberately broadcast
        # on /tf in every tick below so a late/restarted web bridge can never
        # lose the link and place RobotModel at the (0,0) fallback.
        t2=TransformStamped(); t2.header.frame_id='base_link'; t2.child_frame_id='laser_frame'
        t2.transform.translation.x=0.2; t2.transform.translation.z=0.1; t2.transform.rotation.w=1.0
        self.static_br.sendTransform(t2)
    def _cmd_vel_cb(self,msg):
        self.last_cmd=msg
        # The persistent web teleop publisher keeps sending 0,0 after release.
        # A zero command means "give control back", not a permanent manual
        # override; otherwise Navigation can never enter _nav_command().
        moving=abs(float(msg.linear.x))>1e-4 or abs(float(msg.angular.z))>1e-4
        self.last_cmd_time=time.time() if moving else 0.0
    def _tick(self):
        if self.map_data:
            self._check_web_nav_config(); self._check_web_goal()
            tick_now=time.monotonic(); dt=min(0.2,max(0.001,tick_now-self._last_tick)); self._last_tick=tick_now
            manual=time.time()-self.last_cmd_time<CMD_TIMEOUT
            if manual: v,wz=self.last_cmd.linear.x,self.last_cmd.angular.z
            else: v,wz=self._nav_command()
            self.th+=wz*dt
            next_x=self.x+v*math.cos(self.th)*dt; next_y=self.y+v*math.sin(self.th)*dt
            if not manual and self.nav_goal is not None and v!=0.0 and not self._nav_grid.line_free((self.x,self.y),(next_x,next_y)):
                v=0.0; next_x,next_y=self.x,self.y
                self._set_nav_status('blocked','หยุดก่อนเข้าเขตระยะปลอดภัย')
            if v==0.0 or motion_is_clear(self.x,self.y,next_x,next_y): self.x,self.y=next_x,next_y
            else:
                v=0.0
                if manual: self.last_cmd.linear.x=0.0
                self._set_nav_status('blocked','ชนสิ่งกีดขวาง หุ่นหยุดแล้ว')
            now=self.get_clock().now().to_msg()
            map_tf=TransformStamped(); map_tf.header.stamp=now; map_tf.header.frame_id='map'; map_tf.child_frame_id='odom'
            map_tf.transform.rotation.w=1.0
            tf=TransformStamped(); tf.header.stamp=now; tf.header.frame_id='odom'; tf.child_frame_id='base_link'
            tf.transform.translation.x=self.x; tf.transform.translation.y=self.y
            tf.transform.rotation.z=math.sin(self.th/2); tf.transform.rotation.w=math.cos(self.th/2)
            # Publish laser_frame dynamically as well. Some DDS/browser bridge
            # reconnects can miss the one-shot /tf_static sample; without this
            # edge RViz used to draw /scan at the fixed-frame origin, looking
            # like a second LiDAR process far away from the robot.
            laser_tf=TransformStamped(); laser_tf.header.stamp=now; laser_tf.header.frame_id='base_link'; laser_tf.child_frame_id='laser_frame'
            laser_tf.transform.translation.x=0.2; laser_tf.transform.translation.z=0.1; laser_tf.transform.rotation.w=1.0
            self.br.sendTransform([map_tf,tf,laser_tf])
            odom=Odometry(); odom.header.stamp=now; odom.header.frame_id='odom'; odom.child_frame_id='base_link'
            odom.pose.pose.position.x=self.x; odom.pose.pose.position.y=self.y
            odom.pose.pose.orientation.z=math.sin(self.th/2); odom.pose.pose.orientation.w=math.cos(self.th/2)
            odom.twist.twist.linear.x=v; odom.twist.twist.angular.z=wz; self.odom_pub.publish(odom)
            scan=LaserScan(); scan.header.stamp=now; scan.header.frame_id='laser_frame'
            scan.angle_min=-math.pi/2; scan.angle_max=math.pi/2; scan.angle_increment=math.pi/180
            scan.range_min=0.1; scan.range_max=10.0
            n=int((scan.angle_max-scan.angle_min)/scan.angle_increment)+1
            # Cast from the actual laser_frame origin (0.20 m in front of
            # base_link), matching the TF used by the web RViz renderer.
            laser_x=self.x+0.2*math.cos(self.th); laser_y=self.y+0.2*math.sin(self.th)
            scan_angles=[self.th+scan.angle_min+i*scan.angle_increment for i in range(n)]
            scan_pose=(laser_x,laser_y,self.th)
            if scan_pose!=self._scan_pose:
                self._scan_ranges=[self._ray(laser_x,laser_y,angle) for angle in scan_angles]
                self._scan_pose=scan_pose
            scan.ranges=self._scan_ranges
            self.scan_pub.publish(scan)
            # Laser/TF/odom stay at 10 Hz for responsive driving, while the
            # occupancy update runs at 2 Hz. Marching every ray through the
            # grid on every control tick wastes CPU without adding visible map
            # detail (the map texture itself is published at 2 Hz).
            if self.nav_goal is None and tick_now-self._last_slam_publish>=0.5 and scan_pose!=self._slam_pose:
                self._last_slam_publish=tick_now
                self._integrate_slam_scan(laser_x,laser_y,scan_angles,scan.ranges,scan.range_max)
                self._publish_slam_map()
                self._slam_pose=scan_pose
    def _ray(self,ox,oy,ang,step=0.05,rng=10.0):
        # Intersect directly with the map's wall segments. The old grid marcher
        # tested up to 200 cells for each of 181 rays at 10 Hz and consumed more
        # than half a CPU core per user. Map Editor already expands every solid
        # object into WALLS, so the analytic result preserves collision detail.
        distance=ray_cast(ox,oy,ang,rng)
        if distance<rng: return distance
        # ROS LaserScan convention: no return is +inf. The bridge discards it,
        # so phantom points are not drawn outside an open section of the map.
        return float('inf')
def main(args=None):
    rclpy.init(args=args)
    rclpy.spin(MapSimNode())
    rclpy.shutdown()
if __name__=='__main__': main()
`;

  return {
    'package.xml': `<?xml version="1.0"?>
<package format="3">
  <name>sim_robot_mapsim</name>
  <version>0.0.1</version>
  <description>Map simulation node for ROS2 IDE sim — publishes /map + /scan + TF tree</description>
  <maintainer email="sim@ros2ide.local">sim</maintainer>
  <license>Apache-2.0</license>
  <buildtool_depend>ament_python</buildtool_depend>
  <exec_depend>rclpy</exec_depend>
  <exec_depend>std_msgs</exec_depend>
  <exec_depend>std_srvs</exec_depend>
  <exec_depend>sensor_msgs</exec_depend>
  <exec_depend>nav_msgs</exec_depend>
  <exec_depend>tf2_ros</exec_depend>
  <exec_depend>geometry_msgs</exec_depend>
  <export>
    <build_type>ament_python</build_type>
  </export>
</package>`,
    'setup.py': `from setuptools import setup
from glob import glob
import os
setup(
    name='sim_robot_mapsim',
    version='0.0.1',
    packages=['sim_robot_mapsim'],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/sim_robot_mapsim']),
        ('share/sim_robot_mapsim', ['package.xml']),
        (os.path.join('share','sim_robot_mapsim','launch'), glob('launch/*.launch.py')),
    ],
    entry_points={
        'console_scripts': [
            'mapsim = sim_robot_mapsim.mapsim:main',
        ],
    },
    install_requires=['setuptools'],
    zip_safe=False,
)`,
    'setup.cfg': `[develop]
script_dir=$base/lib/sim_robot_mapsim
[install]
install_scripts=$base/lib/sim_robot_mapsim
`,
    'resource/sim_robot_mapsim': '',
    'sim_robot_mapsim/__init__.py': '',
    'sim_robot_mapsim/mapsim.py': mapsimPy,
    'launch/map_editor.launch.py': `from launch import LaunchDescription
from launch_ros.actions import Node
def generate_launch_description():
    return LaunchDescription([
        Node(package='sim_robot_mapsim', executable='mapsim', name='mapsim', output='screen'),
    ])`,
  };
}

module.exports = { createSimAgent, isSim, clusterIdForSim, SIM_NODES, SIM_TOPICS, SIM_STATE_PUB, SimEngine, wsRoot, toAbs, writeTfPackage, writeOdomPackage, writeMapsimPackage, genMapsimFiles, robotCollides, motionIsClear, domainFor, reserveDomain, releaseDomain, buildSimProcessEnvironment };
