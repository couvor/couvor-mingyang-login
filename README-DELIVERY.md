# 登录系统交付说明 — login.mingyanginfo.com

技术栈：Node.js 24.21 + Express + 内置 node:sqlite，systemd 托管，宝塔 nginx 反代。
设计系统按《明旸信息设计规范》复刻（暗色默认 / 品牌蓝 / 自托管字体 / 无图标库）。
**状态：2026-10-09 正式上线**（HTTPS + ICP 备案号页脚 + 公开访问）。

## 一、架构与路径速查

| 项 | 位置 |
|---|---|
| 应用代码 | `/www/wwwroot/login.mingyanginfo.com/`（属主 www） |
| 数据库 | `/var/lib/loginapp/app.db`（SQLite，属主 www） |
| systemd 服务 | `loginapp.service`，监听 `127.0.0.1:3000` |
| 环境配置 | `/etc/loginapp.env`（600 权限：Turnstile 密钥、COOKIE_SECURE=1） |
| nginx vhost | `/www/server/panel/vhost/nginx/login.mingyanginfo.com.conf` |
| 证书 | `/www/server/panel/vhost/cert/login.mingyanginfo.com/`（LE，acme.sh 自动续期） |
| ACME 验证目录 | `/www/wwwroot/login.mingyanginfo.com/.well-known/acme-challenge/` |
| 访问日志 | `/www/wwwlogs/login.mingyanginfo.com.log` |

常用命令：
```bash
systemctl status loginapp          # 状态
journalctl -u loginapp -f          # 实时日志
systemctl restart loginapp         # 改配置后重启
```

## 二、Turnstile（已配置完成，LIVE 模式）

正式密钥在 `/etc/loginapp.env`。前端挂 `data-action`（login/register），
服务端 siteverify 强校验 action 一致。小组件域名列表需包含 `login.mingyanginfo.com`。

## 三、HTTPS 与上线状态（2026-10-09）

- DNS：Cloudflare `login` A 记录 → 150.158.55.8（灰云直连）
- 证书：Let's Encrypt（acme.sh，HTTP-01 webroot），有效期至 2027-01-07，
  cron 每天 4 次检查续期 + `--reloadcmd` 自动 reload nginx
- vhost：80 仅留 ACME 验证、其余 301 → 443（TLS1.2/1.3 + HTTP/2 + HSTS）
- `COOKIE_SECURE=1` 已启用；页脚挂备案号 陕ICP备2026028201号（链接工信部）
- 备案期 Basic Auth 门禁已于上线时移除；凭证备份 `/root/loginapp-basic-auth.txt` 仍在，
  如需临时再封锁站点，在 vhost 的 443 server 段加回
  `satisfy any; allow 127.0.0.1; deny all; auth_basic ...; auth_basic_user_file /www/server/nginx/conf/loginapp.htpasswd;`
  后 reload nginx

## 四、Cloudflare 首页的"登录"跳转片段

```html
<a class="btn btn-primary" href="https://login.mingyanginfo.com/">登录</a>
```

## 五、SSO 身份提供方（2026-10-09 上线，为学桥提供登录）

本服务兼任学桥（x.mingyanginfo.com）的 SSO IdP：用户在明旸账号注册一次、绑定一次 2FA，
客户端通过一次性票据换取身份。

- 表：`sso_clients`（client_id / client_secret_hash=sha256 / redirect_uris 白名单）、
  `sso_tickets`（32B 随机 ticket、60 秒有效、用后即焚、绑定 client 与回调）
- 端点：`GET /sso/authorize`（校验白名单 → 未登录跳本站登录，登录后自动续接 → 已登录签发
  ticket 回跳）；`POST /sso/verify`（`{ticket, client_id, client_secret}` → 常数时间比对、
  失败一律 401、按 client+IP 限频）
- 续接机制：未登录时下发 `sso_pending` cookie（**1 小时**有效，覆盖注册 + 绑定 2FA 耗时），
  密码 + TOTP 或注册绑定完成后自动回到 `/sso/authorize`
- **无独立控制台（2026-10-09）**：认证完成后访问 `/`、`/dashboard` 一律立即续接回应用
  （`SSO_DEFAULT_REDIRECT`）——不存在「登录成功」中间页，任何网络中断后刷新/重进都会自动续接自愈
- 默认落地：无待续上下文（直接访问本站、换浏览器等）的注册/登录完成后，跳
  `SSO_DEFAULT_REDIRECT`（在 `/etc/loginapp.env`，当前 = `https://x.mingyanginfo.com/api/auth/sso/start`，
  即无缝续接学桥 SSO、直接把用户送入学桥；改回普通落地页只需改这个值）
- 新增客户端：向 `sso_clients` 插入一行（`redirect_uris` 逗号分隔、精确匹配），
  把明文 secret（随机 64 hex）交给对应站点写入其 `.env`（本服务只存哈希）
- 轮换 secret：更新 `client_secret_hash` + 客户端站点 `.env` + 双方重启
- **联动登出**：`GET /logout?next=<客户端地址>` 支持退出后回跳（白名单校验，当前仅允许
  `https://x.mingyanginfo.com`，防开放重定向）；学桥退出时会先跳这里销毁本站会话

## 六、二次验证（MFA）：TOTP / 邮箱 / 手机 三选一（2026-10-10）

