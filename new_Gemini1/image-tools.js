'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile);
const FILES=['helper.py','adapters.py','fat_marker.py','fat_seed.py','passwords.py','environment.py','env_install.py','Start-ImageHelper.ps1','Start-ImageHelper.sh','Start-ImageHelper.command','README.md'];
function mountImageTools(app,{root=__dirname,auth}){
  let cached=null,building=null;
  async function bundle(){
    if(building)return building;
    building=(async()=>{
      const files=[...FILES.map(f=>'image-tools/'+f),...['html','css','js'].map(ext=>'public/image-tools.'+ext)];
      const stats=await Promise.all(files.map(f=>fs.stat(path.join(root,f))));const stamp=stats.map(s=>s.mtimeMs+':'+s.size).join('|');
      if(cached?.stamp===stamp)return cached;
      const script=`import io,sys,zipfile,json,pathlib\nr=pathlib.Path(sys.argv[1]);b=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n for f in json.loads(sys.argv[2]):\n  name='ROSIDE-Image-Helper/'+(('public/'+pathlib.Path(f).name) if f.startswith('public/') else pathlib.Path(f).name)\n  info=zipfile.ZipInfo(name);info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(0o755 if f.endswith(('.sh','.command')) else 0o644)<<16;z.writestr(info,(r/f).read_bytes())\nsys.stdout.buffer.write(b.getvalue())`;
      const result=await exec('python3',['-c',script,root,JSON.stringify(files)],{encoding:'buffer',maxBuffer:2*1024*1024,timeout:15000});
      cached={stamp,data:result.stdout,etag:'"'+crypto.createHash('sha256').update(result.stdout).digest('hex')+'"'};return cached;
    })().finally(()=>{building=null;});return building;
  }
  app.get('/tools/roside-image-helper.zip',async(req,res)=>{
    try{const value=await bundle();res.set({'ETag':value.etag,'Cache-Control':'public, max-age=300','Content-Type':'application/zip','Content-Disposition':'attachment; filename="ROSIDE-Image-Helper.zip"'});if(req.headers['if-none-match']===value.etag)return res.status(304).end();res.send(value.data);}
    catch{res.status(503).json({ok:false,error:'สร้างชุดเครื่องมือไม่สำเร็จ ลองใหม่อีกครั้ง'});}
  });
  app.post('/api/system-images/prepare',auth,(_,res)=>res.status(410).json({ok:false,error:'เปลี่ยนเป็นการติดตั้ง Ubuntu 24.04 + ROS 2 Jazzy ใหม่แล้ว เปิดเครื่องมือจากปุ่มข้างเพิ่มหุ่นยนต์จริง'}));
}
module.exports={mountImageTools,FILES};
