/**
 * 装配层：引擎 / 渲染 / 图表 / API / 决策策略 → DOM。
 *
 * 布局：界面锁在 100dvh 内，棋盘由 ResizeObserver 取 min(可用宽, 可用高) 定尺寸。
 */
import {
  MAX_BOARD,
  MIN_BOARD,
  SIZE,
  isPowerOfTwo,
  setBoardSize,
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
  loadSession,
  maxTileId,
  saveSession,
  saveSessionNow,
} from "./session.js";
import { trajectoryCells, countEmpty, maxInCorner, monotonicity } from "./metrics.js";
import {
  BACKENDS,
  DEFAULT_RETRY,
  callJev,
  estimateCost,
  type ClientConfig,
  type RetryPolicy,
} from "./api.js";
import { resolveDecision } from "./decision.js";
import { BoardRenderer } from "./render.js";
import { ConfidenceChart } from "./chart.js";
import {
  DEFAULT_API,
  DEFAULT_CONTEXT,
  DEFAULT_GAME,
  MAX_MEMORY,
  MAX_RETRY,
  clamp01,
  clampBoardSize,
  clampSpawn,
  bestTileFor,
  highScoreFor,
  load,
  recordScore,
  recordTile,
  save,
  type Persisted,
} from "./config.js";

/* ═══════════ 常量 ═══════════ */

const ARROW: Record<Direction, string> = { up: "↑", down: "↓", left: "←", right: "→" };
const NAME: Record<Direction, string> = { up: "上", down: "下", left: "左", right: "右" };

/** 模型上下文窗口（typesafe-ai/jev 元数据里的 context_window） */
const CONTEXT_WINDOW = 32000;
/** 估算用的每 token 字符数（JSON + 中文混合，保守取值） */
const CHARS_PER_TOKEN = 2.6;
/** 留给规则/策略/棋盘等固定内容的安全余量 */
const MEMORY_TOKEN_BUDGET = Math.floor(CONTEXT_WINDOW * 0.55);

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

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
  /** 当前棋盘尺寸下达成过的最大瓷砖值 */
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

function setLed(cls: "" | "on" | "busy" | "err", text: string): void {
  ledEl.className = "led" + (cls ? " " + cls : "");
  $("status").textContent = text;
}

function retryPolicy(): RetryPolicy {
  return { max: store.api.retryMax, baseMs: store.api.retryBaseMs };
}

function updateStats(): void {
  $("sScore").textContent = String(state.score);
  $("sBest").textContent = String(state.best);
  $("sTurn").textContent = String(state.turn);
  $("sMax").textContent = String(maxTile(state.tiles) || 0);
  $("sBestMax").textContent = String(state.bestTile);
}

/**
 * 记分与最大瓷砖。分数是「一局内累积」，最大瓷砖是「历史达成过的最高值」，
 * 两者都按棋盘尺寸分开存 —— 8×8 的纪录和 4×4 没有可比性。
 */
function recordProgress(): void {
  const cur = maxTile(state.tiles) || 0;
  let changed = false;

  if (state.score > state.best) {
    state.best = state.score;
    recordScore(store, SIZE, state.score);
    changed = true;
  }
  if (cur > state.bestTile) {
    state.bestTile = cur;
    recordTile(store, SIZE, cur);
    changed = true;
  }
  if (changed) updateStats();
}

/* ═══════════ 画布自适应 ═══════════ */

