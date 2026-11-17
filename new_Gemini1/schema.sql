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
  robot_key     VARCHAR(80) NOT NULL UNIQUE,   -- physical identity / agent key
  name          VARCHAR(128) NOT NULL,
  ssh_user      VARCHAR(64) DEFAULT 'ubuntu',
  ssh_pass      VARCHAR(255),               -- encrypted
  workspace     VARCHAR(255) DEFAULT '~/ros2_ws',
  description   VARCHAR(512),
  agent_version VARCHAR(32),             -- last version reported by a physical Agent
  cluster_id    INT NULL,                 -- Sim placement; NULL for physical robots
  added_by      INT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
);

-- A real robot stays canonical in `robots`, while more than one account can
-- add it to their own team. Simulation keys remain private at API level.
CREATE TABLE IF NOT EXISTS robot_user_access (
  robot_id    INT NOT NULL,
  user_id     INT NOT NULL,
  alias       VARCHAR(128),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (robot_id, user_id),
  INDEX idx_robot_access_user_created (user_id, created_at, robot_id),
  FOREIGN KEY (robot_id) REFERENCES robots(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- The Master remains a Sim host (id=1). Worker keys identify a registered
-- host; user authorization is always checked against cluster_user_access.
CREATE TABLE IF NOT EXISTS clusters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cluster_key VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  kind ENUM('master','worker') NOT NULL DEFAULT 'worker',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  max_users INT NOT NULL DEFAULT 20,
  max_sims INT NOT NULL DEFAULT 2,
  secret_hash CHAR(64),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cluster_user_access (
  cluster_id INT NOT NULL,
  user_id INT NOT NULL,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(cluster_id,user_id),
  INDEX idx_cluster_user(user_id,cluster_id),
  FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS cluster_sim_leases (
  robot_id INT NOT NULL PRIMARY KEY,
  cluster_id INT NOT NULL,
  lease_token CHAR(48) NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_cluster_sim_capacity(cluster_id,expires_at),
  FOREIGN KEY(robot_id) REFERENCES robots(id) ON DELETE CASCADE,
  FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

-- ── Sessions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token       CHAR(64) NOT NULL PRIMARY KEY,
  user_id     INT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Application catalog ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  slug          VARCHAR(80) NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  description   VARCHAR(512) DEFAULT '',
  category      VARCHAR(100) DEFAULT 'Application',
  icon          VARCHAR(2048) NOT NULL DEFAULT '🚀', -- emoji or HTTPS image URL
  redirect_url  VARCHAR(2048) NOT NULL,
  session_mode  ENUM('none','ticket') NOT NULL DEFAULT 'none',
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order    INT NOT NULL DEFAULT 0,
  created_by    INT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ── Membership & payment webhook ledger ─────────────────────
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id                  INT NOT NULL UNIQUE,
  plan_code                ENUM('pro_monthly','pro_yearly','pro_lifetime') NOT NULL,
  status                   VARCHAR(32) NOT NULL DEFAULT 'active',
  provider                 VARCHAR(32) NOT NULL DEFAULT 'stripe',
  provider_customer_id     VARCHAR(255),
  provider_subscription_id VARCHAR(255) UNIQUE,
  starts_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at               DATETIME,
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payment_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider     VARCHAR(32) NOT NULL,
  event_id     VARCHAR(255) NOT NULL,
  event_type   VARCHAR(128) NOT NULL,
  status       VARCHAR(32) NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME,
  UNIQUE KEY uniq_provider_event (provider,event_id)
);

-- ── Shared Admin Support Chat ────────────────────────────────
CREATE TABLE IF NOT EXISTS support_chat_messages (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  message     VARCHAR(1000) NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_support_chat_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Robot Connection Log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS robot_connections (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  robot_id    INT NOT NULL,
  user_id     INT,
  connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  disconnected_at DATETIME,
  INDEX idx_robot_connections_robot_id (robot_id, id),
  INDEX idx_robot_connections_user_open (user_id, disconnected_at, id),
  FOREIGN KEY (robot_id) REFERENCES robots(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE SET NULL
);

-- Create the initial admin with: ADMIN_PASSWORD='<strong password>' npm run setup
