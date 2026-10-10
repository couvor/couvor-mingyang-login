'use strict';

const { db, nowIso } = require('./db');
const config = require('../config');

// 登录限频：key = ip|username（用户名留空时仅按 IP）
function failKey(ip, username) {
  return `${ip}|${(username || '').toLowerCase()}`;
}

function loginLocked(ip, username) {
  const row = db.prepare('SELECT * FROM login_fails WHERE key = ?').get(failKey(ip, username));
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

function recordLoginFail(ip, username) {
  const key = failKey(ip, username);
  const row = db.prepare('SELECT * FROM login_fails WHERE key = ?').get(key);
  const now = Date.now();
  if (!row || now - Date.parse(row.window_start) >= config.rateLimit.windowMs) {
    db.prepare(
      `INSERT INTO login_fails (key, fails, locked_until, window_start) VALUES (?, 1, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET fails = 1, locked_until = NULL, window_start = excluded.window_start`
    ).run(key, nowIso());
    return;
  }
  const fails = row.fails + 1;
  const lockedUntil =
    fails >= config.rateLimit.maxFails
      ? new Date(now + config.rateLimit.windowMs).toISOString()
      : null;
  db.prepare('UPDATE login_fails SET fails = ?, locked_until = ? WHERE key = ?').run(
    fails,
    lockedUntil,
    key
  );
}

function clearLoginFails(ip, username) {
  db.prepare('DELETE FROM login_fails WHERE key = ?').run(failKey(ip, username));
}

// 注册限频：同 IP 每小时最多 registerPerHourPerIp 次
function registerAllowed(ip) {
  const row = db.prepare('SELECT * FROM register_fails WHERE ip = ?').get(ip || '');
  if (!row || Date.now() - Date.parse(row.window_start) >= 3600 * 1000) return true;
  return row.count < config.rateLimit.registerPerHourPerIp;
}

function recordRegister(ip) {
  const row = db.prepare('SELECT * FROM register_fails WHERE ip = ?').get(ip || '');
  if (!row || Date.now() - Date.parse(row.window_start) >= 3600 * 1000) {
    db.prepare(
      `INSERT INTO register_fails (ip, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET count = 1, window_start = excluded.window_start`
    ).run(ip || '', nowIso());
  } else {
    db.prepare('UPDATE register_fails SET count = count + 1 WHERE ip = ?').run(ip || '');
  }
}

module.exports = { loginLocked, recordLoginFail, clearLoginFails, registerAllowed, recordRegister };
