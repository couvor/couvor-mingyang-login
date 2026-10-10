'use strict';

const config = require('../config');

// 服务端校验 Cloudflare Turnstile 令牌（challenges.cloudflare.com siteverify）。
// 使用正式 secret 时强制校验 action 与表单来源一致（官方 spin 流程建议）；
// 官方测试 secret 下放宽，便于本地联调。
const TEST_SECRET = '1x0000000000000000000000000000000AA';

async function verifyTurnstile(token, remoteIp, expectedAction) {
  if (!config.turnstile.enabled) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing-token' };
  try {
    const body = new URLSearchParams({
      secret: config.turnstile.secretKey,
      response: token,
    });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(config.turnstile.verifyUrl, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const data = await res.json();
    if (!data.success) return { ok: false, reason: 'failed', codes: data['error-codes'] };
    const isTestSecret = config.turnstile.secretKey === TEST_SECRET;
    if (expectedAction && !isTestSecret && data.action !== expectedAction) {
      return { ok: false, reason: `action-mismatch:${data.action}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `network: ${err.message}` };
  }
}

module.exports = { verifyTurnstile };
