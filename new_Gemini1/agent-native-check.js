'use strict';
// Probe the installed release, never a module inherited through NODE_PATH.
const path=require('node:path');
async function check(root=__dirname){
  const pty=require(path.join(root,'node_modules','node-pty'));
  await new Promise((resolve,reject)=>{
    let terminal,output='',done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error){try{terminal?.kill();}catch{}reject(error);}else resolve();};
    const timer=setTimeout(()=>finish(new Error('PTY shell did not complete within 5 seconds')),5000);
    try{
      terminal=pty.spawn('/bin/sh',['-c','printf ROSIDE_NATIVE_PTY_OK'],{name:'xterm',cols:80,rows:24,cwd:root,env:{...process.env}});
      terminal.onData(data=>output+=data);
      terminal.onExit(({exitCode})=>finish(exitCode===0&&output.includes('ROSIDE_NATIVE_PTY_OK')?null:new Error('PTY shell failed: '+exitCode)));
    }catch(error){finish(error);}
  });
}
if(require.main===module)check(process.argv[2]||__dirname).then(()=>console.log(`Native PTY verified: ${process.platform}/${process.arch}, Node ${process.version}`)).catch(error=>{console.error('[NATIVE PTY]',error.message);process.exitCode=1;});
module.exports={check};
