# 邮件验证码（登录二次验证）开通步骤

目标：让用户在 `login.mingyanginfo.com` 注册后可以选择「邮箱验证」，
并在每次登录时收到一封 6 位验证码邮件。

---

## 0. 现状体检（已实测，2026-10-10）

| 检查项 | 实际值 | 状态 |
|---|---|---|
| CAM 密钥 `TENCENT_SECRET_ID/KEY` | 已填且非空 | ✅ |
| CAM 密钥权限 | `ListEmailAddress` / `ListEmailTemplates` 均返回 `AuthFailure.UnauthorizedOperation` | ⚠️ 只有最小授权（推测仅 `ses:SendEmail`），够用但无法用 API 自查 |
| SES 地域 | `ap-hongkong`（env 未设 `TENCENT_SES_REGION`，取代码默认值） | ⚠️ 控制台地域必须也是**中国香港** |
| 发信地址 | `no-reply@m.mingyanginfo.com` | ✅ 已配 |
| 发信域名 MX | `mxbiz1.qq.com`（1 条） | ✅ |
| 发信域名 SPF | `v=spf1 include:qcloudmail.com ~all` | ✅ |
| 发信域名 DMARC | `_dmarc.m.mingyanginfo.com` = `v=DMARC1; p=none` | ✅ |
| 发信域名 DKIM | 实际主机记录是 **`qcloudhk2048._domainkey.m`**（香港站专属前缀，非 `qcloudsg*`），`Status: true` | ✅ **已通过**（早先按 `qcloud*` 三种名字查不到，属误判） |
| 代码发送方式 | `SendEmail` 的 `Simple`（自定义 HTML/Text） | ❌ **官方已废弃**，仅历史申请过特殊配置的客户可用；默认账号只能用**模板发送** → 已改为模板发送（见第 6 节） |
| SMTP 密码 `SES_SMTP_PASS` | 仍为 `__REPLACE_ME__` 占位符 | ❌ 未启用（故当前实际走 API 通道） |
| 前端入口 | TOTP ✅ / 邮箱 ✅ / 手机「暂不可用」（按要求屏蔽） | ✅ |

### 结论：必须二选一

- **路线 A：模板发送**（走 API，不需要 SMTP 密码）—— 控制台建一个验证码模板，把 TemplateID 给我，我改代码。
- **路线 B：SMTP 发送**（不需要模板，也不需要 CAM 密钥）—— 你自己填 SMTP 密码，代码已支持，填完自动优先走 SMTP。

两条路都要先把 **DKIM** 补上，否则域名验证过不了。

---

## 1. 两条路都要做：补齐发信域名 DKIM

