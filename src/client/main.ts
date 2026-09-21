/**
 * 装配层：引擎 / 渲染 / 图表 / API / 决策策略 → DOM。
 *
 * 布局：界面锁在 100dvh 内，棋盘由 ResizeObserver 取 min(可用宽, 可用高) 定尺寸。
 */
import {
  COLS,
  ROWS,
  MAX_SPAWN_EXP,
  spawnExpOf,
  spawnValueOf,
  setBoardSize,
  type BackendConfig,
  type BackendId,
  type ChoiceAnswer,
  type Direction,
  type MemoryEntry,
  type Questions,
  type Strategy,
  type Tile,
  type TurnLog,
} from "../shared/types.js";
import {
  cloneTiles,
  ensureTileSeqAbove,
  isGameOver,
  makeTile,
  maxTile,
  moveTiles,
  spawnTile,
  toGrid,
  validMoves,
} from "./engine.js";
import {
  clearSession,
  commitForced,
  forceLoadSession,
  loadSession,
  maxTileId,
  rawSession,
  SESSION_VERSION,
  saveSession,
  saveSessionNow,
  type Session,
  type SessionInput,
} from "./session.js";
import {
  ArchiveError,
  buildArchive,
  download,
  downloadRaw,
  extract,
  parseArchive,
  readFile,
  type ArchiveKind,
} from "./archive.js";
import { trajectoryCells, countEmpty, maxInCorner, monotonicity } from "./metrics.js";
import {
  BACKENDS,
  DEFAULT_RETRY,
  JevError,
  callJev,
  estimateCost,
  type ClientConfig,
  type RetryPolicy,
} from "./api.js";
import { isStaticHosting } from "./api.js";
import { resolveDecision } from "./decision.js";
import { BoardRenderer } from "./render.js";
import { ConfidenceChart } from "./chart.js";
import {
  DEFAULT_API,
  DEFAULT_CONTEXT,
  DEFAULT_CONTEXT_EN,
  DEFAULT_GAME,
  MAX_MEMORY,
  MAX_RETRY,
  clamp01,
  clampBoardSize,
  clampDist,
  clampInitial,
  clampPace,
  bestTileFor,
  highScoreFor,
  load,
  recordScore,
  recordTile,
  save,
  type Persisted,
} from "./config.js";
import {
  applyDom,
  getLang,
  onLangChange,
  setLang,
  t,
  type Lang,
} from "./i18n.js";

/* ═══════════ 常量 ═══════════ */

const ARROW: Record<Direction, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/**
 * 方向的中文名 —— **只服务于喂给 Jev 的 `criteria`，刻意不随界面语言变化**。
 *
 * 提示词属于实验变量：随界面语言改写会让跨语言的对局不可比，
 * 也违背本项目「测量 Jev」的定位。界面要显示方向名请用 {@link dirLabel}。
 */
const NAME: Record<Direction, string> = { up: "上", down: "下", left: "左", right: "右" };

/** 界面显示用的方向名，随语言切换 */
function dirLabel(d: Direction): string {
  return t(`dir.${d}`);
}

/** 模型上下文窗口（typesafe-ai/jev 元数据里的 context_window） */
const CONTEXT_WINDOW = 32000;
/** 估算用的每 token 字符数（JSON + 中文混合，保守取值） */
const CHARS_PER_TOKEN = 2.6;
/** 留给规则/策略/棋盘等固定内容的安全余量 */
const MEMORY_TOKEN_BUDGET = Math.floor(CONTEXT_WINDOW * 0.55);

/**
 * 取 DOM 元素。
 *
 * 拿不到时返回 null（类型上被断言掉了），后续访问会抛
 * 「Cannot read properties of null」。这种错误若发生在**模块求值阶段**，
 * 会静默中断整个启动流程 —— 表现为「棋盘空白、点一下直接判负」，
 * 与真正的原因（一个多出来的字符串）毫无关联，排查成本极高。
 *
 * 两道防线：
 *   1. boot() 里用 assertDom() 一次性核对全部 id
 *   2. 构建前由 tools/check-dom.ts 静态比对，从源头拦住
 */
/** 日志面板一次最多渲染多少条 —— 几百条 <details> 全渲染会明显卡顿 */
const LOG_PAGE_SIZE = 120;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** 启动自检：把所有缺失的 id 一次性报出来，而不是让第一个 null 静默炸掉 */
function assertDom(ids: string[]): void {
  const missing = ids.filter((id) => !document.getElementById(id));
  if (missing.length) {
    throw new Error(
      `${t("boot.missingDom", { n: missing.length, list: missing.map((m) => "#" + m).join(", ") })}\n` +
        t("boot.missingDomHint"),
    );
  }
}

/* ═══════════ 持久化 + 渲染器 ═══════════ */

const store: Persisted = load();

const canvas = $<HTMLCanvasElement>("board");
const renderer = new BoardRenderer(canvas);
const chartCanvas = $<HTMLCanvasElement>("chart");
const chart = new ConfidenceChart(chartCanvas);

/* ═══════════ 状态 ═══════════ */

interface AppState {
  tiles: Tile[];
  score: number;
  turn: number;
  running: boolean;
  busy: boolean;
  costTotal: number;
  cfg: ClientConfig;
  /** 当前棋盘尺寸下的历史最高分 */
  best: number;
  /** 当前棋盘尺寸下达成过的最大方块值 */
  bestTile: number;
  /** 每回合的历史（含完整请求/响应，供日志面板） */
  history: TurnLog[];
  /** 记忆用的「局面 + 操作」序列 */
  memory: MemoryEntry[];
}

const state: AppState = {
  tiles: [],
  score: 0,
  turn: 0,
  running: false,
  busy: false,
  costTotal: 0,
  cfg: { provider: "localproxy", base: "/api/evaluate", model: "typesafe-ai/jev", apiKey: "" },
  best: 0,
  bestTile: 0,
  history: [],
  memory: [],
};

const ledEl = $("led");
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 最近一次的状态栏内容。
 *
 * 存 **key 而不是已翻译的文本** —— 切换语言时要能按新语言重画，
 * 而状态栏是「一次性写上去」的，没有别的途径能恢复它。
 * 每次 setLed 都会覆盖它，所以重放的一定是当前状态，不会显示过期信息。
 */
let lastLed: {
  cls: "" | "on" | "busy" | "err";
  key: string;
  params?: Record<string, string | number>;
} | null = null;

function setLed(
  cls: "" | "on" | "busy" | "err",
  key: string,
  params?: Record<string, string | number>,
): void {
  lastLed = { cls, key, params };
  ledEl.className = "led" + (cls ? " " + cls : "");
  $("status").textContent = t(key, params);
}

function retryPolicy(): RetryPolicy {
  return { max: store.api.retryMax, baseMs: store.api.retryBaseMs };
}

/**
 * 累计费用与均次费用。
 *
 * 两处数据同源（`costTotal` 与已成功调用次数），放在一起更新，
 * 免得某一处漏改导致两个数字对不上。失败的调用不产生费用，也不计入分母。
 */
function updateCostUi(): void {
  $("cost").textContent = `$${state.costTotal.toFixed(4)}`;
  const ok = state.history.filter((h) => !h.failed).length;
    // 单次调用常常只有十万分之几美元，4 位小数会一律显示成 $0.0000
  $("avgCost").textContent = ok > 0 ? `$${(state.costTotal / ok).toFixed(8)}` : "—";
}

function updateStats(): void {
  $("sScore").textContent = String(state.score);
  $("sBest").textContent = String(state.best);
  $("sTurn").textContent = String(state.turn);
  $("sMax").textContent = String(maxTile(state.tiles) || 0);
  $("sBestMax").textContent = String(state.bestTile);
}

/**
 * 记分与最大方块。分数是「一局内累积」，最大方块是「历史达成过的最高值」，
 * 两者都按棋盘尺寸分开存 —— 8×8 的纪录和 4×4 没有可比性。
 */
function recordProgress(): void {
  const cur = maxTile(state.tiles) || 0;
  let changed = false;

  if (state.score > state.best) {
    state.best = state.score;
    recordScore(store, COLS, ROWS, state.score);
    changed = true;
  }
  if (cur > state.bestTile) {
    state.bestTile = cur;
    recordTile(store, COLS, ROWS, cur);
    changed = true;
  }
  if (changed) updateStats();
}

/* ═══════════ 画布自适应 ═══════════ */

function fitBoard(): void {
  const box = canvas.parentElement;
  if (!box) return;
  // 矩形棋盘：宽高都要给，由渲染器取「两个约束中较小的格子尺寸」
  renderer.resize(box.clientWidth, box.clientHeight);
}

/**
 * 图表高度取侧栏高度的固定比例，并夹在合理区间内。
 * 关键：图表是 flex-shrink:0，绝不参与挤压「Jev 决策」面板。
 */
function fitChart(): void {
  const box = chartCanvas.parentElement;
  const side = box?.parentElement;
  if (!box || !side) return;

  const avail = side.clientHeight;
  const h = Math.round(Math.min(132, Math.max(58, avail * 0.21)));
  box.style.height = `${h + 24}px`;   // 24 = 标题行 + 内边距
  chart.resize(box.clientWidth - 16, h);
}

new ResizeObserver(() => { fitBoard(); fitChart(); }).observe(document.body);
window.addEventListener("orientationchange", () =>
  setTimeout(() => { fitBoard(); fitChart(); }, 140),
);

