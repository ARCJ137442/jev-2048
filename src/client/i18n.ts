/**
 * 界面国际化。
 *
 * ## 边界：什么翻译，什么不翻译
 *
 * **只覆盖界面框架文案** —— 标签、按钮、状态、错误提示、说明文字。
 *
 * 刻意**不**覆盖喂给 Jev 的请求内容：`buildState()` / `buildQuestions()` 里构造的
 * `board_legend`、`memory_note`、`criteria`、`instructions`，以及 `DEFAULT_CONTEXT`
 * 的默认提示词。那些是**实验变量** —— 随界面语言变化会让跨语言的对局不可比，
 * 而本项目的定位是「测量 Jev，不是做一个好玩的 2048」。
 *
 * 这一点也解释了为什么 `NAME`（方向 → 中文名）不在这里：它只服务于 `criteria`。
 *
 * ## 用法
 *
 * HTML 侧标属性，扫描后写回；TS 侧直接调 `t()`：
 *
 * | 属性 | 写回目标 |
 * |---|---|
 * | `data-i18n="key"` | `textContent` |
 * | `data-i18n-html="key"` | `innerHTML`（文案里含标签时用） |
 * | `data-i18n-title="key"` | `title` |
 * | `data-i18n-ph="key"` | `placeholder` |
 *
 * HTML 里保留中文原文，未启用 JS 时仍可读（渐进增强）。
 */

export type Lang = "zh" | "en";

// 注意：这里刻意不提供语言清单数组常量。tools/check-dom.ts 会把方括号包裹的
// 字符串字面量一律当作需要核对的 DOM id 列表（它扫的是全文，注释也算），
// 于是报出并不存在的 zh / en 两个 id。语言切换是 zh↔en 的对切，本就不需要遍历。

/**
 * 词条表。
 *
 * key 用点分命名空间，第一段对应界面区域（`nav` / `game` / `strategy` / `api` /
 * `log` / `archive` / `decision` / `status` / `toast` …），第二段是用途。
 *
 * `zh` 与 `en` 的 key 集合**必须完全一致** —— `i18n.test.ts` 里有断言，
 * 漏译会在测试阶段直接暴露。
 */
