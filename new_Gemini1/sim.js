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
const b64  = s => Buffer.from(s).toString('base64');

const SIM_WS_ROOT = path.join(__dirname, 'sim_ws');   // ทุก workspace ของ sim อยู่ที่นี่
function isSim(k) { return typeof k === 'string' && k.startsWith('SIM-'); }

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

// ── ROS_DOMAIN_ID ต่อ simulation: แยก topic ของแต่ละหุ่น ไม่ให้ชนกัน ──
// ROS_DOMAIN_ID เป็น unsigned int (0..232) — ใช้ 1..230 เลี่ยง 0 และสงวนค่าบางส่วน
function domainFor(robotKey) {
  return (hashSeed(robotKey || 'SIM') % 230) + 1;
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
    this.rvizBuf = [];
    this.rvizOn = false;
    // เส้นทางลาดตระเวนหมุนตาม seed → sim ต่างกันวิ่งต่างกัน
    this._patrol = [...corners.slice(si), ...corners.slice(0, si)];
    this._pi = 0;
    this.tick = this.tick.bind(this);
    this._timer = setInterval(this.tick, 100);
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
    this.x  += this.v * Math.cos(this.th) * dt;
    this.y  += this.v * Math.sin(this.th) * dt;

    for (let i = 0; i < 360; i++) {
      const a = this.th + this.scan.amin + i * this.scan.ainc;
      const r = rayCast(this.x, this.y, a, 12, this.walls);
      this.scan.ranges[i] = r >= 12 ? 0 : +(r + (this._rng()-0.5)*0.02).toFixed(3);
    }
    if (this.rvizOn) {
      const qz = Math.sin(this.th/2), qw = Math.cos(this.th/2);
      this.rvizBuf.push(JSON.stringify({
        tf: [
          { frame:'odom',        parent:'map',       x:0, y:0, z:0, qx:0,qy:0,qz:0,qw:1 },
          { frame:'base_link',   parent:'odom',      x:this.x, y:this.y, z:0, qx:0,qy:0,qz:qz,qw:qw },
          { frame:'laser_frame', parent:'base_link', x:0, y:0, z:0.1, qx:0,qy:0,qz:0,qw:1 },
        ],
        odom: { x:this.x, y:this.y, qz, qw },
        scan: { amin:this.scan.amin, ainc:this.scan.ainc, ranges:this.scan.ranges.slice() },
      }));
      if (this.rvizBuf.length > 20) this.rvizBuf.shift();
    }
  }

  msgFor(topic) {
    const qz = Math.sin(this.th/2), qw = Math.cos(this.th/2);
    if (/scan/.test(topic))
      return { header:{frame_id:'laser_frame'}, angle_min:this.scan.amin, angle_increment:this.scan.ainc,
               range_min:0.1, range_max:12.0, ranges:this.scan.ranges.slice(0,20).concat(['...']) };
    if (/odom/.test(topic))
      return { header:{frame_id:'odom'}, pose:{pose:{position:{x:+this.x.toFixed(3),y:+this.y.toFixed(3),z:0},
               orientation:{x:0,y:0,z:+qz.toFixed(3),w:+qw.toFixed(3)}}},
               twist:{twist:{linear:{x:+this.v.toFixed(3),y:0,z:0},angular:{x:0,y:0,z:+this.w.toFixed(3)}}} };
    if (/cmd_vel/.test(topic))
      return { linear:{x:+this.v.toFixed(3),y:0,z:0}, angular:{x:0,y:0,z:+this.w.toFixed(3)} };
    return { stamp:Date.now(), note:`sim data for ${topic}` };
  }
  destroy() { clearInterval(this._timer); }
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

WALLS = [(-4,-4,4,-4),(4,-4,4,4),(4,4,-4,4),(-4,4,-4,-4),
         (-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,-1),(2.5,-3,2.5,-1)]
def rayCast(ox,oy,ang,maxR):
    best=maxR
    dx,dy=math.cos(ang),math.sin(ang)
    for (x1,y1,x2,y2) in WALLS:
        sx,sy=x2-x1,y2-y1
        den=dx*sy-dy*sx
        if abs(den)<1e-9: continue
        t=((x1-ox)*sy-(y1-oy)*sx)/den
        u=((x1-ox)*dy-(y1-oy)*dx)/den
        if t>0 and t<best and 0<=u<=1: best=t
    return best

