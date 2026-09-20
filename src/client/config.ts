/**
 * 配置持久化。
 *
 * 写入 localStorage 的只有**非敏感**内容：游戏设置、上下文文本、历史最高分。
 * API Key 绝不落盘 —— 它只存在于内存（代理模式下更是连浏览器都拿不到）。
 */
import {
  MAX_BOARD,
  MIN_BOARD,
  SPAWN_ALLOWED,
  type SpawnDist,
} from "../shared/types.js";

const KEY = "jev2048.v1";

export interface GameSettings {
  /** 棋盘宽（列数），与高独立 */
  boardWidth: number;
  /** 棋盘高（行数），与宽独立 */
  boardHeight: number;
  /** 新方块取值区间的下界（只接受 2 或 4） */
  spawnMin: number;
  /** 上界（只接受 2 或 4） */
  spawnMax: number;
  /** 生成值的分布：等概率，或权重为值的倒数（越大的越罕见） */
  spawnDist: SpawnDist;
  /**
   * 开局时随机摆放的瓷砖个数区间。
   *
   * 下限**不能是 0** —— 空棋盘上任何方向都无法移动，第一步就会被判负。
   * 这是标准 2048 的规则，也是曾真实出过的 bug。
   */
  initialMin: number;
  initialMax: number;
  animations: boolean;
  /** 方向箭头粒子动效 */
  particles: boolean;
  paceMs: number;
  strategy: "greedy" | "sample" | "threshold";
  /** 置信度门槛 0–1。0 表示不启用。 */
  threshold: number;
  /**
   * 记忆轮数：把最近 n 轮的「局面 + 操作」一并发给 Jev。
   * 0 = 不加入（原版行为）；null = 最大（在上下文预算内塞满）。
   */
  memory: number | null;
}

export interface ContextSettings {
  ruleDesc: string;
  strategyHint: string;
  consequences: boolean;
}

export interface Persisted {
  game: GameSettings;
  context: ContextSettings;
  /** 重试等非敏感 API 设置。API Key 绝不在这里。 */
  api: ApiSettings;
  /** 各棋盘尺寸下的历史最高分 */
  highScores: Record<string, number>;
  /** 各棋盘尺寸下达成过的最大瓷砖值 */
  bestTiles: Record<string, number>;
  /** 上一局用的棋盘尺寸，便于启动时恢复 */
  lastWidth: number;
  lastHeight: number;
}

export const DEFAULT_GAME: GameSettings = {
  boardWidth: 4,
  boardHeight: 4,
  spawnMin: 2,
  spawnMax: 4,
  spawnDist: "weighted",
  initialMin: 1,
  initialMax: 2,
  animations: true,
  particles: true,
  paceMs: 2000,
  strategy: "greedy",
  threshold: 0,
  memory: 0,
};

export const DEFAULT_CONTEXT: ContextSettings = {
  ruleDesc: `你正在玩 2048 游戏。棋盘是矩形网格，0 表示空格。
每次移动后，会在一个随机空位生成一个新方块。
相同的两个方块相撞会合并成它们之和，并计入得分。目标是合并出 2048。`,
  strategyHint: `策略要点：
- 保持棋盘单调（数字从一角向另一角递减）
- 把最大方块固定在角落里
- 避免频繁切换移动方向
- 保留足够的空格`,
  consequences: true,
};

/* ---------- 校验 ---------- */

/** 棋盘单边长度：夹在 [MIN_BOARD, MAX_BOARD] */
export function clampBoardSize(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 4;
  return Math.min(MAX_BOARD, Math.max(MIN_BOARD, n));
}

/**
 * 生成值：只接受 2 或 4。
 * 非法输入回落到最近的那个允许值（不抛错，配置面板要能容错）。
 */
export function clampSpawn(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return SPAWN_ALLOWED[0];
  let best: number = SPAWN_ALLOWED[0];
  for (const a of SPAWN_ALLOWED) {
    if (Math.abs(a - n) < Math.abs(best - n)) best = a;
  }
  return best;
}

/** 生成分布：只认 uniform / weighted；缺失时取默认（加权） */
export function clampDist(v: unknown): SpawnDist {
  return v === "uniform" ? "uniform" : "weighted";
}

/**
 * 历史纪录的键。矩形棋盘下 `"4"` 这种单数字键不再够用，改用 `"宽x高"`。
 * 旧版本的单数字键在读取时会自然落空（视为无纪录），不会读到错位的数值。
 */
export function dimKey(cols: number, rows: number): string {
  return `${cols}x${rows}`;
}

/** 初始瓷砖个数的上限护栏（棋盘再大也不该开局铺满） */
export const MAX_INITIAL = 32;

/**
 * 初始瓷砖个数：下限**强制为 1**。
 *
 * 0 个瓷砖的棋盘上四个方向都无法移动，游戏会在第一步直接判负 ——
 * 这不是可配置项，是规则约束。
 */
export function clampInitial(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_INITIAL, Math.max(1, n));
}

/** 置信度门槛归一到 [0, 1] */
export function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 记忆轮数的上限（防止 UI 滑块给出荒谬值） */
export const MAX_MEMORY = 60;

/** 重试次数上限（UI 侧护栏，无限重试用 null 表示） */
export const MAX_RETRY = 20;

