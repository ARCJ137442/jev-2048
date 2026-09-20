/**
 * 「免费试用」后端 —— 转发到 Vercel AI Gateway。
 *
 * 与本机 server.ts 是同一套架构，只是宿主机从 localhost 换成了 Vercel。
 * 前端本地开发与线上用的是**同一个端点路径** `/api/evaluate`，所以前端代码一行不用改。
 *
 * 需要配置的环境变量：VERCEL_AI_GATEWAY_KEY
 */
import { makeHandler } from "./_upstream.js";

export default makeHandler({
  label: "free-trial",
  url: "https://ai-gateway.vercel.sh/v1/evaluate",
  envKey: "VERCEL_AI_GATEWAY_KEY",
  model: "typesafe-ai/jev",
});
