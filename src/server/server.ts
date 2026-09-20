/**
 * Jev × 2048 本机服务器
 *
 * 职责：
 *   1. 托管静态页面（public/）
 *   2. 提供 /api/evaluate 代理端点 —— Vercel API Key 只存在于本进程内存中，
 *      浏览器全程接触不到密钥，DevTools 的 Network / Source 面板里也看不到。
 *
 * 只用 Node 内置模块，无第三方依赖。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ═══════════ 配置 ═══════════ */

// dist/server/server.js → dist/server → dist → 项目根
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(HERE, "public");
const KEY_FILE = join(HERE, "..", "local", "vercel-secret-api-key");

const GATEWAY = "https://ai-gateway.vercel.sh/v1/evaluate";
const DEFAULT_MODEL = "typesafe-ai/jev";
const DEFAULT_PORT = 8787;
const MAX_BODY = 512 * 1024;

/** 静态文件白名单 —— 密钥文件、源码永远不会被读到 */
const ALLOWED_EXT = new Set([".html", ".js", ".css", ".ico", ".png", ".svg", ".map"]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

/* ═══════════ 密钥 ═══════════ */

function loadApiKey(): string {
  const env = (process.env.VERCEL_AI_GATEWAY_KEY ?? "").trim();
  if (env) return env;

  if (!existsSync(KEY_FILE)) {
    console.error(`[致命] 找不到密钥文件：${KEY_FILE}`);
    console.error(`       可改用环境变量 VERCEL_AI_GATEWAY_KEY=xxx 启动。`);
    process.exit(1);
  }
  const key = readFileSync(KEY_FILE, "utf8").trim();
  if (!key) {
    console.error(`[致命] 密钥文件为空：${KEY_FILE}`);
    process.exit(1);
  }
  return key;
}

const API_KEY = loadApiKey();

function masked(key: string): string {
  return key.length > 14 ? `${key.slice(0, 7)}${"*".repeat(12)}${key.slice(-4)}` : "***";
}

/* ═══════════ 局域网地址 ═══════════ */

function lanIp(): string {
  // Android/Termux 下内核选路会返回应用沙箱的网桥地址，不是真实局域网地址。
  // 因此优先向 Termux WiFi API 询问。
  try {
    const out = execFileSync("termux-wifi-connectioninfo", { timeout: 5000 }).toString();
    const ip = (JSON.parse(out) as { ip?: string }).ip;
    if (ip && !ip.startsWith("127.")) return ip;
  } catch {
    /* 非 Android 或 API 不可用，走下面的回退 */
  }

  // 通用回退：读路由表里的默认出口地址
  try {
    const out = execFileSync("hostname", ["-I"], { timeout: 3000 }).toString().trim();
    const first = out.split(/\s+/)[0];
    if (first) return first;
  } catch {
    /* ignore */
  }
  return "localhost";
}

/* ═══════════ HTTP 处理 ═══════════ */

function send(res: ServerResponse, code: number, body: Buffer | string, ctype: string): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  res.writeHead(code, {
    "Content-Type": ctype,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 解析静态文件路径，拒绝任何越界访问 */
function resolveStatic(urlPath: string): string | null {
  const rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;      // 路径穿越
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  if (!ALLOWED_EXT.has(extname(full))) return null;   // 白名单
  return full;
}

async function handleEvaluate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    if (!raw) {
      sendJson(res, 400, { error: { message: "请求体为空" } });
      return;
    }
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求体无效：${(e as Error).message}` } });
    return;
  }

  // 关键：模型与密钥一律由服务器决定，忽略浏览器传来的任何认证信息
  payload.model = (payload.model as string) || DEFAULT_MODEL;

  const t0 = Date.now();
  let status = 502;
  let body = "";

  try {
    const upstream = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        // ← 密钥在这里注入，永不外泄给浏览器
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    status = upstream.status;
    body = await upstream.text();
  } catch (e) {
    sendJson(res, 502, { error: { message: `无法连接 AI Gateway：${(e as Error).message}` } });
    log(`✗ 502  连接失败：${(e as Error).message}`);
    return;
  }

  const ms = Date.now() - t0;

  if (status === 200) {
    try {
      const d = JSON.parse(body) as {
        usage?: { inputTokens?: number };
        answers?: { best_move?: { choice?: string; confidence?: number } };
      };
      const tok = d.usage?.inputTokens ?? 0;
      const mv = d.answers?.best_move?.choice ?? "?";
      const conf = d.answers?.best_move?.confidence;
      const confStr = typeof conf === "number" ? conf.toFixed(2) : "—";
      log(`✓ 200  → ${mv}  置信 ${confStr}  ${tok} tok  ${ms}ms`);
    } catch {
      log(`✓ 200  (响应解析失败)  ${ms}ms`);
    }
  } else {
    log(`✗ ${status}  ${ms}ms`);
  }

  send(res, status, body, "application/json; charset=utf-8");
}

function log(msg: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`  ${t}  ${msg}`);
}

/* ═══════════ 启动 ═══════════ */

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      key: masked(API_KEY),
      gateway: GATEWAY,
      model: DEFAULT_MODEL,
    });
    return;
  }

  if (req.method === "POST" && path === "/api/evaluate") {
    void handleEvaluate(req, res);
    return;
  }

  if (req.method === "GET") {
    const file = resolveStatic(path);
    if (!file) {
      send(res, 404, "Not Found", "text/plain; charset=utf-8");
      return;
    }
    const ext = extname(file);
    send(res, 200, readFileSync(file), MIME[ext] ?? "application/octet-stream");
    return;
  }

  sendJson(res, 404, { error: { message: `未知端点：${req.method} ${path}` } });
});

const port = (() => {
  const arg = process.argv[2];
  if (!arg) return DEFAULT_PORT;
  const n = Number(arg);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    console.error(`[致命] 端口无效：${arg}`);
    process.exit(1);
  }
  return n;
})();

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[致命] 端口 ${port} 已被占用。换一个：node dist/server/server.js ${port + 1}`);
  } else {
    console.error(`[致命] 服务器错误：${e.message}`);
  }
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  const ip = lanIp();
  const keySource = process.env.VERCEL_AI_GATEWAY_KEY
    ? "环境变量 VERCEL_AI_GATEWAY_KEY"
    : KEY_FILE;

  console.log(
    [
      "",
      "═".repeat(62),
      "  JEV × 2048  —  决策仪器已启动",
      "═".repeat(62),
      `  密钥       ${masked(API_KEY)}   (仅存于本进程内存)`,
      `  密钥来源   ${keySource}`,
      `  上游       ${GATEWAY}`,
      `  模型       ${DEFAULT_MODEL}`,
      "",
      `  本机访问   http://localhost:${port}/`,
      `  局域网访问 http://${ip}:${port}/`,
      "",
      "  在浏览器中打开上面任一地址即可开始。",
      "  Ctrl+C 停止服务。",
      "═".repeat(62),
      "",
    ].join("\n"),
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\n  已停止。");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