1. 打开 [邮件推送 SES 控制台](https://console.cloud.tencent.com/ses)，**右上角地域切到「中国香港」**。
2. 左侧「发信域名」→ 找到 `m.mingyanginfo.com` → 点「验证」。
3. 弹窗里会列出待配的 DNS 记录，**复制 DKIM 那一条的记录值**（以控制台显示为准，不要照抄网上的）。
4. 到你的 DNS 服务商（域名在哪买的就在哪配）加一条 TXT：
   - 主机记录：控制台显示的值（三种可能：`qcloud._domainkey.m`、`qcloudsg1024._domainkey.m`、`qcloudsg2048._domainkey.m`）
   - 记录类型：`TXT`
   - 记录值：第 3 步复制的那一长串（`v=DKIM1;k=rsa;p=...`）
5. 回控制台点「提交验证」。DNS 生效需要 5 分钟 ~ 2 小时，通过后状态变为「验证通过」。
6. 顺手核对一下这三项是否仍在（前面体检已确认存在，别动它们）：
   - MX：`m` → `mxbiz1.qq.com.`
   - TXT：`m` → `v=spf1 include:qcloudmail.com ~all`
   - TXT：`_dmarc.m` → `v=DMARC1; p=none`

> 注意：官方文档明确要求「不可使用企业邮箱域名」。`m.mingyanginfo.com` 的 MX 指向 `mxbiz1.qq.com`
> （腾讯企业邮与 SES 共用这套基础设施，属正常）；但如果这个子域已经在企业邮里开了收信，
> 请在控制台确认域名状态确实是「验证通过」而不是冲突。

---

## 2. 路线 A：模板发送（推荐）

### 步骤 A1 — 确认发信地址已创建

控制台左侧「发信地址」→ 应有 `no-reply@m.mingyanginfo.com`，
发信域名选的是已验证通过的 `m.mingyanginfo.com`。没有就点「新建」补一个。

### 步骤 A2 — 创建验证码邮件模板

控制台左侧「邮件模板」→「新建模板」，建议内容：

```
主题：明旸信息登录验证码
正文：您好，您正在登录明旸信息账号。本次验证码为 {{code}}，{{minutes}} 分钟内有效。请勿将验证码告知他人。如非本人操作请忽略本邮件。
```

- 变量名用 `code` 和 `minutes`（与模板编辑器里的占位符写法保持一致；若编辑器要求别的写法，告诉我，我同步改）。
- 提交后记下 **TemplateID**（纯数字），例如 `100091`。

### 步骤 A3 — 把 TemplateID 给我

我这边要做的改动（拿到 ID 后执行）：

- `config.js`：`ses` 增加 `templateId`（env `TENCENT_SES_TEMPLATE_ID`）、`templateKey`（默认 `code`）
- `lib/notify.js`：`SendEmail` 改用 `Template: { TemplateID, TemplateData: '{"code":"123456","minutes":"10"}' }`，
  保留 `Simple` 作为无模板时的回退
- 写入 `/etc/loginapp.env` → restart → 实测

### 步骤 A4 — 确认 CAM 子账号有 SendEmail 权限

CAM 控制台 → 用户 → 找到这个密钥对应的子账号 → 确认策略里包含 `ses:SendEmail`。
（当前密钥连 `List*` 都没有，如果连 `SendEmail` 也没给，实测会直接报 `AuthFailure`。）

---

## 3. 路线 B：SMTP 发送（不需要模板）

### 前提

- 账号必须是**企业实名**。（腾讯云公告：2026-03-02 起，个人实名新用户不再支持 SMTP 发送；
  企业实名不受影响。西安明旸信息技术应为企业实名，请在「账号信息中心」确认。）

### 步骤 B1 — 在控制台设置 SMTP 密码

控制台「发信地址」→ `no-reply@m.mingyanginfo.com` → 设置/重置 SMTP 密码。
（对应 API 是 `UpdateEmailSmtpPassWord`，控制台更直观。）

### 步骤 B2 — 在服务器上填写（密码不回显、不进 shell 历史）

```bash
read -r -s -p 'SMTP 密码: ' P \
&& grep -v '^SES_SMTP_PASS=' /etc/loginapp.env > /tmp/env.new \
&& printf 'SES_SMTP_PASS=%s\n' "$P" >> /tmp/env.new \
&& install -m 600 /tmp/env.new /etc/loginapp.env && rm -f /tmp/env.new && unset P \
&& systemctl restart loginapp
```

已配好的其它项（`SES_SMTP_HOST=smtp.qcloudmail.com`、`SES_SMTP_PORT=465`、
`SES_SMTP_USER=no-reply@m.mingyanginfo.com`）不用动。

### 步骤 B3 — 注意 IP 白名单

2026 年 3 月新增了「SMTP 发送 IP 白名单」：若控制台开启了，需把服务器的公网 IP
（即 `150.158.55.8`）加入白名单，否则 465 端口连不通。

同样需要把 TemplateID 或结果告诉我，我来验证 `ses.mode` 是否变成 `smtp`。

---

## 4. 实测（两条路都要做）

给我一个**你能收信的邮箱地址**，我在服务器上跑这条命令真实发一封验证码：

```bash
cd /www/wwwroot/login.mingyanginfo.com \
&& set -a && . /etc/loginapp.env && set +a \
&& node -e "require('./lib/notify.js').sendVerificationEmail('你的邮箱@example.com','123456').then(r=>console.log(r))"
```

看结果：

- 返回 `{ delivered: true }` → 通了，去收件箱（没有就看垃圾邮件）。
- 返回 `{ delivered: false }` → 我把服务端日志里的错误码贴出来，常见：
  - `FailedOperation.WithOutPermission` → 只能用模板发送（走路线 A）
  - `AuthFailure.UnauthorizedOperation` → CAM 没给 `ses:SendEmail`
  - `InvalidParameterValue.NoSuchSender` / 发信地址不存在 → 发信地址或域名未验证通过（回到第 1 节）
  - `MessageId` 返回但收不到 → 查域名 DKIM/SPF、查收件方垃圾邮件夹、查 SES 控制台「发送统计」

---

## 5. 端到端验收

发信通了之后，走一遍真实流程：

1. 打开 https://login.mingyanginfo.com/ 注册一个新账号（邮箱填你自己的）
2. 注册完成 → 自动到「开启二次验证」页 → 选「邮箱验证」
3. 收到 6 位验证码 → 填入 → 绑定成功
4. 退出 → 重新登录（用户名 + 密码）→ 第二步提示输入邮箱验证码 → 收码 → 登录成功
5. 数据库校验：`users` 表该行 `mfa_method='email'`、`email_verified=1`

---

## 6. 进展（2026-10-10）

- 已选定**路线 A（模板发送）**，TemplateID = **224198**，已写入 `/etc/loginapp.env`：
  `TENCENT_SES_TEMPLATE_ID=224198`（追加，未改动任何原有配置）。
- 代码已改造（commit `8d88845`）：
  - 新增 `lib/verifyEmailTemplate.js`：设计规范版验证码邮件（内联 logo、浅色默认 + 暗色渐进增强）。
  - `config.js` 新增 `ses.templateId` / `ses.templateVars`（默认 `code,minutes,email`，
    可用 `TENCENT_SES_TEMPLATE_VARS` 覆盖）。
  - `lib/notify.js`：API 通道优先 `Template` 发送，未配模板时才走 `Simple`；
    SMTP 通道仍优先，且直接发这份 HTML。
- **实测已通**：`sendVerificationEmail('no-reply@m.mingyanginfo.com','123456')`
  → `{ "delivered": true }`，MessageId `qcloudses-30-...-QW2OwZpNT0Uk1`。
  说明 CAM 密钥有 `ses:SendEmail` 权限、模板 224198 可用、地域 ap-hongkong 正确。

## 6.5 已修复：模板里验证码是写死的（重要）

用 `GetEmailTemplate` 读到模板 224198 的真实内容后发现：HTML 虽然是我们那份设计，
但**验证码、邮箱、IP 全是写死的**（`824613` / `hello@example.com` / `113.140.11.28`），
没有任何 `{{变量}}` → 用户收到的邮件里永远显示同一个假验证码。

已处理（`UpdateEmailTemplate`，原模板已备份）：
- HTML 换成 `docs/verify-email-template.html`（含 `{{code}}` / `{{email}}` / `{{minutes}}`）
- 补上真正的纯文本版本（原来 Text 是"向用户发送验证码的模板"这句占位符，
  而"缺少纯文本版本"正是官方列出的进垃圾箱因素之一）

⚠️ **改模板会触发重新审核**，审核期间发送会报
`FailedOperation.InvalidTemplateID`（模板 ID 无效或者不可用），属正常现象，等通过即可。

## 7. 送达率 / 进入垃圾箱：原因与对策

域名侧能做的都做完了（MX / SPF / DKIM / DMARC 四项 `Status` 全为 true），
剩下的是**域名信誉**与**内容结构**问题。控制台实测：
`CurrentReputationLevel = 1`（当前最低等级）、`DailyQuota = 500`。

按官方《送达率相关问题》《垃圾箱相关问题》文档，对策按见效速度排序：

| 优先级 | 做法 | 说明 |
|---|---|---|
| 立刻 | 在 QQ 邮箱里把 `no-reply@m.mingyanginfo.com` **加入通讯录/白名单**，并对垃圾箱里的那封点「不是垃圾邮件」 | 收件方的正反馈（打开、加为重要联系人）直接影响后续判定 |
| 立刻 | 给模板补纯文本版本 | **已做**（见 6.5） |
| 短期 | **新域名 warm up**：稳定、低频、真实地发触发类邮件，持续约 1 个月 | 官方明确：新域名在收件方没有信誉度，开始进垃圾箱是正常的，持续发"良好的验证类邮件"会逐渐移送至收件箱 |
| 短期 | 保持**低退信率、低投诉率、高打开率** | 无效地址导致的硬退信是信誉杀手（拉黑率达 8% 会被自动停发） |
| 可选 | 用 [mail-tester](https://www.mail-tester.com/) 测内容评分，目标 > 8 | 官方推荐做法 |
| 中期 | 购买**独立 IP** | 共享 IP 池的声誉是共享的，容易被连坐 |
| 中期 | 国内收件人可考虑改用 **ap-guangzhou** 地域 | 当前是 `ap-hongkong`；换地域需重新建发信域名与模板 |
| 兜底 | 改走 **SMTP 通道** | 代码已支持（填 `SES_SMTP_PASS` 即自动优先），好处是 HTML+纯文本都由代码控制，且不受模板审核影响 |

## 8. 还差最后一步：确认模板内容 + 真人验收

1. ~~核对控制台模板 224198 的内容~~ → **已由 API 直接更新完成**（见 6.5），
   当前卡在**模板重新审核**。请在控制台「邮件模板」看 224198 的状态，
   审核通过后告诉我，我立刻重发一封验证。
   ⚠️ 模板发送时**正文由控制台模板决定**，代码里的 HTML 只作用于 SMTP 通道。
2. **给一个你能收信的邮箱**，我发一封真实验证码，你确认：样式是否正常、
   `{{code}}` / `{{email}}` / `{{minutes}}` 是否都被正确替换。
   - 若变量没被替换（页面上还显示 `{{code}}` 原文）→ 说明控制台模板里的变量名不一致，按实际改。
   - 若报 `3010 TemplateData 字段格式不正确` → 单发模板只允许一个变量，
     把 `TENCENT_SES_TEMPLATE_VARS` 改成只留 `code`，其余在模板里写死。
