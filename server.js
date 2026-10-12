'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const config = require('./config');
const { db, nowIso, cleanupExpiredSessions } = require('./lib/db');
const {
  createSession, getSession, rotateSession, destroySession,
  setSessionCookie, clearSessionCookie,
} = require('./lib/session');
const { generateSecret, verifyTotp, otpauthUri } = require('./lib/totp');
const mfa = require('./lib/mfa');
const {
  loginLocked, recordLoginFail, clearLoginFails, registerAllowed, recordRegister,
} = require('./lib/ratelimit');
const { verifyTurnstile } = require('./lib/turnstile');
const { verifyRecaptcha } = require('./lib/recaptcha');
const pages = require('./lib/pages');
const multer = require('multer');
const avatar = require('./lib/avatar');

const app = express();

// 头像图片的来源域名（COS 默认域名或自定义 CDN 域名），用于放宽 CSP 的 img-src。
// 只在真正使用 COS 存储时才放开；本地回退模式图片由本站 /avatar/… 提供，无需额外放行。
const AVATAR_IMG_ORIGIN = (() => {
  if (config.avatar.backend !== 'cos') return '';
  try {
    return new URL(config.avatar.publicBase).origin;
  } catch {
    return '';
  }
})();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------- 安全响应头 ----------
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      `img-src 'self' data: https://www.gstatic.cn https://www.gstatic.com${AVATAR_IMG_ORIGIN ? ' ' + AVATAR_IMG_ORIGIN : ''}`,
      "style-src 'self' 'unsafe-inline'",
      // 注意：reCAPTCHA 的 api.js 只是一个加载器，真正的渲染引擎 recaptcha__*.js
      // 由它动态注入。走 www.recaptcha.net 时该脚本来自 www.gstatic.cn（国内镜像），
      // 走 www.google.com 时来自 www.gstatic.com —— 两个域名必须同时放行，
      // 否则引擎被 CSP 拦截，grecaptcha.render 不存在，.g-recaptcha 挂件永远空白。
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://www.recaptcha.net https://www.google.com https://www.gstatic.com https://www.gstatic.cn",
      "frame-src https://challenges.cloudflare.com https://www.recaptcha.net https://www.google.com https://www.gstatic.com https://www.gstatic.cn",
      "connect-src https://challenges.cloudflare.com https://www.recaptcha.net https://www.google.com https://www.gstatic.com https://www.gstatic.cn",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ---------- 认证跳转不落缓存 ----------
// SSO 续接/登录跳转的 Location 含一次性票据与 state，被浏览器或中间层缓存会
// 导致重放或「停在旧页面」。对所有 res.redirect 统一追加 no-store。
app.use((req, res, next) => {
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    return redirect(...args);
  };
  next();
});

// ---------- 静态资源 ----------
app.use(
  express.static(require('path').join(__dirname, 'public'), {
    maxAge: '1d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.woff2')) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      }
    },
  })
);

// ---------- 动态响应禁缓存 ----------
// 位于 express.static 之后：静态文件由上面按 maxAge 自带缓存策略（命中即返回、不会走到这里），
// 此中间件只对动态路由（HTML 页面、接口）生效。页面引用的第三方脚本地址/CSP/守卫逻辑
// 随部署演进，HTML 被浏览器缓存会让用户停留在旧版页面（如仍引用被墙的 google.com 版
// api.js、无挂件加载守卫），表现为「复选框不出现、发送必失败」。
app.use((req, res, next) => {
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---------- SSO 辅助（本服务作为 IdP） ----------
const SSO_PENDING_COOKIE = 'sso_pending';

function parseCookies(req) {
  try {
    return Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((p) => p.trim().split('=').map(decodeURIComponent))
        .filter((p) => p.length === 2)
    );
  } catch {
    return {};
  }
}

function ssoPendingFrom(req) {
  const raw = parseCookies(req)[SSO_PENDING_COOKIE];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p.client_id !== 'string' || typeof p.redirect_uri !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

function clearSsoPending(res) {
  res.append(
    'Set-Cookie',
    `${SSO_PENDING_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.session.secure ? '; Secure' : ''}`
  );
}

// 登录成功后若存在待续 SSO 请求，回到 /sso/authorize（参数会重新校验）；否则回 fallback
function ssoResumeOr(res, req, fallback) {
  const p = ssoPendingFrom(req);
  if (!p) return fallback;
  clearSsoPending(res);
  const q = new URLSearchParams({ client_id: p.client_id, redirect_uri: p.redirect_uri });
  if (p.state) q.set('state', p.state);
  return `/sso/authorize?${q.toString()}`;
}

// ---------- 会话装载 ----------
app.use((req, res, next) => {
  const cookies = parseCookies(req);
  let session = getSession(cookies[config.session.cookieName]);
  if (!session) {
    session = createSession(req);
    setSessionCookie(res, session.id);
  }
  req.session = session;
  next();
});

// CSRF 校验（所有 POST）
function csrfGuard(req, res, next) {
  const given = String(req.body._csrf || '');
  const expect = req.session.csrf_token || '';
  const ok =
    given.length === expect.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expect));
  if (!ok) {
    return res.status(403).send(
      pages.messagePage({
        title: '请求被拒绝',
        kicker: 'CSRF / 403',
        message: '表单校验失败，请返回重新提交。',
      })
    );
  }
  next();
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // 基础邮箱格式校验
const PHONE_RE = /^1[3-9]\d{9}$/; // 11 位中国大陆手机号

// 生成 10 个恢复码（明文显示一次；启用后数据库只存哈希）
function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(4).toString('hex') + '-' + crypto.randomBytes(4).toString('hex'));
  }
  return codes;
}

const hashRecovery = (code) => crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');

// 占位哈希：用户不存在时也执行一次 bcrypt 比较，抹平时间差
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-placeholder', config.bcryptRounds);

