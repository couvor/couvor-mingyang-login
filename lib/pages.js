'use strict';

// 页面模板：按《明旸信息设计规范》(01-DESIGN_SPEC.md) 复刻设计系统。
// 独立项目（非 Next.js），因此在此复刻 tokens：主题变量、字体、组件类名见 public/css/style.css。

const config = require('../config');

// 静态资源版本号：CSS 有变更时自增，强制浏览器刷新缓存（生产亦适用）。
const ASSET_VER = '7';

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
  '(function(){try{var t=localStorage.getItem("theme");var dark=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;if(dark)document.documentElement.classList.add("dark");}catch(e){}})()';

// 提交反馈 + 自动重试：POST 表单提交后立即禁用按钮并显示「正在处理…」；
// 若 3 秒内页面仍未跳走（登录/2FA 成功后的 SSO 续接是跨站 302 链，可能被
// 中间网络设备静默挂起数秒），浏览器端自动重新发起导航（GET /，由服务端按
// 会话状态自动续接：已认证 → 续接回应用），并按 3/6/9/12/15 秒退避重试，
// 直至新页面提交或 45 秒上限——用户无需手动刷新。跳转悬空期间旧页面的
// 计时器仍在运行，这正是能自动重试的关键。重试期间按钮显示「网络较慢，正在自动重试…」。
const SUBMIT_GUARD_SCRIPT =
  '(function(){' +
  'function arm(f){' +
  'var b=f.querySelector("button[type=submit]"),t=null;' +
  'if(b&&!b.disabled){b.disabled=true;t=b.textContent;b.textContent="正在处理…";}' +
  'var delays=[3000,6000,9000,12000,15000],i=0;' +
  'function restore(){if(b){b.disabled=false;if(t!==null)b.textContent=t;}}' +
  'function tick(){' +
  'if(i>=delays.length){restore();return;}' +
  'setTimeout(function(){' +
  'if(b&&b.disabled)b.textContent="网络较慢，正在自动重试…";' +
  'try{location.replace("/");}catch(e){}' +
  'i++;tick();' +
  '},delays[i]);' +
  '}' +
  'tick();' +
  '}' +
  // data-no-guard 的表单不做自动重试：头像上传等同页操作若被强行导航到 / 会丢失结果提示。
  // 含 reCAPTCHA 挂件的表单（验证码发送/重发）同样跳过：发码要先走 SES 出网，
  // 服务端可能数秒才响应，此时 3 秒的自动重试会 location.replace("/") 强行取消
  // 这个仍在途的 POST，导致「点了发送却没发出去 / 被踢回首页」。
  'document.addEventListener("submit",function(e){var f=e.target;if(!f||(f.method||"get").toLowerCase()!=="post")return;if(f.hasAttribute("data-no-guard"))return;if(f.querySelector(".g-recaptcha"))return;arm(f);},true);' +
  '})();';

