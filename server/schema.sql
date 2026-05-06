SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(60) NOT NULL,
  avatar_color VARCHAR(7) NOT NULL DEFAULT '#00d4ff',
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  is_banned TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_token (token_hash),
  KEY idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS streams (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  host_id INT UNSIGNED NOT NULL,
  room_code VARCHAR(12) NOT NULL,
  title VARCHAR(120) NOT NULL DEFAULT 'Live Stream',
  description TEXT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  is_live TINYINT(1) NOT NULL DEFAULT 0,
  allow_guest_cam TINYINT(1) NOT NULL DEFAULT 1,
  allow_guest_mic TINYINT(1) NOT NULL DEFAULT 1,
  allow_guest_screen TINYINT(1) NOT NULL DEFAULT 0,
  allow_chat TINYINT(1) NOT NULL DEFAULT 1,
  max_guests SMALLINT NOT NULL DEFAULT 50,
  source_type ENUM('file','screen','cam') NOT NULL DEFAULT 'screen',
  thumbnail_url VARCHAR(500) NULL,
  viewer_count INT UNSIGNED NOT NULL DEFAULT 0,
  peak_viewers INT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_room_code (room_code),
  KEY idx_host (host_id),
  KEY idx_live (is_live),
  KEY idx_public (is_public),
  FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_guests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NULL,
  peer_id VARCHAR(20) NOT NULL,
  display_name VARCHAR(60) NOT NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at DATETIME NULL,
  kicked_at DATETIME NULL,
  kicked_reason VARCHAR(255) NULL,
  is_muted_by_host TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_stream (stream_id),
  FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_snapshots (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_id INT UNSIGNED NOT NULL,
  filename VARCHAR(255) NOT NULL,
  taken_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chat_messages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NULL,
  peer_id VARCHAR(20) NOT NULL,
  display_name VARCHAR(60) NOT NULL,
  message TEXT NOT NULL,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stream_chat (stream_id, created_at),
  FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_id INT UNSIGNED NOT NULL,
  payer_id INT UNSIGNED NULL,
  amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  provider VARCHAR(20) NULL,
  provider_ref VARCHAR(255) NULL,
  status ENUM('pending','completed','refunded','failed') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id INT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  target_type VARCHAR(30) NULL,
  target_id INT UNSIGNED NULL,
  detail TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_admin (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default admin: admin@watch.relay.media / Admin1234! (CHANGE IMMEDIATELY)
INSERT IGNORE INTO users (email, password_hash, display_name, role)
VALUES ('admin@watch.relay.media',
        '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj4oI0RCgPdm',
        'Admin', 'admin');
