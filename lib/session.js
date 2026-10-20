'use strict';

const crypto = require('crypto');
const { db, nowIso } = require('./db');
const config = require('../config');

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(req) {
  const id = newToken();
  const expires = new Date(Date.now() + config.session.ttlMs).toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (id, state, csrf_token, created_at, expires_at, ip, user_agent)
       VALUES (?, 'anonymous', ?, ?, ?, ?, ?)`
    )
    .run(id, newToken(), nowIso(), expires, req.ip || '', (req.headers['user-agent'] || '').slice(0, 200));
  return getSession(id);
}

async function getSession(id) {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  // 滑动过期
  const expires = new Date(Date.now() + config.session.ttlMs).toISOString();
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expires, id);
  if (row.user_id != null) {
    row.user = (await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) || null;
  }
  return row;
}

// 登录态切换后轮换 session id，防固定攻击；data 为要保留的字段
async function rotateSession(oldId, { userId = null, state = 'anonymous', mfaMethod = null } = {}) {
  const old = await getSession(oldId);
  const id = newToken();
  const expires = new Date(Date.now() + config.session.ttlMs).toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, state, mfa_method, csrf_token, created_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      state,
      mfaMethod,
      old ? old.csrf_token : newToken(),
      nowIso(),
      expires,
      old ? old.ip : '',
      old ? old.user_agent : ''
    );
  if (oldId) await db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId);
  return getSession(id);
}

async function destroySession(id) {
  if (id) await db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
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