CORNERS=[(-3.0,-3.0),(3.0,-3.0),(3.0,3.0),(-3.0,3.0)]
# ── โหลดแผนที่จาก ~/map.json (ถ้ามี) → กำแพง/ขอบเขต/จุดเริ่ม ของ simulation ──
_MAP_START=(-3.0,-3.0)
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
except Exception:
    pass
URDF='''<?xml version="1.0"?>
<robot name="sim_robot">
  <link name="base_link"><visual><geometry><box size="0.4 0.3 0.2"/></geometry><material name="c"><color rgba="0.2 0.6 1.0 1"/></material></visual><collision><geometry><box size="0.4 0.3 0.2"/></geometry></collision></link>
  <link name="laser_frame"/>
  <joint name="laser_joint" type="fixed"><parent link="base_link"/><child link="laser_frame"/><origin xyz="0 0 0.1"/></joint>
</robot>'''

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
        self.x,self.y,self.th=float(_MAP_START[0]),float(_MAP_START[1]),0.0
        self.v,self.w=0.0,0.0
        # คำสั่งความเร็วล่าสุดจาก /cmd_vel (Teleop)
        self.cmd_v=0.0
        self.cmd_w=0.0
        self.cmd_t=0.0   # เวลา (time.time) ที่ได้รับ /cmd_vel ล่าสุด
        # ลำดับมุมลาดตระเวน (เดินวนรอบห้อง) — หุ่นจะเคลื่อนที่เองเมื่อไม่มีคำสั่ง Teleop
        # กันหุ่น "ยืนนิ่งเฉย" หลังเปิด RViz (ดูเหมือนระบบพัง)
        self._patrol=CORNERS
        self._pi=0
        m=TransformStamped(); m.header.frame_id='map'; m.child_frame_id='odom'; m.transform.rotation.w=1.0; self._map_odom=m
        b=TransformStamped(); b.header.frame_id='base_link'; b.child_frame_id='laser_frame'; b.transform.translation.z=0.1; b.transform.rotation.w=1.0; self._bl_laser=b
        self.desc_pub.publish(String(data=URDF))
        self.static_br.sendTransform([self._map_odom, self._bl_laser])
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
        # ถ้าไม่ → ลาดตระเวนอัตโนมัติไปยังมุมถัดไป (หุ่นเคลื่อนที่เองตลอดเวลา ไม่นิ่งเฉย)
        if time.time()-self.cmd_t <= CMD_TIMEOUT:
            self.v=self.cmd_v
            self.w=self.cmd_w
        else:
            tgt=self._patrol[self._pi]
            dx=tgt[0]-self.x; dy=tgt[1]-self.y
            dist=math.hypot(dx,dy)
            if dist < 0.15:
                self._pi=(self._pi+1) % len(self._patrol)
                self.v=0.0; self.w=0.0
            else:
                desired=math.atan2(dy,dx)
                err=desired-self.th
                while err>math.pi: err-=2*math.pi
                while err<-math.pi: err+=2*math.pi
                self.w=max(-1.2,min(1.2,2.0*err))
                self.v=min(0.5,dist) if abs(err)<0.3 else 0.05
        self.th+=self.w*0.05
        self.x+=self.v*math.cos(self.th)*0.05
        self.y+=self.v*math.sin(self.th)*0.05
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
        s=LaserScan(); s.header.stamp=now; s.header.frame_id='laser_frame'
        s.angle_min=-math.pi; s.angle_max=math.pi; s.angle_increment=2*math.pi/360.0
        s.range_min=0.1; s.range_max=12.0
        s.ranges=[float(rayCast(self.x,self.y,self.th+a,s.range_max)) for a in [s.angle_min+i*s.angle_increment for i in range(360)]]
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
  return path.join(SIM_WS_ROOT, safe);
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
    const dirs = ['src/sim_robot/sim_robot','src/sim_robot/launch','build','install','log'];
    dirs.forEach(d => fss.mkdirSync(path.join(root, d), { recursive:true }));
    fss.writeFileSync(path.join(root, 'src/sim_robot/package.xml'),
      `<?xml version="1.0"?>\n<package format="3">\n  <name>sim_robot</name>\n  <version>0.1.0</version>\n  <description>ROS2 IDE Sim sample package</description>\n  <maintainer email="sim@ros2ide.local">sim</maintainer>\n  <buildtool_depend>ament_python</buildtool_depend>\n  <exec_depend>rclpy</exec_depend>\n</package>\n`);
    fss.writeFileSync(path.join(root, 'src/sim_robot/setup.py'),
      `from setuptools import setup\nsetup(name='sim_robot', packages=['sim_robot'])\n`);
    fss.writeFileSync(path.join(root, 'src/sim_robot/sim_robot/__init__.py'), '');
    fss.writeFileSync(path.join(root, 'src/sim_robot/sim_robot/talker.py'),
      `import rclpy\nfrom rclpy.node import Node\nfrom std_msgs.msg import String\n\nclass Talker(Node):\n    def __init__(self):\n        super().__init__('talker')\n        self.pub = self.create_publisher(String, '/chatter', 10)\n        self.i = 0\n        self.timer = self.create_timer(1.0, self.cb)\n    def cb(self):\n        msg = String(); msg.data = f'hello sim {self.i}'; self.i += 1\n        self.pub.publish(msg); self.get_logger().info(f'Pub: {msg.data}')\n\nif __name__ == '__main__':\n    rclpy.init(); rclpy.spin(Talker()); rclpy.shutdown()\n`);
    fss.writeFileSync(path.join(root, 'src/sim_robot/launch/sim.launch.py'),
      `from launch import LaunchDescription\nfrom launch_ros.actions import Node\n\ndef generate_launch_description():\n    return LaunchDescription([\n        Node(package='sim_robot', executable='talker.py', name='talker'),\n    ])\n`);
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
  const { pendingReqs, monSockets, webSockets, WebSocket } = deps;
  const root = wsRoot(robotKey);
  let initialMap=null;try{initialMap=JSON.parse(fss.readFileSync(path.join(root,'map.json'),'utf8'));}catch{}
  const eng  = new SimEngine(robotKey,initialMap);
  const domain = domainFor(robotKey);       // ROS_DOMAIN_ID เฉพาะหุ่นนี้ (แยก topic ไม่ให้ชน sim อื่น)
  seed(root);

  // ── Sim backend (dummy-primary): เปิด sim ด้วย dummy kinematic (SIM_STATE_PUB) เสมอ ──
  //  หุ่นที่ user ออกแบบ (src/sim_robot_odom/scripts/wheel_odom) จะ "ไม่" รันอัตโนมัติอีกต่อไป
  //  → ผู้ใช้กด "▶ Run in Sim" ในแผง Odometry (หน้า Robot Config) เพื่อรัน odom เอง (เปิดด้วยตัวเอง ทุก package)
  //  dummy fallback: กล่องชั่วคราว กันหน้าว่างก่อนออกแบบ + รองรับ Teleop (/cmd_vel)
  //  (Gazebo auto-start ปิดไปตามนโยบาย dummy-primary; โฟลเดอร์ sim_gazebo/ ยังคงอยู่บนดิสก์ หากต้องการรันเอง)
  try { fss.mkdirSync(path.join(root, 'tmp'), { recursive: true }); } catch (e) {}
  let _rosSetup = '';
  try { const ds = fss.readdirSync('/opt/ros').filter(d => /^[a-z]+$/.test(d)).sort(); if (ds.length) _rosSetup = `/opt/ros/${ds[ds.length - 1]}/setup.bash`; } catch (e) {}
  // ฆ่า backend ตัวเก่าที่ค้าง (dummy pub + user wheel_odom) ก่อนรันใหม่ → กัน /odom ซ้อนกัน
  // ⚠️ ต้องรอ pkill จบก่อน spawn ใหม่ (รัน spawn ใน callback ของ exec)
  //    ถ้าสั่ง pkill แล้ว spawn ต่อกันแบบ async → pkill จะฆ่า node ที่เพิ่ง spawn ไปเอง (race → sim ว่างเปล่า)
  const startBackend = () => {
    // ⚠️ ไม่ auto-start wheel_odom (หุ่นที่ user ออกแบบ) — ผู้ใช้รันเองผ่าน "▶ Run in Sim"
    //    ดังนั้นเปิด sim ด้วย dummy fallback (SIM_STATE_PUB) เสมอ (กล่องชั่วคราว + Teleop)
    try { fss.writeFileSync(path.join(root, 'tmp', '_sim_state_pub.py'), SIM_STATE_PUB); } catch (e) {}
    const _pubPy = path.join(root, 'tmp', '_sim_state_pub.py');
    const _pubLog = path.join(root, 'tmp', '_sim_state.log');
    let _pubStdio = ['ignore', 'ignore', 'ignore'];
    try { const fd = fss.openSync(_pubLog, 'a'); _pubStdio = ['ignore', fd, fd]; } catch (e) {}
    const simPubChild = spawn('bash', ['-lc', `source ${_rosSetup} 2>/dev/null; exec python3 -u ${_pubPy}`], {
      cwd: root,
      env: { ...process.env, HOME: root, TERM: 'xterm-256color', ROS_DOMAIN_ID: String(domain) },
      detached: true,
      stdio: _pubStdio,
    });
    simPubChild.unref();
    console.log('[SIM] dummy SIM_STATE_PUB fallback for', robotKey, '(wheel_odom เปิดด้วยตัวเองผ่าน Run in Sim)');
  };
  try { exec(`pkill -f '${root}/.*_sim_state_pub[.]py' 2>/dev/null; pkill -f '${root}/.*wheel_odom' 2>/dev/null`, () => startBackend()); }
  catch (e) { startBackend(); }

  const cwdState = new Map();               // termId → relative path (cwd)
  const termState = new Map();              // termId → { line } (terminal buffer)
  const monTimers = new Map();
  const shells = new Map();                 // termId → child_process (shell จริง บน server)
  const monChildren = new Map();            // monTermId → child_process (subscribe topic จริง)
  let rvizTermId = null;                    // termId ของ rviz ที่กำลังเปิด (สำหรับสตรีม/ปิด)

  const reply = (reqId, ok, data, error) => {
    const cb = pendingReqs.get(reqId);
    if (cb) { cb({ ok, data, error }); pendingReqs.delete(reqId); }
  };

  // รันคำสั่งจริงบน server (มี ROS) ภายใน workspace ของหุ่น
  function realExec(cmd, cwd = root) {
    // ใน sim: ~/ros2_ws คือ alias ของ root → แปลให้ชี้มาที่ ~ (root) เหมือนทาง terminal
    // ป้องกันคำสั่งเช่น `mkdir -p ~/ros2_ws/src` สร้างโฟลเดอร์ ros2_ws ซ้อนซ้ำ
    cmd = cmd.replace(/~\/ros2_ws(?=\/|\s|$)/g, '~');
    // แปล /tmp/... ให้ชี้เข้า workspace ของหุ่น (root/tmp/...) → ไฟล์ rviz/monitor ไม่ปนกันบน /tmp กลาง
    const tmpRoot = path.join(root, 'tmp') + '/';
    cmd = cmd.replace(/(^|[\s'";&|()])(\/tmp\/)/g, '$1' + tmpRoot);
    try { fss.mkdirSync(tmpRoot, { recursive:true }); } catch (e) {}
    return new Promise(resolve => {
      const child = exec(cmd, {
        shell: '/bin/bash', cwd,
        timeout: 120000, maxBuffer: 20 * 1024 * 1024,
        // ⚠️ ต้องมี ROS_DOMAIN_ID เสมอ (ก่อนหน้านี้ env ถูกเขียนซ้ำสองรอบ → key หลังทับ front ทำให้
        //    ROS_DOMAIN_ID หาย → คำสั่งพวก ros2 node list / rviz bridge ไปรันใน domain 0
        //    ไม่ตรงกับ node ที่รันใน terminal (domain ของ sim) → dashboard/rviz ไม่เจอ node)
        env: { ...process.env, HOME: cwd, TERM: 'xterm-256color', ROS_DOMAIN_ID: String(domain) },
      }, (err, stdout, stderr) => {
        resolve({
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim(),
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        });
      });
    });
  }

  // exec สำหรับ ros2 / dashboard / rviz / goal (ไม่รวม shell builtin)
  // ⚠️ สำคัญ: simulation รัน ROS จริงบน server โดยใช้ ROS_DOMAIN_ID ของหุ่นนี้ (ดู realExec)
  //    ดังนั้น rviz / topic list / node list ต้องรันคำสั่งจริงเพื่ออ่าน topic ที่ package ของผู้ใช้กำลัง publish
  //    ไม่ใช้ข้อมูลจำลองอีกต่อไป (กัน rviz "ไม่ตรงตาม package ที่รัน" และ topic ชนกันระหว่าง sim)
  async function runExec(cmd) {
    if (/topic\s+pub.*goal_pose/.test(cmd)) {
      const mx = cmd.match(/x:\s*([-\d.]+)/), my = cmd.match(/y:\s*([-\d.]+)/);
      if (mx && my) eng.setGoal(mx[1], my[1]);
      return { stdout:'publishing goal...', stderr:'', code:0 };
    }
    // ⚠️ ห้าม block คำสั่ง pkill — ก่อนหน้านี้มีการ short-circuit ทุกคำสั่งที่มี "pkill"
    //    ซึ่งทำให้คำสั่งเริ่ม rviz (startCmd ที่มี `pkill ...; nohup python3 ... &`) ถูกยกเลิก silently
    //    ผลคือ bridge (_rviz_rt.py) ไม่ได้รันเลย → หน้า RVIZ ไม่มีข้อมูล TF
    //    ตอนนี้ pkill รันได้ปกติ (จริงบน server) และ realExec จะ rewrite /tmp/ ให้ชี้มาที่
    //    root/tmp ของ sim นี้ ทำให้ฆ่า/เริ่ม bridge ได้ถูกต้องโดยไม่ไปกระทบ sim อื่น
    // ตรวจ ROS_DISTRO จริงบน server (ไม่ฮาร์ดโค้ด humble)
    if (/ROS_DISTRO=/.test(cmd)) {
      let setup = '';
      try {
        const ds = fss.readdirSync('/opt/ros').filter(d => /^[a-z]+$/.test(d)).sort();
        if (ds.length) setup = `/opt/ros/${ds[ds.length-1]}/setup.bash`;
      } catch {}
      if (setup) return { stdout: `ROS_DISTRO=${path.basename(path.dirname(setup))}\nSETUP=${setup}`, stderr:'', code:0 };
      return { stdout:'ROS_DISTRO=unknown\nSETUP=/opt/ros/humble/setup.bash', stderr:'', code:0 };
    }
    if (/tf_static/.test(cmd)) return { stdout: JSON.stringify({transforms:[]}), stderr:'', code:0 };
    // ทุกคำสั่งอื่น (ros2 run/launch, ros2 topic/node list, rviz streamer, colcon build, ls ...)
    // → รันจริงบน server พร้อม ROS_DOMAIN_ID ของหุ่นนี้ (แยก topic ไม่ให้ชน simulation อื่น)
    return realExec(cmd, root);
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

  const ws = {
    readyState: WebSocket.OPEN,
    send(str) {
      let msg; try { msg = JSON.parse(str); } catch { return; }
      const { type } = msg;

      if (type === 'request') {
        const { reqId, action, payload } = msg;
        Promise.resolve(action === 'exec' ? runExec(payload.command || '') : runFs(action, payload || {}))
          .then(data => reply(reqId, true, action === 'exec' ? data : data))
          .catch(e => reply(reqId, false, null, e.message));
      }

      else if (type === 'pty_init') {
        const id = msg.termId;
        if (id.startsWith('mon_') || id.startsWith('rviz_')) {
          // monitor / rviz ยังคงใช้ข้อมูลจำลอง (SimEngine) เหมือนเดิม
          if (id.startsWith('rviz_')) {
            rvizTermId = id;                 // จดจำ termId ของ rviz ที่เปิดอยู่
            const sock = webSockets.get(id);
            if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({type:'pty_output',termId:id,data:b64('\x1b[32msim@ros2\x1b[0m:~/ros2_ws$ ')}));
            cwdState.set(id, '');
            termState.set(id, { line:'' });
          }
          return;
        }
        if (shells.has(id)) return;
        // สปาวน์ shell จริงบน server (มี PTY ผ่าน `script`) → colcon build / คำสั่งรันได้จริง
        const child = spawn('script', ['-qec', 'bash -i', '/dev/null'], {
          cwd: root,
          // ⚠️ ต้องเซ็ต ROS_DOMAIN_ID ให้ shell ของ terminal ด้วย
          //    ก่อนหน้านี้ shell นี้ไม่ได้ตั้ง → node ที่รันผ่าน Run manager ตกอยู่ใน default domain (0)
          //    ขณะที่ dashboard ใช้ ros2 node list ใน domain ของ sim นี้ → เลยมองไม่เห็น node ที่รันจาก Run manager
          //    และการ Kill ผ่าน ros2 node kill ก็ไปฆ่า domain ผิดตัว ผลคือ "กด kill แล้ว node ไม่ตาย"
          env: { ...process.env, HOME: root, TERM: 'xterm-256color', COLORTERM: 'truecolor', ROS_DOMAIN_ID: String(domain) },
        });
        const sockOf = () => { const s = webSockets.get(id); return (s && s.readyState === WebSocket.OPEN) ? s : null; };
        const fwd = d => { const s = sockOf(); if (s) s.send(JSON.stringify({ type:'pty_output', termId:id, data: Buffer.from(d).toString('base64') })); };
        child.stdout.on('data', fwd);
        child.stderr.on('data', fwd);
        child.on('exit', () => {
          shells.delete(id);
          const s = sockOf();
          if (s) s.send(JSON.stringify({ type:'pty_closed', termId:id }));
        });
        child.on('error', () => { shells.delete(id); });
        shells.set(id, child);
      }

      else if (type === 'pty_input') {
        const id = msg.termId, data = msg.data || '';
        if (id.startsWith('mon_') && /_mon\.py/.test(data)) {
          const topic = (data.match(/'([^']+)'/)||[])[1] || '/scan';
          const sock = monSockets.get(id);
          if (sock?.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({type:'pty_output',termId:id,data:b64('READY:sim\n')}));
            const t = setInterval(() => {
              const s = monSockets.get(id);
              if (!s || s.readyState !== WebSocket.OPEN) { clearInterval(t); monTimers.delete(id); return; }
              s.send(JSON.stringify({type:'pty_output',termId:id,data:b64('MSG:'+JSON.stringify(eng.msgFor(topic))+'\n')}));
            }, 200);
            monTimers.set(id, t);
          }
          return;
        }
        if (id.startsWith('rviz_')) {
          // rviz ใช้ข้อมูลจำลอง (SimEngine) — คงพฤติกรรมเดิม
          const st = termState.get(id); if (st === undefined) return;
          const sock = webSockets.get(id);
          const out = s => sock?.readyState===WebSocket.OPEN && sock.send(JSON.stringify({type:'pty_output',termId:id,data:b64(s)}));
          for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
              const line = st.line ? st.line.trim() : '';
              st.line = '';
              out('\r\n');
              if (line) {
                Promise.resolve(shell(line, id)).then(r => {
                  if (r) out(r.replace(/\n/g, '\r\n') + '\r\n');
                  out('\x1b[32msim@ros2\x1b[0m:~/ros2_ws$ ');
                });
              } else out('\x1b[32msim@ros2\x1b[0m:~/ros2_ws$ ');
            } else if (ch === '\x7f') { if (st.line) { st.line = st.line.slice(0,-1); out('\b \b'); } }
            else { st.line += ch; out(ch); }
          }
          return;
        }
        // terminal ปกติ → ส่งเข้า shell จริง
        // workspace คือ root เอง → แปล alias ~/ros2_ws ให้ชี้มาที่ ~ (root) โดยไม่ต้องมีโฟลเดอร์จริง
        const sh = shells.get(id);
        if (sh) sh.stdin.write(data.replace(/~\/ros2_ws(?=\/|\s|$)/g, '~'));
      }

      else if (type === 'pty_close') {
        const id = msg.termId;
        if (monTimers.has(id)) { clearInterval(monTimers.get(id)); monTimers.delete(id); }
        if (id.startsWith('rviz_')) { eng.rvizOn = false; cwdState.delete(id); termState.delete(id); rvizTermId = null; return; }
        const sh = shells.get(id);
        if (sh) { try { sh.kill(); } catch {} shells.delete(id); }
        cwdState.delete(id);
        termState.delete(id);
      }
    },
    close() {
      eng.destroy();
      monTimers.forEach(clearInterval);
      shells.forEach(s => { try { s.kill(); } catch {} });
      // ฆ่า Sim Robot State Publisher ของ sim นี้
      try {
        if (fss.existsSync(simPubPidFile)) {
          const pid = parseInt(fss.readFileSync(simPubPidFile, 'utf8').trim());
          if (pid) try { process.kill(pid, 'SIGKILL'); } catch (e) {}
        }
      } catch (e) {}
      try { exec(`pkill -f '${root}/.*_sim_gazebo[.]sh' 2>/dev/null; pkill -f '${root}/.*_sim_state_pub[.]py' 2>/dev/null`, () => {}); } catch (e) {}
    },
  };

  // ── รีสตาร์ท backend ให้โหลด ~/map.json ใหม่ (เรียกจาก endpoint /api/sim/apply-map) ──
  function respawnBackend(mapJson) {
    try { fss.mkdirSync(path.join(root, 'tmp'), { recursive: true }); } catch (e) {}
    if (mapJson != null) {
      try { fss.writeFileSync(path.join(root, 'map.json'), typeof mapJson === 'string' ? mapJson : JSON.stringify(mapJson)); } catch (e) {}
      try { eng.applyMap(typeof mapJson==='string'?JSON.parse(mapJson):mapJson); } catch (e) {}
    }
    // pkill ตัวเก่า (dummy + wheel_odom) แล้วรัน backend ใหม่ → dummy โหลด ~/map.json ใหม่
    try { exec(`pkill -f '${root}/.*_sim_state_pub[.]py' 2>/dev/null; pkill -f '${root}/.*wheel_odom' 2>/dev/null`, () => startBackend()); }
    catch (e) { startBackend(); }
  }

  return { ws, lastSeen: Date.now(), _sim: true, _engine: eng, respawnBackend };
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
import json, math, os, time
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from geometry_msgs.msg import TransformStamped, Twist
from tf2_ros import StaticTransformBroadcaster, TransformBroadcaster
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from std_msgs.msg import String

