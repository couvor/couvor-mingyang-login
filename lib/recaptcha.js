'use strict';

const config = require('../config');

// 服务端校验 Google reCAPTCHA v2 令牌。
// 校验地址取自 config.recaptcha.verifyUrl（默认 https://www.recaptcha.net/recaptcha/api/siteverify，
// 国内可达；需要时可经 RECAPTCHA_API_HOST 切回 www.google.com）。
// 使用正式 secret 时按官方约定校验；Google 官方测试 secret 下恒通过，便于本地联调。
// 未启用（RECAPTCHA_DISABLED=1）或无令牌时跳过校验（仅影响本地开发，不阻断流程）。
const TEST_SECRET = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';

async function verifyRecaptcha(token, remoteIp) {
  if (!config.recaptcha.enabled) return { ok: true, skipped: true };
  if (!token) {
    // 常见原因：浏览器侧 api.js 加载失败导致挂件未渲染，用户无框可勾即提交
    console.warn('[loginapp] reCAPTCHA 校验失败: missing-token（未收到令牌，多为挂件未渲染/未勾选）');
    return { ok: false, reason: 'missing-token' };
  }
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
    if (!res.ok) {
      console.warn('[loginapp] reCAPTCHA 校验失败: http-' + res.status, 'verifyUrl=' + config.recaptcha.verifyUrl);
      return { ok: false, reason: `http-${res.status}` };
    }
    const data = await res.json();
    if (!data.success) {
      // error-codes 例：invalid-input-response（token 无效/过期/域名不匹配）、timeout-or-duplicate（重复提交）
      console.warn('[loginapp] reCAPTCHA 校验失败: failed, error-codes =', JSON.stringify(data['error-codes'] || []));
      return { ok: false, reason: 'failed', codes: data['error-codes'] };
    }
    // 官方测试 secret 下直接放行（本地联调无需真实交互）
    if (config.recaptcha.secretKey === TEST_SECRET) return { ok: true };
    // 生产环境可在此追加 hostname 校验（data.hostname 应在允许列表内），
    // 当前发码接口仅站内可触达（CSRF + 会话态），暂以 success 为准。
    return { ok: true };
  } catch (err) {
    console.warn('[loginapp] reCAPTCHA 校验失败: network —', err.message, 'verifyUrl=' + config.recaptcha.verifyUrl);
    return { ok: false, reason: `network: ${err.message}` };
  }
}

module.exports = { verifyRecaptcha };
