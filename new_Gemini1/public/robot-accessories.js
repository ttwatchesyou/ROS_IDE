/* Assembly accessory visuals for real and Sim. ROS metres, X forward / Y left / Z up.
 * Decorative geometry stays inside the configured mechanical envelope.
 * The same descriptions are used in TF and URDF; no hardware behaviour here.
 */
(function(root) {
  'use strict';
  const legacyColors = {
    battery:0x536b46, controller:0x327eab, mounting_plate:0xb2bac4,
    sensor_mast:0x8c99a8, motor_housing:0x909ca7, bumper:0xef9b35,
    payload_tray:0x479d90, antenna:0x303b48,
  };
  const defaults = {...legacyColors,battery:0x364454,controller:0x41647e,bumper:0xe9ac48,payload_tray:0x587583};
  const types = {battery:'box',controller:'box',mounting_plate:'box',sensor_mast:'cylinder',motor_housing:'cylinder',bumper:'box',payload_tray:'box',antenna:'cylinder'};
  function kind(c) {
    if(c.params?.accessory==='none')return '';
    const explicit = c.params?.accessory;
    if (Object.hasOwn(defaults, explicit) && c.type === types[explicit]) return explicit;
    // Only names created by the old accessory palette, never arbitrary boxes.
    return Object.keys(defaults).find(id => c.type === types[id] && new RegExp('^'+id+'_\\d+(?:_copy_\\d+)*$').test(c.name || '')) || '';
  }
  function upgrade(c) {
    const accessory=kind(c);if(!accessory)return false;
    if(c.params?.accessoryRevision!==2 && (c.color===undefined || c.color===legacyColors[accessory]))c.color=defaults[accessory];
    c.params={...c.params,accessory,accessoryRevision:2};
    return true;
  }
  function parts(c) {
    const id=kind(c); if (!id) return [];
    const p=c.params || {}, out=[], primary=Number.isInteger(c.color) && c.color>=0 && c.color<=0xffffff ? c.color : defaults[id];
    const metal=0xc1cad2, steel=0x738797, black=0x17212d, rubber=0x303841, gold=0xc7a252, red=0xe45b53, white=0xe7edf2, blue=0x42a6c6;
    const dim=(v,d)=>Number.isFinite(+v)&&+v>0?+v:d;
    const X=dim(p.sx,.2),Y=dim(p.sy,.12),Z=dim(p.sz,.09),R=dim(p.radius,.018),H=dim(p.height,.18);
    function add(shape,dims,xyz,color,rpy=[0,0,0],detail='',finish='metal') {
      out.push({shape,...dims,xyz,rpy,color,detail,roughness:finish==='rubber'?.76:finish==='plastic'?.48:.34,metalness:finish==='rubber'||finish==='plastic'?.04:.65});
    }
    const box=(size,xyz,color,detail='',finish='metal')=>add('box',{size},xyz,color,undefined,detail,finish);
    const cyl=(radius,length,xyz,color,rpy,detail='',finish)=>add('cylinder',{radius,length},xyz,color,rpy,detail,finish);
    const screw=(x,y,z,r)=>{cyl(r,r*.35,[x,y,z],steel,undefined,'bolt');cyl(r*.38,r*.04,[x,y,z+r*.19],black,undefined,'socket');};
    // Rounded extrusion represented by portable URDF primitives, not a mesh
    // or bitmap: the exact same silhouette remains visible in Sim and RViz.
    const rounded=(size,xyz,color,radius,detail,finish='metal')=>{
      const [x,y,z]=size,r=Math.min(radius,x*.45,y*.45);
      box([x-2*r,y,z],xyz,color,detail,finish);box([x,y-2*r,z],xyz,color,detail,finish);
      for(const sx of [-1,1])for(const sy of [-1,1])cyl(r,z,[xyz[0]+sx*(x/2-r),xyz[1]+sy*(y/2-r),xyz[2]],color,undefined,detail,finish);
    };
    const glyphs={D:['110','101','101','101','110'],C:['111','100','100','100','111'],P:['110','101','110','100','100'],O:['111','101','101','101','111'],W:['101','101','101','111','101'],E:['111','100','110','100','111'],R:['110','101','110','101','101']};
    function lettering(word,origin,width,height,color,side=0) {
      const cell=width/(word.length*4-1),row=height/5,depth=Math.min(X,Y,Z)*.005;
      [...word].forEach((letter,index)=>{(glyphs[letter]||[]).forEach((bits,y)=>{
        for(let x=0;x<3;){if(bits[x]!=='1'){x++;continue;}let end=x+1;while(bits[end]==='1')end++;
          // +Y and -Y side labels face opposite ways; neither may be mirrored.
          const u=origin[0]+(side>0?-1:1)*(-width/2+(index*4+(x+end)/2)*cell),v=height/2-(y+.5)*row;
          box(side?[(end-x)*cell,depth,row*.88]:[(end-x)*cell,row*.88,depth],side?[u,origin[1],origin[2]+v]:[u,origin[1]+v,origin[2]],color,'printed-'+word,'plastic');x=end;
        }
      });});
    }
    if(id==='battery') {
      const corner=Math.min(X,Y)*.055;
      rounded([X*.96,Y*.94,Z*.73],[0,0,-Z*.115],primary,corner,'battery-case','plastic');
      rounded([X,Y,Z*.045],[0,0,-Z*.4775],black,corner,'base-protector','rubber');
      rounded([X,Y,Z*.055],[0,0,Z*.246],black,corner,'lid-seal','rubber');
      rounded([X*.99,Y*.99,Z*.075],[0,0,Z*.30],primary,corner,'sealed-lid','plastic');
      // Terminal polarity, retaining nuts, folded carrying handle and an
      // illustrated label, deliberately without invented voltage/capacity.
      for(const x of [-X*.35,X*.35]) {
        cyl(Math.min(X,Y)*.105,Z*.075,[x,Y*.13,Z*.375],x>0?red:black,undefined,'terminal-insulator','plastic');
        cyl(Math.min(X,Y)*.062,Z*.06,[x,Y*.13,Z*.443],gold,undefined,'terminal');
        cyl(Math.min(X,Y)*.075,Z*.024,[x,Y*.13,Z*.442],metal,undefined,'bolt');
        cyl(Math.min(X,Y)*.028,Z*.024,[x,Y*.13,Z*.483],gold,undefined,'terminal-stud');
        box([X*.045,Y*.009,Z*.005],[x,-Y*.015,Z*.342],white,'polarity-minus','plastic');
        if(x>0)box([X*.006,Y*.062,Z*.005],[x,-Y*.015,Z*.342],white,'polarity-plus','plastic');
      }
      for(const x of [-X*.14,X*.14]){
        box([X*.045,Y*.07,Z*.115],[x,Y*.30,Z*.396],black,'handle-mount','plastic');
        screw(x,Y*.30,Z*.339,Math.min(X,Y)*.017);
      }
      rounded([X*.33,Y*.095,Z*.065],[0,Y*.30,Z*.464],black,Y*.025,'carry-handle','plastic');
      rounded([X*.51,Y*.29,Z*.007],[0,-Y*.22,Z*.3415],white,Y*.018,'rating-label','plastic');
      box([X*.49,Y*.045,Z*.008],[0,-Y*.326,Z*.342],blue,'label-accent','plastic');
      lettering('DC',[0,-Y*.207,Z*.347],X*.15,Y*.12,black);
      for(const side of [-1,1]) {
        box([X*.58,Y*.009,Z*.38],[0,side*Y*.474,-Z*.08],black,'side-label','plastic');
        box([X*.58,Y*.011,Z*.045],[0,side*Y*.474,Z*.084],blue,'side-label-accent','plastic');
        lettering('POWER',[0,side*Y*.481,-Z*.06],X*.46,Z*.10,white,side);
        for(const x of [-X*.39,X*.39])box([X*.018,Y*.02,Z*.54],[x,side*Y*.466,-Z*.095],primary,'moulded-rib','plastic');
      }
      for(const x of [-X*.44,X*.44])for(const y of [-Y*.39,Y*.39])screw(x,y,Z*.338,Math.min(X,Y,Z)*.025);
    } else if(id==='controller') {
      rounded([X*.96,Y*.96,Z*.74],[0,0,-Z*.02],primary,Math.min(X,Y)*.035,'controller-case');
      rounded([X,Y,Z*.06],[0,0,-Z*.465],metal,Math.min(X,Y)*.025,'mounting-flange');
      box([X*.026,Y*.87,Z*.64],[X*.481,0,-Z*.02],black,'front-panel');
      for(let i=0;i<9;i++)box([X*.81,Y*.034,Z*.10],[-X*.025,(i-4)*Y*.09,Z*.40],black,'cooling-fin');
      // Port bank faces +X, not +Y: the visible front agrees with ROS forward.
      for(let i=0;i<2;i++) {
        box([X*.02,Y*.23,Z*.30],[X*.487,(-.27+i*.29)*Y,0],metal,'port-bezel');
        box([X*.006,Y*.19,Z*.23],[X*.497,(-.27+i*.29)*Y,0],black,'port-opening','plastic');
        for(let pin=0;pin<4;pin++)box([X*.008,Y*.025,Z*.025],[X*.496,(-.27+i*.29+(pin-1.5)*.04)*Y,-Z*.052],gold,'port-contact');
      }
      const jack=Math.min(Y,Z)*.135;
      cyl(jack,X*.01,[X*.491,Y*.32,0],metal,[0,Math.PI/2,0],'power-jack');
      cyl(jack*.68,X*.012,[X*.494,Y*.32,0],black,[0,Math.PI/2,0],'power-jack-hole','plastic');
      cyl(jack*.23,X*.006,[X*.497,Y*.32,0],gold,[0,Math.PI/2,0],'power-pin');
      for(const x of [-X*.42,X*.42])for(const y of [-Y*.4,Y*.4])screw(x,y,Z*.352,Math.min(X,Y,Z)*.045);
      cyl(Math.min(X,Y,Z)*.035,Z*.008,[X*.40,-Y*.37,Z*.358],0x5ee09b,undefined,'power-led','plastic');
    } else if(id==='mounting_plate') {
      rounded([X,Y,Z*.78],[0,0,-Z*.1],primary,Math.min(X,Y)*.065,'plate');
      // Dark recessed slots and countersunk fasteners, not collision holes.
      for(let x=-2;x<=2;x++)for(const y of [-Y*.26,Y*.26])box([X*.11,Y*.04,Z*.018],[x*X*.15,y,Z*.3],black,'mounting-slot');
      for(const x of [-X*.44,X*.44])for(const y of [-Y*.4,Y*.4])screw(x,y,Z*.32,Math.min(X,Y,Z)*.38);
      for(const x of [-X*.30,0,X*.30])for(const y of [-Y*.10,Y*.10]){
        cyl(Math.min(X,Y)*.018,Z*.014,[x,y,Z*.303],steel,undefined,'mounting-recess');
        cyl(Math.min(X,Y)*.010,Z*.016,[x,y,Z*.31],black,undefined,'mounting-hole');
      }
    } else if(id==='payload_tray') {
      rounded([X,Y,Z*.18],[0,0,-Z*.40],primary,Math.min(X,Y)*.03,'tray-floor');
      box([X*.9,Y*.87,Z*.018],[0,0,-Z*.297],rubber,'anti-slip-mat','rubber');
      for(const side of [-1,1]) {
        box([X,Y*.035,Z],[0,side*Y*.482,0],primary,'tray-rim');
        box([X*.025,Y*.93,Z],[side*X*.487,0,0],primary,'tray-rim');
      }
      for(let i=0;i<7;i++)box([X*.006,Y*.76,Z*.009],[(i-3)*X*.11,0,-Z*.283],steel,'mat-rib');
      for(const x of [-X*.42,X*.42])for(const y of [-Y*.39,Y*.39])screw(x,y,-Z*.29,Math.min(X,Y,Z)*.12);
      for(const side of [-1,1])box([X*.018,Y*.30,Z*.15],[side*X*.486,0,Z*.36],black,'grip-inset','rubber');
    } else if(id==='bumper') {
      box([X*.58,Y*.98,Z*.75],[-X*.21,0,0],steel,'bumper-bracket');
      box([X*.40,Y,Z],[X*.29,0,0],primary,'bumper-shell','rubber');
      box([X*.008,Y*.76,Z*.21],[X*.495,0,0],black,'contact-strip','rubber');
      for(const y of [-Y*.42,Y*.42])box([X*.008,Y*.035,Z*.55],[X*.495,y,0],0xf5e6bc,'reflector','rubber');
      for(const y of [-Y*.36,Y*.36])screw(-X*.28,y,Z*.379,Math.min(X,Z)*.05);
      for(let i=0;i<9;i++)box([X*.009,Y*.022,Z*.38],[X*.495,(i-4)*Y*.063,0],rubber,'bumper-rib','rubber');
    } else if(id==='sensor_mast') {
      cyl(R*.46,H*.46,[0,0,-H*.20],primary,undefined,'mast-tube');
      cyl(R*.31,H*.40,[0,0,H*.23],metal,undefined,'telescopic-tube');
      cyl(R*.61,H*.035,[0,0,H*.03],black,undefined,'adjustment-collar','plastic');
      for(const sign of [-1,1]) {
        cyl(R,H*.07,[0,0,sign*H*.462],metal,undefined,'mounting-flange');
        cyl(R*.62,H*.04,[0,0,sign*H*.408],black,undefined,'clamp');
      }
      box([R*.22,R*.17,H*.72],[R*.38,0,0],black,'cable-channel','rubber');
      box([R*.35,R*.32,H*.024],[R*.65,0,H*.03],black,'clamp-lever','plastic');
      for(let i=0;i<3;i++){const a=i*2*Math.PI/3;screw(R*.73*Math.cos(a),R*.73*Math.sin(a),H*.497,Math.min(R*.06,H*.006));}
    } else if(id==='motor_housing') {
      cyl(R,H*.63,[0,0,-H*.06],primary,undefined,'motor-can');
      cyl(R*.99,H*.14,[0,0,-H*.43],black,undefined,'end-cap');
      cyl(R*.93,H*.13,[0,0,H*.32],metal,undefined,'gearbox');
      cyl(R*.40,H*.045,[0,0,H*.399],steel,undefined,'shaft-bearing');
      cyl(R*.14,H*.08,[0,0,H*.46],metal,undefined,'output-shaft');
      for(let i=0;i<8;i++) {
        const a=i*Math.PI/4;
        cyl(R*.048,H*.54,[R*.95*Math.cos(a),R*.95*Math.sin(a),-H*.06],steel,undefined,'cooling-rib');
        cyl(R*.055,H*.12,[R*.92*Math.cos(a),R*.92*Math.sin(a),-H*.31],black,undefined,'motor-vent','plastic');
      }
      cyl(R*.995,H*.026,[0,0,H*.17],black,undefined,'case-seam','plastic');
      for(let i=0;i<4;i++){const a=i*Math.PI/2;screw(R*.69*Math.cos(a),R*.69*Math.sin(a),H*.39,R*.065);}
    } else if(id==='antenna') {
      cyl(R,H*.09,[0,0,-H*.455],gold,undefined,'coax-connector');
      cyl(R*.98,H*.09,[0,0,-H*.365],black,undefined,'antenna-base','rubber');
      cyl(R*.54,H*.80,[0,0,H*.08],primary,undefined,'antenna-whip','rubber');
      cyl(R*.57,H*.02,[0,0,H*.49],rubber,undefined,'antenna-tip','rubber');
      for(let i=0;i<4;i++)cyl(R*.99,H*.005,[0,0,-H*.49+i*H*.02],steel,undefined,'connector-thread');
      for(let i=0;i<5;i++)cyl(R*.62,H*.008,[0,0,-H*.29+i*H*.014],rubber,undefined,'strain-relief','rubber');
    }
    return out;
  }
  const api={parts,kind,defaults,upgrade};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RobotAccessories=api;
})(typeof globalThis!=='undefined'?globalThis:this);
