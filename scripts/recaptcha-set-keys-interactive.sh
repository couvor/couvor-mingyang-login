#!/usr/bin/env bash
# reCAPTCHA 密钥一键写入（交互式版）：直接在服务器上运行，按提示粘贴两个密钥即可。
# 行为：备份 /etc/loginapp.env → 只增改 RECAPTCHA_ 两键（不碰其它配置）→
#       顺带 git pull 部署最新代码 → npm install --omit=dev → 重启 loginapp。
# 密钥通过隐藏输入读入，不落终端历史、不完整回显，运行后即可关闭会话。
set -euo pipefail

ENV_FILE=/etc/loginapp.env
APP_DIR=/www/wwwroot/login.mingyanginfo.com

[[ $EUID -eq 0 ]] || { echo "✗ 请用 root 运行"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "✗ 未找到 $ENV_FILE"; exit 1; }

echo "== Google reCAPTCHA v2 密钥写入 =="
echo "（密钥来自 https://www.google.com/recaptcha/admin ，v2 复选框，域名 login.mingyanginfo.com）"
read -r -p "① 粘贴 SITE_KEY  : " SK
read -rs -p "② 粘贴 SECRET_KEY（输入不回显）: " SEC; echo
[[ -n "$SK" && -n "$SEC" ]] || { echo "✗ 两个密钥都不能为空"; exit 1; }

mask() { echo "${1:0:8}…（长度 ${#1}）"; }

# 1) 备份
TS=$(date +%Y%m%d-%H%M%S)
BAK="/backup/loginapp-env-${TS}.bak"
mkdir -p /backup
cp -a "$ENV_FILE" "$BAK"; chmod 600 "$BAK"
echo "✓ 已备份原配置 → $BAK"

# 2) upsert：存在则原地替换，不存在则追加（绝不删除既有行）
upsert() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    echo "✓ ${key} 已原地更新 → $(mask "$val")"
  else
    { printf '\n'; printf '# Google reCAPTCHA v2（发验证码接口人机校验，2026-10-11）\n'; printf '%s=%s\n' "$key" "$val"; } >> "$ENV_FILE"
    echo "✓ ${key} 已追加 → $(mask "$val")"
  fi
}
upsert RECAPTCHA_SITE_KEY "$SK"
upsert RECAPTCHA_SECRET_KEY "$SEC"

# 3) 若被显式禁用则改为 0（只改值不删行）
if grep -q '^RECAPTCHA_DISABLED=1' "$ENV_FILE"; then
  sed -i 's|^RECAPTCHA_DISABLED=1|RECAPTCHA_DISABLED=0|' "$ENV_FILE"
  echo "✓ 检测到 RECAPTCHA_DISABLED=1，已改为 0"
fi

chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
echo "✓ 权限 root:root 600"

# 4) 顺带把最新代码拉下来并装依赖（失败不阻断，密钥已写入）
if [ -d "$APP_DIR/.git" ]; then
  if git -C "$APP_DIR" -c safe.directory='*' pull --ff-only 2>&1 | tail -2; then
    echo "✓ 代码已更新到最新"
  else
    echo "⚠ git pull 失败，跳过代码更新（密钥仍已写入）"
  fi
  if (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error); then
    echo "✓ 依赖安装完成"
  else
    echo "⚠ npm install 失败（若服务起不来再手动跑一次）"
  fi
fi

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
echo "全部完成。验证方式：走一遍登录 → 第二步勾选 I'm not a robot → 点「发送验证码」→ 收码登录，"
echo "页面无 'for testing purposes only' 警告即正式生效。"
