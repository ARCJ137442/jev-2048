/**
 * 对局持久化。
 *
 * 刷新页面不该丢掉正在跑的一局 —— 尤其本 Demo 的定位是「测量 Jev」，
 * 跑一局几十手，刷新即清零等于白跑。
 *
 * 写入是**防抖**的：每手都存一次全量 JSON 会拖慢决策循环，
 * 而 300ms 的延迟对人来说无感，对浏览器足够友好。
 *
 * 与 config.ts 的分工：
 *   config  → 长期设置（棋盘、策略、阈值、历史最高分）
 *   session → 当前这一局（棋盘、分数、轮次、记忆、调用日志）
 */
import type { MemoryEntry, Tile, TurnLog } from "../shared/types.js";

const KEY = "jev2048.session.v1";
const SAVE_DEBOUNCE_MS = 300;
/** 持久化的日志条数上限。每条含完整请求/响应，太多会撑爆 localStorage 配额。 */
const MAX_PERSISTED_HISTORY = 150;

export interface Session {
  /** 存档时的棋盘边长。与当前设置不一致时整局作废。 */
  size: number;
  tiles: Tile[];
  score: number;
  turn: number;
  memory: MemoryEntry[];
  history: TurnLog[];
  /** 该局是否已结束（结束后刷新不该"续玩"） */
  finished: boolean;
  savedAt: string;
}

let timer = 0;

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false; // 某些隐私模式下访问就会抛
  }
}

export function loadSession(): Session | null {
  if (!canUseStorage()) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const s = JSON.parse(raw) as Partial<Session>;
    if (
      !s ||
      typeof s.size !== "number" ||
      !Array.isArray(s.tiles) ||
      typeof s.score !== "number" ||
      typeof s.turn !== "number"
    ) {
      return null;
    }
    return {
      size: s.size,
      tiles: s.tiles as Tile[],
      score: s.score,
      turn: s.turn,
      memory: Array.isArray(s.memory) ? (s.memory as MemoryEntry[]) : [],
      history: Array.isArray(s.history) ? (s.history as TurnLog[]) : [],
      finished: Boolean(s.finished),
      savedAt: typeof s.savedAt === "string" ? s.savedAt : "",
    };
  } catch {
    // 存档损坏（版本变更、手改过）—— 丢掉即可，不影响使用
    return null;
  }
}

/** 立即写入，不防抖。用于「重开」「结束」这类必须落盘的时点。 */
export function saveSessionNow(s: Omit<Session, "savedAt">): void {
  if (!canUseStorage()) return;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  const payload: Session = {
    ...s,
    history: s.history.slice(-MAX_PERSISTED_HISTORY),
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 配额满：丢弃最旧的日志再试一次，仍失败就放弃（不影响游戏）
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ ...payload, history: payload.history.slice(-30) }),
      );
    } catch {
      /* 静默降级 */
    }
  }
}

/** 防抖写入。每手结束时调用。 */
export function saveSession(s: Omit<Session, "savedAt">): void {
  if (!canUseStorage()) return;
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    saveSessionNow(s);
  }, SAVE_DEBOUNCE_MS);
}

export function clearSession(): void {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** 存档里出现过的最大 tile id —— 还原后要用它把引擎的计数器顶上去 */
export function maxTileId(tiles: Tile[]): number {
  return tiles.reduce((m, t) => (typeof t.id === "number" && t.id > m ? t.id : m), 0);
}
