/**
 * Vercel Serverless Function —— 「免费试用」后端的部署形态。
 *
 * 与本机 server.ts 是**同一套架构**，只是宿主机从 localhost 换成了 Vercel：
 * 浏览器 POST /api/evaluate 时不带任何凭据，函数在服务端补上 API Key 再转发。
 *
 * 为什么不需要「加密 token」：
 *   密钥只存在于 Vercel 的环境变量里，只在函数进程内被读取，
 *   从不进入任何响应体或客户端代码。**不下发，就不存在泄漏面。**
 *   真正需要加密的场景是「密钥必须交给浏览器」—— 那本就该避免。
 *
 * 额度控制靠 Vercel 侧的用量上限，不靠这里的代码。
 *
 * 刻意不 import @vercel/node —— 那会引入一个部署时才需要的依赖。
 * 这里只用到 req.method / req.body 和几个 res 方法，自己声明即可。
 */

/** Vercel 注入的最小请求/响应形状（只声明用到的部分） */
interface Req {
  method?: string;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(obj: unknown): void;
  send(body: string): void;
}

const GATEWAY = "https://ai-gateway.vercel.sh/v1/evaluate";
const DEFAULT_MODEL = "typesafe-ai/jev";
/** 请求体上限，防止被当成任意转发代理滥用 */
const MAX_BODY = 256 * 1024;

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    // 健康检查：只回显脱敏后的形态，绝不返回密钥本身
    const key = process.env.VERCEL_AI_GATEWAY_KEY ?? "";
    res.status(200).json({
      ok: Boolean(key),
      key: mask(key),
      model: DEFAULT_MODEL,
      backend: "free-trial",
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: { message: `不支持的方法：${req.method}` } });
    return;
  }

  const key = process.env.VERCEL_AI_GATEWAY_KEY;
  if (!key) {
    res.status(503).json({
      error: {
        message:
          "免费试用未配置：服务端缺少 VERCEL_AI_GATEWAY_KEY 环境变量。" +
          "请在 Vercel 项目设置里添加，或改用其他后端。",
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

  // 模型与服务端凭据一律由服务端决定，忽略客户端传来的任何认证信息
  const payload = { ...(body as Record<string, unknown>), model: DEFAULT_MODEL };

  try {
    const upstream = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,   // ← 密钥只在这一行出现，永不外泄
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(text);
  } catch (e) {
    res.status(502).json({
      error: { message: `无法连接 AI Gateway：${(e as Error).message}` },
    });
  }
}

function mask(key: string): string {
  return key.length > 14 ? `${key.slice(0, 7)}${"*".repeat(12)}${key.slice(-4)}` : "***";
}
