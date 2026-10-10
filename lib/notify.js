'use strict';

// 验证消息发送：邮件（腾讯云 SES 邮件推送）/ 短信（腾讯云 SMS）。
//
// 开发/测试环境（NODE_ENV=development 或 MOCK_2FA=1）下不真正外发，
// 而是把验证码打印到服务端控制台，便于本地预览与冒烟测试（页面也会回显）。
//
// 生产环境通过腾讯云 SDK 真实外发：
//   - 短信走 SMS SendSms；邮件走 SES SendEmail（Simple，base64 编码的 HTML/Text）。
//   - 仅在 /etc/loginapp.env 配齐对应密钥与资源后才启用（见 config.js 的 tencent 配置、
//     README-DELIVERY.md 第六节的腾讯云控制台准备步骤）。
//   - 任何配置缺失或调用异常都会优雅降级：打印告警并返回 delivered:false，
//     调用方（lib/mfa.js）据此提示"验证码发送失败"，避免用户被静默锁死。
//
// 密钥与资源 ID 一律走环境变量，绝不写入代码或日志。

const config = require('../config');

function isDev() {
  return config.env === 'development' || process.env.MOCK_2FA === '1';
}

// 腾讯云 SDK 客户端懒加载并缓存：未配置/未安装时不强依赖，dev 与降级路径不受影响。
let _smsClient = null;
let _sesClient = null;

function getSmsClient() {
  if (_smsClient) return _smsClient;
  const tencentcloud = require('tencentcloud-sdk-nodejs-sms');
  const SmsClient = tencentcloud.sms.v20210111.Client;
  _smsClient = new SmsClient({
    credential: { secretId: config.tencent.secretId, secretKey: config.tencent.secretKey },
    region: config.tencent.sms.region,
    profile: {
      httpProfile: {
        endpoint: 'sms.tencentcloudapi.com',
        reqTimeout: 10,
      },
    },
  });
  return _smsClient;
}

function getSesClient() {
  if (_sesClient) return _sesClient;
  const tencentcloud = require('tencentcloud-sdk-nodejs-ses');
  const SesClient = tencentcloud.ses.v20201002.Client;
  _sesClient = new SesClient({
    credential: { secretId: config.tencent.secretId, secretKey: config.tencent.secretKey },
    region: config.tencent.ses.region,
    profile: {
      httpProfile: {
        endpoint: 'ses.tencentcloudapi.com',
        reqTimeout: 10,
      },
    },
  });
  return _sesClient;
}

// 短信模板参数顺序：默认 [验证码, 有效分钟数]，可用 TENCENT_SMS_TEMPLATE_PARAMS
// 以逗号分隔覆盖，占位符 CODE=验证码、MINUTES=有效分钟数（其余原样）。
function smsTemplateParams(code, minutes) {
  const raw = (process.env.TENCENT_SMS_TEMPLATE_PARAMS || 'CODE,MINUTES').trim();
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t === 'CODE' ? String(code) : t === 'MINUTES' ? String(minutes) : t));
}

// 中国大陆手机号 → E.164（+86...）；已带 + 则原样。
function toE164(phone) {
  const s = String(phone || '').trim();
  return s.startsWith('+') ? s : `+86${s}`;
}

function buildEmailHtml(code, minutes) {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>',
    '<body style="margin:0;padding:24px;background:#f4f6fb;font-family:-apple-system,Segoe UI,Noto Sans SC,sans-serif;">',
    '<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e6e9f2;border-radius:14px;overflow:hidden;">',
    '<div style="background:#0d1117;padding:20px 24px;">',
    '<span style="color:#ffffff;font-size:16px;font-weight:600;">明旸信息 · 登录验证码</span>',
    '</div>',
    '<div style="padding:28px 24px;">',
    `<p style="margin:0 0 16px;color:#1f2430;font-size:15px;line-height:1.7;">您好，您正在登录明旸信息账号。本次验证码为：</p>`,
    `<div style="margin:0 0 18px;padding:16px 20px;background:#f0f5ff;border:1px solid #d6e2ff;border-radius:10px;`,
    `text-align:center;font-size:30px;letter-spacing:6px;color:#1d67ea;font-weight:700;">${code}</div>`,
    `<p style="margin:0 0 8px;color:#5a6172;font-size:13px;line-height:1.7;">该验证码 ${minutes} 分钟内有效。请勿将验证码告知他人，明旸信息不会向您索取此信息。</p>`,
    '<p style="margin:0;color:#9aa1b1;font-size:12px;line-height:1.7;">如非本人操作，请忽略本邮件。</p>',
    '</div>',
    '<div style="padding:14px 24px;background:#fafbfe;border-top:1px solid #eef1f7;">',
    '<span style="color:#9aa1b1;font-size:12px;">西安明旸信息技术有限公司</span>',
    '</div>',
    '</div></body></html>',
  ].join('');
}

