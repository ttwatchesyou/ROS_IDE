'use strict';
// Metres, ROS XY plane, Z up. Shared by the editor and geometry regression tests.
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MapGeometry=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const EPS=1e-6, rad=d=>d*Math.PI/180;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const opening=o=>o.type==='door'||o.type==='window';
  function local(w,x,y){const a=rad(w.r||0),c=Math.cos(a),s=Math.sin(a);return {x:(x-w.x)*c+(y-w.y)*s,y:-(x-w.x)*s+(y-w.y)*c};}
  function world(w,x,y){const a=rad(w.r||0),c=Math.cos(a),s=Math.sin(a);return {x:w.x+x*c-y*s,y:w.y+x*s+y*c};}
  function fits(o,w){return w.type==='wall'&&w.id!==o.id&&o.w<=w.w-.08&&o.h<=w.h&&((o.z||0)-(w.z||0))>=-EPS&&((o.z||0)-(w.z||0))+o.h<=w.h+EPS;}
  function attach(o,objects,distance=.35){
    if(!opening(o))return null;
    if(o.locked===true)return objects.find(w=>w.id===o.wallId)||null;
    let best=null;
    for(const w of objects){
      if(!fits(o,w))continue;
      const p=local(w,o.x,o.y),limit=(w.w-o.w)/2-.04;
      if(Math.abs(p.x)>limit+distance||Math.abs(p.y)>w.d/2+distance)continue;
      const score=Math.hypot(p.y,Math.max(0,Math.abs(p.x)-limit));
      if(!best||score<best.score)best={w,x:clamp(p.x,-limit,limit),score};
    }
    if(!best){delete o.wallId;delete o.wallOffset;return null;}
    o.wallId=best.w.id;o.wallOffset=best.x;o.r=best.w.r;
    Object.assign(o,world(best.w,best.x,0));
    return best.w;
  }
  function reconcile(objects){
    for(const o of objects.filter(opening)){
      if(o.locked===true)continue;
      const w=objects.find(w=>w.id===o.wallId);
      if(w&&fits(o,w)){
        const limit=(w.w-o.w)/2-.04;
        o.wallOffset=clamp(Number.isFinite(o.wallOffset)?o.wallOffset:local(w,o.x,o.y).x,-limit,limit);
        Object.assign(o,world(w,o.wallOffset,0));o.r=w.r;
      }else attach(o,objects,.08);
    }
  }
  function holes(w,objects){
    return objects.filter(o=>opening(o)&&o.wallId===w.id&&fits(o,w)).map(o=>{
      const x=local(w,o.x,o.y).x,z=(o.z||0)-(w.z||0);
      return {left:Math.max(-w.w/2,x-o.w/2),right:Math.min(w.w/2,x+o.w/2),bottom:z,top:Math.min(w.h,z+o.h)};
    });
  }
  function box(x,y,z,w,d,h,detail,r=0){return {x,y,z,w,d,h,detail,r};}
  function wallParts(w,objects){
    const cuts=holes(w,objects),xs=[-w.w/2,w.w/2],zs=[0,w.h];
    for(const h of cuts){xs.push(h.left,h.right);zs.push(h.bottom,h.top);}
    const unique=a=>[...new Set(a)].sort((a,b)=>a-b),xx=unique(xs),zz=unique(zs),parts=[];
    // Rectangular subdivision also handles intersecting or overlapping openings.
    for(let i=1;i<xx.length;i++)for(let j=1;j<zz.length;j++){
      const x=(xx[i-1]+xx[i])/2,z=(zz[j-1]+zz[j])/2;
      if(cuts.some(h=>x>h.left-EPS&&x<h.right+EPS&&z>h.bottom-EPS&&z<h.top+EPS))continue;
      if(xx[i]-xx[i-1]>EPS&&zz[j]-zz[j-1]>EPS)parts.push(box(x,0,zz[j-1],xx[i]-xx[i-1],w.d,zz[j]-zz[j-1],'wall'));
    }
    return parts;
  }
  function doorParts(o,objects){
    const host=objects.find(w=>w.id===o.wallId),depth=Math.max(o.d,host?.d||0)+.025;
    const post=Math.min(.055,o.w*.08),top=Math.min(.06,o.h*.06),clear=o.w-2*post;
    const parts=[box(-o.w/2+post/2,0,0,post,depth,o.h,'frame'),box(o.w/2-post/2,0,0,post,depth,o.h,'frame'),box(0,0,o.h-top,o.w,depth,top,'frame')];
    const double=o.asset==='double-door',count=double?2:1;
    for(let i=0;i<count;i++){
      const hand=(o.hinge==='right'?-1:1)*(i===1?-1:1),angle=clamp(Number.isFinite(o.openAngle)?o.openAngle:90,0,170);
      const hingeX=-hand*clear/2,width=clear/count-.008,a=rad(angle),r=hand*angle;
      parts.push({...box(hingeX+hand*width/2*Math.cos(a),width/2*Math.sin(a),.012,width,Math.min(.045,o.d*.5),o.h-top-.02,'leaf',r),hand});
    }
    return parts;
  }
  function corners(o,p){
    const a=rad(p.r||0),c=Math.cos(a),s=Math.sin(a);
    return [[-p.w/2,-p.d/2],[p.w/2,-p.d/2],[p.w/2,p.d/2],[-p.w/2,p.d/2]].map(([x,y])=>world(o,p.x+x*c-y*s,p.y+x*s+y*c));
  }
  function footprint(o){
    if(['start','rug','window','board'].includes(o.type))return [];
    if(o.type==='table'||o.type==='chair'){
      // Low mobile robots see/pass between legs, instead of a solid table-sized box.
      if(o.asset==='round-table')return [box(0,0,0,o.w*.24,o.d*.24,o.h,'pedestal')];
      const leg=Math.min(o.w,o.d)*.09;
      return [-1,1].flatMap(x=>[-1,1].map(y=>box(x*(o.w/2-leg),y*(o.d/2-leg),0,leg,leg,o.h,'leg')));
    }
    return [box(0,0,0,o.w,o.d,o.h,'body')];
  }
  function segments(objects){
    const lines=[];
    for(const o of objects){
      if(o.z>.35)continue;
      if(['column','cone','plant','lamp'].includes(o.type)){
        const factor=o.type==='lamp'?.42:o.type==='plant'?.38:.5;
        const points=Array.from({length:24},(_,i)=>world(o,Math.cos(i*Math.PI/12)*o.w*factor,Math.sin(i*Math.PI/12)*o.d*factor));
        points.forEach((p,i)=>{const q=points[(i+1)%points.length];lines.push([p.x,p.y,q.x,q.y]);});continue;
      }
      const parts=o.type==='wall'?wallParts(o,objects):o.type==='door'?doorParts(o,objects):footprint(o);
      for(const p of parts){
        if((o.z||0)+p.z>.35||p.h<=0)continue;
        const points=corners(o,p);
        points.forEach((p,i)=>{const q=points[(i+1)%points.length];lines.push([p.x,p.y,q.x,q.y]);});
      }
    }
    return lines.map(line=>line.map(v=>Math.round(v*1e5)/1e5));
  }
  return {local,world,attach,reconcile,holes,wallParts,doorParts,corners,segments};
});