const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    /* ---------- 顶栏 ---------- */
    "app.subtitle": "决策由 Jev 评估模型给出",
    "app.subtitleTitle":
      "每一手都由 Jev 评估模型决定 —— 它返回带校准概率的决策，而非生成的文本",
    "nav.game": "游戏",
    "nav.gameTitle": "棋盘大小、新方块取值区间、动效 —— 与玩家和 Jev 的操作无关的自然属性",
    "nav.strategy": "策略",
    "nav.strategyTitle": "上下文（影响 Jev 看到什么）与规则（影响动作如何落实）",
    "nav.apiTitle": "用哪个提供商、怎么调用",
    "nav.log": "日志",
    "nav.logTitle": "每一次请求的完整往返记录",
    "nav.archive": "存档",
    "nav.archiveTitle": "导入 / 导出存档：对局、策略、API 设置、调用日志",
    "nav.githubTitle": "在 GitHub 上查看源码 · 欢迎 star 与 issue",
    "nav.langTitle": "界面语言 / Interface language",
    "nav.langName": "中文",

    /* ---------- 棋盘下方控制条 ---------- */
    "ctrl.takeover": "▶ 让 Jev 接管",
    "ctrl.pause": "⏸ 暂停",
    "ctrl.takeoverTitle": "让 Jev 接管 / 暂停自动走棋（空格）",
    "ctrl.step": "单步",
    "ctrl.stepTitle": "只走一手",
    "ctrl.new": "↺ 重开",
    "ctrl.newTitle": "重开一局，保留全部设置",
    "ctrl.hintManual": "手动 ·",
    "ctrl.hintPause": "暂停",
    "fb.label": "启发式回退",
    "pace.label": "步进间隔",
    "pace.title": "自动走棋的间隔。0 = 不等，上游多快就多快（测极限用）",
    "pace.instant": "最快",

    /* ---------- 决策面板 ---------- */
    "decision.title": "Jev 决策",
    "decision.idle": "尚未开始",
    "decision.confidence": "置信",
    "decision.restored": "已恢复上一局（第 {n} 手）",

    /* ---------- 侧栏图表与统计 ---------- */
    "chart.title": "置信度追踪",
    "chart.band": "上/下界",
    "chart.median": "中位",
    "chart.waiting": "等待对局数据",
    "stats.ready": "就绪",
    "stats.total": "累计",
    "stats.latency": "延迟",

    /* ---------- 游戏面板 ---------- */
    "game.title": "游戏",
    "game.desc":
      "棋盘与新方块的自然属性。这里改任何东西，都不会影响 Jev 看到的内容，也不影响它怎么决策。",
    "game.boardSize": "棋盘大小（宽 × 高，各自独立）",
    "game.boardHint": "2 – 16。改动会立即重开一局；历史纪录按「宽×高」分别记录。",
    "game.phWidth": "宽 4",
    "game.phHeight": "高 4",
    "game.spawnRange": "新方块取值区间（填 2 的指数）",
    "game.spawnHint": "填指数 n，实际取值是 2ⁿ —— 0 → 1、1 → 2、2 → 4，以此类推。",
    "game.phSpawnMin": "最小 0",
    "game.phSpawnMax": "最大 2",
    "game.spawnWarn": "指数需为非负整数，且上界不小于下界",
    "game.dist": "生成分布",
    "game.distWeighted": "加权 — 权重为值的倒数，越大越罕见（默认）",
    "game.distUniform": "均匀 — 区间内各值等概率",
    "game.distNote": "加权模式下 2 与 4 的出现比约为 2 : 1（P(2)=2/3）；均匀模式各占一半。",
    "game.initRange": "初始瓷砖个数区间",
    "game.initDesc": "开局时随机摆放几个瓷砖。下限不能小于 1 —— 空棋盘上任何方向都动不了，第一步就会判负。",
    "game.phMin1": "最小 1",
    "game.phMax2": "最大 2",
    "game.initWarn": "下限至少为 1，且不得大于上限",
    "game.fx": "动效",
    "game.fxAnim": "滑动 / 合并 / 入场动画",
    "game.fxParticles": "决策方向箭头粒子",
    "game.reset": "恢复默认",
    "game.resetTitle": "棋盘尺寸、新方块区间、动效回到出厂值",
    "game.scoreReset": "重置最高分",
    "game.scoreResetTitle": "清空各棋盘尺寸的历史最高分与最大瓷砖",
    "game.done": "完成",

    /* ---------- 策略面板 ---------- */
    "strategy.title": "策略",
    "strategy.introA": "分两部分：",
    "strategy.introCtx": "上下文",
    "strategy.introMid": "决定 Jev 看到什么，",
    "strategy.introRule": "规则",
    "strategy.introEnd": "决定拿到答案后怎么做。",
    "strategy.ctx": "上下文",
    "strategy.ctxNote": "改动会进入请求，影响 Jev 的判断 —— 效果看「概率分布」",
    "strategy.ruleDescLabel": "规则说明 → state.rule_description",
    "strategy.hintLabel": "策略提示 → state.strategy_hint",
    "strategy.criteriaLabel": "后果预测 → questions.criteria",
    "strategy.criteriaOn": "包含每步的具体后果",
    "strategy.criteriaDesc": "开启后每个候选方向附带合并得分、剩余空格、最大块是否在角落。关掉它，Jev 只能看到方向名。",
    "strategy.memoryLabel": "记忆轮数 → state.recent_history",
    "strategy.max": "最大",
    "strategy.maxTitle": "在上下文预算内尽量塞满",
    "strategy.memoryNote": "上限受模型上下文窗口约束（32000 token 的 55% 预算）。",
    "strategy.memoryDesc": "把最近 n 轮的「局面 + 当时走的方向 + 当时得分」一并发给 Jev。0 = 不加入（原版行为）。",
    "strategy.rule": "规则",
    "strategy.ruleNote": "不进入请求，Jev 看不到 —— 效果看「实际走了哪一步」",
    "strategy.policy": "决策策略",
    "strategy.greedy": "贪心 — 取概率最高的合法方向",
    "strategy.sample": "概率采样 — 按分布随机（有探索性）",
    "strategy.thresholdOpt": "置信度门槛 — 低于阈值时标记",
    "strategy.thresholdLabel": "置信度门槛",
    "strategy.thresholdNote": "看着侧栏的置信度追踪图来定：低于该值的回合会被标记。",
    "strategy.noHeuristic": "本 Demo 不含启发式兜底：拿不准时不换别的算法，而是把不确定性标出来交给你判断。",
    "strategy.presetEn": "应用英文预设",
    "strategy.presetEnTitle": "把规则说明与策略提示替换为英文版本（当前内容会被覆盖）",
    "strategy.presetZh": "应用中文预设",
    "strategy.presetZhTitle": "把规则说明与策略提示替换为中文版本（当前内容会被覆盖）",
    "strategy.reset": "恢复默认",
    "strategy.resetTitle": "上下文与规则全部回到出厂值",
    "strategy.done": "完成",

    /* ---------- API 面板 ---------- */
    "api.title": "API",
    "api.desc": "用哪个提供商、怎么调用。这里只影响请求如何送达，不改变提示词或游戏规则。",
    "api.keySafety": "密钥安全",
    "api.keyNote": "只有选「直连」类后端时才需要填写。密钥仅存于当前页面的内存，刷新即清除，不会写入本地存储。",
    "api.backend": "后端",
    "api.customOnly": "只有自建 / 直连后端需要改这里",
    "api.retry": "自动重试",
    "api.retryNote": "只对瞬时故障重试（网络错误 / 429 / 5xx）。参数错误、鉴权失败会直接报错。 填",
    "api.retryInfNote": "表示无限重试。",
    "api.phRetryMax": "最大次数，或 inf",
    "api.phRetryBase": "退避基数 ms",
    "api.reset": "恢复默认",
    "api.resetTitle": "自动重试参数回到出厂值；后端与密钥不受影响",
    "api.cancel": "取消",
    "api.save": "保存",

    /* ---------- 日志面板 ---------- */
    "log.title": "调用日志",
    "log.desc": "每一次请求的完整往返。展开可看原始 JSON 并单独复制。",
    "log.empty": "还没有请求记录",
    "log.copyAll": "复制全部",
    "log.clear": "清空",
    "log.clearTitle": "清空全部调用日志（不可撤销）",
    "log.done": "完成",
    "log.turnCount": "{n} 条",
    "log.failed": "失败",
    "log.noResponse": "（无 —— 本次调用失败）",
    "log.reason": "决策依据",
    "log.copyReq": "复制请求",
    "log.copyRes": "复制响应",
    "log.copyBoth": "复制完整调用",
    "log.reqLabel": "请求 request",
    "log.resLabel": "响应 response",
    "log.pagedNote": "仅显示最近 {n} 条，更早的可用「复制全部」导出",

    /* ---------- 存档面板 ---------- */
    "archive.title": "存档",
    "archive.desc": "四类内容各自独立成档，可分别备份与恢复。导出的是 JSON 文件，导入时逐项校验。",
    "archive.game": "游戏（对局）",
    "archive.gameDesc": "当前棋盘、分数、轮次、记忆，以及棋盘尺寸与历史最高分／最大瓷砖。",
    "archive.strategy": "策略",
    "archive.strategyDesc": "上下文（规则说明、策略提示、后果预测、记忆轮数）与规则（决策策略、置信度门槛）。",
    "archive.apiDesc": "自动重试参数。",
    "archive.noKey": "不含密钥",
    "archive.noKeyDesc": "—— 密钥从不落盘，因此也无法导出。",
    "archive.log": "调用日志",
    "archive.logDesc": "全部请求记录（含完整请求体与响应）。只支持导出 —— 日志是过程记录，导入它没有意义。",
    "archive.all": "整体",
    "archive.exportAll": "导出全部",
    "archive.wipe": "清空存档",
    "archive.wipeTitle": "清除本机全部存档并重新载入",
    "archive.export": "导出",
    "archive.import": "导入",
    "archive.logExportOnly": "日志只导出，不支持导入",
    "archive.done": "完成",

    /* ---------- 不兼容存档模态框 ---------- */
    "incompat.title": "发现不兼容的旧存档",
    "incompat.desc": "本机存有一份旧数据，但当前版本读不懂它。",
    "incompat.none": "没有",
    "incompat.whyEdited": "它可能是更早版本写下的，或者已被外部修改。",
    "incompat.whyKept": "为避免丢掉你原本的进度，应用",
    "incompat.whyDecide": "自动清理它 —— 请先决定如何处理。",
    "incompat.reason": "读取失败的原因",
    "incompat.raw": "原始数据（截断预览，大小",
    "incompat.force": "强行加载",
    "incompat.salvage": "会尽力从这份数据里抢救出可用的部分： 棋盘与分数通常没问题，读不懂的字段会被丢弃并如实告知。",
    "incompat.order": "建议顺序：先「导出旧数据」留底，再决定强行加载还是重置。",
    "incompat.export": "⬇ 导出旧数据",
    "incompat.reset": "重置回默认",
    "incompat.later": "稍后再说",

    /* ---------- 额度不足模态框 ---------- */
    "quota.title": "额度不足",
    "quota.desc": "当前后端的调用额度已用尽或被限流。",
    "quota.serverReturned": "服务端返回",
    "quota.whatCanDo": "可以怎么做",
    "quota.notNetwork": "这通常不是网络问题，重试也不会恢复 —— 换个后端或用自己的 Key 即可继续。",
    "quota.gateway": "Vercel AI Gateway",
    "quota.gatewayBold": "Vercel AI Gateway 直连",
    "quota.gatewayHint": "，填自己的 API Key（推荐，额度归你掌控）",
    "quota.official": "TypeSafe 官方",
    "quota.or": "或",
    "quota.backendWord": "后端",
    "quota.step3": "3. 稍后再试 —— 如果是共享额度的免费试用，等它恢复",
    "quota.switch": "去切换后端",
    "quota.later": "稍后再说",

    /* ---------- 后端描述 ---------- */
    "backend.freeTrial": "免费试用",
    "backend.freeTrialDesc":
      "由本站的服务器端代为调用，API Key 只存在于服务端环境变量，浏览器全程接触不到（DevTools 里也看不到）。额度有限，用尽后请改用其他后端。",
    "backend.freeTrial2": "免费试用 2",
    "backend.freeTrial2Desc":
      "与「免费试用」同一套服务端代理架构，走另一个上游。密钥同样只存在于服务端。额度独立，一个用尽时另一个可能还有余量。",
    "backend.vercel": "Vercel AI Gateway",
    "backend.vercelDesc":
      "浏览器直连。端点 /v1/evaluate，CORS 已实测全开，但密钥会进入浏览器内存。",
    "backend.openrouter": "OpenRouter 直连",
    "backend.openrouterDesc":
      "已实测可用。模型 ID 必须是 typesafe/jev-1.13（typesafe/jev-latest 与 typesafe-ai/jev 都会报不存在）。注意：OpenRouter 的布尔类型判别值是 noul，Vercel 那边叫 boolean，两家相反。",
    "backend.typesafe": "TypeSafe 官方",
    "backend.typesafeDesc":
      "端点与协议已由官方公开的 openapi.json（v0.2.0）确认：只有 POST /v1/systemone 一个决策端点。未持密钥实测过。布尔类型判别值是 noul。需要 TypeSafe 账号。",
    "backend.laya": "本地 Laya 服务器",
    "backend.layaDesc":
      "Laya 是 Jev 的开源替代：非自回归决策模型，一次前向回答全部问题，无文本生成。它本身是 Python 包、不带 HTTP 服务，需要自己包一层实现 SystemOne 协议的 sidecar。注意上下文窗口小得多（english=512 / multilingual 与 typed-decisions=1024 token），且 confidence 不在同一尺度 —— 为 Jev 标定的阈值不能直接套用。类型判别值是 noul。无鉴权、无计费、不出网。",
    "backend.custom": "自建 / 本地兼容端点",
    "backend.customDesc":
      "指向任何实现了 SystemOne 协议的服务 —— LiteLLM proxy 的 /typesafe 透传、LangChain TypeSafeClassifier 配 TYPESAFE_BASE_URL、或你自己写的一层转换。注意：普通的 OpenAI 兼容端点（LM Studio / vLLM / Ollama 的 /v1/chat/completions）打不通 Jev —— 它是决策模型不是文本模型。必须让本地侧实现 SystemOne 协议，把 OpenAI 兼容留在文本模型那一层。",

    /* ---------- 后端标签与提示 ---------- */
    "backend.remoteSuffix": "{label}（远端）",
    "backend.quotaWord": "额度",
    "backend.balanceWord": "余额",
    "backend.quotaAltWord": "配额",
    "backend.unverifiedTag": " (未验证)",
    "backend.currentTitle": "当前后端：{label}\n模型：{model}",
    "backend.modelManaged": "由本站指定",
    "backend.modelManagedHint": "由本站服务端决定，无需也无法修改",
    "backend.modelPlaceholder": "留空即用该后端的默认模型（{model}）",
    "backend.verifiedOk": "✅ 已验证可用。",
    "backend.unverified": "⚠ 未经实测验证。",
    "backend.keyPlaceholder": "粘贴你的 API Key（仅存内存，刷新即清除）",
    "backend.noKeyPlaceholder": "无需填写 —— 开箱即用",
    "backend.needConfig": "请在 API 中配置",

    /* ---------- 自动重试预览 ---------- */
    "retry.none": "不重试",
    "retry.sequence": "等待序列：{seq}",
    "retry.inf": "无限",

    /* ---------- 状态栏 ---------- */
    "status.online": "Jev 在线",
    "status.ready": "就绪",
    "status.paused": "已暂停",
    "status.quota": "额度不足",
    "status.apiFail": "API 失败",
    "status.calling": "调用 Jev…",
    "status.retrying": "重试 {n}（{s}s 后）",
    "status.noMoves": "无可用移动",

    /* ---------- 覆盖层 / 游戏结束 ---------- */
    "over.gameOver": "游戏结束",
    "over.stats": "得分 {score}　最大方块 {max}　共 {turn} 回合",
    "over.best": "历史最高分 {best}　历史最大瓷砖 {bt}",
    "over.again": "再来一局",
    "over.retry": "重试",
    "over.skip": "跳过这一手",
    "over.apiFail": "API 调用失败",
    "over.failBody": "{msg}\n\n已按设置重试 {n} 次仍未成功。",
    "over.failBodyInf": "{msg}\n\n已按设置无限重试仍未成功。",
    "over.quotaBody": "额度不足：{msg}",

    /* ---------- toast ---------- */
    "toast.copied": "已复制 ✓",
    "toast.copyFail": "复制失败",
    "toast.exported": "已导出{label}",
    "toast.imported": "已导入：{list}",
    "toast.importEmpty": "档案为空，未做改动",
    "toast.importFail": "导入失败：{msg}",
    "toast.readFail": "读取失败：{msg}",
    "toast.kindMismatch": "这是一份「{from}」档案，不能导入到「{to}」位置",

    /* ---------- 存档字段名 ---------- */
    "field.gameSettings": "游戏设置",
    "field.context": "上下文",
    "field.apiSettings": "API 设置",
    "field.highScores": "历史最高分",
    "field.bestTiles": "历史最大瓷砖",
    "field.gameAtTurn": "对局（第 {n} 手）",
    "kind.game": "对局",
    "kind.strategy": "策略",
    "kind.api": "API 设置",
    "kind.log": "日志",
    "kind.all": "全部",

    /* ---------- 确认框 ---------- */
    "confirm.wipeAll":
      "清空全部本地存档？\n（设置、历史最高分、当前对局与调用日志都会被清除，且无法恢复）",
    "confirm.gameReset":
      "恢复游戏的默认设置？\n（棋盘尺寸、新方块区间、动效都会回到出厂值；历史最高分保留）",
    "confirm.strategyReset":
      "恢复策略的默认设置？\n（上下文文本、后果预测、记忆、决策策略、阈值都会回到出厂值）",
    "confirm.scoreReset":
      "重置所有历史最高分与最大瓷砖？\n（各棋盘尺寸的纪录都会被清空，当前对局不受影响）",
    "confirm.apiReset":
      "恢复 API 的默认设置？\n（自动重试参数回到出厂值；后端与密钥不受影响）",
    "confirm.logClear": "清空全部调用日志？此操作不可撤销。",
    "confirm.incompatReset": "重置回默认？\n旧存档将被清除且无法恢复（建议先导出）。",
    "confirm.scoresReset": "已重置最高分",
    "confirm.resetDone": "已重置回默认",
    "confirm.kept": "旧存档已保留，未做处理",

    /* ---------- 不兼容存档的处理结果 ---------- */
    "salvage.rawGone": "原始数据已不存在",
    "salvage.exported": "已导出旧数据",
    "salvage.forceFail": "无法强行加载：数据里没有可用的棋盘",
    "salvage.forced": "已强行加载 · 第 {n} 手",
    "salvage.forcedPartial": "已强行加载。注意：{list}",
    "salvage.forcedShort": "已强行加载上一局（第 {n} 手）",
    "salvage.restoredShort": "已恢复上一局 · 第 {n} 手",

    /* ---------- 启动期 ---------- */
    "boot.missingDom": "页面缺少 {n} 个必需元素：{list}",
    "boot.missingDomHint": "这通常意味着 index.html 与 main.ts 不同步。",
    "boot.failed": "启动失败",
    "boot.failedBody": "启动失败\n\n{msg}\n\n请把这条信息报告给开发者。",

    /* ---------- 错误 ---------- */
    "err.noChoice": "响应中缺少 choice 类型的 best_move",
    "err.connect": "无法连接 {url}：{msg}",
    "err.notJson": "响应不是 JSON (HTTP {status})：{body}",
    "err.noAnswers": "响应缺少 answers 字段：{body}",
    "err.noCanvas": "无法获取 2D 绘图上下文",

    /* ---------- 存档解析错误 ---------- */
    "sesserr.notObject": "存档内容不是一个对象",
    "sesserr.badJson": "存档不是合法 JSON（可能已损坏）",
    "sesserr.versionHigh": "存档版本 v{v} 高于当前支持的 v{cur}",
    "sesserr.noSize": "存档缺少棋盘宽高",
    "sesserr.badTiles": "存档的方块列表已损坏",
    "sesserr.noScore": "存档缺少分数",
    "sesserr.noTurn": "存档缺少轮次",
    "sesserr.badTile": "存档里有结构不完整的方块",
    "salv.tilesDropped": "方块 {n} 个损坏已丢弃",
    "salv.size": "棋盘宽高已用默认值 4×4",
    "salv.score": "分数已归零",
    "salv.turn": "轮次已归零",
    "salv.memory": "记忆已清空",
    "salv.log": "调用日志已清空",

    /* ---------- 档案错误 ---------- */
    "arcerr.badJson": "不是合法的 JSON 文件",
    "arcerr.notObject": "档案内容不是一个对象",
    "arcerr.notOurs": "这不像是本应用的存档（缺少 app 标记）",
    "arcerr.noVersion": "档案缺少版本号",
    "arcerr.versionHigh": "档案版本 v{v} 高于当前支持的 v{cur}，请升级应用后再导入",
    "arcerr.unknownKind": "未知的档案类型：{kind}",
    "arcerr.noPayload": "档案缺少 payload",
    "arcerr.logNoImport": "日志档案不支持导入",
    "arcerr.readFail": "读取文件失败",

    /* ---------- 决策依据（decision.ts，会显示在决策面板上）---------- */
    "reason.noProb": "响应中没有概率分布，取首个合法方向",
    "reason.sampled": "按分布采样",
    "reason.belowThreshold": "Jev 仅 {p}%，低于阈值 {t}%",
    "reason.takeTop": "取最高概率",
    "reason.coerced": "Jev 首选 {move} 非法，取其分布内次优合法方向",
    "reason.noLegal": "模型分布中无合法方向，取首个合法方向",

    /* ---------- 方向名（仅用于界面显示，不用于喂给 Jev 的 criteria）---------- */
    "dir.up": "上",
    "dir.down": "下",
    "dir.left": "左",
    "dir.right": "右",

    /* ---------- 开发者控制台 ---------- */
    "dev.spawnFail": "[Jev×2048] 初始瓷砖放置失败，已兜底放置一个",
    "dev.bootFail": "[Jev×2048] 启动失败：",
    "dev.bootInfo": "[Jev×2048] 棋盘 {cols}×{rows}　生成 {min}–{max} ({dist})　记忆 {mem}　阈值 {th}",
    "dev.memMax": "最大",
  },

  en: {
    /* ---------- Top bar ---------- */
    "app.subtitle": "Decisions made by the Jev evaluation model",
    "app.subtitleTitle":
      "Every move is decided by the Jev evaluation model — it returns calibrated probabilistic decisions rather than generated text",
    "nav.game": "Game",
    "nav.gameTitle": "Board size, spawn range and effects — natural properties unrelated to you or Jev",
    "nav.strategy": "Strategy",
    "nav.strategyTitle": "Context (what Jev sees) and rules (how the answer is applied)",
    "nav.apiTitle": "Which provider to use, and how calls are made",
    "nav.log": "Log",
    "nav.logTitle": "The full round trip of every request",
    "nav.archive": "Archive",
    "nav.archiveTitle": "Import / export: game, strategy, API settings, call log",
    "nav.githubTitle": "View the source on GitHub · stars and issues welcome",
    "nav.langTitle": "界面语言 / Interface language",
    "nav.langName": "English",

    /* ---------- Controls under the board ---------- */
    "ctrl.takeover": "▶ Let Jev play",
    "ctrl.pause": "⏸ Pause",
    "ctrl.takeoverTitle": "Let Jev play / pause auto-play (Space)",
    "ctrl.step": "Step",
    "ctrl.stepTitle": "Play a single move",
    "ctrl.new": "↺ New game",
    "ctrl.newTitle": "Start a new game, keeping all settings",
    "ctrl.hintManual": "manual ·",
    "ctrl.hintPause": "pause",
    "fb.label": "Heuristic fallback",
    "pace.label": "Step interval",
    "pace.title": "Interval between auto-play moves. 0 = no wait, as fast as the upstream responds",
    "pace.instant": "instant",

    /* ---------- Decision panel ---------- */
    "decision.title": "Jev decision",
    "decision.idle": "Not started yet",
    "decision.confidence": "conf.",
    "decision.restored": "Restored the previous game (move {n})",

    /* ---------- Chart and stats ---------- */
    "chart.title": "Confidence tracking",
    "chart.band": "band",
    "chart.median": "median",
    "chart.waiting": "Waiting for game data",
    "stats.ready": "Ready",
    "stats.total": "Total",
    "stats.latency": "Latency",

    /* ---------- Game panel ---------- */
    "game.title": "Game",
    "game.desc":
      "Natural properties of the board and new tiles. Nothing here affects what Jev sees, or how it decides.",
    "game.boardSize": "Board size (width × height, independent)",
    "game.boardHint": "2 – 16. Changing this immediately starts a new game; records are kept per width×height.",
    "game.phWidth": "W 4",
    "game.phHeight": "H 4",
    "game.spawnRange": "New tile value range (exponent of 2)",
    "game.spawnHint": "Enter the exponent n; the actual value is 2ⁿ — 0 → 1, 1 → 2, 2 → 4, and so on.",
    "game.phSpawnMin": "min 0",
    "game.phSpawnMax": "max 2",
    "game.spawnWarn": "The exponent must be a non-negative integer, and the upper bound must not be below the lower one",
    "game.dist": "Spawn distribution",
    "game.distWeighted": "Weighted — weight is the inverse of the value, so larger values are rarer (default)",
    "game.distUniform": "Uniform — every value in the range is equally likely",
    "game.distNote": "Weighted makes 2 about twice as likely as 4 (P(2)=2/3); uniform splits them evenly.",
    "game.initRange": "Initial tile count range",
    "game.initDesc":
      "How many tiles are placed at the start. The lower bound cannot be less than 1 — on an empty board no direction can move, so the first move would end the game immediately.",
    "game.phMin1": "min 1",
    "game.phMax2": "max 2",
    "game.initWarn": "The lower bound must be at least 1 and no greater than the upper bound",
    "game.fx": "Effects",
    "game.fxAnim": "Slide / merge / spawn animations",
    "game.fxParticles": "Direction arrow particles",
    "game.reset": "Restore defaults",
    "game.resetTitle": "Reset board size, spawn range and effects to factory values",
    "game.scoreReset": "Reset records",
    "game.scoreResetTitle": "Clear the best score and best tile for every board size",
    "game.done": "Done",

    /* ---------- Strategy panel ---------- */
    "strategy.title": "Strategy",
    "strategy.introA": "Two parts:",
    "strategy.introCtx": "Context",
    "strategy.introMid": "decides what Jev sees;",
    "strategy.introRule": "Rules",
    "strategy.introEnd": "decide what happens with the answer.",
    "strategy.ctx": "Context",
    "strategy.ctxNote": "Changes here go into the request and shape Jev's judgment — see the probability distribution",
    "strategy.ruleDescLabel": "Rule description → state.rule_description",
    "strategy.hintLabel": "Strategy hint → state.strategy_hint",
    "strategy.criteriaLabel": "Consequence forecast → questions.criteria",
    "strategy.criteriaOn": "Include each move's concrete consequences",
    "strategy.criteriaDesc": "When on, every candidate direction carries its merge score, the remaining empty cells, and whether the largest tile ends up in a corner. Turn it off and Jev sees only the direction names.",
    "strategy.memoryLabel": "Memory turns → state.recent_history",
    "strategy.max": "Max",
    "strategy.maxTitle": "Fill as much as the context budget allows",
    "strategy.memoryNote": "The cap is bounded by the model context window (55% of a 32000 token budget).",
    "strategy.memoryDesc": "Sends the last n turns — the board, the direction taken, and the score at the time — alongside the request. 0 = no memory (original behaviour).",
    "strategy.rule": "Rules",
    "strategy.ruleNote": "Not sent to Jev — see which move was actually taken instead",
    "strategy.policy": "Decision policy",
    "strategy.greedy": "Greedy — take the highest-probability legal direction",
    "strategy.sample": "Sampled — draw from the distribution (exploratory)",
    "strategy.thresholdOpt": "Confidence gate — flag moves below the threshold",
    "strategy.thresholdLabel": "Confidence threshold",
    "strategy.thresholdNote": "Read it off the confidence chart: turns below this value get flagged.",
    "strategy.noHeuristic": "This demo has no heuristic fallback: when Jev is unsure, the app does not quietly switch to another algorithm — it surfaces the uncertainty for you to judge.",
    "strategy.presetEn": "Apply English preset",
    "strategy.presetEnTitle": "Replace the rule description and strategy hint with the English versions (current content is overwritten)",
    "strategy.presetZh": "Apply Chinese preset",
    "strategy.presetZhTitle": "Replace the rule description and strategy hint with the Chinese versions (current content is overwritten)",
    "strategy.reset": "Restore defaults",
    "strategy.resetTitle": "Reset context and rules to factory values",
    "strategy.done": "Done",

    /* ---------- API panel ---------- */
    "api.title": "API",
    "api.desc": "Which provider to use and how to call it. This only affects delivery, not the prompts or game rules.",
    "api.keySafety": "Key safety",
    "api.keyNote": "Only needed for direct-connection backends. The key lives in this page's memory only, is cleared on refresh, and is never written to local storage.",
    "api.backend": "Backend",
    "api.customOnly": "Only custom / direct backends need changes here",
    "api.retry": "Automatic retry",
    "api.retryNote": "Retries transient failures only (network errors / 429 / 5xx). Parameter errors and auth failures fail immediately. Enter",
    "api.retryInfNote": "to retry without limit.",
    "api.phRetryMax": "max attempts, or inf",
    "api.phRetryBase": "backoff base ms",
    "api.reset": "Restore defaults",
    "api.resetTitle": "Reset retry settings to factory values; backend and key are untouched",
    "api.cancel": "Cancel",
    "api.save": "Save",

    /* ---------- Log panel ---------- */
    "log.title": "Call log",
    "log.desc": "The full round trip of every request. Expand to see the raw JSON and copy it individually.",
    "log.empty": "No requests recorded yet",
    "log.copyAll": "Copy all",
    "log.clear": "Clear",
    "log.clearTitle": "Clear the entire call log (irreversible)",
    "log.done": "Done",
    "log.turnCount": "{n}",
    "log.failed": "failed",
    "log.noResponse": "(none — this call failed)",
    "log.reason": "Reasoning",
    "log.copyReq": "Copy request",
    "log.copyRes": "Copy response",
    "log.copyBoth": "Copy full call",
    "log.reqLabel": "request",
    "log.resLabel": "response",
    "log.pagedNote": "Showing only the latest {n}; use “Copy all” to export the rest",

    /* ---------- Archive panel ---------- */
    "archive.title": "Archive",
    "archive.desc":
      "Four independent archives, each backed up and restored separately. Exports are JSON files, and imports are validated item by item.",
    "archive.game": "Game (session)",
    "archive.gameDesc": "Current board, score, turn, memory, plus board size, best score and best tile.",
    "archive.strategy": "Strategy",
    "archive.strategyDesc":
      "Context (rule description, strategy hint, consequence forecast, memory turns) and rules (decision policy, confidence threshold).",
    "archive.apiDesc": "Retry settings.",
    "archive.noKey": "No keys",
    "archive.noKeyDesc": "— keys are never persisted, so they cannot be exported either.",
    "archive.log": "Call log",
    "archive.logDesc":
      "Every request record, including the full request body and response. Export only — the log is a process record, and importing it serves no purpose.",
    "archive.all": "Everything",
    "archive.exportAll": "Export all",
    "archive.wipe": "Wipe archive",
    "archive.wipeTitle": "Clear all local archives and reload",
    "archive.export": "Export",
    "archive.import": "Import",
    "archive.logExportOnly": "The log is export-only and cannot be imported",
    "archive.done": "Done",

    /* ---------- Incompatible archive modal ---------- */
    "incompat.title": "Incompatible saved data found",
    "incompat.desc": "This browser holds older data that the current version cannot read.",
    "incompat.none": "not",
    "incompat.whyEdited": "It may have been written by an earlier version, or modified from outside.",
    "incompat.whyKept": "To avoid losing your existing progress, the app has",
    "incompat.whyDecide": "cleaned it up — decide how to proceed first.",
    "incompat.reason": "Why reading failed",
    "incompat.raw": "Raw data (truncated preview, size",
    "incompat.force": "Force load",
    "incompat.salvage": "will salvage whatever it can from this data: the board and the score are usually fine, and fields it cannot read are dropped and reported truthfully.",
    "incompat.order": "Suggested order: export the old data first as a backup, then decide between force loading and resetting.",
    "incompat.export": "⬇ Export old data",
    "incompat.reset": "Reset to defaults",
    "incompat.later": "Later",

    /* ---------- Quota modal ---------- */
    "quota.title": "Quota exhausted",
    "quota.desc": "The current backend has run out of quota or is being rate limited.",
    "quota.serverReturned": "Server returned",
    "quota.whatCanDo": "What you can do",
    "quota.notNetwork": "This is usually not a network problem, and retrying will not fix it — switch to another backend or use your own key to continue.",
    "quota.gateway": "Vercel AI Gateway",
    "quota.gatewayBold": "Vercel AI Gateway direct",
    "quota.gatewayHint": " directly with your own API key (recommended — the quota is yours)",
    "quota.official": "TypeSafe official",
    "quota.or": "or",
    "quota.backendWord": "backend",
    "quota.step3": "3. Try again later — if this is a shared-quota free trial, wait for it to recover",
    "quota.switch": "Switch backend",
    "quota.later": "Later",

    /* ---------- Backend descriptions ---------- */
    "backend.freeTrial": "Free trial",
    "backend.freeTrialDesc":
      "Proxied by this site's server. The API key lives only in a server-side environment variable and never reaches the browser (it is not visible in DevTools either). The quota is limited; switch to another backend once it runs out.",
    "backend.freeTrial2": "Free trial 2",
    "backend.freeTrial2Desc":
      "Same server-side proxy architecture as “Free trial”, routed to a different upstream. The key likewise lives only on the server. The quotas are independent, so when one runs out the other may still have room.",
    "backend.vercel": "Vercel AI Gateway",
    "backend.vercelDesc":
      "Called directly from the browser. Endpoint /v1/evaluate; CORS was verified wide open, but the key does enter browser memory.",
    "backend.openrouter": "OpenRouter direct",
    "backend.openrouterDesc":
      "Verified working. The model ID must be typesafe/jev-1.13 (both typesafe/jev-latest and typesafe-ai/jev report as not found). Note: OpenRouter's boolean discriminator is noul, while Vercel calls it boolean — the two are opposite.",
    "backend.typesafe": "TypeSafe official",
    "backend.typesafeDesc":
      "Endpoint and protocol confirmed by the vendor's public openapi.json (v0.2.0): a single decision endpoint, POST /v1/systemone. Not tested with a real key. The boolean discriminator is noul. Requires a TypeSafe account.",
    "backend.laya": "Local Laya server",
    "backend.layaDesc":
      "Laya is an open-source alternative to Jev: a non-autoregressive decision model that answers all questions in one forward pass with no text generation. It is a Python package with no HTTP server, so you need to wrap a SystemOne-protocol sidecar around it. Note the much smaller context window (english=512 / multilingual and typed-decisions=1024 tokens), and that confidence is on a different scale — thresholds calibrated for Jev do not transfer. The type discriminator is noul. No auth, no billing, no network egress.",
    "backend.custom": "Custom / local compatible endpoint",
    "backend.customDesc":
      "Point it at anything implementing the SystemOne protocol — LiteLLM proxy's /typesafe passthrough, LangChain's TypeSafeClassifier with TYPESAFE_BASE_URL, or a translation layer of your own. Note: a plain OpenAI-compatible endpoint (LM Studio / vLLM / Ollama /v1/chat/completions) cannot reach Jev — it is a decision model, not a text model. The local side must implement SystemOne, leaving OpenAI compatibility to the text-model layer.",

    /* ---------- Backend labels and hints ---------- */
    "backend.remoteSuffix": "{label} (remote)",
    "backend.quotaWord": "quota",
    "backend.balanceWord": "balance",
    "backend.quotaAltWord": "allowance",
    "backend.unverifiedTag": " (unverified)",
    "backend.currentTitle": "Current backend: {label}\nModel: {model}",
    "backend.modelManaged": "Set by this site",
    "backend.modelManagedHint": "Decided by this site's server; it cannot be changed",
    "backend.modelPlaceholder": "Leave empty to use this backend's default model ({model})",
    "backend.verifiedOk": "✅ Verified working.",
    "backend.unverified": "⚠ Not verified against a live endpoint.",
    "backend.keyPlaceholder": "Paste your API key (memory only, cleared on refresh)",
    "backend.noKeyPlaceholder": "Nothing to fill in — it works out of the box",
    "backend.needConfig": "Configure it under API",

    /* ---------- Retry preview ---------- */
    "retry.none": "No retry",
    "retry.sequence": "Wait sequence: {seq}",
    "retry.inf": "infinite",

    /* ---------- Status bar ---------- */
    "status.online": "Jev online",
    "status.ready": "Ready",
    "status.paused": "Paused",
    "status.quota": "Quota exhausted",
    "status.apiFail": "API error",
    "status.calling": "Calling Jev…",
    "status.retrying": "Retry {n} (in {s}s)",
    "status.noMoves": "No legal move",

    /* ---------- Overlay / game over ---------- */
    "over.gameOver": "Game over",
    "over.stats": "Score {score}　Best tile {max}　{turn} turns",
    "over.best": "Best score {best}　Best tile ever {bt}",
    "over.again": "Play again",
    "over.retry": "Retry",
    "over.skip": "Skip this move",
    "over.apiFail": "API call failed",
    "over.failBody": "{msg}\n\nStill failing after {n} retries as configured.",
    "over.failBodyInf": "{msg}\n\nStill failing after unlimited retries as configured.",
    "over.quotaBody": "Quota exhausted: {msg}",

    /* ---------- Toasts ---------- */
    "toast.copied": "Copied ✓",
    "toast.copyFail": "Copy failed",
    "toast.exported": "Exported {label}",
    "toast.imported": "Imported: {list}",
    "toast.importEmpty": "The archive was empty; nothing changed",
    "toast.importFail": "Import failed: {msg}",
    "toast.readFail": "Reading failed: {msg}",
    "toast.kindMismatch": "This is a “{from}” archive and cannot be imported into “{to}”",

    /* ---------- Archive field names ---------- */
    "field.gameSettings": "Game settings",
    "field.context": "Context",
    "field.apiSettings": "API settings",
    "field.highScores": "Best scores",
    "field.bestTiles": "Best tiles",
    "field.gameAtTurn": "Session (move {n})",
    "kind.game": "session",
    "kind.strategy": "strategy",
    "kind.api": "API settings",
    "kind.log": "log",
    "kind.all": "everything",

    /* ---------- Confirmation dialogs ---------- */
    "confirm.wipeAll":
      "Clear all local archives?\n(Settings, best scores, the current game and the call log will all be erased, irreversibly)",
    "confirm.gameReset":
      "Restore the game's default settings?\n(Board size, spawn range and effects return to factory values; best scores are kept)",
    "confirm.strategyReset":
      "Restore the strategy defaults?\n(Context text, consequence forecast, memory, decision policy and threshold all return to factory values)",
    "confirm.scoreReset":
      "Reset all best scores and best tiles?\n(Records for every board size are cleared; the current game is unaffected)",
    "confirm.apiReset":
      "Restore the API defaults?\n(Retry settings return to factory values; backend and key are untouched)",
    "confirm.logClear": "Clear the entire call log? This cannot be undone.",
    "confirm.incompatReset": "Reset to defaults?\nThe old data will be erased and cannot be recovered (export it first).",
    "confirm.scoresReset": "Records reset",
    "confirm.resetDone": "Reset to defaults",
    "confirm.kept": "Old data kept; nothing changed",

    /* ---------- Salvage outcomes ---------- */
    "salvage.rawGone": "The raw data no longer exists",
    "salvage.exported": "Old data exported",
    "salvage.forceFail": "Cannot force load: no usable board in the data",
    "salvage.forced": "Force loaded · move {n}",
    "salvage.forcedPartial": "Force loaded. Note: {list}",
    "salvage.forcedShort": "Force loaded the previous game (move {n})",
    "salvage.restoredShort": "Restored the previous game · move {n}",

    /* ---------- Boot ---------- */
    "boot.missingDom": "The page is missing {n} required element(s): {list}",
    "boot.missingDomHint": "This usually means index.html and main.ts are out of sync.",
    "boot.failed": "Startup failed",
    "boot.failedBody": "Startup failed\n\n{msg}\n\nPlease report this message to the developer.",

    /* ---------- Errors ---------- */
    "err.noChoice": "The response is missing a choice-type best_move",
    "err.connect": "Cannot connect to {url}: {msg}",
    "err.notJson": "Response is not JSON (HTTP {status}): {body}",
    "err.noAnswers": "Response is missing the answers field: {body}",
    "err.noCanvas": "Cannot get a 2D drawing context",

    /* ---------- Session parse errors ---------- */
    "sesserr.notObject": "Saved data is not an object",
    "sesserr.badJson": "Saved data is not valid JSON (possibly corrupted)",
    "sesserr.versionHigh": "Saved data version v{v} is newer than the supported v{cur}",
    "sesserr.noSize": "Saved data is missing board dimensions",
    "sesserr.badTiles": "The saved tile list is corrupted",
    "sesserr.noScore": "Saved data is missing the score",
    "sesserr.noTurn": "Saved data is missing the turn count",
    "sesserr.badTile": "Saved data contains structurally incomplete tiles",
    "salv.tilesDropped": "{n} corrupted tile(s) dropped",
    "salv.size": "Board dimensions fell back to the default 4×4",
    "salv.score": "Score reset to zero",
    "salv.turn": "Turn count reset to zero",
    "salv.memory": "Memory cleared",
    "salv.log": "Call log cleared",

    /* ---------- Archive errors ---------- */
    "arcerr.badJson": "Not a valid JSON file",
    "arcerr.notObject": "The archive content is not an object",
    "arcerr.notOurs": "This does not look like an archive from this app (missing the app marker)",
    "arcerr.noVersion": "The archive is missing a version number",
    "arcerr.versionHigh": "Archive version v{v} is newer than the supported v{cur}; upgrade the app before importing",
    "arcerr.unknownKind": "Unknown archive kind: {kind}",
    "arcerr.noPayload": "The archive is missing its payload",
    "arcerr.logNoImport": "Log archives cannot be imported",
    "arcerr.readFail": "Failed to read the file",

    /* ---------- Decision reasons (shown in the decision panel) ---------- */
    "reason.noProb": "No probability distribution in the response; taking the first legal direction",
    "reason.sampled": "Sampled from the distribution",
    "reason.belowThreshold": "Jev gave only {p}%, below the {t}% threshold",
    "reason.takeTop": "Taking the highest probability",
    "reason.coerced": "Jev's first choice {move} is illegal; taking the next best legal direction in its distribution",
    "reason.noLegal": "No legal direction in the model's distribution; taking the first legal one",

    /* ---------- Direction names (display only — never used in Jev's criteria) ---------- */
    "dir.up": "Up",
    "dir.down": "Down",
    "dir.left": "Left",
    "dir.right": "Right",

    /* ---------- Developer console ---------- */
    "dev.spawnFail": "[Jev×2048] Initial tile placement failed; fell back to placing one",
    "dev.bootFail": "[Jev×2048] Startup failed:",
    "dev.bootInfo": "[Jev×2048] board {cols}×{rows}　spawn {min}–{max} ({dist})　memory {mem}　threshold {th}",
    "dev.memMax": "max",
  },
};

