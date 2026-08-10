// ══ TERMINAL — PTY & multi-tab system ══
// Depends on: common.js (sessionId, sbMsg, API, escH)

// Legacy single-terminal variables (still used by some functions)
let term = null;
let fitAddon = null;
let termWs = null;

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
    term.writeln('\x1b[38;5;240m║  \x1b[38;5;75mROS2 IDE Terminal\x1b[38;5;240m            ║\x1b[0m');
    term.writeln('\x1b[38;5;240m╚═══════════════════════════════╝\x1b[0m');
    term.writeln('\x1b[38;5;245mกด SSH Connect เพื่อเริ่มใช้งาน\x1b[0m\r\n');
  }
}

function termFit() { if (fitAddon) fitAddon.fit(); }
function termClear() { if (term) term.clear(); }

// ══ Open legacy terminal WebSocket (called on connect) ══
function openTermWs(user, host) {
  // Close old connections
  TERMS.forEach(t => { try { t.ws?.close(); } catch(e) {} });
  TERMS.length = 0;

  // Create first tab using new multi-tab system
  const t0 = termNewTab('Terminal 1');
  if (t0) termWs = t0.ws;

  termRenderTabs();
  window.addEventListener('resize', () => {
    termFitActive();
    if (termWs && termWs.readyState === WebSocket.OPEN && term)
      termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
}

// ══ Multi-tab functions ══
function termNewTab(label, autoRun) {
  if (!sessionId) { sbMsg('เชื่อมต่อ SSH ก่อน', 2000); return null; }
  const id = 'term_' + Date.now();
  const t = {
    id,
    label: label || ('Terminal ' + (TERMS.length + 1)),
    term: null, fitAddon: null, ws: null, ready: false,
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
  setTimeout(() => t.fitAddon?.fit(), 50);

  // Connect SSH WS
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('ros2ide_token') || '';
  t.ws = new WebSocket(`${proto}//${location.host}/ws/terminal`, ['ros2ide', token]);
  t.ws.onopen = () => {
    t.ws.send(JSON.stringify({ type: 'init', sessionId, cols: t.term.cols, rows: t.term.rows }));
  };
  t.ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'ready') {
      t.ready = true;
      t.term.writeln(`\x1b[32m[${t.label}]\x1b[0m\r\n`);
      if (msg.rosInfo?.distro && msg.rosInfo.distro !== 'unknown')
        t.term.writeln(`\x1b[38;5;245mROS ${msg.rosInfo.distro} auto-sourced\x1b[0m\r\n`);
      t.term.onData(data => {
        if (t.ws && t.ws.readyState === WebSocket.OPEN)
          t.ws.send(JSON.stringify({ type: 'data', data }));
      });
    } else if (msg.type === 'data') {
      // Server sends base64 encoded terminal output
      try { t.term.write(atob(msg.data)); } catch(e) { t.term.write(msg.data||''); }
    } else if (msg.type === 'pty_output') {
      // Alternative format from some server versions
      try { t.term.write(atob(msg.data)); } catch(e) { t.term.write(msg.data||''); }
    } else if (msg.type === 'exit' || msg.type === 'pty_closed') {
      t.term.writeln('\r\n\x1b[33m[Session closed]\x1b[0m');
    } else if (msg.type === 'error') {
      t.term.writeln(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m`);
    }
  };
  t.ws.onclose = () => { if (t === TERMS.find(x => x.id === activeTermId)) { } };
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
  if (t) setTimeout(() => t.fitAddon?.fit(), 30);
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
  if (t) t.fitAddon?.fit();
  else if (fitAddon) fitAddon.fit();
}