BE = QoSProfile(depth=10, reliability=QoSReliabilityPolicy.BEST_EFFORT)
ST = QoSProfile(depth=100, reliability=QoSReliabilityPolicy.RELIABLE, durability=QoSDurabilityPolicy.TRANSIENT_LOCAL)
CMD_TIMEOUT = 0.5

WALLS = [(-4,-4,4,-4),(4,-4,4,4),(4,4,-4,4),(-4,4,-4,-4),
         (-1,-1,1,-1),(1,-1,1,1),(1,1,-1,1),(-1,1,-1,1),(2.5,-3,2.5,-1)]
def ray_cast(ox,oy,ang,max_r):
    best=max_r; dx=math.cos(ang); dy=math.sin(ang)
    for x1,y1,x2,y2 in WALLS:
        sx,sy=x2-x1,y2-y1; den=dx*sy-dy*sx
        if abs(den)<1e-9: continue
        t=((x1-ox)*sy-(y1-oy)*sx)/den; u=((x1-ox)*dy-(y1-oy)*dx)/den
        if t>0 and t<best and 0<=u<=1: best=t
    return best

MAP_START=(0.0,0.0)
try:
    with open(os.path.expanduser('~/map.json')) as _f: _m=json.load(_f)
    w=_m.get('walls') or []
    if w: WALLS=[tuple(float(v) for v in wall[:4]) for wall in w if len(wall)>=4]
    b=_m.get('bounds')
    if b: WALLS=[(b[0],b[1],b[2],b[1]),(b[2],b[1],b[2],b[3]),(b[2],b[3],b[0],b[3]),(b[0],b[3],b[0],b[1])]
    s=_m.get('start')
    if s: MAP_START=(float(s[0]),float(s[1]))