let current: Lang = "zh";

const listeners: Array<() => void> = [];

/**
 * 从 BCP-47 语言标签判断用哪门界面语言：`zh` 开头一律中文（含 zh-CN / zh-Hant），
 * 其余一律英文。
 *
 * 抽成纯函数是为了可测 —— `detectLang` 依赖全局 `navigator`，在 Node 里不好造。
 */
export function langFromTag(tag: string | undefined): Lang {
  return /^zh/i.test(tag ?? "") ? "zh" : "en";
}

/** 按浏览器语言猜一个默认值。没有 navigator（如 Node）时回落到中文。 */
export function detectLang(): Lang {
  if (typeof navigator === "undefined") return "zh";
  return langFromTag(navigator.language);
}

export function getLang(): Lang {
  return current;
}

/**
 * 设置当前语言。
 *
 * 只管内存状态与广播，**不碰持久化** —— 落盘由 `main.ts` 订阅后写入 config，
 * 这样 i18n 不必反向依赖 config，避免循环引用。
 */
export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  for (const cb of listeners) cb();
}

/** 订阅语言变更，返回取消订阅的函数 */
export function onLangChange(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** 语言的自称，用于切换按钮的标签 —— 刻意不翻译 */
export function langName(l: Lang): string {
  return DICT[l]["nav.langName"];
}

/**
 * 取词条并做参数插值。
 *
 * 缺 key 时依次回落到中文词条、最后回落到 key 本身 —— **绝不抛异常**：
 * 界面不该因为漏翻一条就整个白屏，那正是这个项目踩过的坑
 * （见 tools/check-dom.ts 的注释）。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const s = DICT[current][key] ?? DICT.zh[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  );
}

/** 把 `data-i18n*` 属性扫一遍写回 DOM */
export function applyDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    if (key) el.innerHTML = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((el) => {
    const key = el.dataset.i18nPh;
    if (key) el.placeholder = t(key);
  });
  // 同步 <html lang>，让浏览器按正确语言处理断行、拼写检查与朗读。
  // 先判 document 是否存在 —— 否则在 Node（测试环境）里引用 document 会直接抛错。
  if (typeof document === "undefined") return;
  if (root === document || root === document.documentElement) {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  }
}

/** 词条表的只读视图，仅供测试断言用 */
export function dictFor(l: Lang): Readonly<Record<string, string>> {
  return DICT[l];
}
