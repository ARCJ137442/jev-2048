/**
 * 密钥扫描。
 *
 * 为什么不用 grep：
 *   之前 CI 里写的是 `grep -rIl -E 'vck_...'`。那个 `-I` 是「跳过二进制文件」——
 *   而当时被扫的那个文件恰好混进了裸控制字节，git 与 grep 都把它判为二进制，
 *   于是**真实密钥从扫描里溜了过去**。
 *
 *   一次真实的漏检。所以这里改为**按字节读**，不做任何文本/二进制假设。
 *
 * 用 Node 直接跑（Node 22+ 原生支持 TypeScript）：
 *   node tools/scan-secrets.ts            # 扫工作区
 *   node tools/scan-secrets.ts --history  # 连 git 历史一起扫
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * 扫描时跳过的目录。
 *
 * ⚠ 这里跳过的 `.git` 只指**仓库自己的** .git（在根目录）。
 * 嵌套在子目录里的 .git 是危险信号，必须报出来 —— 见 walk() 里的处理。
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-test"]);

/** 已知的密钥形态。宁可多报，也不能漏。 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Vercel Gateway Key", re: /vck_[A-Za-z0-9_-]{20,}/g },
  { name: "OpenRouter Key", re: /sk-or-v1-[a-f0-9]{32,}/g },
  { name: "OpenAI Key", re: /sk-[A-Za-z0-9]{32,}/g },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "Slack Token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Private Key Block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * 允许出现的「假密钥」。
 *
 * 测试 fixture 会用形如 `vck_TESTONLY_...` 的占位值 —— 它们长得像密钥，
 * 但明显是假的。白名单写在这里，而不是放宽正则 —— 放宽正则会同时放过真货。
 *
 * ⚠ 这些正则**不能带 `g` 标志**。
 * 带 `g` 的正则在 `.test()` 时是有状态的：匹配成功后 lastIndex 停在末尾，
 * 下一次调用会从那里继续找而失败。连续检查多个候选时白名单会时灵时不灵 ——
 * 扫描工具自己踩过一次。
 */
const ALLOWLIST = [/vck_TESTONLY/, /vck_xxxxx/i, /sk-or-v1-0{20,}/];

interface Hit {
  where: string;
  pattern: string;
  sample: string;
}

/** 按**字节**读文件，再用 latin1 解码 —— 保证任何字节都不会丢失或被跳过 */
function readRaw(path: string): string {
  return readFileSync(path).toString("latin1");
}

/**
 * 扫描一段内容，**同时尝试把它当 zlib 流解开再扫一遍**。
 *
 * 为什么需要：git 对象是 zlib 压缩存储的。
 * 真实事故：`.git.backup/` 曾不在 .gitignore 里，一次 `git add -A`
 * 把整个旧 .git 提交了进去 —— 里面存有密钥的那个对象是**压缩字节**，
 * 明文正则完全匹配不到，扫描器报了「干净」。
 * 但任何人 `zlib.decompress` 一下就能还原出密钥。
 *
 * 所以「找不到明文」不等于「没有密钥」——还要看压缩层。
 */
function scanWithInflate(data: Buffer, where: string, out: Hit[]): void {
  scanText(data.toString("latin1"), where, out);
  // zlib 流可能带 2 字节头（0x78 开头），也可能不带（raw deflate）
  for (const attempt of [() => inflateSync(data), () => inflateSync(data, { finishFlush: 2 })]) {
    try {
      const plain = attempt();
      if (plain.length > 0) scanText(plain.toString("latin1"), `${where}(解压)`, out);
    } catch {
      /* 不是 zlib 流，正常 */
    }
  }
}

function isAllowlisted(text: string): boolean {
  return ALLOWLIST.some((re) => re.test(text));
}

function scanText(text: string, where: string, out: Hit[]): void {
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (isAllowlisted(m[0])) continue;
      // 只报前缀，绝不回显完整值
      out.push({ where, pattern: name, sample: `${m[0].slice(0, 10)}…` });
    }
  }
}

function walk(dir: string, out: Hit[], isRoot = false): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // 嵌套的 .git 目录一律视为问题 —— 它会把历史里的所有对象（含已删除的密钥）
      // 整个带进仓库。这不是「可能有问题」，是「一定有风险」。
      if (name === ".git" && !isRoot) {
        out.push({
          where: relative(ROOT, full),
          pattern: "嵌套 .git 目录",
          sample: "整个 git 对象库被提交",
        });
        continue;
      }
      walk(full, out, false);
    } else if (st.isFile()) {
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        continue;
      }
      scanWithInflate(buf, relative(ROOT, full), out);
    }
  }
}

function scanHistory(out: Hit[]): void {
  // 逐个 blob 扫，而不是扫 diff 文本 —— diff 会截断长行
  let hashes: string[] = [];
  try {
    hashes = execFileSync("git", ["rev-list", "--objects", "--all"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")[0]);
  } catch {
    console.log("  （非 git 仓库或 git 不可用，跳过历史扫描）");
    return;
  }

  const seen = new Set<string>();
  for (const h of hashes) {
    if (seen.has(h)) continue;
    seen.add(h);
    try {
      const buf = execFileSync("git", ["cat-file", "-p", h], {
        cwd: ROOT,
        maxBuffer: 64 * 1024 * 1024,
      });
      scanWithInflate(buf, `git:${h.slice(0, 8)}`, out);
    } catch {
      /* 非 blob 对象，跳过 */
    }
  }
}

/* ---------- 主流程 ---------- */

const wantHistory = process.argv.includes("--history");
const hits: Hit[] = [];

walk(ROOT, hits, true);
if (wantHistory) scanHistory(hits);

if (hits.length === 0) {
  console.log(`\n  ✓ 未发现明文密钥${wantHistory ? "（含 git 历史）" : ""}\n`);
  process.exit(0);
}

// 去重后输出
const uniq = new Map<string, Hit>();
for (const h of hits) uniq.set(`${h.where}|${h.pattern}|${h.sample}`, h);

console.error(`\n  ✗ 发现 ${uniq.size} 处疑似密钥：\n`);
for (const h of uniq.values()) {
  console.error(`      ${h.pattern.padEnd(20)} ${h.sample.padEnd(14)} ${h.where}`);
}
console.error(
  `\n    注意：扫描按字节进行，不区分文本与二进制 ——` +
    `\n    早期版本因为用了 grep -I（跳过二进制），让一个混入控制字符的文件` +
    `\n    把真实密钥带进了仓库。\n`,
);
process.exit(1);
