/**
 * 「免费试用 2」后端 —— 转发到 OpenRouter。
 *
 * 与 evaluate.ts 同构，只是上游与密钥不同。两份额度独立，
 * 一个用尽时另一个可能还有余量 —— 这是设置第二个免费后端的意义。
 *
 * 需要配置的环境变量：OPENROUTER_API_KEY
 *
 * ⚠ 实测差异（与 Vercel 对照，不要想当然地套用）：
 *   - 端点：OpenRouter 用 `/api/v1/systemone`，不是 `/v1/evaluate`
 *   - 模型 ID：`typesafe/jev-1.13`（`typesafe/jev-latest` 与
 *     `typesafe-ai/jev` 都报「模型不存在」）
 *   - 布尔类型判别值：OpenRouter 是 `noul`，Vercel 是 `boolean`，**两家相反**
 *   - usage 字段：OpenRouter 是 `input_tokens`，Vercel 是 `inputTokens`
 */
import { makeHandler } from "./_upstream.js";

export default makeHandler({
  label: "free-trial-2",
  url: "https://openrouter.ai/api/v1/systemone",
  envKey: "OPENROUTER_API_KEY",
  model: "typesafe/jev-1.13",
});
