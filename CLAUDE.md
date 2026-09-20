# CLAUDE.md

给在这个项目里工作的 AI 助手。**先读这一页再动手。**

关于「为什么这样设计」的完整推理见 `DESIGN.md`；面向外部读者的说明见 `README.md`。
本文件只写**红线、命令、和容易踩的坑**。

---

## 这个项目是什么

用 TypeSafe AI 的「Jev」决策模型作为 2048 引擎的网页实验台。全 TypeScript，
前后端统一，不用打包器。

**核心定位：测量 Jev，不是做一个好玩的 2048。** 判断任何改动是否合适，先问：
*它会让测量更干净，还是更浑浊？*

---

## 三条红线

### 1. `moveTiles()` 必须是纯函数

**不得修改传入的任何 tile 对象。**

`validMoves()` 的实现是「对每个方向试着走一步，看是否发生移动」——
一旦 `moveTiles` 有副作用，**每次询问合法方向都会真的把棋盘搅乱一次**。

症状是「上下移动时方块跑到别的列」「动画走对角线」。**根因在引擎，不在渲染**。

回归用例：`validMoves 不修改传入的 tile 对象`、`试算若干方向后再执行移动，结果与直接执行一致`。
用 `makeTile` 造新对象的测试**覆盖不到**这类 bug —— 必须显式传入同一批对象并检查它没被改动。

### 2. HTML 与 TS 必须同步

`$("id")` 拿不到元素时返回 `null`，后续访问抛 TypeError。
**若发生在模块求值阶段，会静默中断整个启动流程** —— 表现为「棋盘空白、点一下直接判负」。

三道防线，缺一不可：

| 层 | 手段 |
|---|---|
| 构建期 | `tools/check-dom.ts`（`start.sh` / CI 都会跑，失败即中止） |
| 启动期 | `boot()` 里的 `assertDom([...])` 一次性报出全部缺失 id |
| 兜底 | `boot()` 整体 try/catch，把错误显示在页面上 |

### 3. 绝不把密钥写进仓库

- 密钥只存在于服务端（环境变量 > `*.sealed` > 明文文件），**绝不下发到浏览器**
- 测试 fixture 一律用**假值**（如 `vck_TESTONLY_...`）
- `tools/scan-secrets.ts` 会扫工作区与 git 历史；`.git*` 必须在 `.gitignore` 里

> 这个项目**真的出过一次泄漏**（密钥进过测试文件与 git 历史）。
> 完整复盘见 `DESIGN.md` 的「一次真实的密钥泄漏事故」。
> 三条教训：`grep -I` 会跳过二进制、带 `g` 的正则 `.test()` 有状态、zlib 压缩层要单独扫。

---

## 常用命令

```bash
./start.sh                    # 密钥扫描 → DOM 检查 → 测试 → 编译 → 启动（8787）

# 分步
node tools/scan-secrets.ts --history    # 密钥扫描（含 git 历史）
node tools/check-dom.ts                 # HTML 与 TS 的 id 一致性
npm test                                # = tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js
npm run typecheck                       # 四份 tsconfig 全查

# 工具
node tools/seal-key.ts <明文文件>        # 明文密钥 → 密文（AES-256-GCM）
```

**Termux 注意**：`npm`/`npx` 的 shebang 指向不存在的 `/usr/bin/env`，直接执行会失败。
用 `node $(command -v npm) ...` 或直接 `node node_modules/typescript/bin/tsc ...`。
`start.sh` 已经绕开了这点。

---

## 结构

```
src/shared/types.ts      共享类型 + COLS/ROWS（可变棋盘）+ 生成分布
src/client/engine.ts     2048 引擎（纯函数，tile 列表模型）
src/client/decision.ts   决策策略 ★ 最值得动手改的地方
src/client/api.ts        多后端适配 + 重试 + 静态托管地址解析
src/client/render.ts     Canvas 渲染（橙色阶 + 方向粒子）
src/client/config.ts     长期设置持久化（不含密钥）
src/client/session.ts    对局持久化（刷新续玩）
src/client/archive.ts    存档导入导出
src/server/server.ts     本机服务器 + 密钥代理（多上游）
src/server/seal.ts       密钥封存
api/                     Vercel Serverless Functions（两个免费试用后端）
tools/                   构建期检查工具
```

构建产物：客户端 → `public/js/`，服务器 → `dist/`，测试 → `dist-test/`（三者都在 .gitignore 里）。

---

## 部署

| 环境 | 形态 | 密钥在哪 |
|---|---|---|
| 本机 | `server.ts` | `../local/*.sealed` 或环境变量 |
| Vercel | `api/*.ts` | Vercel 项目环境变量 |
| GitHub Pages | 纯静态 | **不持有** —— 跨域调用 Vercel 那份 |

GitHub Pages 版靠 `src/client/api.ts` 的 `REMOTE_PROXY_BASE` 找远端。
**换 Vercel 域名时必须同步改这个常量**，否则静态版跨域调不通。

Vercel 环境变量：`VERCEL_AI_GATEWAY_KEY`、`OPENROUTER_API_KEY`。
详细步骤见 `DEPLOY.md`。

---

## 约定

- **提交信息**用 Conventional Commits，中文正文
- **注释解释「为什么」**，不解释「是什么」—— 代码本身说得清后者
- 改动 `src/client/` 后**必须**跑 `check-dom.ts`；改 `.ts` 后**必须**跑 typecheck
- 新增 UI 元素时同步更新 `boot()` 里的 `assertDom([...])` 白名单

---

## 发布前的流程

**任何仓库推成公开之前，先由一个无上下文 subagent 独立复核。**

用新 agent，不要复用已经知道问题在哪的那个 —— 那只能算复验，不算双盲。
提示词里要明确要求它**用自己的方法独立验证**，不能只信仓库自带的工具。

理由是实际教训：本项目的扫描工具曾连续漏检三次，每一次都是**工具自身的盲区**。
独立视角的价值不在于更仔细，而在于**没有共同的盲区**。

---

## 已知边界

| 项 | 状态 |
|---|---|
| TypeSafe 官方后端 | 端点与协议由公开 `openapi.json` 确认，**未持密钥实测** |
| 本地 Laya 后端 | 需自行实现 SystemOne sidecar。它与 Jev 的 confidence **不同尺度** |
| Jev 在 2048 上的置信度 | 实测中位数约 0.3 —— 模型的真实输出特征，不是 bug |
| Vercel Hobby 额度 | $5/月 AI Gateway + 360 GB·h 内存。**无超额付费，用完即停到下月** |
| 免费端点滥用 | `/api/evaluate` 公开无鉴权，**建议在两个提供商后台设消费上限** |
