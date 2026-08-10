-- ROS2 IDE Database Schema
-- Run: mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS ros2ide CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ros2ide;

-- ── Users ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(64) NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,  -- bcrypt hash
  role        ENUM('admin','user') DEFAULT 'user',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login  DATETIME
);

-- ── Robots ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS robots (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  robot_key     VARCHAR(40) NOT NULL UNIQUE,   -- UUID gen'd by install script
  name          VARCHAR(128) NOT NULL,
  ssh_user      VARCHAR(64) DEFAULT 'ubuntu',
  ssh_pass      VARCHAR(255),               -- encrypted
  workspace     VARCHAR(255) DEFAULT '~/ros2_ws',
  description   VARCHAR(512),
  added_by      INT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ── Sessions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token       CHAR(64) NOT NULL PRIMARY KEY,
  user_id     INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Robot Connection Log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS robot_connections (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  robot_id    INT NOT NULL,
  user_id     INT,
  connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  disconnected_at DATETIME,
  FOREIGN KEY (robot_id) REFERENCES robots(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE SET NULL
);

-- Create the initial admin with: ADMIN_PASSWORD='<strong password>' npm run setup
