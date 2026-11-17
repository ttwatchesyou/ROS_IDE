'use strict';
const fs=require('fs');
const path=require('path');
const NavigationSettings=require('./public/navigation-settings');

const clamp=(value,min,max,fallback)=>{const number=Number(value);return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;};

function writeNavigationPackage(root,mapName,values={}){
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(mapName))throw new Error('Invalid map name');
  const sourceMap=path.join(root,'maps',mapName),packageName='mecha_rayong_nav',packageDir=path.join(root,'src',packageName);
  for(const file of ['map.pgm','map.yaml'])if(!fs.existsSync(path.join(sourceMap,file)))throw new Error(`แผนที่ ${mapName} ขาดไฟล์ ${file}`);
  const parameters=NavigationSettings.normalize(values),{speed,obstacle,inflation,lookahead,tolerance,radius,clearance,cost,turn,yaw}=parameters;
  fs.mkdirSync(path.join(packageDir,'launch'),{recursive:true});fs.mkdirSync(path.join(packageDir,'config'),{recursive:true});fs.mkdirSync(path.join(packageDir,'maps'),{recursive:true});
  fs.copyFileSync(path.join(sourceMap,'map.pgm'),path.join(packageDir,'maps','map.pgm'));fs.copyFileSync(path.join(sourceMap,'map.yaml'),path.join(packageDir,'maps','map.yaml'));
  const files={
    'package.xml':`<?xml version="1.0"?>\n<package format="3"><name>${packageName}</name><version>1.0.0</version><description>Portable Nav2 bringup exported by Mecha Rayong Learning Workspace</description><maintainer email="dev@neocluster.local">Neocluster</maintainer><license>Apache-2.0</license><buildtool_depend>ament_cmake</buildtool_depend><exec_depend>nav2_bringup</exec_depend><exec_depend>navigation2</exec_depend><exec_depend>slam_toolbox</exec_depend><exec_depend>robot_localization</exec_depend><exec_depend>launch</exec_depend><exec_depend>launch_ros</exec_depend><export><build_type>ament_cmake</build_type></export></package>\n`,
    'CMakeLists.txt':`cmake_minimum_required(VERSION 3.8)\nproject(${packageName})\nfind_package(ament_cmake REQUIRED)\ninstall(DIRECTORY launch config maps DESTINATION share/\${PROJECT_NAME})\ninstall(PROGRAMS install_dependencies.sh DESTINATION share/\${PROJECT_NAME})\nament_package()\n`,
    'launch/navigation.launch.py':`import os\nfrom ament_index_python.packages import get_package_share_directory\nfrom launch import LaunchDescription\nfrom launch.actions import DeclareLaunchArgument, IncludeLaunchDescription\nfrom launch.launch_description_sources import PythonLaunchDescriptionSource\nfrom launch.substitutions import LaunchConfiguration\n\ndef generate_launch_description():\n    share=get_package_share_directory('${packageName}')\n    bringup=get_package_share_directory('nav2_bringup')\n    use_sim_time=LaunchConfiguration('use_sim_time')\n    return LaunchDescription([\n        DeclareLaunchArgument('use_sim_time',default_value='false'),\n        IncludeLaunchDescription(PythonLaunchDescriptionSource(os.path.join(bringup,'launch','bringup_launch.py')),launch_arguments={'map':os.path.join(share,'maps','map.yaml'),'params_file':os.path.join(share,'config','nav2_params.yaml'),'use_sim_time':use_sim_time,'autostart':'true'}.items())\n    ])\n`,
    'config/nav2_params.yaml':`amcl:\n  ros__parameters:\n    use_sim_time: false\n    base_frame_id: base_link\n    odom_frame_id: odom\n    global_frame_id: map\n    scan_topic: scan\n    robot_model_type: nav2_amcl::DifferentialMotionModel\nmap_server:\n  ros__parameters:\n    use_sim_time: false\n    yaml_filename: ""\nplanner_server:\n  ros__parameters:\n    expected_planner_frequency: 10.0\n    planner_plugins: ["GridBased"]\n    GridBased:\n      plugin: "nav2_navfn_planner/NavfnPlanner"\n      tolerance: ${tolerance.toFixed(2)}\n      use_astar: true\n      allow_unknown: false\ncontroller_server:\n  ros__parameters:\n    controller_frequency: 20.0\n    min_x_velocity_threshold: 0.001\n    min_theta_velocity_threshold: 0.001\n    controller_plugins: ["FollowPath"]\n    goal_checker_plugins: ["goal_checker"]\n    goal_checker:\n      plugin: "nav2_controller::SimpleGoalChecker"\n      xy_goal_tolerance: ${tolerance.toFixed(2)}\n      yaw_goal_tolerance: ${yaw.toFixed(2)}\n      stateful: true\n    FollowPath:\n      plugin: "nav2_regulated_pure_pursuit_controller::RegulatedPurePursuitController"\n      desired_linear_vel: ${speed.toFixed(2)}\n      lookahead_dist: ${lookahead.toFixed(2)}\n      min_lookahead_dist: 0.20\n      max_lookahead_dist: ${Math.max(.9,lookahead).toFixed(2)}\n      use_velocity_scaled_lookahead_dist: true\n      use_collision_detection: true\n      max_allowed_time_to_collision_up_to_carrot: 1.0\nbt_navigator:\n  ros__parameters:\n    global_frame: map\n    robot_base_frame: base_link\n    odom_topic: /odom\n    transform_tolerance: 0.3\nbehavior_server:\n  ros__parameters:\n    local_costmap_topic: local_costmap/costmap_raw\n    global_costmap_topic: global_costmap/costmap_raw\n    cycle_frequency: 10.0\nlocal_costmap:\n  local_costmap:\n    ros__parameters:\n      update_frequency: 8.0\n      publish_frequency: 4.0\n      global_frame: odom\n      robot_base_frame: base_link\n      rolling_window: true\n      width: 3\n      height: 3\n      resolution: 0.05\n      robot_radius: ${(radius+clearance).toFixed(2)}\n      plugins: ["voxel_layer", "inflation_layer"]\n      voxel_layer:\n        plugin: "nav2_costmap_2d::VoxelLayer"\n        enabled: true\n        observation_sources: scan\n        scan:\n          topic: /scan\n          data_type: "LaserScan"\n          clearing: true\n          marking: true\n          obstacle_max_range: 2.5\n          raytrace_max_range: 3.0\n      inflation_layer:\n        plugin: "nav2_costmap_2d::InflationLayer"\n        inflation_radius: ${inflation.toFixed(2)}\n        cost_scaling_factor: ${cost.toFixed(2)}\nglobal_costmap:\n  global_costmap:\n    ros__parameters:\n      update_frequency: 2.0\n      publish_frequency: 1.0\n      global_frame: map\n      robot_base_frame: base_link\n      resolution: 0.05\n      track_unknown_space: true\n      robot_radius: ${(radius+clearance).toFixed(2)}\n      plugins: ["static_layer", "obstacle_layer", "inflation_layer"]\n      static_layer:\n        plugin: "nav2_costmap_2d::StaticLayer"\n        map_subscribe_transient_local: true\n      obstacle_layer:\n        plugin: "nav2_costmap_2d::ObstacleLayer"\n        observation_sources: scan\n        scan:\n          topic: /scan\n          data_type: "LaserScan"\n          clearing: true\n          marking: true\n      inflation_layer:\n        plugin: "nav2_costmap_2d::InflationLayer"\n        inflation_radius: ${inflation.toFixed(2)}\n        cost_scaling_factor: ${cost.toFixed(2)}\nwaypoint_follower:\n  ros__parameters:\n    loop_rate: 20\nvelocity_smoother:\n  ros__parameters:\n    smoothing_frequency: 20.0\n    feedback: OPEN_LOOP\n    max_velocity: [${speed.toFixed(2)}, 0.0, ${turn.toFixed(2)}]\n    min_velocity: [-${speed.toFixed(2)}, 0.0, -${turn.toFixed(2)}]\n    max_accel: [1.0, 0.0, 2.0]\n    max_decel: [-1.0, 0.0, -2.0]\n`,
    'install_dependencies.sh':`#!/usr/bin/env bash\nset -e\nif [ -z "\${ROS_DISTRO:-}" ]; then ROS_DISTRO="$(find /opt/ros -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort | tail -1)"; fi\nif [ -z "\${ROS_DISTRO}" ] || [ ! -f "/opt/ros/\${ROS_DISTRO}/setup.bash" ]; then echo "ROS 2 installation not found" >&2; exit 1; fi\nsource "/opt/ros/\${ROS_DISTRO}/setup.bash"\nsudo apt update\nsudo apt install -y ros-\${ROS_DISTRO}-navigation2 ros-\${ROS_DISTRO}-nav2-bringup ros-\${ROS_DISTRO}-slam-toolbox ros-\${ROS_DISTRO}-robot-localization\n`,
    'README.md':`# Mecha Rayong Nav2 Project\n\nExported map: **${mapName}**\n\n## Install\n\nExtract this folder into \`~/ros2_ws/src\`, then run:\n\n\`bash ~/ros2_ws/src/${packageName}/install_dependencies.sh\`\n\nThe installer detects the ROS 2 distro under \`/opt/ros\`. You can also choose one explicitly with \`export ROS_DISTRO=humble\` or \`export ROS_DISTRO=jazzy\`.\n\n## Build\n\n\`cd ~/ros2_ws && colcon build --symlink-install --packages-select ${packageName}\`\n\`source install/setup.bash\`\n\n## Run on a real robot\n\nStart robot drivers first. They must publish \`/scan\`, \`/odom\`, \`/tf\` and accept \`/cmd_vel\`. Then run:\n\n\`ros2 launch ${packageName} navigation.launch.py use_sim_time:=false\`\n\nIn RViz, set **2D Pose Estimate**, then send a **Nav2 Goal**. Confirm frame names \`map -> odom -> base_link -> laser_frame\` before moving the robot.\n`,
  };
  for(const[relative,content]of Object.entries(files)){const target=path.join(packageDir,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);}
  fs.chmodSync(path.join(packageDir,'install_dependencies.sh'),0o755);
  return{packageName,packageDir,parameters};
}

