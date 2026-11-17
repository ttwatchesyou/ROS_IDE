'use strict';
// Procedural, locally generated materials: no model/texture downloads are needed.
const MapSceneAssets=(()=>{
  const textures=new Map();
  function texture(kind){
    if(textures.has(kind))return textures.get(kind);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
    const ctx=canvas.getContext('2d');let seed=719;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    ctx.fillStyle=kind==='oak'?'#b69773':kind==='tile'?'#d7d4cd':kind==='concrete'?'#aaaba6':'#eeeae4';ctx.fillRect(0,0,512,512);
    if(kind==='wood'||kind==='oak'){
      const rows=kind==='oak'?8:1;
      for(let row=0;row<rows;row++){
        const y=row*512/rows;
        if(kind==='oak'){ctx.fillStyle=`rgba(65,37,12,${.025+random()*.13})`;ctx.fillRect(0,y,512,64);ctx.fillStyle='#776047';ctx.fillRect(0,y,512,1);const seam=(row%3)*170;ctx.fillRect(seam,y,1,64);}
        for(let i=0;i<150/rows;i++){
          const yy=y+random()*512/rows;ctx.strokeStyle=`rgba(65,43,22,${.035+random()*.12})`;ctx.lineWidth=.4+random();ctx.beginPath();ctx.moveTo(0,yy);ctx.bezierCurveTo(130,yy+random()*6,350,yy-random()*6,512,yy+random()*2);ctx.stroke();
        }
      }
    }else if(kind==='tile'){
      ctx.strokeStyle='#a6a49e';ctx.lineWidth=3;ctx.strokeRect(0,0,256,256);ctx.strokeRect(256,0,256,256);ctx.strokeRect(0,256,256,256);ctx.strokeRect(256,256,256,256);
      ctx.strokeStyle='#ebe8e1';ctx.lineWidth=1;ctx.strokeRect(3,3,250,250);
    }else if(kind==='fabric'){
      for(let i=0;i<512;i+=3){ctx.strokeStyle=i%2?'#c6c1b9':'#e0dcd5';ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,512);ctx.moveTo(0,i);ctx.lineTo(512,i);ctx.stroke();}
    }
    for(let i=0;i<18000;i++){const light=random()>.5;ctx.fillStyle=`rgba(${light?'255,255,255':'30,25,20'},${random()*(kind==='concrete'?.08:.035)})`;ctx.fillRect(random()*512,random()*512,1+random(),1);}
    const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.encoding=THREE.sRGBEncoding;t.anisotropy=4;textures.set(kind,t);return t;
  }
  function material(kind,color=0xffffff,extra={}){
    const settings={color,roughness:.75,metalness:0,...extra};
    if(['wood','fabric','plaster','concrete'].includes(kind)){settings.map=texture(kind);settings.bumpMap=settings.map;settings.bumpScale=kind==='wood'?.006:.003;}
    if(kind==='metal'){settings.roughness=.3;settings.metalness=.72;}
    if(kind==='glass'){Object.assign(settings,{color:0xc5e0df,roughness:.12,metalness:.15,transparent:true,opacity:.3,depthWrite:false},extra);}
    const mat=new THREE.MeshStandardMaterial(settings);mat.color.convertSRGBToLinear();return mat;
  }
  function rounded(w,h,d,r){
    r=Math.min(r||.025,w*.2,h*.2,d*.2);
    const shape=new THREE.Shape(),x=w/2-r,y=h/2-r;
    shape.moveTo(-x,-y);shape.lineTo(x,-y);shape.lineTo(x,y);shape.lineTo(-x,y);shape.closePath();
    const geometry=new THREE.ExtrudeGeometry(shape,{depth:d-2*r,bevelEnabled:true,bevelThickness:r,bevelSize:r,bevelSegments:2,steps:1,curveSegments:2});geometry.translate(0,0,-(d-2*r)/2);return geometry;
  }
  function build(o,objects){
    const g=new THREE.Group(),asset=o.asset||o.type;
    const wood=material('wood',o.color),oak=material('wood',0xb79167),dark=material('metal',0x343a3b),ivory=material('plaster',0xf2eee5),fabric=material('fabric',o.color),metal=material('metal',0xb8bebc);
    const main=['sofa','bed','rug'].includes(o.type)?fabric:['table','cabinet','door','chair','box'].includes(o.type)?wood:material('plaster',o.color);
    function mesh(geometry,mat,x,y,z,parent=g){const m=new THREE.Mesh(geometry,mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
    function box(w,h,d,x,y,z,mat=main,soft=false,parent=g){return mesh(soft?rounded(w,h,d):new THREE.BoxGeometry(w,h,d),mat,x,y,z,parent);}
    function cyl(top,bottom,h,x,y,z,mat=dark){return mesh(new THREE.CylinderGeometry(top,bottom,h,24),mat,x,y,z);}
    function sphere(w,h,d,x,y,z,mat){const m=mesh(new THREE.SphereGeometry(1,12,8),mat,x,y,z);m.scale.set(w,h,d);return m;}
    function legs(height,w=o.w,d=o.d){const t=Math.min(w,d)*.09;for(const x of [-1,1])for(const z of [-1,1])box(t,height,t,x*(w/2-t),height/2,z*(d/2-t),dark);}
    if(o.type==='wall'){
      const wallMat=asset==='glass-wall'?material('glass',o.color,o.colorCustomized?{color:o.color}:{}):main;
      for(const p of MapGeometry.wallParts(o,objects)){
        box(p.w,p.h,p.d,p.x,p.z+p.h/2,0,wallMat);
        if(p.z===0&&asset!=='glass-wall'){
          const h=Math.min(.11,p.h);box(p.w,h,p.d+.025,p.x,h/2,0,ivory);
        }
        if(p.z+p.h>=o.h-.001)box(p.w,.035,p.d+.025,p.x,o.h-.0175,0,ivory);
      }
      if(asset==='glass-wall')for(const p of MapGeometry.wallParts(o,objects)){
        box(.026,p.h,o.d+.015,p.x-p.w/2+.013,p.z+p.h/2,0,dark);box(p.w,.03,o.d+.015,p.x,p.z+.015,0,dark);
      }
    }else if(o.type==='door'){
      for(const p of MapGeometry.doorParts(o,objects)){
        const part=new THREE.Group();part.position.set(p.x,p.z,-p.y);part.rotation.y=p.r*Math.PI/180;g.add(part);
        box(p.w,p.h,p.d,0,p.h/2,0,p.detail==='frame'?ivory:wood,false,part);
        if(p.detail==='leaf'){
          for(const z of [-1,1]){
            for(const [height,y] of [[p.h*.35,p.h*.72],[p.h*.3,p.h*.29]])box(p.w*.77,height,.008,0,y,z*(p.d/2+.004),wood,true,part);
            box(.03,.12,.015,p.hand*p.w*.36,p.h*.48,z*(p.d/2+.012),metal,true,part);
            box(.1,.02,.045,p.hand*p.w*.32,p.h*.48,z*(p.d/2+.027),metal,true,part);
          }
          for(const h of [.2,.8])box(.012,.09,.026,-p.hand*p.w/2,p.h*h,0,metal,false,part);
        }
      }
    }else if(o.type==='window'){
      const frame=Math.min(.05,o.w*.07),host=objects.find(w=>w.id===o.wallId),depth=Math.max(o.d,host?.d||0)+.025,frameMat=o.colorCustomized?main:ivory;
      box(o.w,frame,depth,0,frame/2,0,frameMat);box(o.w,frame,depth,0,o.h-frame/2,0,frameMat);
      for(const x of [-o.w/2+frame/2,0,o.w/2-frame/2])box(frame,o.h,depth,x,o.h/2,0,frameMat);
      box(o.w-frame*2,o.h-frame*2,.012,0,o.h/2,0,material('glass'));box(o.w+.1,.04,depth+.14,0,-.02,0,frameMat);
    }else if(o.type==='table'){
      const top=Math.min(.045,o.h*.09),legH=o.h-top;
      if(asset==='round-table'){cyl(o.w/2,o.w/2,top,0,o.h-top/2,0,wood);cyl(o.w*.045,o.w*.06,legH,0,legH/2,0,dark);cyl(o.w*.12,o.w*.12,.025,0,.0125,0,dark);}
      else{box(o.w,top,o.d,0,o.h-top/2,0,wood,true);legs(legH);box(o.w*.84,.09,.035,0,o.h-.09,o.d*.38,wood);}
      if(asset==='workbench'){
        box(o.w*.85,.045,o.d*.78,0,o.h*.25,0,wood);
        box(o.w*.4,o.h*.18,o.d*.75,o.w*.22,o.h*.77,0,main,true);
        box(o.w*.2,.025,.025,o.w*.22,o.h*.77,-o.d*.4,metal);
      }else if(asset==='computer-table'){
        box(.24,.022,.17,0,o.h+.011,o.d*.12,dark,true);box(.04,.19,.035,0,o.h+.09,o.d*.17,dark);
        box(o.w*.48,.3,.035,0,o.h+.3,o.d*.17,dark,true);box(o.w*.445,.264,.008,0,o.h+.3,o.d*.17-.02,material('metal',0x253c48,{emissive:0x253c48,emissiveIntensity:.25}));
        box(.36,.018,.12,-.04,o.h+.01,-o.d*.24,dark,true);box(.055,.025,.085,.23,o.h+.015,-o.d*.22,dark,true);
      }else if(asset==='coffee-table'||asset==='desk'||asset==='teacher-desk'){
        box(o.w*.25,.035,o.d*.33,-o.w*.2,o.h+.018,0,material('plaster',0x55736c));box(o.w*.24,.017,o.d*.32,-o.w*.2,o.h+.044,0,ivory);
        cyl(.037,.03,.085,o.w*.25,o.h+.043,0,ivory);
      }
    }else if(o.type==='chair'){
      const stool=['stool','bench','ottoman'].includes(asset),seatY=stool?o.h-.055:o.h*.5;
      if(asset==='office-chair'){
        cyl(.025,.035,seatY-.05,0,seatY/2,0,metal);
        for(let i=0;i<5;i++){
          const a=i*Math.PI*2/5,arm=box(.025,.025,o.d*.44,Math.sin(a)*o.d*.22,.08,Math.cos(a)*o.d*.22,dark);arm.rotation.y=a;
          sphere(.035,.04,.035,Math.sin(a)*o.d*.43,.04,Math.cos(a)*o.d*.43,dark);
        }
        for(const x of [-1,1]){box(.025,o.h*.23,.025,x*o.w*.45,seatY+o.h*.1,0,metal);box(.055,.035,o.d*.65,x*o.w*.45,seatY+o.h*.22,0,dark,true);}
      }else legs(asset==='ottoman'?.08:seatY-.03);
      if(asset==='ottoman')box(o.w,o.h-.1,o.d,0,(o.h+.08)/2,0,fabric,true);
      else box(o.w,.055,o.d,0,seatY,0,wood,true);
      if(!stool){box(o.w*.91,.04,o.d*.89,0,seatY+.04,-.015,fabric,true);for(const x of [-1,1])box(.035,o.h-seatY,.035,x*o.w*.4,(o.h+seatY)/2,o.d*.42,dark);box(o.w,o.h*.27,.055,0,o.h*.84,o.d*.43,wood,true);}
      else box(o.w*.8,.025,.025,0,seatY*.35,o.d*.37,dark);
    }else if(o.type==='sofa'){
      const arm=Math.min(.14,o.w*.13),seat=o.h*.45,n=asset==='armchair'?1:3,cw=(o.w-arm*2)/n;
      legs(.1);box(o.w,.22,o.d,0,.2,0,fabric,true);
      for(const x of [-1,1])box(arm,o.h*.66,o.d,x*(o.w-arm)/2,o.h*.39,0,fabric,true);
      box(o.w-arm*2,o.h*.55,o.d*.18,0,o.h*.69,o.d*.4,fabric,true);
      for(let i=0;i<n;i++){
        const x=-(o.w-arm*2)/2+cw*(i+.5);box(cw-.014,.16,o.d*.73,x,seat,-o.d*.06,fabric,true);
        const back=box(cw-.018,o.h*.39,.15,x,o.h*.72,o.d*.27,fabric,true);back.rotation.x=-.1;
      }
      const pillow=material('fabric',0xd6c5a9);
      for(const x of n===1?[0]:[-o.w*.3,o.w*.3]){const p=box(Math.min(.3,o.w*.3),.29,.11,x,seat+.22,o.d*.06,pillow,true);p.rotation.z=x>0?-.15:.15;}
    }else if(o.type==='cabinet'){
      const bodyH=asset==='dresser'?o.h*.52:o.h;
      const t=Math.min(.035,o.w*.04),shelf=['bookshelf','warehouse-rack'].includes(asset),counter=asset==='kitchen-counter',drawers=['bedside-table','dresser','filing-cabinet'].includes(asset);
      box(o.w,bodyH*.07,o.d,0,bodyH*.035,0,dark);box(o.w,t,o.d,0,bodyH-t/2,0,counter?ivory:wood);
      if(asset==='warehouse-rack'){
        for(const x of [-1,1])for(const z of [-1,1])box(t,bodyH,t,x*(o.w-t)/2,bodyH/2,z*(o.d-t)/2,main);
      }else{
        box(o.w,bodyH,.024,0,bodyH/2,o.d/2-.012,wood);
        for(const x of [-1,1])box(t,bodyH,o.d,x*(o.w-t)/2,bodyH/2,0,wood);
      }
      if(shelf){
        for(let i=0;i<5;i++){
          const y=.09+i*(bodyH-.12)/5;box(o.w,t,o.d,0,y,0,wood);
          if(asset==='warehouse-rack'){
            for(const x of [-o.w*.25,o.w*.23])box(o.w*.32,bodyH*.12,o.d*.7,x,y+bodyH*.06+t/2,0,oak);
          }else for(let j=0;j<7;j++){const bw=o.w*.075,bh=(bodyH/5)*(.46+(j%3)*.13),x=-o.w*.39+j*o.w*.12;box(bw,bh,o.d*.66,x,y+bh/2+t/2,-o.d*.06,material('plaster',[0x62786e,0xba9777,0xd3c9b8,0x566572,0x945f4d][(i+j)%5]));box(bw*.75,.012,.005,x,y+bh*.8,-o.d*.395,ivory);}
        }
      }else{
        const count=drawers?3:Math.max(2,Math.round(o.w/.55));
        for(let i=0;i<count;i++){
          const w=drawers?o.w-t*2:o.w/count-.012,h=drawers?(bodyH-.12)/count-.01:bodyH-.12,x=drawers?0:-o.w/2+o.w/count*(i+.5),y=drawers?.09+(bodyH-.12)/count*(i+.5):(bodyH+.07)/2;
          box(w,h,.03,x,y,-o.d/2,wood,true);box(drawers?w*.25:.018,drawers?.018:.13,.03,x+(drawers?0:w*.32),y,-o.d/2-.027,metal,true);
          if(asset==='locker')for(let k=0;k<3;k++)box(w*.52,.012,.004,x,y+h*.33-k*.035,-o.d/2-.018,dark);
        }
      }
      if(asset==='tv-stand'){
        box(o.w*.13,.025,.22,-o.w*.27,bodyH+.015,0,dark);box(o.w*.13,.025,.22,o.w*.27,bodyH+.015,0,dark);
        box(o.w*.88,o.w*.49,.045,0,bodyH+o.w*.26,0,dark,true);box(o.w*.84,o.w*.45,.005,0,bodyH+o.w*.26,-.026,material('metal',0x253c43,{roughness:.2}));
      }
      if(counter){box(o.w*.31,.012,o.d*.63,-o.w*.25,bodyH+.006,0,metal,true);box(o.w*.24,.008,o.d*.47,-o.w*.25,bodyH+.014,0,dark,true);cyl(.012,.012,.19,-o.w*.25,bodyH+.09,o.d*.3,metal);box(.018,.018,.12,-o.w*.25,bodyH+.19,o.d*.22,metal);}
      if(asset==='dresser'){box(o.w*.7,o.h*.43,.035,0,o.h*.78,o.d*.35,oak);box(o.w*.64,o.h*.38,.008,0,o.h*.78,o.d*.35-.022,material('metal',0xd0dedd,{roughness:.1}));}
    }else if(o.type==='bed'){
      legs(o.h*.16);box(o.w,o.h*.35,o.d,0,o.h*.3,0,oak,true);box(o.w,o.h*.94,.095,0,o.h*.53,o.d/2-.05,wood,true);
      box(o.w*.96,o.h*.27,o.d*.93,0,o.h*.59,-o.d*.01,ivory,true);box(o.w*.97,.045,o.d*.62,0,o.h*.75,-o.d*.16,fabric,true);
      const n=asset==='double-bed'?2:1;for(let i=0;i<n;i++)box(o.w*.8/n,.095,o.d*.2,(i-(n-1)/2)*o.w*.46,o.h*.81,o.d*.29,ivory,true);
      box(o.w*.98,.025,o.d*.17,0,o.h*.8,-o.d*.32,material('fabric',0x8d9c96),true);
    }else if(o.type==='plant'){
      cyl(o.w*.34,o.w*.25,o.h*.28,0,o.h*.14,0,material('plaster',0xb88a69));cyl(o.w*.3,o.w*.3,.018,0,o.h*.281,0,material('plaster',0x3c342b));
      cyl(.012,.018,o.h*.58,0,o.h*.48,0,oak);
      for(let i=0;i<18;i++){
        const a=i*2.399,y=o.h*(.4+(i%6)*.085),radius=o.w*(.19+(i%3)*.04);
        const leafMat=material('plaster',o.colorCustomized?o.color:i%2?0x56734c:0x3f6043);if(o.colorCustomized&&i%2)leafMat.color.multiplyScalar(.8);
        const leaf=sphere(o.w*.09,o.h*.16,o.d*.035,Math.cos(a)*radius,y,Math.sin(a)*radius,leafMat);leaf.rotation.set(Math.sin(a)*.6,a,Math.cos(a)*.65);
      }
    }else if(o.type==='lamp'){
      cyl(o.w*.38,o.w*.42,.035,0,.018,0,dark);cyl(.014,.014,o.h*.79,0,o.h*.4,0,dark);
      mesh(new THREE.CylinderGeometry(o.w*.3,o.w*.48,o.h*.23,32,1,true),material('fabric',o.color,{side:THREE.DoubleSide}),0,o.h*.865,0);
      sphere(.055,.07,.055,0,o.h*.83,0,material('plaster',0xffedcb,{emissive:0xffdca0,emissiveIntensity:.55}));
    }else if(o.type==='rug'){
      box(o.w,o.h,o.d,0,o.h/2,0,fabric,true);const border=material('fabric',0xd7cbb6);
      for(const x of [-1,1])box(.035,.003,o.d*.9,x*o.w*.46,o.h+.002,0,border);for(const z of [-1,1])box(o.w*.94,.003,.035,0,o.h+.002,z*o.d*.45,border);
    }else if(o.type==='appliance'){
      box(o.w,o.h,o.d,0,o.h/2,0,material('metal',o.color,{roughness:.45}),true);
      if(asset==='charging-station'){
        box(o.w*.72,o.h*.1,.008,0,o.h*.8,-o.d/2-.005,material('metal',0x59b493,{emissive:0x59b493,emissiveIntensity:.35}));box(o.w*.85,.025,o.d*.45,0,.013,-o.d*.64,dark,true);
        for(const x of [-1,1])box(.05,.08,.012,x*o.w*.22,o.h*.22,-o.d/2-.01,metal);
      }else if(asset==='washing-machine'){
        const rim=cyl(o.w*.32,o.w*.32,.025,0,o.h*.43,-o.d/2-.012,metal);rim.rotation.x=Math.PI/2;
        const drum=cyl(o.w*.255,o.w*.255,.028,0,o.h*.43,-o.d/2-.025,dark);drum.rotation.x=Math.PI/2;
        box(o.w*.88,o.h*.13,.015,0,o.h*.88,-o.d/2-.008,ivory);
        const dial=cyl(o.w*.05,o.w*.05,.025,o.w*.25,o.h*.88,-o.d/2-.025,metal);dial.rotation.x=Math.PI/2;
        box(o.w*.25,o.h*.06,.018,-o.w*.2,o.h*.88,-o.d/2-.018,dark);
      }else{
        box(o.w*.96,.012,.012,0,o.h*.69,-o.d/2-.005,dark);
        for(const y of [.52,.8])box(.026,o.h*.13,.04,o.w*.35,o.h*y,-o.d/2-.035,metal,true);
        box(o.w*.19,o.h*.1,.006,-o.w*.17,o.h*.83,-o.d/2-.008,dark,true);
      }
    }else if(o.type==='board'){
      box(o.w,o.h,o.d,0,o.h/2,0,metal);box(o.w-.055,o.h-.055,o.d+.005,0,o.h/2,0,o.colorCustomized?main:ivory);box(o.w*.9,.025,.12,0,.02,-.04,metal);
      for(let i=0;i<3;i++)box(.09,.014,.014,-.2+i*.13,.04,-.06,material('plaster',[0x465c73,0x904d43,0x404644][i]));
    }else if(o.type==='column'){
      const m=cyl(o.w/2,o.w/2,o.h,0,o.h/2,0,main);m.scale.z=o.d/o.w;
      if(asset==='trash-bin'){
        const lid=cyl(o.w*.53,o.w*.53,o.h*.06,0,o.h*.98,0,dark);lid.scale.z=o.d/o.w;
        box(o.w*.45,o.h*.06,o.d*.35,0,o.h*1.03,0,dark,true);
      }else if(asset==='road-post'){
        cyl(o.w*.8,o.w*.8,.035,0,.0175,0,dark);
        for(const y of [.65,.8])cyl(o.w*.505,o.w*.505,o.h*.06,0,o.h*y,0,ivory);
      }
    }else if(o.type==='stairs'){
      const n=Math.max(2,Math.ceil(o.h/.17));for(let i=0;i<n;i++){const h=o.h*(i+1)/n;box(o.w,h,o.d/n,0,h/2,-o.d/2+o.d/n*(i+.5));box(o.w,.012,o.d/n,0,h+.006,-o.d/2+o.d/n*(i+.5),ivory);}
    }else if(o.type==='barrier'){
      for(const x of [-1,1]){box(.07,o.h,.07,x*o.w*.44,o.h/2,0,dark);box(.25,.055,.45,x*o.w*.44,.0275,0,dark,true);}
      for(const y of [.42,.77]){box(o.w,o.h*.15,o.d,0,o.h*y,0,main);for(let i=0;i<7;i++)box(o.w*.065,o.h*.15,o.d+.002,-o.w*.43+i*o.w*.14,o.h*y,0,ivory);}
    }else if(o.type==='cone'){
      box(o.w,.045,o.d,0,.0225,0,dark,true);cyl(.025,o.w*.43,o.h-.045,0,(o.h+.045)/2,0,main);
      cyl(o.w*.19,o.w*.25,o.h*.13,0,o.h*.56,0,ivory);
    }else if(o.type==='box'&&asset==='pallet'){
      for(const x of [-1,0,1])box(o.w*.12,o.h*.6,o.d,x*o.w*.4,o.h*.45,0,wood);
      for(let i=0;i<5;i++)box(o.w,o.h*.2,o.d*.16,0,o.h*.9,-o.d*.4+i*o.d*.2,wood);
      for(const z of [-1,0,1])box(o.w,o.h*.2,o.d*.14,0,o.h*.1,z*o.d*.4,wood);
    }else if(o.type==='box'){
      box(o.w,o.h,o.d,0,o.h/2,0,wood,true);const tape=material('plaster',0xc5ad81);box(o.w*.14,.004,o.d,0,o.h+.001,0,tape);box(o.w*.14,o.h*.35,.004,0,o.h*.825,-o.d/2-.002,tape);box(o.w*.35,o.h*.23,.003,-o.w*.19,o.h*.47,-o.d/2-.003,ivory);
      for(let i=0;i<9;i++)box(.005+(i%2)*.005,o.h*.11,.003,-o.w*.32+i*o.w*.029,o.h*.48,-o.d/2-.006,dark);
    }else if(o.type==='start'){
      cyl(o.w*.46,o.w*.46,o.h*.18,0,o.h*.15,0,dark);box(o.w*.74,o.h*.35,o.d*.76,0,o.h*.37,0,material('metal',o.color),true);
      for(const x of [-1,1]){const wheel=cyl(o.h*.2,o.h*.2,o.w*.1,x*o.w*.44,o.h*.2,0,dark);wheel.rotation.z=Math.PI/2;}
      cyl(o.w*.15,o.w*.15,o.h*.15,0,o.h*.68,0,dark);cyl(o.w*.155,o.w*.155,.025,0,o.h*.74,0,material('metal',0x66c3ad));
      const arrow=mesh(new THREE.ConeGeometry(o.w*.09,o.d*.25,12),material('metal',0xe9bb61),0,o.h*.47,-o.d*.32);arrow.rotation.x=-Math.PI/2;
    }
    g.userData.mapObjectId=o.id;g.userData.mapObjectType=o.type;
    g.position.set(o.x,o.z,-o.y);g.rotation.y=(o.r||0)*Math.PI/180;
    // Some branches don't use all materials; release those immediately.
    const used=new Set();g.traverse(n=>{if(n.material)used.add(n.material);});for(const m of [wood,oak,dark,ivory,fabric,metal,main])if(!used.has(m))m.dispose();
    return g;
  }
  function floor(bounds,style,z=0){
    const [x0,y0,x1,y1]=bounds,w=x1-x0,d=y1-y0,group=new THREE.Group();
    const map=texture(['oak','tile','concrete'].includes(style)?style:'oak').clone();map.needsUpdate=true;map.repeat.set(w/3,d/3);map.userData={mapOwned:true};
    const mat=new THREE.MeshStandardMaterial({map,roughness:style==='tile'?.48:.87,metalness:0,bumpMap:map,bumpScale:.004});
    const m=new THREE.Mesh(new THREE.PlaneGeometry(w,d),mat);m.rotation.x=-Math.PI/2;m.position.set((x0+x1)/2,z,-(y0+y1)/2);m.receiveShadow=true;group.add(m);
    const base=new THREE.Mesh(new THREE.BoxGeometry(w,.14,d),material('plaster',0x6e736f));base.position.set((x0+x1)/2,z-.075,-(y0+y1)/2);base.receiveShadow=true;group.add(base);return group;
  }
  function roomFloor(map){
    const group=floor(map.bounds,map.floorStyle||'oak');
    for(const zone of Array.isArray(map.floorZones)?map.floorZones:[]){
      if(Array.isArray(zone?.bounds)&&zone.bounds.length===4&&zone.bounds.every(Number.isFinite)&&zone.bounds[2]>zone.bounds[0]&&zone.bounds[3]>zone.bounds[1])group.add(floor(zone.bounds,zone.style,.005));
    }
    return group;
  }
  function configureRenderer(renderer){
    renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
  }
  function updateLighting(sun,bounds){
    const [x0,y0,x1,y1]=bounds,cx=(x0+x1)/2,cy=(y0+y1)/2,size=Math.max(x1-x0,y1-y0,.5),extent=size*.8;
    Object.assign(sun.shadow.camera,{left:-extent,right:extent,top:extent,bottom:-extent,near:.1,far:150});sun.shadow.camera.updateProjectionMatrix();
    sun.position.set(cx+8,size+8,-cy+6);sun.target.position.set(cx,0,-cy);
  }
  function lighting(bounds){
    const group=new THREE.Group();group.name='Map Editor Lighting';
    group.add(new THREE.HemisphereLight(0xe8efff,0x8b8070,.6));
    const sun=new THREE.DirectionalLight(0xffecd4,1.55);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.00015;sun.shadow.normalBias=.018;sun.shadow.radius=3;
    const fill=new THREE.DirectionalLight(0xdde8ff,.3);fill.position.set(-8,9,-6);group.add(sun,sun.target,fill);updateLighting(sun,bounds);
    return {group,sun};
  }
  function dispose(root){
    if(!root)return;const geometries=new Set(),materials=new Set(),ownedTextures=new Set();
    root.traverse(n=>{if(n.isLight&&n.shadow){n.shadow.map?.dispose();n.shadow.mapPass?.dispose();}if(n.geometry)geometries.add(n.geometry);for(const m of n.material?(Array.isArray(n.material)?n.material:[n.material]):[]){materials.add(m);if(m.map?.userData?.mapOwned)ownedTextures.add(m.map);}});
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());ownedTextures.forEach(t=>t.dispose());
  }
  return {build,floor,roomFloor,configureRenderer,lighting,updateLighting,dispose};
})();