// 人机验证挂件加载守卫（Turnstile + reCAPTCHA 通用）。
// 两家 api.js 都是 async 加载：网络慢或被拦时挂件区域会一直空白，用户面前没有任何框可勾，
// 一旦点提交就是空 token，服务端只会回「人机验证未通过」——用户既不知道原因也无从补救。
// 规则：**挂件渲染完成前，一律拦在前端**——
//   1. 禁用提交按钮并显示「加载中」提示；
//   2. 在 submit 捕获阶段 preventDefault + stopImmediatePropagation，空 token 绝不出网
//      （stopImmediatePropagation 同时挡住后面的 SUBMIT_GUARD，避免它误判成慢请求而开自动重试）；
//   3. 渲染完成即恢复按钮、移除提示，正常提交。
// 渲染成功标志：**以「是否拿到 token」为准**（Turnstile 用 turnstile.getResponse() / 隐藏域，
// reCAPTCHA 用 grecaptcha.getResponse() / 隐藏 textarea），不再看容器里有没有 iframe。
// ⚠️ 2026-10-18 事故教训：旧实现用 `.cf-turnstile iframe` 判断就绪，而 Cloudflare 新版
// Turnstile 渲染模式（rch/av0）**整个文档里一个 iframe 都没有**，导致 ready() 永远 false：
// 挂件明明显示「成功！」绿勾、token 也有效，按钮却被永久禁用，submit 在捕获阶段被拦死，
// 12 秒后变成「组件加载失败，请刷新页面重试」→ 点击 reload → 死循环，登录/注册/忘记密码全部无法提交。
// 所以：SDK 一旦可用就放行按钮；空 token 的拦截交给 submit 时按需提示，绝不让按钮永久卡死。
// 约 12 秒（40×300ms）连 SDK 都没就绪才判定加载失败：按钮改成「刷新页面重试」，提交即刷新页面。
const CAPTCHA_GUARD_SCRIPT =
  '(function(){' +
  'var W=[' +
  // Turnstile：拿 token 的正规入口是 getResponse()，隐藏域兜底（隐式渲染时它由 SDK 写入）。
  '{s:".cf-turnstile",' +
  'tok:function(){try{if(window.turnstile&&typeof window.turnstile.getResponse==="function"){var r=window.turnstile.getResponse();if(r)return r;}}catch(e){}' +
  'var i=document.querySelector("input[name=cf-turnstile-response]");return i&&i.value?i.value:"";},' +
  'sdk:function(){return !!(window.turnstile&&typeof window.turnstile.getResponse==="function");},' +
  'reset:function(){try{window.turnstile.reset();}catch(e){}}},' +
  // reCAPTCHA v2：必须用户勾选才有 token，故 sdk 一就绪就放行按钮，未勾选时由 submit 提示。
  '{s:".g-recaptcha",' +
  'tok:function(){try{if(window.grecaptcha&&typeof window.grecaptcha.getResponse==="function"){var r=window.grecaptcha.getResponse();if(r)return r;}}catch(e){}' +
  'var t=document.querySelector("textarea[name=g-recaptcha-response]");return t&&t.value?t.value:"";},' +
  'sdk:function(){return !!(window.grecaptcha&&typeof window.grecaptcha.render==="function");},' +
  'reset:function(){try{window.grecaptcha.reset();}catch(e){}}}' +
  '];' +
  'function wid(f){for(var i=0;i<W.length;i++){if(f.querySelector(W[i].s))return W[i];}return null;}' +
  'var forms=[].slice.call(document.querySelectorAll("form"))' +
  '.map(function(f){return{f:f,w:wid(f),b:null,tip:null,t:null,done:false,failed:false};})' +
  '.filter(function(o){return o.w;});' +
  'if(!forms.length)return;' +
  // 提示条按需插入：settle 后节点会被移除，再次拦截时要能重新挂回去。
  'function showTip(o,msg,cls){' +
  'if(!o.tip){o.tip=document.createElement("p");o.tip.setAttribute("role","status");}' +
  'o.tip.className=(cls||"form-error")+" captcha-tip";o.tip.textContent=msg;' +
  'if(!o.tip.parentNode){(o.b&&o.b.parentNode?o.b.parentNode:o.f).insertBefore(o.tip,o.b||null);}' +
  '}' +
  'function hideTip(o){if(o.tip&&o.tip.parentNode)o.tip.parentNode.removeChild(o.tip);}' +
  'forms.forEach(function(o){' +
  'o.b=o.f.querySelector("button[type=submit]");' +
  'if(o.b){o.t=o.b.textContent;o.b.disabled=true;}' +
  'showTip(o,"人机验证组件加载中，请稍候…","form-notice");' +
  '});' +
  'function tokenOf(o){try{return o.w.tok()||"";}catch(e){return "";}}' +
  'function sdkOk(o){try{return !!o.w.sdk();}catch(e){return false;}}' +
  'function settle(o){o.done=true;if(o.b){o.b.disabled=false;if(o.t!==null)o.b.textContent=o.t;}hideTip(o);}' +
  'function giveup(o){o.done=true;o.failed=true;if(o.b){o.b.disabled=false;o.b.textContent="刷新页面重试";}showTip(o,"人机验证组件加载失败，请刷新页面重试。","form-error");}' +
  'document.addEventListener("submit",function(e){' +
  'var f=e.target,o=null;' +
  'for(var i=0;i<forms.length;i++){if(forms[i].f===f){o=forms[i];break;}}' +
  'if(!o)return;' +
  'if(tokenOf(o))return;' + // 有 token 正常放行
  'e.preventDefault();e.stopImmediatePropagation();' +
  // SDK 都没起来（或已判失败）→ 刷新页面重来，而不是把空 token 发给服务端换一句「未通过」。
  'if(o.failed||!sdkOk(o)){try{location.reload();}catch(err){}return;}' +
  'showTip(o,"请先完成人机验证（勾选或等待验证完成）后再提交。","form-notice");' +
  '},true);' +
  'var tries=0,MAX=40;' +
  'var timer=setInterval(function(){' +
  'tries++;var all=true;' +
  // 拿到 token 或 SDK 就绪即放行；token 未到但 SDK 在，也算已就绪（v2 需用户勾选）。
  'forms.forEach(function(o){if(o.done)return;if(tokenOf(o)||sdkOk(o))settle(o);else all=false;});' +
  'if(all){clearInterval(timer);return;}' +
  // 超时后必须放行按钮：永久禁用会让用户卡死；但放行后的提交走上面的拦截，直接刷新页面。
  'if(tries>=MAX){clearInterval(timer);forms.forEach(function(o){if(!o.done)giveup(o);});}' +
  '},300);' +
  // bfcache / 前进后退恢复页面时，挂件可能仍显示「成功」但 token 已被服务端消费过，
  // 直接提交会得到 `timeout-or-duplicate`（用户视角：明明通过了却说未通过）。恢复即重置换件。
  'window.addEventListener("pageshow",function(e){if(e&&e.persisted){forms.forEach(function(o){if(o.failed)return;try{o.w.reset();}catch(err){}});}});' +
  '})();';

