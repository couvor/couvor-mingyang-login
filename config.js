'use strict';

const path = require('path');

// 腾讯云服务配置（SES 邮件推送 + SMS 短信），供下方 tencent 与 mfa 共用，避免对象字面量内部自引用。
// 密钥与资源 ID 一律从环境变量（/etc/loginapp.env）读取，绝不写入代码或日志。
function buildTencent() {
  // 统一取值：空值与 __REPLACE_ME__ 占位符一律视为"未配置"。
  // 否则"看似配好、实际发不出"会让用户被卡在手机/邮箱验证上。
  const envVal = (k) => {
    const v = (process.env[k] || '').trim();
    return !v || v.includes('__REPLACE_ME__') ? '' : v;
  };
  const secretId = envVal('TENCENT_SECRET_ID');
  const secretKey = envVal('TENCENT_SECRET_KEY');
  const smsSdkAppId = envVal('TENCENT_SMS_SDK_APP_ID');
  const smsSign = envVal('TENCENT_SMS_SIGN');
  const smsTemplateId = envVal('TENCENT_SMS_TEMPLATE_ID');
  const sesFromAddress = envVal('TENCENT_SES_FROM_ADDRESS');

  // 邮件通道二：SES 的 SMTP 发送（不需要 CAM 密钥，只需发信地址 + SMTP 密码）。
  // 腾讯云 SES 控制台「发信地址」页可看到 SMTP 服务地址与端口，并单独设置 SMTP 密码。
  //   SES_SMTP_HOST  默认 smtp.qcloudmail.com
  //   SES_SMTP_PORT  465(SSL) / 587(STARTTLS) / 25，默认 465
  //   SES_SMTP_USER  默认取发信地址
  //   SES_SMTP_PASS  SMTP 密码（**机密**，只存 /etc/loginapp.env，绝不进代码或日志）
  const smtpHost = (process.env.SES_SMTP_HOST || 'smtp.qcloudmail.com').trim();
  const smtpPort = parseInt(process.env.SES_SMTP_PORT || '465', 10);
  const smtpUser = (process.env.SES_SMTP_USER || sesFromAddress).trim();
  // 密码不做 trim（首尾空格可能是密码的一部分）；占位符一律视为未配置，
  // 避免"看似配好、实际发不出"把用户锁在邮箱验证上。
  const smtpPassRaw = process.env.SES_SMTP_PASS || '';
  const smtpPassIsPlaceholder = !smtpPassRaw || smtpPassRaw.includes('__REPLACE_ME__');
  const smtpPass = smtpPassIsPlaceholder ? '' : smtpPassRaw;
  const smtpConfigured = !!smtpHost && !!smtpUser && !smtpPassIsPlaceholder;

  const hasCredential = !!secretId && !!secretKey;
  // 短信要齐全（应用、签名、模板）才视为可用
  const smsConfigured = hasCredential && !!smsSdkAppId && !!smsSign && !!smsTemplateId;
  // 邮件模板发送。腾讯云 SES 的 Simple（自定义内容）字段官方已标注废弃，
  // 默认账号只能"模板发送"，否则报 SendStatus 1011 / FailedOperation.WithOutPermission。
  // 在控制台建好模板后，把 TemplateID 填到 TENCENT_SES_TEMPLATE_ID；
  // 模板正文中的变量写作 {{键}}，发送时用 TemplateData 传值（见 lib/notify.js）。
  // 变量清单默认 code,minutes,email，可用 TENCENT_SES_TEMPLATE_VARS 覆盖（逗号分隔）。
  // 注意：部分版本的控制台限制"单发模板只支持一个变量"，若发送报 3010
  // （TemplateData 字段格式不正确），把该变量改成只留 code，其余在模板里写死。
  const sesTemplateId = parseInt(envVal('TENCENT_SES_TEMPLATE_ID') || '0', 10);
  const sesTemplateVars = (process.env.TENCENT_SES_TEMPLATE_VARS || 'code,minutes,email')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 邮件只需发信地址（仍需在控制台完成验证/认证，否则 SendEmail 会报 NoSuchSender）
  const sesApiConfigured = hasCredential && !!sesFromAddress;
  // 邮件整体可用 = SMTP 通道 或 API 通道 任一配齐（SMTP 优先）
  const sesConfigured = smtpConfigured || sesApiConfigured;

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
      fromName: (process.env.SES_FROM_NAME || '明旸信息').trim(),
      mode: smtpConfigured ? 'smtp' : sesApiConfigured ? 'api' : null,
      smtp: {
        host: smtpHost,
        port: Number.isFinite(smtpPort) ? smtpPort : 465,
        // 465 走隐式 SSL；587 / 25 走 STARTTLS（nodemailer 会自动升级）
        secure: (Number.isFinite(smtpPort) ? smtpPort : 465) === 465,
        user: smtpUser,
        pass: smtpPass,
        configured: smtpConfigured,
      },
      region: (process.env.TENCENT_SES_REGION || 'ap-hongkong').trim(),
      templateId: Number.isFinite(sesTemplateId) ? sesTemplateId : 0,
      templateVars: sesTemplateVars,
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
