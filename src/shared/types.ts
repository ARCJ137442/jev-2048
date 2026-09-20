/**
 * 前后端共享的类型定义。
 *
 * 这里的 Jev 协议类型全部来自实测，与部分公开文档不一致的地方已标注。
 */

/* ============================================================
   棋盘
   ============================================================ */

/**
 * 棋盘边长。**可变** —— 通过 setBoardSize() 在开局前设置。
 *
 * 注意：这是 ESM 的 live binding，各模块 `import { SIZE }` 后读到的是最新值。
 * 但**不要**在模块顶层写 `const n = SIZE` 之类的快照，那样会固化。
 */
export let SIZE = 4;

export const BOARD_SIZES = [3, 4, 5, 6, 7, 8] as const;
export const MIN_BOARD = 3;
export const MAX_BOARD = 8;

export function setBoardSize(n: number): void {
  const v = Math.round(n);
  if (!Number.isFinite(v) || v < MIN_BOARD || v > MAX_BOARD) {
    throw new Error(`棋盘边长需在 ${MIN_BOARD}–${MAX_BOARD} 之间，收到 ${n}`);
  }
  SIZE = v;
}

/** 是否为 2 的幂次。1 也算（2^0），用于「随机生成值」的合法性和取值。 */
export function isPowerOfTwo(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && (v & (v - 1)) === 0;
}

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
 * 注意：公开文档里叫 "noul"，但 API 层实际接受的是 "boolean"。
 * 实测错误信息：Expected 'boolean' | 'choice' | 'score'
 */
export type QuestionType = "boolean" | "choice" | "score";

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

export interface BooleanAnswer {
  type: "boolean";
  probability: number;
  /** boolean 类型没有 confidence 字段 */
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = ChoiceAnswer | BooleanAnswer | ScoreAnswer;

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

export type BackendId = "localproxy" | "vercel" | "typesafe" | "openrouter" | "lmstudio";

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
