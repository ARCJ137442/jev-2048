/**
 * 配置持久化。
 *
 * 写入 localStorage 的只有**非敏感**内容：游戏设置、上下文文本、历史最高分。
 * API Key 绝不落盘 —— 它只存在于内存（代理模式下更是连浏览器都拿不到）。
 */
import { MAX_BOARD, MIN_BOARD, isPowerOfTwo } from "../shared/types.js";

const KEY = "jev2048.v1";

export interface GameSettings {
  boardSize: number;
  /** 新方块取值区间的下界（2 的幂次，>=1） */
  spawnMin: number;
  /** 上界（2 的幂次），null 表示不限 */
  spawnMax: number | null;
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
  lastSize: number;
}

export const DEFAULT_GAME: GameSettings = {
  boardSize: 4,
  spawnMin: 2,
  spawnMax: 2,
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
  ruleDesc: `你正在玩 2048 游戏。棋盘是 4×4 网格，0 表示空格。
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

export function clampBoardSize(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_GAME.boardSize;
  return Math.min(MAX_BOARD, Math.max(MIN_BOARD, n));
}

/** 生成值必须是 2 的幂次且 >= 1；非法则回落到 2 */
export function clampSpawn(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || !isPowerOfTwo(n)) return 2;
  return n;
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

  const spawnMin = clampSpawn(g.spawnMin ?? DEFAULT_GAME.spawnMin);
  const rawMax = g.spawnMax === null || g.spawnMax === undefined ? null : clampSpawn(g.spawnMax);

  return {
    game: {
      boardSize: clampBoardSize(g.boardSize ?? DEFAULT_GAME.boardSize),
      spawnMin,
      // 上界不得小于下界
      spawnMax: rawMax === null ? null : Math.max(spawnMin, rawMax),
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
    lastSize: clampBoardSize(o?.lastSize ?? DEFAULT_GAME.boardSize),
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

export function highScoreFor(p: Persisted, size: number): number {
  return Number(p.highScores[String(size)] ?? 0) || 0;
}

/** 返回是否刷新了纪录 */
export function recordScore(p: Persisted, size: number, score: number): boolean {
  const cur = highScoreFor(p, size);
  if (score > cur) {
    p.highScores[String(size)] = score;
    save(p);
    return true;
  }
  return false;
}

export function bestTileFor(p: Persisted, size: number): number {
  return Number(p.bestTiles[String(size)] ?? 0) || 0;
}

/** 返回是否刷新了最大瓷砖纪录 */
export function recordTile(p: Persisted, size: number, tile: number): boolean {
  const cur = bestTileFor(p, size);
  if (tile > cur) {
    p.bestTiles[String(size)] = tile;
    save(p);
    return true;
  }
  return false;
}
