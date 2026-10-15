#!/usr/bin/env bash
# 由 chengchuan-bank-deploy.service 执行（GitHub push → webhook → path unit）：拉取 main，构建后调用 update-release.sh。
# 部署期间又有新推送时，结束后再比对一次 origin/main 并补上。
set -euo pipefail

base=/opt/chengchuan-bank
work=$HOME/chengchuan-bank-deploy
src=$work/src
keep_releases=8
keep_backups=5

deploy() {
  local sha=$1 release upload backups
  release=$(date +%Y%m%d-%H%M%S)-${sha:0:7}
  upload=$work/upload-$release
  echo "开始部署 $release"
  git -C "$src" reset --hard --quiet "$sha"
  git -C "$src" clean -fdq -e node_modules
  (cd "$src" && npm ci --no-audit --no-fund --loglevel=error && npm run build)
  echo "$sha" > "$src/REVISION"
  mkdir -p "$upload"
  (cd "$src" && { git ls-files -z; find dist -type f -print0; printf 'REVISION\0'; } | tar --null -T - -czf "$upload/bank-release.tar.gz")

  # SQLite 在线备份（含 WAL 中的数据），只保留最近几份。
  backups=/var/lib/chengchuan-bank/backups
  sudo -u bank-sim mkdir -p "$backups"
  sudo -u bank-sim "$base/runtime/bin/node" -e "new (require('node:sqlite').DatabaseSync)('/var/lib/chengchuan-bank/bank.sqlite').exec(\"VACUUM INTO '$backups/bank-before-$release.sqlite'\")"
  sudo -u bank-sim find "$backups" -name 'bank-before-*.sqlite' | sort | head -n -$keep_backups | xargs -r sudo -u bank-sim rm -f

  bash "$src/deploy/update-release.sh" "$release" "$upload"
  rm -rf "$upload"

  # 保留最近几个版本用于回滚，当前版本永远保留。
  local current
  current=$(basename "$(readlink -f "$base/current")")
  ls -1 "$base/releases" | sort | head -n -$keep_releases | while read -r old; do
    if [ -n "$old" ] && [ "$old" != "$current" ]; then sudo rm -rf "${base:?}/releases/$old"; fi
  done

  sudo install -m 0755 "$src/deploy/auto-deploy.sh" "$base/hooks/auto-deploy.sh"
  sudo install -m 0644 "$src/deploy/webhook.mjs" "$base/hooks/webhook.mjs"
  echo "部署完成 $release"
}

main() {
  mkdir -p "$work"
  exec 9>"$work/lock"
  flock -n 9 || { echo "已有部署在进行，结束后会再次比对 main"; exit 0; }
  trap 'rm -rf "$work"/upload-*' EXIT
  for _ in 1 2 3; do
    git -C "$src" fetch --quiet origin main
    local target current
    target=$(git -C "$src" rev-parse origin/main)
    current=$(cat "$base/current/REVISION" 2>/dev/null || true)
    if [ "$target" = "$current" ]; then echo "线上已是最新 ${target:0:7}"; return 0; fi
    deploy "$target"
  done
}

# Parsed in full before running, so replacing this file mid-deploy cannot change what executes.
main "$@"; exit
