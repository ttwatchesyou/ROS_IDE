'use strict';
// Only loaded by Task Studio. Canonical programs remain independent of Blockly.
(()=>{
  const M=TaskStudioModel,B=Blockly;
  const text=(name,value)=>({type:'field_input',name,text:String(value)});
  const statement=name=>({type:'input_statement',name});
  let availableTopics=[];
  const chosenType=topic=>{const found=availableTopics.find(t=>t.name===topic);return found?(found.types.length===1?found.types[0]:'ชนิดข้อมูลซ้ำ — ตรวจ Topic'):null;};
  function options(block){const value=block?.getFieldValue('topic'),current=value&&value!=='__choose__'?value:block?.savedTopic,items=availableTopics.map(t=>[t.name+(t.source==='app'?' · ในแอป':''),t.name]);if(current&&current!=='__choose__'&&!items.some(x=>x[1]===current))items.unshift([current+' · ยังไม่พบ',current]);return [['เลือก Topic…','__choose__'],...items];}
  function autoType(block,topic){if(!block?.getField('msgType'))return;const known=chosenType(topic),previous=block.getFieldValue('topic'),fallback=topic===previous?block.getFieldValue('msgType'):'';block.setFieldValue(known??(topic==='__choose__'?'ยังไม่เลือก Topic':fallback||'ยังไม่ทราบชนิด'),'msgType');}
  const definitions=[
    {type:'rt_start',message0:'🚩 %1',args0:[text('TITLE','เมื่อเริ่มโปรแกรม')],nextStatement:null,colour:'#e8a23a',hat:'cap'},
    {type:'rt_log',message0:'💬 พูด %1',args0:[text('text','สวัสดี!')],colour:'#9162d1'},
    {type:'rt_wait',message0:'⏱ รอ %1 วินาที',args0:[text('seconds',1)],colour:'#d69b2b'},
    {type:'rt_repeat',message0:'↻ ทำซ้ำ %1 รอบ %2',args0:[text('count',2),statement('BODY')],colour:'#d69b2b'},
    {type:'rt_parallel',message0:'⑂ ทำพร้อมกัน แล้วรอให้ทั้งคู่เสร็จ',message1:'งาน A %1',args1:[statement('A')],message2:'งาน B %1',args2:[statement('B')],colour:'#199ea5'},
    {type:'rt_odom_position',message0:'⌖ ไปยังตำแหน่ง ODOM',message1:'X %1   Y %2 เมตร',args1:[text('x',1),text('y',0)],message2:'หัน %1 องศา   ความเร็ว %2 m/s',args2:[text('yaw',0),text('speed',.1)],message3:'รอได้ไม่เกิน %1 วินาที',args3:[text('timeout',30)],colour:'#4381df',inputsInline:false},
    {type:'rt_wait_topic',message0:'⏳ รอจนกว่า %1',args0:[{type:'input_value',name:'CONDITION',check:'Boolean'}],message1:'ไม่เกิน %1 วินาที',args1:[text('timeout',10)],colour:'#d69b2b',inputsInline:false},
    {type:'rt_if_topic',message0:'ถ้า %1',args0:[{type:'input_value',name:'CONDITION',check:'Boolean'}],message1:'ทำ %1',args1:[statement('BODY')],message2:'มิฉะนั้น %1',args2:[statement('ELSE')],message3:'รอข้อมูลสดได้ไม่เกิน %1 วินาที',args3:[text('timeout',10)],colour:'#d69b2b',inputsInline:false},
    {type:'rt_publish',message0:'📤 ส่งข้อความให้เพื่อน',message1:'Topic %1',args1:[text('topic','/task_studio/user/hello')],message2:'ชนิด %1 ค่า %2',args2:[{type:'field_dropdown',name:'msgType',options:[['ข้อความ','std_msgs/msg/String'],['ตัวเลข','std_msgs/msg/Float64'],['จริง / เท็จ','std_msgs/msg/Bool']]},text('value','พร้อมแล้ว')],colour:'#329779',inputsInline:false},
    {type:'rt_missing',message0:'ƒ ฟังก์ชันที่ต้องแก้ %1',args0:[text('fn','missing')],colour:'#cf5f7f'}
  ];
  B.defineBlocksWithJsonArray(definitions.map(d=>d.type==='rt_start'?d:{previousStatement:null,nextStatement:null,inputsInline:true,...d}));
  B.Blocks.rt_topic_condition={
    init(){
      const choice=new B.FieldDropdown(function(){return options(this.getSourceBlock());},function(value){autoType(this.getSourceBlock(),value);return value;});
      this.appendDummyInput().appendField('◇ ข้อมูลจาก').appendField(choice,'topic');
      this.appendDummyInput().appendField('ชนิด').appendField(new B.FieldLabelSerializable('ยังไม่เลือก Topic'),'msgType');
      this.appendDummyInput().appendField('ช่อง').appendField(new B.FieldTextInput('data'),'field').appendField(new B.FieldDropdown(['==','!=','>','<','>=','<='].map(x=>[x,x])),'op').appendField(new B.FieldTextInput('true'),'value');
      this.setOutput(true,'Boolean');this.setColour('#329779');this.setTooltip('เลือก Topic ที่ค้นพบ ชนิดข้อความเติมอัตโนมัติ · กด ⟳ Topics เพื่อค้นหาใหม่');
    },
    saveExtraState(){return{topic:this.getFieldValue('topic')};},
    loadExtraState(state){this.savedTopic=state?.topic;this.getField('topic').getOptions(false);}
  };
  function conditionState(fields){return{type:'rt_topic_condition',fields:{topic:fields.topic||'__choose__',msgType:fields.msgType||'ยังไม่ทราบชนิด',field:fields.field||'data',op:fields.op||'==',value:String(fields.value??'true')},extraState:{topic:fields.topic||'__choose__'}};}
  function upgradeState(state){const copy=M.clone(state);function walk(b){if(b.type==='rt_wait_topic'&&b.fields?.topic!==undefined){b.inputs||={};b.inputs.CONDITION={block:conditionState(b.fields)};b.fields={timeout:b.fields.timeout||'10'};}if(b.next?.block)walk(b.next.block);for(const input of Object.values(b.inputs||{}))if(input.block)walk(input.block);}for(const b of copy.blocks?.blocks||[])walk(b);return copy;}
  const numeric=new Set(['seconds','count','x','y','yaw','speed','timeout']);
  const number=v=>v.startsWith('$')?v:v.trim()===''?null:Number(v);
  const scalar=v=>{try{return JSON.parse(v);}catch{return v;}};
  class Editor{
    constructor(element,notify){
      this.notify=notify;this.guard=false;this.hash='';this.signature='';this.key='';this.errors=[];
      this.workspace=B.inject(element,{renderer:'zelos',toolbox:{kind:'categoryToolbox',contents:[]},media:'/',sounds:false,trashcan:false,comments:false,disable:false,collapse:true,scrollbars:true,move:{scrollbars:true,drag:true,wheel:true},zoom:{controls:false,wheel:false,startScale:.82,maxScale:1.5,minScale:.35,scaleSpeed:1.15},grid:{spacing:24,length:2,colour:'#cbd5e1',snap:false}});
      this.workspace.addChangeListener(e=>{if(this.guard||e.isUiEvent||e.type===B.Events.FINISHED_LOADING)return;this.refreshTypes();this.read();});
      this.workspace.registerButtonCallback('DISCOVER_TASK_TOPICS',()=>document.getElementById('discover').click());
      new ResizeObserver(()=>{B.svgResize(this.workspace);if(!this.workspace.isDragging())this.workspace.scroll(0,0);}).observe(element);
    }
    configure(program){
      const signature=JSON.stringify(program.functions.map(f=>[f.name,f.title,f.params]));if(signature===this.signature)return;this.signature=signature;
      for(const type of Object.keys(B.Blocks))if(type.startsWith('rt_fn_')&&!program.functions.some(f=>'rt_fn_'+f.name===type))delete B.Blocks[type];
      for(const f of program.functions){const args=Object.keys(f.params);B.Blocks['rt_fn_'+f.name]={init(){this.appendDummyInput().appendField('ƒ '+(f.title||f.name));for(const name of args)this.appendDummyInput().appendField(name).appendField(new B.FieldTextInput(String(f.params[name])), 'arg_'+name);this.setPreviousStatement(true);this.setNextStatement(true);this.setColour('#cf5f96');this.setTooltip('เรียกชุดคำสั่ง '+f.name);}};}
      const item=type=>({kind:'block',type:'rt_'+type});
      this.workspace.updateToolbox({kind:'categoryToolbox',contents:[
        {kind:'category',name:'💬 เริ่มง่าย ๆ',colour:'#9162d1',contents:['log','wait'].map(item)},
        {kind:'category',name:'↻ จัดลำดับ',colour:'#d69b2b',contents:['repeat','parallel','if_topic','wait_topic'].map(item)},
        {kind:'category',name:'⌖ เคลื่อนที่',colour:'#4381df',contents:[item('odom_position')]},
        {kind:'category',name:'📨 ข้อมูล ROS',colour:'#329779',contents:[{kind:'button',text:'⟳ ค้นหา Topics',callbackKey:'DISCOVER_TASK_TOPICS'},item('topic_condition'),{...item('wait_topic'),inputs:{CONDITION:{block:{type:'rt_topic_condition'}}}},item('if_topic'),item('publish')]},
        {kind:'category',name:'ƒ ของฉัน',colour:'#cf5f96',contents:program.functions.length?program.functions.map(f=>item('fn_'+f.name)):[{kind:'label',text:'กด + ชุดคำสั่ง ด้านบนก่อน'}]}
      ]});
    }
    chain(blocks){let head=null,last=null;for(const b of blocks){const state=this.encodeBlock(b);if(last)last.next={block:state};else head=state;last=state;}return head;}
    encodeBlock(b){const fields={};let type='rt_'+b.type;
      if(b.type==='call'){type=B.Blocks['rt_fn_'+b.fn]?'rt_fn_'+b.fn:'rt_missing';if(type==='rt_missing')fields.fn=b.fn;else for(const[k,v]of Object.entries(this.program.functions.find(f=>f.name===b.fn)?.params||{}))fields['arg_'+k]=String(b.args[k]??v);}
      else for(const[k,v]of Object.entries(b))if(!['id','type','body','elseBody','branches','conditionMissing'].includes(k)&&typeof v!=='object')fields[k]=String(v);
      if(['wait_topic','if_topic'].includes(b.type)){if(!b.msgType)fields.msgType='';fields.value=b.msgType==='std_msgs/msg/String'?String(b.value):JSON.stringify(b.value);}
      const state={type,fields,data:JSON.stringify({id:b.id,source:b}),inputs:{}};
      if(['wait_topic','if_topic'].includes(b.type)){if(!b.conditionMissing)state.inputs.CONDITION={block:conditionState(fields)};state.fields={timeout:fields.timeout};}
      const connect=(name,list)=>{const child=this.chain(list);if(child)state.inputs[name]={block:child};};
      if(b.body)connect('BODY',b.body);if(b.elseBody)connect('ELSE',b.elseBody);if(b.branches){connect('A',b.branches[0]);connect('B',b.branches[1]);}return state;
    }
    load(program,tab,key,draft){
      this.program=program;this.tab=tab;const previous=this.signature;this.configure(program);
      const body=tab==='Main'?program.main:program.functions.find(f=>f.name===tab)?.body||[];
      const hash=JSON.stringify(body);if(this.key===key&&this.hash===hash&&previous===this.signature)return;
      this.guard=true;this.key=key;this.hash=hash;B.Events.disable();
      try{
        if(draft?.hash===hash&&draft.signature===this.signature)B.serialization.workspaces.load(upgradeState(draft.state),this.workspace);
        else{this.workspace.clear();const start={type:'rt_start',x:35,y:30,fields:{TITLE:tab==='Main'?'เมื่อเริ่มโปรแกรม':'ชุดคำสั่ง '+(program.functions.find(f=>f.name===tab)?.title||tab)}};const chain=this.chain(body);if(chain)start.next={block:chain};
          const loose=(draft?.state?upgradeState(draft.state).blocks?.blocks||[]:[]).filter(b=>b.type!=='rt_start');
          const repair=b=>{if(b.type?.startsWith('rt_fn_')){const name=b.type.slice(6),f=program.functions.find(f=>f.name===name);if(!f){b.type='rt_missing';b.fields={fn:name};}else b.fields=Object.fromEntries(Object.entries(f.params).map(([k,v])=>['arg_'+k,b.fields?.['arg_'+k]??String(v)]));}if(b.next?.block)repair(b.next.block);for(const input of Object.values(b.inputs||{}))if(input.block)repair(input.block);};loose.forEach(repair);
          B.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[start,...loose]}},this.workspace);
        }
        const start=this.workspace.getBlocksByType('rt_start')[0];if(start){start.setDeletable(false);start.setEditable(false);}
        this.refreshTypes();this.workspace.scroll(0,0);this.read(false);
      }catch(error){this.workspace.clear();this.hash='';this.errors=['โหลดบล็อกไม่สำเร็จ: '+error.message];this.notify(null,null,this.errors[0]);}
      finally{B.Events.enable();this.guard=false;}
    }
    decodeChain(first){const result=[];for(let block=first;block;block=block.getNextBlock()){
      let data;try{data=JSON.parse(block.data||'{}');}catch{data={};}
      const type=block.type.startsWith('rt_fn_')||block.type==='rt_missing'?'call':block.type.slice(3);
      if(!M.types[type])throw Error('บล็อกนี้ไม่รองรับ: '+block.type);
      // Duplicating a Blockly block must not duplicate the canonical program ID.
      let id=data.id;if(!/^b[a-z0-9]+$/.test(id)||this.ids.has(id))id=M.id();this.ids.add(id);
      const b={...(data.source||M.block(type)),id,type};
      if(type==='call'){b.fn=block.type==='rt_missing'?block.getFieldValue('fn'):block.type.slice(6);b.args={};for(const k of Object.keys(this.program.functions.find(f=>f.name===b.fn)?.params||{}))b.args[k]=number(block.getFieldValue('arg_'+k));}
      else for(const input of block.inputList)for(const field of input.fieldRow){if(!field.name)continue;const v=field.getValue();b[field.name]=numeric.has(field.name)?number(v):v;}
      if(type==='publish')b.value=b.msgType==='std_msgs/msg/String'?b.value:scalar(b.value);
      if(['wait_topic','if_topic'].includes(type)){const c=block.getInputTargetBlock('CONDITION');if(c?.type==='rt_topic_condition'){for(const k of ['topic','field','op','value','msgType'])b[k]=c.getFieldValue(k);b.value=b.msgType==='std_msgs/msg/String'?b.value:scalar(b.value);if(!/^\w+\/msg\/\w+$/.test(b.msgType))delete b.msgType;delete b.conditionMissing;}else{b.topic='';b.conditionMissing=true;delete b.msgType;}}
      if(type==='repeat')b.body=this.decodeChain(block.getInputTargetBlock('BODY'));
      if(type==='if_topic'){b.body=this.decodeChain(block.getInputTargetBlock('BODY'));b.elseBody=this.decodeChain(block.getInputTargetBlock('ELSE'));}
      if(type==='parallel')b.branches=['A','B'].map(n=>this.decodeChain(block.getInputTargetBlock(n)));
      block.data=JSON.stringify({id,source:b});result.push(b);
    }return result;}
    inspect(){const roots=this.workspace.getTopBlocks(false),start=roots.find(b=>b.type==='rt_start');this.errors=[];if(!start||roots.length!==1)this.errors.push('มีบล็อกที่ยังไม่ได้ต่อ: ต่อทุกบล็อกใต้ธงเริ่ม หรือเลือกแล้วกดลบ');for(const b of this.workspace.getAllBlocks(false)){if(!b.isEnabled())this.errors.push('มีบล็อกถูกปิดใช้งาน กรุณาเปิดหรือลบก่อนทดลอง');if(['rt_wait_topic','rt_if_topic'].includes(b.type)&&!b.getInputTargetBlock('CONDITION'))this.errors.push('ต่อบล็อกเงื่อนไขรูปหกเหลี่ยมในช่องที่ว่างก่อน');if(b.type==='rt_topic_condition'){if(b.getFieldValue('topic')==='__choose__')this.errors.push('เลือก Topic จากรายการก่อน · กด ⟳ Topics เพื่อค้นหา');if(chosenType(b.getFieldValue('topic'))?.startsWith('ชนิดข้อมูลซ้ำ'))this.errors.push('Topic มีหลายชนิดข้อความ กรุณาแก้ความขัดแย้งก่อน');}}return start;}
    refreshTypes(){B.Events.disable();try{for(const b of this.workspace.getAllBlocks(false))if(b.type==='rt_topic_condition'){b.getField('topic').getOptions(false);autoType(b,b.getFieldValue('topic'));}}finally{B.Events.enable();}}
    setTopics(topics,commit=false){const entries=new Map();for(const t of topics){if(!M.topicName(t.name))continue;const e=entries.get(t.name)||{name:t.name,types:[],source:t.source};for(const type of t.types||[])if(/^\w+\/msg\/\w+$/.test(type)&&!e.types.includes(type))e.types.push(type);entries.set(t.name,e);}availableTopics=[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name));this.refreshTypes();if(commit&&this.program&&!this.guard)this.read();}
    read(commit=true){this.guard=true;try{const start=this.inspect();this.ids=new Set();const remember=blocks=>{for(const b of blocks){this.ids.add(b.id);if(b.body)remember(b.body);if(b.elseBody)remember(b.elseBody);for(const branch of b.branches||[])remember(branch);}};if(this.tab!=='Main')remember(this.program.main);for(const f of this.program.functions)if(f.name!==this.tab)remember(f.body);const body=start?this.decodeChain(start.getNextBlock()):[];if(commit)this.hash=JSON.stringify(body);this.notify(commit?body:null,{hash:this.hash,signature:this.signature,state:B.serialization.workspaces.save(this.workspace),loose:this.errors.length>0});}catch(error){this.errors=[error.message];this.notify(null,null,error.message);}finally{this.guard=false;}}
    highlight(id){const block=this.workspace.getAllBlocks(false).find(b=>{try{return JSON.parse(b.data||'{}').id===id;}catch{return false;}});this.workspace.highlightBlock(block?.id||null);}
    zoom(delta){this.workspace.zoomCenter(delta);}
    remove(){const block=B.getSelected();if(block?.workspace===this.workspace&&block.isDeletable())block.dispose(true);}
    undo(redo=false){this.workspace.undo(redo);}
  }
  window.TaskStudioBlocks=Editor;
})();
