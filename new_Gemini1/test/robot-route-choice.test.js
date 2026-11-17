'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../public/robots.html'),'utf8');
const routeCode=source.slice(source.indexOf('function routeCandidateUrls('),source.indexOf('function refreshRoutePreviews('));
const openCode=source.slice(source.indexOf('async function openIDE('),source.indexOf('function goToIDE('));

test('robot card offers Local and VPN IPs and Start uses the selected IP',async()=>{
  const local='http://192.168.0.168:3080/',vpn='http://100.85.138.103:3080/';
  const robot={id:1,name:'Robot',robot_key:'REAL-robot',online:true,routePreview:{route:'cloud',browserIp:'100.121.38.120',localUrls:[vpn,local]}};
  const calls=[],locations=[];
  const context=vm.createContext({robots:[robot],routeChoiceByRobot:new Map(),URL,
    document:{getElementById:()=>null,querySelector:()=>null},window:{location:{assign:url=>locations.push(url)}},
    api:async(url,options)=>{calls.push({url,options});return{ok:true,route:'local',localUrl:local,handoff:'x'.repeat(43)};},
    notif(){},showClientIp(){},escH:value=>String(value),console});
  vm.runInContext(routeCode+openCode,context);
  const selector=vm.runInContext('renderRouteChoices(robots[0])',context);
  assert.match(selector,/<label[^>]*>เชื่อมต่อด้วย<\/label>/);
  assert.match(selector,/<select[^>]*onchange="setRobotRouteChoice\(1,this\.value\)"/);
  assert.match(selector,/<option[^>]*>Local 192\.168\.0\.168<\/option>/);
  assert.match(selector,/<option[^>]* selected>VPN 100\.85\.138\.103<\/option>/);
  assert.match(selector,/<option value="cloud">Cloud<\/option>/);
  assert.equal(vm.runInContext('selectedRouteUrl(robots[0])',context),vpn,'observed VPN IP selects reachable VPN candidate first');
  vm.runInContext(`setRobotRouteChoice(1,'${local}')`,context);
  assert.equal(vm.runInContext('routeChoiceLabel(robots[0])',context),'Local');
  await vm.runInContext('openIDE(1)',context);
  assert.equal(calls[0].options.body.preferredLocalUrl,local);
  assert.deepEqual(locations,[local+'#handoff='+('x'.repeat(43))]);
});

test('route preview keeps an open combobox mounted until selection is finished',()=>{
  const local='http://192.168.0.168:3080/',vpn='http://100.85.138.103:3080/';
  const robot={id:1,robot_key:'REAL-robot',online:true,routePreview:{route:'local',localUrl:vpn,pingMs:3,localUrls:[local,vpn]}};
  const select={},start={textContent:''};let replacements=0;
  const choices={dataset:{},querySelector:()=>select,set outerHTML(value){replacements++;this.html=value;}};
  const document={activeElement:null,querySelector:selector=>selector.endsWith('.rc-route-choices')?choices:start};
  const context=vm.createContext({robots:[robot],routeChoiceByRobot:new Map(),URL,document,escH:value=>String(value),console});
  vm.runInContext(routeCode,context);
  choices.dataset.routeKey=vm.runInContext('routeChoiceKey(robots[0])',context);
  vm.runInContext('syncRouteChoices(1)',context);
  assert.equal(replacements,0,'unchanged route must keep the same select element');
  robot.routePreview.pingMs=4;document.activeElement=select;
  vm.runInContext('syncRouteChoices(1)',context);
  assert.equal(replacements,0,'updated ping must not close an open select');
  vm.runInContext(`setRobotRouteChoice(1,'${local}')`,context);
  assert.equal(context.routeChoiceByRobot.get(1),local);
  assert.match(start.textContent,/เริ่มภารกิจ · Local/);
  assert.equal(replacements,0,'selection must not replace the focused select');
  document.activeElement=null;
  vm.runInContext('syncRouteChoices(1)',context);
  assert.equal(replacements,1,'new options render after the user leaves the select');
});
