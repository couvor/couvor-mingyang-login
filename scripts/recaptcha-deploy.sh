#!/usr/bin/env bash
# recaptcha-deploy.sh — 把 Google reCAPTCHA v2 密钥自动写入服务器 /etc/loginapp.env 并重启 loginapp。
#
# ⚠️ 前置条件（重要，否则白填）：
#   本脚本只负责「服务器侧」写入。要让 /register/verify-email 的复选框真正能加载，
#   你需先在 Google reCAPTCHA 后台（https://www.google.com/recaptcha/admin）准备好一把：
#     - 类型：reCAPTCHA v2 → "I'm not a robot" Checkbox
#     - Domains：必须包含 login.mingyanginfo.com
#   说明：
#     · 若只是给「已有密钥」在后台加域名 —— 服务器无需改动，硬刷新页面即可，本脚本用不上。
#     · 若「新建」了密钥（例如轮换刚泄露的旧 secret）—— 才需要用本脚本把新密钥推到服务器。
#   （经典 reCAPTCHA v2 没有可用的 API 来自动加域名，那一步只能手动在控制台操作。）
#
# 用法（任选其一）：
#   1) 位置参数（最省事，从控制台复制两个密钥直接贴）：
#      sudo bash recaptcha-deploy.sh <SITE_KEY> <SECRET_KEY> [API_HOST]
#   2) 环境变量（适合脚本 / 一行 SSH 执行）：
#      RECAPTCHA_SITE_KEY='xxx' RECAPTCHA_SECRET_KEY='yyy' \
#      [RECAPTCHA_API_HOST='www.recaptcha.net'] \
#      sudo bash recaptcha-deploy.sh
#   3) 交互（缺哪个提示哪个，SECRET 不回显）：
#      sudo bash recaptcha-deploy.sh
#   4) 从本机经 SSH 流式执行（变量在远端命令里设好）：
#      ssh root@150.158.55.8 \
#        'RECAPTCHA_SITE_KEY="xxx" RECAPTCHA_SECRET_KEY="yyy" bash -s' \
#        < recaptcha-deploy.sh
#
# 行为：
#   - 备份 /etc/loginapp.env → /backup/loginapp-env-<时间戳>.bak（权限 600）
#   - 仅增改 RECAPTCHA_SITE_KEY / RECAPTCHA_SECRET_KEY / RECAPTCHA_API_HOST 三项，
#     绝不删除或改动文件里其它任何配置
#   - 若 RECAPTCHA_DISABLED=1 则改为 0（只改值不删行）
#   - 权限保持 root:root 600
#   - 重启 loginapp 并校验运行状态
#   - 密钥仅掩码显示（前 8 位 + 长度），绝不完整打印到终端/日志
set -euo pipefail

ENV_FILE=/etc/loginapp.env

[[ $EUID -eq 0 ]] || { echo "✗ 请用 root 运行（sudo bash $0 或 SSH root@host）"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "✗ 未找到 $ENV_FILE"; exit 1; }

# ---- 取密钥：环境变量优先，缺失则交互 ----
read_secret() {
  # $1 = 提示文案；读入全局变量 val
  if [[ "${INTERACTIVE_SECRET:-}" == "1" ]]; then
    read -rs -p "$1（输入不回显）: " val; echo
  else
    read -r -p "$1: " val
  fi
}

SK="${RECAPTCHA_SITE_KEY:-}"
SEC="${RECAPTCHA_SECRET_KEY:-}"
API_HOST="${RECAPTCHA_API_HOST:-}"

# 位置参数覆盖：$1=SITE_KEY  $2=SECRET_KEY  $3=API_HOST
[[ -n "${1:-}" ]] && SK="$1"
[[ -n "${2:-}" ]] && SEC="$2"
[[ -n "${3:-}" ]] && API_HOST="$3"

if [[ -z "$SK" || -z "$SEC" ]]; then
  echo "== Google reCAPTCHA v2 密钥写入（交互模式）=="
  echo "（来源：https://www.google.com/recaptcha/admin ，v2 复选框，Domains 含 login.mingyanginfo.com）"
  if [[ -z "$SK" ]]; then read -r -p "① 粘贴 SITE_KEY : " SK; fi
  if [[ -z "$SEC" ]]; then INTERACTIVE_SECRET=1; read_secret "② 粘贴 SECRET_KEY"; SEC="$val"; fi
fi

case "$SK" in ''|*粘贴*|*REPLACE_ME*) echo "✗ SITE_KEY 无效（空/占位符）"; exit 1;; esac
case "$SEC" in ''|*粘贴*|*REPLACE_ME*) echo "✗ SECRET_KEY 无效（空/占位符）"; exit 1;; esac

mask() { local v="$1"; echo "${v:0:8}…(长度 ${#v})"; }

# 1) 备份
TS=$(date +%Y%m%d-%H%M%S)
BAK="/backup/loginapp-env-${TS}.bak"
mkdir -p /backup
cp -a "$ENV_FILE" "$BAK"; chmod 600 "$BAK"
echo "✓ 已备份原配置 → $BAK"

# 2) upsert：存在则原地替换，不存在则追加（绝不删除既有行）
upsert() {
  local key="$1" val="$2" comment="$3"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    echo "✓ ${key} 已原地更新 → $(mask "$val")"
  else
    { printf '\n'; printf '# %s\n' "$comment"; printf '%s=%s\n' "$key" "$val"; } >> "$ENV_FILE"
    echo "✓ ${key} 已追加 → $(mask "$val")"
  fi
}
upsert RECAPTCHA_SITE_KEY "$SK" "Google reCAPTCHA v2（/register/verify-email 等发码接口人机校验）"
upsert RECAPTCHA_SECRET_KEY "$SEC" "Google reCAPTCHA v2 secret（机密，勿外泄）"
[[ -n "$API_HOST" ]] && upsert RECAPTCHA_API_HOST "$API_HOST" "reCAPTCHA 脚本/校验主机，默认 www.recaptcha.net（国内可达）"

# 3) 若被显式禁用则改为 0（只改值不删行）
if grep -q '^RECAPTCHA_DISABLED=1' "$ENV_FILE"; then
  sed -i 's|^RECAPTCHA_DISABLED=1|RECAPTCHA_DISABLED=0|' "$ENV_FILE"
  echo "✓ 检测到 RECAPTCHA_DISABLED=1，已改为 0"
fi

chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
echo "✓ 权限 root:root 600"

# 4) 重启生效
systemctl restart loginapp
sleep 1
if systemctl is-active --quiet loginapp; then
  echo "✓ loginapp 已重启且运行中"
else
  echo "✗ 重启后服务未运行，最近日志："
  journalctl -u loginapp -n 20 --no-pager || true
  exit 1
fi

echo
echo "完成。服务器侧已写入："
echo "  RECAPTCHA_SITE_KEY   = $(mask "$SK")"
echo "  RECAPTCHA_SECRET_KEY = $(mask "$SEC")"
echo "请确认 Google 后台该密钥：① 类型为 v2 Checkbox；② Domains 含 login.mingyanginfo.com。"
echo "验证：浏览器硬刷新（Ctrl+Shift+R）后打开 /register/verify-email，F12 Console 无"
echo "Invalid domain for site key / Invalid site key 报错即成功。"
