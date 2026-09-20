/**
 * 把明文密钥文件封存成密文，之后可以删掉明文。
 *
 * 用法：
 *   node tools/seal-key.ts <明文文件> [输出文件]
 *
 * 例：
 *   node tools/seal-key.ts ../local/vercel-secret-api-key
 *   → 生成 ../local/vercel-secret-api-key.sealed
 *
 * 之后服务器会优先读 `.sealed`；确认无误再删明文。
 *
 * 注意这里直接跑 TypeScript（Node 22+ 原生支持），而 src/server/seal.ts
 * 用的是 node:crypto —— 它只属于服务端，所以放在 src/server 而不是 src/shared。
 *
 * 想换口令：设 JEV_SEAL_PASSPHRASE 环境变量再运行（服务器也要用同一个）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seal } from "../src/server/seal.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const src = process.argv[2];
if (!src) {
  console.error("用法：node tools/seal-key.ts <明文文件> [输出文件]");
  process.exit(1);
}

const inPath = resolve(ROOT, src);
if (!existsSync(inPath)) {
  console.error(`找不到文件：${inPath}`);
  process.exit(1);
}

const outPath = resolve(ROOT, process.argv[3] ?? `${src}.sealed`);

const plain = readFileSync(inPath, "utf8").trim();
if (!plain) {
  console.error("文件为空");
  process.exit(1);
}

writeFileSync(outPath, seal(plain), "utf8");

const usingEnv = Boolean(process.env.JEV_SEAL_PASSPHRASE);
console.log(`
  已封存 → ${outPath}
  密文长度 ${seal(plain).length} 字符
  口令来源 ${usingEnv ? "环境变量 JEV_SEAL_PASSPHRASE" : "源码默认值"}

  提醒：这不是密码学保护 —— 默认口令就在源码里。
  它挡的是「明文躺在磁盘上被顺手看到」，不是有心人的针对性攻击。
  真正的密钥保护是「不下发到客户端」和「服务端环境变量」。

  确认服务器能正常读取后，可以删掉明文文件：
    rm ${inPath}
`);
