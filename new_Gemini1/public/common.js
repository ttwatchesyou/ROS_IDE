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

// API wrapper
const API = (path, body) => {
  const token = localStorage.getItem('ros2ide_token') || '';
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify(body)
  }).then(r => r.json());
};

async function appLogout() {
  try { await API('/api/auth/logout', {}); } catch (_) {}
  ['ros2ide_token','ros2ide_user','ros2ide_session','ros2ide_rosinfo','ros2ide_workspace','ros2ide_username','ros2ide_robotname','ros2ide_is_sim']
    .forEach(k => localStorage.removeItem(k));
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