function fitBoard(): void {
  const box = canvas.parentElement;
  if (!box) return;
  const size = Math.floor(Math.min(box.clientWidth, box.clientHeight));
  if (size > 40) renderer.resize(size);
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
    board_legend: `0=空，其余为方块数值；棋盘为 ${SIZE}×${SIZE}`,
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

function renderDecision(
  answer: ChoiceAnswer | null,
  move: Direction,
  latency: number,
  tokens: number,
  note: string,
  coerced: boolean,
): void {
  const host = $("decision");
  $("dTurn").textContent = state.turn ? `#${state.turn}` : "";

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
      <span>置信 <b>${(answer.confidence ?? 0).toFixed(3)}</b></span>
      <span>${latency.toFixed(0)}ms</span>
      <span>${tokens} tok</span>
    </div>
    ${coerced ? `<div class="note-warn">${note}</div>` : ""}`;
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
  setLed("busy", "调用 Jev…");

  const g = store.game;
  const legal = validMoves(state.tiles);
  const requestBody = {
    model: state.cfg.model,
    state: buildState(state.tiles),
    questions: buildQuestions(state.tiles, store.context.consequences),
  };

  let answer: ChoiceAnswer | null = null;
  let latency = 0;
  let tokens = 0;
  let move: Direction | null = null;
  let note = "";
  let coerced = false;
  let belowThreshold: boolean | undefined;
  let response: unknown = null;
  let error: string | undefined;

  try {
    const res = await callJev(
      state.cfg,
      requestBody.state,
      requestBody.questions,
      retryPolicy(),
      {
        onRetry: (attempt, err, delay) => {
          setLed("busy", `重试 ${attempt}（${(delay / 1000).toFixed(1)}s 后）`);
          void err;
        },
      },
    );
    latency = performance.now() - turnStart;
    tokens = res.inputTokens;
    response = res.raw;

    const raw = res.answers.best_move;
    if (!raw || raw.type !== "choice") throw new Error("响应中缺少 choice 类型的 best_move");
    answer = raw;

    const r = resolveDecision(answer, legal, g.strategy as Strategy, g.threshold);
    move = r.move;
    note = r.reason;
    coerced = r.coerced;
    belowThreshold = r.belowThreshold;

    setLed("on", "Jev 在线");
    $("fb").classList.remove("on");
  } catch (err) {
    error = (err as Error).message;
    console.error(err);
    state.busy = false;
    setLed("err", "API 失败");

    pushLog({
      turn: state.turn + 1, move: legal[0], top: 0, bottom: 0, median: 0, confidence: 0,
      latencyMs: Math.round(performance.now() - turnStart), tokens: 0,
      reason: error, coerced: false, belowThreshold: undefined, failed: true,
      request: requestBody, response: null, at,
    });

    showOverlay(
      "API 调用失败",
      `${error}\n\n已按设置重试 ${store.api.retryMax === null ? "（无限）" : store.api.retryMax} 次仍未成功。`,
      true,
      [
        { label: "重试", fn: () => { hideOverlay(); void doTurn(); }, primary: true },
        { label: "跳过这一手", fn: () => { hideOverlay(); state.busy = false; if (state.running) void doTurn(); } },
      ],
    );
    return;
  }

  if (!move) { state.busy = false; setLed("err", "无可用移动"); return; }

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

  const nt = spawnTile(state.tiles, g.spawnMin, g.spawnMax);
  if (nt) state.tiles.push(nt);

  state.turn++;
  state.memory.push({ turn: state.turn, board: beforeGrid, move, score: state.score });
  renderer.sync(state.tiles, res.dying);

  // ★ 方向粒子动效：只在本手瓷砖划过的轨迹上生成
  if (answer) renderer.burst(move, trajectoryCells(beforeTiles, state.tiles, res.dying));
  recordProgress();

  if (answer) {
    state.costTotal += estimateCost(tokens);
    $("cost").textContent = `$${state.costTotal.toFixed(4)}`;
    $("lat").textContent = `${latency.toFixed(0)}ms`;
    renderDecision(answer, move, latency, tokens, note, coerced);
  } else {
    renderDecision(null, move, 0, 0, note, false);
  }

  pushLog({
    turn: state.turn, move,
    top: answer ? Math.max(...Object.values(answer.probabilities)) : 0,
    bottom: answer ? Math.min(...Object.values(answer.probabilities)) : 0,
    median: answer ? median(Object.values(answer.probabilities)) : 0,
    confidence: answer?.confidence ?? 0,
    latencyMs: Math.round(latency), tokens,
    reason: note, coerced, belowThreshold, failed: false,
    request: requestBody, response, at,
  });

  state.busy = false;

  if (state.running) {
    const rest = store.game.paceMs - (performance.now() - turnStart);
    if (rest > 0) await wait(rest);
    if (state.running) void doTurn();
  } else {
    setLed("", "已暂停");
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
  setLed("", "游戏结束");
  syncRunButton();
  recordProgress();
  // 结束后立即落盘并标记 finished —— 刷新页面不该「续玩」一局已经结束的棋
  saveSessionNow({
    size: SIZE,
    tiles: state.tiles,
    score: state.score,
    turn: state.turn,
    memory: state.memory,
    history: state.history,
    finished: true,
  });
  showOverlay(
    "游戏结束",
    `得分 ${state.score}　最大方块 ${maxTile(state.tiles) || 0}　共 ${state.turn} 回合\n` +
      `历史最高分 ${state.best}　历史最大瓷砖 ${state.bestTile}`,
    false,
    [{ label: "再来一局", fn: () => { hideOverlay(); newGame(); }, primary: true }],
  );
}

/* ═══════════ 控制 ═══════════ */

/**
 * 尝试从 localStorage 还原上一局。
 *
 * 只在存档的棋盘尺寸与当前设置一致、且该局尚未结束时才还原 ——
 * 换过尺寸或已经结束的存档直接作废并清掉，避免出现「4×4 的棋盘配 8×8 的纪录」这种错位。
 *
 * @returns 是否成功还原
 */
function restoreSession(): boolean {
  const s = loadSession();
  if (!s) return false;

  if (s.size !== SIZE || s.finished || s.tiles.length === 0) {
    clearSession();
    return false;
  }

  state.tiles = s.tiles;
  state.score = s.score;
  state.turn = s.turn;
  state.memory = s.memory;
  state.history = s.history;

  // 关键：把引擎的 id 计数器顶到存档里的最大值之上，否则新方块会与旧方块 id 撞车
  ensureTileSeqAbove(maxTileId(state.tiles));

  state.best = highScoreFor(store, SIZE);
  state.bestTile = bestTileFor(store, SIZE);

  renderer.sync(state.tiles);
  updateStats();
  chart.setData(state.history);
  renderLog();

  state.costTotal = state.history.reduce((sum, r) => sum + estimateCost(r.tokens), 0);
  $("cost").textContent = `$${state.costTotal.toFixed(4)}`;
  const last = state.history[state.history.length - 1];
  $("lat").textContent = last ? `${last.latencyMs}ms` : "—";
  $("decision").innerHTML = `<div class="idle">已恢复上一局（第 ${state.turn} 手）</div>`;
  $("dTurn").textContent = state.turn ? `#${state.turn}` : "";
  syncRunButton();
  setLed("", `已恢复上一局 · 第 ${state.turn} 手`);
  return true;
}

/** 把当前对局写进 localStorage。每手结束后调用（内部防抖）。 */
function persist(): void {
  saveSession({
    size: SIZE,
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
  state.tiles.push(
    makeTile(g.spawnMin, Math.floor(Math.random() * SIZE), Math.floor(Math.random() * SIZE)),
  );
  const t2 = spawnTile(state.tiles, g.spawnMin, g.spawnMax);
  if (t2) state.tiles.push(t2);

  state.best = highScoreFor(store, SIZE);
  state.bestTile = bestTileFor(store, SIZE);
  renderer.sync(state.tiles);
  updateStats();
  saveSessionNow({
    size: SIZE,
    tiles: state.tiles,
    score: 0,
    turn: 0,
    memory: [],
    history: [],
    finished: false,
  });

  $("cost").textContent = "$0";
  $("lat").textContent = "—";
  $("decision").innerHTML = '<div class="idle">尚未开始</div>';
  $("dTurn").textContent = "";
  $("fb").classList.remove("on");
  syncRunButton();
  setLed("", "就绪");
  fitBoard();
  fitChart();
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
    b.textContent = "⏸ 暂停";
    b.classList.remove("primary");
    b.classList.add("running");
    b.title = "暂停自动走棋（空格）";
  } else {
    b.textContent = "▶ 让 Jev 接管";
    b.classList.remove("running");
    b.classList.add("primary");
    b.title = "让 Jev 接管，自动走棋（空格）";
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
  setLed("", "已暂停");
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
  const nt = spawnTile(state.tiles, g.spawnMin, g.spawnMax);
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

function renderLog(): void {
  const host = $("logList");
  const tag = $("logCount");
  const n = state.history.length;
  tag.textContent = n ? `${n} 条` : "";

  if (n === 0) {
    host.innerHTML = `<div class="idle">还没有请求记录</div>`;
    return;
  }

  // 最新的在最上面
  host.innerHTML = state.history
    .slice()
    .reverse()
    .map((r) => {
      const tm = r.at.slice(11, 19);
      const cls = r.failed ? "lg err" : r.coerced ? "lg warn" : "lg";
      const head = r.failed
        ? `<span class="lgmove err">失败</span>`
        : `<span class="lgmove">${ARROW[r.move]}</span>`;
      const probs = r.failed
        ? ""
        : `<span class="lgprobs">${r.top.toFixed(2)} / ${r.median.toFixed(2)} / ${r.bottom.toFixed(2)}</span>`;
      return `<details class="${cls}">
        <summary>
          <span class="lgturn">#${r.turn}</span>
          ${head}
          ${probs}
          <span class="lgmeta">${r.latencyMs}ms · ${r.tokens}tok · ${tm}</span>
        </summary>
        <div class="lgbody">
          <div class="lgrow"><span>决策依据</span><code>${escapeHtml(r.reason)}</code></div>
          <div class="lgbtns">
            <button data-copy="req" data-i="${r.turn}">复制请求</button>
            <button data-copy="res" data-i="${r.turn}">复制响应</button>
            <button data-copy="both" data-i="${r.turn}">复制完整调用</button>
          </div>
          <div class="lglabel">请求 request</div>
          <pre>${escapeHtml(fmtJson(r.request))}</pre>
          <div class="lglabel">响应 response</div>
          <pre>${r.response ? escapeHtml(fmtJson(r.response)) : "（无 —— 本次调用失败）"}</pre>
        </div>
      </details>`;
    })
    .join("");

  host.querySelectorAll<HTMLButtonElement>("button[data-copy]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const i = Number(btn.dataset.i);
      const row = state.history.find((r) => r.turn === i);
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
    btn.textContent = "已复制 ✓";
  } catch {
    // 非安全上下文（file:// 或 http 内网）没有 clipboard API，退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    btn.textContent = ok ? "已复制 ✓" : "复制失败";
  }
  setTimeout(() => { btn.textContent = old; }, 1200);
}

/* ═══════════ 抽屉 ═══════════ */

const scrim = $("scrim");
/** 呈现顺序即此数组顺序：游戏 → 策略 → API → 日志 */
const DRAWERS = ["dGame", "dStrategy", "dApi", "dLog"];

function openDrawer(id: string): void {
  for (const d of DRAWERS) $(d).classList.toggle("show", d === id);
  scrim.classList.add("show");
}

function closeDrawers(): void {
  for (const d of DRAWERS) $(d).classList.remove("show");
  scrim.classList.remove("show");
}

/* ═══════════ 游戏设置 ═══════════ */

function syncGameUi(): void {
  const g = store.game;
  $<HTMLSelectElement>("inpSize").value = String(g.boardSize);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-size]")) {
    b.classList.toggle("on", Number(b.dataset.size) === g.boardSize);
  }
  $<HTMLInputElement>("inpSpawnMin").value = String(g.spawnMin);
  $<HTMLInputElement>("inpSpawnMax").value = g.spawnMax === null ? "" : String(g.spawnMax);
  $<HTMLInputElement>("inpAnim").checked = g.animations;
  $<HTMLInputElement>("inpParticles").checked = g.particles;
  $<HTMLSelectElement>("inpStrategy").value = g.strategy;
  $<HTMLInputElement>("inpThreshold").value = String(Math.round(g.threshold * 100));
  $("thresholdVal").textContent = `${Math.round(g.threshold * 100)}%`;
  $<HTMLInputElement>("inpMemory").value = g.memory === null ? "max" : String(g.memory);
  $("memoryVal").textContent = g.memory === null ? "最大" : String(g.memory);
  $("thresholdRow").style.display = g.strategy === "threshold" ? "" : "none";
}

function applyGameSettings(): void {
  const g = store.game;
  const min = clampSpawn($<HTMLInputElement>("inpSpawnMin").value);
  const rawMax = $<HTMLInputElement>("inpSpawnMax").value.trim();
  const max = rawMax === "" ? null : clampSpawn(rawMax);

  g.spawnMin = min;
  g.spawnMax = max === null ? null : Math.max(min, max);
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
  const minV = Number($<HTMLInputElement>("inpSpawnMin").value);
  const rawMax = $<HTMLInputElement>("inpSpawnMax").value.trim();
  const maxV = rawMax === "" ? null : Number(rawMax);
  const bad =
    !isPowerOfTwo(Math.round(minV)) ||
    (maxV !== null && (!isPowerOfTwo(Math.round(maxV)) || maxV < minV));
  $("spawnWarn").style.display = bad ? "block" : "none";
  return !bad;
}

function setBoardSizeAndRestart(n: number): void {
  const size = clampBoardSize(n);
  store.game.boardSize = size;
  store.lastSize = size;
  save(store);
  setBoardSize(size);
  syncGameUi();
  newGame();
}

function bindGameSettings(): void {
  const sel = $<HTMLSelectElement>("inpSize");
  for (let n = MIN_BOARD; n <= MAX_BOARD; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = `${n} × ${n}`;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => setBoardSizeAndRestart(Number(sel.value)));

  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-size]")) {
    b.onclick = () => setBoardSizeAndRestart(Number(b.dataset.size));
  }

  const onSpawn = (): void => { if (validateSpawn()) applyGameSettings(); };
  $("inpSpawnMin").addEventListener("change", onSpawn);
  $("inpSpawnMax").addEventListener("change", onSpawn);

  for (const id of ["inpAnim", "inpParticles", "inpPace", "inpStrategy"]) {
    $(id).addEventListener("change", applyGameSettings);
  }

  // 阈值：滑块即时反馈
  const th = $<HTMLInputElement>("inpThreshold");
  th.addEventListener("input", () => {
    $("thresholdVal").textContent = `${th.value}%`;
  });
  th.addEventListener("change", applyGameSettings);

  // 记忆：滑块 + 「最大」按钮
  const mem = $<HTMLInputElement>("inpMemory");
  mem.addEventListener("input", () => {
    $("memoryVal").textContent = mem.value === "max" ? "最大" : mem.value;
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

  if (store.game.boardSize !== SIZE) {
    setBoardSize(store.game.boardSize);
    store.lastSize = store.game.boardSize;
    newGame();
  }
}

function resetStrategySettings(): void {
  Object.assign(store.game, {
    strategy: DEFAULT_GAME.strategy,
    threshold: DEFAULT_GAME.threshold,
    memory: DEFAULT_GAME.memory,
  });
  Object.assign(store.context, DEFAULT_CONTEXT);
  save(store);

  $<HTMLTextAreaElement>("ruleDesc").value = DEFAULT_CONTEXT.ruleDesc;
  $<HTMLTextAreaElement>("hintText").value = DEFAULT_CONTEXT.strategyHint;
  $<HTMLInputElement>("inpCons").checked = DEFAULT_CONTEXT.consequences;
  syncGameUi();
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

function refreshBackend(): void {
  const b = BACKENDS[selBackend.value as BackendId];
  $<HTMLInputElement>("inpBase").value = b.base;
  $<HTMLInputElement>("inpModel").value = b.model;
  $("backendNote").textContent = (b.verified ? "✅ 已验证可用。" : "⚠ 未经实测验证。") + b.note;

  if (b.needsKey) {
    inpKey.disabled = false;
    inpKey.placeholder = "粘贴你的 API Key（仅存内存，刷新即清除）";
    inpKey.style.userSelect = "auto";
  } else {
    inpKey.disabled = true;
    inpKey.value = "";
    inpKey.placeholder = "••••••••••　由本机服务器持有，不可查看";
    inpKey.style.userSelect = "none";
  }
}

function syncApiUi(): void {
  const a = store.api;
  $<HTMLInputElement>("inpRetryMax").value = a.retryMax === null ? "inf" : String(a.retryMax);
  $<HTMLInputElement>("inpRetryBase").value = String(a.retryBaseMs);
  $("retryPreview").textContent = previewBackoff(a.retryMax, a.retryBaseMs);
}

function previewBackoff(max: number | null, base: number): string {
  const n = max === null ? 5 : Math.min(max, 5);
  if (n === 0) return "不重试";
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`${((base * Math.pow(2, i)) / 1000).toFixed(1)}s`);
  }
  return `等待序列：${parts.join(" → ")}${max === null || max > 5 ? " → …" : ""}`;
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
  $("backend").textContent = `${b.label} · ${state.cfg.model}`;
  closeDrawers();
}

/* ═══════════ 节奏滑块 ═══════════ */

const paceSlider = $<HTMLInputElement>("pace");
const paceVal = $("paceVal");

/**
 * 步进间隔是**实时控制**而非配置项 —— 它既不进请求，也不改变动作如何落实，
 * 只影响自动走棋的播放速度。所以只在棋盘下方留一个滑块，设置抽屉里不重复出现。
 */
function syncPaceUi(): void {
  paceSlider.value = String(store.game.paceMs);
  paceVal.textContent = `${(store.game.paceMs / 1000).toFixed(1)}s`;
}

paceSlider.addEventListener("input", () => {
  store.game.paceMs = Number(paceSlider.value);
  paceVal.textContent = `${(store.game.paceMs / 1000).toFixed(1)}s`;
  save(store);
});

/* ═══════════ 事件 ═══════════ */

$("bToggle").onclick = toggleRun;
$("bStep").onclick = () => { pause(); void doTurn(); };
$("bNew").onclick = newGame;
$("bGame").onclick = () => openDrawer("dGame");
$("bStrategy").onclick = () => openDrawer("dStrategy");
$("bApi").onclick = () => openDrawer("dApi");
$("bLog").onclick = () => { renderLog(); openDrawer("dLog"); };
$("bSaveApi").onclick = saveApi;
$("bGameReset").onclick = () =>
  confirmAction("恢复游戏的默认设置？\n（棋盘尺寸、新方块区间、动效都会回到出厂值；历史最高分保留）", () => {
    resetGameSettings();
  });
$("bStrategyReset").onclick = () =>
  confirmAction("恢复策略的默认设置？\n（上下文文本、后果预测、记忆、决策策略、阈值都会回到出厂值）", () => {
    resetStrategySettings();
  });
$("bApiReset").onclick = () =>
  confirmAction("恢复 API 的默认设置？\n（自动重试参数回到出厂值；后端与密钥不受影响）", () => {
    resetApiSettings();
  });
$("bLogClear").onclick = () =>
  confirmAction("清空全部调用日志？此操作不可撤销。", () => {
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
selBackend.onchange = refreshBackend;
scrim.onclick = closeDrawers;
for (const id of ["bGameDone", "bStrategyDone", "bApiCancel", "bLogDone"]) {
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

for (const [id, b] of Object.entries(BACKENDS)) {
  const o = document.createElement("option");
  o.value = id;
  o.textContent = `${b.label}${b.verified ? " ✓" : " (未验证)"}`;
  selBackend.appendChild(o);
}

const served = location.protocol === "http:" || location.protocol === "https:";
if (served) {
  selBackend.value = "localproxy";
  state.cfg = { provider: "localproxy", base: "/api/evaluate", model: "typesafe-ai/jev", apiKey: "" };
  $("backend").textContent = "本机代理 · typesafe-ai/jev";
  setLed("", "就绪");
} else {
  selBackend.value = "vercel";
  state.cfg = { provider: "vercel", base: BACKENDS.vercel.base, model: BACKENDS.vercel.model, apiKey: "" };
  $("backend").textContent = "未配置";
  setLed("", "请在 API 中配置");
}
refreshBackend();

setBoardSize(store.lastSize);
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
for (const t of [60, 200, 500]) setTimeout(() => { fitBoard(); fitChart(); }, t);

void DEFAULT_RETRY; // 保留默认值导出，供外部引用
console.info(
  `[Jev×2048] 棋盘 ${SIZE}×${SIZE}　生成 ${store.game.spawnMin}–${store.game.spawnMax ?? "∞"}` +
    `　记忆 ${store.game.memory === null ? "最大" : store.game.memory}　阈值 ${store.game.threshold}`,
);