// ---------- 多因素认证（MFA）：TOTP / 邮箱 / 手机 ----------

// 用户当前启用的二次验证方式。优先取显式 mfa_method；
// 旧库（上线时强制 TOTP）mfa_method 为空，按已验证标志回退推断。
function userMfaMethod(user) {
  if (!user) return null;
  if (user.mfa_method) return user.mfa_method;
  if (user.totp_enabled) return 'totp';
  if (user.email_verified) return 'email';
  if (user.phone_verified) return 'phone';
  return null;
}

// 该方式当前是否可用（邮箱/手机依赖服务商；未配置时生产环境关闭，避免用户被锁死）。
function methodEnabled(method) {
  if (method === 'totp') return true;
  if (method === 'email') return config.mfa.emailEnabled;
  if (method === 'phone') return config.mfa.phoneEnabled;
  return false;
}

// 展示用的脱敏目标（邮箱只留首字符，手机只留前 3 后 4）。
function mfaTarget(user, method) {
  if (method === 'email') {
    const s = String(user.email || '');
    const at = s.indexOf('@');
    if (at <= 0) return s || '你的邮箱';
    return `${s.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(3, at - 1)))}${s.slice(at)}`;
  }
  if (method === 'phone') {
    const s = String(user.phone || '');
    return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s || '你的手机';
  }
  return '';
}

// （原 ensureCode「进页面自动发码」已移除：发码必须先过 reCAPTCHA，见 POST /2fa/send。）

// 绑定成功：写入启用的方式 → 置为已认证 → 续接 SSO 或回默认落地页。
function completeMfaSetup(req, res, user, method) {
  db.prepare('UPDATE users SET mfa_method = ? WHERE id = ?').run(method, user.id);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  // 管理员刚重置过密码 → 强制先改密再放行（force_password_change 由重置端点置位）。
  if (user.force_password_change) {
    req.session = rotateSession(req.session.id, {
      userId: user.id,
      state: 'change_password',
      mfaMethod: method,
    });
    setSessionCookie(res, req.session.id);
    return res.redirect('/change-password');
  }
  req.session = rotateSession(req.session.id, {
    userId: user.id,
    state: 'authed',
    mfaMethod: method,
  });
  setSessionCookie(res, req.session.id);
  const resume = ssoResumeOr(res, req, null);
  res.redirect(resume || config.defaultRedirect);
}

// ---------- 路由 ----------

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// 管理员重置密码（仅本地 + Bearer 令牌，不经 nginx 对外暴露）。
// 由学桥运营后台经 127.0.0.1 直连调用：重置密码 + 清掉 2FA + 强制改密 + 踢掉在线会话。
app.post('/admin/api/reset-password', express.json(), async (req, res) => {
  const token = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!config.adminApiToken || token !== config.adminApiToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const remote = req.socket.remoteAddress || '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ ok: false, error: 'forbidden' });

  const body = req.body || {};
  const uid = parseInt(String(body.ssoSub), 10);
  const newPassword = String(body.newPassword || '');
  if (!Number.isInteger(uid) || newPassword.length < 10) {
    return res.status(400).json({ ok: false, error: 'bad request' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ ok: false, error: 'user not found' });

  const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
  db.prepare(
    `UPDATE users SET password_hash = ?, totp_enabled = 0, mfa_method = NULL,
       totp_secret = NULL, recovery_codes = NULL, force_password_change = 1 WHERE id = ?`
  ).run(hash, uid);
  // 踢掉该用户所有在线会话，强制用新密码重新登录并完成 2FA 重设。
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
  console.log(`[loginapp] admin reset password for user ${uid} (forced 2FA re-setup + password change)`);
  return res.json({ ok: true });
});

// 登录页
app.get('/', (req, res) => {
  const s = req.session;
  if (s.state === 'authed') return res.redirect('/dashboard');
  if (s.state === 'pending_2fa') return res.redirect('/2fa');
  if (s.state === 'setup_2fa') return res.redirect('/setup-2fa');
  if (s.state === 'reset_code') return res.redirect('/forgot-password/code');
  if (s.state === 'reset_set') return res.redirect('/forgot-password/reset');
  if (s.state === 'change_password') return res.redirect('/change-password');
  const loggedOut = req.query.bye === '1';
  const reset = req.query.reset === '1';
  res.send(
    pages.loginPage({
      csrf: s.csrf_token,
      notice: reset ? '密码已重置成功，请使用新密码登录。' : loggedOut ? '已安全退出。' : '',
      error: req.query.locked === '1' ? '尝试过于频繁，账号已临时锁定，请稍后再试。' : '',
    })
  );
});

// 第一步：用户名 + 密码 + Turnstile
app.post('/login', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const { username = '', password = '' } = req.body;
  const ip = req.ip || '';
  const ipUsername = String(username || '').trim().toLowerCase();

  const lock = loginLocked(ip, ipUsername);
  if (lock.locked) {
    return res.redirect('/?locked=1');
  }

  const ts = await verifyTurnstile(req.body['cf-turnstile-response'], ip, 'login');
  if (!ts.ok) {
    return res.status(400).send(
      pages.loginPage({
        csrf: req.session.csrf_token,
        username,
        error: '人机验证未通过，请重试。' + (config.env === 'development' ? ` (${ts.reason})` : ''),
      })
    );
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(ipUsername);
  const hash = user ? user.password_hash : DUMMY_HASH;
  const match = await bcrypt.compare(String(password), hash);

  if (!user || !match) {
    recordLoginFail(ip, ipUsername);
    const after = loginLocked(ip, ipUsername);
    return res.status(401).send(
      pages.loginPage({
        csrf: req.session.csrf_token,
        username,
        error: after.locked
          ? '尝试过于频繁，账号已临时锁定，请 10 分钟后再试。'
          : `用户名或密码不正确（剩余 ${after.remaining} 次尝试）。`,
      })
    );
  }

  clearLoginFails(ip, ipUsername);
  const method = userMfaMethod(user);
  const state = method ? 'pending_2fa' : 'setup_2fa';
  req.session = rotateSession(req.session.id, { userId: user.id, state, mfaMethod: method });
  setSessionCookie(res, req.session.id);
  res.redirect(state === 'pending_2fa' ? '/2fa' : '/setup-2fa');
});

// 强制改密页（仅 change_password 状态可访问；完成后才真正认证放行）。
app.get('/change-password', (req, res) => {
  const s = req.session;
  if (s.state !== 'change_password' || !s.user) return res.redirect('/');
  res.send(pages.changePasswordPage({ csrf: s.csrf_token }));
});

app.post('/change-password', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const s = req.session;
  if (s.state !== 'change_password' || !s.user) return res.redirect('/');
  const newPw = String(req.body.password || '');
  const newPw2 = String(req.body.password2 || '');
  if (newPw.length < 8 || newPw !== newPw2) {
    return res.status(400).send(
      pages.changePasswordPage({ csrf: s.csrf_token, error: '密码至少 8 位，且两次输入需一致。' })
    );
  }
  const hash = await bcrypt.hash(newPw, config.bcryptRounds);
  db.prepare('UPDATE users SET password_hash = ?, force_password_change = 0 WHERE id = ?').run(hash, s.user.id);
  req.session = rotateSession(s.id, { userId: s.user.id, state: 'authed', mfaMethod: s.mfaMethod });
  setSessionCookie(res, req.session.id);
  res.redirect(ssoResumeOr(res, req, config.defaultRedirect));
});

