'use strict';

// 邮箱 / 手机 验证码（6 位数字）的生成、入库与校验。
// TOTP 走 lib/totp.js，这里只管「一次性码」类方式。
// 验证码以 SHA-256 哈希落库，并带 10 分钟过期；明文仅在 dev 模式回显，绝不以明文入库。

const crypto = require('crypto');
const { db, nowIso } = require('./db');
const { isDev, sendVerificationEmail, sendVerificationSms } = require('./notify');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟

function generateSixDigitCode() {
  // 加密安全随机 0–999999，统一补零为 6 位
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code).trim()).digest('hex');

function colHash(method) {
  return method === 'email' ? 'email_code_hash' : 'phone_code_hash';
}
function colExp(method) {
  return method === 'email' ? 'email_code_expires' : 'phone_code_expires';
}

// 生成验证码 → 入库（哈希 + 过期）→ 发送。返回 { devCode }（仅 dev 模式有值）。
async function issueCode(method, user) {
  const code = generateSixDigitCode();
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.prepare(`UPDATE users SET ${colHash(method)} = ?, ${colExp(method)} = ? WHERE id = ?`).run(
    hashCode(code),
    expires,
    user.id
  );
  if (method === 'email') await sendVerificationEmail(user.email, code);
  else await sendVerificationSms(user.phone, code);
  return { devCode: isDev() ? code : null };
}

// 校验用户输入是否匹配且未过期。不走消费（同一码在过期前可多次尝试/重发会覆盖）。
function verifyCode(method, userId, input) {
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!fresh) return false;
  const hash = fresh[colHash(method)];
  const exp = fresh[colExp(method)];
  if (!hash || !exp) return false;
  if (exp < nowIso()) return false;
  const clean = String(input || '').trim();
  if (!/^\d{6}$/.test(clean)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashCode(clean)));
}

// 验证成功后清空该方式的待核验码。
function consumeCode(method, userId) {
  db.prepare(`UPDATE users SET ${colHash(method)} = NULL, ${colExp(method)} = NULL WHERE id = ?`).run(
    userId
  );
}

module.exports = { generateSixDigitCode, issueCode, verifyCode, consumeCode, CODE_TTL_MS };
