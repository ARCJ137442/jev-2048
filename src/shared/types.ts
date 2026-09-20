/**
 * 前后端共享的类型定义。
 *
 * 这里的 Jev 协议类型全部来自实测，与部分公开文档不一致的地方已标注。
 */

/* ============================================================
   棋盘
   ============================================================ */

/**
 * 棋盘尺寸。**宽高独立可变** —— 通过 setBoardSize() 在开局前设置。
 *
 * 注意：这是 ESM 的 live binding，各模块 `import { COLS, ROWS }` 后读到的是最新值。
 * 但**不要**在模块顶层写 `const n = COLS` 之类的快照，那样会固化。
 */
export let COLS = 4;   // 宽（列数）
export let ROWS = 4;   // 高（行数）

export const MIN_BOARD = 2;
export const MAX_BOARD = 16;

/** 常见预设，UI 里做成按钮 */
export const BOARD_PRESETS: Array<[number, number]> = [
  [4, 4],
  [6, 6],
  [8, 8],
  [16, 2],
];

export function setBoardSize(cols: number, rows: number): void {
  const c = Math.round(cols);
  const r = Math.round(rows);
  const bad = (v: number, name: string): never => {
    throw new Error(
      `棋盘${name}需在 ${MIN_BOARD}–${MAX_BOARD} 之间，收到 ${v}`,
    );
  };
  if (!Number.isFinite(c) || c < MIN_BOARD || c > MAX_BOARD) bad(c, "宽");
  if (!Number.isFinite(r) || r < MIN_BOARD || r > MAX_BOARD) bad(r, "高");
  COLS = c;
  ROWS = r;
}

/** 是否为 2 的幂次。1 也算（2^0）。 */
export function isPowerOfTwo(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && (v & (v - 1)) === 0;
}

/* ============================================================
   新方块生成
   ============================================================ */

/** 生成值的允许范围：只接受 2 与 4 这两个幂次 */
export const SPAWN_ALLOWED = [2, 4] as const;
export const SPAWN_MIN_LIMIT = 2;
export const SPAWN_MAX_LIMIT = 4;

/**
 * 生成值的分布方式。
 *   uniform   区间内所有取值等概率
 *   weighted  权重为值的倒数 —— 越大的值越罕见
 */
export type SpawnDist = "uniform" | "weighted";

export type Direction = "up" | "down" | "left" | "right";

export interface Tile {
  id: number;
  value: number;
  row: number;
  col: number;
  /** 本回合新生成（触发入场动画） */
  isNew?: boolean;
  /** 本回合由合并产生（触发脉冲动画） */
  isMerged?: boolean;
  dying?: boolean;
}

export type Grid = number[][];

/* ============================================================
   Jev 协议
   ============================================================ */

/**
 * 问题类型判别值。
 *
 * ⚠ **各网关的取值不一致**，实测结论：
 *
 *   TypeSafe 官方   noul | choice | score
 *   OpenRouter      noul | choice | score
 *   AI/ML API       noul | choice | score
 *   Vercel Gateway  boolean | choice | score   ← 唯一的异类
 *
 * Vercel 自己封装时把 `noul` 改名成了 `boolean`。所以「文档写 noul、
 * API 实际叫 boolean」这句话**只对 Vercel 成立** —— 它一度被误当成通例。
 *
 * `choice` 与 `score` 四家一致，而本项目的 best_move 走的就是 choice，
 * 所以主流程不受影响。将来若要加布尔类型的问题，必须按后端取判别值。
 */
export type NoulType = "noul" | "boolean";
export type QuestionType = NoulType | "choice" | "score";

/** 某后端下布尔类型的实际判别值 */
export function noulDiscriminator(backend: string): NoulType {
  // Vercel 的封装使用了 boolean，其余（官方 / OpenRouter / AI-ML-API）都是 noul
  return backend === "vercel" ? "boolean" : "noul";
}