// 第二步：二次验证（按会话记录的 mfa_method 渲染对应页面）
app.get('/2fa', async (req, res) => {
  const s = req.session;
  if (s.state !== 'pending_2fa' || !s.user) return res.redirect('/');
  const method = s.mfa_method || userMfaMethod(s.user) || 'totp';
  const qErr = req.query.e;
  const pageError = qErr === 'robot' ? '人机验证未通过，请重试。' : '';

  if (method === 'totp') {
    return res.send(
      pages.twofaPage({ csrf: s.csrf_token, username: s.user.username, method: 'totp', error: pageError })
    );
  }

  // 邮箱/手机：不再自动发码——必须先通过 Google reCAPTCHA（POST /2fa/send）才会真正发送。
  // 已有未过期验证码（刚发过或刷新页面）时直接显示输入框。
  const hasCode = mfa.hasValidCode(method, s.user.id);
  res.send(
    pages.twofaPage({
      csrf: s.csrf_token,
      username: s.user.username,
      method,
      target: mfaTarget(s.user, method),
      notice: hasCode ? `验证码已发送至 ${mfaTarget(s.user, method)}，10 分钟内有效。` : '',
      error: pageError,
      needSend: !hasCode,
    })
  );
});

// 重发登录验证码（仅邮箱/手机方式）
app.post('/2fa/send', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const s = req.session;
  if (s.state !== 'pending_2fa' || !s.user) return res.redirect('/');
  const method = s.mfa_method || userMfaMethod(s.user);
  if (method !== 'email' && method !== 'phone') return res.redirect('/2fa');

  // 发码会真实消耗邮件 / 短信资源，必须先过 Google reCAPTCHA v2（recaptcha.net），
  // 验证通过之后才真正发送——绝不在验证前发码。
  const ip = req.ip || '';
  const cap = await verifyRecaptcha(req.body['g-recaptcha-response'], ip);
  if (!cap.ok) {
    console.warn('[loginapp] /2fa/send reCAPTCHA 校验失败:', cap.reason, cap.codes || '');
    return res.redirect('/2fa?e=robot');
  }

  let notice = '';
  let devCode = null;
  try {
    const r = await mfa.issueCode(method, s.user);
    notice = `验证码已重新发送至 ${mfaTarget(s.user, method)}。`;
    devCode = r.devCode;
  } catch (e) {
    console.error('[loginapp] 重发验证码失败:', e);
    notice = '验证码发送失败，请稍后重试。';
  }
  res.send(
    pages.twofaPage({
      csrf: s.csrf_token,
      username: s.user.username,
      method,
      target: mfaTarget(s.user, method),
      notice,
      devCode,
    })
  );
});

