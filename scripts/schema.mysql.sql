-- 明旸统一登录（loginapp）MySQL 表结构
-- 由 lib/db.js 在启动时执行（CREATE TABLE IF NOT EXISTS，幂等）。
-- 约定：
--   1) 时间列一律 VARCHAR(32) 存 ISO-8601 UTC 字符串（如 2026-10-20T11:08:01.123Z）。
--      代码里大量比较是「字符串比大小」（expires_at < nowIso()），定宽 ISO 串的字典序等价于时间序，
--      改成 DATETIME 会波及全站且没有收益，故保持原样。
--   2) 布尔用 TINYINT(1)，取值 0/1。
--   3) login_fails 的原列名 key 是 MySQL 保留字，改名 lock_key。

CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  totp_secret VARCHAR(64) NULL,
  totp_enabled TINYINT NOT NULL DEFAULT 0,
  recovery_codes TEXT NULL,
  created_at VARCHAR(32) NOT NULL,
  last_login_at VARCHAR(32) NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  email_verified TINYINT NOT NULL DEFAULT 0,
  phone_verified TINYINT NOT NULL DEFAULT 0,
  mfa_method VARCHAR(16) NULL,
  email_code_hash VARCHAR(128) NULL,
  phone_code_hash VARCHAR(128) NULL,
  email_code_expires VARCHAR(32) NULL,
  phone_code_expires VARCHAR(32) NULL,
  avatar_url VARCHAR(500) NULL,
  avatar_key VARCHAR(300) NULL,
  avatar_updated_at VARCHAR(32) NULL,
  reset_code_hash VARCHAR(128) NULL,
  reset_code_expires VARCHAR(32) NULL,
  force_password_change TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_username (username),
  KEY idx_users_email (email),
  KEY idx_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(64) NOT NULL,
  user_id INT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'anonymous',
  csrf_token CHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  mfa_method VARCHAR(16) NULL,
  reset_user_id INT NULL,
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_fails (
  lock_key VARCHAR(255) NOT NULL,
  fails INT NOT NULL DEFAULT 0,
  locked_until VARCHAR(32) NULL,
  window_start VARCHAR(32) NOT NULL,
  PRIMARY KEY (lock_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS register_fails (
  ip VARCHAR(64) NOT NULL,
  cnt INT NOT NULL DEFAULT 0,
  window_start VARCHAR(32) NOT NULL,
  PRIMARY KEY (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sso_clients (
  client_id VARCHAR(64) NOT NULL,
  client_secret_hash CHAR(64) NOT NULL,
  redirect_uris TEXT NOT NULL,
  PRIMARY KEY (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sso_tickets (
  ticket CHAR(64) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  redirect_uri VARCHAR(500) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  used TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket),
  KEY idx_tickets_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
