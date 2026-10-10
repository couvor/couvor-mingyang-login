'use strict';

const crypto = require('crypto');
const { db, nowIso } = require('./db');
const config = require('../config');

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(req) {
  const id = newToken();
  const expires = new Date(Date.now() + config.session.ttlMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, state, csrf_token, created_at, expires_at, ip, user_agent)
     VALUES (?, 'anonymous', ?, ?, ?, ?, ?)`
  ).run(id, newToken(), nowIso(), expires, req.ip || '', (req.headers['user-agent'] || '').slice(0, 200));
  return getSession(id);
}

function getSession(id) {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  // 滑动过期
  const expires = new Date(Date.now() + config.session.ttlMs).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expires, id);
  if (row.user_id != null) {
    row.user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) || null;
  }
  return row;
}

// 登录态切换后轮换 session id，防固定攻击；data 为要保留的字段
function rotateSession(oldId, { userId = null, state = 'anonymous' } = {}) {
  const old = getSession(oldId);
  const id = newToken();
  const expires = new Date(Date.now() + config.session.ttlMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, state, csrf_token, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    state,
    old ? old.csrf_token : newToken(),
    nowIso(),
    expires,
    old ? old.ip : '',
    old ? old.user_agent : ''
  );
  if (oldId) db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId);
  return getSession(id);
}

function destroySession(id) {
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function setSessionCookie(res, id) {
  const parts = [
    `${config.session.cookieName}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(config.session.ttlMs / 1000)}`,
  ];
  if (config.session.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${config.session.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

module.exports = {
  createSession,
  getSession,
  rotateSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
};
