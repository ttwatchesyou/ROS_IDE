'use strict';

const SYSTEM_CHECK_MARKER = 'ROSIDE_REAL_SYSTEM_CHECK=';
const SUPPORTED_ARCHITECTURES = new Set(['amd64', 'arm64']);

function buildRealSystemProbeCommand() {
  const script = String.raw`set +e
os_id=''; os_version=''; os_codename=''; os_pretty='';
if [ -r /etc/os-release ]; then
  . /etc/os-release
  os_id="$ID"
  os_version="$VERSION_ID"
  os_codename="$VERSION_CODENAME"
  [ -n "$os_codename" ] || os_codename="$UBUNTU_CODENAME"
  os_pretty="$PRETTY_NAME"
fi
arch=$(dpkg --print-architecture 2>/dev/null || uname -m 2>/dev/null || true)
has_apt=0; command -v apt-get >/dev/null 2>&1 && has_apt=1
has_jazzy_setup=0; [ -r /opt/ros/jazzy/setup.bash ] && has_jazzy_setup=1
has_jazzy_ros2=0
if [ "$has_jazzy_setup" = 1 ]; then
  bash -lc 'source /opt/ros/jazzy/setup.bash >/dev/null 2>&1 && command -v ros2 >/dev/null 2>&1' && has_jazzy_ros2=1
fi
has_humble_setup=0; [ -r /opt/ros/humble/setup.bash ] && has_humble_setup=1
has_humble_ros2=0
if [ "$has_humble_setup" = 1 ]; then
  bash -lc 'source /opt/ros/humble/setup.bash >/dev/null 2>&1 && command -v ros2 >/dev/null 2>&1' && has_humble_ros2=1
fi
has_colcon=0; command -v colcon >/dev/null 2>&1 && has_colcon=1
has_rosdep=0; command -v rosdep >/dev/null 2>&1 && has_rosdep=1
has_git=0; command -v git >/dev/null 2>&1 && has_git=1
has_curl=0; command -v curl >/dev/null 2>&1 && has_curl=1
node_version=$(node --version 2>/dev/null || true)
printf '%s' '${SYSTEM_CHECK_MARKER}'
printf '%s\n' "$(printf '%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s' "$os_id" "$os_version" "$os_codename" "$os_pretty" "$arch" "$has_apt" "$has_jazzy_setup" "$has_jazzy_ros2" "$has_humble_setup" "$has_humble_ros2" "$has_colcon" "$has_rosdep" "$has_git" "$has_curl" "$node_version" | base64 -w0)"`;
  return `bash -lc ${shellQuote(script)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseRealSystemProbeOutput(stdout) {
  const line = String(stdout || '').split(/\r?\n/).reverse().find(value => value.startsWith(SYSTEM_CHECK_MARKER));
  if (!line) throw new Error('Robot system check returned no result');
  let decoded;
  try { decoded = Buffer.from(line.slice(SYSTEM_CHECK_MARKER.length), 'base64').toString('utf8'); }
  catch { throw new Error('Robot system check result is invalid'); }
  const [id='', version='', codename='', prettyName='', architecture='', apt='0', jazzySetup='0', jazzyRos2='0', humbleSetup='0', humbleRos2='0', colcon='0', rosdep='0', git='0', curl='0', nodeVersion=''] = decoded.split('\x1f');
  const ubuntuId = id.toLowerCase() === 'ubuntu';
  const ubuntuNoble = ubuntuId && version.startsWith('24.04') && codename.toLowerCase() === 'noble';
  const ubuntuJammy = ubuntuId && version.startsWith('22.04') && codename.toLowerCase() === 'jammy';
  const targetDistro = ubuntuNoble ? 'jazzy' : ubuntuJammy ? 'humble' : '';
  const targetDistroLabel = targetDistro === 'jazzy' ? 'Jazzy' : targetDistro === 'humble' ? 'Humble' : '';
  const ubuntuSupported = Boolean(targetDistro);
  const architectureSupported = SUPPORTED_ARCHITECTURES.has(architecture);
  const aptAvailable = apt === '1';
  const rosInstallations = {
    jazzy: jazzySetup === '1' && jazzyRos2 === '1',
    humble: humbleSetup === '1' && humbleRos2 === '1',
  };
  const rosInstalled = Boolean(targetDistro && rosInstallations[targetDistro]);
  const tools = { colcon:colcon === '1', rosdep:rosdep === '1', git:git === '1', curl:curl === '1' };
  const canInstallRos = ubuntuSupported && architectureSupported && aptAvailable;
  const ready = canInstallRos && rosInstalled && Object.values(tools).every(Boolean);
  const missing = [];
  if (!ubuntuSupported) missing.push('supported_ubuntu');
  if (!architectureSupported) missing.push('architecture');
  if (!aptAvailable) missing.push('apt');
  if (!rosInstalled) missing.push(targetDistro ? `ros_${targetDistro}` : 'supported_ros');
  for (const [name, installed] of Object.entries(tools)) if (!installed) missing.push(name);
  const osLabel = prettyName || [id, version].filter(Boolean).join(' ') || 'Unknown operating system';
  const validationMessage = ready
    ? `${osLabel} · ${architecture} · ROS 2 ${targetDistroLabel} พร้อมใช้งาน`
    : !canInstallRos
      ? `${osLabel} · ${architecture || 'unknown architecture'} ไม่ตรงกับ Ubuntu 22.04/Humble หรือ Ubuntu 24.04/Jazzy ที่ระบบรองรับ`
      : `เครื่องรองรับ ROS 2 ${targetDistroLabel} แต่ยังขาด: ${missing.filter(item=>!['supported_ubuntu','architecture','apt'].includes(item)).map(item=>({ros_jazzy:'ROS 2 Jazzy',ros_humble:'ROS 2 Humble',supported_ros:'ROS 2 รุ่นที่รองรับ',colcon:'colcon',rosdep:'rosdep',git:'Git',curl:'curl'}[item]||item)).join(', ') || 'แพ็กเกจระบบ'}`;
  const setupBash = targetDistro ? `/opt/ros/${targetDistro}/setup.bash` : '';
  return {
    id:'system', detected:ready, count:ready?1:0,
    files:rosInstalled?['/etc/os-release',setupBash]:['/etc/os-release'],
    resultCheck:true, validationMessage,
    systemCheck:{id,version,codename,prettyName:osLabel,architecture,nodeVersion,ubuntuSupported,ubuntuNoble,ubuntuJammy,architectureSupported,aptAvailable,targetDistro,targetDistroLabel,setupBash,canInstallRos,rosInstalled,rosInstallations,tools,missing,ready},
  };
}

function buildRealSystemInstallCommand(distro) {
  const rosDistro = String(distro || '').toLowerCase();
  if (!['humble','jazzy'].includes(rosDistro)) throw new Error('Unsupported ROS 2 distribution');
  return String.raw`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=60 update
apt-get -o DPkg::Lock::Timeout=60 install -y locales software-properties-common curl gnupg ca-certificates git build-essential
locale-gen en_US en_US.UTF-8
update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
add-apt-repository -y universe
. /etc/os-release
ROS_APT_SOURCE_VERSION=$(curl -fsSL https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
test -n "$ROS_APT_SOURCE_VERSION"
curl -fL -o /tmp/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${'${ROS_APT_SOURCE_VERSION}'}/ros2-apt-source_${'${ROS_APT_SOURCE_VERSION}'}.${'${UBUNTU_CODENAME}'}_all.deb"
apt-get install -y /tmp/ros2-apt-source.deb
apt-get -o DPkg::Lock::Timeout=60 update
apt-get -o DPkg::Lock::Timeout=60 install -y ros-${rosDistro}-ros-base python3-colcon-common-extensions python3-rosdep python3-vcstool
if [ ! -e /etc/ros/rosdep/sources.list.d/20-default.list ]; then rosdep init; fi`;
}

module.exports = { buildRealSystemProbeCommand, parseRealSystemProbeOutput, buildRealSystemInstallCommand };
