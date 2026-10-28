#!/usr/bin/env bash
# 在 gcp-hk 上以部署用户执行一次：克隆仓库、安装 webhook 与自动部署的 systemd 单元。之后 GitHub push 到 main 即自动部署。
# 用法：setup-auto-deploy.sh <仓库检出目录>（使用其中的 deploy/ 文件）；webhook 密钥写入 /etc/chengchuan-bank/webhook.env。
set -euo pipefail
repo=${1:?usage: setup-auto-deploy.sh <checkout-dir>}
user=$(id -un) home=$HOME work=$HOME/chengchuan-bank-deploy
mkdir -p "$work"
gh auth setup-git
test -d "$work/src/.git" || gh repo clone siruizou2005/AI-Banking "$work/src" -- --quiet
touch "$work/request"

sudo install -d -m 0755 /opt/chengchuan-bank/hooks
sudo install -m 0755 "$repo/deploy/auto-deploy.sh" /opt/chengchuan-bank/hooks/auto-deploy.sh
sudo install -m 0644 "$repo/deploy/webhook.mjs" /opt/chengchuan-bank/hooks/webhook.mjs
if ! sudo test -f /etc/chengchuan-bank/webhook.env; then
  printf 'GITHUB_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo install -m 0600 -o root -g root /dev/stdin /etc/chengchuan-bank/webhook.env
fi
for unit in chengchuan-bank-webhook.socket chengchuan-bank-webhook.service chengchuan-bank-deploy.path chengchuan-bank-deploy.service; do
  sed -e "s|@USER@|$user|g" -e "s|@HOME@|$home|g" "$repo/deploy/systemd/$unit" | sudo install -m 0644 /dev/stdin "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable --now chengchuan-bank-webhook.socket chengchuan-bank-deploy.path
echo "已启用：webhook 127.0.0.1:8317（Caddy 转发 /_deploy/github），push 到 main 自动部署"
