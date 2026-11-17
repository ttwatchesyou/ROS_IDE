'use strict';
((root)=>{
  const M=root.TaskStudioModel||(typeof require==='function'?require('./task-studio-model'):null);
  const walk=(blocks,fn)=>{for(const b of blocks){fn(b);if(b.body)walk(b.body,fn);if(b.elseBody)walk(b.elseBody,fn);for(const branch of b.branches||[])walk(branch,fn);}};
  function allBlocks(program){const out=[];walk(program.main,b=>out.push(b));for(const f of program.functions)walk(f.body,b=>out.push(b));return out;}
  function unit(program=M.sample(),pkg=program.name,file='main_node'){return{id:'u'+M.id().slice(1),package:pkg,file,program:{...M.clone(program),name:file}};}
  function migrate(value){if(value?.version===2)return M.clone(value);return{version:2,name:'my_robot_app',units:[unit(value||M.sample())],topics:[],links:[],positions:{}};}
  // Drafts may contain unfinished calls/fields/wires. Reject malformed structure,
  // but leave semantic checks to Run/Export so saved work always remains editable.
  function validateDraft(app){try{
    const object=x=>x&&typeof x==='object'&&!Array.isArray(x),ids=new Set();let count=0;
    if(app?.version!==2||!M.name(app.name)||!Array.isArray(app.units)||!app.units.length||app.units.length>16||!Array.isArray(app.links)||app.links.length>100||!Array.isArray(app.topics)||app.topics.length>32||app.drafts&&!object(app.drafts)||app.positions&&!object(app.positions))throw Error();
    const blocks=(list,depth=0)=>{if(!Array.isArray(list)||depth>10)throw Error();for(const b of list){if(++count>8000||!object(b)||!M.types[b.type]||!/^b[a-z0-9]+$/.test(b.id))throw Error();if(b.type==='repeat'||b.type==='if_topic')blocks(b.body,depth+1);if(b.type==='if_topic')blocks(b.elseBody,depth+1);if(b.type==='parallel'){if(!Array.isArray(b.branches)||b.branches.length!==2)throw Error();b.branches.forEach(x=>blocks(x,depth+1));}}};
    for(const u of app.units){if(!object(u)||!/^u[a-z0-9]+$/.test(u.id)||ids.has(u.id)||!M.name(u.package)||!M.name(u.file))throw Error();ids.add(u.id);const p=u.program;if(!object(p)||p.version!==1||!M.name(p.name)||!Array.isArray(p.functions)||p.functions.length>32)throw Error();blocks(p.main);const names=new Set();for(const f of p.functions){if(!object(f)||!M.name(f.name)||names.has(f.name)||!object(f.params)||Object.entries(f.params).some(([k,v])=>!M.name(k)||typeof v!=='number'||!Number.isFinite(v)))throw Error();names.add(f.name);blocks(f.body);}}
    for(const l of app.links)if(!object(l)||!/^b[a-z0-9]+$/.test(l.id)||['source','target','input','output'].some(k=>typeof l[k]!=='string'))throw Error();
    for(const t of app.topics)if(!object(t)||!M.topicName(t.name)||!/^\w+\/msg\/\w+$/.test(t.msgType))throw Error();
    return[];
  }catch{return['โครงสร้างไฟล์ Draft ไม่ถูกต้อง หรือใหญ่เกินขีดจำกัด'];}}
  function validate(app){try{
    const errors=[];if(app?.version!==2||!M.name(app.name)||!Array.isArray(app.units)||!app.units.length||app.units.length>16||!Array.isArray(app.topics)||app.topics.length>32||!Array.isArray(app.links)||app.links.length>100)return['รูปแบบ Application ไม่ถูกต้อง'];
    const ids=new Set(),files=new Set();let motionUnits=0;
    for(const u of app.units){if(!/^u[a-z0-9]+$/.test(u.id)||ids.has(u.id)||!M.name(u.package)||!M.name(u.file)||files.has(u.package+'/'+u.file)||u.file==='task_runner')errors.push('ชื่อ Package / Node ซ้ำหรือไม่ถูกต้อง');ids.add(u.id);files.add(u.package+'/'+u.file);errors.push(...M.validate(u.program).map(e=>u.file+': '+e));if(allBlocks(u.program).some(b=>b.type==='odom_position'))motionUnits++;}
    if(motionUnits>1)errors.push('Application นี้ให้มี Node เคลื่อนที่เพียงตัวเดียว เพื่อไม่ให้แย่งควบคุมล้อ');
    const topicNames=new Set();for(const t of app.topics){if(!M.topicName(t.name)||!/^\w+\/msg\/\w+$/.test(t.msgType)||topicNames.has(t.name))errors.push('Topic ภายนอกไม่ถูกต้องหรือซ้ำ');topicNames.add(t.name);}
    const messageTypes=new Map();for(const u of app.units)for(const b of allBlocks(u.program))if(b.msgType&&b.topic){if(messageTypes.has(b.topic)&&messageTypes.get(b.topic)!==b.msgType)errors.push('ชนิดข้อความขัดแย้งกันบน '+b.topic);messageTypes.set(b.topic,b.msgType);}
    const inputs=new Set(),linkIds=new Set();for(const l of app.links){const source=endpoint(app,l.source,l.output,true),target=endpoint(app,l.target,l.input,false);if(!/^b[a-z0-9]+$/.test(l.id)||linkIds.has(l.id)||l.source===l.target||!source||!target||source.type!==target.type||source.topic!==target.topic||inputs.has(l.target+'/'+l.input))errors.push('สายเชื่อมไม่ตรง Topic/ชนิดข้อมูล หรือ Input มีสายซ้ำ');inputs.add(l.target+'/'+l.input);linkIds.add(l.id);}
    return errors;
  }catch{return['Application มีโครงสร้างไม่ถูกต้อง'];}}
  function endpoint(app,id,blockId,output){
    if(id.startsWith('topic:')){const t=app.topics.find(t=>'topic:'+t.name===id);return output&&t?{topic:t.name,type:t.msgType}:null;}
    const u=app.units.find(u=>u.id===id),b=u&&allBlocks(u.program).find(b=>b.id===blockId);if(!b||(output?b.type!=='publish':!['wait_topic','if_topic'].includes(b.type)))return null;
    return{topic:b.topic,type:b.msgType||null,block:b};
  }
  function connect(app,source,output,target,input){const a=endpoint(app,source,output,true),b=endpoint(app,target,input,false);if(!a||!b||source===target)throw Error('เลือกช่องส่งและช่องรับของคนละ Node');if(!a.type||(b.type&&a.type!==b.type))throw Error('ชนิดข้อมูลไม่ตรงกัน กรุณาเลือกชนิดเดียวกันก่อนเชื่อม');
    const previous=b.block.topic;b.block.topic=a.topic;b.block.msgType=a.type;app.links=app.links.filter(l=>l.target!==target||l.input!==input);app.links.push({id:M.id(),source,output,target,input,previousTopic:previous});
  }
  function ports(app,u){return allBlocks(u.program).filter(b=>['publish','wait_topic','if_topic'].includes(b.type)).map(b=>({id:b.id,direction:b.type==='publish'?'out':'in',topic:b.topic,type:b.msgType||'auto · กำหนดชนิดเมื่อเชื่อม'}));}
  function packageFiles(app,runner,packageOnly=null){
    const errors=validate(app);if(errors.length)throw Error(errors.join('\n'));const files={},units=app.units.filter(u=>!packageOnly||u.package===packageOnly),packages=[...new Set(units.map(u=>u.package))];
    for(const pkg of packages){const members=units.filter(u=>u.package===pkg),base=M.packageFiles({...members[0].program,name:pkg},runner);Object.assign(files,base);delete files[`${pkg}/${pkg}/task_runner.py`];delete files[`${pkg}/flows/task.flow.json`];
      const entries=[],flowPaths=[];for(const u of members){const p=M.clone(u.program);p.name=u.file;
        files[`${pkg}/${pkg}/${u.file}.py`]=runner.replaceAll('__TASK_PACKAGE__',pkg).replace("'flows/task.flow.json'",`'flows/${u.file}.flow.json'`).replace("'task_studio_runner'",`'${u.file}'`);
        files[`${pkg}/flows/${u.file}.flow.json`]=JSON.stringify(p,null,2);flowPaths.push(`'flows/${u.file}.flow.json'`);entries.push(`'${u.file} = ${pkg}.${u.file}:main'`);
      }
      files[`${pkg}/setup.py`]=`from setuptools import setup\nsetup(name='${pkg}',version='0.2.0',packages=['${pkg}'],data_files=[('share/ament_index/resource_index/packages',['resource/${pkg}']),('share/${pkg}',['package.xml']),('share/${pkg}/flows',[${flowPaths.join(',')}]),('share/${pkg}/launch',['launch/task.launch.py'])],install_requires=['setuptools'],entry_points={'console_scripts':[${entries.join(',')}]})\n`;
      files[`${pkg}/launch/task.launch.py`]=launch(members);
      const deps=new Set();for(const u of members)for(const b of allBlocks(u.program)){const d=(b.msgType||'').split('/')[0];if(/^[a-z][a-z0-9_]*$/.test(d)&&!['std_msgs','geometry_msgs','nav_msgs'].includes(d))deps.add(d);}
      files[`${pkg}/package.xml`]=files[`${pkg}/package.xml`].replace('<export>',[...deps].map(d=>`<exec_depend>${d}</exec_depend>`).join('')+'<export>');
      files[`${pkg}/README.md`]+='\n\n## Blockly application\nEach Node is a separate Python file and executable. The generated task.launch.py starts all Nodes in this package as separate processes. Parallel A/B blocks use two bounded Python worker threads, join both before continuing, and cancel siblings on failure. They support I/O waits, user-topic messages, loops and custom calls, but never motion or nested parallel blocks. Python threads do not promise CPU-bound parallelism because of the GIL. Dry run skips user-topic publishing; real ROS topic input is still required for topic waits.\n';
    }
    if(!packageOnly){let bringup=app.name+'_bringup';if(packages.includes(bringup))throw Error('ชื่อแอปชนกับ Package bringup');
      files[`${bringup}/package.xml`]=`<package format="3"><name>${bringup}</name><version>0.2.0</version><description>Task Studio Application</description><maintainer email="operator@example.com">Operator</maintainer><license>Apache-2.0</license><exec_depend>launch_ros</exec_depend>${packages.map(p=>`<exec_depend>${p}</exec_depend>`).join('')}<export><build_type>ament_python</build_type></export></package>`;
      files[`${bringup}/resource/${bringup}`]='';files[`${bringup}/setup.cfg`]=`[develop]\nscript_dir=$base/lib/${bringup}\n[install]\ninstall_scripts=$base/lib/${bringup}\n`;
      files[`${bringup}/setup.py`]=`from setuptools import setup\nsetup(name='${bringup}',version='0.2.0',packages=[],data_files=[('share/ament_index/resource_index/packages',['resource/${bringup}']),('share/${bringup}',['package.xml']),('share/${bringup}/launch',['launch/application.launch.py']),('share/${bringup}/flows',['flows/application.json'])])\n`;
      files[`${bringup}/launch/application.launch.py`]=launch(units);files[`${bringup}/flows/application.json`]=JSON.stringify(app,null,2);
      files['README.md']=`# ${app.name}\nExtract packages into workspace src, source ROS, colcon build, source install/setup.bash, then ros2 launch ${bringup} application.launch.py. Default dry_run=true. Nothing is auto-installed or run by the browser.\n\nROS Graph is a visual overview of distributed ROS 2 discovery, not a central roscore or message relay. Graph connections share a ROS topic name and compatible message type in the exported code. External topics need their own publishers. No virtual wire bypasses ROS QoS or safety. Import ${bringup}/flows/application.json to restore all packages, nodes and connections.\n`;
    }
    return files;
  }
  function launch(units){return`from launch import LaunchDescription\nfrom launch_ros.actions import Node\ndef generate_launch_description():\n    return LaunchDescription([\n${units.map(u=>`        Node(package='${u.package}',executable='${u.file}',name='${u.file}',parameters=[{'dry_run':True}],remappings=[('/task_studio/debug','/task_studio/${u.package}/${u.file}/debug'),('/task_studio/stop','/task_studio/${u.package}/${u.file}/stop')]),`).join('\n')}\n    ])\n`;}
  root.TaskStudioApplication={walk,allBlocks,unit,migrate,validateDraft,validate,endpoint,connect,ports,packageFiles};if(typeof module!=='undefined')module.exports=root.TaskStudioApplication;
})(typeof window==='undefined'?globalThis:window);
