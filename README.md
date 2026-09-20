# Jev × 2048

|**简体中文** | [English](README.en.md)|
|:-:|:-:|

<!-- 📝徽章安排参考：https://daily.dev/blog/readme-badges-github-best-practices#organizing-badges-in-your-readme -->

![License](https://img.shields.io/badge/license-MIT-78dce8?style=for-the-badge)
![Code Size](https://img.shields.io/github/languages/code-size/ARCJ137442/jev-2048?style=for-the-badge&color=78dce8)
![Language](https://img.shields.io/badge/language-TypeScript-78dce8?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%E2%89%A520-78dce8?style=for-the-badge)

<!-- 面向用户 -->

试玩：

[![Online Demo](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E8%AF%95%E7%8E%A9-Vercel-78dce8?style=for-the-badge)](https://jev-2048.vercel.app)

<!-- 面向开发者 -->

开发状态：

[![CI](https://img.shields.io/github/actions/workflow/status/ARCJ137442/jev-2048/ci.yml?style=for-the-badge&label=CI)](https://github.com/ARCJ137442/jev-2048/actions)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-78dce8?style=for-the-badge)](https://conventionalcommits.org)
![Last Commit](https://img.shields.io/github/last-commit/ARCJ137442/jev-2048?style=for-the-badge&color=78dce8)

---

## 简介

一个用 [TypeSafe AI 的「Jev」](https://www.typesafe.ai/) 决策模型作为「2048」决策引擎的网页实验台，全 [TypeScript](https://www.typescriptlang.org/) 编写。

Jev 不生成文本。它接收一段「状态」与一组带类型的「问题」，返回**带校准概率的结构化决策**。
本项目把每一步棋都交给它来决策，并把它的「概率分布」「置信度」「延迟」「token 消耗」全部摊开在界面上 ——
目的不是做一个好玩的 2048，而是让「上下文设计如何影响决策模型」这件事变得**可见、可调、可测量**。

---

## 在线演示

| 部署方式 | 地址 | 说明 |
|---|---|---|
| Vercel | <https://jev-2048.vercel.app> | 自带服务端函数，「免费试用」同源可用 |
| GitHub Pages | <https://arcj137442.github.io/jev-2048/> | 纯静态，跨域调用上面那份的免费试用端点 |

两种部署都内置「免费试用」后端，无需配置密钥即可试玩。
额度有限，用尽时会提示切换到自己的 API 密钥 —— 也可用下面「快速开始」在本地跑。

> 📝 **纯静态托管怎么处理密钥？** 静态站点没有服务端函数，所以它**不持有密钥**，
> 而是跨域调用 Vercel 上的那份部署，密钥仍在 Vercel 的函数进程里。
> 远端地址由 `src/client/api.ts` 的 `REMOTE_PROXY_BASE` 决定，换成自己的域名即可。

---

## 快速开始

### 前置条件

1. 安装 [**Node.js**](https://nodejs.org/)（≥ 20）
2. 准备一个 Jev 的 API 密钥（可选，仅在使用自备后端时需要）

### 尝鲜：即刻运行

```bash
git clone https://github.com/ARCJ137442/jev-2048.git
cd jev-2048
npm install
./start.sh
```

`start.sh` 会依次执行四步，任一步失败即中止：

```plaintext
▸ 检查 DOM id 一致性…     tools/check-dom.ts
▸ 运行单元测试…           73 项
▸ 编译客户端 / 服务器…
▸ 启动服务器…
```

启动后终端会打印访问地址：

```plaintext
本机访问   http://localhost:8787/
局域网访问 http://192.168.41.151:8787/
```

### 提供密钥

密钥按以下优先级读取（三条路径任意一条即可）：

1. 环境变量 `VERCEL_AI_GATEWAY_KEY`
2. `../local/vercel-secret-api-key.sealed`（封存后的密文）
3. `../local/vercel-secret-api-key`（明文，兼容旧布置）

把明文密钥封存起来：

```bash
node tools/seal-key.ts ../local/vercel-secret-api-key
# → 生成 *.sealed，服务器会自动优先读它
# 确认服务正常后，可以删掉明文：
rm ../local/vercel-secret-api-key
```

> ⚠️ **这不是密码学保护。** 默认口令就写在 `src/server/seal.ts` 里，拿到仓库就能解开。
> 它挡的是「明文躺在磁盘上被 `cat` 到、被截图、被误提交」这类**意外暴露**，不是针对性攻击。
> 真正的密钥保护是「不下发到客户端」与「服务端环境变量」。
> 想更严一点：设 `JEV_SEAL_PASSPHRASE`，源码里就只剩一个无用的默认值。

### 进阶：源码编译

```bash
# 类型检查
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.api.json

# 单元测试
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test dist-test/test/*.test.js

# 构建
node node_modules/typescript/bin/tsc -p tsconfig.client.json   # → public/js/
node node_modules/typescript/bin/tsc -p tsconfig.server.json   # → dist/
```

> 📝 本项目**不使用打包器**。客户端用浏览器原生 ES Modules，
> tsc 直接输出带 `.js` 扩展名的 import 路径，浏览器能原生加载。
> Termux 下 `npm`/`npx` 的 shebang 指向不存在的 `/usr/bin/env`，
> 所以 `start.sh` 用 `node` 直接跑 tsc 的 JS 入口绕开它。

---

## 项目概览

### 声明

本项目是「Jev」的一个**第三方实验台**，与 TypeSafe AI 无隶属关系。
「2048」的游戏规则属公有领域，本项目仅借用它作为一个有明确目标的决策场景。

### 系统模块架构

```plaintext
jev-2048
├── src
│   ├── shared
│   │   └── types.ts:       前后端共享类型 + 棋盘尺寸 + 生成分布
│   ├── client
│   │   ├── engine.ts:      2048 引擎，**纯函数**，tile 列表模型
│   │   ├── metrics.ts:     棋盘「特征」计算 + 「轨迹格」计算
│   │   ├── decision.ts:    决策策略 —— 把概率分布转成实际动作 ★
│   │   ├── api.ts:         多后端适配层 + 指数退避重试
│   │   ├── render.ts:      Canvas 棋盘渲染（橙色阶 + 方向粒子）
│   │   ├── chart.ts:       「置信度追踪图」（面积带 + 中位折线）
│   │   ├── config.ts:      长期设置持久化（不含密钥）
│   │   ├── session.ts:     对局持久化（支持刷新续玩）
│   │   ├── archive.ts:     存档导入导出
│   │   └── main.ts:        装配层
│   ├── server
│   │   ├── server.ts:      本机服务器 + 密钥代理
│   │   └── seal.ts:        密钥封存（AES-256-GCM）
│   └── test
│       ├── engine.test.ts:  49 项 —— 引擎规则 / 纯度 / 轴对齐 / 矩形棋盘
│       ├── archive.test.ts: 17 项 —— 存档校验与提取
│       └── seal.test.ts:     7 项 —— 密钥封存往返与安全失败
├── api:                    Vercel Serverless Functions（免费试用后端）
├── tools
│   ├── check-dom.ts:       构建期 DOM id 一致性检查
│   └── seal-key.ts:        明文密钥 → 密文
├── public:                 单页界面 + 编译产物
├── DESIGN.md:              设计决策记录（交接用，记录「为什么」）
└── ...
```

### 所用技术特性

- 📌 **纯 TypeScript，前后端统一**，不使用打包器
- 📌 **Canvas 渲染棋盘**：几何构造性正确（`2·pad + n·cell + (n-1)·gap` 恒等于边长），
  换任何棋盘尺寸四边都严格等距，不需要调参
- 📌 **「引擎纯度」作为硬约束**：`moveTiles()` 绝不修改入参 ——
  因为「合法方向」的判断方式就是「逐方向试走一步」，一旦有副作用，
  每次询问都会真的把棋盘搅乱一次
- 📌 **不引入任何启发式算法**：模型不确定时不悄悄换算法，而是把「不确定性」暴露给用户
- 📌 **零凭据下发**：API 密钥只存在于服务端进程，浏览器全程接触不到

### 可调参数

界面分五个抽屉，顺序即一条用户动线：
**游戏 → 策略 → API → 日志 → 存档**。

分区依据是「**影响谁的输入**」，不是功能分类：

| 分区 | 影响 Jev 的输入 | 影响动作落实 | 内容 |
|---|:-:|:-:|---|
| 「游戏」 | ✗ | ✗ | 棋盘宽高、新方块取值区间、生成分布、初始瓷砖个数、动效 |
| 「策略 › 上下文」 | **✓** | ✗ | 规则说明、策略提示、后果预测、记忆轮数 |
| 「策略 › 规则」 | ✗ | **✓** | 决策策略、置信度门槛 |
| 「API」 | ✗ | ✗ | 后端、密钥、自动重试 |
| 「日志」 | — | — | 每次请求的完整往返，只读 |
| 「存档」 | — | — | 导入 / 导出 |

> 这条判据可以直接当回归测试用：**改一个「游戏」项，若概率分布变了，说明有 bug。**

其中「策略 › 上下文」的三组参数是本实验台的核心：

| 参数 | 注入位置 | 观察什么 |
|---|---|---|
| 「规则说明」 | `state.rule_description` | 规则描述越精确，早期回合决策是否越合理 |
| 「策略提示」 | `state.strategy_hint` | 给出策略后，概率分布是否更集中（`confidence` 上升） |
| 「后果预测」 | `questions.best_move.criteria` | **影响最大的开关**。开启时每个方向附带模拟结果（合并得分 / 剩余空格 / 最大块是否在角落），关闭时只有方向标签 |

### 关于「不使用启发式」

一旦模型不确定时悄悄换成规则算法，测量就被污染了 ——
你无法区分「这一手是 Jev 走的」还是「规则走的」。

所以本项目的做法是：把不确定性**标记**出来，交由用户判断。
置信度门槛默认 **0**，即全程逐手使用模型输出。

### 各网关的命名差异 ⚠️

同一个 Jev、同一份「SystemOne」协议，各家做了**不同的命名选择**：

| | TypeSafe 官方 | OpenRouter | AI/ML API | Vercel Gateway |
|---|---|---|---|---|
| 端点 | `/v1/systemone` | `/api/v1/systemone` | `/v1/decisions` | `/v1/evaluate` |
| 模型 ID | `jev-latest` | `typesafe/jev-1.13` | `typesafe/jev` | `typesafe-ai/jev` |
| **布尔判别值** | `noul` | `noul` | `noul` | **`boolean`** |
| usage 字段 | `input_tokens` | `input_tokens` | `input_tokens` | `inputTokens` |

**Vercel 是唯一的异类** —— 它自己封装时把 `noul` 改名成了 `boolean`。
这条一度被搞反：「文档说 noul、API 实际叫 boolean」只对 Vercel 成立。
官方公开的 `openapi.json`（v0.2.0）确认官方用 `noul`。

`choice` 与 `score` 四家完全一致，所以本项目主流程不受影响。

### 想用本地模型跑？

**普通的 OpenAI 兼容端点接不了 Jev。**

Jev 是决策模型：接收 `state` + `questions`，返回带概率的结构化答案，
**没有 `/v1/chat/completions`**。LM Studio / vLLM / Ollama 的 OpenAI 兼容层
本质是「文本补全」，与 SystemOne 协议不匹配 —— 职责不同，不该硬凑。

正确做法是**让本地侧实现 SystemOne 协议**，把 OpenAI 兼容留在文本模型那一层：

- **LiteLLM proxy**：`/typesafe/v1/systemone` 透传到官方，自带计费与日志
- **LangChain**：`TypeSafeClassifier` 读 `TYPESAFE_BASE_URL`，可指向任意兼容网关
- **自建转换层**：自己实现 `POST /v1/systemone`

完全离线跑 Jev 不可行 —— 官方未开放权重。

### 离线替代：Laya

[Laya](https://github.com/NandhaKishorM/laya)（Apache-2.0）是 Jev 的**开源替代** ——
同样是非自回归决策模型，一次前向回答全部问题，不生成文本。
它本身是 Python 包、不带 HTTP 服务，需要自己包一层 sidecar 实现 SystemOne。

```plaintext
POST /v1/systemone   请求 { state, model, questions }
                     可选 per-request 字段 head_max_len / max_len
                     响应 { model, answers, usage, routing }
GET  /v1/models      列出可路由的 checkpoint
GET  /healthz        健康检查
```

- 默认 `http://127.0.0.1:8137`，`--host` / `--port` 可改
- 默认**无鉴权**；加 `--api-key <k>` 后要求 `Authorization: Bearer <k>`
- `model` 取值：`router`（默认，语言路由）/ `english` / `multilingual` / `typed-decisions`
- 响应 `model` 形如 `laya-typed-decisions`，并额外带 `routing` 字段（语言路由决策）

#### 与 Jev 的差异 ⚠️

| | 说明 |
|---|---|
| **上下文窗口小** | english=512、multilingual 与 typed-decisions=1024 token，超出从尾部截断 |
| **choice 选项共享预算** | 每个选项标签共享 `head_max_len`（默认 512）token，选项过多直接 400 并指名是哪个 question |
| **confidence 不同尺度** | 为 Jev 标定的阈值**不能直接套用**，需重新标定 |
| **类型判别值是 `noul`** | 不是 Vercel 的 `boolean` |
| **零成本** | 无 key、无按 token 计费、不出网 |

> 📌 本项目的「本地 Laya 服务器」后端就是为它预留的（默认地址 `127.0.0.1:8137`）。
> 标注为实验性：适配器尚未随仓库开源，形状以上表为准。

### 潜在应用领域

本项目的价值不在「让模型玩 2048」，而在于它是一台**可复现的上下文实验台**：

- 研究「提示词 / 上下文如何影响分类模型的决策质量」
- 对比不同网关（官方 / Vercel / OpenRouter / 自建）对同一模型输出的影响
- 作为「结构化决策模型」接入形态的参考实现（SystemOne 协议的完整调用封装）

---

## 贡献指南

### 项目分支情况

- `main`：基础版本，长期支持
- `dev`：开发版本，持续开发（ℹ️**PR 主要在此分支合并**）

### 贡献途径

- [GitHub Issues](https://github.com/ARCJ137442/jev-2048/issues)：反馈问题、建议、bug
- [GitHub Pull Request](https://github.com/ARCJ137442/jev-2048/pulls)：直接向项目贡献代码

### 提交前请确保

```bash
node tools/check-dom.ts && npm test
```

`./start.sh` 与 CI 跑的是同一组检查 —— 本地能过，CI 就能过，反之亦然。

---

<!-- 📝设计决策的完整理由见 DESIGN.md —— 那里记录的是「为什么这样做」，不是「做了什么」 -->
