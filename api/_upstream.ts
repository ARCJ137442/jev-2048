/**
 * Vercel Serverless Function 的共享逻辑。
 *
 * 文件名以 `_` 开头，Vercel 不会把它当成路由 —— 它只被 evaluate.ts /
 * evaluate2.ts 引用。
 *
 * 「免费试用」与「免费试用 2」是**同一套代理架构的两个实例**，
 * 区别只在「转发到哪、用哪个环境变量里的密钥」。用一张表描述，
 * 而不是把处理逻辑复制两份 —— 复制的部分迟早会走样。
 *
 * 为什么不需要「加密 token」：
 *   密钥只存在于 Vercel 的环境变量里，只在函数进程内被读取，
 *   从不进入任何响应体或客户端代码。**不下发，就不存在泄漏面。**
 */

/** Vercel 注入的最小请求/响应形状（只声明用到的部分，避免依赖 @vercel/node） */
export interface Req {
  method?: string;
  body?: unknown;
}
export interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(obj: unknown): void;
  send(body: string): void;
}

export interface Upstream {
  /** 面向用户的标识，只用于健康检查与日志 */
  label: string;
  /** 真实上游地址 */
  url: string;
  /** 环境变量名 */
  envKey: string;
  /**
   * 默认模型 ID。
   * ⚠ 两家的命名空间不同：Vercel 是 `typesafe-ai/jev`，
   * OpenRouter 是 `typesafe/jev-1.13`（`typesafe/jev-latest` 和
   * `typesafe-ai/jev` 在 OpenRouter 上都会报「模型不存在」）。
   */
  model: string;
}

/** 请求体上限，防止被当成任意转发代理滥用 */
const MAX_BODY = 256 * 1024;

/**
 * 允许跨域调用的来源。
 *
 * 为什么需要：项目可以部署在**纯静态托管**上（GitHub Pages 等），
 * 那里没有服务端函数，静态页面只能跨域调用 Vercel 上的这份。
 *
 * 安全性由服务端保证，不由来源限制保证：
 *   - 请求体里不含任何凭据（密钥在服务端注入）
 *   - 就算别的站点来调，它消耗的也只是本站的免费额度，拿不到任何数据
 * 所以这里用 `*` 而不是白名单 —— 白名单反而会在换了域名后静默失效。
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

function applyCors(res: Res): void {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
}

function mask(key: string): string {
  return key.length > 14 ? `${key.slice(0, 7)}${"*".repeat(12)}${key.slice(-4)}` : "***";
}

/** 从响应里取 token 数 —— 两家字段名不同 */
function tokensOf(d: unknown): number {
  const u = (d as { usage?: { inputTokens?: number; input_tokens?: number } })?.usage ?? {};
  return u.inputTokens ?? u.input_tokens ?? 0;
}

/**
 * 生成一个处理函数。两个 evaluate*.ts 各自导出一个实例。
 */
export function makeHandler(up: Upstream) {
  return async function handler(req: Req, res: Res): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    applyCors(res);

    // 浏览器的跨域预检：不带凭据，直接放行
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method === "GET") {
      // 健康检查：只回显「配没配」与脱敏形态。
      // 不回上游名称 —— 部署冒烟测试只需要知道这个后端能不能用。
      const key = process.env[up.envKey] ?? "";
      res.status(200).json({
        ok: Boolean(key),
        backend: up.label,
        key: key ? mask(key) : null,
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: { message: `不支持的方法：${req.method}` } });
      return;
    }

    const key = process.env[up.envKey];
    if (!key) {
      // ⚠ 面向用户的错误**只说他能做什么**。
      // 实现细节（是哪个上游、缺哪个环境变量）只进服务端日志 ——
      // 写进响应体等于把「免费试用背后是某某提供商」直接告诉用户，
      // 而界面上那些隐藏（禁用模型字段、藏 Base URL）就白做了。
      // 错误信息恰恰是用户最会仔细读的地方。
      console.error(`[${up.label}] 未配置：缺少环境变量 ${up.envKey}`);
      res.status(503).json({
        error: {
          message: "该免费后端暂时不可用。请稍后重试，或在「API」设置里改用其他后端或自备密钥。",
        },
      });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: { message: "请求体为空或非法" } });
      return;
    }
    if (JSON.stringify(body).length > MAX_BODY) {
      res.status(413).json({ error: { message: "请求体过大" } });
      return;
    }

    // 模型与凭据一律由服务端决定，忽略客户端传来的任何认证信息
    const payload = { ...(body as Record<string, unknown>), model: up.model };

    try {
      const upstream = await fetch(up.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,   // ← 密钥只在这一行出现，永不外泄
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();

      // 日志里只记决策与 token，不记请求体（可能含用户上下文）
      if (upstream.status === 200) {
        try {
          const d = JSON.parse(text);
          const mv = d?.answers?.best_move?.choice ?? "?";
          const conf = d?.answers?.best_move?.confidence;
          const cs = typeof conf === "number" ? conf.toFixed(2) : "—";
          console.log(`[${up.label}] 200 → ${mv} 置信 ${cs} ${tokensOf(d)} tok`);
        } catch {
          console.log(`[${up.label}] 200（响应解析失败）`);
        }
      } else {
        console.log(`[${up.label}] ${upstream.status}`);
      }

      res.status(upstream.status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(text);
    } catch (e) {
      res.status(502).json({
        error: { message: `无法连接上游：${(e as Error).message}` },
      });
    }
  };
}