function readLidarSelection(root){
  let lidar={};
  try{lidar=JSON.parse(fs.readFileSync(path.join(root,'map.json'),'utf8')).lidar||{};}catch{}
  const supported={
    ydlidar:{label:'YDLIDAR',repository:'https://github.com/YDLIDAR/ydlidar_ros2',branch:'master',directory:'ydlidar_ros2',packageName:'ydlidar'},
    slamtec:{label:'RPLIDAR',repository:'https://github.com/CreedyNZ/rplidar_ros2',branch:'ros2',directory:'rplidar_ros2',packageName:'rplidar_ros'},
  };
  const driver=supported[String(lidar.brand||'')];
  return driver?{...driver,brand:String(lidar.brand),model:String(lidar.model||''),sensorType:String(lidar.sensorType||'')}:null;
}

function lidarInstallerScript(lidar){
  if(!lidar)return`#!/usr/bin/env bash
set -euo pipefail
echo "No supported LiDAR was selected in Map Editor; driver installation skipped."
echo "Select YDLIDAR or RPLIDAR before exporting to generate the matching installer."
`;
  return`#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$PROJECT_ROOT/src"
DRIVER_DIR="$SRC_DIR/${lidar.directory}"
DRIVER_REPOSITORY="${lidar.repository}"
DRIVER_BRANCH="${lidar.branch}"
DRIVER_PACKAGE="${lidar.packageName}"

ROS_DISTRO="\${ROS_DISTRO:-}"
if [ -z "$ROS_DISTRO" ] && [ -d /opt/ros ]; then ROS_DISTRO="$(find /opt/ros -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort | tail -1)"; fi
if [ -z "\${ROS_DISTRO}" ] || [ ! -f "/opt/ros/\${ROS_DISTRO}/setup.bash" ]; then
  echo "ROS 2 is not installed. Follow https://docs.ros.org/en/rolling/Installation.html first." >&2
  exit 1
fi
source "/opt/ros/\${ROS_DISTRO}/setup.bash"
if [ "\${LIDAR_SKIP_BUILD:-0}" != "1" ]; then
  sudo apt update
  sudo apt install -y git python3-colcon-common-extensions python3-rosdep
fi
mkdir -p "$SRC_DIR"
if [ -e "$DRIVER_DIR" ]; then
  echo "LiDAR driver already exists at $DRIVER_DIR; keeping the existing source."
else
  git clone --branch "$DRIVER_BRANCH" --single-branch "$DRIVER_REPOSITORY" "$DRIVER_DIR"
fi
${lidar.brand==='ydlidar'?`if [ -d "$DRIVER_DIR/startup" ]; then
  chmod +x "$DRIVER_DIR"/startup/*.sh
  (cd "$DRIVER_DIR/startup" && sudo bash ./initenv.sh)
  echo "Reconnect the YDLIDAR so that /dev/ydlidar becomes available."
fi
`:''}if [ "\${LIDAR_SKIP_BUILD:-0}" != "1" ]; then
  sudo rosdep init 2>/dev/null || true
  rosdep update
  rosdep install --from-paths "$DRIVER_DIR" --ignore-src -r -y --rosdistro "$ROS_DISTRO"
  cd "$PROJECT_ROOT"
  colcon build --symlink-install --packages-select "$DRIVER_PACKAGE"
  echo "LiDAR driver installed. Run: source $PROJECT_ROOT/install/setup.bash"
fi
`;
}

function writeProjectInstaller(root,mapName){
  const lidar=readLidarSelection(root),lidarName=lidar?`${lidar.label}${lidar.model?` (${lidar.model})`:''}`:'not selected';
  const installer=`#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
ROS_DISTRO="\${ROS_DISTRO:-}"
if [ -z "$ROS_DISTRO" ] && [ -d /opt/ros ]; then ROS_DISTRO="$(find /opt/ros -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort | tail -1)"; fi
if [ -z "\${ROS_DISTRO}" ] || [ ! -f "/opt/ros/\${ROS_DISTRO}/setup.bash" ]; then
  echo "ROS 2 is not installed. Follow https://docs.ros.org/en/rolling/Installation.html first." >&2
  exit 1
fi
source "/opt/ros/\${ROS_DISTRO}/setup.bash"
sudo apt update
sudo apt install -y git python3-colcon-common-extensions python3-rosdep ros-\${ROS_DISTRO}-navigation2 ros-\${ROS_DISTRO}-nav2-bringup ros-\${ROS_DISTRO}-slam-toolbox ros-\${ROS_DISTRO}-robot-localization
LIDAR_SKIP_BUILD=1 bash "$PROJECT_ROOT/install_lidar_driver.sh"
sudo rosdep init 2>/dev/null || true
rosdep update
cd "$PROJECT_ROOT"
rosdep install --from-paths src --ignore-src -r -y --rosdistro "$ROS_DISTRO"
colcon build --symlink-install
echo "Project installed. Run: source install/setup.bash"
echo "Navigation: ros2 launch mecha_rayong_nav navigation.launch.py use_sim_time:=false"
`;
  const guide=`# Mecha Rayong ROS 2 Project — Installation

This ZIP is a complete ROS 2 source workspace export. It contains every package under \`src/\`, saved maps, robot configuration and the generated \`mecha_rayong_nav\` package.

Selected navigation map: **${mapName}**

Selected LiDAR: **${lidarName}**

## 1. Install ROS 2

Install the ROS 2 distribution that matches Ubuntu by following the official guide:
https://docs.ros.org/en/rolling/Installation.html

## 2. Install project programs and package dependencies

\`cd ~/mecha_rayong_project\`
\`bash install_project.sh\`

The script installs colcon, rosdep, Navigation2, Nav2 Bringup, SLAM Toolbox and Robot Localization, downloads the selected LiDAR driver, runs rosdep, then builds the workspace.

The generated \`install_lidar_driver.sh\` can also be run by itself. It uses ${lidar?`[${lidar.repository}](${lidar.repository}) on the \`${lidar.branch}\` branch`:'the LiDAR saved in Map Editor; no supported driver was selected for this export'}.
${lidar?.brand==='ydlidar'?`For YDLIDAR it also runs the repository's \`startup/initenv.sh\` udev setup. Reconnect the sensor after installation, then check \`/dev/ydlidar\`.`:''}

## 3. Connect the real robot

The real robot drivers must publish \`/scan\`, \`/odom\`, \`/tf\`, accept \`/cmd_vel\`, and provide this TF chain:

\`map -> odom -> base_link -> laser_frame\`

Do not run \`sim_robot_mapsim\` on the real robot. Start the real motor, encoder and LiDAR drivers instead.

## 4. Run Navigation

\`source /opt/ros/$ROS_DISTRO/setup.bash\`
\`source install/setup.bash\`
\`ros2 launch mecha_rayong_nav navigation.launch.py use_sim_time:=false\`

Set the initial pose in RViz before sending the first Nav2 Goal.
`;
  fs.writeFileSync(path.join(root,'install_project.sh'),installer);fs.chmodSync(path.join(root,'install_project.sh'),0o755);
  fs.writeFileSync(path.join(root,'install_lidar_driver.sh'),lidarInstallerScript(lidar));fs.chmodSync(path.join(root,'install_lidar_driver.sh'),0o755);
  fs.writeFileSync(path.join(root,'INSTALL_PROJECT.md'),guide);
  return{installer:path.join(root,'install_project.sh'),lidarInstaller:path.join(root,'install_lidar_driver.sh'),guide:path.join(root,'INSTALL_PROJECT.md'),lidar};
}

module.exports={writeNavigationPackage,writeProjectInstaller};
