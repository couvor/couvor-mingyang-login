'use strict';

const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',

  // 数据库放项目目录外
  dbPath: process.env.DB_PATH || '/var/lib/loginapp/app.db',

  baseUrl: process.env.BASE_URL || 'https://login.mingyanginfo.com',

  // 注册/登录完成后的默认落地页。
  // 有 SSO 待续上下文时优先续接回 /sso/authorize（回客户端站点）；
  // 无上下文（直接访问本站、换了浏览器等）时跳这里——默认直接续接学桥 SSO，
  // 已登录用户会被无缝送入学桥（首登需选身份）。可用环境变量覆盖。
  defaultRedirect:
    process.env.SSO_DEFAULT_REDIRECT || 'https://x.mingyanginfo.com/api/auth/sso/start',

  // Cloudflare Turnstile。
  // 密钥从 /etc/loginapp.env（systemd EnvironmentFile）读取：
  //   TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY
  // secret 未填（占位符/为空）时自动回退到官方测试密钥对，保证验证逻辑自洽；
  // 填入真实 secret 后正式密钥原子生效。secret 属于机密，不得写入代码或日志。
  turnstile: (() => {
    const TEST = {
      siteKey: '1x00000000000000000000AA',
      secretKey: '1x0000000000000000000000000000000AA',
    };
    const envSite = (process.env.TURNSTILE_SITE_KEY || '').trim();
    const envSecret = (process.env.TURNSTILE_SECRET_KEY || '').trim();
    const secretIsPlaceholder = !envSecret || envSecret.includes('__REPLACE_ME__');
    const live = !!envSite && !secretIsPlaceholder;
    return {
      siteKey: live ? envSite : TEST.siteKey,
      secretKey: live ? envSecret : TEST.secretKey,
      live,
      verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      enabled: process.env.TURNSTILE_DISABLED !== '1',
    };
  })(),

  session: {
    cookieName: 'mysid',
    ttlMs: 7 * 24 * 3600 * 1000, // 7 天滑动过期
    secure: process.env.COOKIE_SECURE === '1', // HTTPS 上线后设为 1
  },

  // 多因素认证（MFA）：TOTP / 邮箱 / 手机 三选一。
  // 邮箱与手机方式依赖外部服务商（由 lib/notify.js 真实发送验证码）：
  //   - 开发/测试（NODE_ENV=development 或 MOCK_2FA=1）下始终可用，验证码仅打印到服务端控制台；
  //   - 生产环境仅在配置了对应服务商后才开放，避免用户选了却收不到码而被锁死。
  // 相关环境变量（/etc/loginapp.env）：SMTP_HOST 或 EMAIL_PROVIDER_KEY（邮箱），SMS_PROVIDER_KEY（短信）。
  mfa: (() => {
    const isDevEnv =
      (process.env.NODE_ENV || 'development') === 'development' || process.env.MOCK_2FA === '1';
    const emailProvider = !!(process.env.SMTP_HOST || process.env.EMAIL_PROVIDER_KEY);
    const smsProvider = !!(process.env.SMS_PROVIDER_KEY);
    return {
      codeTtlMs: 10 * 60 * 1000, // 验证码 10 分钟有效
      emailEnabled: isDevEnv || emailProvider,
      phoneEnabled: isDevEnv || smsProvider,
      providers: { email: emailProvider, sms: smsProvider },
    };
  })(),

  // 限频：同 IP+用户名 10 分钟窗口内失败 5 次锁定
  rateLimit: {
    windowMs: 10 * 60 * 1000,
    maxFails: 5,
    // 注册防滥用：同 IP 每小时最多注册数
    registerPerHourPerIp: 5,
  },

  bcryptRounds: 12,
};
