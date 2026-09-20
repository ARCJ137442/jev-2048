/**
 * Jev API 适配层。
 *
 * 五个后端在 SystemOne 协议层结构一致，差异只在 base URL / 认证 / 响应字段命名。
 *
 * 实测要点：
 *  - 端点 POST /v1/evaluate（不是 /v1/chat/completions）
 *  - 域名 ai-gateway.vercel.sh（不是 .ai）
 *  - questions 是 record 不是 array
 *  - criteria 必填
 *  - Gateway 的 CORS 全开，浏览器可直连
 */
import type {
  Answer,
  BackendConfig,
  BackendId,
  JevRequest,
  JevResponse,
  Questions,
} from "../shared/types.js";

/* ══════════════ 静态托管支持 ══════════════ */

/**
 * 远端免费试用端点的地址。
 *
 * 纯静态托管（GitHub Pages、任意静态空间、file://）没有同源的服务端函数，
 * 所以「免费试用」类后端必须指向别处 —— 也就是 Vercel 上的那份部署。
 *
 * **这不是把密钥搬进静态文件**：静态页面只发请求，密钥仍在 Vercel 的函数进程里。
 * 部署到自己的域名后，把这个常量改成你的地址即可。
 */
export const REMOTE_PROXY_BASE = "https://jev-2048.vercel.app";

/**
 * 当前是否跑在「没有同源服务端」的环境里。
 *
 * 判据是 hostname 而不是探测请求：探测要等一次网络往返，
 * 而首屏就要决定后端可选列表，探测会让界面先闪一下再修正。
 */
export function isStaticHosting(): boolean {
  if (typeof location === "undefined") return false;
  if (location.protocol === "file:") return true;
  // GitHub Pages 的地址形如 <user>.github.io
  if (location.hostname.endsWith(".github.io")) return true;
  return false;
}

/**
 * 把代理路径解析成实际可用的地址。
 *
 *   /api/evaluate  →  同源部署下原样返回（本机服务器 / Vercel 自身）
 *                  →  静态托管下拼上远端前缀
 *
 * 绝对 URL（直连各类网关）原样返回。
 */
export function resolveBase(base: string): string {
  if (!base.startsWith("/")) return base;
  if (!isStaticHosting()) return base;
  return REMOTE_PROXY_BASE.replace(/\/$/, "") + base;
}

export const BACKENDS: Record<BackendId, BackendConfig> = {
  localproxy: {
    label: "免费试用",
    base: "/api/evaluate",
    model: "typesafe-ai/jev",
    note:
      "由本站的服务器端代为调用，API Key 只存在于服务端环境变量，" +
      "浏览器全程接触不到（DevTools 里也看不到）。额度有限，用尽后请改用其他后端。",
    verified: true,
    needsKey: false,
  },
  openrouterproxy: {
    label: "免费试用 2",
    base: "/api/evaluate2",
    model: "typesafe/jev-1.13",
    note:
      "与「免费试用」同一套服务端代理架构，走另一个上游。密钥同样只存在于服务端。" +
      "额度独立，一个用尽时另一个可能还有余量。",
    verified: true,
    needsKey: false,
  },
  vercel: {
    label: "Vercel AI Gateway",
    base: "https://ai-gateway.vercel.sh/v1/evaluate",
    model: "typesafe-ai/jev",
    note: "浏览器直连。端点 /v1/evaluate，CORS 已实测全开，但密钥会进入浏览器内存。",
    verified: true,
    needsKey: true,
  },
  typesafe: {
    label: "TypeSafe 官方",
    base: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    note:
      "端点与协议已由官方公开的 openapi.json（v0.2.0）确认：只有 POST /v1/systemone 一个决策端点。" +
      "未持密钥实测过。布尔类型判别值是 noul。需要 TypeSafe 账号。",
    verified: true,
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter 直连",
    base: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    note:
      "已实测可用。模型 ID 必须是 typesafe/jev-1.13（typesafe/jev-latest 与 typesafe-ai/jev 都会报不存在）。" +
      "注意：OpenRouter 的布尔类型判别值是 noul，Vercel 那边叫 boolean，两家相反。",
    verified: true,
    needsKey: true,
  },
  lmstudio: {
    label: "自建 / 本地兼容端点",
    base: "http://localhost:1234/v1/systemone",
    model: "jev-latest",
    note:
      "指向任何实现了 SystemOne 协议的服务 —— LiteLLM proxy 的 /typesafe 透传、" +
      "LangChain TypeSafeClassifier 配 TYPESAFE_BASE_URL、或你自己写的一层转换。" +
      "⚠ 普通的 OpenAI 兼容端点（LM Studio / vLLM / Ollama 的 /v1/chat/completions）" +
      "**打不通 Jev** —— 它是决策模型不是文本模型。必须让本地侧实现 SystemOne 协议，" +
      "把 OpenAI 兼容留在文本模型那一层。",
    verified: false,
    needsKey: false,
  },
};

