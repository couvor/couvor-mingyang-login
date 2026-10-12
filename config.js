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

  // Google reCAPTCHA v2（仅用于邮箱 / 手机验证码重发等会消耗外部资源的人机校验）。
  // 密钥从 /etc/loginapp.env（systemd EnvironmentFile）读取：
  //   RECAPTCHA_SITE_KEY / RECAPTCHA_SECRET_KEY
  // secret 未填（占位符/为空）时回退到 Google 官方测试密钥对，验证恒通过，保证本地联调；
  // 填入真实 secret 后正式密钥原子生效。secret 属于机密，不得写入代码或日志。
  // 设为 RECAPTCHA_DISABLED=1 可完全关闭（与 turnstile 一致）。
  //
  // 国内访问：google.com 被墙，前端脚本与本站（腾讯云轻量，位于大陆）的服务端校验都会超时/失败。
  // 故默认使用 Google 官方备用域名 RECAPTCHA_API_HOST=www.recaptcha.net（同一套密钥，
  // 仅换主机名），脚本加载与服务端 siteverify 在国内均可达。需要切回 google 时
  // 在 /etc/loginapp.env 设 RECAPTCHA_API_HOST=www.google.com 即可。
  recaptcha: (() => {
    const TEST = {
      siteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
      secretKey: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
    };
    const envSite = (process.env.RECAPTCHA_SITE_KEY || '').trim();
    const envSecret = (process.env.RECAPTCHA_SECRET_KEY || '').trim();
    const secretIsPlaceholder = !envSecret || envSecret.includes('__REPLACE_ME__');
    const live = !!envSite && !secretIsPlaceholder;
    const apiHost = (process.env.RECAPTCHA_API_HOST || 'www.recaptcha.net').trim();
    return {
      siteKey: live ? envSite : TEST.siteKey,
      secretKey: live ? envSecret : TEST.secretKey,
      live,
      apiHost,
      // 校验接口与脚本同域，确保服务端（大陆）出网也走可达的 recaptcha.net
      verifyUrl: `https://${apiHost}/recaptcha/api/siteverify`,
      enabled: process.env.RECAPTCHA_DISABLED !== '1',
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

  // 管理员重置密码端点（/admin/api/reset-password）的共享令牌。
  // 由学桥运营后台经 127.0.0.1 直连调用；令牌仅存 /etc/loginapp.env，绝不进代码或日志。
  adminApiToken: (process.env.ADMIN_API_TOKEN || '').trim(),

  // 头像（用户自行上传）：默认存腾讯云 COS，未配置桶时回退服务器本地文件。
  // 环境变量（/etc/loginapp.env，写入后 systemctl restart loginapp）：
  //   COS_BUCKET            桶名，形如 avatar-1250000000（**必须带 AppId 后缀**）
  //   COS_REGION            桶地域，默认 ap-guangzhou
  //   COS_SECRET_ID / COS_SECRET_KEY   可选，默认复用 TENCENT_SECRET_ID / TENCENT_SECRET_KEY，
  //                        建议单独给头像桶建一把最小权限密钥（只需 cos:PutObject / DeleteObject）
  //   COS_PUBLIC_BASE_URL   可选，自定义 CDN 域名，形如 https://avatar.mingyanginfo.com
  //   AVATAR_LOCAL_DIR      可选，回退存储目录，默认 /var/lib/loginapp/avatars
  // 桶的创建、权限、跨域等**一律在腾讯云控制台完成**，代码不自动创建任何云资源。
  avatar: (() => {
    const envVal = (k) => {
      const v = (process.env[k] || '').trim();
      return !v || v.includes('__REPLACE_ME__') ? '' : v;
    };
    const bucket = envVal('COS_BUCKET');
    const region = envVal('COS_REGION') || 'ap-guangzhou';
    // 未单独配置时复用腾讯云通用密钥（SES / SMS 同用的一对）
    const secretId = envVal('COS_SECRET_ID') || envVal('TENCENT_SECRET_ID');
    const secretKey = envVal('COS_SECRET_KEY') || envVal('TENCENT_SECRET_KEY');
    const cdnBase = envVal('COS_PUBLIC_BASE_URL').replace(/\/+$/, '');
    const configured = !!bucket && !!secretId && !!secretKey;
    const backend = configured ? 'cos' : 'local';
    const publicBase =
      backend === 'cos' ? cdnBase || `https://${bucket}.cos.${region}.myqcloud.com` : '';
    return {
      backend, // cos | local
      bucket,
      region,
      secretId, // 机密：仅内部使用，禁止写入日志
      secretKey, // 机密：仅内部使用，禁止写入日志
      publicBase,
      configured,
      // 输出规    configured,
    // 对象级 ACL：桶整体保持私有（最小权限），仅对头像对象单独开公有读，
    // 这样桶内其它前缀（如 tutor-materials/）不会被公开。
    // 可用 COS_OBJECT_ACL 覆盖：设为 inherit 则跟随桶 ACL（适合桶整体公有读的旧方案）。
    // 注意：若桶在控制台开启了「阻止公有访问」，对象级 public-read 不生效，匿名读取会 403。
    objectAcl: envVal('COS_OBJECT_ACL') || 'public-read',
    // 输出规格：统一裁剪为正方形并转 WebP，控制体积与加载速度
      size: 256,
      maxBytes: 5 * 1024 * 1024, // 上传上限 5MB
      allowedFormats: ['jpeg', 'png', 'webp', 'gif', 'avif'],
      // 每用户每小时上传次数（内存计数，重启即清零，够挡误触与脚本刷子）
      perHourPerUser: 20,
      localDir: envVal('AVATAR_LOCAL_DIR') || '/var/lib/loginapp/avatars',
    };
  })(),
};