app.post('/2fa', express.urlencoded({ extended: false }), csrfGuard, (req, res) => {
  const s = req.session;
  // 重复提交（网络抖动引发浏览器重试）：已认证则直接续接去应用，不在站内打转
  if (s.state === 'authed' && s.user_id) {
    return res.redirect(ssoResumeOr(res, req, config.defaultRedirect));
  }
  if (s.state !== 'pending_2fa' || !s.user) return res.redirect('/');
  const ip = req.ip || '';
  const uname = s.user.username;
  const method = s.mfa_method || userMfaMethod(s.user) || 'totp';

  const lock = loginLocked(ip, uname);
  if (lock.locked) return res.redirect('/?locked=1');

  const succeed = () => {
    clearLoginFails(ip, uname);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), s.user.id);
    // 管理员刚重置过密码 → 强制先改密再放行。
    if (s.user.force_password_change) {
      req.session = rotateSession(s.id, { userId: s.user.id, state: 'change_password', mfaMethod: method });
      setSessionCookie(res, req.session.id);
      return res.redirect('/change-password');
    }
    req.session = rotateSession(s.id, { userId: s.user.id, state: 'authed', mfaMethod: method });
    setSessionCookie(res, req.session.id);
    res.redirect(ssoResumeOr(res, req, config.defaultRedirect));
  };

  let ok = false;

  if (method === 'totp') {
    const input = String(req.body.totp || '').trim().toLowerCase();
    if (verifyTotp(s.user.totp_secret, input)) {
      ok = true;
    } else {
      // TOTP 未通过 → 尝试一次性恢复码（存的是 SHA-256 哈希）
      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user.id);
      let codes = [];
      try {
        codes = JSON.parse(fresh.recovery_codes || '[]');
      } catch {}
      const idx = Array.isArray(codes) ? codes.indexOf(hashRecovery(input)) : -1;
      if (idx !== -1) {
        codes.splice(idx, 1); // 用掉即作废
        db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(
          JSON.stringify(codes),
          fresh.id
        );
        ok = true;
      }
    }
  } else {
    const input = String(req.body.code || '').trim();
    if (mfa.verifyCode(method, s.user.id, input)) {
      mfa.consumeCode(method, s.user.id);
      ok = true;
    }
  }

  if (ok) return succeed();

  recordLoginFail(ip, uname);
  const after = loginLocked(ip, uname);
  if (after.locked) {
    destroySession(s.id);
    clearSessionCookie(res);
    return res.redirect('/?locked=1');
  }
  res.status(401).send(
    pages.twofaPage({
      csrf: s.csrf_token,
      username: uname,
      method,
      target: mfaTarget(s.user, method),
      error:
        method === 'totp'
          ? `动态口令不正确（剩余 ${after.remaining} 次尝试）。`
          : `验证码不正确（剩余 ${after.remaining} 次尝试）。`,
    })
  );
});

// 注册
app.get('/register', (req, res) => {
  if (req.session.state === 'authed') return res.redirect('/dashboard');
  res.send(pages.registerPage({ csrf: req.session.csrf_token }));
});

app.post('/register', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  const ip = req.ip || '';

  const fail = (msg, code = 400) =>
    res.status(code).send(
      pages.registerPage({ csrf: req.session.csrf_token, username, email, phone, error: msg })
    );

  if (!registerAllowed(ip)) {
    return fail('该 IP 注册过于频繁，请一小时后再试。', 429);
  }

  const ts = await verifyTurnstile(req.body['cf-turnstile-response'], ip, 'register');
  if (!ts.ok) {
    return fail('人机验证未通过，请重试。' + (config.env === 'development' ? ` (${ts.reason})` : ''));
  }
  if (!USERNAME_RE.test(username)) {
    return fail('用户名需为 3–24 位字母、数字或下划线。');
  }
  if (!EMAIL_RE.test(email)) {
    return fail('请输入有效的邮箱地址。');
  }
  if (!PHONE_RE.test(phone)) {
    return fail('请输入有效的 11 位手机号码。');
  }
  if (password.length < 8 || password.length > 72) {
    return fail('密码长度需在 8–72 位之间。');
  }
  if (password !== password2) {
    return fail('两次输入的密码不一致。');
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return fail('该用户名已被使用，换一个试试。');
  }
  const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (emailExists) {
    return fail('该邮箱已被注册，换一个试试。');
  }
  const phoneExists = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (phoneExists) {
    return fail('该手机号码已被注册，换一个试试。');
  }

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  const result = db
    .prepare('INSERT INTO users (username, password_hash, email, phone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, email, phone, nowIso());
  const userId = Number(result.lastInsertRowid);

  recordRegister(ip);
  // 注册即激活：不再强制邮箱验证，直接进入二次验证绑定（TOTP / 邮箱 / 手机 三选一）。
  // 邮箱归属只在用户主动选择「邮箱验证」作为二次验证方式时才被证实（绑定成功置 email_verified=1）。
  req.session = rotateSession(req.session.id, {
    userId,
    state: 'setup_2fa',
  });
  setSessionCookie(res, req.session.id);
  res.redirect('/setup-2fa');
});

// 二次验证绑定 · 方式选择（TOTP / 邮箱 / 手机）
app.get('/setup-2fa', (req, res) => {
  const s = req.session;
  if (!s.user || !['setup_2fa', 'authed'].includes(s.state)) return res.redirect('/');
  if (userMfaMethod(s.user)) return res.redirect('/dashboard');
  res.send(
    pages.setupChoosePage({
      username: s.user.username,
      email: s.user.email || '',
      phone: s.user.phone || '',
      emailEnabled: config.mfa.emailEnabled,
      phoneEnabled: config.mfa.phoneEnabled,
      error: req.query.e === '1' ? '该方式暂不可用，请选择其他方式。' : '',
    })
  );
});

// 二次验证绑定 · 动态令牌（TOTP）
app.get('/setup-2fa/totp', async (req, res) => {
  const s = req.session;
  if (!s.user || !['setup_2fa', 'authed'].includes(s.state)) return res.redirect('/');
  if (userMfaMethod(s.user)) return res.redirect('/dashboard');

  let secret = s.user.totp_secret;
  if (!secret) {
    secret = generateSecret();
    const codes = generateRecoveryCodes();
    db.prepare('UPDATE users SET totp_secret = ?, recovery_codes = ? WHERE id = ?').run(
      secret,
      JSON.stringify(codes),
      s.user.id
    );
    s.user.totp_secret = secret;
    s.user.recovery_codes = JSON.stringify(codes);
  }

  let codes = [];
  try {
    codes = JSON.parse(s.user.recovery_codes || '[]');
  } catch {
    codes = [];
  }
  if (!Array.isArray(codes) || codes.length === 0) {
    codes = generateRecoveryCodes();
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(
      JSON.stringify(codes),
      s.user.id
    );
  }

  const uri = otpauthUri(secret, s.user.username, '明旸信息');
  const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 352 });

  res.send(
    pages.setup2faPage({
      csrf: s.csrf_token,
      qrDataUrl,
      secret,
      recoveryCodes: codes,
      username: s.user.username,
      error: req.query.e === '1' ? '口令不正确，请重试。' : '',
    })
  );
});

