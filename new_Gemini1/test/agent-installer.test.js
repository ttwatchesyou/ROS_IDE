'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync,execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const hasRelease=fs.existsSync(path.join(root,'releases','agent-release.tar.gz'));
test('release allowlist never ships cloud secrets, uploads or runtime workspaces',{skip:!hasRelease},()=>{
  const files=execFileSync('tar',['-tzf',path.join(root,'releases','agent-release.tar.gz')],{encoding:'utf8'}).split('\n');
  assert.ok(files.includes('./local-runtime.js'));assert.ok(files.includes('./lan-routing.js'));assert.ok(files.includes('./public/vendor/three.min.js'));
  assert.ok(files.includes('./agent-release-smoke.js'));
  assert.equal(files.some(file=>/\.\/cluster-(?:management|bootstrap|worker|provisioning)/.test(file)),false,'Cloud Cluster source must stay on Master');
  for(const page of ['index','hardware','tune','mapping','navigation','task-studio'])assert.ok(files.includes(`./public/${page}.html`),`${page} must be available in Local mode`);
  assert.equal(files.some(file=>/(?:^|\/)\.env|\/sim_ws\/|\/uploads\/|\/node_modules\/|\/\.git\//.test(file)),false);
});
for(const phase of ['success','startup-race','dependencies-fail','readiness-fail'])test('staged installer '+phase+' preserves legacy key/config and rollback service',{skip:!hasRelease,timeout:15000},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-installer-test-')),home=path.join(directory,'home'),install=path.join(directory,'install'),service=path.join(directory,'systemd'),bin=path.join(directory,'bin'),old=path.join(directory,'old');
  try{
    for(const dir of [home,install,service,bin,old])fs.mkdirSync(dir);
    fs.writeFileSync(path.join(service,'ros2ide-agent.service'),'LEGACY SERVICE');
    fs.writeFileSync(path.join(install,'config.json'),JSON.stringify({robot_key:'legacy-robot-key-0123456789',cloud_url:'ws://legacy.invalid/ws/agent',workspace:'~/custom_ws',extraField:'preserve-me'}));
    fs.writeFileSync(path.join(install,'agent.js'),'LEGACY AGENT');fs.symlinkSync(old,path.join(install,'current'));
    const script=(name,text)=>fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\n'+text,{mode:0o700});
    script('npm',phase==='dependencies-fail'?'exit 1\n':'ln -s "$ROSIDE_FIXTURE_ROOT/agent/node_modules" node_modules\nexit 0\n');
    script('systemctl','exit 0\n');script('loginctl','exit 0\n');script('sleep','exit 0\n');
    script('curl',`url=''; output=''; data=''; while [ "$#" -gt 0 ]; do case "$1" in -o) shift; output="$1";; --data) shift; data="$1";; http*) url="$1";; esac; shift; done
case "$url" in
  */agent-release.json) cp "$ROSIDE_FIXTURE_ROOT/releases/agent-release.json" "$output";;
  */agent-release.tar.gz|*/agent-release/*.tar.gz) cp "$ROSIDE_FIXTURE_ROOT/releases/agent-release.tar.gz" "$output";;
  */api/local/info) ${phase==='readiness-fail'?'exit 22':phase==='startup-race'?`if [ ! -f "$ROSIDE_INSTALL_ROOT/local-attempted" ]; then touch "$ROSIDE_INSTALL_ROOT/local-attempted"; echo 'curl: (7) simulated startup race' >&2; exit 7; fi; printf '%s' '{"ok":true,"local":true}'`:`printf '%s' '{"ok":true,"local":true}'`};;
  */report) printf '%s\\n' "$data" >> "$ROSIDE_INSTALL_ROOT/reports.jsonl";;
  *) exit 22;;
esac\n`);
    const result=spawnSync('bash',[path.join(root,'agent-install.sh')],{encoding:'utf8',timeout:12000,env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH,NODE_PATH:[path.join(root,'node_modules'),path.join(root,'agent','node_modules')].join(':'),CLOUD_URL:'https://cloud.invalid',ROSIDE_FIXTURE_ROOT:root,ROSIDE_INSTALL_ROOT:install,ROSIDE_SERVICE_DIR:service,ROSIDE_UPDATE_JOB:'00000000-0000-4000-8000-000000000001',ROSIDE_UPDATE_TOKEN:'fixture-token',ROSIDE_UPDATE_REPORT:'https://cloud.invalid/report'}});
    const succeeds=['success','startup-race'].includes(phase);
    assert.equal(result.status,succeeds?0:1,result.stdout+'\n'+result.stderr);
    if(phase==='startup-race')assert.doesNotMatch(result.stderr,/curl: \(7\)/,'expected connection refusals during the bounded readiness retry must stay quiet');
    const stages=fs.readFileSync(path.join(install,'reports.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).stage);
    assert.deepEqual(stages.slice(0,4),['checking','downloading','verifying','installing']);assert.equal(stages.at(-1),succeeds?'ready':'failed');assert.equal(stages.includes('succeeded'),false,'installer must not claim verified reconnect');
    const config=JSON.parse(fs.readFileSync(path.join(install,'config.json'),'utf8'));assert.equal(config.robot_key,'legacy-robot-key-0123456789');assert.equal(config.workspace,'~/custom_ws');assert.equal(config.extraField,'preserve-me');assert.equal(fs.readFileSync(path.join(install,'agent.js'),'utf8'),'LEGACY AGENT');
    if(succeeds){
      assert.equal(config.release_sha256,JSON.parse(fs.readFileSync(path.join(root,'releases','agent-release.json'),'utf8')).sha256);
      assert.notEqual(fs.readlinkSync(path.join(install,'current')),old);assert.match(fs.readFileSync(path.join(service,'ros2ide-agent.service'),'utf8'),/Online \+ Local/);
      assert.equal(fs.existsSync(path.join(home,'.local','bin','ros2ide-agent')),true);
      assert.match(fs.readFileSync(path.join(home,'.bashrc'),'utf8'),/# ROSIDE Agent CLI path/);
      assert.match(result.stdout,/Agent CLI installed:/);assert.match(result.stdout,/Enable it in this terminal now: export PATH=/);
    }
    else{assert.equal(fs.readlinkSync(path.join(install,'current')),old);assert.equal(fs.readFileSync(path.join(service,'ros2ide-agent.service'),'utf8'),'LEGACY SERVICE');if(phase==='readiness-fail')assert.equal(config.release_sha256,undefined);}
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
