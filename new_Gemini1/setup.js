// setup.js — Run once after: npm install
// Creates the initial admin using ADMIN_PASSWORD from the environment.
'use strict';
const bcrypt = require('bcrypt');
const mysql  = require('mysql2/promise');

(async () => {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST || 'localhost',
    user:     process.env.DB_USER || 'ros2ide',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ros2ide',
  });

  const initialPassword = process.env.ADMIN_PASSWORD;
  if (!initialPassword || initialPassword.length < 12) throw new Error('Set ADMIN_PASSWORD to at least 12 characters');
  const hash = await bcrypt.hash(initialPassword, 12);
  await db.query("INSERT INTO users (username, password, role) VALUES (?,?,?) ON DUPLICATE KEY UPDATE password=VALUES(password), role='admin'", ['admin', hash, 'admin']);
  console.log('✅ Admin account is ready: admin');
  await db.end();
})().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