export interface ClientConfig {
  provider: BackendId;
  base: string;
  model: string;
  /** 仅存内存，绝不落盘。代理模式下为空字符串 */
  apiKey: string;
}

/** 自动重试策略：指数退避 */
export interface RetryPolicy {
  /** 最大重试次数；null 表示无限重试 */
  max: number | null;
  /** 退避基数（毫秒），实际等待 = base * 2^attempt */
  baseMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { max: 3, baseMs: 800 };

/** 单次等待上限，避免指数退避涨到荒谬的时长 */
const MAX_BACKOFF_MS = 30_000;

export interface EvalResult {
  answers: Record<string, Answer>;
  inputTokens: number;
  raw: JevResponse;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 是否属于「值得重试」的错误 */
    readonly retryable = false,
    /**
     * 是否为「额度/配额」类问题。
     *
     * 这类错误值得单独提示：用户能做的事不是「重试」，而是**换一个后端或用自己的 key**。
     */
    readonly quotaExhausted = false,
  ) {
    super(message);
    this.name = "JevError";
  }
}

/** 429 / 408 / 5xx 属于服务端或配额侧的瞬时问题，值得重试 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * 判断一条错误是否属于「额度用尽」。
 *
 * 除了 402/429 这类状态码，还要看文案 —— Gateway 在预算耗尽时
 * 返回的仍是 4xx，措辞里会带 credits / quota / budget / 余额 等字样。
 */
export function isQuotaError(status: number | undefined, message: string): boolean {
  if (status === 402) return true;
  if (status === 429) return true;
  const m = message.toLowerCase();
  return (
    m.includes("quota") ||
    m.includes("credit") ||
    m.includes("budget") ||
    m.includes("insufficient") ||
    m.includes("rate limit") ||
    m.includes("exceeded") ||
    message.includes("额度") ||
    message.includes("余额") ||
    message.includes("配额")
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 带抖动的指数退避：base * 2^n，加 ±20% 抖动避免同时重试 */
export function backoffDelay(attempt: number, baseMs: number): number {
  const raw = baseMs * Math.pow(2, attempt);
  const capped = Math.min(raw, MAX_BACKOFF_MS);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export interface CallHooks {
  /** 每次重试前回调，便于界面显示「第 n 次重试」 */
  onRetry?: (attempt: number, error: JevError, delayMs: number) => void;
}

/** 单次请求，不做重试 */
async function callOnce(
  cfg: ClientConfig,
  state: unknown,
  questions: Questions,
): Promise<EvalResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // 代理类后端（路径以 / 开头）：密钥由服务端注入，浏览器既不持有也不发送
  const isProxy = cfg.base.startsWith("/");
  if (cfg.apiKey && !isProxy) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const url = resolveBase(cfg.base);
  const body: JevRequest = { model: cfg.model, state, questions };

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    // 网络层失败（断网、CORS、DNS）—— 一律可重试
    throw new JevError(`无法连接 ${url}：${(e as Error).message}`, undefined, true);
  }

  const text = await res.text();

  let data: JevResponse & { error?: { message?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    throw new JevError(
      `响应不是 JSON (HTTP ${res.status})：${text.slice(0, 200)}`,
      res.status,
      isRetryableStatus(res.status),
    );
  }

  if (!res.ok) {
    const msg = data.error?.message ?? text.slice(0, 200);
    throw new JevError(
      `HTTP ${res.status}：${msg}`,
      res.status,
      isRetryableStatus(res.status),
      isQuotaError(res.status, msg),
    );
  }
  if (!data.answers) {
    throw new JevError(`响应缺少 answers 字段：${text.slice(0, 200)}`, res.status, false);
  }

  const u = data.usage ?? {};
  return {
    answers: data.answers,
    inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
    raw: data,
  };
}

/**
 * 统一调用入口，按 RetryPolicy 做指数退避重试。
 *
 * 只对「瞬时故障」重试：网络错误、429、408、5xx。
 * 4xx（模型不存在、参数错误、鉴权失败）会直接抛出 —— 重试没有意义。
 */
export async function callJev(
  cfg: ClientConfig,
  state: unknown,
  questions: Questions,
  retry: RetryPolicy = { max: 0, baseMs: 800 },
  hooks: CallHooks = {},
): Promise<EvalResult> {
  let attempt = 0;

  for (;;) {
    try {
      return await callOnce(cfg, state, questions);
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError(String(e), undefined, false);
      const max = retry.max;
      const canRetry = err.retryable && (max === null || attempt < max);

      if (!canRetry) throw err;

      const delay = backoffDelay(attempt, retry.baseMs);
      hooks.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
      attempt++;
    }
  }
}

/** 实测：$0.042 / 1M input tokens，output 不计费 */
export const PRICE_PER_TOKEN = 0.042 / 1e6;

export function estimateCost(tokens: number): number {
  return tokens * PRICE_PER_TOKEN;
}
