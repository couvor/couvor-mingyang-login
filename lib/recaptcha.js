'use strict';

const config = require('../config');

// 服务端校验 Google reCAPTCHA v2 令牌（www.google.com/recaptcha/api/siteverify）。
// 使用正式 secret 时按官方约定校验；Google 官方测试 secret 下恒通过，便于本地联调。
// 未启用（RECAPTCHA_DISABLED=1）或无令牌时跳过校验（仅影响本地开发，不阻断流程）。
const TEST_SECRET = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';

async function verifyRecaptcha(token, remoteIp) {
  if (!config.recaptcha.enabled) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing-token' };
  try {
    const body = new URLSearchParams({
      secret: config.recaptcha.secretKey,
      response: token,
    });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(config.recaptcha.verifyUrl, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
      // 发码接口会被高频调用，禁用缓存避免陈旧响应
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const data = await res.json();
    if (!data.success) {
      return { ok: false, reason: 'failed', codes: data['error-codes'] };
    }
    // 官方测试 secret 下直接放行（本地联调无需真实交互）
    if (config.recaptcha.secretKey === TEST_SECRET) return { ok: true };
    // 生产环境可在此追加 hostname 校验（data.hostname 应在允许列表内），
    // 当前发码接口仅站内可触达（CSRF + 会话态），暂以 success 为准。
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `network: ${err.message}` };
  }
}

module.exports = { verifyRecaptcha };
