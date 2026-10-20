'use strict';

// 邮箱 / 手机 验证码（6 位数字）的生成、入库与校验。
// TOTP 走 lib/totp.js，这里只管「一次性码」类方式。
// 验证码以 SHA-256 哈希落库，并带 10 分钟过期；明文仅在 dev 模式回显，绝不以明文入库。
// 注：数据库为 MySQL（2026-10-20 起），所有读写均为异步，调用处需 await。

const crypto = require('crypto');
const { db, nowIso } = require('./db');
const { isDev, sendVerificationEmail, sendVerificationSms, sendPasswordResetEmail } = require('./notify');

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
  await db
    .prepare(`UPDATE users SET ${colHash(method)} = ?, ${colExp(method)} = ? WHERE id = ?`)
    .run(hashCode(code), expires, user.id);
  const r =
    method === 'email'
      ? await sendVerificationEmail(user.email, code)
      : await sendVerificationSms(user.phone, code);
  // 生产环境若实际未送达（配置缺失/服务商拒绝），抛错让路由提示"发送失败"，
  // 避免用户在收不到码的情况下被静默锁死在验证页。
  if (!isDev() && !r.delivered) {
    throw new Error(`verification ${method} send failed`);
  }
  return { devCode: isDev() ? code : null };
}

// 校验用户输入是否匹配且未过期。不走消费（同一码在过期前可多次尝试/重发会覆盖）。
async function verifyCode(method, userId, input) {
  const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!fresh) return false;
  const hash = fresh[colHash(method)];
  const exp = fresh[colExp(method)];
  if (!hash || !exp) return false;
  if (exp < nowIso()) return false;
  const clean = String(input || '').trim();
  if (!/^\d{6}$/.test(clean)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashCode(clean)));
}

// 是否存在未过期验证码（供发码页判断「已发 / 未发」状态，只查库不发送）。
async function hasValidCode(method, userId) {
  const u = await db
    .prepare(`SELECT ${colHash(method)} AS h, ${colExp(method)} AS e FROM users WHERE id = ?`)
    .get(userId);
  return !!(u && u.h && u.e && u.e >= nowIso());
}

// 验证成功后清空该方式的待核验码。
async function consumeCode(method, userId) {
  await db
    .prepare(`UPDATE users SET ${colHash(method)} = NULL, ${colExp(method)} = NULL WHERE id = ?`)
    .run(userId);
}

// 忘记密码：独立重置验证码（存 reset_code_hash / reset_code_expires，10 分钟 TTL）。
// 仅走邮箱（所有已注册用户都有已验证邮箱），与登录/绑定的 email_code_* 互不干扰。
const colResetHash = 'reset_code_hash';
const colResetExp = 'reset_code_expires';

async function issueResetCode(user) {
  const code = generateSixDigitCode();
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await db
    .prepare(`UPDATE users SET ${colResetHash} = ?, ${colResetExp} = ? WHERE id = ?`)
    .run(hashCode(code), expires, user.id);
  const r = await sendPasswordResetEmail(user.email, code);
  // 生产环境若实际未送达（配置缺失/服务商拒绝），抛错让路由提示"发送失败"
  if (!isDev() && !r.delivered) {
    throw new Error('reset email send failed');
  }
  return { devCode: isDev() ? code : null };
}

async function verifyResetCode(userId, input) {
  const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!fresh) return false;
  const hash = fresh[colResetHash];
  const exp = fresh[colResetExp];
  if (!hash || !exp) return false;
  if (exp < nowIso()) return false;
  const clean = String(input || '').trim();
  if (!/^\d{6}$/.test(clean)) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashCode(clean)));
}

async function hasValidResetCode(userId) {
  const u = await db
    .prepare(`SELECT ${colResetHash} AS h, ${colResetExp} AS e FROM users WHERE id = ?`)
    .get(userId);
  return !!(u && u.h && u.e && u.e >= nowIso());
}

async function consumeResetCode(userId) {
  await db
    .prepare(`UPDATE users SET ${colResetHash} = NULL, ${colResetExp} = NULL WHERE id = ?`)
    .run(userId);
}

module.exports = {
  generateSixDigitCode,
  issueCode,
  verifyCode,
  consumeCode,
  hasValidCode,
  CODE_TTL_MS,
  issueResetCode,
  verifyResetCode,
  hasValidResetCode,
  consumeResetCode,
};
