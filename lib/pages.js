'use strict';

// 页面模板：按《明旸信息设计规范》(01-DESIGN_SPEC.md) 复刻设计系统。
// 独立项目（非 Next.js），因此在此复刻 tokens：主题变量、字体、组件类名见 public/css/style.css。

const config = require('../config');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 首帧防闪烁脚本（规范 §2，置于 body 第一个子元素）
const NO_FLASH_SCRIPT =
  '(function(){try{var t=localStorage.getItem("theme");var light=t?t==="light":window.matchMedia("(prefers-color-scheme: light)").matches;if(light)document.documentElement.classList.add("light");}catch(e){}})()';

function turnstileBox(action) {
  if (!config.turnstile.enabled) return '';
  const actionAttr = action ? ` data-action="${esc(action)}"` : '';
  return `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${esc(config.turnstile.siteKey)}" data-theme="auto"${actionAttr}></div></div>`;
}

/**
 * 公共布局。规范 §7：液态玻璃表单卡居中 + 背景网格 + 单个 accent 光斑 + 左上角 logo。
 */
function layout({ title, content, withTurnstile = false }) {
  const ts = withTurnstile && config.turnstile.enabled
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(title)} · 明旸信息</title>
<link rel="icon" href="/img/logo-icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/style.css">
${ts}
</head>
<body>
<script>${NO_FLASH_SCRIPT}</script>
<div class="grain" aria-hidden="true"></div>
<div class="bg-grid" aria-hidden="true"></div>
<div class="ambient" aria-hidden="true"></div>
<header class="site-head rise">
  <a class="brand" href="/" aria-label="明旸信息首页">
    <img src="/img/logo-icon.svg" alt="" width="30" height="30">
    <span class="brand-text">
      <span class="brand-name">明旸信息</span>
      <span class="brand-mono">MINGYANGINFO</span>
    </span>
  </a>
  <button type="button" class="theme-btn" aria-label="切换亮暗主题">
    <svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5"/></svg>
    <svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.3 8.3 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7Z"/></svg>
  </button>
</header>
<main class="auth-wrap">
${content}
</main>
<footer class="site-foot">© 2026 西安明旸信息技术有限公司 · XI'AN MINGYANG INFORMATION TECHNOLOGY CO., LTD.<br><a class="beian-link" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">陕ICP备2026028201号</a></footer>
<script src="/js/theme.js" defer></script>
</body>
</html>`;
}

function errorBox(msg) {
  if (!msg) return '';
  return `<p class="form-error" role="alert">${esc(msg)}</p>`;
}

function noticeBox(msg) {
  if (!msg) return '';
  return `<p class="form-notice" role="status">${esc(msg)}</p>`;
}

function loginPage({ csrf, error, notice, username = '' }) {
  return layout({
    title: '登录',
    withTurnstile: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">SIGN IN / 01</p>
  <h1 class="form-title">登录<span class="latin-accent"> Sign in</span></h1>
  <p class="form-sub">使用你的明旸信息账号继续，登录需通过动态口令验证。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/login">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="username">用户名</label>
      <input id="username" name="username" type="text" value="${esc(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" required autofocus>
    </div>
    <div class="field">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="72" required>
    </div>
    ${turnstileBox('login')}
    <button class="btn btn-primary btn-block" type="submit">继续</button>
  </form>
  <p class="form-foot">还没有账号？<a class="link-slide" href="/register">注册一个</a></p>
</section>`,
  });
}

function twofaPage({ csrf, error, username }) {
  return layout({
    title: '动态口令',
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">TWO-FACTOR / 02</p>
  <h1 class="form-title">动态口令<span class="latin-accent"> 2FA</span></h1>
  <p class="form-sub">打开验证器 App（Google Authenticator、Aegis 等），输入当前 6 位动态口令。</p>
  ${errorBox(error)}
  <form method="post" action="/2fa">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="totp">动态口令或恢复码</label>
      <input id="totp" name="totp" class="otp-input" type="text" autocomplete="one-time-code" maxlength="18" required autofocus>
      <p class="hint">验证器 App 的 6 位口令；手机丢失时可用恢复码（xxxx-xxxx）</p>
    </div>
    <button class="btn btn-primary btn-block" type="submit">验证并登录</button>
  </form>
  <p class="form-foot">账号：${esc(username)} · <a class="link-slide" href="/logout">使用其他账号</a></p>
</section>`,
  });
}

function registerPage({ csrf, error, username = '', email = '', phone = '' }) {
  return layout({
    title: '注册',
    withTurnstile: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">CREATE ACCOUNT</p>
  <h1 class="form-title">注册<span class="latin-accent"> Sign up</span></h1>
  <p class="form-sub">创建明旸信息账号。注册后需绑定手机动态令牌（TOTP）方可使用。</p>
  ${errorBox(error)}
  <form method="post" action="/register">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="username">用户名</label>
      <input id="username" name="username" type="text" value="${esc(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+" required autofocus>
      <p class="hint">3–24 位，仅限字母、数字与下划线</p>
    </div>
    <div class="field">
      <label for="email">邮箱</label>
      <input id="email" name="email" type="email" value="${esc(email)}" autocomplete="email" maxlength="254" required>
    </div>
    <div class="field">
      <label for="phone">手机号码</label>
      <input id="phone" name="phone" type="tel" value="${esc(phone)}" autocomplete="tel" inputmode="numeric" pattern="1[3-9][0-9]{9}" maxlength="11" required>
      <p class="hint">11 位中国大陆手机号</p>
    </div>
    <div class="field">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
      <p class="hint">至少 8 位；建议字母、数字与符号组合</p>
    </div>
    <div class="field">
      <label for="password2">确认密码</label>
      <input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
    </div>
    ${turnstileBox('register')}
    <button class="btn btn-primary btn-block" type="submit">创建账号</button>
  </form>
  <p class="form-foot">已有账号？<a class="link-slide" href="/">直接登录</a></p>
</section>`,
  });
}

