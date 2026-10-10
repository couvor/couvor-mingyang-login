# 明旸登录系统 · login.mingyanginfo.com

面向学桥（x.mingyanginfo.com）等应用的统一登录服务（SSO 身份提供方 / IdP）。

- **注册 + 登录**：bcrypt 密码、Cloudflare Turnstile 人机验证、**二次验证三选一**（TOTP 动态令牌 / 邮箱验证码 / 手机验证码，首次登录强制绑定；TOTP 含一次性恢复码）
- **SSO**：`GET /sso/authorize` 签发 60 秒一次性票据、`POST /sso/verify` 服务端换身份（secret 仅存哈希、常数时间比对、按客户端+IP 限频）
- **退出**：清本站会话，支持 `?next=` 白名单回跳（客户端联动注销）
- **主题**：全站默认亮色优先（`.dark` 类切换暗色，偏好存 localStorage）
- **技术栈**：Node.js 24 + Express + node:sqlite（无构建步骤），systemd 托管

部署与运维细节见 [README-DELIVERY.md](README-DELIVERY.md)。

## 登录后跳转链路说明

登录/注册/2FA 全部通过后，服务端会自动续接回来源应用（学桥），无需人工刷新：

1. 表单成功 → 302 `/sso/authorize` → 302 回客户端回调（带一次性 ticket）→ 客户端建会话 → 落地角色首页
2. 所有认证跳转响应带 `Cache-Control: no-store`（ticket/state 不可缓存）
3. nginx 侧 `keepalive_timeout 15s`：让服务器主动关闭空闲连接，避免浏览器复用已被中间网络设备（NAT）静默回收的"死连接"——那会表现为**登录成功后跳转黑洞挂起、需手动刷新**（2026-10-10 校园网环境实测）
4. 前端对 POST 表单做提交反馈（按钮禁用 +「正在处理…」），并内置**自动重试看门狗**：提交后若 6 秒内页面仍未跳走（跨站续接被中间网络挂起），页面自动重新发起导航（`GET /`，服务端按会话状态自动续接回应用），按 6/12/18/24 秒退避重试、上限 60 秒——用户无需手动刷新；重试期间按钮显示「网络较慢，正在自动重试…」