app.post('/setup-2fa/totp', express.urlencoded({ extended: false }), csrfGuard, (req, res) => {
  const s = req.session;
  if (!s.user || !['setup_2fa', 'authed'].includes(s.state)) return res.redirect('/');
  if (userMfaMethod(s.user)) return res.redirect('/dashboard');

  if (!verifyTotp(s.user.totp_secret, req.body.totp)) {
    return res.redirect('/setup-2fa/totp?e=1');
  }

  // 启用：恢复码明文替换为哈希
  let plain = [];
  try {
    plain = JSON.parse(s.user.recovery_codes || '[]');
  } catch {}
  const hashed = (Array.isArray(plain) ? plain : []).map(hashRecovery);
  db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?').run(
    JSON.stringify(hashed),
    s.user.id
  );

  // 有待续 SSO 请求则续接回客户端；否则回默认落地页（默认直接续接学桥 SSO）
  completeMfaSetup(req, res, s.user, 'totp');
});

// 二次验证绑定 · 邮箱 / 手机（发送 + 校验一次性验证码）
app.get('/setup-2fa/:method', async (req, res) => {
  const method = req.params.method;
  if (method !== 'email' && method !== 'phone') return res.redirect('/setup-2fa');
  const s = req.session;
  if (!s.user || !['setup_2fa', 'authed'].includes(s.state)) return res.redirect('/');
  if (userMfaMethod(s.user)) return res.redirect('/dashboard');
  if (!methodEnabled(method)) return res.redirect('/setup-2fa?e=1');

  // 不再自动发码——必须先通过 Google reCAPTCHA（POST /setup-2fa/:method/send）才会真正发送。
  const hasCode = mfa.hasValidCode(method, s.user.id);
  res.send(
    pages.setupCodePage({
      csrf: s.csrf_token,
      method,
      target: mfaTarget(s.user, method),
      username: s.user.username,
      notice: hasCode ? `验证码已发送至 ${mfaTarget(s.user, method)}，10 分钟内有效。` : '',
      error: req.query.e === '1' ? '验证码不正确，请重试。' : req.query.e === 'robot' ? '人机验证未通过，请重试。' : '',
      needSend: !hasCode,
    })
  );
});

app.post('/setup-2fa/:method/send', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const method = req.params.method;
  if (method !== 'email' && method !== 'phone') return res.redirect('/setup-2fa');
  const s = req.session;
  if (!s.user || !['setup_2fa', 'authed'].includes(s.state)) return res.redirect('/');
  if (userMfaMethod(s.user)) return res.redirect('/dashboard');
  if (!methodEnabled(method)) return res.redirect('/setup-2fa?e=1');

  // 发码会真实消耗邮件 / 短信资源，必须先过 Google reCAPTCHA v2（recaptcha.net），
  // 验证通过之后才真正发送——绝不在验证前发码。
  const ip = req.ip || '';
  const cap = await verifyRecaptcha(req.body['g-recaptcha-response'], ip);
  if (!cap.ok) {
    console.warn('[loginapp] /setup-2fa send reCAPTCHA 校验失败:', cap.reason, cap.codes || '');
    return res.redirect(`/setup-2fa/${method}?e=robot`);
  }

  let notice = '';
  let devCode = null;
  try {
    const r = await mfa.issueCode(method, s.user);
    notice = `验证码已重新发送至 ${mfaTarget(s.user, method)}。`;
    devCode = r.devCode;
  } catch (e) {
    console.error('[loginapp] 重发验证码失败:', e);
    notice = '验证码发送失败，请稍后重试。';
  }
  res.send(
    pages.setupCodePage({
      csrf: s.csrf_token,
      method,
      target: mfaTarget(s.user, method),
      username: s.user.username,
      notice,
      devCode,
    })
  );
});

app.post('/setup-2fa/:method', express.urlencoded({ extended: false }), csrfGuard, (req, res) => {
  const method = req.params.method;
  if (method !== 'email' && method !== 'phone') return res.redirect('/setup-2fa');
  const s = req.session;
  if (!s.user || !['setup_2fa', 'authed'].includes(s.state)) return res.redirect('/');
  if (userMfaMethod(s.user)) return res.redirect('/dashboard');
  if (!methodEnabled(method)) return res.redirect('/setup-2fa?e=1');

  const input = String(req.body.code || '').trim();
  if (!mfa.verifyCode(method, s.user.id, input)) {
    return res.redirect(`/setup-2fa/${method}?e=1`);
  }
  mfa.consumeCode(method, s.user.id);
  db.prepare(`UPDATE users SET ${method}_verified = 1 WHERE id = ?`).run(s.user.id);
  completeMfaSetup(req, res, s.user, method);
});

// 本服务不设独立控制台：认证完成后一律续接回应用（默认落地），
// 避免用户停在"登录成功"中间页成为死胡同；任何中断后刷新/回来都会自动续接。
app.get('/dashboard', (req, res) => {
  const s = req.session;
  if (s.state === 'setup_2fa') return res.redirect('/setup-2fa');
  if (s.state === 'pending_2fa') return res.redirect('/2fa');
  if (s.state !== 'authed' || !s.user_id) return res.redirect('/');
  res.redirect(config.defaultRedirect);
});

// ---------- 账号设置：用户自行上传 / 更换 / 移除头像 ----------

// 上传解析：只走内存（后续由 sharp 处理再落存储），大小与数量双重限制。
// nginx 侧 client_max_body_size 10m 已放宽，这里再按 5MB 收紧。
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.avatar.maxBytes, files: 1, fields: 8 },
});