except Exception:
    pass

class MapSimNode(Node):
    def __init__(self):
        super().__init__('sim_robot_mapsim')
        self.declare_parameter('map_file', str(os.path.expanduser('~/map.json')))
        self.map_file=self.get_parameter('map_file').get_parameter_value().string_value
        self.map_pub=self.create_publisher(OccupancyGrid,'/map',1)
        self.scan_pub=self.create_publisher(LaserScan,'/scan',1)
        self.cmd_vel_sub=self.create_subscription(Twist,'/cmd_vel',self._cmd_vel_cb,1)
        self.static_br=StaticTransformBroadcaster(self)
        self.br=TransformBroadcaster(self)
        self.x,self.y,self.th=float(MAP_START[0]),float(MAP_START[1]),0.0
        self.last_cmd=Twist(); self.last_cmd_time=0.0
        self.map_data=None; self._load_map()
        self._publish_static_tfs()
        self.timer=self.create_timer(0.05,self._tick)
        self.get_logger().info('sim_robot_mapsim started')
    def _load_map(self):
        try:
            with open(self.map_file,'r') as f: data=json.load(f)
        except Exception as e:
            self.get_logger().error(f'Failed to load map: {e}')
            data={'bounds':[-4,-4,4,4],'walls':[],'start':[0,0]}
        b=data.get('bounds',[-4,-4,4,4]); res=0.1
        w=int(math.ceil(abs(b[2]-b[0])/res)); h=int(math.ceil(abs(b[3]-b[1])/res))
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
        self.map_data.info.origin.position.x=b[0]; self.map_data.info.origin.position.y=b[1]
        self.map_data.info.origin.orientation.w=1.0; self.map_data.data=grid
    def _publish_static_tfs(self):
        t=TransformStamped(); t.header.frame_id='map'; t.child_frame_id='odom'
        t.transform.translation.x=t.transform.translation.y=t.transform.translation.z=0; t.transform.rotation.w=1.0
        self.static_br.sendTransform(t)
        t2=TransformStamped(); t2.header.frame_id='base_link'; t2.child_frame_id='laser_frame'
        t2.transform.translation.x=0.2; t2.transform.translation.z=0.1; t2.transform.rotation.w=1.0
        self.static_br.sendTransform(t2)
    def _cmd_vel_cb(self,msg): self.last_cmd=msg; self.last_cmd_time=time.time()
    def _tick(self):
        if self.map_data:
            dt=0.05
            v=self.last_cmd.linear.x if time.time()-self.last_cmd_time<CMD_TIMEOUT else 0.0
            wz=self.last_cmd.angular.z if time.time()-self.last_cmd_time<CMD_TIMEOUT else 0.0
            self.th+=wz*dt; self.x+=v*math.cos(self.th)*dt; self.y+=v*math.sin(self.th)*dt
            now=self.get_clock().now().to_msg(); self.map_data.header.stamp=now
            self.map_pub.publish(self.map_data)
            tf=TransformStamped(); tf.header.stamp=now; tf.header.frame_id='odom'; tf.child_frame_id='base_link'
            tf.transform.translation.x=self.x; tf.transform.translation.y=self.y
            tf.transform.rotation.z=math.sin(self.th/2); tf.transform.rotation.w=math.cos(self.th/2); self.br.sendTransform(tf)
            scan=LaserScan(); scan.header.stamp=now; scan.header.frame_id='laser_frame'
            scan.angle_min=-math.pi/2; scan.angle_max=math.pi/2; scan.angle_increment=math.pi/180
            scan.range_min=0.1; scan.range_max=10.0
            n=int((scan.angle_max-scan.angle_min)/scan.angle_increment)+1
            scan.ranges=[self._ray(self.x,self.y,self.th+scan.angle_min+i*scan.angle_increment) for i in range(n)]
            self.scan_pub.publish(scan)
    def _ray(self,ox,oy,ang,step=0.05,rng=10.0):
        for d in range(int((rng-0.1)/step)+1):
            cur=0.1+d*step; tx=ox+cur*math.cos(ang); ty=oy+cur*math.sin(ang)
            mx=int((tx-self.map_data.info.origin.position.x)/self.map_data.info.resolution)
            my=int((ty-self.map_data.info.origin.position.y)/self.map_data.info.resolution)
            if 0<=mx<self.map_data.info.width and 0<=my<self.map_data.info.height:
                if self.map_data.data[my*self.map_data.info.width+mx]==100: return cur
        return 10.0
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
  <buildtool_depend>ament_python</buildtool_depend>
  <exec_depend>rclpy</exec_depend>
  <exec_depend>std_msgs</exec_depend>
  <exec_depend>sensor_msgs</exec_depend>
  <exec_depend>nav_msgs</exec_depend>
  <exec_depend>tf2_ros</exec_depend>
  <exec_depend>geometry_msgs</exec_depend>
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

module.exports = { createSimAgent, isSim, SIM_NODES, SIM_TOPICS, SIM_STATE_PUB, SimEngine, wsRoot, toAbs, writeTfPackage, writeOdomPackage, writeMapsimPackage, genMapsimFiles };