/* ═══════════ 触摸滑动（移动端手动走棋）══════════ */

/**
 * 在棋盘上滑动即走一手。
 *
 * 判定阈值取棋盘边长的 8%（下限 24px）：既不会被手指抖动误触发，
 * 也不至于要滑很长距离。方向取 |dx| 与 |dy| 中较大者。
 */
function bindSwipe(el: HTMLElement): void {
  let x0 = 0;
  let y0 = 0;
  let active = false;

  el.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      active = true;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    },
    { passive: true },
  );

  el.addEventListener(
    "touchend",
    (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      if (!t) return;

      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      const threshold = Math.max(24, el.clientWidth * 0.08);
      if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

      manualMove(
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up",
      );
    },
    { passive: true },
  );

  // 在棋盘上滑动时不要连带滚动页面
  el.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (active) e.preventDefault();
    },
    { passive: false },
  );
}

/* ═══════════ 记忆组装 ═══════════ */

/** 粗略 token 估算：JSON 化后的字符数 / CHARS_PER_TOKEN */
function estimateTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v).length / CHARS_PER_TOKEN);
}

/**
 * 按配置取记忆切片。
 *  - memory = 0        → 不加入（原版行为）
 *  - memory = n        → 最近 n 轮
 *  - memory = null     → 最大：从最近往回塞，直到触到 token 预算
 */
function buildMemory(cfg: number | null): MemoryEntry[] | undefined {
  const all = state.memory;
  if (all.length === 0) return undefined;
  if (cfg === 0) return undefined;

  if (cfg !== null) {
    const n = Math.max(0, Math.min(all.length, Math.floor(cfg)));
    return n === 0 ? undefined : all.slice(-n);
  }

  // 最大：从最近往回累积，超出预算就停
  const picked: MemoryEntry[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const cost = estimateTokens(all[i]);
    if (used + cost > MEMORY_TOKEN_BUDGET) break;
    picked.unshift(all[i]);
    used += cost;
  }
  return picked.length ? picked : undefined;
}

/* ═══════════ 请求组装 ═══════════ */

function buildState(tiles: Tile[]): Record<string, unknown> {
  const grid = toGrid(tiles);
  const mem = buildMemory(store.game.memory);

  const base: Record<string, unknown> = {
    board: grid,
    board_legend: `0=空，其余为方块数值；棋盘为 ${COLS}×${ROWS}`,
    score: state.score,
    turn: state.turn,
    valid_moves: validMoves(tiles),
    features: {
      empty_cells: countEmpty(grid),
      monotonicity: Number(monotonicity(grid).toFixed(2)),
      max_tile_in_corner: maxInCorner(grid),
    },
  };

  if (mem) {
    base.memory_note =
      "recent_history 是最近若干轮的记录，按时间从早到晚排列。用它判断哪些方向此前导致过困境。";
    base.recent_history = mem.map((m) => ({
      turn: m.turn,
      board: m.board,
      move_taken: m.move,
      score_after: m.score,
    }));
  }

  base.rule_description = $<HTMLTextAreaElement>("ruleDesc").value.trim();
  base.strategy_hint = $<HTMLTextAreaElement>("hintText").value.trim();
  return base;
}

function buildQuestions(tiles: Tile[], detailed: boolean): Questions {
  const moves = validMoves(tiles);
  const criteria: Record<string, string> = {};

  for (const dir of moves) {
    if (detailed) {
      const r = moveTiles(cloneTiles(tiles), dir);
      const after = toGrid(r.tiles);
      criteria[dir] =
        `向${NAME[dir]}滑动。合并得分：${r.score}。` +
        `剩余空格：${countEmpty(after)}。` +
        `最大方块${maxInCorner(after) ? "在角落" : "不在角落"}。`;
    } else {
      criteria[dir] = `向${NAME[dir]}滑动。`;
    }
  }

  return {
    best_move: {
      type: "choice",
      instructions: "哪个移动方向最有利于长期得分、保持棋盘可玩？",
      criteria,
    },
  };
}

/* ═══════════ 决策面板 ═══════════ */

/**
 * 决策面板最后一次渲染的参数。
 *
 * 面板是**一次性画好**的（直接写 innerHTML），没有别的途径能恢复内容；
 * 切换语言时必须按新语言重画，所以参数得留下来重放。
 * 存的是**词条 key 而不是译文** —— 存译文的话重放出来还是旧语言。
 */
let lastDecision:
  | {
      answer: ChoiceAnswer | null;
      move: Direction;
      latency: number;
      tokens: number;
      noteKey: string;
      coerced: boolean;
      noteParams?: Record<string, string | number>;
    }
  | null = null;

function renderDecision(
  answer: ChoiceAnswer | null,
  move: Direction,
  latency: number,
  tokens: number,
  noteKey: string,
  coerced: boolean,
  noteParams?: Record<string, string | number>,
): void {
  lastDecision = { answer, move, latency, tokens, noteKey, coerced, noteParams };

  const host = $("decision");
  $("dTurn").textContent = state.turn ? `#${state.turn}` : "";
  const note = t(noteKey, noteParams);

  if (!answer) {
    host.innerHTML = `<div class="idle">${note}</div>`;
    return;
  }

  const entries = (Object.entries(answer.probabilities) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1]);

  const bars = entries
    .map(
      ([d, p]) => `<div class="bar ${d === move ? "win" : ""}">
        <span class="d">${ARROW[d as Direction] ?? d}</span>
        <span class="t"><span class="f" style="width:${(p * 100).toFixed(1)}%"></span></span>
        <span class="n">${p.toFixed(3)}</span>
      </div>`,
    )
    .join("");

  host.innerHTML = `<div class="bars">${bars}</div>
    <div class="meta">
      <span>${t("decision.confidence")} <b>${(answer.confidence ?? 0).toFixed(3)}</b></span>
      <span>${latency.toFixed(0)}ms</span>
      <span>${tokens} tok</span>
    </div>
    ${coerced ? `<div class="note-warn">${note}</div>` : ""}`;
}

/**
 * 决策面板的「空闲」文案（尚未开始 / 已恢复上一局）。
 *
 * 同样走 renderDecision 的那份缓存 —— 否则切换语言时这块会留在旧语言里。
 * `answer` 为 null 时 `move` 不参与渲染，传什么值都无所谓。
 */
function renderDecisionIdle(key: string, params?: Record<string, string | number>): void {
  renderDecision(null, "up", 0, 0, key, false, params);
}

/* ═══════════ 覆盖层 ═══════════ */

interface OvBtn { label: string; fn: () => void; primary?: boolean }

function showOverlay(title: string, msg: string, isErr: boolean, buttons: OvBtn[]): void {
  let ov = document.getElementById("overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "overlay";
    ov.className = "overlay";
    canvas.parentElement!.appendChild(ov);
  }
  const safe = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  ov.innerHTML = `<h2>${title}</h2><p class="${isErr ? "err" : ""}">${safe}</p>`;
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center";
  for (const b of buttons) {
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.primary) el.className = "primary";
    el.onclick = b.fn;
    bar.appendChild(el);
  }
  ov.appendChild(bar);
  ov.classList.add("show");
}

const hideOverlay = (): void => {
  document.getElementById("overlay")?.classList.remove("show");
};