// 失败原因码 → 用户可读提示（内部错误细节只进日志，不回显到页面）
const AVATAR_ERRORS = {
  nofile: '请先选择一张图片。',
  toobig: '图片超过 5MB，请压缩后再试。',
  type: '仅支持 JPG / PNG / WebP / GIF / AVIF 格式的图片。',
  rate: '上传过于频繁，请稍后再试。',
  fail: '头像上传失败，请稍后再试。',
};

function requireAuthed(req, res, next) {
  const s = req.session;
  if (s.state !== 'authed' || !s.user_id) return res.redirect('/');
  next();
}

const pad2 = (n) => String(n).padStart(2, '0');

// ISO 时间 → 2026.10.11 09:30（服务器时区；与站内其它页面保持一致）
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function accountView(req, res, { notice = '', error = '' } = {}) {
  const s = req.session;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!user) return res.redirect('/');
  const method = userMfaMethod(user);
  const mfaLabel =
    method === 'totp' ? '动态令牌（TOTP）'
    : method === 'email' ? '邮箱验证'
    : method === 'phone' ? '手机验证'
    : '未绑定';
  res.send(
    pages.accountPage({
      csrf: s.csrf_token,
      username: user.username,
      avatarUrl: user.avatar_url || '',
      initial: avatar.initialOf(user.username),
      emailMasked: user.email ? mfaTarget(user, 'email') : '',
      phoneMasked: user.phone ? mfaTarget(user, 'phone') : '',
      mfaLabel,
      lastLogin: fmtDateTime(user.last_login_at),
      joined: fmtDateTime(user.created_at),
      avatarUpdated: fmtDateTime(user.avatar_updated_at),
      homeHref: config.defaultRedirect,
      avatarEnabled: true,
      notice,
      error,
    })
  );
}

app.get('/account', requireAuthed, (req, res) => {
  const ok = String(req.query.ok || '');
  const code = String(req.query.e || '');
  const notice = ok === '1' ? '头像已更新，已同步到接入的应用。' : ok === 'removed' ? '已移除头像。' : '';
  accountView(req, res, { notice, error: AVATAR_ERRORS[code] || '' });
});

app.post(
  '/account/avatar',
  requireAuthed,
  avatarUpload.single('avatar'),
  csrfGuard,
  async (req, res) => {
    const userId = req.session.user_id;
    try {
      const saved = await avatar.saveAvatar(userId, req.file && req.file.buffer);
      const prev = db.prepare('SELECT avatar_key FROM users WHERE id = ?').get(userId);
      db.prepare(
        'UPDATE users SET avatar_url = ?, avatar_key = ?, avatar_updated_at = ? WHERE id = ?'
      ).run(saved.url, saved.key, nowIso(), userId);
      // 先写新后删旧：清理失败不影响用户已换好的头像
      avatar.removeAfterReplace(prev && prev.avatar_key);
      res.redirect('/account?ok=1');
    } catch (err) {
      const code = err && err.code ? err.code : 'fail';
      if (code === 'fail') console.error('[loginapp] 头像上传失败:', err);
      res.redirect(`/account?e=${encodeURIComponent(code)}`);
    }
  }
);

app.post('/account/avatar/delete', requireAuthed, csrfGuard, (req, res) => {
  const userId = req.session.user_id;
  const row = db.prepare('SELECT avatar_key FROM users WHERE id = ?').get(userId);
  db.prepare('UPDATE users SET avatar_url = NULL, avatar_key = NULL, avatar_updated_at = ? WHERE id = ?')
    .run(nowIso(), userId);
  avatar.removeAfterReplace(row && row.avatar_key);
  res.redirect('/account?ok=removed');
});

