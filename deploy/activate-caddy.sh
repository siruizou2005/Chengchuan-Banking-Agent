#!/usr/bin/env bash
set -euo pipefail

upload_dir=/home/siruizou/chengchuan-bank-upload-20260912
expected=d066aafcf6f90badcd87351649db09db08e0636b769352d09ff43037abf24d14
actual=$(sha256sum /etc/caddy/Caddyfile | cut -d ' ' -f 1)
test "$actual" = "$expected"
curl -fsS http://127.0.0.1:8316/api/health
sudo install -d -m 0755 /etc/caddy/sites
test ! -e /etc/caddy/sites/bank.caddy
sudo install -m 0644 "$upload_dir/bank.caddy" /etc/caddy/sites/bank.caddy
sudo caddy validate --config "$upload_dir/Caddyfile" --adapter caddyfile
sudo cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.bank.20260912
sudo install -m 0644 "$upload_dir/Caddyfile" /etc/caddy/Caddyfile
if ! sudo systemctl reload caddy; then
  sudo cp -a /etc/caddy/Caddyfile.bak.bank.20260912 /etc/caddy/Caddyfile
  sudo systemctl reload caddy
  exit 1
fi
sudo systemctl is-active caddy chengchuan-bank
