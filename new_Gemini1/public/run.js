// ══ RUN MANAGER PAGE ══
// Depends on: common.js (sessionId, rosInfo, API, sbMsg, escH)

const RUN = {
  packages: [],   // [{name, lang, exes:[{name, module, func, label}]}]
  selected: null, // package name
  runTabs: {},    // exe name → terminal tab id (ให้ Kill ปิดแท็บ Terminal นั้นตรงๆ)
};

// สร้าง snippet export ตัวแปรสภาพแวดล้อม ROS ให้ชี้มาที่ install prefix ของ workspace
// สภาพแวดล้อมนี้ colcon/setup.bash ไม่ได้ลงทะเบียน AMENT_PREFIX_PATH ให้เอง จึงต้อง export เอง
// รองรับทั้ง layout merged (install/) และ isolated (install/<pkg>/)
function amentEnvExports(pkg){
  const p = '~/ros2_ws/install';
  return ' && if [ -f ' + p + '/share/ament_index/resource_index/packages/' + pkg + ' ]; then PREF=' + p + '; else PREF=' + p + '/' + pkg + '; fi' +
         ' && export AMENT_PREFIX_PATH=$PREF:${AMENT_PREFIX_PATH}' +
         ' && export PYTHONPATH=$PREF/lib/python3.12/site-packages:${PYTHONPATH}' +
         ' && export PATH=$PREF/lib/' + pkg + ':$PREF/bin:${PATH}';
}

// ══ Init Run Page ══
function initRunPage(){
  document.getElementById('btn-run-refresh').disabled = !sessionId;
  document.getElementById('btn-run-buildall').disabled = !sessionId;
  if(sessionId && RUN.packages.length === 0) runRefresh();
}

// ══ Refresh: scan workspace/src for packages and read setup.py / CMakeLists ══
async function runRefresh(){
  if(!sessionId) return;
  const btn = document.getElementById('btn-run-refresh');
  btn.disabled = true; btn.textContent = '↻ Loading...';
  sbMsg('Scanning packages...');

  try {
    const r = await API('/api/files/list',{sessionId, path: wsPath+'/src'});
    if(!r.ok){ sbMsg('Cannot read src/: '+r.error, 3000); return; }

    const pkgDirs = r.items.filter(i => i.isDir);
    RUN.packages = [];

    await Promise.all(pkgDirs.map(async dir => {
      const name = dir.name;
      // Try setup.py (Python)
      const setupR = await API('/api/files/read',{sessionId, path: `${wsPath}/src/${name}/setup.py`});
      if(setupR.ok){
        const exes = parseSetupPyExes(setupR.content, name);
        RUN.packages.push({name, lang:'py', exes});
        return;
      }
      // Try CMakeLists.txt (C++)
      const cmakeR = await API('/api/files/read',{sessionId, path: `${wsPath}/src/${name}/CMakeLists.txt`});
      if(cmakeR.ok){
        const exes = parseCmakeExes(cmakeR.content);
        RUN.packages.push({name, lang:'cpp', exes});
        return;
      }
    }));

    RUN.packages.sort((a,b) => a.name.localeCompare(b.name));
    runRenderPkgList();
    document.getElementById('run-pkg-count').textContent = RUN.packages.length + ' packages';
    sbMsg('');
  } catch(e) {
    sbMsg('Error: '+e.message, 3000);
  } finally {
    btn.disabled = !sessionId; btn.textContent = '↻ Refresh';
  }
}

