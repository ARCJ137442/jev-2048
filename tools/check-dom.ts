/**
 * 构建期检查：index.html 里的 id 是否覆盖了客户端代码引用到的全部 id。
 *
 * 为什么需要它：
 * 曾经因为 HTML 里删掉了一个输入框、而 TS 里还在绑定它的事件，
 * `$("inpPace")` 返回 null，`null.addEventListener` 在**模块求值阶段**抛出，
 * 静默中断了整个启动流程 —— 表现为「棋盘空白、点一下直接判负」，
 * 与真正的原因（一个多余的字符串）毫无关联，排查成本极高。
 *
 * 直接跑 TypeScript，Node 22+ 原生支持：
 *   node tools/check-dom.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const HTML = join(ROOT, "public", "index.html");
const CLIENT_DIR = join(ROOT, "src", "client");

const html = readFileSync(HTML, "utf8");
const htmlIds = new Set<string>();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

/** 从 TS 源码里收集所有「看起来是 DOM id」的字符串 */
function collectRefs(src: string): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  const lines = src.split("\n");

  // 只认形如 $("x") / $<T>("x") 的直接引用，以及数组字面量里的小驼峰标识符。
  // 前者靠语法上下文，后者靠命名约定 —— 我们的 id 一律是 lowerCamelCase。
  //
  // 两条直接引用的正则都必须**紧贴括号**：早先写成 /\$[<(][^>]*>?\(/ 时，
  // `[^>]*` 会跨过中间的括号一路回溯，把 `$("fb").classList.remove("on")`
  // 里的 "on" 也当成 id。
  const DIRECT_PLAIN = /\$\(\s*"([^"]+)"\s*\)/g;
  const DIRECT_TYPED = /\$<[^>]+>\(\s*"([^"]+)"\s*\)/g;
  const ARRAY = /\[\s*((?:"[^"]+"\s*,?\s*)+)\]/g;
  const IDENT = /^[a-z][A-Za-z0-9]*$/;

  // 这些是常见的非 id 字符串，避免误报
  const NOT_ID = new Set([
    "on", "off", "up", "down", "left", "right", "true", "false",
    "game", "strategy", "api", "log", "all", "none", "ok", "incompatible",
    "show", "hide", "err", "warn", "busy", "running", "primary", "ghost",
    "click", "change", "input", "submit", "touchstart", "touchend", "touchmove",
    "button", "text", "json", "GET", "POST",
  ]);

  lines.forEach((line, i) => {
    // $("...") / $<T>("...") 一定是 id，无需过滤
    for (const m of line.matchAll(DIRECT_PLAIN)) out.push({ id: m[1], line: i + 1 });
    for (const m of line.matchAll(DIRECT_TYPED)) out.push({ id: m[1], line: i + 1 });

    for (const m of line.matchAll(ARRAY)) {
      for (const s of m[1].matchAll(/"([^"]+)"/g)) {
        const id = s[1];
        if (IDENT.test(id) && !NOT_ID.has(id)) out.push({ id, line: i + 1 });
      }
    }
  });

  return out;
}

const missing: { id: string; file: string; line: number }[] = [];
let checked = 0;

for (const file of readdirSync(CLIENT_DIR).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(CLIENT_DIR, file), "utf8");
  for (const ref of collectRefs(src)) {
    checked++;
    if (!htmlIds.has(ref.id)) missing.push({ ...ref, file });
  }
}

console.log(`\n  DOM 检查：HTML 定义 ${htmlIds.size} 个 id，客户端引用 ${checked} 处`);

if (missing.length) {
  console.error(`\n  ✗ 有 ${missing.length} 处引用的 id 在 index.html 里不存在：\n`);
  for (const m of missing) {
    console.error(`      src/client/${m.file}:${m.line}   #${m.id}`);
  }
  console.error(
    `\n    这类不一致会在模块求值阶段抛出 TypeError，静默中断整个启动流程，\n` +
      `    表现为「棋盘空白、点击直接判负」。必须修掉。\n`,
  );
  process.exit(1);
}

console.log("  ✓ 全部引用都能在 HTML 里找到\n");
