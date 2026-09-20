#!/data/data/com.termux/files/usr/bin/bash
#
# 编译并启动 Jev × 2048。
#
# 不依赖 npm —— Termux 下 npm/npx 的 shebang 指向不存在的 /usr/bin/env，
# 直接调用会失败，所以这里用 node 执行 tsc 的 JS 入口绕开它。
#
# 用法： ./start.sh [端口]
#
set -euo pipefail
cd "$(dirname "$0")"

TSC="node_modules/typescript/bin/tsc"

if [ ! -f "$TSC" ]; then
  echo "✗ 缺少 TypeScript。请先安装依赖："
  echo "    node \$(command -v npm) install"
  exit 1
fi

echo "▸ 运行单元测试…"
node "$TSC" -p tsconfig.test.json
node --test dist-test/test/*.test.js || { echo "✗ 测试未通过，已中止启动"; exit 1; }

echo "▸ 编译客户端 (src/client → public/js)…"
node "$TSC" -p tsconfig.client.json

echo "▸ 编译服务器 (src/server → dist)…"
node "$TSC" -p tsconfig.server.json

echo "▸ 启动服务器…"
exec node dist/server/server.js "${1:-8787}"
