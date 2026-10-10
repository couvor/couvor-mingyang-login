# 明旸登录系统 · login.mingyanginfo.com

面向学桥（x.mingyanginfo.com）等应用的统一登录服务（SSO 身份提供方 / IdP）。

- **注册 + 登录**：bcrypt 密码、Cloudflare Turnstile 人机验证、**二次验证三选一**（TOTP 动态令牌 / 邮箱验证码 / 手机验证码，首次登录强制绑定；TOTP 含一次性恢复码）
- **SSO**：`GET /sso/authorize` 签发 60 秒一次性票据、`POST /sso/verify` 服务端换身份（secret 仅存哈希、常数时间比对、按客户端+IP 限频）
- **退出**：清本站会话，支持 `?next=` 白名单回跳（客户端联动注销）
- **技术栈**：Node.js 24 + Express + node:sqlite（无构建步骤），systemd 托管

部署与运维细节见 [README-DELIVERY.md](README-DELIVERY.md)。
