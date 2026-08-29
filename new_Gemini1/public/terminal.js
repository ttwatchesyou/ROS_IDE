// ══ TERMINAL — PTY & multi-tab system ══
// Depends on: common.js (sessionId, sbMsg, API, escH)

// Legacy single-terminal variables (still used by some functions)
let term = null;
let fitAddon = null;
let termWs = null;
let _termWindowResizeBound = false;
let _termSequence = 0;

function termSetBadge(text, state='connecting') {
  const badge = document.getElementById('term-badge');
  if (!badge) return;
  const dotClass = state === 'ready' ? 'dg' : state === 'error' ? 'dr' : 'da';
  badge.innerHTML = `<span class="dot ${dotClass}"></span>${escH(text)}`;
  badge.className = `badge ${state === 'ready' ? 'bg' : state === 'error' ? 'br' : 'ba'}`;
}

function termResetTabs() {
  for (const t of TERMS.splice(0)) {
    t.intentionalClose = true;
    try { t.ws?.close(); } catch {}
    try { t.term?.dispose(); } catch {}
    document.getElementById('xterm-' + t.id)?.remove();
  }
  activeTermId = null;
  termWs = null;
}

// Multi-tab system
const TERMS = [];    // [{id, ws, term, fitAddon, label, ready}]
let activeTermId = null;

