#!/usr/bin/env node
'use strict';

// SMTP 通道自检：默认只做「登录验证」，不投递任何邮件。
//
// 为什么需要它：SES 的 API 通道有两条硬限制（均已实测）
//   1) Simple 自定义内容 → FailedOperation.WithOutPermission（未开通自定义发送权限）
//   2) 模板发送 → 模板新建/修改后必须重新审核，审核期间 SendEmail 一律报 InvalidTemplateID
// SMTP 通道两条都不受限制：正文由代码渲染，验证码一定是当次生成的真码。
//
// 用法（在服务器上执行）：
//   set -a; . /etc/loginapp.env; set +a
//   export NODE_PATH=/www/wwwroot/login.mingyanginfo.com/node_modules
//   node scripts/smtp-verify.js                      # 只验证能否登录 SMTP，不发信
//   node scripts/smtp-verify.js --to someone@x.com   # 额外真发一封（需你明确要求才用）

const config = require('../config');
const verifyEmailTemplate = require('../lib/verifyEmailTemplate');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

const s = config.tencent.ses.smtp;

console.log(' SES 配置：mode =', config.tencent.ses.mode, '| region =', config.tencent.ses.region);
console.log(' 发信地址：', config.tencent.ses.fromAddress, '| 显示名：', config.tencent.ses.fromName);
console.log(' SMTP：', s.host + ':' + s.port, '| secure =', s.secure, '| user =', s.user);
console.log(' SMTP 已配置：', s.configured, '| 邮件方式已启用：', config.mfa.emailEnabled);

if (!s.configured) {
  console.error('\n❌ SMTP 未配置（SES_SMTP_PASS 为空或仍是占位符）。');
  console.error('   请先在控制台给发信地址设置 SMTP 密码，再执行：bash scripts/smtp-setup.sh');
  process.exit(1);
}

const nodemailer = require('nodemailer');
const transport = nodemailer.createTransport({
  host: s.host,
  port: s.port,
  secure: s.secure,
  auth: { user: s.user, pass: s.pass },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
});

(async () => {
  try {
    await transport.verify();
    console.log('\n✅ SMTP 登录成功（未发送任何邮件）');
  } catch (e) {
    console.error('\n❌ SMTP 登录失败：', e && e.message);
    console.error('   常见原因：① 密码不对 ② 个人实名账号 2026-03-02 后禁用 SMTP ③ 开了 SMTP IP 白名单但没加 150.158.55.8');
    process.exit(1);
  }

  const to = arg('to');
  if (!to) return;

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const minutes = Math.round(config.mfa.codeTtlMs / 60000);
  const info = await transport.sendMail({
    from: '"' + config.tencent.ses.fromName + '" <' + (s.user || config.tencent.ses.fromAddress) + '>',
    to,
    subject: '【明旸信息】登录验证码',
    text: `【明旸信息】您正在登录账号，本次验证码为 ${code}，请在 ${minutes} 分钟内使用。如非本人操作请忽略本邮件。`,
    html: verifyEmailTemplate.renderVerifyEmail({ code, email: to, minutes, ip: '', time: '' }),
  });
  console.log('✅ 已发送测试邮件 ->', to, '| 验证码 =', code, '| messageId =', info && info.messageId);
})().catch((e) => {
  console.error('执行失败：', e && e.message);
  process.exit(1);
});
