'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {buildRealSystemProbeCommand,parseRealSystemProbeOutput,buildRealSystemInstallCommand}=require('../real-robot-system');

const marker=values=>'ROSIDE_REAL_SYSTEM_CHECK='+Buffer.from(values.join('\x1f')).toString('base64')+'\n';

test('Ubuntu Noble with Jazzy tools passes mission zero',()=>{
  const capability=parseRealSystemProbeOutput(marker(['ubuntu','24.04','noble','Ubuntu 24.04.4 LTS','arm64','1','1','1','0','0','1','1','1','1','v20.19.0']));
  assert.equal(capability.detected,true);
  assert.equal(capability.systemCheck.ready,true);
  assert.equal(capability.systemCheck.canInstallRos,true);
  assert.equal(capability.systemCheck.targetDistro,'jazzy');
  assert.equal(capability.systemCheck.setupBash,'/opt/ros/jazzy/setup.bash');
  assert.deepEqual(capability.systemCheck.missing,[]);
});

test('Ubuntu Jammy with Humble tools passes mission zero',()=>{
  const capability=parseRealSystemProbeOutput(marker(['ubuntu','22.04','jammy','Ubuntu 22.04.5 LTS','amd64','1','0','0','1','1','1','1','1','1','v20.19.0']));
  assert.equal(capability.detected,true);
  assert.equal(capability.systemCheck.ready,true);
  assert.equal(capability.systemCheck.canInstallRos,true);
  assert.equal(capability.systemCheck.targetDistro,'humble');
  assert.equal(capability.systemCheck.setupBash,'/opt/ros/humble/setup.bash');
  assert.match(capability.validationMessage,/ROS 2 Humble/);
});

test('a ROS distro installed on the wrong Ubuntu pair does not pass mission zero',()=>{
  const jammyWithOnlyJazzy=parseRealSystemProbeOutput(marker(['ubuntu','22.04','jammy','Ubuntu 22.04 LTS','amd64','1','1','1','0','0','1','1','1','1','v20.19.0']));
  assert.equal(jammyWithOnlyJazzy.detected,false);
  assert.equal(jammyWithOnlyJazzy.systemCheck.targetDistro,'humble');
  assert.equal(jammyWithOnlyJazzy.systemCheck.rosInstallations.jazzy,true);
  assert.equal(jammyWithOnlyJazzy.systemCheck.rosInstalled,false);
  assert.ok(jammyWithOnlyJazzy.systemCheck.missing.includes('ros_humble'));
});

test('supported Ubuntu reports installable missing Jazzy packages',()=>{
  const capability=parseRealSystemProbeOutput(marker(['ubuntu','24.04','noble','Ubuntu 24.04 LTS','amd64','1','0','0','0','0','0','0','1','1','v20.19.0']));
  assert.equal(capability.detected,false);
  assert.equal(capability.systemCheck.canInstallRos,true);
  assert.ok(capability.systemCheck.missing.includes('ros_jazzy'));
  assert.ok(capability.systemCheck.missing.includes('colcon'));
});

test('unsupported Ubuntu is blocked instead of being upgraded automatically',()=>{
  const capability=parseRealSystemProbeOutput(marker(['ubuntu','20.04','focal','Ubuntu 20.04 LTS','amd64','1','0','0','0','0','1','1','1','1','v20.19.0']));
  assert.equal(capability.detected,false);
  assert.equal(capability.systemCheck.canInstallRos,false);
  assert.ok(capability.systemCheck.missing.includes('supported_ubuntu'));
});

test('mission zero commands use the official ROS apt source and never reference simulation',()=>{
  const probe=buildRealSystemProbeCommand(),jazzyInstall=buildRealSystemInstallCommand('jazzy'),humbleInstall=buildRealSystemInstallCommand('humble');
  assert.match(probe,/\/opt\/ros\/jazzy\/setup\.bash/);
  assert.match(probe,/\/opt\/ros\/humble\/setup\.bash/);
  assert.match(jazzyInstall,/ros-infrastructure\/ros-apt-source\/releases\/latest/);
  assert.match(jazzyInstall,/ros2-apt-source_/);
  assert.match(jazzyInstall,/releases\/download\/\$\{ROS_APT_SOURCE_VERSION\}/);
  assert.doesNotMatch(jazzyInstall,/\\\$\{ROS_APT_SOURCE_VERSION\}/);
  assert.match(jazzyInstall,/ros-jazzy-ros-base/);
  assert.doesNotMatch(jazzyInstall,/ros-humble-ros-base/);
  assert.match(humbleInstall,/ros-humble-ros-base/);
  assert.doesNotMatch(humbleInstall,/ros-jazzy-ros-base/);
  assert.match(humbleInstall,/python3-colcon-common-extensions/);
  assert.match(humbleInstall,/python3-rosdep/);
  assert.throws(()=>buildRealSystemInstallCommand('rolling'),/Unsupported/);
  assert.doesNotMatch(probe+jazzyInstall+humbleInstall,/sim_ws|mapsim|simulation/i);
});
