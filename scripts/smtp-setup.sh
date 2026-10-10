#!/bin/bash
# 手工填写 SES 的 SMTP 发信密码（不回显、不留 shell 历史）。
#
# 用法（在服务器上以 root 执行）：
#   bash scripts/smtp-setup.sh
#
# 说明：
#   - 密码只在本次输入时存在于内存，不会回显到终端，也不会写入 ~/.bash_history；
#   - 只替换/追加 /etc/loginapp.env 里的 SES_SMTP_PASS 一行，其他配置不动；
#   - 写完后重启 loginapp 使配置生效。

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/loginapp.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE，请确认路径。" >&2
  exit 1
fi

printf '请输入 SMTP 发信密码（输入时不显示）：'
read -rs SMTP_NEW_PASS
printf '\n'

if [ -z "$SMTP_NEW_PASS" ]; then
  echo "密码为空，未做任何修改。" >&2
  exit 1
fi

# 用 Node 改写，避免密码里的 / & | 等特殊字符破坏 sed 表达式
SMTP_NEW_PASS="$SMTP_NEW_PASS" ENV_FILE="$ENV_FILE" node -e '
const fs = require("fs");
const file = process.env.ENV_FILE;
const pass = process.env.SMTP_NEW_PASS;
let s = fs.readFileSync(file, "utf8");
const line = "SES_SMTP_PASS=" + pass;
if (/^SES_SMTP_PASS=.*$/m.test(s)) {
  s = s.replace(/^SES_SMTP_PASS=.*$/m, line);
} else {
  s = s.replace(/\n*$/, "\n") + line + "\n";
}
fs.writeFileSync(file, s, { mode: 0o600 });
console.log("已写入 SES_SMTP_PASS 到 " + file);
'

chmod 600 "$ENV_FILE"
systemctl restart loginapp
sleep 2
systemctl is-active loginapp
echo "完成。执行验证（只登录、不发信）："
echo "  cd /www/wwwroot/login.mingyanginfo.com && set -a && . /etc/loginapp.env && set +a && NODE_PATH=/www/wwwroot/login.mingyanginfo.com/node_modules node scripts/smtp-verify.js"
