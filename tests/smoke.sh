#!/bin/sh
# 一条命令跑 native 单元测试、payload 冒烟、wasm 冒烟与浏览器端到端。
set -e
cd "$(dirname "$0")/.."
./build.sh test
if command -v chromium >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  mkdir -p build/chrome-e2e
  node tests/browser_e2e.js
else
  echo "smoke: 跳过浏览器 e2e（缺少 chromium/node）"
fi
echo "smoke: all passed"
