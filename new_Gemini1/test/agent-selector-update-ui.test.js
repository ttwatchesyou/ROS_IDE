'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../public/robots.html'),'utf8');
const cardCode=source.slice(source.indexOf('function agentIsLatest('),source.indexOf('function renderRobotProgress('));
const modalCode=source.slice(source.indexOf('function renderAgentUpdateModal('),source.indexOf('async function startAgentUpdate('));

test('offline robot update button opens an explanation; online update shows the required confirmation',async()=>{
  const nodes=new Map(),robot={id:1,name:'Real robot',robot_key:'REAL-test',online:false};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',checked:false,disabled:false,hidden:false,replaceChildren(){}});return nodes.get(id);};
  let opened=false,apiCalls=0;
  const context=vm.createContext({document:{getElementById:node},robots:[robot],latestAgentVersion:null,selectedUpdateRobotId:null,agentUpdateState:null,agentUpdateJob:null,agentUpdateError:'',agentUpdateTimer:null,agentUpdateStarting:false,
    escH:value=>String(value),renderRouteBadge:()=>'',renderRouteChoices:()=>'',routeChoiceLabel:()=>'',renderRobotProgress:()=>'',openModal:()=>{opened=true;},api:async()=>{apiCalls++;throw Error('unexpected API call');}});
  vm.runInContext(cardCode+modalCode,context);
  const card=vm.runInContext('renderRobotCard(robots[0])',context);
  const button=card.match(/<button class="rc-update-button"[^>]*>/)?.[0];
  assert.ok(button);assert.doesNotMatch(button,/\bdisabled\b/);
  await vm.runInContext('openAgentUpdate(1)',context);
  assert.equal(opened,true);assert.equal(apiCalls,0);
  assert.match(node('agent-update-status').textContent,/ออฟไลน์/);
  assert.equal(node('agent-update-start').disabled,true);
  robot.online=true;context.agentUpdateState={version:'2.4.4',latestVersion:'2.4.5',updateAvailable:true,releaseNotes:[]};
  vm.runInContext('renderAgentUpdateModal()',context);
  assert.match(node('agent-update-status').textContent,/ติ๊กยืนยัน/);
  node('agent-update-safe').checked=true;vm.runInContext('renderAgentUpdateModal()',context);
  assert.equal(node('agent-update-start').disabled,false);
  robot.agentVersion='2.4.22';context.latestAgentVersion='2.4.22';
  const latestCard=vm.runInContext('renderRobotCard(robots[0])',context);
  assert.match(latestCard,/Agent 2\.4\.22 · เวอร์ชันล่าสุด/);
  assert.match(latestCard,/<button class="rc-update-button"[^>]* disabled>/);
});
