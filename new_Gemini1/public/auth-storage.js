'use strict';

// `token` is the public integration key. Keep the legacy ROSIDE key so tabs
// opened before this change continue to share the same login session.
const AUTH_TOKEN_KEYS = ['ros2ide_token', 'token', 'session_id'];
const AUTH_SESSION_KEYS = [
  ...AUTH_TOKEN_KEYS,
  'user_id', 'encrypted_user_id', 'ros2ide_user', 'ros2ide_session', 'ros2ide_robotid', 'ros2ide_rosinfo',
  'ros2ide_workspace', 'ros2ide_username', 'ros2ide_robotname', 'ros2ide_is_sim',
];

function getAuthToken() {
  const token = AUTH_TOKEN_KEYS.map(key => localStorage.getItem(key)).find(Boolean) || '';
  if (token) AUTH_TOKEN_KEYS.forEach(key => localStorage.setItem(key, token));
  return token;
}

function storeAuthSession(token, user, encryptedUserId) {
  if (!token) throw new Error('Login response did not contain a session token');
  AUTH_TOKEN_KEYS.forEach(key => localStorage.setItem(key, token));
  storeAuthUser(user, encryptedUserId);
}

function storeAuthUser(user, encryptedUserId) {
  if (!user) return;
  localStorage.setItem('ros2ide_user', JSON.stringify({username:user.username,role:user.role}));
  localStorage.removeItem('user_id');
  if (encryptedUserId) localStorage.setItem('encrypted_user_id', encryptedUserId);
}

function clearAuthSession() {
  AUTH_SESSION_KEYS.forEach(key => localStorage.removeItem(key));
}

function authHeaders(token = getAuthToken()) {
  return token ? { 'x-auth-token': token, Authorization: `Bearer ${token}` } : {};
}