/** choice 的 criteria 是 map；score 是有序数组；boolean 是 {true,false} */
export type Criteria =
  | Record<string, string>
  | string[]
  | { true: string; false: string };

export interface Question {
  type: QuestionType;
  instructions: string;
  /** 必填。缺失会直接返回 400: expected record, received undefined */
  criteria: Criteria;
}

/** questions 是 record（映射），不是数组。传数组报 expected record, received array */
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** 分布集中度 0~1，与最高项概率不是一回事 */
  confidence: number;
}

/**
 * 布尔答案。字段名随网关变化：
 *   Vercel             {"type":"boolean","probability":0.69}
 *   OpenRouter / 官方   {"type":"noul","noul":0.96}
 * 两者都是 0~1 的概率，语义相同，只是键名不同。
 * 注意：**没有 confidence 字段** —— 概率本身就是置信度。
 */
export interface BooleanAnswer {
  type: NoulType;
  /** Vercel 用这个键 */
  probability?: number;
  /** OpenRouter / 官方用这个键 */
  noul?: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = ChoiceAnswer | BooleanAnswer | ScoreAnswer;

/** 从布尔答案里取概率 —— 两家键名不同，统一在这里抹平 */
export function noulProbability(a: BooleanAnswer): number {
  return a.noul ?? a.probability ?? 0;
}

export interface JevRequest {
  model: string;
  state: unknown;
  questions: Questions;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, Answer>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    input_tokens?: number;
  };
  providerMetadata?: Record<string, unknown>;
}

/* ============================================================
   应用层
   ============================================================ */

/**
 * 后端标识。
 *
 * 注意 localproxy 与 openrouterproxy 是**同构的两套服务端代理** ——
 * 它们不是「某个提供商」，而是「本站代为调用的免费额度」。
 * 界面上显示为「免费试用」与「免费试用 2」，不暴露背后的提供商。
 */
export type BackendId =
  | "localproxy"
  | "openrouterproxy"
  | "vercel"
  | "typesafe"
  | "openrouter"
  | "lmstudio";

export interface BackendConfig {
  label: string;
  base: string;
  model: string;
  note: string;
  verified: boolean;
  /** 是否需要用户在浏览器中输入密钥（代理模式不需要） */
  needsKey: boolean;
}

export type Strategy = "greedy" | "sample" | "threshold";

/** 一回合记录：既供置信度图表采样，也供日志面板回看完整请求 */
/** 棋盘尺寸的快照，供日志与存档记录 */
export interface BoardDims {
  cols: number;
  rows: number;
}

export interface TurnLog {
  turn: number;
  move: Direction;
  /** 该回合分布的最高概率 */
  top: number;
  /** 该回合分布的最低概率 */
  bottom: number;
  /** 该回合分布的中位概率 */
  median: number;
  /** 该回合模型自报的 confidence（分布集中度） */
  confidence: number;
  latencyMs: number;
  tokens: number;
  /** 决策依据的可读描述 */
  reason: string;
  /** 是否发生了「首选非法 → 取次优合法」的纠正 */
  coerced: boolean;
  /** 最高概率是否低于用户设定的置信度门槛 */
  belowThreshold: boolean | undefined;
  /** 是否因 API 失败而未能取得模型决策 */
  failed: boolean;
  /** 实际发送的请求体（日志面板用，保留原始信息） */
  request: unknown;
  /** 原始响应 */
  response: unknown;
  /** 请求发起时的 ISO 时间戳 */
  at: string;
}

/** 记忆条目：一条「当时的棋盘 + 当时的操作」 */
export interface MemoryEntry {
  turn: number;
  board: Grid;
  move: Direction;
  score: number;
}

/** 一次评估调用的完整往返记录 */
export interface CallRecord {
  turn: number;
  at: string;
  latencyMs: number;
  tokens: number;
  ok: boolean;
  error?: string;
  request: unknown;
  response: unknown;
}
