'use strict';
// Static orthographic 3D illustrations, exclusively for the real Hardware workspace.
// Geometry is illustrative, never a physical pin-location or electrical specification.
// No WebGL context, network assets, animation loop or camera controls are required.
((root)=>{
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const profiles={
    stm32f103:{w:32,h:76,color:'#176ca9',label:'STM32',chip:'STM32F103',type:'pill'},
    esp32:{w:43,h:75,color:'#243747',label:'ESP32',chip:'ESP-WROOM',type:'radio'},
    pico:{w:29,h:73,color:'#198362',label:'PICO',chip:'RP2040',type:'pico'},
    teensy41:{w:28,h:85,color:'#247a62',label:'TEENSY 4.1',chip:'IMXRT',type:'pill'},
    nanorp2040:{w:29,h:73,color:'#138b88',label:'NANO',chip:'RP2040',type:'radio'},
    portenta_h7:{w:38,h:78,color:'#138b88',label:'PORTENTA',chip:'H7',type:'radio'},
    opencr:{w:66,h:84,color:'#215283',label:'OPENCR',chip:'STM32',type:'large'},
    arduino_due:{w:62,h:96,color:'#148b96',label:'DUE',chip:'SAM3X',type:'large'},
    stm32_e407:{w:67,h:84,color:'#b53136',label:'E407',chip:'STM32F4',type:'large'}
  };
  function render(kind,variant='',label=''){
    const faces=[],labels=[];let baseCount=0;
    const project=([x,y,z])=>kind==='controller'?[x-y*.32,y*.82+x*.14-z]:[(x-y)*.866,(x+y)*.43-z];
    const face=(points,color)=>faces.push({points,color,depth:points.reduce((s,p)=>s+p[0]+p[1]+p[2]*1.16,0)/points.length});
    const shade=(hex,n)=>'#'+hex.slice(1).match(/../g).map(c=>Math.max(0,Math.min(255,parseInt(c,16)+n)).toString(16).padStart(2,'0')).join('');
    function box(x,y,z,w,h,d,color){
      face([[x,y,z+d],[x+w,y,z+d],[x+w,y+h,z+d],[x,y+h,z+d]],color);
      face([[x+w,y,z],[x+w,y+h,z],[x+w,y+h,z+d],[x+w,y,z+d]],shade(color,-28));
      face([[x,y+h,z],[x+w,y+h,z],[x+w,y+h,z+d],[x,y+h,z+d]],shade(color,-48));
    }
    function cylinder(x,y,z,r,h,color,axis='z'){
      const p=(a,t)=>axis==='z'?[x+Math.cos(a)*r,y+Math.sin(a)*r,z+t]:[x+Math.cos(a)*r,y+t,z+Math.sin(a)*r];
      const count=24,top=[];
      for(let i=0;i<count;i++){
        const a=i*Math.PI*2/count,b=(i+1)*Math.PI*2/count;
        top.push(p(a,h));face([p(a,0),p(b,0),p(b,h),p(a,h)],shade(color,Math.round(Math.cos(a-2)*25)-20));
      }
      face(top,shade(color,15));
    }
    function text(x,y,z,value,size=3,color='#daeae9'){labels.push({p:[x,y,z],value,size,color});}
    function pcb(w,h,color){
      box(0,0,0,w,h,2,color);
      for(const[x,y]of [[4,4],[w-4,4],[4,h-4],[w-4,h-4]]){cylinder(x,y,2,2.3,.2,'#c9b779');cylinder(x,y,2.3,1.25,.15,'#172f39');}
      for(let i=0;i<6;i++){box(7+i*(w-15)/6,8,2.05,.35,h-17,.1,shade(color,12));box(7,8+i*(h-16)/6,2.1,w-14,.25,.1,shade(color,16));}
      // The substrate is behind every mounted component, regardless of its centre depth.
      baseCount=faces.length;
    }
    function chip(x,y,z,w,h){
      for(let i=1;i<Math.floor(h/2);i++){box(x-1.6,y+i*2,z,2,h>20?.65:.8,.6,'#adb7bd');box(x+w-.4,y+i*2,z,2,.7,.6,'#adb7bd');}
      box(x,y,z,w,h,2.5,'#25303a');cylinder(x+2,y+2,z+2.6,.5,.1,'#697984');
    }
    function pins(x,y,count,alongY=true){
      box(x-1.1,y-1.1,2,alongY?3:count*3,alongY?count*3:3,2.5,'#202831');
      for(let i=0;i<count;i++)box(x+(alongY?0:i*3),y+(alongY?i*3:0),4.5,.85,.85,3.5,'#d8b966');
    }
    function smd(x,y){box(x,y,2.2,3,1.4,.7,'#c2b493');box(x-.3,y,2.2,.65,1.4,.8,'#b6c7d0');box(x+2.6,y,2.2,.65,1.4,.8,'#b6c7d0');}
    function usb(x,y){box(x,y,2,11,9,4.5,'#b6c5ce');box(x+1,y+7.9,2.7,9,1.2,2.6,'#25313d');box(x+2,y+8.3,3.5,7,1,.65,'#c4b97b');}
    function terminal(x,y,n){
      box(x,y,2,n*6,8,6,'#2f8dab');
      for(let i=0;i<n;i++){cylinder(x+3+i*6,y+4,8,1.7,.5,'#bdc9ce');box(x+1.7+i*6,y+3.8,8.6,2.6,.4,.15,'#546573');box(x+1+i*6,y+7.8,3,4,.3,2.5,'#203d4e');}
    }
    let identity=variant||kind;
    if(kind==='controller'){
      const p=profiles[variant]||profiles.stm32f103,{w,h,color}=p;identity=p.label;pcb(w,h,color);
      pins(1.5,10,Math.floor((h-18)/3));pins(w-2,10,Math.floor((h-18)/3));
      usb(w/2-5.5,h-9);chip(w/2-7,h*.4,2.2,14,15);text(w/2-6,h*.4+8,5,p.chip,2);
      for(let i=0;i<5;i++){smd(w/2-8,12+i*4);smd(w/2+5,h*.64+i*3);}
      box(w/2-5,h*.72,2,6,3,2,'#b9c9cc');box(w/2+4,h*.8,2,3,3,1.6,'#f2c74e');
      if(p.type==='radio'){box(7,6,2,w-14,19,3,'#b9c6c9');text(9,14,5.1,p.chip,2.5,'#4a5b67');box(7,0,2,w-14,5,1,'#26353c');for(let i=0;i<4;i++)box(9+i*3,0,3,1,4,.3,'#d4b65d');}
      if(p.type==='large'){terminal(9,5,4);box(w-18,16,2,12,15,9,'#b0bec7');pins(10,h-18,9,false);}
      if(p.type==='pill'){pins(8,5,3,false);box(8,4,7,4,4,2,'#e5c64c');}
      text(6,h*.32,2.3,p.label,3);
    }else if(kind==='driver'){
      const l298=variant==='l298n',tiny=variant==='tb6612',w=tiny?37:58,h=tiny?42:51;
      identity=l298?'L298N':tiny?'TB6612FNG':'PWM / DIR DRIVER';pcb(w,h,l298?'#bf353c':tiny?'#257d89':'#257859');
      if(tiny){pins(2,6,10);pins(w-3,6,10);chip(10,12,2,16,18);text(10,37,2.4,'TB6612',3);}
      else{terminal(5,h-10,3);terminal(w-16,5,2);chip(13,16,2,24,17);
        for(let i=0;i<(l298?7:4);i++)box(11+i*4,12,5,2.2,24,l298?17:7,'#35414b');
        cylinder(7,10,2,3,10,'#34485c');cylinder(7,10,12,2.5,.3,'#afbdc4');pins(31,h-8,6,false);}
    }else if(kind==='encoder'){
      identity='ROTARY ENCODER';cylinder(20,20,0,17,15,'#6c8599');cylinder(20,20,15,15,3,'#c8d3d9');cylinder(20,20,18,6,2,'#566b7e');cylinder(20,20,20,3,17,'#c4d0d5');
      for(const[x,y]of [[10,13],[30,13],[20,31]])cylinder(x,y,18.2,1.3,.5,'#3d5162');
      for(let i=0;i<4;i++)box(32+i*1.4,26,3,1,24,1,['#d24b56','#252f3c','#e9c65c','#5caee3'][i]);
    }else if(kind==='hcsr04'){
      identity='HC-SR04';pcb(65,30,'#22689b');
      for(const x of [17,48]){cylinder(x,16,2,12,11,'#b8c8d2');cylinder(x,16,13,10,.5,'#3a4d5c');cylinder(x,16,13.6,8.8,.3,'#8eabb9');for(let i=-3;i<=3;i++)box(x-6,16+i*2,14,12,.4,.1,'#405e70');}
      pins(28,26,4,false);text(24,5,2.3,'HC-SR04',3);
    }else if(kind==='servo'){
      identity='MICRO SERVO';box(4,4,0,26,34,24,'#246ac2');box(0,15,19,34,8,3,'#3184d7');cylinder(17,17,24,10,5,'#307ed0');cylinder(17,17,29,3,3,'#e5e8e7');box(2,14,32,30,6,2,'#dde5e8');cylinder(17,17,34,2,.5,'#8799a6');
      for(let i=0;i<3;i++)box(12+i*1.5,35,4,1,22,1,['#935a3a','#e6504a','#efb54b'][i]);
    }else{
      const bno=kind==='bno055';identity=bno?'BNO055':'MPU6050';pcb(38,31,bno?'#6550a4':'#266a9d');chip(13,9,2,12,12);pins(4,26,10,false);for(let i=0;i<4;i++)smd(6+i*6,5);text(5,23,2.3,identity,3);
    }
    const mounted=faces.splice(baseCount);mounted.sort((a,b)=>a.depth-b.depth);faces.push(...mounted);
    const all=faces.flatMap(f=>f.points.map(project)),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),minX=Math.min(...xs)-10,minY=Math.min(...ys)-8,width=Math.max(...xs)-minX+10,height=Math.max(...ys)-minY+10;
    const points=ps=>ps.map(p=>project(p).map(v=>v.toFixed(2)).join(',')).join(' ');
    return `<svg class="hw-device-art" data-device-kind="${escape(kind)}" data-device-model="${escape(variant||kind)}" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}" role="img" aria-label="${escape(label||identity)} · ภาพ 3D มุมคงที่"><title>${escape(label||identity)} — ภาพประกอบ ไม่ใช่ตำแหน่งขาจริง</title>${faces.map(f=>`<polygon points="${points(f.points)}" fill="${f.color}" stroke="${f.color}" stroke-width=".15"/>`).join('')}${labels.map(l=>{const[x,y]=project(l.p),matrix=kind==='controller'?'1 .14 -.32 .82':'.866 .43 -.866 .43';return `<text transform="matrix(${matrix} ${x} ${y})" font-family="monospace" font-size="${l.size}" fill="${l.color}">${escape(l.value)}</text>`;}).join('')}</svg>`;
  }
  root.HardwareVisuals={render,profiles};
  if(typeof module!=='undefined')module.exports=root.HardwareVisuals;
})(typeof window==='undefined'?globalThis:window);
