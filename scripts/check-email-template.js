#!/usr/bin/env node
'use strict';

// 验证码邮件模板自检 / 修复工具。
//
// 背景：SES 的 API 通道只能走「模板发送」（Simple 自定义内容默认被拒：
// FailedOperation.WithOutPermission 未开通自定义发送权限）。因此邮件正文完全由
// 控制台模板决定，代码无法干预。一旦模板里把验证码写死、或被人改掉 {{code}} 占位符，
// 所有用户收到的都会是同一个固定验证码，且服务端完全无感。本脚本用于把这种事故
// 变成可发现、可修复的常规检查。
//
// 用法（在服务器上执行，需先加载 /etc/loginapp.env）：
//   set -a; . /etc/loginapp.env; set +a
//   node scripts/check-email-template.js            # 只看状态
//   node scripts/check-email-template.js --fix      # 用本地模板覆盖控制台模板
//   node scripts/check-email-template.js --watch    # 每 60 秒轮询，直到审核通过
//
// 注意：--fix 会触发模板重新审核，审核期间发送会报 InvalidTemplateID。

const fs = require('fs');
const path = require('path');

const config = require('../config');
const template = require('../lib/verifyEmailTemplate');

const REQUIRED_VARS = ['code', 'minutes', 'email'];
const TEMPLATE_ID = config.tencent.ses.templateId;

function sdk() {
  return require('tencentcloud-sdk-nodejs-ses').ses.v20201002;
}

function client() {
  const SesClient = sdk().Client;
  return new SesClient({
    credential: { secretId: config.tencent.secretId, secretKey: config.tencent.secretKey },
    region: config.tencent.ses.region,
    profile: { httpProfile: { endpoint: 'ses.tencentcloudapi.com', reqTimeout: 30 } },
  });
}

function decode(b64) {
  return Buffer.from(String(b64 || ''), 'base64').toString('utf8');
}

function encode(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

function htmlWithPlaceholders() {
  const file = path.join(__dirname, '..', 'docs', 'verify-email-template.html');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return template.renderVerifyEmail({ code: '{{code}}', email: '{{email}}', minutes: '{{minutes}}' });
}

function textWithPlaceholders() {
  return [
    '您好，我们收到了针对 {{email}} 的登录请求。',
    '',
    '您的登录验证码是：{{code}}',
    '该验证码 {{minutes}} 分钟内有效。',
    '',
    '如非您本人操作，请忽略本邮件，您的账户不会受到任何影响。',
    '出于安全考虑，请勿将验证码透露给任何人，包括自称官方客服的人员。',
    '',
    '西安明旸信息技术有限公司',
    "XI'AN MINGYANG INFORMATION TECHNOLOGY CO., LTD.",
    'https://mingyanginfo.com',
  ].join('\n');
}

async function inspect(c) {
  const out = { ok: false, lines: [] };
  let status = '未知';
  try {
    const list = await c.ListEmailTemplates({ Limit: 50, Offset: 0 });
    const hit = (list.TemplatesMetadata || []).find((t) => Number(t.TemplateID) === Number(TEMPLATE_ID));
    if (hit) {
      status = String(hit.TemplateStatus);
      out.lines.push(`模板状态 TemplateStatus = ${status}（1 通常为审核通过，0 为审核中，2/-1 为未通过，以控制台显示为准）`);
    } else {
      out.lines.push(`模板 ${TEMPLATE_ID} 不在列表里（可能无 ListEmailTemplates 权限或 ID 有误）`);
    }
  } catch (e) {
    out.lines.push(`列表查询失败（可忽略）：${e.code || ''} ${String(e.message).slice(0, 120)}`);
  }

  let html = '';
  let text = '';
  try {
    const r = await c.GetEmailTemplate({ TemplateID: TEMPLATE_ID });
    const tc = r.TemplateContent || {};
    html = decode(tc.Html);
    text = decode(tc.Text);
  } catch (e) {
    out.lines.push(`读取模板失败：${e.code || ''} ${String(e.message).slice(0, 160)}`);
    return out;
  }

  out.lines.push(`HTML 长度 ${html.length}｜TEXT 长度 ${text.length}`);
  const missing = REQUIRED_VARS.filter((v) => !html.includes(`{{${v}}}`));
  out.lines.push(`占位符：${REQUIRED_VARS.map((v) => `${v}=${html.includes(`{{${v}}}`) ? '有' : '缺'}`).join(' ')}`);
  if (!text.trim()) out.lines.push('⚠️ 缺少纯文本版（TEXT 为空），是官方列出的进垃圾箱因素之一');
  else if (/\{\{code\}\}/.test(text) === false) out.lines.push('⚠️ 纯文本版里没有 {{code}}');

  // 硬编码验证码探测：模板里出现 6 位数字且没有 {{code}}，基本可判定为写死
  if (!html.includes('{{code}}')) {
    const m = html.match(/\b\d{6}\b/);
    if (m) out.lines.push(`🚨 疑似写死的验证码：${m[0]}（模板缺少 {{code}}，所有人都会收到这个固定值）`);
    out.lines.push('🚨 结论：模板内容不可用，发送会被拒绝（sendVerificationEmail 返回 delivered:false）');
    return out;
  }

  out.ok = status === '1' || status === '未知';
  out.lines.push(status === '1' || status === '未知' ? '✅ 结论：模板可用' : '⏳ 结论：模板内容正确，但尚未审核通过，此期间发送会报 InvalidTemplateID');
  return out;
}

async function fix(c) {
  const html = htmlWithPlaceholders();
  const text = textWithPlaceholders();
  console.log('— 用本地参数化模板覆盖控制台模板 —');
  console.log(`HTML 长度 ${html.length}｜含 {{code}}: ${html.includes('{{code}}')}｜含 {{email}}: ${html.includes('{{email}}')}｜含 {{minutes}}: ${html.includes('{{minutes}}')}`);
  const r = await c.UpdateEmailTemplate({
    TemplateID: TEMPLATE_ID,
    TemplateName: '验证码模版',
    TemplateContent: { Html: encode(html), Text: encode(text) },
  });
  console.log('已提交更新：', JSON.stringify(r));
  console.log('⚠️ 修改模板会触发重新审核，审核期间发送会失败，请在控制台确认状态。');
}

(async () => {
  if (!TEMPLATE_ID || Number(TEMPLATE_ID) <= 0) {
    console.error('未配置 TENCENT_SES_TEMPLATE_ID，无法检查。');
    process.exit(1);
  }
  console.log(`模板 ID = ${TEMPLATE_ID}｜地域 = ${config.tencent.ses.region}`);
  const c = client();

  if (process.argv.includes('--fix')) {
    await fix(c);
    return;
  }

  if (process.argv.includes('--watch')) {
    for (let i = 1; i <= 40; i++) {
      const r = await inspect(c);
      console.log(`\n[第 ${i} 次] ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      r.lines.forEach((l) => console.log('  ' + l));
      if (r.ok) {
        console.log('\n模板已可用，可以发测试邮件了。');
        return;
      }
      await new Promise((res) => setTimeout(res, 60000));
    }
    console.log('\n已轮询 40 次仍未通过，请到控制台确认审核结果。');
    return;
  }

  const r = await inspect(c);
  r.lines.forEach((l) => console.log(l));
  process.exit(r.ok ? 0 : 1);
})().catch((e) => {
  console.error('执行失败：', e && (e.code || ''), e && e.message);
  process.exit(1);
});
