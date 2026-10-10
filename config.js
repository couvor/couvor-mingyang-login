'use strict';

const path = require('path');

// 腾讯云服务配置（SES 邮件推送 + SMS 短信），供下方 tencent 与 mfa 共用，避免对象字面量内部自引用。
// 密钥与资源 ID 一律从环境变量（/etc/loginapp.env）读取，绝不写入代码或日志。
function buildTencent() {
  const secretId = (process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = (process.env.TENCENT_SECRET_KEY || '').trim();
  const smsSdkAppId = (process.env.TENCENT_SMS_SDK_APP_ID || '').trim();
  const smsSign = (process.env.TENCENT_SMS_SIGN || '').trim();
  const smsTemplateId = (process.env.TENCENT_SMS_TEMPLATE_ID || '').trim();
  const sesFromAddress = (process.env.TENCENT_SES_FROM_ADDRESS || '').trim();

  const hasCredential = !!secretId && !!secretKey;
  // 短信要齐全（应用、签名、模板）才视为可用
  const smsConfigured = hasCredential && !!smsSdkAppId && !!smsSign && !!smsTemplateId;
  // 邮件只需发信地址（仍需在控制台完成验证/认证，否则 SendEmail 会报 NoSuchSender）
  const sesConfigured = hasCredential && !!sesFromAddress;

  return {
    secretId,
    secretKey,
    sms: {
      sdkAppId: smsSdkAppId,
      signName: smsSign,
      templateId: smsTemplateId,
      region: (process.env.TENCENT_SMS_REGION || 'ap-guangzhou').trim(),
      configured: smsConfigured,
    },
    ses: {
      fromAddress: sesFromAddress,
      region: (process.env.TENCENT_SES_REGION || 'ap-hongkong').trim(),
      configured: sesConfigured,
    },
  };
}
const tencentCfg = buildTencent();

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

  // 腾讯云服务（用于发送 MFA 验证码）：邮件推送 SES + 短信 SMS。
  // 密钥与资源 ID 一律从 /etc/loginapp.env 读取（见 buildTencent / README-DELIVERY.md 第六节）。
  tencent: tencentCfg,

  // 多因素认证（MFA）：TOTP / 邮箱 / 手机 三选一。
  // 邮箱与手机方式依赖外部服务商（腾讯云 SES/SMS，由 lib/notify.js 真实发送验证码）：
  //   - 开发/测试（NODE_ENV=development 或 MOCK_2FA=1）下始终可用，验证码仅打印到服务端控制台；
  //   - 生产环境仅在配置了对应腾讯云服务后才开放，避免用户选了却收不到码而被锁死。
  mfa: (() => {
    const isDevEnv =
      (process.env.NODE_ENV || 'development') === 'development' || process.env.MOCK_2FA === '1';
    return {
      codeTtlMs: 10 * 60 * 1000, // 验证码 10 分钟有效
      emailEnabled: isDevEnv || tencentCfg.ses.configured,
      phoneEnabled: isDevEnv || tencentCfg.sms.configured,
      providers: {
        email: tencentCfg.ses.configured,
        sms: tencentCfg.sms.configured,
      },
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
