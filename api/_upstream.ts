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

    if (req.method === "GET") {
      // 健康检查：只回显「配没配」「脱敏形态」，绝不返回密钥本身
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
      res.status(503).json({
        error: {
          message: `${up.label} 未配置：服务端缺少 ${up.envKey} 环境变量。请在 Vercel 项目设置里添加，或改用其他后端。`,
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
