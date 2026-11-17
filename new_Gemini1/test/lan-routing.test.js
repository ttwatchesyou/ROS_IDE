'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {routeForClient,sameSubnet,browserAddress,localCandidateUrls}=require('../lan-routing');

test('physical IDE route uses only the matching private LAN interface',()=>{
  const interfaces=[
    {address:'192.168.10.20',netmask:'255.255.255.0'},
    {address:'10.2.0.20',netmask:'255.255.0.0'},
    {address:'100.91.74.36',netmask:'255.255.255.255'},
  ];
  assert.equal(routeForClient('192.168.10.45',interfaces,3080),'http://192.168.10.20:3080/');
  assert.equal(routeForClient('::ffff:10.2.7.4',interfaces,3080),'http://10.2.0.20:3080/');
  assert.equal(routeForClient('192.168.11.45',interfaces,3080),null);
  assert.equal(routeForClient('100.91.74.42',interfaces,3080),'http://100.91.74.36:3080/');
  assert.equal(routeForClient('100.91.74.36',interfaces,3080),'http://100.91.74.36:3080/');
  assert.equal(routeForClient('8.8.8.8',interfaces,3080),null);
  assert.equal(routeForClient('192.168.10.45',interfaces,0),null);
  assert.equal(sameSubnet('192.168.10.45',{address:'192.168.10.20',netmask:'255.0.255.0'}),false);
});

test('browser route uses the browser address through a trusted proxy, never the Cloud address',()=>{
  assert.equal(browserAddress('::ffff:192.168.10.45','10.0.0.9',true),'192.168.10.45');
  assert.equal(browserAddress('127.0.0.1','192.168.10.45',true),'192.168.10.45');
  assert.equal(browserAddress('127.0.0.1','192.168.10.45, 10.0.0.9',true,2),'192.168.10.45');
  assert.equal(browserAddress('127.0.0.1','192.168.10.45',false),null);
  assert.equal(browserAddress('127.0.0.1','',true),null);
  assert.deepEqual(localCandidateUrls([{address:'192.168.10.20',netmask:'255.255.255.0'},{address:'100.91.74.36',netmask:'255.255.255.255'}],3080),['http://192.168.10.20:3080/','http://100.91.74.36:3080/']);
  assert.deepEqual(localCandidateUrls([{address:'100.91.74.36',netmask:'255.255.255.255'},{address:'192.168.10.20',netmask:'255.255.255.0'}],3080),['http://192.168.10.20:3080/','http://100.91.74.36:3080/']);
});
