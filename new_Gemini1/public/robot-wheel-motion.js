/* Visual wheel travel for simulated robots whose wheel TFs are fixed.
 * Distances and axes are in the renderer's world coordinates (Y is up).
 * This never changes robot/TF poses or commands the simulation.
 */
(function(root){
  'use strict';
  function angleForTravel(delta,axis,radius,hand=0){
    const horizontal=Math.hypot(axis.x,axis.z);
    if(!(radius>0)||horizontal<.5)return 0;
    // Rolling direction = axle × up. Mecanum rollers add lateral travel.
    const rolling=(-axis.z*delta.x+axis.x*delta.z)/horizontal;
    const lateral=(axis.x*delta.x+axis.z*delta.z)/horizontal;
    return (rolling-hand*lateral)/radius;
  }
  function advance(wheel,position,axis,active,dt){
    const previous=wheel.previous;
    wheel.previous=active?{position:{...position},axis:{...axis}}:null;
    if(!active||!previous||!(dt>0)||dt>.25)return wheel.angle;
    const delta={x:position.x-previous.position.x,y:position.y-previous.position.y,z:position.z-previous.position.z};
    // Reset the travel baseline after a discontinuity instead of spinning up.
    if(Math.hypot(delta.x,delta.y,delta.z)>.5)return wheel.angle;
    const middle={x:(axis.x+previous.axis.x)/2,z:(axis.z+previous.axis.z)/2};
    wheel.angle=(wheel.angle+angleForTravel(delta,middle,wheel.radius,wheel.hand))%(2*Math.PI);
    return wheel.angle;
  }
  const api={angleForTravel,advance};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.RobotWheelMotion=api;
})(typeof globalThis!=='undefined'?globalThis:this);
