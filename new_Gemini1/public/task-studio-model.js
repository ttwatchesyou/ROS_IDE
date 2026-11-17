'use strict';
((root)=>{
  const clone=x=>JSON.parse(JSON.stringify(x));
  const id=()=> 'b'+Math.random().toString(36).slice(2,11);
  const types={log:{label:'ข้อความ',icon:'≡',defaults:{text:'เริ่มทำงาน'}},wait:{label:'รอเวลา',icon:'◷',defaults:{seconds:1}},odom_position:{label:'ไปยังตำแหน่ง ODOM',icon:'⌖',defaults:{x:1,y:0,yaw:0,speed:.1,timeout:30}},wait_topic:{label:'รอข้อมูล Topic',icon:'◉',defaults:{topic:'/object_detected',field:'data',op:'==',value:true,timeout:10}},call:{label:'เรียกฟังก์ชัน',icon:'ƒ',defaults:{fn:'inspect',args:{}}},repeat:{label:'ทำซ้ำ',icon:'↻',defaults:{count:2,body:[]}}};
  types.parallel={label:'ทำพร้อมกัน A / B',icon:'⑂',defaults:{branches:[[],[]]}};
  types.publish={label:'ส่งข้อความให้เพื่อน',icon:'✉',defaults:{topic:'/task_studio/user/hello',msgType:'std_msgs/msg/String',value:'พร้อมแล้ว'}};
  types.if_topic={label:'ถ้าเงื่อนไข Topic / มิฉะนั้น',icon:'◇',defaults:{...clone(types.wait_topic.defaults),body:[],elseBody:[]}};
  Object.setPrototypeOf(types,null);
  function block(type){return {id:id(),type,...clone(types[type].defaults)};}
  function sample(){return{version:1,name:'robot_task',main:[{...block('log'),text:'Main เริ่มงาน'},{...block('call'),fn:'inspect',args:{delay:1}}],functions:[{name:'inspect',params:{delay:1},body:[{...block('log'),text:'ตรวจอุปกรณ์'},{...block('wait'),seconds:'$delay'}]}]};}
  const topicName=s=>typeof s==='string'&&/^\/[A-Za-z_][\w]*(\/[A-Za-z_][\w]*)*$/.test(s);
  const name=s=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,47}$/.test(s)&&!['main','__proto__','constructor','prototype'].includes(s);
  const resolve=(v,env)=>typeof v==='string'&&v.startsWith('$')?env[v.slice(1)]:v;
  function validateUnchecked(p){
    const errors=[],ids=new Set(),functions=new Map();let count=0;
    if(!p||p.version!==1||!name(p.name)||!Array.isArray(p.main)||!Array.isArray(p.functions))return['รูปแบบโปรแกรมหรือชื่อ Package ไม่ถูกต้อง'];
    if(p.functions.length>32)return['ฟังก์ชันมากเกิน 32'];
    for(const f of p.functions){if(!name(f.name)||functions.has(f.name))errors.push('ชื่อฟังก์ชันไม่ถูกต้องหรือซ้ำ: '+f.name);functions.set(f.name,f);if(!f.params||typeof f.params!=='object'||Array.isArray(f.params)||Object.entries(f.params).some(([k,v])=>!name(k)||typeof v!=='number'||!Number.isFinite(v)))errors.push('พารามิเตอร์ต้องเป็นชื่อและค่าเริ่มต้นตัวเลข');}
    function numeric(v,env,min,max){const n=resolve(v,env);return typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;}
    function walk(blocks,env,stack,depth=0,parallel=false){
      if(!Array.isArray(blocks)||depth>10){errors.push('โครงสร้างบล็อกไม่ถูกต้อง/ซ้อนลึกเกิน 10');return;}
      for(const b of blocks){if(++count>2000){errors.push('โปรแกรมใหญ่เกินไป');return;}
        if(!b||!types[b.type]||typeof b.id!=='string'||!/^b[a-z0-9]+$/.test(b.id)){errors.push('บล็อกไม่ถูกต้อง');continue;}
        const err=m=>errors.push(b.id+': '+m);
        if(b.type==='log'&&(typeof b.text!=='string'||b.text.length>500))err('ข้อความยาวเกินไป');
        if(b.type==='wait'&&!numeric(b.seconds,env,0,3600))err('เวลารอ 0–3600 วินาที หรือ $พารามิเตอร์');
        if(b.type==='odom_position'&&(!numeric(b.x,env,-100,100)||!numeric(b.y,env,-100,100)||!numeric(b.yaw,env,-180,180)||!numeric(b.speed,env,.01,.2)||!numeric(b.timeout,env,1,600)))err('พิกัด/มุม/ความเร็ว/timeout ไม่ถูกต้อง');
        if(parallel&&b.type==='odom_position')err('ย้ายบล็อกเคลื่อนที่ออกจากงานคู่ขนาน เพื่อให้มีผู้สั่งล้อเพียงงานเดียว');
        if(b.msgType&&!/^[a-z][a-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/.test(b.msgType))err('ชนิดข้อความต้องเป็น package/msg/Message');
        if(b.type==='publish'&&typeof b.value==='string'&&b.value.length>500)err('ข้อความยาวเกิน 500 ตัวอักษร');
        if(b.type==='publish'&&(!topicName(b.topic)||!b.topic.startsWith('/task_studio/user/')||!['std_msgs/msg/String','std_msgs/msg/Float64','std_msgs/msg/Bool'].includes(b.msgType)||typeof b.value!==({'std_msgs/msg/String':'string','std_msgs/msg/Float64':'number','std_msgs/msg/Bool':'boolean'}[b.msgType])||(typeof b.value==='number'&&!Number.isFinite(b.value))))err('ชนิดข้อความ/ค่าไม่ตรงกัน หรือ Topic ไม่อยู่ใน /task_studio/user/');
        if(['wait_topic','if_topic'].includes(b.type)&&(!topicName(b.topic)||typeof b.field!=='string'||!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(b.field)||!['==','!=','>','<','>=','<='].includes(b.op)||!['string','number','boolean'].includes(typeof b.value)||!numeric(b.timeout,env,1,600)))err('Topic / field / เงื่อนไขไม่ถูกต้อง');
        if(b.type==='if_topic'){walk(b.body,env,stack,depth+1,parallel);walk(b.elseBody,env,stack,depth+1,parallel);}
        if(b.type==='repeat'){if(!numeric(b.count,env,1,100)||!Number.isInteger(resolve(b.count,env)))err('จำนวนรอบต้องเป็นจำนวนเต็ม 1–100');walk(b.body,env,stack,depth+1,parallel);}
        if(b.type==='parallel'){if(parallel||!Array.isArray(b.branches)||b.branches.length!==2){err('งานคู่ขนานต้องมี 2 แขนง และไม่ซ้อนคู่ขนานอีกชั้น');continue;}b.branches.forEach(branch=>walk(branch,env,stack,depth+1,true));}
        if(b.type==='call'){
          const f=functions.get(b.fn);if(!f){err('ไม่พบฟังก์ชัน '+b.fn);continue;}if(stack.includes(b.fn)){err('เรียกฟังก์ชันวนกลับ: '+[...stack,b.fn].join(' → '));continue;}
          if(!b.args||typeof b.args!=='object'||Array.isArray(b.args)){err('args ไม่ถูกต้อง');continue;}
          const args={...f.params};for(const[k,v]of Object.entries(b.args)){if(!Object.hasOwn(args,k)||!numeric(v,env,-1e6,1e6))err('พารามิเตอร์ '+k+' ไม่ถูกต้อง');else args[k]=resolve(v,env);}
          walk(f.body,args,[...stack,b.fn],depth+1,parallel);
        }
      }
    }
    function unique(blocks,depth=0){if(!Array.isArray(blocks)||depth>10){errors.push('โครงสร้างบล็อกซ้อนลึกเกินไป');return;}for(const b of blocks){if(!b)continue;if(ids.has(b.id))errors.push('ID บล็อกซ้ำ');ids.add(b.id);if(ids.size>500){errors.push('เกิน 500 บล็อก');return;}if(b.type==='repeat'||b.type==='if_topic')unique(b.body,depth+1);if(b.type==='if_topic')unique(b.elseBody,depth+1);if(b.type==='parallel')for(const branch of b.branches||[])unique(branch,depth+1);}}
    unique(p.main);p.functions.forEach(f=>unique(f.body));
    walk(p.main,{},['Main']);for(const f of p.functions)walk(f.body,f.params||{},[f.name]);
    return [...new Set(errors)];
  }
  function validate(p){try{return validateUnchecked(p);}catch{return['รูปแบบโปรแกรมไม่ถูกต้อง'];}}
  function* steps(p,blocks=p.main,env={},stack=['Main']){
    for(const source of blocks){const b={...source};for(const k of ['seconds','x','y','yaw','speed','timeout','count'])if(k in b)b[k]=resolve(b[k],env);
      yield{block:b,stack:[...stack],env:{...env},phase:'enter'};
      if(b.type==='call'){const f=p.functions.find(f=>f.name===b.fn),args={...f.params};for(const[k,v]of Object.entries(b.args))args[k]=resolve(v,env);yield* steps(p,f.body,args,[...stack,b.fn]);}
      if(b.type==='repeat')for(let i=0;i<b.count;i++)yield* steps(p,b.body,env,[...stack,`รอบ ${i+1}/${b.count}`]);
      yield{block:b,stack:[...stack],env:{...env},phase:'exit'};
    }
  }
  function field(message,path){return path.split('.').reduce((v,k)=>v!=null&&Object.hasOwn(v,k)?v[k]:undefined,message);}
  function compare(a,op,b){if(a===undefined)return false;if(op==='==')return a===b;if(op==='!=')return a!==b;if(typeof a!=='number'||typeof b!=='number')return false;return op==='>'?a>b:op==='<'?a<b:op==='>='?a>=b:a<=b;}
  // Uncompressed ZIP: portable offline export, no CDN or archive dependency.
  function zip(files){
    const enc=new TextEncoder(),parts=[],central=[];let offset=0;
    const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
    const header=(size)=>{const b=new Uint8Array(size);return[b,new DataView(b.buffer)];};
    for(const[path,content]of Object.entries(files)){const n=enc.encode(path),data=enc.encode(content),sum=crc(data),[h,v]=header(30);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);v.setUint32(14,sum,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n.length,true);parts.push(h,n,data);
      const[c,d]=header(46);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,sum,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,n.length,true);d.setUint32(42,offset,true);central.push(c,n);offset+=h.length+n.length+data.length;
    }
    const[e,v]=header(22),size=central.reduce((s,b)=>s+b.length,0),count=Object.keys(files).length;v.setUint32(0,0x06054b50,true);v.setUint16(8,count,true);v.setUint16(10,count,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);return new Blob([...parts,...central,e],{type:'application/zip'});
  }
  function packageFiles(p,runner){
    const errors=validate(p);if(errors.length)throw Error(errors.join('\n'));const n=p.name,flow=JSON.stringify(p,null,2);
    return{[`${n}/package.xml`]:`<?xml version="1.0"?><package format="3"><name>${n}</name><version>0.1.0</version><description>ROSIDE Task Studio program</description><maintainer email="operator@example.com">Robot operator</maintainer><license>Apache-2.0</license><exec_depend>rclpy</exec_depend><exec_depend>std_msgs</exec_depend><exec_depend>geometry_msgs</exec_depend><exec_depend>nav_msgs</exec_depend><exec_depend>rosidl_runtime_py</exec_depend><exec_depend>ament_index_python</exec_depend><exec_depend>launch_ros</exec_depend><export><build_type>ament_python</build_type></export></package>`,
      [`${n}/setup.py`]:`from setuptools import setup\nsetup(name='${n}',version='0.1.0',packages=['${n}'],data_files=[('share/ament_index/resource_index/packages',['resource/${n}']),('share/${n}',['package.xml']),('share/${n}/flows',['flows/task.flow.json']),('share/${n}/launch',['launch/task.launch.py'])],install_requires=['setuptools'],entry_points={'console_scripts':['task_runner = ${n}.task_runner:main']})\n`,
      [`${n}/setup.cfg`]:`[develop]\nscript_dir=$base/lib/${n}\n[install]\ninstall_scripts=$base/lib/${n}\n`,[`${n}/resource/${n}`]:'',[`${n}/${n}/__init__.py`]:'',
      [`${n}/${n}/task_runner.py`]:runner.replaceAll('__TASK_PACKAGE__',n),[`${n}/flows/task.flow.json`]:flow,
      [`${n}/launch/task.launch.py`]:`from launch import LaunchDescription\nfrom launch_ros.actions import Node\ndef generate_launch_description():\n    return LaunchDescription([Node(package='${n}',executable='task_runner',parameters=[{'dry_run':True}])])\n`,
      [`${n}/README.md`]:`# ${n}\n\nGenerated by ROSIDE Task Studio. Target: ROS 2 Humble / Jazzy (ament_python). Install message packages required by your topics.\n\nExtract into workspace src, source your ROS environment, run colcon build --packages-select ${n}, source install/setup.bash, then ros2 launch ${n} task.launch.py. Default is DRY RUN: no motion publisher is created. The launch starts the sequence; do not enable real motion before commissioning.\n\n## Editing and debug\nImport flows/task.flow.json into Task Studio to edit Main and functions. Numeric function parameters are local; use $name in numeric fields. /task_studio/debug is std_msgs/msg/String JSON with program, step, stack, environment, phase, sequence, run ID and dry_run. Watch it from the Live ROS panel; browser Dry Run is a separate source. /task_studio/stop (std_msgs/msg/Bool true) cancels the runtime.\n\n## Real motion — requires commissioning\nOnly a robot-side safety integration may enable motion. Explicit dry_run:=false AND motion_enabled:=true are required. The controller publishes Twist only on /task_studio/cmd_vel, never the normal /cmd_vel by default. Connect it through a single-owner command arbiter, obstacle safety layer and independent velocity watchdog. Publish a fresh Bool true safety permit on /task_studio/safety_ready only while that integration and the operator lease are healthy. Loss of permit or ODOM stops and fails the task. Do NOT use a constant true publisher as a safety substitute. The web page never enables motion or starts this node. Hardware E-stop remains required.\n\nODOM positions are absolute in the odom frame (metres/degrees). No obstacle planning. Drift/reset invalidates saved waypoints. Do not replay after reboot without checking coordinates. Differential-drive controller only; maximum speed 0.2 m/s. ODOM must publish header.frame_id=odom. Success requires position within 0.05 m and yaw within 0.08 rad.\n\nLive Topic reads are bounded samples, not guaranteed continuous recording. Missing/stale/oversize messages are not treated as valid values. Runtime functions are numeric input-only in this version; no arbitrary Python execution or return-value blocks.\n`};
  }
  root.TaskStudioModel={clone,id,types,block,sample,validate,steps,field,compare,zip,packageFiles,topicName,name};
  if(typeof module!=='undefined')module.exports=root.TaskStudioModel;
})(typeof window==='undefined'?globalThis:window);
