#!/usr/bin/env bash
set -euo pipefail

# Run on gcp-hk after uploading this release. Existing sites are not modified here.
release_dir=/opt/chengchuan-bank/releases/20260912-01
runtime_dir=/opt/chengchuan-bank/node-v24.21.0-linux-x64
upload_dir=/home/siruizou/chengchuan-bank-upload-20260912

sudo install -d -m 0755 /opt/chengchuan-bank /opt/chengchuan-bank/releases
if ! test -x "$runtime_dir/bin/node"; then
  cd "$upload_dir"
  curl -fsSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
  curl -fsSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
  grep ' node-v24.21.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check -
  sudo tar -xJf node-v24.21.0-linux-x64.tar.xz -C /opt/chengchuan-bank
fi
if ! test -L /opt/chengchuan-bank/runtime; then
  sudo ln -s "$runtime_dir" /opt/chengchuan-bank/runtime
fi
if ! id bank-sim >/dev/null 2>&1; then
  sudo useradd --system --home-dir /var/lib/chengchuan-bank --shell /usr/sbin/nologin bank-sim
fi
test ! -e "$release_dir"
sudo install -d -m 0755 -o siruizou -g siruizou "$release_dir"
tar -xzf "$upload_dir/bank-release.tar.gz" -C "$release_dir"
cd "$release_dir"
export PATH="/opt/chengchuan-bank/runtime/bin:$PATH"
# 测试需要开发依赖（如 typescript），与 CI 一致地完整安装，测试通过后再移除。
npm ci --ignore-scripts
npm test
npm prune --omit=dev --ignore-scripts
sudo chown -R root:root "$release_dir"
sudo install -d -m 0700 -o bank-sim -g bank-sim /var/lib/chengchuan-bank
test ! -e /opt/chengchuan-bank/current
sudo ln -s "$release_dir" /opt/chengchuan-bank/current
sudo install -m 0644 deploy/chengchuan-bank.service /etc/systemd/system/chengchuan-bank.service
sudo systemctl daemon-reload
sudo systemctl enable --now chengchuan-bank.service
sudo systemctl status chengchuan-bank.service --no-pager
