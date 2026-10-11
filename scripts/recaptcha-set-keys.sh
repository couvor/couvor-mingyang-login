#!/usr/bin/env bash
# 向 /etc/loginapp.env 写入 Google reCAPTCHA v2 密钥（发验证码接口人机校验用）。
# 只新增 / 原地更新这两项，绝不删除或改动文件里的其它任何配置。
#
# 用法（服务器上以 root 运行）：
#   1. 先把下面 RECAPTCHA_SITE_KEY / RECAPTCHA_SECRET_KEY 两个值替换为
#      Google reCAPTCHA 后台（https://www.google.com/recaptcha/admin，
#      类型选 v2 复选框，域名填 login.mingyanginfo.com）拿到的真实密钥；
#   2. bash recaptcha-set-keys.sh
#
# 脚本行为：
#   - 自动备份 /etc/loginapp.env 到 /backup/loginapp-env-<时间戳>.bak
#   - 已存在的键原地替换，不存在的键追加（含注释行）
#   - 若 RECAPTCHA_DISABLED=1 则改为 0 并提示（只改值不删行）
#   - 密钥只做掩码显示（前 8 位 + 长度），绝不完整打印到终端
#   - 重启 loginapp 使环境变量生效（旧代码在跑也无害，只是暂不生效）
set -euo pipefail

# ↓↓↓ 把这两行替换成你的真实密钥 ↓↓↓
RECAPTCHA_SITE_KEY='在这里粘贴_SITE_KEY'
RECAPTCHA_SECRET_KEY='在这里粘贴_SECRET_KEY'
# ↑↑↑ 不要把真实密钥提交到 git / 贴到聊天里 ↑↑↑

ENV_FILE=/etc/loginapp.env

[[ $EUID -eq 0 ]] || { echo "✗ 请用 root 运行（sudo bash $0）"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "✗ 未找到 $ENV_FILE"; exit 1; }
case "$RECAPTCHA_SITE_KEY" in ''|*粘贴*) echo "✗ 请先在脚本里填入 SITE KEY"; exit 1;; esac
case "$RECAPTCHA_SECRET_KEY" in ''|*粘贴*) echo "✗ 请先在脚本里填入 SECRET KEY"; exit 1;; esac

mask() { local v="$1"; echo "${v:0:8}…（长度 ${#v}）"; }

# 1) 备份
TS=$(date +%Y%m%d-%H%M%S)
BAK="/backup/loginapp-env-${TS}.bak"
mkdir -p /backup
cp -a "$ENV_FILE" "$BAK"
chmod 600 "$BAK"
echo "✓ 已备份原配置 → $BAK"

# 2) upsert：存在则原地替换，不存在则追加（不删除任何既有行）
upsert() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    echo "✓ ${key} 已原地更新 → $(mask "$val")"
  else
    {
      printf '\n'
      printf '# Google reCAPTCHA v2（/2fa/send 与 /setup-2fa/:method/send 发码接口人机校验，2026-10-11）\n'
      printf '%s=%s\n' "$key" "$val"
    } >> "$ENV_FILE"
    echo "✓ ${key} 已追加 → $(mask "$val")"
  fi
}
upsert RECAPTCHA_SITE_KEY "$RECAPTCHA_SITE_KEY"
upsert RECAPTCHA_SECRET_KEY "$RECAPTCHA_SECRET_KEY"

# 3) 若被显式禁用则改为 0（只改值，不删行）
if grep -q '^RECAPTCHA_DISABLED=1' "$ENV_FILE"; then
  sed -i 's|^RECAPTCHA_DISABLED=1|RECAPTCHA_DISABLED=0|' "$ENV_FILE"
  echo "✓ 检测到 RECAPTCHA_DISABLED=1，已改为 0（原先被禁用）"
fi

# 4) 权限
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "✓ 权限已确认 root:root 600"

# 5) 重启生效
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
echo "完成。注意两点："
echo "  1) reCAPTCHA 要等新代码部署到服务器后才真正启用（当前代码尚未含 lib/recaptcha.js）；"
echo "  2) 验证方式：部署后走一遍登录 → 第二步页面的『重新发送验证码』处应出现 I'm not a robot 挂件。"
