(function(root,factory){
  const settings=factory();
  if(typeof module==='object'&&module.exports)module.exports=settings;
  else root.NavigationSettings=settings;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Shared by the form, Simulation API and exported Nav2 package. Distances in metres.
  const fields={
    speed:{label:'ความเร็วเดินสูงสุด',ros:'nav_max_speed',min:.05,max:1.2,step:.05,value:.45,unit:'m/s'},
    turn:{label:'ความเร็วหมุนสูงสุด',ros:'nav_turn_speed',min:.2,max:2.5,step:.1,value:1.2,unit:'rad/s'},
    radius:{label:'รัศมีหุ่น (อย่างน้อย 0.24 m)',ros:'nav_robot_radius',min:.24,max:1,step:.01,value:.24,unit:'m'},
    clearance:{label:'ระยะปลอดภัยจากขอบหุ่น',ros:'nav_safety_margin',min:.02,max:.8,step:.01,value:.08,unit:'m'},
    inflation:{label:'รัศมีเขตหลีกเลี่ยง (cost)',ros:'nav_inflation_radius',min:.26,max:2,step:.01,value:.55,unit:'m'},
    cost:{label:'อัตราลด cost ตามระยะ',ros:'nav_cost_scaling',min:1,max:15,step:.5,value:3,unit:'1/m'},
    obstacle:{label:'ระยะชะลอจากขอบหุ่น',ros:'nav_obstacle_distance',min:.1,max:1.5,step:.05,value:.48,unit:'m'},
    lookahead:{label:'ระยะมองตามเส้นทาง',ros:'nav_lookahead_distance',min:.15,max:1.5,step:.05,value:.45,unit:'m'},
    tolerance:{label:'ความคลาดเคลื่อนถึงเป้า',ros:'nav_goal_tolerance',min:.05,max:.5,step:.01,value:.15,unit:'m'},
    yaw:{label:'ความคลาดเคลื่อนมุมปลายทาง',ros:'nav_yaw_tolerance',min:.05,max:.5,step:.01,value:.15,unit:'rad'},
    replan:{label:'ช่วงพักก่อนวางแผนซ้ำ',ros:'nav_replan_interval',min:1,max:10,step:.5,value:3,unit:'s'},
    budget:{label:'งบ CPU ต่อการหาเส้นทาง',ros:'nav_planning_budget_ms',min:20,max:150,step:10,value:60,unit:'ms'},
  };
  function normalize(values={}){
    const result={};
    for(const [name,field] of Object.entries(fields)){
      const raw=values[name],number=raw===null||raw===''?NaN:Number(raw);
      result[name]=Number.isFinite(number)?Math.max(field.min,Math.min(field.max,number)):field.value;
    }
    result.inflation=Math.max(result.inflation,result.radius+result.clearance);
    return result;
  }
  const presets={
    safe:normalize({speed:.25,turn:.8,clearance:.16,inflation:.75,lookahead:.3,obstacle:.65,replan:4}),
    balanced:normalize(),
    sport:normalize({speed:.2,turn:.7,clearance:.02,inflation:.4,lookahead:.2,obstacle:.3,tolerance:.1,replan:3}),
  };
  const rosConfig=values=>Object.fromEntries(Object.entries(normalize(values)).map(([name,value])=>[fields[name].ros,value]));
  return {fields,presets,normalize,rosConfig};
});
