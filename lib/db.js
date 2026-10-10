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

// 注册补充字段迁移（邮箱 / 手机）：已上线库仅 ALTER 追加，不影响旧数据。
// 用 PRAGMA 探列再幂等追加，保证重复启动不报错。
function columnExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === col);
}
if (!columnExists('users', 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
}
if (!columnExists('users', 'phone')) {
  db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
}

// 多因素认证（MFA）方式扩展：TOTP / 邮箱 / 手机 三选一。
// 用三列独立布尔标记各方式是否已验证，并在 mfa_method 记录当前启用的方式；
// 验证码哈希与过期时间单独存列（明文只在 dev 模式回显，不在库里落明文）。
// 兼容旧库：旧版强制 TOTP 用户的 mfa_method 为 NULL，登录时按 totp_enabled 回退为 'totp'。
for (const col of ['email_verified', 'phone_verified']) {
  if (!columnExists('users', col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
}
if (!columnExists('users', 'mfa_method')) {
  db.exec('ALTER TABLE users ADD COLUMN mfa_method TEXT');
}
for (const col of ['email_code_hash', 'phone_code_hash', 'email_code_expires', 'phone_code_expires']) {
  if (!columnExists('users', col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  }
}

// 会话携带本次要校验的二次验证方式（totp|email|phone）：
// 登录通过密码后按用户已启用的方式写入，绑定阶段记录用户选择的方式，
// 使 /2fa 与 /setup-2fa 能渲染对应页面并校验对应的凭证。
if (!columnExists('sessions', 'mfa_method')) {
  db.exec('ALTER TABLE sessions ADD COLUMN mfa_method TEXT');
}

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