/* ---------- API 侧的非敏感设置 ---------- */

export interface ApiSettings {
  /** 自动重试：最大次数；null = 无限重试 */
  retryMax: number | null;
  /** 指数退避基数（毫秒） */
  retryBaseMs: number;
}

export const DEFAULT_API: ApiSettings = {
  retryMax: 3,
  retryBaseMs: 800,
};

/* ---------- 读写 ---------- */

function safeParse(raw: string | null): Partial<Persisted> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return typeof o === "object" && o !== null ? (o as Partial<Persisted>) : null;
  } catch {
    return null;
  }
}

export function load(): Persisted {
  const o = safeParse(
    typeof localStorage === "undefined" ? null : localStorage.getItem(KEY),
  );

  const g = (o?.game ?? {}) as Partial<GameSettings>;
  const c = (o?.context ?? {}) as Partial<ContextSettings>;
  const a = (o?.api ?? {}) as Partial<ApiSettings>;
  const legacyLast = (o as Record<string, unknown> | null)?.lastSize as number | undefined;

  // 兼容旧字段名：早期版本用 boardSize（正方形）
  const legacy = g as Record<string, unknown>;
  const spawnMin = clampSpawn(g.spawnMin ?? DEFAULT_GAME.spawnMin);
  const rawMax = clampSpawn(g.spawnMax ?? DEFAULT_GAME.spawnMax);

  return {
    game: {
      boardWidth: clampBoardSize(g.boardWidth ?? legacy.boardSize ?? DEFAULT_GAME.boardWidth),
      boardHeight: clampBoardSize(g.boardHeight ?? legacy.boardSize ?? DEFAULT_GAME.boardHeight),
      spawnMin,
      // 上界不得小于下界
      spawnMax: Math.max(spawnMin, rawMax),
      spawnDist: clampDist(g.spawnDist),
      initialMin: clampInitial(g.initialMin, DEFAULT_GAME.initialMin),
      initialMax: Math.max(
        clampInitial(g.initialMin, DEFAULT_GAME.initialMin),
        clampInitial(g.initialMax, DEFAULT_GAME.initialMax),
      ),
      animations: g.animations ?? DEFAULT_GAME.animations,
      particles: g.particles ?? DEFAULT_GAME.particles,
      paceMs: Math.min(5000, Math.max(100, Number(g.paceMs) || DEFAULT_GAME.paceMs)),
      strategy:
        g.strategy === "sample" || g.strategy === "threshold" ? g.strategy : "greedy",
      threshold: clamp01(g.threshold),
      memory:
        g.memory === null || g.memory === undefined
          ? (g.memory === null ? null : 0)
          : Math.max(0, Math.min(60, Math.round(Number(g.memory) || 0))),
    },
    context: {
      ruleDesc: typeof c.ruleDesc === "string" ? c.ruleDesc : DEFAULT_CONTEXT.ruleDesc,
      strategyHint:
        typeof c.strategyHint === "string" ? c.strategyHint : DEFAULT_CONTEXT.strategyHint,
      consequences: c.consequences ?? DEFAULT_CONTEXT.consequences,
    },
    api: {
      // undefined → 默认值；显式 null → 无限重试
      retryMax:
        a.retryMax === null
          ? null
          : Math.max(0, Math.min(MAX_RETRY, Math.round(Number(a.retryMax ?? DEFAULT_API.retryMax) || 0))),
      retryBaseMs: Math.max(100, Math.min(10_000, Number(a.retryBaseMs ?? DEFAULT_API.retryBaseMs) || 800)),
    },
    highScores:
      o?.highScores && typeof o.highScores === "object" ? { ...o.highScores } : {},
    bestTiles:
      o?.bestTiles && typeof o.bestTiles === "object" ? { ...o.bestTiles } : {},
    lastWidth: clampBoardSize(o?.lastWidth ?? legacyLast ?? DEFAULT_GAME.boardWidth),
    lastHeight: clampBoardSize(o?.lastHeight ?? legacyLast ?? DEFAULT_GAME.boardHeight),
  };
}

export function save(p: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式 / 配额满 —— 静默降级，不影响游戏 */
  }
}

/* ---------- 历史最高 ---------- */

export function highScoreFor(p: Persisted, cols: number, rows: number): number {
  return Number(p.highScores[dimKey(cols, rows)] ?? 0) || 0;
}

/** 返回是否刷新了纪录 */
export function recordScore(p: Persisted, cols: number, rows: number, score: number): boolean {
  const cur = highScoreFor(p, cols, rows);
  if (score > cur) {
    p.highScores[dimKey(cols, rows)] = score;
    save(p);
    return true;
  }
  return false;
}

export function bestTileFor(p: Persisted, cols: number, rows: number): number {
  return Number(p.bestTiles[dimKey(cols, rows)] ?? 0) || 0;
}

/** 返回是否刷新了最大瓷砖纪录 */
export function recordTile(p: Persisted, cols: number, rows: number, tile: number): boolean {
  const cur = bestTileFor(p, cols, rows);
  if (tile > cur) {
    p.bestTiles[dimKey(cols, rows)] = tile;
    save(p);
    return true;
  }
  return false;
}