首次登录（注册后）进入方式选择页，任选一种完成绑定；绑定后每次登录都用该方式校验。
用户的启用方式记在 `users.mfa_method`（`totp` / `email` / `phone`），旧库为空时按
`totp_enabled` 回退为 `totp`，老用户无需重新绑定。

- 端点：
  - `GET /setup-2fa` 方式选择页；`GET|POST /setup-2fa/totp` 绑定动态令牌（二维码 + 恢复码）；
  - `GET|POST /setup-2fa/email`、`GET|POST /setup-2fa/phone` 绑定邮箱 / 手机；
  - `POST /setup-2fa/:method/send` 重发绑定验证码；
  - 登录第二步 `GET /2fa`（按方式渲染）、`POST /2fa`（校验）、`POST /2fa/send`（重发验证码）。
- 验证码：6 位数字，SHA-256 哈希落库、10 分钟有效；邮箱 / 手机各存一列哈希与过期时间。
  进入页面时若已有未过期验证码则不再重复发送。
- 目标脱敏展示：邮箱 `u***@domain`、手机 `139****0001`。
- **开发/测试回显**：`NODE_ENV=development` 或 `MOCK_2FA=1` 时验证码打印到服务端控制台，
  并在页面上回显（`code-echo`），便于本地走通流程；生产环境不回显。
### 6.1 腾讯云邮件（SES 邮件推送）与短信（SMS）接入（2026-10-10）

邮箱验证码走腾讯云 **SES 邮件推送** `SendEmail`（Simple，HTML/Text 均 base64 编码），
手机验证码走腾讯云 **SMS 短信** `SendSms`。SDK 为官方模块化包，已在 `package.json` 中声明：

```
tencentcloud-sdk-nodejs-ses
tencentcloud-sdk-nodejs-sms
```

**控制台准备（一次性）**

- 短信 SMS：开通「短信」→ 创建应用拿到 `SdkAppId` → 申请**签名**（如「明旸信息」，需资质审核）
  → 申请**验证码类模板**拿到 `TemplateId`，模板含 `{1}` 验证码、`{2}` 有效分钟数
  → 购买套餐包（国内验证码短信需实名套餐）。
- 邮件 SES：开通「邮件推送」→ 添加并**验证发信域名 / 发信地址**（`noreply@mail.mingyanginfo.com`）
  → 按指引配置 SPF、DKIM（未验证将报错 `NoSuchSender`）。
- 密钥：在访问管理 CAM 创建子账号密钥 `SecretId` / `SecretKey`，**仅授予** `QcloudSMSFullAccess`
  与 SES 发信相关策略，不要用主账号密钥。

**环境变量（`/etc/loginapp.env`，写入后 `systemctl restart loginapp`）**

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | CAM API 密钥（SES 与 SMS 共用） | `AKIDxxxx` |
| `TENCENT_SMS_SDK_APP_ID` | 短信应用 SdkAppId | `1400000000` |
| `TENCENT_SMS_SIGN` | 短信**签名内容**（非签名 ID） | `明旸信息` |
| `TENCENT_SMS_TEMPLATE_ID` | 验证码模板 ID | `123456` |
| `TENCENT_SMS_TEMPLATE_PARAMS` | 可选，模板参数顺序，默认 `CODE,MINUTES` | `CODE,MINUTES` |
| `TENCENT_SMS_REGION` | 短信地域，默认 `ap-guangzhou` | `ap-guangzhou` |
| `TENCENT_SES_FROM_ADDRESS` | 已验证的发信地址 | `noreply@mail.mingyanginfo.com` |
| `TENCENT_SES_REGION` | SES 地域，默认 `ap-hongkong`（国内站常用 `ap-guangzhou`） | `ap-hongkong` |

**开关与降级行为**

- 短信需**密钥 + SdkAppId + 签名 + 模板**齐全才视为已配置；邮件需**密钥 + 发信地址**。
- 未配置时对应方式**在选择页自动关闭**（只留 TOTP），用户不会选到收不到码的方式而被锁死。
- 已配置但调用失败（额度耗尽、模板审核未过、发信地址未验证等）时：
  打印错误日志并在页面提示「验证码发送失败」，**不会**假装已发送。
- 开发/测试环境（`NODE_ENV=development` 或 `MOCK_2FA=1`）始终走 **mock**：只打印到控制台并在页面回显，
  **绝不真实外发**，不会消耗短信套餐。

## 七、安全机制备忘

- 密码 bcrypt(cost 12)；登录/二次验证同 IP+账号 5 次失败锁 10 分钟；注册同 IP 每小时限 5 次。
- 每表单 CSRF token；session cookie HttpOnly + SameSite=Lax + Secure，登录后轮换 ID。
- 登录两步制：密码 → 二次验证（TOTP 动态口令 / 邮箱验证码 / 手机验证码，首次登录强制绑定）。
  TOTP 用户手机丢失时，第二步可直接输入恢复码登录（一次性，用后作废；库中存 SHA-256 哈希）。
- CSP/X-Frame-Options 等响应头在应用层统一设置；未登录访问 /dashboard 一律跳回登录页。
- 数据库在 Web 目录之外；备份：`cp /var/lib/loginapp/app.db /backup/path/`（建议 stop 服务后拷）。