// ══ Legacy single terminal (kept for backwards compatibility) ══
function initTerm() {
  if (term) { term.dispose(); term = null; }
  term = new Terminal({
    theme: {
      background: '#0a0c10', foreground: '#e2e4ec', cursor: '#4f8ef7',
      selection: 'rgba(79,142,247,.25)', black: '#1a1d27', brightBlack: '#3d4261',
      blue: '#4f8ef7', brightBlue: '#7fb0ff', cyan: '#38b2ac', brightCyan: '#4ec9b0',
      green: '#3ecf8e', brightGreen: '#6de8a9', magenta: '#9f7aea', brightMagenta: '#c4a8ff',
      red: '#f06767', brightRed: '#ff9898', white: '#e2e4ec', brightWhite: '#fff',
      yellow: '#f5a623', brightYellow: '#ffd580'
    },
    fontFamily: 'JetBrains Mono,monospace', fontSize: 13, lineHeight: 1.4,
    cursorBlink: true, scrollback: 3000, allowProposedApi: true,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  const c = document.getElementById('xterm-container');
  if (c) {
    c.innerHTML = '';
    term.open(c);
    fitAddon.fit();
    term.writeln('\x1b[38;5;240m╔═══════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[38;5;240m║  \x1b[38;5;75mMecha Rayong Terminal\x1b[38;5;240m       ║\x1b[0m');
    term.writeln('\x1b[38;5;240m╚═══════════════════════════════╝\x1b[0m');
    term.writeln('\x1b[38;5;245mกด SSH Connect เพื่อเริ่มใช้งาน\x1b[0m\r\n');
  }
}

function termFit() { if (fitAddon) fitAddon.fit(); }
function termClear() { if (term) term.clear(); }

// ══ Open legacy terminal WebSocket (called on connect) ══
function openTermWs(user, host) {
  termResetTabs();
  termSetBadge('กำลังเปิด Terminal…');

  // Create first tab using new multi-tab system
  const t0 = termNewTab('Terminal 1');
  if (t0) termWs = t0.ws;

  termRenderTabs();
  if (!_termWindowResizeBound) {
    _termWindowResizeBound = true;
    window.addEventListener('resize', termFitActive);
  }
}

// ══ Multi-tab functions ══
function termNewTab(label, autoRun) {
  if (!sessionId) { sbMsg('เชื่อมต่อ SSH ก่อน', 2000); return null; }
  const id = `term_${Date.now()}_${++_termSequence}`;
  const t = {
    id,
    label: label || ('Terminal ' + (TERMS.length + 1)),
    term: null, fitAddon: null, ws: null, ready: false, inputBound: false, intentionalClose: false,
  };
  TERMS.push(t);
  _termInitTab(t);
  termRenderTabs();
  termSwitchTab(id);
  // If auto-run command given, send after shell is ready
  if (autoRun) {
    const checkReady = setInterval(() => {
      if (t.ready) {
        clearInterval(checkReady);
        setTimeout(() => {
          if (t.ws && t.ws.readyState === WebSocket.OPEN)
            t.ws.send(JSON.stringify({ type: 'data', data: autoRun + '\n' }));
        }, 300);
      }
    }, 100);
    setTimeout(() => clearInterval(checkReady), 8000);
  }
  return t;
}

function _termInitTab(t) {
  const viewport = document.getElementById('term-viewport');
  if (!viewport) { console.error('term-viewport not found'); return; }

  const div = document.createElement('div');
  div.id = 'xterm-' + t.id;
  div.style.cssText = 'position:absolute;inset:0;display:none';
  viewport.appendChild(div);

  t.term = new Terminal({
    theme: {
      background: '#0a0c10', foreground: '#e2e4ec', cursor: '#4f8ef7',
      selection: 'rgba(79,142,247,.25)', black: '#1a1d27', brightBlack: '#3d4261',
      blue: '#4f8ef7', green: '#3ecf8e', red: '#f06767', yellow: '#f5a623',
      cyan: '#38b2ac', magenta: '#9f7aea', white: '#e2e4ec', brightWhite: '#fff'
    },
    fontFamily: 'JetBrains Mono,monospace', fontSize: 13, lineHeight: 1.4,
    cursorBlink: true, scrollback: 3000, allowProposedApi: true,
  });
  t.fitAddon = new FitAddon.FitAddon();
  t.term.loadAddon(t.fitAddon);
  t.term.open(div);
  setTimeout(() => termFitTab(t), 50);

  // Connect SSH WS
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getAuthToken();
  t.ws = new WebSocket(`${proto}//${location.host}/ws/terminal`, ['ros2ide', token]);
  t.ws.onopen = () => {
    t.ws.send(JSON.stringify({ type: 'init', sessionId, cols: t.term.cols, rows: t.term.rows }));
  };
  t.ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch { t.term.writeln('\r\n\x1b[31m[Terminal protocol error]\x1b[0m'); return; }
    if (msg.type === 'ready') {
      t.ready = true;
      termSetBadge('Terminal พร้อมใช้งาน', 'ready');
      t.term.writeln(`\x1b[32m[${t.label}]\x1b[0m ${msg.workspace ? `\x1b[38;5;245m${msg.workspace}\x1b[0m` : ''}\r\n`);
      if (msg.rosInfo?.distro && msg.rosInfo.distro !== 'unknown')
        t.term.writeln(`\x1b[38;5;245mROS ${msg.rosInfo.distro} auto-sourced\x1b[0m\r\n`);
      if (!t.inputBound) {
        t.inputBound = true;
        t.term.onData(data => {
          if (t.ws && t.ws.readyState === WebSocket.OPEN)
            t.ws.send(JSON.stringify({ type: 'data', data }));
        });
      }
      termFitTab(t);
    } else if (msg.type === 'data') {
      // Server sends base64 encoded terminal output
      try { t.term.write(atob(msg.data)); } catch(e) { t.term.write(msg.data||''); }
    } else if (msg.type === 'pty_output') {
      // Alternative format from some server versions
      try { t.term.write(atob(msg.data)); } catch(e) { t.term.write(msg.data||''); }
    } else if (msg.type === 'exit' || msg.type === 'pty_closed') {
      t.term.writeln('\r\n\x1b[33m[Session closed]\x1b[0m');
    } else if (msg.type === 'error') {
      t.ready = false;
      termSetBadge('Terminal เชื่อมต่อไม่ได้', 'error');
      t.term.writeln(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m`);
    }
  };
  t.ws.onerror = () => {
    if (!t.intentionalClose) termSetBadge('Terminal เชื่อมต่อไม่ได้', 'error');
  };
  t.ws.onclose = event => {
    t.ready = false;
    if (!t.intentionalClose) {
      termSetBadge('Terminal หลุดการเชื่อมต่อ', 'error');
      t.term.writeln(`\r\n\x1b[31m[Terminal disconnected${event.code ? `: ${event.code}` : ''}]\x1b[0m`);
    }
  };
}

function termRenderTabs() {
  const bar = document.getElementById('term-tabbar');
  if (!bar) return;
  bar.innerHTML = '';

  if (TERMS.length <= 1) {
    bar.style.display = 'none';
    const lbl = document.getElementById('term-active-label');
    if (lbl) lbl.textContent = TERMS[0]?.label || '';
    return;
  }
  bar.style.display = 'flex';

  TERMS.forEach(t => {
    const btn = document.createElement('button');
    const isActive = t.id === activeTermId;
    btn.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
      font-size:11px;border-radius:4px;cursor:pointer;flex-shrink:0;
      border:1px solid ${isActive?'var(--abrd)':'var(--brd)'};
      background:${isActive?'var(--adim)':'var(--bg2)'};
      color:${isActive?'var(--acc)':'var(--mt)'};font-family:var(--mono)`;
    btn.innerHTML = escH(t.label);
    btn.onclick = () => termSwitchTab(t.id);
    // Close ×
    const x = document.createElement('span');
    x.textContent = '×';
    x.style.cssText = 'opacity:.5;cursor:pointer;margin-left:2px;font-size:12px';
    x.onclick = e => { e.stopPropagation(); termCloseTab(t.id); };
    btn.appendChild(x);
    bar.appendChild(btn);
  });

  // + New Tab
  const plus = document.createElement('button');
  plus.textContent = '+';
  plus.style.cssText = 'padding:3px 9px;font-size:13px;border-radius:4px;cursor:pointer;border:1px solid var(--brd);background:var(--bg2);color:var(--mt)';
  plus.onclick = () => termNewTab();
  bar.appendChild(plus);

  // Update header label
  const lbl = document.getElementById('term-active-label');
  if (lbl) lbl.textContent = TERMS.find(t => t.id === activeTermId)?.label || '';
}

function termSwitchTab(id) {
  activeTermId = id;
  const viewport = document.getElementById('term-viewport');
  if (!viewport) return;
  viewport.querySelectorAll('[id^="xterm-"]').forEach(el => el.style.display = 'none');
  const active = document.getElementById('xterm-' + id);
  if (active) active.style.display = 'block';
  const t = TERMS.find(t => t.id === id);
  if (t) setTimeout(() => termFitTab(t), 30);
  termRenderTabs();
  // Point global termWs to active tab
  termWs = t?.ws || termWs;
}

// ส่งคำสั่งไปรันในแท็บที่มีอยู่แล้ว (ไม่สร้างแท็บใหม่)
// รอจน shell พร้อม (ready) แล้วค่อยส่ง — ใช้ตอน reuse แท็บเดิมแทนการเปิดแท็บใหม่
function termRunInTab(id, cmd) {
  const t = TERMS.find(x => x.id === id);
  if (!t) return;
  const send = () => {
    if (t.ws && t.ws.readyState === WebSocket.OPEN)
      t.ws.send(JSON.stringify({ type: 'data', data: cmd + '\n' }));
  };
  if (t.ready) { send(); return; }
  const iv = setInterval(() => {
    if (t.ready) { clearInterval(iv); send(); }
  }, 100);
  setTimeout(() => clearInterval(iv), 8000);
}

function termCloseTab(id) {
  const idx = TERMS.findIndex(t => t.id === id);
  if (idx < 0) return;
  const t = TERMS[idx];
  t.intentionalClose = true;
  try { t.ws?.close(); } catch(e) {}
  document.getElementById('xterm-' + t.id)?.remove();
  TERMS.splice(idx, 1);
  if (TERMS.length > 0) {
    const next = TERMS[Math.max(0, idx - 1)];
    termSwitchTab(next.id);
  } else {
    activeTermId = null; termWs = null; termRenderTabs();
  }
}

function termClearActive() {
  const t = TERMS.find(t => t.id === activeTermId);
  if (t) t.term?.clear();
  else if (term) term.clear(); // fallback to global term
}

function termFitActive() {
  const t = TERMS.find(t => t.id === activeTermId);
  if (t) termFitTab(t);
  else if (fitAddon) fitAddon.fit();
}

function termFitTab(t) {
  if (!t?.term || !t.fitAddon) return;
  t.fitAddon.fit();
  if (t.ws?.readyState === WebSocket.OPEN) {
    t.ws.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
  }
}
