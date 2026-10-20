'use strict';

const { db, nowIso } = require('./db');
const config = require('../config');

// 登录限频：key = ip|username（用户名留空时仅按 IP）
function failKey(ip, username) {
  return `${ip}|${(username || '').toLowerCase()}`;
}

async function loginLocked(ip, username) {
  const row = await db.prepare('SELECT * FROM login_fails WHERE lock_key = ?').get(failKey(ip, username));
  if (!row) return { locked: false, remaining: config.rateLimit.maxFails, retryAfterSec: 0 };
  const windowFresh = Date.now() - Date.parse(row.window_start) < config.rateLimit.windowMs;
  if (row.locked_until && row.locked_until > nowIso()) {
    return {
      locked: true,
      remaining: 0,
      retryAfterSec: Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000),
    };
  }
  const fails = windowFresh ? row.fails : 0;
  return { locked: false, remaining: Math.max(0, config.rateLimit.maxFails - fails), retryAfterSec: 0 };
}

async function recordLoginFail(ip, username) {
  const key = failKey(ip, username);
  const row = await db.prepare('SELECT * FROM login_fails WHERE lock_key = ?').get(key);
  const now = Date.now();
  if (!row || now - Date.parse(row.window_start) >= config.rateLimit.windowMs) {
    // MySQL 的 upsert 写法（原 SQLite 为 ON CONFLICT ... excluded.x）
    await db
      .prepare(
        `INSERT INTO login_fails (lock_key, fails, locked_until, window_start) VALUES (?, 1, NULL, ?)
         ON DUPLICATE KEY UPDATE fails = 1, locked_until = NULL, window_start = VALUES(window_start)`
      )
      .run(key, nowIso());
    return;
  }
  const fails = row.fails + 1;
  const lockedUntil =
    fails >= config.rateLimit.maxFails
      ? new Date(now + config.rateLimit.windowMs).toISOString()
      : null;
  await db
    .prepare('UPDATE login_fails SET fails = ?, locked_until = ? WHERE lock_key = ?')
    .run(fails, lockedUntil, key);
}

async function clearLoginFails(ip, username) {
  await db.prepare('DELETE FROM login_fails WHERE lock_key = ?').run(failKey(ip, username));
}

// 注册限频：同 IP 每小时最多 registerPerHourPerIp 次
async function registerAllowed(ip) {
  const row = await db.prepare('SELECT * FROM register_fails WHERE ip = ?').get(ip || '');
  if (!row || Date.now() - Date.parse(row.window_start) >= 3600 * 1000) return true;
  return row.cnt < config.rateLimit.registerPerHourPerIp;
}

async function recordRegister(ip) {
  const row = await db.prepare('SELECT * FROM register_fails WHERE ip = ?').get(ip || '');
  if (!row || Date.now() - Date.parse(row.window_start) >= 3600 * 1000) {
    await db
      .prepare(
        `INSERT INTO register_fails (ip, cnt, window_start) VALUES (?, 1, ?)
         ON DUPLICATE KEY UPDATE cnt = 1, window_start = VALUES(window_start)`
      )
      .run(ip || '', nowIso());
  } else {
    await db.prepare('UPDATE register_fails SET cnt = cnt + 1 WHERE ip = ?').run(ip || '');
  }
}

module.exports = { loginLocked, recordLoginFail, clearLoginFails, registerAllowed, recordRegister };