// 本地回退存储的图片读取（COS 模式不会命中此路由）。
// 文件名由服务端生成（<userId>-<24 位 hex>.webp），校验正则后读盘，杜绝路径穿越。
app.get('/avatar/:name', async (req, res, next) => {
  const buf = await avatar.readLocal(String(req.params.name || ''));
  if (!buf) return next();
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

// 退出
// 退出后回跳白名单（防开放重定向）：仅允许已登记的 SSO 客户端站点
const LOGOUT_NEXT_ALLOWLIST = new Set(['https://x.mingyanginfo.com']);

function safeLogoutNext(raw) {
  try {
    const u = new URL(raw);
    if (LOGOUT_NEXT_ALLOWLIST.has(u.origin)) return u.toString();
  } catch {}
  return null;
}

app.post('/logout', express.urlencoded({ extended: false }), csrfGuard, (req, res) => {
  destroySession(req.session.id);
  clearSessionCookie(res);
  res.redirect('/?bye=1');
});
app.get('/logout', (req, res) => {
  destroySession(req.session.id);
  clearSessionCookie(res);
  // SSO 客户端退出联动：清掉本站会话后回跳客户端（白名单校验）
  const next = safeLogoutNext(String(req.query.next || ''));
  res.redirect(next || '/?bye=1');
});

// ---------- 忘记密码：站内三步流程（账号标识 → 邮箱验证码 → 设新密码） ----------
// 全程复用既有安全机制：第一步 Turnstile 防滥用；发码前 Google reCAPTCHA（消耗邮件资源）；
// 重置验证码独立存列，不与登录/绑定的 email_code_* 混淆；通过后踢掉该用户所有已登录会话。

function resetUserId(req) {
  const v = req.session && req.session.reset_user_id;
  return typeof v === 'number' ? v : null;
}

// 第一步：输入账号标识（用户名或邮箱）
app.get('/forgot-password', (req, res) => {
  const s = req.session;
  if (s.state === 'authed') return res.redirect('/dashboard');
  if (s.state === 'reset_code') return res.redirect('/forgot-password/code');
  if (s.state === 'reset_set') return res.redirect('/forgot-password/reset');
  res.send(pages.forgotPasswordPage({ csrf: s.csrf_token }));
});

app.post('/forgot-password', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const s = req.session;
  if (s.state === 'authed') return res.redirect('/dashboard');
  const ip = req.ip || '';
  const ident = String(req.body.account || '').trim().toLowerCase();

  const ts = await verifyTurnstile(req.body['cf-turnstile-response'], ip, 'forgot');
  if (!ts.ok) {
    return res.status(400).send(
      pages.forgotPasswordPage({
        csrf: s.csrf_token,
        account: ident,
        error: '人机验证未通过，请重试。' + (config.env === 'development' ? ` (${ts.reason})` : ''),
      })
    );
  }

  // 防账号枚举：无论账号是否存在，统一提示「已发送（若存在）」。
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(ident, ident);
  if (!user || !user.email) {
    return res.send(
      pages.messagePage({
        title: '请查收邮件',
        kicker: 'RESET PASSWORD',
        message: '如果该账号（用户名或邮箱）存在于我们的系统，我们已向其关联的邮箱发送了一封重置密码邮件。邮件有效期 10 分钟。如未收到，请确认填写的账号无误或稍后重试。',
        backHref: '/forgot-password',
        backText: '重新填写',
      })
    );
  }

  // 进入待校验态，记录归属用户；发码延迟到用户点「发送验证码」（先过 reCAPTCHA，
  // 避免无谓消耗邮件资源，与注册验证邮件「先验证、后发码」的范式一致）。
  req.session = rotateSession(s.id, { state: 'reset_code' });
  db.prepare('UPDATE sessions SET reset_user_id = ? WHERE id = ?').run(user.id, req.session.id);
  setSessionCookie(res, req.session.id);
  res.redirect('/forgot-password/code');
});

// 第二步：输入验证码
app.get('/forgot-password/code', (req, res) => {
  const s = req.session;
  if (s.state === 'authed') return res.redirect('/dashboard');
  const uid = resetUserId(req);
  if (s.state !== 'reset_code' || !uid) return res.redirect('/forgot-password');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.redirect('/forgot-password');
  const needSend = !mfa.hasValidResetCode(user.id);
  const pageError = req.query.e === 'robot' ? '人机验证未通过，请重试。' : '';
  res.send(
    pages.forgotCodePage({
      csrf: s.csrf_token,
      username: user.username,
      target: mfaTarget(user, 'email'),
      needSend,
      error: pageError,
    })
  );
});

// 重发重置验证码（消耗邮件资源，必须先过 reCAPTCHA）
app.post('/forgot-password/send', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const s = req.session;
  const uid = resetUserId(req);
  if (s.state !== 'reset_code' || !uid) return res.redirect('/forgot-password');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.redirect('/forgot-password');

  const ip = req.ip || '';
  const cap = await verifyRecaptcha(req.body['g-recaptcha-response'], ip);
  if (!cap.ok) {
    console.warn('[loginapp] /forgot-password/send reCAPTCHA 校验失败:', cap.reason, cap.codes || '');
    return res.redirect('/forgot-password/code?e=robot');
  }

  let notice = '';
  let devCode = null;
  try {
    const r = await mfa.issueResetCode(user);
    notice = `验证码已重新发送至 ${mfaTarget(user, 'email')}。`;
    devCode = r.devCode;
  } catch (e) {
    console.error('[loginapp] 重置密码重发验证码失败:', e);
    notice = '验证码发送失败，请稍后重试。';
  }
  res.send(
    pages.forgotCodePage({
      csrf: s.csrf_token,
      username: user.username,
      target: mfaTarget(user, 'email'),
      notice,
      devCode,
    })
  );
});

app.post('/forgot-password/code', express.urlencoded({ extended: false }), csrfGuard, (req, res) => {
  const s = req.session;
  const uid = resetUserId(req);
  if (s.state !== 'reset_code' || !uid) return res.redirect('/forgot-password');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.redirect('/forgot-password');

  const input = String(req.body.code || '').trim();
  if (!mfa.verifyResetCode(user.id, input)) {
    return res.status(400).send(
      pages.forgotCodePage({
        csrf: s.csrf_token,
        username: user.username,
        target: mfaTarget(user, 'email'),
        error: '验证码不正确或已过期，请重试。',
      })
    );
  }

  mfa.consumeResetCode(user.id);
  // 通过校验：进入「待设新密码」态，并记录归属用户。
  req.session = rotateSession(s.id, { state: 'reset_set' });
  db.prepare('UPDATE sessions SET reset_user_id = ? WHERE id = ?').run(uid, req.session.id);
  setSessionCookie(res, req.session.id);
  res.redirect('/forgot-password/reset');
});

// 第三步：设置新密码
app.get('/forgot-password/reset', (req, res) => {
  const s = req.session;
  if (s.state === 'authed') return res.redirect('/dashboard');
  const uid = resetUserId(req);
  if (s.state !== 'reset_set' || !uid) return res.redirect('/forgot-password');
  res.send(pages.resetPasswordPage({ csrf: s.csrf_token }));
});

app.post('/forgot-password/reset', express.urlencoded({ extended: false }), csrfGuard, async (req, res) => {
  const s = req.session;
  const uid = resetUserId(req);
  if (s.state !== 'reset_set' || !uid) return res.redirect('/forgot-password');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.redirect('/forgot-password');

  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');

  const fail = (msg) =>
    res.status(400).send(pages.resetPasswordPage({ csrf: s.csrf_token, error: msg }));

  if (password.length < 8 || password.length > 72) {
    return fail('密码长度需在 8–72 位之间。');
  }
  if (password !== password2) {
    return fail('两次输入的密码不一致。');
  }

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  db.prepare('UPDATE users SET password_hash = ?, reset_code_hash = NULL, reset_code_expires = NULL WHERE id = ?').run(
    hash,
    uid
  );
  // 安全：重置成功后使该用户所有已登录会话失效，强制重新登录。
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
  destroySession(s.id);
  clearSessionCookie(res);
  res.redirect('/?reset=1');
});

