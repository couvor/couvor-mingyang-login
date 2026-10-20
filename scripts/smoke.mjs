// loginapp（MySQL 版）冒烟测试：不依赖真实口令，覆盖会话/限频/注册/SSO/忘记密码的读写路径
const BASE = 'http://127.0.0.1:3101';
let cookie = '';
const results = [];

function setCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0];
    if (kv.startsWith('mysid=')) cookie = kv;
  }
}

async function req(path, { method = 'GET', form, json } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  setCookies(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

function csrfOf(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : '';
}

function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

(async () => {
  // 1. 首页：建会话（写 sessions 表）
  let r = await req('/');
  const csrf = csrfOf(r.text);
  check('GET / 200 且下发会话', r.status === 200 && !!cookie && !!csrf, `status=${r.status} csrf=${csrf ? csrf.slice(0, 8) + '…' : '无'}`);

  // 2. 登录失败（不存在用户）：loginLocked 读 + recordLoginFail upsert + 再次读
  r = await req('/login', { method: 'POST', form: { _csrf: csrf, username: 'smoke_no_such_user', password: 'x' } });
  check('POST /login 错误口令被拒', r.status === 401 && /剩余 4 次/.test(r.text), `status=${r.status}`);

  // 3. 再失败一次，验证计数递增（MySQL ON DUPLICATE KEY UPDATE）
  r = await req('/login', { method: 'POST', form: { _csrf: csrf, username: 'smoke_no_such_user', password: 'x' } });
  check('限频计数递增', r.status === 401 && /剩余 3 次/.test(r.text), `status=${r.status}`);

  // 4. 注册页
  r = await req('/register');
  check('GET /register 200', r.status === 200 && /注册/.test(r.text), `status=${r.status}`);

  // 5. 注册新用户（INSERT + lastInsertRowid + rotateSession）
  const uname = 'smoke' + Date.now().toString().slice(-6);
  const csrf2 = csrfOf(r.text);
  r = await req('/register', {
    method: 'POST',
    form: {
      _csrf: csrf2,
      username: uname,
      email: `${uname}@example.com`,
      phone: '139' + String(Date.now()).slice(-8),
      password: 'SmokeTest1234',
      password2: 'SmokeTest1234',
    },
  });
  check('POST /register 成功并跳 /setup-2fa', r.status === 302 && r.location === '/setup-2fa', `status=${r.status} loc=${r.location}`);

  // 6. 绑定选择页（读会话 + users）
  r = await req('/setup-2fa');
  check('GET /setup-2fa 200', r.status === 200 && r.text.includes(uname), `status=${r.status}`);

  // 7. 忘记密码（用户查询）
  r = await req('/forgot-password');
  const csrf3 = csrfOf(r.text);
  r = await req('/forgot-password', {
    method: 'POST',
    form: { _csrf: csrf3, account: 'smoke_no_such_user' },
  });
  check('POST /forgot-password 走「若存在」分支', r.status === 200 && /请查收邮件/.test(r.text), `status=${r.status}`);

  // 8. SSO：非法 client → 400；非法 ticket → 401
  r = await req('/sso/authorize?client_id=bogus&redirect_uri=https%3A%2F%2Fevil.example');
  check('GET /sso/authorize 非法 client 400', r.status === 400 && /请求无效/.test(r.text), `status=${r.status}`);

  r = await req('/sso/verify', { method: 'POST', json: { client_id: 'bogus', client_secret: 'x', ticket: 'y' } });
  check('POST /sso/verify 非法票据 401', r.status === 401, `status=${r.status} body=${r.text.slice(0, 40)}`);

  // 9. 健康检查
  r = await req('/healthz');
  check('GET /healthz ok', r.status === 200 && r.text.trim() === 'ok');

  const failed = results.filter((x) => !x.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('冒烟脚本异常:', e);
  process.exit(2);
});