function buildEmailText(code, minutes) {
  return `【明旸信息】您正在登录账号，本次验证码为 ${code}，请在 ${minutes} 分钟内使用。如非本人操作请忽略本邮件。`;
}

async function sendVerificationEmail(email, code) {
  if (isDev()) {
    console.log(`[mock-email] → ${email} 验证码：${code}（${Math.round(config.mfa.codeTtlMs / 60000)} 分钟内有效）`);
    return { delivered: true, mock: true };
  }
  if (!config.tencent.ses.configured) {
    console.warn('[notify] 未配置腾讯云 SES（缺密钥或发信地址），邮件验证码未发送：', email);
    return { delivered: false };
  }
  const minutes = Math.round(config.mfa.codeTtlMs / 60000);
  try {
    const client = getSesClient();
    const resp = await client.SendEmail({
      FromEmailAddress: config.tencent.ses.fromAddress,
      Destination: [email],
      ReplyToAddresses: config.tencent.ses.fromAddress,
      Subject: '【明旸信息】登录验证码',
      TriggerType: 1, // 触发类：验证码等即时发送
      Unsubscribe: '0', // 不含退订链接
      Simple: {
        Html: Buffer.from(buildEmailHtml(code, minutes)).toString('base64'),
        Text: Buffer.from(buildEmailText(code, minutes)).toString('base64'),
      },
    });
    console.log('[notify] SES 邮件已发送：', email, 'MessageId=', resp && resp.MessageId);
    return { delivered: true };
  } catch (e) {
    console.error('[notify] SES 邮件发送失败：', e && e.message);
    return { delivered: false };
  }
}

async function sendVerificationSms(phone, code) {
  if (isDev()) {
    console.log(`[mock-sms] → ${phone} 验证码：${code}（${Math.round(config.mfa.codeTtlMs / 60000)} 分钟内有效）`);
    return { delivered: true, mock: true };
  }
  if (!config.tencent.sms.configured) {
    console.warn('[notify] 未配置腾讯云 SMS（缺密钥/应用/签名/模板），短信验证码未发送：', phone);
    return { delivered: false };
  }
  const minutes = Math.round(config.mfa.codeTtlMs / 60000);
  try {
    const client = getSmsClient();
    const resp = await client.SendSms({
      PhoneNumberSet: [toE164(phone)],
      SmsSdkAppId: config.tencent.sms.sdkAppId,
      SignName: config.tencent.sms.signName,
      TemplateId: config.tencent.sms.templateId,
      TemplateParamSet: smsTemplateParams(code, minutes),
    });
    // 腾讯云对每条号码返回 SendStatus；任意一条非 Ok 即视为本次发送失败。
    const set = (resp && resp.SendStatusSet) || [];
    const bad = set.find((s) => s && s.Code !== 'Ok');
    if (bad) {
      console.error('[notify] SMS 发送被拒：', phone, bad.Code, bad.Message);
      return { delivered: false };
    }
    console.log('[notify] SMS 已发送：', phone);
    return { delivered: true };
  } catch (e) {
    console.error('[notify] SMS 发送失败：', e && e.message);
    return { delivered: false };
  }
}

module.exports = {
  isDev,
  sendVerificationEmail,
  sendVerificationSms,
  // 供配置自检 / 日志使用
  smsConfigured: () => config.tencent.sms.configured,
  emailConfigured: () => config.tencent.ses.configured,
};
