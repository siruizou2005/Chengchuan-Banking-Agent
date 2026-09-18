#!/usr/bin/env bash
# 在 gcp-hk 上执行：从上传目录安装新版本并原子切换 current，旧版本保留用于回滚。
# 用法：update-release.sh <版本名，如 20260918-01> <上传目录>
# 上传目录需包含 bank-release.tar.gz（含预构建的 dist/）；可选 env 文件（聊天 API 凭据），安装后即从上传目录删除。
set -euo pipefail
release=${1:?usage: update-release.sh <release-name> <upload-dir>}
upload_dir=${2:?usage: update-release.sh <release-name> <upload-dir>}
base=/opt/chengchuan-bank
release_dir=$base/releases/$release
export PATH="$base/runtime/bin:$PATH"

test ! -e "$release_dir"
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" "$release_dir"
tar -xzf "$upload_dir/bank-release.tar.gz" -C "$release_dir"
cd "$release_dir"
npm ci --omit=dev --ignore-scripts
npm test
sudo chown -R root:root "$release_dir"

if test -f "$upload_dir/env"; then
  sudo install -d -m 0755 /etc/chengchuan-bank
  sudo install -m 0600 -o root -g root "$upload_dir/env" /etc/chengchuan-bank/env
  rm -f "$upload_dir/env"
fi
sudo install -m 0644 deploy/chengchuan-bank.service /etc/systemd/system/chengchuan-bank.service
sudo systemctl daemon-reload

previous=$(readlink -f "$base/current" || true)
sudo ln -sfn "$release_dir" "$base/current.new"
sudo mv -T "$base/current.new" "$base/current"
sudo systemctl restart chengchuan-bank
sleep 2
if ! curl -fsS http://127.0.0.1:8316/api/health >/dev/null; then
  echo "健康检查失败，回滚到 $previous" >&2
  if test -n "$previous"; then
    sudo ln -sfn "$previous" "$base/current.new"; sudo mv -T "$base/current.new" "$base/current"; sudo systemctl restart chengchuan-bank
  fi
  exit 1
fi
echo "已发布 $release（上一版本：$previous）"
systemctl is-active chengchuan-bank
curl -fsS http://127.0.0.1:8316/api/health; echo
curl -fsS http://127.0.0.1:8316/api/chat/status; echo
