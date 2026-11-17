'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('component designer saves multiple parts and reloads their colors, transforms and dimensions',()=>{
  const storage=new Map(),name={value:'my_sensor'},context={
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    document:{getElementById:id=>id==='dc-comp-name'?name:null},
    window:{addEventListener(){},confirm:()=>true},alert(){},sessionId:'designer-test',console,
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../public/3dcomponent.js'),'utf8'),context);
  vm.runInContext(`dcAfterChange=()=>{};dcRenderProps=()=>{};dcSelect=id=>{dc.selected=id;};
    dc.parts=[{id:'p1',shape:'box',params:{sx:.2,sy:.1,sz:.05},color:0,pos:{x:0,y:0,z:.1},rpy:{r:15,p:30,y:45}},
      {id:'p2',shape:'sphere',params:{radius:.03},color:0xff0000,pos:{x:.1,y:0,z:.15},rpy:{r:0,p:0,y:0}}];
    dcSaveComponent();globalThis.saved=dcLoadLibrary()[0];dc.parts=[];dcEditLibrary(saved.id);
    globalThis.loaded=dc.parts;`,context);
  assert.equal(context.saved.shape,'composite');assert.equal(context.loaded.length,2);
  for(let i=0;i<2;i++)for(const key of ['shape','params','color','pos','rpy'])assert.equal(JSON.stringify(context.loaded[i][key]),JSON.stringify(context.saved.parts[i][key]));
  name.value='renamed_sensor';context.dcSaveComponent();assert.equal(context.dcLoadLibrary().length,1);
  assert.equal(context.dcLoadLibrary()[0].name,'renamed_sensor');
});