/* ═══════════ 决策循环 ═══════════ */

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function doTurn(): Promise<void> {
  if (state.busy) return;
  if (isGameOver(state.tiles)) { gameOver(); return; }

  state.busy = true;
  const turnStart = performance.now();
  const at = new Date().toISOString();
  setLed("busy", "status.calling");

  const g = store.game;
  const legal = validMoves(state.tiles);
  const requestBody = {
    model: state.cfg.model,
    state: buildState(state.tiles),
    questions: buildQuestions(state.tiles, store.context.consequences),
  };

  let answer: ChoiceAnswer | null = null;
  let latency = 0;
  // 延迟只测「发出请求 → 收到响应」这一段。turnStart 还包含请求体构建与两手
  // 之间的 pace 等待，拿它当延迟会把等待时长也算进去，数字就没有意义了。
  let callStart = turnStart;
  let tokens = 0;
  let move: Direction | null = null;
  let noteKey = "";
  let noteParams: Record<string, string | number> | undefined;
  let coerced = false;
  let belowThreshold: boolean | undefined;
  let response: unknown = null;
  let error: string | undefined;

  try {
    callStart = performance.now();
    const res = await callJev(
      state.cfg,
      requestBody.state,
      requestBody.questions,
      retryPolicy(),
      {
        onRetry: (attempt, err, delay) => {
          setLed("busy", "status.retrying", { n: attempt, s: (delay / 1000).toFixed(1) });
          void err;
        },
      },
    );
    latency = performance.now() - callStart;
    tokens = res.inputTokens;
    response = res.raw;

    const raw = res.answers.best_move;
    if (!raw || raw.type !== "choice") throw new Error(t("err.noChoice"));
    answer = raw;

    const r = resolveDecision(answer, legal, g.strategy as Strategy, g.threshold);
    move = r.move;
    noteKey = r.reasonKey;
    noteParams = r.reasonParams;
    coerced = r.coerced;
    belowThreshold = r.belowThreshold;

    setLed("on", "status.online");
    $("fb").classList.remove("on");
  } catch (err) {
    error = (err as Error).message;
    console.error(err);
    state.busy = false;

    // 额度问题单独走专用提示 —— 它需要的是「换后端」而不是「重试」
    if (err instanceof JevError && err.quotaExhausted) {
      setLed("err", "status.quota");
      showQuotaModal(error);
      pushLog({
        turn: state.turn + 1, move: legal[0], top: 0, bottom: 0, median: 0, confidence: 0,
        latencyMs: Math.round(performance.now() - callStart), tokens: 0,
        reason: t("over.quotaBody", { msg: error }),
        coerced: false, belowThreshold: undefined, failed: true,
        request: requestBody, response: null, at,
      });
      return;
    }

    setLed("err", "status.apiFail");

    pushLog({
      turn: state.turn + 1, move: legal[0], top: 0, bottom: 0, median: 0, confidence: 0,
      latencyMs: Math.round(performance.now() - callStart), tokens: 0,
      reason: error, coerced: false, belowThreshold: undefined, failed: true,
      request: requestBody, response: null, at,
    });

    showOverlay(
      t("over.apiFail"),
      store.api.retryMax === null ? t("over.failBodyInf", { msg: error }) : t("over.failBody", { msg: error, n: store.api.retryMax }),
      true,
      [
        { label: t("over.retry"), fn: () => { hideOverlay(); void doTurn(); }, primary: true },
        { label: t("over.skip"), fn: () => { hideOverlay(); state.busy = false; if (state.running) void doTurn(); } },
      ],
    );
    return;
  }

  if (!move) { state.busy = false; setLed("err", "status.noMoves"); return; }

  // 记忆：记录「动手前的局面 + 这一手」
  // moveTiles 是纯函数，不会改动 state.tiles，所以这里直接留引用即可
  const beforeTiles = state.tiles;
  const beforeGrid = toGrid(beforeTiles);

  const res = moveTiles(beforeTiles, move);
  if (res.moved) {
    state.tiles = res.tiles;
    state.score += res.score;
  } else {
    const alt = legal.find((d) => moveTiles(state.tiles, d).moved);
    if (!alt) { state.busy = false; gameOver(); return; }
    const r2 = moveTiles(state.tiles, alt);
    state.tiles = r2.tiles;
    state.score += r2.score;
    res.dying = r2.dying;
    move = alt;
    coerced = true;
  }

  const nt = spawnTile(state.tiles, g.spawnMin, g.spawnMax, g.spawnDist);
  if (nt) state.tiles.push(nt);

  state.turn++;
  state.memory.push({ turn: state.turn, board: beforeGrid, move, score: state.score });
  renderer.sync(state.tiles, res.dying);

  // ★ 方向粒子动效：只在本手方块划过的轨迹上生成
  if (answer) renderer.burst(move, trajectoryCells(beforeTiles, state.tiles, res.dying));
  recordProgress();

  if (answer) {
    state.costTotal += estimateCost(tokens);
    updateCostUi();
    $("lat").textContent = `${latency.toFixed(0)}ms`;
    renderDecision(answer, move, latency, tokens, noteKey, coerced, noteParams);
  } else {
    renderDecision(null, move, 0, 0, noteKey, false, noteParams);
  }

  pushLog({
    turn: state.turn, move,
    top: answer ? Math.max(...Object.values(answer.probabilities)) : 0,
    bottom: answer ? Math.min(...Object.values(answer.probabilities)) : 0,
    median: answer ? median(Object.values(answer.probabilities)) : 0,
    confidence: answer?.confidence ?? 0,
    latencyMs: Math.round(latency), tokens,
    reason: t(noteKey, noteParams), coerced, belowThreshold, failed: false,
    request: requestBody, response, at,
  });

  state.busy = false;

  if (state.running) {
    const rest = store.game.paceMs - (performance.now() - turnStart);
    if (rest > 0) await wait(rest);
    if (state.running) void doTurn();
  } else {
    setLed("", "status.paused");
  }
}

function pushLog(row: TurnLog): void {
  state.history.push(row);
  if (state.history.length > 400) state.history.shift();
  chart.push(row);
  renderLog();
  persist();
}

function gameOver(): void {
  state.running = false;
  setLed("", "over.gameOver");
  syncRunButton();
  recordProgress();
  // 结束后立即落盘并标记 finished —— 刷新页面不该「续玩」一局已经结束的棋
  saveSessionNow({
    cols: COLS,
    rows: ROWS,
    tiles: state.tiles,
    score: state.score,
    turn: state.turn,
    memory: state.memory,
    history: state.history,
    finished: true,
  });
  showOverlay(
    t("over.gameOver"),
    `${t("over.stats", { score: state.score, max: maxTile(state.tiles) || 0, turn: state.turn })}\n` +
      t("over.best", { best: state.best, bt: state.bestTile }),
    false,
    [{ label: t("over.again"), fn: () => { hideOverlay(); newGame(); }, primary: true }],
  );
}

/* ═══════════ 控制 ═══════════ */

/** 把一份 Session 应用到界面上 */
function applySession(s: Session): void {
  state.tiles = s.tiles;
  state.score = s.score;
  state.turn = s.turn;
  state.memory = s.memory;
  state.history = s.history;

  // 关键：把引擎的 id 计数器顶到存档里的最大值之上，否则新方块会与旧方块 id 撞车
  ensureTileSeqAbove(maxTileId(state.tiles));

  state.best = highScoreFor(store, COLS, ROWS);
  state.bestTile = bestTileFor(store, COLS, ROWS);

  renderer.sync(state.tiles);
  updateStats();
  chart.setData(state.history);
  renderLog();

  state.costTotal = state.history.reduce((sum, r) => sum + estimateCost(r.tokens), 0);
  updateCostUi();
  const last = state.history[state.history.length - 1];
  $("lat").textContent = last ? `${last.latencyMs}ms` : "—";
  renderDecisionIdle("decision.restored", { n: state.turn });
  $("dTurn").textContent = state.turn ? `#${state.turn}` : "";
  syncRunButton();
}

/**
 * 尝试从 localStorage 还原上一局。
 *
 * 三种结果分别对待：
 *   ok            正常还原
 *   none          没有存档 → 开新局
 *   incompatible  磁盘上有数据但读不懂 → **不静默丢弃**，弹框让玩家
 *                 选择「导出旧数据」还是「重置回默认」
 *
 * @returns 是否成功还原
 */
function restoreSession(): boolean {
  const r = loadSession();

  if (r.status === "none") return false;

  if (r.status === "incompatible") {
    showIncompatibleModal(r.raw, r.reason);
    return false;
  }

  const s = r.session;
  // 尺寸对不上或该局已结束 —— 这类是「正常的作废」，不必打扰玩家
  if (s.cols !== COLS || s.rows !== ROWS || s.finished || s.tiles.length === 0) {
    clearSession();
    return false;
  }

  applySession(s);
  setLed("", "salvage.restoredShort", { n: s.turn });
  return true;
}

/** 把当前对局写进 localStorage。每手结束后调用（内部防抖）。 */
function persist(): void {
  saveSession({
    cols: COLS,
    rows: ROWS,
    tiles: state.tiles,
    score: state.score,
    turn: state.turn,
    memory: state.memory,
    history: state.history,
    finished: false,
  });
}

function newGame(): void {
  state.tiles = [];
  state.score = 0;
  state.turn = 0;
  state.running = false;
  state.busy = false;
  state.costTotal = 0;
  state.history = [];
  state.memory = [];

  renderer.clear();
  chart.clear();
  renderLog();

  const g = store.game;
  placeInitialTiles();

  // 硬护栏：无论如何都不能留一个空棋盘给玩家 —— 那会让第一步直接判负。
  // 真走到这里说明上面出了问题，宁可多放一个也不能为零。
  if (state.tiles.length === 0) {
    console.warn(t("dev.spawnFail"));
    state.tiles.push(
      makeTile(g.spawnMin, Math.floor(Math.random() * ROWS), Math.floor(Math.random() * COLS)),
    );
  }

  state.best = highScoreFor(store, COLS, ROWS);
  state.bestTile = bestTileFor(store, COLS, ROWS);
  renderer.sync(state.tiles);
  updateStats();
  saveSessionNow({
    cols: COLS,
    rows: ROWS,
    tiles: state.tiles,
    score: 0,
    turn: 0,
    memory: [],
    history: [],
    finished: false,
  });

  updateCostUi();
  $("lat").textContent = "—";
  renderDecisionIdle("decision.idle");
  $("dTurn").textContent = "";
  $("fb").classList.remove("on");
  syncRunButton();
  setLed("", "status.ready");
  fitBoard();
  fitChart();
}

/**
 * 开局摆放方块。
 *
 * 个数从配置区间里随机取，下限由 clampInitial 强制为 1 ——
 * 空棋盘上四个方向都动不了，第一步就会判负。
 */
function placeInitialTiles(): void {
  const g = store.game;
  const lo = clampInitial(g.initialMin, 1);
  const hi = Math.max(lo, clampInitial(g.initialMax, lo));
  const count = lo + Math.floor(Math.random() * (hi - lo + 1));
  const cap = COLS * ROWS;               // 不可能超过格子总数

  for (let i = 0; i < Math.min(count, cap); i++) {
    // 变量名刻意不叫 t —— 那会遮蔽从 i18n 导入的 t()
    const tile = spawnTile(state.tiles, g.spawnMin, g.spawnMax, g.spawnDist);
    if (!tile) break;                   // 盘面已满
    state.tiles.push(tile);
  }
}