// ---------- SSO：作为 IdP 为学桥等客户端提供登录 ----------

// 引导入口：校验 client 与回调白名单；未登录先走本站登录（密码 + TOTP），已登录签发一次性票据
app.get('/sso/authorize', (req, res) => {
  const clientId = String(req.query.client_id || '');
  const redirectUri = String(req.query.redirect_uri || '');
  const state = String(req.query.state || '').slice(0, 200);

  const client = db.prepare('SELECT * FROM sso_clients WHERE client_id = ?').get(clientId);
  const allowed = client
    ? client.redirect_uris.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (!client || !allowed.includes(redirectUri)) {
    return res.status(400).send(
      pages.messagePage({
        title: '请求无效',
        kicker: 'SSO / 400',
        message: '登录请求无效：client_id 或回调地址不在白名单内。',
      })
    );
  }

  const s = req.session;
  if (s.state !== 'authed' || !s.user_id) {
    // 记录待续请求（1 小时有效，覆盖注册 + 绑定 2FA 的耗时），登录成功后自动回到本端点
    const pending = JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state });
    res.append(
      'Set-Cookie',
      `${SSO_PENDING_COOKIE}=${encodeURIComponent(pending)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${config.session.secure ? '; Secure' : ''}`
    );
    return res.redirect('/');
  }

  // 签发 60 秒一次性票据并回跳客户端
  const ticket = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO sso_tickets (ticket, client_id, user_id, redirect_uri, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(ticket, clientId, s.user_id, redirectUri, expires);

  const u = new URL(redirectUri);
  u.searchParams.set('ticket', ticket);
  if (state) u.searchParams.set('state', state);
  res.redirect(u.toString());
});

// 服务端换身份（客户端 → 本服务，不经浏览器；失败一律 401 不区分原因）
app.post('/sso/verify', express.json({ limit: '4kb' }), (req, res) => {
  const ip = req.ip || '';
  const body = req.body || {};
  const clientId = String(body.client_id || '');
  const secret = String(body.client_secret || '');
  const ticket = String(body.ticket || '');

  const rateKey = `sso:${clientId}`;
  if (loginLocked(ip, rateKey).locked) {
    return res.status(429).json({ error: 'rate-limited' });
  }
  const deny = () => {
    recordLoginFail(ip, rateKey);
    return res.status(401).json({ error: 'invalid' });
  };

  const client = db.prepare('SELECT * FROM sso_clients WHERE client_id = ?').get(clientId);
  if (!client) return deny();

  const given = crypto.createHash('sha256').update(secret).digest('hex');
  const stored = client.client_secret_hash || '';
  const secretOk =
    given.length === stored.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(stored));
  if (!secretOk) return deny();

  const t = db.prepare('SELECT * FROM sso_tickets WHERE ticket = ?').get(ticket);
  if (!t || t.client_id !== clientId || t.used || t.expires_at < nowIso()) return deny();

  const upd = db.prepare('UPDATE sso_tickets SET used = 1 WHERE ticket = ? AND used = 0').run(ticket);
  if (upd.changes !== 1) return deny();

  const user = db.prepare('SELECT id, username, avatar_url, email, phone, email_verified, phone_verified FROM users WHERE id = ?').get(t.user_id);
  if (!user) return deny();

  clearLoginFails(ip, rateKey);
  // avatarUrl 为可直接访问的绝对地址（COS 或本站 /avatar/…），无头像时为 null
  // email/phone：仅在对应渠道已验证时才可信，客户端（如学桥）应校验 *_verified 后再落库
  res.json({
    sub: String(user.id),
    username: user.username,
    displayName: user.username,
    avatarUrl: user.avatar_url || null,
    email: user.email || null,
    emailVerified: !!user.email_verified,
    phone: user.phone || null,
    phoneVerified: !!user.phone_verified,
  });
});

// 上传解析错误（超大文件、字段过多等）统一转成账号页提示，避免直接抛 500
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'toobig' : 'fail';
    return res.redirect(`/account?e=${code}`);
  }
  return next(err);
});

// 404 / 500
app.use((req, res) => {
  res.status(404).send(
    pages.messagePage({
      title: '页面不存在',
      kicker: '404 / NOT FOUND',
      message: '你访问的页面不存在或已被移动。',
    })
  );
});
app.use((err, req, res, next) => {
  console.error('[loginapp] error:', err);
  if (res.headersSent) return next(err);
  res.status(500).send(
    pages.messagePage({
      title: '服务暂时不可用',
      kicker: '500 / ERROR',
      message: '服务器开小差了，请稍后再试。',
    })
  );
});

// 会话/限频窗口定期清理
setInterval(cleanupExpiredSessions, 30 * 60 * 1000).unref();

app.listen(config.port, '127.0.0.1', () => {
  const ts = config.turnstile.live ? 'LIVE' : 'TEST';
  console.log(`[loginapp] listening on 127.0.0.1:${config.port} (env=${config.env}, turnstile=${ts})`);
  // 只打印后端类型与桶名，绝不打印密钥
  console.log(
    `[loginapp] avatar storage: ${config.avatar.backend}` +
      (config.avatar.backend === 'cos'
        ? ` (bucket=${config.avatar.bucket}, region=${config.avatar.region})`
        : ` (dir=${config.avatar.localDir})`)
  );
  if (!config.turnstile.live && process.env.TURNSTILE_SITE_KEY) {
    console.warn('[loginapp] TURNSTILE_SITE_KEY 已配置但 secret 未填（占位符），已回退测试密钥。请编辑 /etc/loginapp.env 填入 TURNSTILE_SECRET_KEY。');
  }
});
