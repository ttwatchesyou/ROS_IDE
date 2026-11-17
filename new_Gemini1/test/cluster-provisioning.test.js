'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateTarget,validRoot,validUrl}=require('../cluster-provisioning');

test('SSH target validation accepts local IPs and rejects command-shaped hosts',()=>{
  assert.deepEqual(validateTarget({host:'192.168.1.25',port:22,username:'root'}),{host:'192.168.1.25',port:22,username:'root'});
  assert.deepEqual(validateTarget({host:'2001:db8::1',port:2222,username:'ubuntu'}),{host:'2001:db8::1',port:2222,username:'ubuntu'});
  assert.throws(()=>validateTarget({host:'-oProxyCommand=bad',port:22,username:'root'}));
  assert.throws(()=>validateTarget({host:'host;id',port:22,username:'root'}));
  assert.throws(()=>validateTarget({host:'worker.local',port:0,username:'root'}));
});

test('Worker config permits only safe Master transports and absolute workspace paths',()=>{
  assert.equal(validUrl('wss://master.example'),true);
  assert.equal(validUrl('ws://127.0.0.1:3050'),true);
  assert.equal(validUrl('ws://master.example'),false);
  assert.equal(validRoot('/srv/roside-cluster/workspaces'),true);
  assert.equal(validRoot('/srv/../etc'),false);
  assert.equal(validRoot('/srv/work space'),false);
});