/**
 * 按钮状态的**唯一来源**。
 *
 * 之前「接管」和「暂停」是两个各自改 disabled 的按钮，任何一条路径漏改就会
 * 两边同时不可用。现在收敛成一个按钮 + 一个同步函数：只要改动 state.running，
 * 调一次 syncRunButton() 即可，不可能出现状态错位。
 */
function syncRunButton(): void {
  const b = $<HTMLButtonElement>("bToggle");
  if (state.running) {
    b.textContent = t("ctrl.pause");
    b.classList.remove("primary");
    b.classList.add("running");
    b.title = t("ctrl.takeoverTitle");
  } else {
    b.textContent = t("ctrl.takeover");
    b.classList.remove("running");
    b.classList.add("primary");
    b.title = t("ctrl.takeoverTitle");
  }
  b.disabled = false;
}

function start(): void {
  if (state.running) return;
  state.running = true;
  syncRunButton();
  hideOverlay();
  void doTurn();
}

function pause(): void {
  state.running = false;
  syncRunButton();
  setLed("", "status.paused");
}

/** 单个按钮在「接管 / 暂停」之间切换 */
function toggleRun(): void {
  state.running ? pause() : start();
}

function manualMove(dir: Direction): void {
  if (state.running || state.busy) return;
  const beforeGrid = toGrid(state.tiles);
  const r = moveTiles(state.tiles, dir);
  if (!r.moved) return;
  state.tiles = r.tiles;
  state.score += r.score;
  const g = store.game;
  const nt = spawnTile(state.tiles, g.spawnMin, g.spawnMax, g.spawnDist);
  if (nt) state.tiles.push(nt);
  state.turn++;
  state.memory.push({ turn: state.turn, board: beforeGrid, move: dir, score: state.score });
  renderer.sync(state.tiles, r.dying);
  recordProgress();
  if (isGameOver(state.tiles)) gameOver();
}

/* ═══════════ 日志面板 ═══════════ */

function fmtJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * 日志条目的稳定标识。
 *
 * 不能只用 turn —— 调用失败后重试会产生同一 turn 的第二条记录。
 * 用 turn + 时间戳组合，保证每条记录在整个会话内唯一。
 */
function logKey(r: TurnLog): string {
  return `${r.turn}@${r.at}`;
}

/**
 * 重绘日志列表。
 *
 * 这里做了两件「防止画面抖动」的事，缺一不可：
 *
 *   1. **保留展开状态**。新条目到来时如果整表重建，用户正在看的那个
 *      展开项会「啪」地合上。所以先收集哪些 key 是展开的，
 *      再把 open 属性直接写进生成的 HTML —— 而不是渲染完再补设，
 *      后者会先画一帧关闭态再展开，眼睛能看到闪一下。
 *   2. **保留滚动位置**。`innerHTML = ...` 会把 scrollTop 归零，
 *      用户往下翻看历史时突然被拽回顶部。
 */
