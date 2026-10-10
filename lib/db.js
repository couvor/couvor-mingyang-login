'use strict';

const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  state TEXT NOT NULL DEFAULT 'anonymous', -- anonymous | pending_2fa | setup_2fa | authed
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_fails (
  key TEXT PRIMARY KEY,        -- ip|username
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS register_fails (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

-- SSO（本服务作为 IdP）：注册的客户端应用
CREATE TABLE IF NOT EXISTS sso_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT NOT NULL,   -- sha256(client_secret) 十六进制
  redirect_uris TEXT NOT NULL         -- 逗号分隔的回调白名单（精确匹配）
);

-- SSO 一次性票据：60 秒有效、用后即焚
CREATE TABLE IF NOT EXISTS sso_tickets (
  ticket TEXT PRIMARY KEY,            -- 32 字节随机数的 hex
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`);

const nowIso = () => new Date().toISOString();

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  // 顺带清理过期限频窗口与已过期 SSO 票据
  db.prepare('DELETE FROM login_fails WHERE window_start < ?').run(
    new Date(Date.now() - config.rateLimit.windowMs * 2).toISOString()
  );
  db.prepare('DELETE FROM register_fails WHERE window_start < ?').run(
    new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  );
  db.prepare('DELETE FROM sso_tickets WHERE expires_at < ?').run(
    new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  );
}

module.exports = { db, nowIso, cleanupExpiredSessions };
