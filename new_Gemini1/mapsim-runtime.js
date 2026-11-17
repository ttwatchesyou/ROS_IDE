'use strict';

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

function mapsimStartCommand({setup, workspaceSetup, pidFile, logFile}) {
  // Environment setup can be slow when several simulations start together.
  // Run it inside the background process, with *all* its output redirected;
  // the HTTP exec must finish after spawning, not after sourcing every package.
  const launch = `set -e; source ${quote(setup)}; source ${quote(workspaceSetup)}; exec ros2 run sim_robot_mapsim mapsim`;
  return `nohup setsid bash -c ${quote(launch)} >${quote(logFile)} 2>&1 </dev/null & echo $! >${quote(pidFile)}`;
}

// Probe the simulation's DDS graph directly. Repeated ros2 CLI calls can each
// wait for discovery/a stale daemon and outlive the enclosing HTTP request.
function mapsimReadinessScript(seconds = 20) {
  const duration = Math.max(.1, Math.min(60, Number(seconds) || 20));
  return `import sys,time,rclpy
from nav_msgs.msg import Odometry
from rclpy.qos import qos_profile_sensor_data
rclpy.init()
node=rclpy.create_node('roside_mapsim_readiness')
received={'odom':False}
node.create_subscription(Odometry,'/odom',lambda message: received.update(odom=True),qos_profile_sensor_data)
required={'/map','/slam_map','/scan','/tf','/tf_static','/odom','/robot_description'}
deadline=time.monotonic()+${duration}
topics=set()
ready=False
try:
    while rclpy.ok() and time.monotonic()<deadline:
        rclpy.spin_once(node,timeout_sec=0.1)
        try:
            topics={name for name,types in node.get_publisher_names_and_types_by_node('sim_robot_mapsim','/')}
        except Exception:
            topics=set()
        if required.issubset(topics) and received['odom']:
            ready=True
            print('/sim_robot_mapsim',flush=True)
            break
    if not ready:
        print('MapSim readiness timed out: missing publishers='+','.join(sorted(required-topics))+'; odom_received='+str(received['odom']),file=sys.stderr,flush=True)
finally:
    node.destroy_node()
    rclpy.shutdown()
sys.exit(0 if ready else 43)
`;
}

module.exports = {mapsimReadinessScript, mapsimStartCommand};