function renderLog(): void {
  const host = $("logList");
  const tag = $("logCount");
  const n = state.history.length;
  tag.textContent = n ? t("log.turnCount", { n }) : "";

  // 记下当前的展开项与滚动位置
  const openKeys = new Set<string>();
  for (const d of host.querySelectorAll<HTMLDetailsElement>("details[data-key]")) {
    if (d.open) openKeys.add(d.dataset.key ?? "");
  }
  const scrollTop = host.scrollTop;

  if (n === 0) {
    host.innerHTML = `<div class="idle">${t("log.empty")}</div>`;
    return;
  }

  const paged = state.history.slice(-LOG_PAGE_SIZE);

  // 最新的在最上面
  host.innerHTML = paged
    .slice()
    .reverse()
    .map((r) => {
      const key = logKey(r);
      const tm = r.at.slice(11, 19);
      const cls = r.failed ? "lg err" : r.coerced ? "lg warn" : "lg";
      const head = r.failed
        ? `<span class="lgmove err">${t("log.failed")}</span>`
        : `<span class="lgmove">${ARROW[r.move]}</span>`;
      const probs = r.failed
        ? ""
        : `<span class="lgprobs">${r.top.toFixed(2)} / ${r.median.toFixed(2)} / ${r.bottom.toFixed(2)}</span>`;
      // open 写进 HTML 本身，避免「先关闭后展开」的一帧闪烁
      const openAttr = openKeys.has(key) ? " open" : "";
      return `<details class="${cls}" data-key="${escapeHtml(key)}"${openAttr}>
        <summary>
          <span class="lgturn">#${r.turn}</span>
          ${head}
          ${probs}
          <span class="lgmeta">${r.latencyMs}ms · ${r.tokens}tok · ${tm}</span>
        </summary>
        <div class="lgbody">
          <div class="lgrow"><span>${t("log.reason")}</span><code>${escapeHtml(r.reason)}</code></div>
          <div class="lgbtns">
            <button data-copy="req" data-k="${escapeHtml(key)}">${t("log.copyReq")}</button>
            <button data-copy="res" data-k="${escapeHtml(key)}">${t("log.copyRes")}</button>
            <button data-copy="both" data-k="${escapeHtml(key)}">${t("log.copyBoth")}</button>
          </div>
          <div class="lglabel">${t("log.reqLabel")}</div>
          <pre>${escapeHtml(fmtJson(r.request))}</pre>
          <div class="lglabel">${t("log.resLabel")}</div>
          t("log.noResponse")
        </div>
      </details>`;
    })
    .join("");

  if (paged.length < n) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="lghint">${t("log.pagedNote", { n: LOG_PAGE_SIZE })}</div>`,
    );
  }

  // 还原滚动位置
  host.scrollTop = scrollTop;

  host.querySelectorAll<HTMLButtonElement>("button[data-copy]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const want = btn.dataset.k;
      const row = state.history.find((r) => logKey(r) === want);
      if (!row) return;
      const kind = btn.dataset.copy;
      const parts: string[] = [];
      if (kind === "req" || kind === "both") parts.push(fmtJson(row.request));
      if (kind === "res" || kind === "both") parts.push(fmtJson(row.response ?? { error: row.reason }));
      void copyText(parts.join("\n\n"), btn);
    };
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t("toast.copied");
  } catch {
    // 非安全上下文（file:// 或 http 内网）没有 clipboard API，退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    btn.textContent = ok ? t("toast.copied") : t("toast.copyFail");
  }
  setTimeout(() => { btn.textContent = old; }, 1200);
}

/* ═══════════ 抽屉 ═══════════ */

const scrim = $("scrim");
/**
 * 顶栏顺序 = 用户的自然动线：
 *   先玩（游戏）→ 调整（策略）→ 接通模型（API）→ 回看发生了什么（日志）→ 把一切存下来（存档）
 *
 * 存档放最右是因为它是**收尾动作** —— 前面几步都做完之后才会想到它。
 */
const DRAWERS = ["dGame", "dStrategy", "dApi", "dLog", "dArchive"];

function openDrawer(id: string): void {
  for (const d of DRAWERS) $(d).classList.toggle("show", d === id);
  scrim.classList.add("show");
}

function closeDrawers(): void {
  for (const d of DRAWERS) $(d).classList.remove("show");
  scrim.classList.remove("show");
}

/**
 * 给每个抽屉右上角注入一个关闭按钮。
 *
 * 宽屏下抽屉是侧栏，点旁边露出的遮罩即可退出；**窄屏下抽屉占满全宽**，
 * 遮罩被完全盖住、点不到，用户只能翻到抽屉底部去找「完成」——
 * 这不是一个能被发现的退出方式。
 *
 * title 走 `data-i18n-title`，由 applyDom 负责跟随语言。
 */
function addDrawerCloseButtons(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".drawer")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "drawer-close";
    btn.textContent = "✕";
    btn.dataset.i18nTitle = "ui.close";
    btn.setAttribute("aria-label", "close");
    btn.addEventListener("click", () => closeDrawers());
    el.appendChild(btn);
  }
}

/* ═══════════ 游戏设置 ═══════════ */

function syncGameUi(): void {
  const g = store.game;
  $<HTMLInputElement>("inpWidth").value = String(g.boardWidth);
  $<HTMLInputElement>("inpHeight").value = String(g.boardHeight);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-size]")) {
    b.classList.toggle("on", Number(b.dataset.w) === g.boardWidth && Number(b.dataset.h) === g.boardHeight);
  }
  $<HTMLInputElement>("inpSpawnMin").value = String(spawnExpOf(g.spawnMin));
  $<HTMLInputElement>("inpSpawnMax").value = String(spawnExpOf(g.spawnMax));
  updateSpawnPreview();
  $<HTMLSelectElement>("inpDist").value = g.spawnDist;
  $<HTMLInputElement>("inpInitMin").value = String(g.initialMin);
  $<HTMLInputElement>("inpInitMax").value = String(g.initialMax);
  $<HTMLInputElement>("inpAnim").checked = g.animations;
  $<HTMLInputElement>("inpParticles").checked = g.particles;
  $<HTMLSelectElement>("inpStrategy").value = g.strategy;
  $<HTMLInputElement>("inpThreshold").value = String(Math.round(g.threshold * 100));
  $("thresholdVal").textContent = `${Math.round(g.threshold * 100)}%`;
  $<HTMLInputElement>("inpMemory").value = g.memory === null ? "max" : String(g.memory);
  $("memoryVal").textContent = g.memory === null ? t("strategy.max") : String(g.memory);
  $("thresholdRow").style.display = g.strategy === "threshold" ? "" : "none";
}

function applyGameSettings(): void {
  const g = store.game;
  // 界面填的是**指数**（0 → 1、1 → 2…），存储的仍是值本身
  const min = spawnValueOf(Number($<HTMLInputElement>("inpSpawnMin").value));
  const max = spawnValueOf(Number($<HTMLInputElement>("inpSpawnMax").value));

  g.spawnMin = min;
  g.spawnMax = Math.max(min, max);
  g.spawnDist = clampDist($<HTMLSelectElement>("inpDist").value);
  g.initialMin = clampInitial($<HTMLInputElement>("inpInitMin").value, DEFAULT_GAME.initialMin);
  g.initialMax = Math.max(g.initialMin, clampInitial($<HTMLInputElement>("inpInitMax").value, g.initialMin));
  g.animations = $<HTMLInputElement>("inpAnim").checked;
  g.particles = $<HTMLInputElement>("inpParticles").checked;
  // 步进间隔只由棋盘下方的滑块控制，不在这里重复设置
  g.strategy = $<HTMLSelectElement>("inpStrategy").value as Strategy;
  g.threshold = clamp01(Number($<HTMLInputElement>("inpThreshold").value) / 100);

  const memRaw = $<HTMLInputElement>("inpMemory").value;
  g.memory = memRaw === "max" ? null : Math.max(0, Math.min(MAX_MEMORY, Math.round(Number(memRaw) || 0)));

  save(store);
  renderer.animations = g.animations;
  renderer.particlesEnabled = g.particles;
  syncGameUi();
}

function validateSpawn(): boolean {
  const minE = Number($<HTMLInputElement>("inpSpawnMin").value);
  const maxE = Number($<HTMLInputElement>("inpSpawnMax").value);
  // 界面填的是**指数**：必须是非负整数，且不超过 MAX_SPAWN_EXP
  const ok = (e: number): boolean =>
    Number.isInteger(e) && e >= 0 && e <= MAX_SPAWN_EXP;
  const bad = !ok(minE) || !ok(maxE) || maxE < minE;
  $("spawnWarn").style.display = bad ? "block" : "none";
  updateSpawnPreview();
  return !bad;
}

/**
 * 新方块区间的「指数 → 值」预览，形如 `2^0 = 1 ~ 2^2 = 4`。
 *
 * 直接填值的话，玩家得自己算 2 的幂次、还得输入 1/2/4/8… 这种不成规律的串；
 * 填指数则天然保证合法，代价就是得把这行换算结果摆在眼前。
 */
function updateSpawnPreview(): void {
  // 算式本身（`2^`）写在 HTML 里，这里只补右侧的换算结果
  const eq = (raw: string): string => {
    const e = Number(raw);
    if (!Number.isInteger(e) || e < 0 || e > MAX_SPAWN_EXP) return "= —";
    return `= ${spawnValueOf(e)}`;
  };
  $("spawnMinVal").textContent = eq($<HTMLInputElement>("inpSpawnMin").value);
  $("spawnMaxVal").textContent = eq($<HTMLInputElement>("inpSpawnMax").value);
}

/** 初始方块个数：下限必须是 ≥1 的整数，且不得大于上限 */
function validateInitial(): boolean {
  const lo = Number($<HTMLInputElement>("inpInitMin").value);
  const hi = Number($<HTMLInputElement>("inpInitMax").value);
  const bad = !Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo;
  $("initWarn").style.display = bad ? "block" : "none";
  return !bad;
}

function setBoardSizeAndRestart(w: number, h: number): void {
  const cw = clampBoardSize(w);
  const ch = clampBoardSize(h);
  store.game.boardWidth = cw;
  store.game.boardHeight = ch;
  store.lastWidth = cw;
  store.lastHeight = ch;
  save(store);
  setBoardSize(cw, ch);
  syncGameUi();
  newGame();
}

function bindGameSettings(): void {
  // 宽高各自独立，两个输入框都要钳到 [MIN_BOARD, MAX_BOARD]
  const onDim = (): void => {
    setBoardSizeAndRestart(
      clampBoardSize($<HTMLInputElement>("inpWidth").value),
      clampBoardSize($<HTMLInputElement>("inpHeight").value),
    );
  };
  $("inpWidth").addEventListener("change", onDim);
  $("inpHeight").addEventListener("change", onDim);

  // 预设按钮：data-w / data-h
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-w]")) {
    b.onclick = () => setBoardSizeAndRestart(Number(b.dataset.w), Number(b.dataset.h));
  }

  const onSpawn = (): void => { if (validateSpawn()) applyGameSettings(); };
  $("inpSpawnMin").addEventListener("change", onSpawn);
  $("inpSpawnMax").addEventListener("change", onSpawn);
  // 输入过程中就更新预览，不必等 change
  $("inpSpawnMin").addEventListener("input", updateSpawnPreview);
  $("inpSpawnMax").addEventListener("input", updateSpawnPreview);

  // 步进间隔不在这里 —— 它只由棋盘下方的滑块控制（见 syncPaceUi）
  for (const id of ["inpAnim", "inpParticles", "inpStrategy", "inpDist"]) {
    $(id).addEventListener("change", applyGameSettings);
  }

  const onInitial = (): void => { if (validateInitial()) applyGameSettings(); };
  $("inpInitMin").addEventListener("change", onInitial);
  $("inpInitMax").addEventListener("change", onInitial);

  // 阈值：滑块即时反馈
  const th = $<HTMLInputElement>("inpThreshold");
  th.addEventListener("input", () => {
    $("thresholdVal").textContent = `${th.value}%`;
  });
  th.addEventListener("change", applyGameSettings);

  // 记忆：滑块 + 「最大」按钮
  const mem = $<HTMLInputElement>("inpMemory");
  mem.addEventListener("input", () => {
    $("memoryVal").textContent = mem.value === "max" ? t("strategy.max") : mem.value;
  });
  mem.addEventListener("change", applyGameSettings);
  $("bMemMax").onclick = () => { mem.value = "max"; applyGameSettings(); };
}

/* ═══════════ 上下文设置 ═══════════ */

function bindContextSettings(): void {
  const c = store.context;
  $<HTMLTextAreaElement>("ruleDesc").value = c.ruleDesc;
  $<HTMLTextAreaElement>("hintText").value = c.strategyHint;
  $<HTMLInputElement>("inpCons").checked = c.consequences;

  const apply = (): void => {
    c.ruleDesc = $<HTMLTextAreaElement>("ruleDesc").value;
    c.strategyHint = $<HTMLTextAreaElement>("hintText").value;
    c.consequences = $<HTMLInputElement>("inpCons").checked;
    save(store);
  };
  for (const id of ["ruleDesc", "hintText", "inpCons"]) {
    $(id).addEventListener("change", apply);
    $(id).addEventListener("input", apply);
  }
}

/* ═══════════ 存档：导入导出 ═══════════ */

/** 当前对局的快照（不含 savedAt），供导出使用 */
function sessionSnapshot(): SessionInput | null {
  if (state.turn === 0 && state.history.length === 0) return null;
  return {
    cols: COLS,
    rows: ROWS,
    tiles: state.tiles,
    score: state.score,
    turn: state.turn,
    memory: state.memory,
    history: state.history,
    finished: false,
  };
}

function doExport(kind: ArchiveKind, label: string): void {
  download(buildArchive(kind, store, sessionSnapshot(), state.history), label);
  toast(t("toast.exported", { label }));
}

/** 顶部短暂提示。导出/导入这类操作需要即时反馈，但不值得弹框。 */
let toastTimer = 0;
function toast(msg: string, isErr = false): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2200);
}

/** 触发文件选择，选完交给 handler */
let pendingImport: ((text: string) => void) | null = null;

function pickFile(handler: (text: string) => void): void {
  pendingImport = handler;
  $<HTMLInputElement>("fileInput").click();
}

function onFileChosen(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";                       // 允许连续选同一个文件
  if (!file || !pendingImport) return;
  const handler = pendingImport;
  pendingImport = null;

  readFile(file)
    .then(handler)
    .catch((err: unknown) => toast(t("toast.readFail", { msg: (err as Error).message }), true));
}

/**
 * 应用导入的档案。
 *
 * 各类档案的作用范围严格按「它自己声称的类型」来 —— 策略档不会顺带改掉棋盘设置，
 * API 档也不会碰密钥。
 */
function applyImported(text: string, expect: ArchiveKind): void {
  try {
    const archive = parseArchive(text);
    const r = extract(archive);

    // 类型不匹配时给出明确提示，但仍允许 all 档写入任何一类
    if (archive.kind !== expect && archive.kind !== "all") {
      throw new ArchiveError(
        t("toast.kindMismatch", { from: t(`kind.${archive.kind}`), to: expect }),
      );
    }

    const touched: string[] = [];

    if (r.game) {
      // 策略档里的 game 只含 strategy/threshold/memory，按字段逐个合并
      if (expect === "game") Object.assign(store.game, r.game);
      else {
        if (r.game.strategy !== undefined) store.game.strategy = r.game.strategy;
        if (r.game.threshold !== undefined) store.game.threshold = r.game.threshold;
        if (r.game.memory !== undefined) store.game.memory = r.game.memory;
      }
      touched.push(t("field.gameSettings"));
    }
    if (r.context) {
      Object.assign(store.context, r.context);
      $<HTMLTextAreaElement>("ruleDesc").value = store.context.ruleDesc;
      $<HTMLTextAreaElement>("hintText").value = store.context.strategyHint;
      $<HTMLInputElement>("inpCons").checked = store.context.consequences;
      touched.push(t("field.context"));
    }
    if (r.api) {
      Object.assign(store.api, r.api);
      touched.push(t("field.apiSettings"));
    }
    if (r.highScores) {
      store.highScores = { ...store.highScores, ...r.highScores };
      touched.push(t("field.highScores"));
    }
    if (r.bestTiles) {
      store.bestTiles = { ...store.bestTiles, ...r.bestTiles };
      touched.push(t("field.bestTiles"));
    }

    save(store);
    renderer.animations = store.game.animations;
    renderer.particlesEnabled = store.game.particles;

    // 棋盘尺寸可能变了
    if (store.game.boardWidth !== COLS || store.game.boardHeight !== ROWS) {
      setBoardSize(store.game.boardWidth, store.game.boardHeight);
      store.lastWidth = store.game.boardWidth;
      store.lastHeight = store.game.boardHeight;
      save(store);
    }
    syncGameUi();
    syncApiUi();
    syncPaceUi();

    // 对局单独处理：有就覆盖当前局
    if (expect === "game" && r.session && Array.isArray(r.session.tiles) && r.session.tiles.length) {
      const sess = r.session;
      if (sess.cols !== COLS || sess.rows !== ROWS) {
        setBoardSize(sess.cols, sess.rows);
        store.lastWidth = sess.cols;
      store.lastHeight = sess.rows;
      store.game.boardWidth = sess.cols;
      store.game.boardHeight = sess.rows;
        save(store);
        syncGameUi();
      }
      applySession({
        v: SESSION_VERSION,
        cols: COLS,
    rows: ROWS,
        tiles: sess.tiles,
        score: Number(sess.score) || 0,
        turn: Number(sess.turn) || 0,
        memory: Array.isArray(sess.memory) ? sess.memory : [],
        history: Array.isArray(sess.history) ? sess.history : [],
        finished: false,
        savedAt: "",
      });
      persist();
      touched.push(t("field.gameAtTurn", { n: state.turn }));
    }

    closeDrawers();
    toast(touched.length ? t("toast.imported", { list: touched.join(", ") }) : t("toast.importEmpty"));
  } catch (err) {
    toast(t("toast.importFail", { msg: (err as Error).message }), true);
  }
}

/* ═══════════ 额度不足提示 ═══════════ */

/**
 * 额度用尽不该跟「网络抖动」共用同一个错误框。
 *
 * 两者的**用户可采取的行动完全不同**：网络问题该重试，额度问题该换后端。
 * 用一个通用错误框会让用户反复点重试，而重试永远不会成功。
 */
function showQuotaModal(detail: string): void {
  $("quotaDetail").textContent = detail;
  $("quotaModal").classList.add("show");
  setLed("err", "status.quota");
}

function bindQuotaModal(): void {
  $("bQuotaSwitch").onclick = () => {
    $("quotaModal").classList.remove("show");
    openDrawer("dApi");
  };
  $("bQuotaClose").onclick = () => {
    $("quotaModal").classList.remove("show");
    setLed("", "status.paused");
  };
}

/* ═══════════ 不兼容存档提示 ═══════════ */

/**
 * 磁盘上有数据但读不懂时的兜底。
 *
 * 刻意**不自动清理** —— 那等于替玩家做决定，而丢掉的可能是几十手的对局。
 * 先让玩家把原始数据导出留存，再决定是否重置。
 */
function showIncompatibleModal(raw: string, reason: string): void {
  const modal = $("incompatModal");
  $("incompatReason").textContent = reason;
  $("incompatSize").textContent = `${(raw.length / 1024).toFixed(1)} KB`;
  $("incompatPreview").textContent = raw.slice(0, 400) + (raw.length > 400 ? "\n…" : "");
  modal.classList.add("show");
  setLed("err", "incompat.title");
}

function bindIncompatibleModal(): void {
  $("bIncompatExport").onclick = () => {
    const raw = rawSession();
    if (!raw) {
      toast(t("salvage.rawGone"), true);
      return;
    }
    downloadRaw(raw, "incompatible-session");
    toast(t("salvage.exported"));
  };

  /**
   * 强行加载：尽力抢救。
   *
   * 这是「责任在用户」的路径 —— 严格校验已经失败过一次，接下来能救回多少
   * 取决于数据本身。应用负责如实报告抢救了什么、丢了什么，不替用户判断值不值。
   */
  $("bIncompatForce").onclick = () => {
    const raw = rawSession();
    if (!raw) {
      toast(t("salvage.rawGone"), true);
      return;
    }

    const r = forceLoadSession(raw);
    if (!r) {
      toast(t("salvage.forceFail"), true);
      return;
    }

    // 尺寸先对齐，否则还原出来的棋盘与当前设置不符
    if (r.session.cols !== COLS || r.session.rows !== ROWS) {
      setBoardSize(r.session.cols, r.session.rows);
      store.lastWidth = r.session.cols;
      store.lastHeight = r.session.rows;
      save(store);
      syncGameUi();
    }

    applySession(r.session);
    commitForced({ ...r.session, cols: COLS, rows: ROWS });
    $("incompatModal").classList.remove("show");

    setLed("on", "salvage.forced", { n: r.session.turn });
    toast(
      r.salvaged.length
        ? t("salvage.forcedPartial", { list: r.salvaged.join("; ") })
        : t("salvage.forcedShort", { n: r.session.turn }),
    );
  };

  $("bIncompatReset").onclick = () => {
    if (!window.confirm(t("confirm.incompatReset"))) return;
    clearSession();
    $("incompatModal").classList.remove("show");
    newGame();
    setLed("", "confirm.resetDone");
    toast(t("confirm.resetDone"));
  };

  // 关掉弹框 = 先不动数据，开新局继续玩（存档原样留着）
  $("bIncompatLater").onclick = () => {
    $("incompatModal").classList.remove("show");
    setLed("", "confirm.kept");
  };
}

/* ═══════════ 恢复默认 ═══════════ */

/**
 * 三类「恢复默认」的边界各不相同：
 *
 *  - 游戏：只重置自然属性，**不动**历史最高分与当前对局
 *  - 策略：上下文 + 规则全部回到出厂值
 *  - API：只重置重试参数。密钥与后端 URL 是运行期输入，不在这里碰
 *
 * 日志的「清空」是破坏性操作，单独确认。
 */
function resetGameSettings(): void {
  const keepScores = store.highScores;
  const keepTiles = store.bestTiles;
  Object.assign(store.game, DEFAULT_GAME);
  store.highScores = keepScores;
  store.bestTiles = keepTiles;
  save(store);

  renderer.animations = store.game.animations;
  renderer.particlesEnabled = store.game.particles;
  syncGameUi();
  syncPaceUi();

  if (store.game.boardWidth !== COLS || store.game.boardHeight !== ROWS) {
    setBoardSize(store.game.boardWidth, store.game.boardHeight);
    store.lastWidth = store.game.boardWidth;
    store.lastHeight = store.game.boardHeight;
    newGame();
  }
}

function resetStrategySettings(): void {
  // 按**当前界面语言**取出厂默认值 —— 否则英文用户点「恢复默认」会拿回
  // 一份中文提示词，白填了这个语言开关
  const ctx = getLang() === "en" ? DEFAULT_CONTEXT_EN : DEFAULT_CONTEXT;
  Object.assign(store.game, {
    strategy: DEFAULT_GAME.strategy,
    threshold: DEFAULT_GAME.threshold,
    memory: DEFAULT_GAME.memory,
  });
  Object.assign(store.context, ctx);
  save(store);

  $<HTMLTextAreaElement>("ruleDesc").value = ctx.ruleDesc;
  $<HTMLTextAreaElement>("hintText").value = ctx.strategyHint;
  $<HTMLInputElement>("inpCons").checked = ctx.consequences;
  syncGameUi();
}

/**
 * 重置历史最高分。
 *
 * 与「恢复默认」分开是刻意的：那一个保留纪录（用户的成绩不该被设置操作抹掉），
 * 这一个专门抹纪录。两件事的意图完全不同，混在一个按钮里必然误伤。
 */
function resetScores(): void {
  store.highScores = {};
  store.bestTiles = {};
  save(store);
  state.best = 0;
  state.bestTile = 0;
  updateStats();
}

function resetApiSettings(): void {
  Object.assign(store.api, DEFAULT_API);
  save(store);
  syncApiUi();
}

function confirmAction(msg: string, fn: () => void): void {
  if (window.confirm(msg)) fn();
}

/* ═══════════ API 设置 ═══════════ */

const selBackend = $<HTMLSelectElement>("selBackend");
const inpKey = $<HTMLInputElement>("inpKey");

/**
 * 状态栏的后端标签 —— **单一来源**。
 *
 * 之前有三处各写各的（启动、保存设置、静态托管分支），
 * 于是「改了模型但状态栏没变」这类不一致迟早出现。
 */
function updateBackendLabel(): void {
  const b = BACKENDS[state.cfg.provider];
  const name = t(b.labelKey);
  const label = b.needsKey || !staticHost ? name : t("backend.remoteSuffix", { label: name });
  const el = $("backend");

  // 代管后端的模型是本站服务端的内部选择：用户既改不了，也不该看到 ——
  // 展示它只会让人以为那是个可调项，还会把上游选型泄露到 UI 上。
  // 这与 BackendConfig.managed 的语义一致（它也负责隐藏 Base URL 与 Model ID）。
  if (b.managed) {
    el.textContent = label;
    el.title = t("backend.currentTitleShort", { label });
    return;
  }
  el.textContent = `${label} · ${state.cfg.model}`;
  el.title = t("backend.currentTitle", { label, model: state.cfg.model });
}

/** 把某个后端的默认地址填进 Base URL（那是个真值，留空没意义） */
function fillBackendDefaults(id: BackendId): void {
  $<HTMLInputElement>("inpBase").value = BACKENDS[id].base;
}

/**
 * 填模型输入框。
 *
 * 两类后端分开对待：
 *
 *   **本站代管**（两个免费试用）—— 模型由服务端决定，输入框禁用，
 *     占位符只说「由本站指定」，**不暴露具体模型 ID**。
 *     这是本站的内部选择，写出来只会引导用户去研究一个他改不了的东西。
 *
 *   **用户自配** —— 用**占位符**承载默认值，而不是预填成值：
 *       输入框空着  → 用的是默认（占位符灰字显示的就是它）
 *       输入框有值  → 这是自定义的
 *     预填成值的话两者外观一样，用户没法知道当前跑的是默认还是改过的。
 */
function fillModelField(b: BackendConfig, current: string): void {
  const el = $<HTMLInputElement>("inpModel");
  if (b.managed) {
    el.value = "";
    el.placeholder = t("backend.modelManaged");
    el.disabled = true;
    return;
  }
  el.disabled = false;
  el.placeholder = b.model;
  el.value = current && current !== b.model ? current : "";
}

/** 按后端类型决定哪些字段可编辑、哪些提示要显示 */
function applyBackendGating(b: BackendConfig): void {
  // Base URL 是本站的内部选择（开箱即用后端尤其如此），不展示；
  // Model ID 则对所有后端可见可改 —— 用户可能想换模型做对比实验。
  $("advancedApi").style.display = b.managed ? "none" : "";

  $("modelHint").textContent = b.managed
    ? t("backend.modelManagedHint")
    : t("backend.modelPlaceholder", { model: b.model });

  // 说明文字 = 「已实测可用 / 未经实测」+ 该后端的描述（描述本身也走 i18n）
  const note = t(b.noteKey);
  $("backendNote").textContent =
    b.verified || !b.needsKey
      ? (b.verified && b.needsKey ? t("backend.verifiedOk") : "") + (b.needsKey ? note : "")
      : t("backend.unverified") + note;
  $("backendNote").style.display = $("backendNote").textContent ? "" : "none";

  if (b.needsKey) {
    inpKey.disabled = false;
    inpKey.placeholder = t("backend.keyPlaceholder");
    inpKey.style.userSelect = "auto";
  } else {
    inpKey.disabled = true;
    inpKey.value = "";
    inpKey.placeholder = t("backend.noKeyPlaceholder");
    inpKey.style.userSelect = "none";
  }
}

/**
 * 切换后端时调用：把该后端的默认端点与模型预置进表单。
 *
 * 这是「日常操作丝滑」的关键 —— 换后端不必去查它的模型 ID 是什么。
 * 代价是切走再切回会丢掉手改的模型值，但那正是「预置默认」的语义。
 */
function onBackendSwitch(): void {
  const id = selBackend.value as BackendId;
  const b = BACKENDS[id];
  fillBackendDefaults(id);
  // 换后端 = 回到该后端的默认模型，所以输入框清空、占位符换成新默认值
  fillModelField(b, "");
  applyBackendGating(b);
}

/**
 * 打开抽屉时调用：填**当前生效的配置**，而不是后端默认值。
 *
 * 与 onBackendSwitch 分开是必须的：
 * 如果打开抽屉也走默认值路径，用户刚改好的模型会在下次打开时被悄悄冲掉。
 */
function onApiDrawerOpen(): void {
  // 双保险：语言切换时 relanguage() 已经重建过，这里再建一次，
  // 这样无论用户是「先切语言再开抽屉」还是「开着抽屉切语言」都能对上
  fillBackendOptions();
  const b = BACKENDS[state.cfg.provider];
  selBackend.value = state.cfg.provider;
  $<HTMLInputElement>("inpBase").value = state.cfg.base;
  fillModelField(b, state.cfg.model);
  applyBackendGating(b);

  // 直连后端才有密钥可填，且浏览器不保存它 —— 每次打开都是空的
  if (b.needsKey) inpKey.value = "";
}

function syncApiUi(): void {
  const a = store.api;
  $<HTMLInputElement>("inpRetryMax").value = a.retryMax === null ? "inf" : String(a.retryMax);
  $<HTMLInputElement>("inpRetryBase").value = String(a.retryBaseMs);
  $("retryPreview").textContent = previewBackoff(a.retryMax, a.retryBaseMs);
}

function previewBackoff(max: number | null, base: number): string {
  const n = max === null ? 5 : Math.min(max, 5);
  if (n === 0) return t("retry.none");
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`${((base * Math.pow(2, i)) / 1000).toFixed(1)}s`);
  }
  return t("retry.sequence", { seq: parts.join(" → ") }) + (max === null || max > 5 ? " → …" : "");
}

function applyApiSettings(): void {
  const raw = $<HTMLInputElement>("inpRetryMax").value.trim().toLowerCase();
  const infinite = raw === "inf" || raw === "∞" || raw === "unlimited";
  store.api.retryMax = infinite
    ? null
    : Math.max(0, Math.min(MAX_RETRY, Math.round(Number(raw) || 0)));
  store.api.retryBaseMs = Math.max(100, Math.min(10_000, Number($<HTMLInputElement>("inpRetryBase").value) || DEFAULT_API.retryBaseMs));
  save(store);
  syncApiUi();
}

function saveApi(): void {
  const id = selBackend.value as BackendId;
  const b = BACKENDS[id];
  state.cfg = {
    provider: id,
    base: $<HTMLInputElement>("inpBase").value.trim(),
    model: $<HTMLInputElement>("inpModel").value.trim(),
    // 仅存内存，绝不落盘
    apiKey: b.needsKey ? inpKey.value.trim() : "",
  };
  // 状态栏的拼法只在 updateBackendLabel 里有一份 —— 之前这里另抄了一遍，
  // 于是「改了模型但状态栏没跟上」这类不一致迟早出现（函数上方注释早有提醒）
  updateBackendLabel();
  closeDrawers();
}

/* ═══════════ 节奏滑块 ═══════════ */

const paceSlider = $<HTMLInputElement>("pace");
const paceVal = $("paceVal");

/**
 * 步进间隔是**实时控制**而非配置项 —— 它既不进请求，也不改变动作如何落实，
 * 只影响自动走棋的播放速度。所以只在棋盘下方留一个滑块，设置抽屉里不重复出现。
 */
function paceLabel(ms: number): string {
  return ms === 0 ? t("pace.instant") : `${(ms / 1000).toFixed(1)}s`;
}

function syncPaceUi(): void {
  paceSlider.value = String(store.game.paceMs);
  paceVal.textContent = paceLabel(store.game.paceMs);
}

paceSlider.addEventListener("input", () => {
  store.game.paceMs = clampPace(paceSlider.value);
  paceVal.textContent = paceLabel(store.game.paceMs);
  save(store);
});

/* ═══════════ 事件 ═══════════ */

$("bToggle").onclick = toggleRun;
$("bStep").onclick = () => { pause(); void doTurn(); };
$("bNew").onclick = newGame;
$("bArchive").onclick = () => openDrawer("dArchive");
$("bGame").onclick = () => openDrawer("dGame");
$("bStrategy").onclick = () => openDrawer("dStrategy");
$("bApi").onclick = () => { onApiDrawerOpen(); openDrawer("dApi"); };
$("bLog").onclick = () => { renderLog(); openDrawer("dLog"); };

/* 导入导出 */
$("bExpGame").onclick = () => doExport("game", t("kind.game"));
$("bExpStrategy").onclick = () => doExport("strategy", t("kind.strategy"));
$("bExpApi").onclick = () => doExport("api", t("kind.api"));
$("bExpLog").onclick = () => doExport("log", t("kind.log"));
$("bExpAll").onclick = () => doExport("all", t("kind.all"));

$("bImpGame").onclick = () => pickFile((t) => applyImported(t, "game"));
$("bImpStrategy").onclick = () => pickFile((t) => applyImported(t, "strategy"));
$("bImpApi").onclick = () => pickFile((t) => applyImported(t, "api"));

$("fileInput").addEventListener("change", onFileChosen);

$("bArchiveWipe").onclick = () =>
  confirmAction(
    t("confirm.wipeAll"),
    () => {
      clearSession();
      try {
        localStorage.removeItem("jev2048.v1");
      } catch {
        /* ignore */
      }
      location.reload();
    },
  );

bindIncompatibleModal();
bindQuotaModal();
$("bSaveApi").onclick = saveApi;
$("bGameReset").onclick = () =>
  confirmAction(t("confirm.gameReset"), () => {
    resetGameSettings();
  });
$("bStrategyReset").onclick = () =>
  confirmAction(t("confirm.strategyReset"), () => {
    resetStrategySettings();
  });
$("bScoreReset").onclick = () =>
  confirmAction(
    t("confirm.scoreReset"),
    () => {
      resetScores();
      toast(t("confirm.scoresReset"));
    },
  );
$("bApiReset").onclick = () =>
  confirmAction(t("confirm.apiReset"), () => {
    resetApiSettings();
  });
$("bLogClear").onclick = () =>
  confirmAction(t("confirm.logClear"), () => {
    state.history = [];
    chart.clear();
    renderLog();
    persist();
  });
$("bCopyAll").onclick = (e) => {
  const all = state.history.map((r) => ({
    turn: r.turn, at: r.at, move: r.move, latencyMs: r.latencyMs, tokens: r.tokens,
    reason: r.reason, failed: r.failed, request: r.request, response: r.response,
  }));
  void copyText(fmtJson(all), e.currentTarget as HTMLButtonElement);
};
selBackend.onchange = onBackendSwitch;
scrim.onclick = closeDrawers;
for (const id of ["bArchiveDone", "bGameDone", "bStrategyDone", "bApiCancel", "bLogDone"]) {
  $(id).onclick = closeDrawers;
}

for (const id of ["inpRetryMax", "inpRetryBase"]) {
  $(id).addEventListener("change", applyApiSettings);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeDrawers(); return; }
  const tag = (document.activeElement as HTMLElement)?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;

  if (e.key === " ") {
    e.preventDefault();
    toggleRun();
    return;
  }
  if (state.running) return;
  const map: Record<string, Direction> = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  };
  const dir = map[e.key];
  if (!dir) return;
  e.preventDefault();
  manualMove(dir);
});

/* ═══════════ 启动 ═══════════ */

/**
 * 填充后端的下拉选项。
 *
 * 原先这段是**模块求值期**跑一次的裸循环，于是切换语言时下拉框永远停在
 * 初始化那一刻的语言上 —— 状态栏都跟着变了，唯独这里不动。
 * 抽成函数后由 `relanguage()` 重跑。
 */
function fillBackendOptions(): void {
  // 重建会丢选中项，先记下来
  const keep = selBackend.value || state.cfg.provider;
  selBackend.replaceChildren();
  for (const [id, b] of Object.entries(BACKENDS)) {
    const o = document.createElement("option");
    o.value = id;
    // 开箱即用的后端不加「已验证」标记 —— 那是在暗示它背后有可验证的第三方服务
    const name = t(b.labelKey);
    o.textContent = b.needsKey ? `${name}${b.verified ? " ✓" : t("backend.unverifiedTag")}` : name;
    selBackend.appendChild(o);
  }
  selBackend.value = keep;
}

fillBackendOptions();

const served = location.protocol === "http:" || location.protocol === "https:";
const staticHost = isStaticHosting();
if (served) {
  state.cfg = { provider: "localproxy", base: BACKENDS.localproxy.base, model: BACKENDS.localproxy.model, apiKey: "" };
  setLed("", "status.ready");
} else {
  state.cfg = { provider: "vercel", base: BACKENDS.vercel.base, model: BACKENDS.vercel.model, apiKey: "" };
  setLed("", "backend.needConfig");
}
selBackend.value = state.cfg.provider;
fillBackendDefaults(state.cfg.provider);
applyBackendGating(BACKENDS[state.cfg.provider]);
updateBackendLabel();

/**
 * 启动。
 *
 * 整体包在 try/catch 里是**刻意**的：模块求值阶段抛出的异常会静默中断后续所有初始化，
 * 表现为「棋盘空白、点一下就判负」这种与根因毫不相干的症状。
 * 真出问题时，至少要把它显式地报出来，而不是留一个空棋盘让玩家猜。
 */
/**
 * 按当前语言重画**全部**文案。
 *
 * 静态文案由 applyDom() 扫描 `data-i18n*` 属性搞定；但动态内容是各函数
 * 一次性写进 DOM 的，必须逐个重放 —— 尤其是决策面板与状态栏，它们
 * 除了这份缓存没有别的途径能恢复内容（见 lastDecision / lastLed）。
 */
function relanguage(): void {
  applyDom();

  if (lastLed) setLed(lastLed.cls, lastLed.key, lastLed.params);
  if (lastDecision) {
    const d = lastDecision;
    renderDecision(d.answer, d.move, d.latency, d.tokens, d.noteKey, d.coerced, d.noteParams);
  }

  syncGameUi();
  syncRunButton();
  syncApiUi();
  syncPaceUi();
  renderLog();
  updateBackendLabel();
  applyBackendGating(BACKENDS[state.cfg.provider]);
  // 下拉选项与 Model ID 的占位符都是「生成一次就留着」的，必须显式重建，
  // 否则它们会停在切换前那门语言
  fillBackendOptions();
  fillModelField(BACKENDS[state.cfg.provider], state.cfg.model);
  // 画布上的「等待对局数据」也是绘制一次就留下的，得重绘
  chart.redraw();
}

/** 顶栏的语言按钮：zh ↔ en 对切。标签由 applyDom 按 data-i18n 自动更新。 */
function bindLanguage(): void {
  $("bLang").addEventListener("click", () => {
    const next: Lang = getLang() === "zh" ? "en" : "zh";
    setLang(next);
  });
}

function boot(): void {
  // 先把所有必需的 id 一次性核对完，缺哪个直接说清楚
  assertDom([
    "board", "chart", "led", "status", "cost", "lat", "fb", "decision", "dTurn",
    "sScore", "sBest", "sTurn", "sMax", "sBestMax", "pace", "paceVal",
    "bToggle", "bStep", "bNew", "bArchive", "bGame", "bStrategy", "bApi", "bLog",
    "scrim", "dArchive", "dGame", "dStrategy", "dApi", "dLog", "fileInput",
    "incompatModal", "incompatReason", "incompatSize", "incompatPreview",
    "quotaModal", "quotaDetail", "bQuotaSwitch", "bQuotaClose",
    "bIncompatExport", "bIncompatForce", "bIncompatReset", "bIncompatLater",
    "bGameReset", "bScoreReset", "bStrategyReset", "bApiReset", "bArchiveWipe", "bLogClear", "bCopyAll",
    "ruleDesc", "hintText", "inpCons",
    "inpWidth", "inpHeight", "inpSpawnMin", "inpSpawnMax", "inpDist",
    "inpInitMin", "inpInitMax", "spawnWarn", "spawnMinVal", "spawnMaxVal", "initWarn", "inpAnim", "inpParticles",
    "inpStrategy", "inpThreshold", "thresholdRow", "thresholdVal", "inpMemory",
    "memoryVal", "bMemMax", "selBackend", "inpKey", "inpBase", "inpModel",
    "inpRetryMax", "inpRetryBase", "retryPreview", "backendNote", "backend", "avgCost",
    "advancedApi", "modelHint",
    "logList", "logCount", "bCopyAll", "bLogClear",
    "bLang", "langLbl",
  ]);

  // 语言：先套用已保存的选择，绑定切换按钮，再订阅「切换后重绘」。
  // setLang 只在值真的变了才广播，所以这里的首次套用不会触发重绘，
  // 随后的 applyDom() 负责把静态文案刷成当前语言。
  setLang(store.lang);
  bindLanguage();
  addDrawerCloseButtons();
  onLangChange(() => {
    store.lang = getLang();
    save(store);
    relanguage();
  });
  applyDom();

  // 指数输入框的上限跟着常量走，避免 HTML 里写死的数字与 MAX_SPAWN_EXP 脱节
  $<HTMLInputElement>("inpSpawnMin").max = String(MAX_SPAWN_EXP);
  $<HTMLInputElement>("inpSpawnMax").max = String(MAX_SPAWN_EXP);

  setBoardSize(store.lastWidth, store.lastHeight);
  renderer.animations = store.game.animations;
  renderer.particlesEnabled = store.game.particles;
  bindSwipe(canvas);

  bindGameSettings();
  bindContextSettings();
  syncGameUi();
  syncApiUi();
  syncPaceUi();

  fitBoard();
  // 优先还原上一局；没有可还原的存档才开新局
  if (!restoreSession()) newGame();
}

try {
  boot();
} catch (err) {
  console.error(t("dev.bootFail"), err);
  setLed("err", "boot.failed");
  const msg = err instanceof Error ? err.message : String(err);
  // 用最朴素的方式报错 —— 此时弹框、抽屉这些依赖可能本身就不可用
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
    "background:#0a0a0a;z-index:9999;padding:24px;text-align:center;" +
    "font:13px/1.7 ui-monospace,monospace;color:#f5b5b5;white-space:pre-wrap";
  box.textContent = t("boot.failedBody", { msg });
  document.body.appendChild(box);
}
for (const delay of [60, 200, 500]) setTimeout(() => { fitBoard(); fitChart(); }, delay);

void DEFAULT_RETRY; // 保留默认值导出，供外部引用
console.info(
  t("dev.bootInfo", {
    cols: COLS, rows: ROWS,
    min: store.game.spawnMin, max: store.game.spawnMax, dist: store.game.spawnDist,
    mem: store.game.memory === null ? t("dev.memMax") : store.game.memory,
    th: store.game.threshold,
  }),
);