function setup2faPage({ csrf, error, qrDataUrl, secret, recoveryCodes, username }) {
  return layout({
    title: '绑定动态令牌',
    content: `
<section class="form-card rise rise-2 form-card-wide">
  <p class="kicker">SETUP 2FA / REQUIRED</p>
  <h1 class="form-title">绑定动态令牌<span class="latin-accent"> TOTP</span></h1>
  <p class="form-sub">使用验证器 App 扫描下方二维码（或手动录入密钥），随后输入当前 6 位口令完成绑定。绑定后登录需要动态口令。</p>
  ${errorBox(error)}
  <div class="qr-panel rise rise-3">
    <img class="qr" src="${qrDataUrl}" alt="TOTP 二维码" width="176" height="176">
    <div class="qr-meta">
      <p class="field-label">账户</p>
      <p class="secret-text">明旸信息:${esc(username)}</p>
      <p class="field-label">密钥（手动录入）</p>
      <p class="secret-text">${esc(secret)}</p>
      <p class="hint">算法 SHA1 · 6 位 · 30 秒</p>
    </div>
  </div>
  <div class="recovery rise rise-4">
    <p class="field-label">恢复码（仅显示一次，请妥善保存）</p>
    <div class="recovery-codes">
      ${recoveryCodes.map((c) => `<span>${esc(c)}</span>`).join('')}
    </div>
  </div>
  <form method="post" action="/setup-2fa" class="rise rise-5">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="totp">输入当前 6 位口令以确认绑定</label>
      <input id="totp" name="totp" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9\\s]*" maxlength="7" required>
    </div>
    <button class="btn btn-primary btn-block" type="submit">确认绑定</button>
  </form>
</section>`,
  });
}

function dashboardPage({ user, lastLogin, loginIp, notice, csrf }) {
  const joined = new Date(user.created_at);
  const dateStr = `${joined.getFullYear()}.${
    String(joined.getMonth() + 1).padStart(2, '0')
  }.${String(joined.getDate()).padStart(2, '0')}`;
  return layout({
    title: '控制台',
    content: `
<section class="dash rise rise-2">
  <p class="kicker">DASHBOARD</p>
  <h1 class="dash-title">你好，<span class="dash-name">${esc(user.username)}</span></h1>
  <p class="form-sub rise rise-3">两步验证已启用，你的账号受到动态口令保护。</p>
  ${noticeBox(notice)}
  <div class="dash-meta rise rise-4">
    <span class="badge-ok">2FA ENABLED</span>
    <div class="meta-rows">
      <p><span class="meta-label">上次登录</span><span class="meta-value">${esc(lastLogin || '本次为首次登录')}</span></p>
      <p><span class="meta-label">登录 IP</span><span class="meta-value">${esc(loginIp)}</span></p>
      <p><span class="meta-label">账号创建</span><span class="meta-value">${dateStr}</span></p>
    </div>
  </div>
  <div class="dash-actions rise rise-5">
    <form method="post" action="/logout">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button class="btn btn-ghost" type="submit">退出登录</button>
    </form>
  </div>
  <span class="text-outline" aria-hidden="true">明旸</span>
</section>`,
  });
}

function messagePage({ title, kicker, message, backHref = '/', backText = '返回登录' }) {
  return layout({
    title,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">${esc(kicker)}</p>
  <h1 class="form-title">${esc(title)}</h1>
  <p class="form-sub">${esc(message)}</p>
  <a class="btn btn-primary btn-block" href="${esc(backHref)}">${esc(backText)}</a>
</section>`,
  });
}

module.exports = { esc, loginPage, twofaPage, registerPage, setup2faPage, dashboardPage, messagePage };
