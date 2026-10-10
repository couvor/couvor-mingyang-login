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
const verifyEmailTemplate = require('./verifyEmailTemplate');

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

// 邮件通道二：SES 的 SMTP 发送。不需要 CAM 密钥，直接用发信地址 + SMTP 密码
// 连接 smtp.qcloudmail.com（465 隐式 SSL / 587 STARTTLS）。同样懒加载并缓存。
let _mailer = null;

function getMailer() {
  if (_mailer) return _mailer;
  const nodemailer = require('nodemailer');
  const s = config.tencent.ses.smtp;
  _mailer = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure, // 465 隐式 SSL；587/25 为 false，由 nodemailer 自动 STARTTLS 升级
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return _mailer;
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

// 验证码邮件正文（HTML）。样式见 lib/verifyEmailTemplate.js（明旸信息设计规范）。
// 注意：SES 模板发送时正文由控制台里的模板决定，这里的内容只在 SMTP 通道 /
// 本地预览下生效；若改用模板发送，请把同一份 HTML 上传到控制台模板。
function buildEmailHtml(code, minutes, email) {
  return verifyEmailTemplate.renderVerifyEmail({
    code,
    minutes,
    email,
    // 发送时没有请求上下文，IP 与时间戳留空 → 模板自动省略这两行
    ip: '',
    time: '',
  });
}

function buildEmailText(code, minutes) {
  return `【明旸信息】您正在登录账号，本次验证码为 ${code}，请在 ${minutes} 分钟内使用。如非本人操作请忽略本邮件。`;
}

// 北京时间（GMT+8）时间戳，用于模板里的 REQUEST AT 一栏。
function nowGMT8() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (GMT+8)`;
}

// SES 模板发送的变量值。控制台模板正文里的变量写作 {{code}} / {{minutes}} /
// {{email}} / {{time}}，这里按 config.tencent.ses.templateVars 的清单拼成
// TemplateData（JSON 字符串）；未在清单里的变量不传，避免多传参数被判格式错误。
function buildTemplateData(code, minutes, email) {
  const values = {
    code: String(code),
    minutes: String(minutes),
    email: String(email || ''),
    time: nowGMT8(),
  };
  const data = {};
  for (const key of config.tencent.ses.templateVars) {
    if (Object.prototype.hasOwnProperty.call(values, key)) data[key] = values[key];
  }
  return JSON.stringify(data);
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

  // 优先走 SMTP 通道（无需 CAM 密钥；密码缺失时 smtp.configured 为 false，自然落到 API 通道）
  if (config.tencent.ses.smtp && config.tencent.ses.smtp.configured) {
    try {
      const fromAddr = config.tencent.ses.smtp.user || config.tencent.ses.fromAddress;
      const info = await getMailer().sendMail({
        from: '"' + config.tencent.ses.fromName + '" <' + fromAddr + '>',
        to: email,
        subject: '【明旸信息】登录验证码',
        text: buildEmailText(code, minutes),
        html: buildEmailHtml(code, minutes, email),
      });
      console.log('[notify] SES SMTP 邮件已发送：', email, 'messageId=', info && info.messageId);
      return { delivered: true };
    } catch (e) {
      console.error('[notify] SES SMTP 邮件发送失败：', e && e.message);
      return { delivered: false };
    }
  }
  try {
    const client = getSesClient();
    const base = {
      FromEmailAddress: config.tencent.ses.fromAddress,
      Destination: [email],
      ReplyToAddresses: config.tencent.ses.fromAddress,
      Subject: '【明旸信息】登录验证码',
      TriggerType: 1, // 触发类：验证码等即时发送
      Unsubscribe: '0', // 不含退订链接
    };

    // 通道一（默认）：模板发送。Simple 字段官方已废弃，默认账号只能用模板。
    const templateId = config.tencent.ses.templateId;
    if (templateId > 0) {
      try {
        const resp = await client.SendEmail({
          ...base,
          Template: {
            TemplateID: templateId,
            TemplateData: buildTemplateData(code, minutes, email),
          },
        });
        console.log('[notify] SES 模板邮件已发送：', email, 'TemplateID=', templateId, 'MessageId=', resp && resp.MessageId);
        return { delivered: true };
      } catch (te) {
        // 模板发送失败就不再回退 Simple 了——默认账号本来就没有自定义内容权限，
        // 回退只会多一条噪音日志；这里把原始错误码完整打出来便于定位。
        console.error('[notify] SES 模板发送失败：', email, te && (te.code || ''), te && te.message);
        return { delivered: false };
      }
    }

    // 通道二：自定义内容（Simple）。仅历史申请过特殊配置的账号可用。
    const resp = await client.SendEmail({
      ...base,
      Simple: {
        Html: Buffer.from(buildEmailHtml(code, minutes, email)).toString('base64'),
        Text: Buffer.from(buildEmailText(code, minutes)).toString('base64'),
      },
    });
    console.log('[notify] SES 邮件已发送：', email, 'MessageId=', resp && resp.MessageId);
    return { delivered: true };
  } catch (e) {
    console.error('[notify] SES 邮件发送失败：', e && (e.code || ''), e && e.message);
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