function turnstileBox(action) {
  if (!config.turnstile.enabled) return '';
  const actionAttr = action ? ` data-action="${esc(action)}"` : '';
  return `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${esc(config.turnstile.siteKey)}" data-theme="auto"${actionAttr}></div></div>`;
}

// Google reCAPTCHA v2 复选框挂件（走 recaptcha.net，国内可达）。
function recaptchaBox() {
  if (!config.recaptcha.enabled) return '';
  return `<div class="recaptcha-wrap"><div class="g-recaptcha" data-sitekey="${esc(config.recaptcha.siteKey)}" data-theme="light"></div></div>`;
}

/**
 * 公共布局。规范 §7：液态玻璃表单卡居中 + 背景网格 + 单个 accent 光斑 + 左上角 logo。
 */
function layout({ title, content, withTurnstile = false, withRecaptcha = false }) {
  const ts = withTurnstile && config.turnstile.enabled
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';
  const rc = withRecaptcha && config.recaptcha.enabled
    ? `<script src="https://${esc(config.recaptcha.apiHost)}/recaptcha/api.js" async defer></script>`
    : '';
  // 有人机验证挂件的页面都装守卫（Turnstile 与 reCAPTCHA 共用一套）。
  const rg = ((withTurnstile && config.turnstile.enabled) || (withRecaptcha && config.recaptcha.enabled))
    ? '<script>' + CAPTCHA_GUARD_SCRIPT + '</script>'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · 明旸信息</title>
<link rel="icon" href="/img/logo-icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/style.css?v=${ASSET_VER}">
${ts}
${rc}
</head>
<body>
<script>${NO_FLASH_SCRIPT}</script>
<div class="grain" aria-hidden="true"></div>
<div class="bg-grid" aria-hidden="true"></div>
<div class="ambient" aria-hidden="true"></div>
<header class="site-head rise">
  <a class="brand" href="/" aria-label="明旸信息首页">
    <img src="/img/logo-icon.svg" alt="" width="36" height="30">
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
${rg}
<script>${SUBMIT_GUARD_SCRIPT}</script>
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

// 开发/测试环境回显验证码（生产环境为空，验证码只走邮件/短信）。
function devCodeBox(code) {
  if (!code) return '';
  return `<p class="form-notice" role="status">开发模式验证码：<span class="code-echo">${esc(code)}</span>（生产环境将通过邮件 / 短信发送）</p>`;
}

function loginPage({ csrf, error, notice, username = '' }) {
  return layout({
    title: '登录',
    withTurnstile: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">SIGN IN / 01</p>
  <h1 class="form-title">登录<span class="latin-accent"> Sign in</span></h1>
  <p class="form-sub">使用你的明旸信息账号继续，登录需通过二次验证。</p>
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
  <div class="form-foot-split">
    <p class="form-foot">还没有账号？<a class="link-slide" href="/register">注册一个</a></p>
    <p class="form-foot"><a class="link-slide" href="/forgot-password">忘记密码？</a></p>
  </div>
</section>`,
  });
}

// 二次验证页（登录第二步）：按会话记录的 mfa_method 渲染对应凭证输入。
// totp → 6 位动态口令（手机丢失时可用恢复码）；email/phone → 6 位验证码（可重发）。
function twofaPage({ csrf, error, notice, devCode, username, method = 'totp', target = '', needSend = false }) {
  if (method === 'totp') {
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

  const isEmail = method === 'email';
  const title = isEmail ? '邮箱验证' : '手机验证';

  // 未发码状态：先完成 reCAPTCHA 人机验证，点击「发送验证码」后才会真正发送（先验证、后发码）。
  if (needSend) {
    return layout({
      title,
      withRecaptcha: true,
      content: `
<section class="form-card rise rise-2">
  <p class="kicker">TWO-FACTOR / ${isEmail ? 'EMAIL' : 'SMS'}</p>
  <h1 class="form-title">${title}<span class="latin-accent"> ${isEmail ? 'Email' : 'SMS'}</span></h1>
  <p class="form-sub">验证码将发送至 ${esc(target)}。请先完成人机验证，再点击发送。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/2fa/send">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    ${recaptchaBox()}
    <button class="btn btn-primary btn-block" type="submit">发送验证码</button>
  </form>
  <p class="form-foot">账号：${esc(username)} · <a class="link-slide" href="/logout">使用其他账号</a></p>
</section>`,
    });
  }

  return layout({
    title,
    withRecaptcha: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">TWO-FACTOR / ${isEmail ? 'EMAIL' : 'SMS'}</p>
  <h1 class="form-title">${title}<span class="latin-accent"> ${isEmail ? 'Email' : 'SMS'}</span></h1>
  <p class="form-sub">输入发送至 ${esc(target)} 的 6 位验证码以完成登录。</p>
  ${noticeBox(notice)}
  ${devCodeBox(devCode)}
  ${errorBox(error)}
  <form method="post" action="/2fa">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="code">6 位验证码</label>
      <input id="code" name="code" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
      <p class="hint">验证码 10 分钟内有效</p>
    </div>
    <button class="btn btn-primary btn-block" type="submit">验证并登录</button>
  </form>
  <form method="post" action="/2fa/send" class="resend-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    ${recaptchaBox()}
    <button class="btn-link" type="submit">重新发送验证码</button>
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
  <p class="form-sub">创建明旸信息账号。注册完成后，请任选一种方式完成二次验证：动态令牌（TOTP）、邮箱验证或手机验证。</p>
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
  <form method="post" action="/setup-2fa/totp" class="rise rise-5">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="totp">输入当前 6 位口令以确认绑定</label>
      <input id="totp" name="totp" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9\\s]*" maxlength="7" required>
    </div>
    <button class="btn btn-primary btn-block" type="submit">确认绑定</button>
  </form>
  <p class="form-foot">不想用验证器 App？<a class="link-slide" href="/setup-2fa">改用其他方式</a></p>
</section>`,
  });
}

// 首次绑定二次验证的方式选择页（TOTP / 邮箱 / 手机 三选一）。
function setupChoosePage({ username, email, phone, emailEnabled, phoneEnabled, error, notice }) {
  const choice = (href, title, desc, enabled) =>
    enabled
      ? `<a class="method-choice" href="${esc(href)}">
          <span class="m-title">${esc(title)}</span>
          <span class="m-desc">${esc(desc)}</span>
          <span class="m-go">选择 →</span>
        </a>`
      : `<div class="method-choice is-disabled">
          <span class="m-title">${esc(title)}</span>
          <span class="m-desc">${esc(desc)}</span>
          <span class="m-go">暂不可用</span>
        </div>`;
  const emailDesc = emailEnabled
    ? `验证码发送到 ${email}。`
    : `服务商未配置，暂不可用（需发送到 ${email}）。`;
  // 短信通道暂未对外开放：前端恒定为「暂不可用」，不展示入口。
  // 后端 SMS 发送 / 绑定 / 校验代码完整保留，待短信签名与模板审批通过、
  // 并在 /etc/loginapp.env 填入 SdkAppId、签名、模板 ID 后，
  // 把 SMS_FRONTEND_DISABLED 改回 false 即可恢复入口。
  const SMS_FRONTEND_DISABLED = true;
  const phoneChoiceEnabled = SMS_FRONTEND_DISABLED ? false : phoneEnabled;
  const phoneDesc = SMS_FRONTEND_DISABLED
    ? '短信通道暂未开放，敬请期待。'
    : phoneEnabled
      ? `验证码发送到 ${phone}。`
      : `服务商未配置，暂不可用（需发送到 ${phone}）。`;
  return layout({
    title: '开启二次验证',
    content: `
<section class="form-card rise rise-2 form-card-wide">
  <p class="kicker">SETUP 2FA / CHOOSE</p>
  <h1 class="form-title">开启二次验证<span class="latin-accent"> MFA</span></h1>
  <p class="form-sub">请任选一种方式完成绑定。绑定后每次登录都需用该方式验证，以保护账号安全。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <div class="method-choices rise rise-3">
    ${choice('/setup-2fa/totp', '动态令牌（TOTP）', '用 Google Authenticator、Aegis 等验证器 App 生成 6 位口令，离线可用、最省心。', true)}
    ${choice('/setup-2fa/email', '邮箱验证', emailDesc, emailEnabled)}
    ${choice('/setup-2fa/phone', '手机验证', phoneDesc, phoneChoiceEnabled)}
  </div>
  <p class="form-foot">账号：${esc(username)}</p>
</section>`,
  });
}

// 邮箱 / 手机首次绑定页：输入发往该账号的一次性验证码完成绑定。
function setupCodePage({ csrf, method, target, error, notice, devCode, username, needSend = false }) {
  const isEmail = method === 'email';
  const title = isEmail ? '邮箱验证' : '手机验证';

  // 未发码状态：先完成 reCAPTCHA 人机验证，点击「发送验证码」后才会真正发送（先验证、后发码）。
  if (needSend) {
    return layout({
      title,
      withRecaptcha: true,
      content: `
<section class="form-card rise rise-2">
  <p class="kicker">SETUP 2FA / ${isEmail ? 'EMAIL' : 'PHONE'}</p>
  <h1 class="form-title">${title}<span class="latin-accent"> ${isEmail ? 'Email' : 'SMS'}</span></h1>
  <p class="form-sub">验证码将发送至 ${esc(target)}。请先完成人机验证，再点击发送。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/setup-2fa/${esc(method)}/send">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    ${recaptchaBox()}
    <button class="btn btn-primary btn-block" type="submit">发送验证码</button>
  </form>
  <p class="form-foot">账号：${esc(username)} · <a class="link-slide" href="/setup-2fa">改用其他方式</a></p>
</section>`,
    });
  }

  return layout({
    title,
    withRecaptcha: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">SETUP 2FA / ${isEmail ? 'EMAIL' : 'PHONE'}</p>
  <h1 class="form-title">${title}<span class="latin-accent"> ${isEmail ? 'Email' : 'SMS'}</span></h1>
  <p class="form-sub">验证码已发送至 ${esc(target)}，10 分钟内有效。输入后即完成绑定。</p>
  ${noticeBox(notice)}
  ${devCodeBox(devCode)}
  ${errorBox(error)}
  <form method="post" action="/setup-2fa/${esc(method)}">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="code">6 位验证码</label>
      <input id="code" name="code" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
    </div>
    <button class="btn btn-primary btn-block" type="submit">确认绑定</button>
  </form>
  <form method="post" action="/setup-2fa/${esc(method)}/send" class="resend-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    ${recaptchaBox()}
    <button class="btn-link" type="submit">重新发送验证码</button>
  </form>
  <p class="form-foot">账号：${esc(username)} · <a class="link-slide" href="/setup-2fa">改用其他方式</a></p>
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

// 账号设置（用户中心）：头像上传 / 更换 / 删除 + 账号信息概览。
// 头像为上传后裁剪的 256×256 WebP；无头像时渲染用户名首字母占位，不依赖外部头像服务。
function accountPage({
  csrf,
  username = '',
  avatarUrl = '',
  initial = '?',
  emailMasked = '',
  phoneMasked = '',
  mfaLabel = '未绑定',
  lastLogin = '',
  joined = '',
  avatarUpdated = '',
  error = '',
  notice = '',
  homeHref = '/',
  avatarEnabled = true,
}) {
  const imgTag = avatarUrl
    ? `<img class="avatar-img" id="avatarImg" src="${esc(avatarUrl)}" alt="当前头像" width="96" height="96">`
    : `<img class="avatar-img" id="avatarImg" alt="" width="96" height="96" hidden>`;
  const previewScript =
    "(function(){var i=document.getElementById('avatarInput'),img=document.getElementById('avatarImg'),ini=document.getElementById('avatarInitial'),n=document.getElementById('fileName'),f=document.getElementById('avatarForm'),b=f&&f.querySelector('button[type=submit]'),u=null;" +
    "if(!i)return;" +
    "f.addEventListener('submit',function(){if(b){b.disabled=true;b.textContent='上传中…';}});" +
    "i.addEventListener('change',function(){var file=i.files&&i.files[0];if(!file)return;" +
    "if(n)n.textContent=file.name;" +
    "if(!/^image\\//.test(file.type||'')){if(n)n.textContent=file.name+'（不是图片）';return;}" +
    "if(u)URL.revokeObjectURL(u);u=URL.createObjectURL(file);" +
    "if(img){img.hidden=false;img.src=u;}if(ini){ini.hidden=true;}});" +
    '})();';

  const uploadBlock = avatarEnabled
    ? `<form id="avatarForm" method="post" action="/account/avatar" enctype="multipart/form-data" data-no-guard>
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <div class="avatar-file">
          <input id="avatarInput" name="avatar" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" class="visually-hidden">
          <label class="btn btn-ghost btn-sm" for="avatarInput">选择图片</label>
          <span class="file-name" id="fileName">未选择文件</span>
        </div>
        <button class="btn btn-primary btn-block" type="submit">上传头像</button>
      </form>
      <p class="hint">支持 JPG / PNG / WebP / GIF / AVIF，最大 5MB。上传后自动居中裁剪为 256 × 256 并压缩。</p>`
    : `<p class="form-notice" role="status">头像上传暂未开通（存储服务未配置），请联系管理员。</p>`;

  const removeBlock =
    avatarEnabled && avatarUrl
      ? `<form method="post" action="/account/avatar/delete" class="resend-form" data-no-guard>
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn-link" type="submit">移除当前头像</button>
        </form>`
      : '';

  const row = (label, value) =>
    `<p><span class="meta-label">${esc(label)}</span><span class="meta-value">${esc(value || '—')}</span></p>`;

  return layout({
    title: '账号设置',
    content: `
<section class="form-card rise rise-2 form-card-wide">
  <p class="kicker">ACCOUNT / PROFILE</p>
  <h1 class="form-title">账号设置<span class="latin-accent"> Account</span></h1>
  <p class="form-sub">管理你的头像与账号信息。头像会同步到学桥等已接入明旸账号的应用。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <div class="avatar-block rise rise-3">
    <div class="avatar-preview">
      <span class="avatar-initial" id="avatarInitial"${avatarUrl ? ' hidden' : ''}>${esc(initial)}</span>
      ${imgTag}
    </div>
    <div class="avatar-side">
      <p class="field-label">头像</p>
      ${uploadBlock}
      ${removeBlock}
    </div>
  </div>
  <div class="meta-rows rise rise-4">
    ${row('用户名', username)}
    ${row('邮箱', emailMasked)}
    ${row('手机', phoneMasked)}
    ${row('二次验证', mfaLabel)}
    ${row('头像更新', avatarUpdated)}
    ${row('上次登录', lastLogin)}
    ${row('账号创建', joined)}
  </div>
  <div class="dash-actions rise rise-5">
    <a class="btn btn-ghost" href="${esc(homeHref)}">返回应用</a>
    <form method="post" action="/logout">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button class="btn btn-ghost" type="submit">退出登录</button>
    </form>
  </div>
</section>
<script>${previewScript}</script>`,
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

// 忘记密码 · 第一步：输入账号标识（用户名或邮箱），过 Turnstile 防滥用。
function forgotPasswordPage({ csrf, error, notice, account = '' }) {
  return layout({
    title: '忘记密码',
    withTurnstile: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">FORGOT PASSWORD</p>
  <h1 class="form-title">忘记密码<span class="latin-accent"> Reset</span></h1>
  <p class="form-sub">输入你的用户名或注册邮箱，我们会向该账号关联的邮箱发送一封重置密码邮件。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/forgot-password">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="account">用户名或邮箱</label>
      <input id="account" name="account" type="text" value="${esc(account)}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" required autofocus>
      <p class="hint">将用于查找你的账号</p>
    </div>
    ${turnstileBox('forgot')}
    <button class="btn btn-primary btn-block" type="submit">发送重置验证码</button>
  </form>
  <p class="form-foot">想起来了？<a class="link-slide" href="/">返回登录</a></p>
</section>`,
  });
}

// 忘记密码 · 第二步：输入发送至邮箱的 6 位验证码（发码前须过 reCAPTCHA）。
function forgotCodePage({ csrf, error, notice, devCode, target = '', username = '', needSend = false }) {
  if (needSend) {
    return layout({
      title: '重置密码',
      withRecaptcha: true,
      content: `
<section class="form-card rise rise-2">
  <p class="kicker">RESET PASSWORD / EMAIL</p>
  <h1 class="form-title">重置密码<span class="latin-accent"> Email</span></h1>
  <p class="form-sub">验证码将发送至 ${esc(target)}。请先完成人机验证，再点击发送。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/forgot-password/send">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    ${recaptchaBox()}
    <button class="btn btn-primary btn-block" type="submit">发送验证码</button>
  </form>
  <p class="form-foot">账号：${esc(username)} · <a class="link-slide" href="/forgot-password">换个账号</a></p>
</section>`,
    });
  }
  return layout({
    title: '重置密码',
    withRecaptcha: true,
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">RESET PASSWORD / EMAIL</p>
  <h1 class="form-title">重置密码<span class="latin-accent"> Email</span></h1>
  <p class="form-sub">输入发送至 ${esc(target)} 的 6 位验证码，以继续重置密码。</p>
  ${noticeBox(notice)}
  ${devCodeBox(devCode)}
  ${errorBox(error)}
  <form method="post" action="/forgot-password/code">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="code">6 位验证码</label>
      <input id="code" name="code" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
      <p class="hint">验证码 10 分钟内有效</p>
    </div>
    <button class="btn btn-primary btn-block" type="submit">验证并继续</button>
  </form>
  <form method="post" action="/forgot-password/send" class="resend-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    ${recaptchaBox()}
    <button class="btn-link" type="submit">重新发送验证码</button>
  </form>
  <p class="form-foot">账号：${esc(username)} · <a class="link-slide" href="/forgot-password">换个账号</a></p>
</section>`,
  });
}

// 忘记密码 · 第三步：设置新密码（两次输入）。
function resetPasswordPage({ csrf, error, notice }) {
  return layout({
    title: '设置新密码',
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">RESET PASSWORD / NEW</p>
  <h1 class="form-title">设置新密码<span class="latin-accent"> New</span></h1>
  <p class="form-sub">请输入你的新密码。设置成功后，该账号在其他设备上的登录会话将自动失效，需重新登录。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/forgot-password/reset">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="password">新密码</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
      <p class="hint">至少 8 位；建议字母、数字与符号组合</p>
    </div>
    <div class="field">
      <label for="password2">确认新密码</label>
      <input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
    </div>
    <button class="btn btn-primary btn-block" type="submit">重置密码</button>
  </form>
  <p class="form-foot"><a class="link-slide" href="/forgot-password/code">返回上一步</a></p>
</section>`,
  });
}

// 管理员重置后强制改密页（首次登录走此页，改完才放行）。
function changePasswordPage({ csrf, error, notice }) {
  return layout({
    title: '修改密码',
    content: `
<section class="form-card rise rise-2">
  <p class="kicker">SECURITY / CHANGE PASSWORD</p>
  <h1 class="form-title">请设置新密码<span class="latin-accent"> New password</span></h1>
  <p class="form-sub">你的密码已被管理员重置，为保障账号安全，请先设置一个新密码再继续使用。</p>
  ${noticeBox(notice)}
  ${errorBox(error)}
  <form method="post" action="/change-password">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="field">
      <label for="password">新密码</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
      <p class="hint">至少 8 位；建议字母、数字与符号组合</p>
    </div>
    <div class="field">
      <label for="password2">确认新密码</label>
      <input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" maxlength="72" required>
    </div>
    <button class="btn btn-primary btn-block" type="submit">确认修改</button>
  </form>
</section>`,
  });
}

module.exports = {
  esc,
  loginPage,
  forgotPasswordPage,
  forgotCodePage,
  resetPasswordPage,
  changePasswordPage,
  twofaPage,
  registerPage,
  setup2faPage,
  setupChoosePage,
  setupCodePage,
  dashboardPage,
  accountPage,
  messagePage,
};