// ══ Parse entry_points from setup.py ══
function parseSetupPyExes(src, pkg){
  const exes = [];
  // Match: 'exe_name = pkg.module:func'
  const re = /['"]([a-zA-Z0-9_-]+)\s*=\s*([a-zA-Z0-9_.]+):([a-zA-Z0-9_]+)['"]/g;
  let m;
  while((m = re.exec(src)) !== null){
    exes.push({name:m[1], module:m[2], func:m[3], label: `${m[2]}:${m[3]}`});
  }
  return exes;
}

// ══ Parse add_executable from CMakeLists.txt ══
function parseCmakeExes(src){
  const exes = [];
  const re = /add_executable\s*\(\s*(\w+)/g;
  let m;
  while((m = re.exec(src)) !== null){
    if(!m[1].endsWith('_test')) exes.push({name:m[1], module:'', func:'main', label:'C++ executable'});
  }
  return exes;
}

// ══ Render package list ══
function runRenderPkgList(){
  const el = document.getElementById('run-pkg-scroll');
  if(RUN.packages.length === 0){
    el.innerHTML = '<div class="run-empty" style="padding:30px 0;font-size:11px"><div class="icon">📦</div><div>ไม่พบ package ใน workspace</div></div>';
    return;
  }
  el.innerHTML = RUN.packages.map(pkg => `
    <div class="run-pkg-item ${pkg.name===RUN.selected?' active':''}" onclick="runSelectPkg(decodeURIComponent('${encArg(pkg.name)}'))">
      <span class="run-pkg-name">${escH(pkg.name)}</span>
      <span class="run-pkg-lang ${pkg.lang==='py'?'py':'cpp'}">${pkg.lang==='py'?'py':'c++'}</span>
    </div>
  `).join('');
}

// ══ Select package → show executables ══
function runSelectPkg(name){
  RUN.selected = name;
  runRenderPkgList();
  const pkg = RUN.packages.find(p => p.name === name);
  if(!pkg) return;

  document.getElementById('run-exe-head').style.display = 'flex';
  document.getElementById('run-exe-pkg-title').textContent = name;
  document.getElementById('run-exe-count').textContent = pkg.exes.length + ' executables';
  document.getElementById('btn-run-build-pkg').dataset.pkg = name;

  // Pre-fill quick run
  const qr = document.getElementById('run-quick-input');
  if(qr) qr.value = name + ' ';

  const scroll = document.getElementById('run-exe-scroll');
  const empty  = document.getElementById('run-exe-empty');

  if(pkg.exes.length === 0){
    scroll.innerHTML = '';
    if(empty) { empty.style.display = 'flex'; empty.innerHTML = '<div class="icon">⚠️</div><div>ไม่พบ executable ใน '+escH(name)+'<br><small style="color:var(--dim)">ลอง Build ก่อน</small></div>'; }
    return;
  }

  if(empty) empty.style.display = 'none';

  scroll.innerHTML = pkg.exes.map(exe => `
    <div class="exe-card" id="exe-card-${escH(exe.name)}">
      <div class="exe-card-head">
        <span class="exe-name">${escH(exe.name)}</span>
        <span class="exe-module">${escH(exe.label)}</span>
        <span class="run-status stopped" id="run-status-${escH(name)}-${escH(exe.name)}">⏹ Stopped</span>
      </div>
      <div class="exe-actions">
        <button class="run-btn run-btn-go" onclick="runExe(decodeURIComponent('${encArg(name)}'),decodeURIComponent('${encArg(exe.name)}'))">▷ Run</button>
        <button class="run-btn run-btn-kill" onclick="killExe(decodeURIComponent('${encArg(name)}'),decodeURIComponent('${encArg(exe.name)}'))">⏹ Kill</button>
        <button class="run-btn run-btn-sec" onclick="runExeLog(decodeURIComponent('${encArg(name)}'),decodeURIComponent('${encArg(exe.name)}'))">📋 Log</button>
        <button class="run-btn run-btn-sec" onclick="openExeFile(decodeURIComponent('${encArg(name)}'),decodeURIComponent('${encArg(exe.module)}'))">📄 Open file</button>
      </div>
      <input class="exe-args" id="exe-args-${escH(name)}-${escH(exe.name)}" placeholder="arguments (optional) e.g. --ros-args -p speed:=1.0"/>
    </div>
  `).join('');
}

// ══ Run executable ══
async function runExe(pkg, exe){
  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  const args = document.getElementById(`exe-args-${pkg}-${exe}`)?.value?.trim() || '';
  // ฆ่า instance เก่า (backend auto-spawn หรือรันคราวก่อน) ก่อนรันใหม่
  // กัน node ซ้ำซ้อนโพสต์ /tf /odom ซ้ำกัน → rviz กระพริบ 2 ตำแหน่ง
  try { await API('/api/kill-node', { sessionId, pkg, exe }); } catch(e){}
  const cmd = `source ${src} && source ${wsPath}/install/setup.bash 2>/dev/null` + amentEnvExports(pkg) + ` && ros2 run ${pkg} ${exe}${args ? ' '+args : ''}`;

  // ใช้แท็บเฉพาะชื่อ "▷ <pkg>/<exe>" — รัน package เดิมให้เด้งไปแท็บเดิม (ไม่เปิดใหม่)
  // แล้วจดจำ tab id ไว้ เพื่อให้ Kill ปิด Terminal ตัวนั้นตรงๆ ได้ (key ตาม pkg::exe ป้องกันชนกับ exe ชื่อซ้ำ)
  const key = pkg + '::' + exe;
  const t = runInDedicatedTab(cmd, `▷ ${pkg}/${exe}`);
  if (t && t.id) RUN.runTabs[key] = t.id;

  const badge = document.getElementById(`run-status-${pkg}-${exe}`);
  if(badge){ badge.textContent='▶ Running'; badge.className='run-status running'; }
}

async function killExe(pkg, exe){
  if (!sessionId) return;
  const badge = document.getElementById(`run-status-${pkg}-${exe}`);
  sbMsg(`Killing ${pkg}/${exe}...`);

  // ฆ่า process จริง (ไม่ใช่แค่ปิด terminal) — ใช้ backend /api/kill-node
  // ซึ่งฆ่าโครงสร้างตาม path ของ binary จริง (ros2 run ทำ exec เปลี่ยน cmdline แล้ว
  // จึงไม่มีคำว่า "ros2 run" อีก เลยจับไม่ได้ด้วย pkill -f "ros2 run.*")
  let r = { ok:true, stillUp:false };
  try {
    r = await API('/api/kill-node', { sessionId, pkg, exe });
  } catch(e) { r = { ok:false, error:e.message }; }

  if (r.ok && !r.stillUp) {
    if(badge){ badge.textContent='⏹ Stopped'; badge.className='run-status stopped'; }
    sbMsg(`✅ Killed ${pkg}/${exe}`, 2000);
    // ปิดแท็บ Terminal ที่รันคำสั่งนี้ (ทำความสะอาด) — node ตายไปแล้วจึงปลอดภัย
    const key = pkg + '::' + exe;
    const tabId = RUN.runTabs[key];
    if (tabId && typeof TERMS !== 'undefined' && TERMS.find(x => x.id === tabId) && typeof termCloseTab === 'function') {
      termCloseTab(tabId);
      delete RUN.runTabs[key];
    }
  } else {
    // ฆ่าไม่สำเร็จ → เก็บแท็บไว้ อย่าปิด (กัน node ค้างเป็น orphan) แล้วบอกให้ไป Kill PID ที่ Dashboard
    if(badge){ badge.textContent='⚠ Still running'; badge.className='run-status running'; }
    sbMsg(`⚠ ไม่สามารถฆ่า ${exe} ได้ ลอง Kill PID ในหน้า Dashboard`, 4000);
  }
}

function runExeLog(pkg, exe){
  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  const cmd = `source ${src} 2>/dev/null && ros2 node list | grep ${exe} && ros2 node info ${exe} 2>/dev/null`;
  runInNewTab(cmd, `📋 Log: ${exe}`);
}

async function openExeFile(pkg, module){
  // module = "pkg.submodule" → file = wsPath/src/pkg/pkg/submodule.py
  if(!module) return;
  const parts = module.split('.');
  const filePath = `${wsPath}/src/${pkg}/${parts.join('/')}.py`;
  await openFilePath(filePath);
}

// ══ Build package ══
function runBuildPkg(){
  const pkg = document.getElementById('btn-run-build-pkg')?.dataset?.pkg || RUN.selected;
  if(!pkg) return;
  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  // force merged layout (สภาพแวดล้อมนี้ default เป็น isolated ซึ่ง ros2 หา package ไม่เจอ)
  const cmd = `cd ${wsPath} && source ${src} && rm -rf ${wsPath}/build ${wsPath}/install ${wsPath}/log && colcon build --merge-install --packages-select ${pkg} && echo "\n[OK] Build done: ${pkg}"`;
  // ใช้แท็บเฉพาะชื่อ "⚙️ Build: <pkg>" — ถ้ามีอยู่แล้วให้เด้งไปแท็บเดิมแทนเปิดใหม่
  runInDedicatedTab(cmd, `⚙️ Build: ${pkg}`);
}

function runBuildAll(){
  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  const cmd = `cd ${wsPath} && source ${src} && rm -rf ${wsPath}/build ${wsPath}/install ${wsPath}/log && colcon build --merge-install && echo "\n[OK] Build All done"`;
  // ใช้แท็บเฉพาะชื่อ "⚙️ Build All" — ถ้ามีอยู่แล้วให้เด้งไปแท็บเดิมแทนเปิดใหม่
  runInDedicatedTab(cmd, '⚙️ Build All');
}

function runSourceSetup(){
  runInNewTab(`source ${wsPath}/install/setup.bash && echo '[OK] Sourced'`, '⟳ Source');
}

// ══ Quick run bar ══
function runQuick(){
  const val = document.getElementById('run-quick-input')?.value?.trim();
  if(!val) return;
  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  const cmd = `source ${src} && source ${wsPath}/install/setup.bash 2>/dev/null` + amentEnvExports(val.split(' ')[0]) + ` && ros2 run ${val}`;
  // ดึงชื่อคำสั่งคำแรกมาเป็นชื่อ Tab
  const tabName = val.split(' ')[0] || 'Run';
  runInNewTab(cmd, `▷ ${tabName}`);
}

function runQuickLaunch(){
  const val = document.getElementById('run-quick-input')?.value?.trim();
  if(!val) return;
  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  const cmd = `source ${src} && source ${wsPath}/install/setup.bash 2>/dev/null` + amentEnvExports(val.split(' ')[0]) + ` && ros2 launch ${val}`;
  const tabName = val.split(' ')[0] || 'Launch';
  runInNewTab(cmd, `🚀 ${tabName}`);
}

// ══ Fix runCurrentNode — read entry_points from setup.py first ══
async function runCurrentNode(){
  if(!currentPath) return;
  const parts = currentPath.split('/');
  const pkgIdx = parts.findIndex(p => p === 'src');
  const pkg = pkgIdx >= 0 ? parts[pkgIdx+1] : null;
  if(!pkg) { switchPage('terminal'); return; }

  // Read setup.py to find executable that matches this file
  const fileName = currentPath.split('/').pop().replace(/\.py$/, '');
  let exeName = fileName; // fallback

  if(sessionId){
    const r = await API('/api/files/read',{sessionId, path: `${wsPath}/src/${pkg}/setup.py`});
    if(r.ok){
      const exes = parseSetupPyExes(r.content, pkg);
      // Find exe where module ends with fileName
      const match = exes.find(e => e.module.endsWith('.'+fileName) || e.name === fileName);
      if(match) exeName = match.name;
    }
  }

  const src = rosInfo?.setupBash || '/opt/ros/humble/setup.bash';
  const cmd = `source ${src} && source ${wsPath}/install/setup.bash 2>/dev/null` + amentEnvExports(pkg) + ` && ros2 run ${pkg} ${exeName}`;
  runInNewTab(cmd, `▷ ${exeName}`);
}
