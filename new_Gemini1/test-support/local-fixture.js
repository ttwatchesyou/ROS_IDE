'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const {createRuntime}=require('../agent-runtime');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture({root=path.join(__dirname,'..')}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'roside-local-test-'));
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const config={robot_key:'local-test-physical-0123456789',local_secret:'test-only-local-secret-01234567890123456789',cloud_url:'wss://cloud.example.test/ws/agent',workspace:directory,local_host:'127.0.0.1',local_port:port,data_dir:directory};
  const configPath=path.join(directory,'config.json');fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  const runtime=createRuntime({config,pty:{spawn(){let onExit;return{onData(){},onExit(fn){onExit=fn;},kill(){onExit?.({exitCode:0});},write(){},resize(){}};}}});
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{PATH:process.env.PATH,HOME:os.homedir(),NODE_PATH:path.join(__dirname,'..','node_modules'),ROSIDE_LOCAL_CONFIG:configPath,PORT:String(port),ENC_KEY:'test-only',AUTH_TOKEN_SECRET:'test-only'},stdio:['ignore','pipe','pipe']});
  let logs='',socket,timer;child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
  const origin=`http://127.0.0.1:${port}`;
  const stop=async()=>{clearInterval(timer);socket?.terminate();child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(1500)]);if(child.exitCode===null)child.kill('SIGKILL');fs.rmSync(directory,{recursive:true,force:true});};
  try{
    let ready=false;
    for(let n=0;n<100;n++){try{const result=await fetch(origin+'/api/local/info');if(result.ok){ready=true;break;}}catch{}if(child.exitCode!==null)throw new Error(logs);await pause(50);}
    if(!ready)throw new Error('Local startup timeout: '+logs);
    socket=new WebSocket(origin.replace('http:','ws:')+'/ws/agent');
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    const link=runtime.link('local',msg=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(msg));});
    const authenticated=new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('Agent auth timed out: '+logs)),5000);
      socket.on('message',raw=>{const msg=JSON.parse(raw);if(msg.type==='auth_ok'){clearTimeout(deadline);resolve();}
        // Probe responses are synthetic: these tests never start ROS or access robot hardware.
        if(msg.type==='request'&&msg.action==='exec'&&msg.payload.command.includes('ROS_DISTRO='))return link.send({type:'response',reqId:msg.reqId,ok:true,data:{stdout:'ROS_DISTRO=humble\nSETUP=/opt/ros/humble/setup.bash',stderr:'',code:0}});
        runtime.handle(link,msg);
      });
    });
    socket.send(JSON.stringify({type:'auth',robotKey:config.robot_key,localSecret:config.local_secret,...runtime.status()}));await authenticated;
    timer=setInterval(()=>runtime.pulse(),250);
    const post=async(url,body={},token='')=>{const response=await fetch(origin+url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'x-auth-token':token}:{})},body:JSON.stringify(body)});return{status:response.status,...await response.json()};};
    return{directory,origin,config,runtime,post,stop,logs:()=>logs};
  }catch(error){await stop();throw error;}
}
module.exports={fixture,pause};
