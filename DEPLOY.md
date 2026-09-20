# 部署到 Vercel

面向不熟悉 Vercel 控制台的人。按顺序做即可，全程只需要在浏览器里点。

---

## 为什么需要这一步

本项目有一个「免费试用」后端：浏览器不带任何凭据请求 `/api/evaluate`，
由 **Vercel 上的 Serverless Function** 补上 API Key 再转发出去。

所以密钥必须配在 **Vercel 项目的环境变量**里 —— 它只在函数进程内被读取，
从不进入响应体或客户端代码。

> **密钥不要放进 GitHub Secrets。** 那会多一个泄漏面而没有任何好处 ——
> 它不是给 GitHub Actions 用的，是给 Vercel 运行时用的。

---

## 准备工作：先拿到 API Key

按你打算启用的免费后端，准备对应的密钥：

| 免费后端 | 需要的密钥 | 从哪里拿 |
|---|---|---|
| 免费试用（端点 `/api/evaluate`） | Vercel AI Gateway Key，形如 `vck_...` | <https://vercel.com/dashboard> → 顶部 **AI** → **AI Gateway** → **API Keys** → Create |
| 免费试用 2（端点 `/api/evaluate2`） | OpenRouter Key，形如 `sk-or-v1-...` | <https://openrouter.ai/settings/keys> → **Create Key** |

只配一个也能跑，另一个会自动显示为不可用。两个都配则互为备份。

**建议给这两把钥匙都设消费上限** —— 公开站点上的额度是会被用掉的。

---

## 第一步：在 Vercel 里导入仓库

1. 打开 <https://vercel.com/new>
2. 找到 **Import Git Repository**
3. 第一次用的话，点 **Add GitHub Account** 授权 Vercel 读取你的仓库
   （只授权这一个仓库即可，不必给全部权限）
4. 在列表里选中 **`jev-2048`**，点 **Import**

> 如果列表里看不到它，点 **Adjust GitHub App Permissions**，
> 确认这个仓库被勾选了。

导入后 Vercel 会自己读取仓库里的 `vercel.json`，构建配置不需要手填。

---

## 第二步：配置环境变量

**在点 Deploy 之前**，展开 **Environment Variables** 那一栏，添加：

| Name | Value | 说明 |
|---|---|---|
| `VERCEL_AI_GATEWAY_KEY` | 你的 `vck_...` | 供「免费试用」使用 |
| `OPENROUTER_API_KEY` | 你的 `sk-or-v1-...` | 供「免费试用 2」使用 |

两个都填在 **Production / Preview / Development** 三个环境下（默认就是全选）。

⚠️ **变量名必须一模一样**，大小写敏感。写错了函数会返回 503 并提示缺哪个变量。

---

## 第三步：部署

点 **Deploy**。等大约一分钟，会看到一个带彩带的成功页面，上面有你的网址，
形如 `https://jev-2048-xxxx.vercel.app`。

**验证是否真的通了** —— 在浏览器地址栏直接访问：

```
https://你的域名/api/evaluate
```

应该返回类似：

```json
{"ok":true,"backend":"free-trial","key":"vck_3Qq************wXaw"}
```

- 看到 `"ok":true` → 成功
- 看到 `"ok":false` → 环境变量没配上，回第二步检查变量名
- 看到 `key` 字段是**脱敏**的（中间一串 `*`）→ 正常，它本来就不该回显完整密钥

对 `/api/evaluate2` 重复同样的检查。

---

## 第四步：绑定一个好记的域名（可选）

默认域名是一串随机字符。想换成 `jev-2048.vercel.app` 这种：

1. 进入项目 → **Settings** → **Domains**
2. 输入想要的子域名，点 **Add**
3. 如果名字没被占用，会自动分配成功

---

## 之后：推送即自动部署

导入仓库之后，**Vercel 已经和 GitHub 连上了**。
以后只要往 `main` 分支推代码，Vercel 会自动重新部署，不需要再做任何事。

每次部署的状态可以在项目的 **Deployments** 页看到。

---

## 常见问题

**部署失败，日志里说找不到 `public/js/client/main.js`**

说明客户端没编译出来。检查 `vercel.json` 里的 `buildCommand`：

```json
"buildCommand": "node node_modules/typescript/bin/tsc -p tsconfig.client.json"
```

**页面能打开，但一按「接管」就提示额度不足**

密钥没配、配错、或额度确实用尽了。先访问 `/api/evaluate` 看 `"ok"` 字段。

**想让局域网/本地也能用**

本地跑 `./start.sh` 即可，它会读 `../local/` 下的密钥文件。本地与线上用的是
**同一个端点路径** `/api/evaluate`，所以前端代码完全一样。

**担心密钥被刷**

- 在两个提供商后台都设置消费上限（这是最有效的一道）
- 公开仓库不含任何密钥，密钥只在 Vercel 环境变量里
- 如果确实被刷了，去提供商后台 revoke 旧 key，在 Vercel 里换新的，重新部署

---

## 附：另一条部署路径（GitHub Actions）

仓库里还有 `.github/workflows/deploy.yml`，可以在 GitHub 侧触发部署。
它需要三个仓库 Secrets：`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。

**用控制台连通之后就不需要它了。** 它默认会在缺少 `VERCEL_TOKEN` 时自动跳过，
不会让 CI 变红。留着是为了将来需要「部署记录与代码变更放在一起」时可用。
