'use strict';

// 验证消息发送：邮件 / 短信。
// 开发/测试环境（NODE_ENV=development 或 MOCK_2FA=1）下不真正外发，
// 而是把验证码打印到服务端控制台，便于本地预览与冒烟测试。
// 生产环境请在此接入真实服务商（见 TODO），未接入时仅告警不阻断。

const config = require('../config');

function isDev() {
  return config.env === 'development' || process.env.MOCK_2FA === '1';
}

async function sendVerificationEmail(email, code) {
  if (isDev()) {
    console.log(`[mock-email] → ${email} 验证码：${code}（10 分钟内有效）`);
    return { delivered: true, mock: true };
  }
  // TODO(prod): 接入邮件服务商（如 SendGrid、阿里云邮件推送、腾讯云 SES）。
  // 需要 config 中补充 SMTP_HOST/USER/PASS 或对应 API Key，再在此处调用。
  console.warn('[notify] 未配置邮件服务商，验证码未实际发送：', email);
  return { delivered: false };
}

async function sendVerificationSms(phone, code) {
  if (isDev()) {
    console.log(`[mock-sms] → ${phone} 验证码：${code}（10 分钟内有效）`);
    return { delivered: true, mock: true };
  }
  // TODO(prod): 接入短信服务商（如 腾讯云 SMS、阿里云短信）。
  // 需要 config 中补充短信签名/模板/密钥，再在此处调用。
  console.warn('[notify] 未配置短信服务商，验证码未实际发送：', phone);
  return { delivered: false };
}

module.exports = { isDev, sendVerificationEmail, sendVerificationSms };
