'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/navigation.js'),'utf8');
const code=source.slice(source.indexOf('function enforceNavigationUsbLidarPort('),source.indexOf('\nnew MutationObserver(enforceNavigationUsbLidarPort)'));

function fixture(controllerValue,ports,selected=''){
  let pending=false,callbacks=0;
  class Option {constructor(text,value){this.text=text;this.value=value;this.disabled=false;this.hidden=false;}}
  const controller={value:controllerValue},lidar={options:['',...ports].map(value=>new Option(value,value)),value:selected,add(option){this.options.push(option);pending=true;}};
  const context=vm.createContext({$:id=>id==='lidar-port'?lidar:controller,Option,updateNote(){}});
  vm.runInContext(code,context);
  function settle(){
    do{pending=false;callbacks++;vm.runInContext('enforceNavigationUsbLidarPort()',context);assert.ok(callbacks<=10,'observer must settle instead of starving the browser event loop');}while(pending);
  }
  return{controller,lidar,settle,get callbacks(){return callbacks;}};
}

test('Nav2 controller occupying the only USB port does not append a conflicting fallback forever',()=>{
  const f=fixture('/dev/ttyUSB0',['/dev/ttyUSB0'],'/dev/ttyUSB0');f.settle();
  assert.equal(f.callbacks,1);assert.equal(f.lidar.options.length,2);assert.equal(f.lidar.value,'');assert.equal(f.lidar.options[1].disabled,true);
});
test('Nav2 empty port list with controller USB0 stays empty and settles',()=>{
  const f=fixture('/dev/ttyUSB0',[]);f.settle();assert.equal(f.callbacks,1);assert.equal(f.lidar.options.length,1);assert.equal(f.lidar.value,'');
});
test('Nav2 disconnected USB fallback is added at most once across observer callbacks',()=>{
  const f=fixture('/dev/ttyAMA0',['/dev/ttyAMA0','/dev/ttyAMA10']);f.settle();f.settle();
  assert.equal(f.lidar.value,'/dev/ttyUSB0');assert.equal(f.lidar.options.filter(o=>o.value==='/dev/ttyUSB0').length,1);
  assert.ok(f.lidar.options.filter(o=>o.value.startsWith('/dev/ttyAMA')).every(o=>o.disabled));
});
test('Nav2 keeps distinct Pi GPIO controller and USB LiDAR selections',()=>{
  const f=fixture('/dev/ttyAMA0',['/dev/ttyUSB0','/dev/ttyAMA0','/dev/ttyAMA10'],'/dev/ttyUSB0');f.settle();
  assert.equal(f.callbacks,1);assert.equal(f.lidar.value,'/dev/ttyUSB0');assert.equal(f.lidar.options.length,4);
});
test('Nav2 chooses an existing alternate USB device without adding USB0 duplicates',()=>{
  const f=fixture('/dev/ttyUSB0',['/dev/ttyUSB0','/dev/ttyACM1'],'/dev/ttyUSB0');f.settle();
  assert.equal(f.lidar.value,'/dev/ttyACM1');assert.equal(f.lidar.options.length,3);
});
test('Nav2 preserves a valid by-id LiDAR selection',()=>{
  const port='/dev/serial/by-id/usb-Silicon_Labs-fixture';
  const f=fixture('/dev/ttyAMA0',['/dev/ttyUSB0',port],port);f.settle();assert.equal(f.lidar.value,port);
});
test('Nav2 makes a formerly conflicting port available again after controller changes',()=>{
  const f=fixture('/dev/ttyUSB0',['/dev/ttyUSB0'],'/dev/ttyUSB0');f.settle();f.controller.value='/dev/ttyAMA0';f.settle();
  assert.equal(f.lidar.value,'/dev/ttyUSB0');assert.equal(f.lidar.options[1].disabled,false);assert.equal(f.lidar.options[1].hidden,false);
});
