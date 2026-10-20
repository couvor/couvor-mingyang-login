// 端到端验证「注册 → 绑定 TOTP → 完成登录」这条最关键的写入链路
import crypto from 'crypto';
import mysql from 'mysql2/promise';

const BASE = 'http://127.0.0.1:3101';
let cookie = '';

function setCookies(res) {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('mysid=')) cookie = kv;
  }
}

async function req(path, { method = 'GET', form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  setCookies(res);
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1] || '';

// RFC 6238 TOTP（6 位、30 秒、SHA1），与 lib/totp.js 的默认参数一致
function totp(secretBase32, t = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(t / 30000), 4);
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

(async () => {
  const uname = 'smoketotp' + Date.now().toString().slice(-6);
  let r = await req('/register');
  r = await req('/register', {
    method: 'POST',
    form: {
      _csrf: csrfOf(r.text),
      username: uname,
      email: `${uname}@example.com`,
      phone: '138' + String(Date.now()).slice(-8),
      password: 'SmokeTest1234',
      password2: 'SmokeTest1234',
    },
  });
  if (r.status !== 302) throw new Error('注册失败: ' + r.status);

  r = await req('/setup-2fa/totp');
  if (r.status !== 200) throw new Error('绑定页失败: ' + r.status);

  const db = await mysql.createConnection({
    host: '127.0.0.1',
    port: Number(process.env.DB_PORT || 13307),
    user: process.env.DB_USER || 'loginapp',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'loginapp',
  });
  const [[u]] = await db.query('SELECT id, totp_secret, recovery_codes FROM users WHERE username = ?', [uname]);
  if (!u || !u.totp_secret) throw new Error('未写入 totp_secret');
  console.log(`✓ 生成并落库 totp_secret（长度 ${u.totp_secret.length}），恢复码 ${JSON.parse(u.recovery_codes || '[]').length} 条`);

  const code = totp(u.totp_secret);
  r = await req('/setup-2fa/totp', { method: 'POST', form: { _csrf: csrfOf(r.text), totp: code } });
  console.log(`  POST /setup-2fa/totp -> ${r.status} ${r.location || ''}`);
  if (r.status !== 302) throw new Error('绑定失败: ' + r.status);

  const [[after]] = await db.query(
    'SELECT totp_enabled, mfa_method, last_login_at, recovery_codes FROM users WHERE id = ?',
    [u.id]
  );
  const ok =
    after.totp_enabled === 1 &&
    after.mfa_method === 'totp' &&
    !!after.last_login_at &&
    JSON.parse(after.recovery_codes)[0].length === 64; // 明文已替换为 sha256
  console.log(`${ok ? '✓' : '✗'} 绑定结果：totp_enabled=${after.totp_enabled} mfa_method=${after.mfa_method} 恢复码已哈希=${JSON.parse(after.recovery_codes)[0].length === 64}`);

  const [[sess]] = await db.query(
    "SELECT state, user_id FROM sessions WHERE id = ?",
    [cookie.replace('mysid=', '')]
  );
  console.log(`${sess && sess.state === 'authed' ? '✓' : '✗'} 会话状态=${sess && sess.state} user_id=${sess && sess.user_id}`);

  r = await req('/dashboard');
  console.log(`${r.status === 302 ? '✓' : '✗'} GET /dashboard -> ${r.status} ${r.location || ''}`);

  await db.end();
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error('✗ 异常:', e.message);
  process.exit(2);
});
