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

  // 限频：同 IP+用户名 10 分钟窗口内失败 5 次锁定
  rateLimit: {
    windowMs: 10 * 60 * 1000,
    maxFails: 5,
    // 注册防滥用：同 IP 每小时最多注册数
    registerPerHourPerIp: 5,
  },

  bcryptRounds: 12,
};
