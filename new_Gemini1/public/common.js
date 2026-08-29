// ══ COMMON — shared state & utilities ══
let sessionId = null;
let wsPath = '~/ros2_ws';
let currentPath = null;
let openTabs = [];
let activeTab = null;
let authMode = 'password';
let nfType = 'py';
let rosInfo = null;
let isSimWorkspace = localStorage.getItem('ros2ide_is_sim') === 'true';
let treeState = {};
let terminalPlanAccess = false;
let terminalPlanAccessResolved = false;

// API wrapper
const API = (path, body) => {
  const token = getAuthToken();
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
    },
    body: JSON.stringify(body)
  }).then(async r => {
    const raw = await r.text();
    if (r.status === 401) {
      clearAuthSession();
      window.location.replace('/');
      throw new Error('Session expired');
    }
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      const contentType = r.headers && r.headers.get ? (r.headers.get('content-type') || '') : '';
      const error = new Error(
        `Server ตอบกลับไม่ถูกต้อง (${r.status || 'unknown'}${contentType ? ', ' + contentType : ''}) กรุณารีสตาร์ต server แล้วลองใหม่`
      );
      error.status = r.status;
      error.code = 'INVALID_API_RESPONSE';
      throw error;
    }
    return data;
  });
};

function applyTerminalPlanAccess(membership) {
  terminalPlanAccess = Boolean(membership && membership.planCode !== 'free');
  terminalPlanAccessResolved = true;
  const menu = document.getElementById('terminal-menu');
  if (menu) {
    menu.hidden = !terminalPlanAccess;
    menu.setAttribute('aria-hidden', String(!terminalPlanAccess));
  }
  if (!terminalPlanAccess && document.getElementById('page-terminal')?.classList.contains('show')) {
    switchPage('dashboard');
  }
}

async function loadTerminalPlanAccess() {
  try {
    const response = await fetch('/api/auth/me', {headers: authHeaders()});
    if (response.status === 401) {
      clearAuthSession();
      window.location.replace('/');
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load membership');
    applyTerminalPlanAccess(result.membership);
  } catch (error) {
    terminalPlanAccessResolved = true;
    const menu = document.getElementById('terminal-menu');
    if (menu) menu.hidden = true;
    console.warn('[MEMBERSHIP] Unable to determine Terminal access:', error.message);
  }
}

async function appLogout() {
  try { await API('/api/auth/logout', {}); } catch (_) {}
  clearAuthSession();
  window.location.replace('/');
}

// HTML escape
function escH(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Encode untrusted text before placing it inside an inline event-handler string.
// Prefer addEventListener for new code; this helper keeps legacy templates safe.
function encArg(s) {
  return encodeURIComponent(String(s ?? '')).replace(/'/g, '%27');
}

// Base64 key for tree node IDs
function b64k(s) {
  try {
    return btoa(encodeURIComponent(s))
      .replace(/=/g, '')
      .replace(/\+/g, '_')
      .replace(/\//g, '-');
  } catch (e) {
    return Math.random().toString(36).slice(2);
  }
}

// Status bar message
function sbMsg(text, timeout = 3000) {
  const el = document.getElementById('sb-msg');
  if (!el) return;
  el.textContent = text;
  if (timeout) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, timeout);
}
