#!/usr/bin/env bash
# npm 解包会丢掉 node-pty 预编译 spawn-helper 的执行位，症状是 spawn 时
# 抛 "posix_spawnp failed."（不是 ABI 错误，很容易看岔）。每次 install 后补回来。
set -e
for f in node_modules/node-pty/prebuilds/*/spawn-helper; do
  [ -f "$f" ] && chmod +x "$f"
done
exit 0
