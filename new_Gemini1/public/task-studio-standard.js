'use strict';
// Stock Blockly + ROS extensions. Never executes code supplied by an imported file.
(()=>{
  const B=Blockly,M=TaskStudioModel,J=javascript.javascriptGenerator,P=python.pythonGenerator;
  B.Msg.LISTS_CREATE_WITH_INPUT_WITH='สร้างลิสต์ด้วย';
  const stock=new Set(Object.keys(B.Blocks));let topics=[],pythonEditor=()=>{};
  const field=(name,value)=>({type:'field_input',name,text:String(value)}),value=(name,check)=>({type:'input_value',name,...(check?{check}:{})});
  const stmt=name=>({type:'input_statement',name});
  const types=[
    {type:'rs_start',message0:'🚩 เมื่อเริ่มเล่น',nextStatement:null,colour:'#edae34',hat:'cap'},
    {type:'rs_wait',message0:'⏱ รอ %1 วินาที',args0:[value('SECONDS','Number')],colour:'#edae34'},
    {type:'rs_until',message0:'รอจนกว่า %1',args0:[value('BOOL','Boolean')],message1:'ไม่เกิน %1 วินาที',args1:[value('TIMEOUT','Number')],colour:'#edae34'},
    {type:'rs_parallel',message0:'⑂ ช่วยกันทำสองงาน',message1:'งาน A %1',args1:[stmt('A')],message2:'งาน B %1',args2:[stmt('B')],colour:'#299fb0'},
    {type:'rs_move',message0:'⌖ ไปตำแหน่ง ODOM',message1:'X %1 Y %2 หัน %3 องศา',args1:[value('X','Number'),value('Y','Number'),value('YAW','Number')],message2:'ความเร็ว %1 m/s ไม่เกิน %2 วินาที',args2:[value('SPEED','Number'),value('TIMEOUT','Number')],colour:'#4e87da'},
    {type:'rs_publish',message0:'📤 ส่งข้อมูล',message1:'Topic %1',args1:[field('TOPIC','/task_studio/user/hello')],message2:'ชนิด %1 ค่า %2',args2:[{type:'field_dropdown',name:'MSG',options:[['ข้อความ','std_msgs/msg/String'],['ตัวเลข','std_msgs/msg/Float64'],['จริง / เท็จ','std_msgs/msg/Bool']]},value('VALUE')],colour:'#2f9b78'},
    {type:'rs_python',message0:'🐍 Python · %1',args0:[field('NAME','ฟังก์ชันของฉัน')],message1:'เลือกบล็อก แล้วกด แก้ Python',colour:'#626bc4'}
  ];
  B.defineBlocksWithJsonArray(types.map(d=>d.type==='rs_start'?d:{previousStatement:null,nextStatement:null,inputsInline:true,...d}));
  const options=block=>{const current=block?.getFieldValue('TOPIC'),saved=current&&current!=='__choose__'?current:block?.savedTopic;const result=[['เลือก Topic…','__choose__'],...topics.map(t=>[t.name+(t.source==='app'?' · ในแอป':''),t.name])];if(saved&&saved!=='__choose__'&&!result.some(x=>x[1]===saved))result.push([saved+' · ยังไม่พบ',saved]);return result;};
  function updateType(block,topic){const found=topics.find(t=>t.name===topic);if(block?.getField('MSG')&&found)block.setFieldValue(found.types.length===1?found.types[0]:'ชนิดขัดแย้ง','MSG');if(block?.type==='rs_read'&&block.outputConnection){const check=({'std_msgs/msg/Bool':'Boolean','std_msgs/msg/Float64':'Number','std_msgs/msg/String':'String'})[block.getFieldValue('MSG')]||null;block.setOutput(true,check);}}
  B.Blocks.rs_read={init(){const menu=new B.FieldDropdown(function(){return options(this.getSourceBlock());},function(v){updateType(this.getSourceBlock(),v);return v;});this.appendDummyInput().appendField('📥 ข้อมูลจาก').appendField(menu,'TOPIC');this.appendDummyInput().appendField(new B.FieldLabelSerializable('เลือก Topic เพื่อระบุชนิด'),'MSG');this.appendDummyInput().appendField('ช่อง').appendField(new B.FieldTextInput('data'),'FIELD');this.appendValueInput('TIMEOUT').setCheck('Number').appendField('รอข้อมูลสดไม่เกิน');this.setOutput(true);this.setColour('#2f9b78');this.setTooltip('ข้อมูลเข้าใช้ต่อกับคณิตศาสตร์ เงื่อนไข ตัวแปร หรือข้อความได้');},saveExtraState(){return{topic:this.getFieldValue('TOPIC')};},loadExtraState(s){this.savedTopic=s.topic;this.getField('TOPIC').getOptions(false);}};
  const publishInit=B.Blocks.rs_publish.init;
  B.Blocks.rs_publish.init=function(){publishInit.call(this);const row=this.inputList.find(i=>i.fieldRow.some(f=>f.name==='TOPIC'));row.removeField('TOPIC');this.savedPublishTopic='/task_studio/user/hello';const dropdown=new B.FieldDropdown(function(){const b=this.getSourceBlock(),saved=b?.getFieldValue('TOPIC')||b?.savedPublishTopic||'/task_studio/user/hello',names=[...new Set([saved,b?.savedPublishTopic||'/task_studio/user/hello',...topics.filter(t=>t.name.startsWith('/task_studio/user/')).map(t=>t.name)])].filter(n=>n!=='__new__');return[...names.map(n=>[n,n]),['＋ สร้าง Topic ส่งใหม่…','__new__']];},function(v){const b=this.getSourceBlock();if(v==='__new__'){B.dialog.prompt('ชื่อ Topic ส่งใหม่ (อยู่ใน /task_studio/user/)','/task_studio/user/my_message',name=>{if(!name||!M.topicName(name)||!name.startsWith('/task_studio/user/'))return;b.savedPublishTopic=name;this.getOptions(false);this.setValue(name);});return null;}const found=topics.find(t=>t.name===v);if(found?.types.length===1&&b?.getField('MSG').getOptions(false).some(o=>o[1]===found.types[0]))b.setFieldValue(found.types[0],'MSG');return v;});row.appendField(dropdown,'TOPIC');this.setTooltip('เลือก Topic ส่งจากรายการ หรือสร้างชื่อใหม่ · รายการที่มีอยู่จะเลือกชนิดข้อมูลให้เอง');};
  B.Blocks.rs_publish.saveExtraState=function(){return{topic:this.getFieldValue('TOPIC')};};
  B.Blocks.rs_publish.loadExtraState=function(s){this.savedPublishTopic=s.topic;this.getField('TOPIC').getOptions(false);};
  // JSON definitions are mixed into block instances when Blockly creates them.
  B.Blocks.rs_python.customContextMenu=function(options){options.push({text:'✎ แก้ Python และ Topic',enabled:true,callback:()=>pythonEditor(this)});};
  // customContextMenu belongs to the instance, not its prototype definition.
  const pythonInit=B.Blocks.rs_python.init;B.Blocks.rs_python.init=function(){pythonInit.call(this);this.customContextMenu=options=>options.push({text:'✎ แก้ Python และ Topic',enabled:true,callback:()=>pythonEditor(this)});};
  function pythonData(block){try{const d={code:'ctx.log("สวัสดีจาก Python")',ports:[],...JSON.parse(block.data||'{}')};return{...d,ports:Array.isArray(d.ports)?d.ports:[]};}catch{return{code:'',ports:[]};}}
  const q=JSON.stringify,orderJ=javascript.Order,orderP=python.Order;
  function generators(g,py){const val=(b,n,d)=>g.valueToCode(b,n,py?orderP.NONE:orderJ.NONE)||d,call=(s)=>py?`ctx.${s}`:`await ctx.${s}`,end=py?'\n':';\n';
    g.forBlock.rs_start=()=>'';
    g.forBlock.rs_wait=b=>call(`wait(${val(b,'SECONDS','1')})`)+end;
    g.forBlock.rs_until=b=>py?`ctx.until(lambda: ${val(b,'BOOL','False')}, ${val(b,'TIMEOUT','10')})\n`:`await ctx.until(async () => (${val(b,'BOOL','false')}), ${val(b,'TIMEOUT','10')});\n`;
    g.forBlock.rs_read=b=>[call(`read(${q(b.getFieldValue('TOPIC'))}, ${q(b.getFieldValue('FIELD'))}, ${val(b,'TIMEOUT','10')})`),py?orderP.FUNCTION_CALL:orderJ.AWAIT];
    g.forBlock.rs_publish=b=>call(`publish(${q(b.getFieldValue('TOPIC'))}, ${q(b.getFieldValue('MSG'))}, ${val(b,'VALUE',py?'None':'null')})`)+end;
    g.forBlock.rs_move=b=>call(`move(${['X','Y','YAW','SPEED','TIMEOUT'].map((n,i)=>val(b,n,['0','0','0','.1','30'][i])).join(', ')})`)+end;
    g.forBlock.rs_python=b=>call(`python(${q(pythonData(b).code)})`)+end;
    g.forBlock.rs_parallel=b=>{
      const a=g.statementToCode(b,'A'),c=g.statementToCode(b,'B');
      if(!py)return`await ctx.parallel(async (ctx) => {\n${a}}, async (ctx) => {\n${c}});\n`;
      const name='lane_'+b.id.replace(/\W/g,'').slice(0,30),params=new Set();
      for(let parent=b.getSurroundParent();parent;parent=parent.getSurroundParent())if(['procedures_defreturn','procedures_defnoreturn'].includes(parent.type))for(const v of parent.getVars())params.add(g.getVariableName(v));
      const vars=(B.Variables.allUsedVarModels(b.workspace)||[]).map(v=>g.getVariableName(v.getName())).filter(v=>!params.has(v));
      const header=(vars.length?g.INDENT+'global '+vars.join(', ')+'\n':'')+(params.size?g.INDENT+'nonlocal '+[...params].join(', ')+'\n':'');
      return`def ${name}_a(ctx):\n${header}${a||'  pass\n'}def ${name}_b(ctx):\n${header}${c||'  pass\n'}ctx.parallel(${name}_a, ${name}_b)\n`;
    };
    g.forBlock.text_print=b=>call(`log(${val(b,'TEXT',q(''))})`)+end;
    for(const type of ['text_prompt_ext','text_prompt'])g.forBlock[type]=b=>[call(`ask(${b.getInput('TEXT')?val(b,'TEXT',q('')):q(b.getFieldValue('TEXT'))}, ${q(b.getFieldValue('TYPE'))})`),py?orderP.FUNCTION_CALL:orderJ.AWAIT];
  }
  generators(J,false);generators(P,true);
  // Pass the lane context through user procedures, including indirect calls.
  // A function called from A/B must not acquire Main's motion authority.
  for(const g of [J,P]){
    for(const type of ['procedures_defreturn','procedures_defnoreturn']){const original=g.forBlock[type];g.forBlock[type]=(b,g)=>{const result=original(b,g),key='%'+g.getProcedureName(b.getFieldValue('NAME'));g.definitions_[key]=g.definitions_[key].replace(/^(function |def )(\S+?)\(([^)]*)\)/m,(_,prefix,name,args)=>(g===J?'async function ':'def ')+name+'(ctx'+(args?', '+args:'')+')');return result;};}
    const original=g.forBlock.procedures_callreturn;g.forBlock.procedures_callreturn=(b,g)=>{const [code]=original(b,g),at=code.indexOf('('),call=code.slice(0,at+1)+'ctx'+(code.slice(at+1,-1).trim()?', ':'')+code.slice(at+1);return[g===J?'(await '+call+')':call,g===J?orderJ.ATOMIC:orderP.FUNCTION_CALL];};
    g.forBlock.procedures_callnoreturn=(b,g)=>g.forBlock.procedures_callreturn(b,g)[0]+(g===J?';\n':'\n');
  }
  for(const g of [J,P])g.addReservedWords('ctx,TaskRunner,BlocklyRunner');
  const number=n=>({type:'math_number',fields:{NUM:n}}),text=s=>({type:'text',fields:{TEXT:String(s)}}),boolean=b=>({type:'logic_boolean',fields:{BOOL:b?'TRUE':'FALSE'}});
  const input=b=>({block:b}),shadow=b=>({shadow:b});
  const defaults={rs_wait:{SECONDS:shadow(number(1))},rs_until:{BOOL:shadow(boolean(true)),TIMEOUT:shadow(number(10))},rs_read:{TIMEOUT:shadow(number(10))},rs_move:{X:shadow(number(1)),Y:shadow(number(0)),YAW:shadow(number(0)),SPEED:shadow(number(.1)),TIMEOUT:shadow(number(30))},rs_publish:{VALUE:shadow(text('สวัสดี'))}};
  Object.assign(defaults,{controls_if:{IF0:shadow(boolean(true))},logic_compare:{A:shadow(number(1)),B:shadow(number(1))},logic_operation:{A:shadow(boolean(true)),B:shadow(boolean(true))},logic_negate:{BOOL:shadow(boolean(true))},controls_repeat_ext:{TIMES:shadow(number(3))},controls_whileUntil:{BOOL:shadow(boolean(true))},controls_for:{FROM:shadow(number(1)),TO:shadow(number(10)),BY:shadow(number(1))},math_arithmetic:{A:shadow(number(1)),B:shadow(number(1))},math_single:{NUM:shadow(number(9))},math_trig:{NUM:shadow(number(45))},math_round:{NUM:shadow(number(3.1))},math_modulo:{DIVIDEND:shadow(number(10)),DIVISOR:shadow(number(3))},math_random_int:{FROM:shadow(number(1)),TO:shadow(number(10))},math_constrain:{VALUE:shadow(number(5)),LOW:shadow(number(0)),HIGH:shadow(number(10))},text_print:{TEXT:shadow(text('สวัสดี!'))},text_length:{VALUE:shadow(text('สวัสดี'))},text_isEmpty:{VALUE:shadow(text(''))},text_prompt_ext:{TEXT:shadow(text('ชื่อของเราคืออะไร?'))},lists_repeat:{ITEM:shadow(text('ดาว')),NUM:shadow(number(3))}});
  const item=type=>({kind:'block',type,...(defaults[type]?{inputs:defaults[type]}:{})});
  const category=(name,colour,types)=>({kind:'category',name,colour,contents:types.map(item)});
  function toolbox(){return{kind:'categoryToolbox',contents:[
    category('🚀 เริ่มต้น','#edae34',['rs_start','rs_wait','text_print','rs_until','rs_parallel']),
    category('◇ เงื่อนไข','#638acb',['controls_if','logic_compare','logic_operation','logic_negate','logic_boolean','logic_null','logic_ternary']),
    category('↻ ทำซ้ำ','#58a878',['controls_repeat_ext','controls_whileUntil','controls_for','controls_forEach','controls_flow_statements']),
    category('＋ คณิตศาสตร์','#6e79c3',['math_number','math_arithmetic','math_single','math_trig','math_constant','math_number_property','math_round','math_on_list','math_modulo','math_constrain','math_random_int','math_random_float','math_atan2']),
    category('💬 ข้อความ','#aa6bbb',['text','text_join','text_append','text_length','text_isEmpty','text_indexOf','text_charAt','text_getSubstring','text_changeCase','text_trim','text_count','text_replace','text_reverse','text_print','text_prompt_ext']),
    category('☷ ลิสต์','#a56d9b',['lists_create_with','lists_repeat','lists_length','lists_isEmpty','lists_indexOf','lists_getIndex','lists_setIndex','lists_getSublist','lists_split','lists_sort','lists_reverse']),
    {kind:'category',name:'📦 ตัวแปร',colour:'#cf875b',custom:'VARIABLE'},
    {kind:'category',name:'ƒ ฟังก์ชัน',colour:'#ba6c9c',custom:'PROCEDURE'},
    category('📡 หุ่นยนต์ ROS','#329977',['rs_read','rs_publish','rs_move']),
    category('🐍 Python ของฉัน','#626bc4',['rs_python'])
  ].map(c=>c.contents?{...c,contents:c.contents.filter(b=>B.Blocks[b.type])}:c)};}
  function walkState(state,fn,depth=0){let count=0;const walk=(first,d)=>{if(d>70)throw Error('บล็อกซ้อนลึกเกินไป');for(let b=first;b;b=b.next?.block){if(++count>1500)throw Error('เกิน 1,500 บล็อก');fn(b);for(const i of Object.values(b.inputs||{})){if(i.block)walk(i.block,d+1);else if(i.shadow)walk(i.shadow,d+1);}}};for(const b of state.blocks?.blocks||[])walk(b,depth);}
  function inspectState(state){let count=0;walkState(state,b=>{if(++count>1500||!B.Blocks[b.type]||!(stock.has(b.type)||b.type.startsWith('rs_')))throw Error('ชนิดบล็อกไม่รองรับ หรือเกิน 1,500 บล็อก');});}
  function ports(state){const result=[];walkState(state,b=>{if(['rs_read','rs_publish'].includes(b.type))result.push({id:b.id,topic:b.fields?.TOPIC||'',msgType:b.fields?.MSG||'',direction:b.type==='rs_read'?'in':'out'});if(b.type==='rs_python'){let data;try{data=JSON.parse(b.data||'{}');}catch{return;}if(!Array.isArray(data.ports))return;for(const [i,p]of data.ports.slice(0,129).entries())result.push({id:b.id+':'+i,blockId:b.id,topic:p?.topic||'',msgType:p?.msgType||'',direction:p?.direction,declared:true});}});return result;}
  function compile(workspace){const issues=[],all=workspace.getAllBlocks(false),roots=workspace.getTopBlocks(true);if(all.length>1500)issues.push('ใช้ได้ไม่เกิน 1,500 บล็อก');if(roots.filter(b=>b.type==='rs_start').length!==1)issues.push('ต้องมีธงเริ่มหนึ่งบล็อก');if(roots.some(b=>!['rs_start','procedures_defreturn','procedures_defnoreturn'].includes(b.type)))issues.push('มีบล็อกยังไม่ต่อกับธงเริ่มหรือฟังก์ชัน');
    const state=B.serialization.workspaces.save(workspace),io=ports(state),motion=all.some(b=>b.type==='rs_move');
    for(const p of io){if(!M.topicName(p.topic)||!/^\w+\/msg\/\w+$/.test(p.msgType))issues.push('เลือก Topic และชนิดข้อความให้ครบ');if(p.direction==='out'&&(!p.topic.startsWith('/task_studio/user/')||!['std_msgs/msg/String','std_msgs/msg/Float64','std_msgs/msg/Bool'].includes(p.msgType)))issues.push('ส่งได้เฉพาะ String / Bool / Float64 ใน /task_studio/user/');if(!['in','out'].includes(p.direction))issues.push('ทิศทาง Topic ไม่ถูกต้อง');}
    for(const b of all){if(!b.isEnabled())issues.push('มีบล็อกถูกปิดใช้งาน');if(b.type==='rs_move'&&b.getSurroundParent()?.type==='rs_parallel')issues.push('ห้ามใช้คำสั่งวิ่งในงานคู่ขนาน');if(b.type==='rs_read'&&!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(b.getFieldValue('FIELD')))issues.push('ชื่อช่องข้อมูลไม่ถูกต้อง');if(b.type==='rs_python'&&(typeof pythonData(b).code!=='string'||pythonData(b).code.length>20000))issues.push('Python ต้องเป็นข้อความไม่เกิน 20,000 ตัวอักษร');}
    const definitions=new Set(all.filter(b=>['procedures_defreturn','procedures_defnoreturn'].includes(b.type)).map(b=>b.getFieldValue('NAME')));
    const functionBlocks=new Map(all.filter(b=>['procedures_defreturn','procedures_defnoreturn'].includes(b.type)).map(b=>[b.getFieldValue('NAME'),b]));
    for(const parallel of all.filter(b=>b.type==='rs_parallel')){const seen=new Set(),visit=b=>{if(!b||seen.has(b.id))return;seen.add(b.id);if(b.type==='rs_move')issues.push('ห้ามใช้คำสั่งวิ่งในงานคู่ขนาน รวมถึงในฟังก์ชันที่เรียก');if(b.type==='rs_parallel')issues.push('ห้ามซ้อนงานคู่ขนาน A/B');if(['procedures_callreturn','procedures_callnoreturn'].includes(b.type))visit(functionBlocks.get(b.getFieldValue('NAME')));for(const child of b.getChildren(false))visit(child);};visit(parallel.getInputTargetBlock('A'));visit(parallel.getInputTargetBlock('B'));}
    for(const b of all){if(['procedures_callreturn','procedures_callnoreturn'].includes(b.type)&&!definitions.has(b.getFieldValue('NAME')))issues.push('ยังไม่พบฟังก์ชัน '+b.getFieldValue('NAME'));for(const i of b.inputList)if(i.connection&&!i.connection.targetBlock()&&((b.type==='controls_if'&&i.name.startsWith('IF'))||(b.type==='controls_whileUntil'&&i.name==='BOOL')||(b.type==='rs_until'&&i.name==='BOOL')))issues.push('ต่อบล็อกเงื่อนไขหกเหลี่ยมในช่องที่ว่างก่อน');}
    if(issues.length)return{state,ports:io,motion,issues:[...new Set(issues)]};
    J.STATEMENT_PREFIX='await ctx.step(%1);\n';J.INFINITE_LOOP_TRAP='await ctx.guard();\n';
    P.STATEMENT_PREFIX='ctx.step(%1, locals())\n';P.INFINITE_LOOP_TRAP='ctx.guard()\n';
    try{return{state,ports:io,motion,issues:[],javascript:J.workspaceToCode(workspace),python:P.workspaceToCode(workspace)};}catch(e){return{state,ports:io,motion,issues:['ตรวจบล็อก: '+e.message]};}
  }
  function legacy(program){const variables=new Map();const variable=name=>{if(!variables.has(name))variables.set(name,{name,id:'v_'+name});return{type:'variables_get',fields:{VAR:{id:variables.get(name).id}}};};
    const expression=v=>typeof v==='string'&&v.startsWith('$')?variable(v.slice(1)):typeof v==='number'?number(v):typeof v==='boolean'?boolean(v):text(v);
    const list=blocks=>{let first,last;for(const b of blocks){let n;const val=v=>input(expression(v));if(b.type==='log')n={type:'text_print',inputs:{TEXT:val(b.text)}};if(b.type==='wait')n={type:'rs_wait',inputs:{SECONDS:val(b.seconds)}};if(b.type==='repeat')n={type:'controls_repeat_ext',inputs:{TIMES:val(b.count),DO:{block:list(b.body)}}};
      if(b.type==='call'){const f=program.functions.find(f=>f.name===b.fn);n={type:'procedures_callnoreturn',extraState:{name:b.fn,params:Object.keys(f?.params||{})},inputs:Object.fromEntries(Object.entries(f?.params||{}).map(([k,v],i)=>['ARG'+i,val(b.args?.[k]??v)]))};}
      if(b.type==='parallel')n={type:'rs_parallel',inputs:{A:{block:list(b.branches[0])},B:{block:list(b.branches[1])}}};
      if(b.type==='odom_position')n={type:'rs_move',inputs:Object.fromEntries(['x','y','yaw','speed','timeout'].map(k=>[k.toUpperCase(),val(b[k])]))};
      if(b.type==='publish')n={type:'rs_publish',fields:{TOPIC:b.topic,MSG:b.msgType},extraState:{topic:b.topic},inputs:{VALUE:val(b.value)}};
      if(['wait_topic','if_topic'].includes(b.type)){const read={type:'rs_read',fields:{TOPIC:b.topic,MSG:b.msgType||'',FIELD:b.field},extraState:{topic:b.topic},inputs:{TIMEOUT:val(b.timeout)}},condition={type:'logic_compare',fields:{OP:({'==':'EQ','!=':'NEQ','>':'GT','<':'LT','>=':'GTE','<=':'LTE'})[b.op]},inputs:{A:input(read),B:val(b.value)}};n=b.type==='wait_topic'?{type:'rs_until',inputs:{BOOL:input(condition),TIMEOUT:val(b.timeout)}}:{type:'controls_if',extraState:{hasElse:true},inputs:{IF0:input(condition),DO0:{block:list(b.body)},ELSE:{block:list(b.elseBody)}}};}
      if(!n)throw Error('ยังแปลงบล็อก '+b.type+' ไม่ได้');if(b.conditionMissing){if(n.type==='rs_until')delete n.inputs.BOOL;if(n.type==='controls_if')delete n.inputs.IF0;}n.id=b.id;if(last)last.next={block:n};else first=n;last=n;
    }return first;};
    const main=list(program.main),defs=program.functions.map((f,i)=>{const params=Object.keys(f.params);params.forEach(variable);return{type:'procedures_defnoreturn',x:520,y:30+i*220,fields:{NAME:f.name},extraState:{params:params.map(name=>({name,id:variables.get(name).id}))},inputs:{STACK:{block:list(f.body)}}};});
    return{variables:[...variables.values()],blocks:{languageVersion:0,blocks:[{type:'rs_start',x:35,y:30,...(main?{next:{block:main}}:{})},...defs]}};
  }
  function setTopics(list,workspace){const map=new Map();for(const t of list){if(!M.topicName(t.name))continue;const item=map.get(t.name)||{name:t.name,types:[],source:t.source};for(const type of t.types||[])if(!item.types.includes(type))item.types.push(type);map.set(t.name,item);}topics=[...map.values()].sort((a,b)=>a.name.localeCompare(b.name));if(workspace){B.Events.disable();try{for(const b of workspace.getBlocksByType('rs_read')){b.getField('TOPIC').getOptions(false);updateType(b,b.getFieldValue('TOPIC'));}for(const b of workspace.getBlocksByType('rs_publish'))b.getField('TOPIC').getOptions(false);}finally{B.Events.enable();}}}
  function legacyDrafts(program,drafts){const state=legacy(program),scalar=v=>{try{return JSON.parse(v);}catch{return v;}},num=v=>typeof v==='string'&&v.startsWith('$')?v:Number(v);
    function chain(first,depth=0){if(depth>50)throw Error('Draft เดิมซ้อนลึกเกินไป');const out=[];for(let n=first;n;n=n.next?.block){const type=n.type.startsWith('rt_fn_')||n.type==='rt_missing'?'call':n.type.slice(3);if(!M.types[type])throw Error('ยังแปลง Draft '+n.type+' ไม่ได้');let data={};try{data=JSON.parse(n.data||'{}');}catch{}const b={...M.block(type),...data.source,id:M.id(),type};for(const[k,v]of Object.entries(n.fields||{}))b[k]=['x','y','yaw','speed','timeout','seconds','count'].includes(k)?num(v):v;
      if(type==='call'){b.fn=n.type==='rt_missing'?n.fields.fn:n.type.slice(6);b.args=Object.fromEntries(Object.keys(program.functions.find(f=>f.name===b.fn)?.params||{}).map(k=>[k,num(n.fields?.['arg_'+k]??b.args?.[k]??0)]));}
      if(type==='publish'&&b.msgType!=='std_msgs/msg/String')b.value=scalar(b.value);
      if(['wait_topic','if_topic'].includes(type)){const c=n.inputs?.CONDITION?.block;if(c?.type==='rt_topic_condition'){Object.assign(b,c.fields);b.value=b.msgType==='std_msgs/msg/String'?String(b.value):scalar(b.value);delete b.conditionMissing;}else if(n.fields?.topic===undefined)b.conditionMissing=true;}
      if(['repeat','if_topic'].includes(type))b.body=chain(n.inputs?.BODY?.block,depth+1);if(type==='if_topic')b.elseBody=chain(n.inputs?.ELSE?.block,depth+1);if(type==='parallel')b.branches=['A','B'].map(k=>chain(n.inputs?.[k]?.block,depth+1));out.push(b);
    }return out;}
    for(const draft of drafts)for(const root of draft.state?.blocks?.blocks||[]){if(root.type==='rt_start')continue;let loose;if(root.type==='rt_topic_condition'){const fields=root.fields||{},b={...M.block('wait_topic'),...fields,value:fields.msgType==='std_msgs/msg/String'?fields.value:scalar(fields.value)};loose=legacy({...program,main:[b]}).blocks.blocks[0].next.block.inputs.BOOL.block;}else loose=legacy({...program,main:chain(root)}).blocks.blocks[0].next?.block;if(loose){loose.x=Number(root.x)||800;loose.y=Number(root.y)||80;state.blocks.blocks.push(loose);}}
    return state;
  }
  window.TaskStudioStandard={toolbox,compile,legacy,legacyDrafts,ports,inspectState,walkState,number,text,boolean,input,shadow,setTopics,pythonData,onPythonEdit:fn=>pythonEditor=fn};
})();
