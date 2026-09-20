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

/** schema 版本。字段结构变更时递增 —— 旧档据此判定为不兼容。 */
export const SESSION_VERSION = 1;

export interface Session {
  /** schema 版本 */
  v: number;
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

/**
 * 读取结果。
 *
 * `incompatible` 与 `none` 必须区分开：前者意味着磁盘上**有**数据但读不懂，
 * 直接丢掉会让玩家损失一整局；正确做法是交给界面提示玩家
 * 「导出旧数据」还是「重置回默认」。
 */
export type LoadResult =
  | { status: "none" }
  | { status: "ok"; session: Session }
  | { status: "incompatible"; raw: string; reason: string };

let timer = 0;

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false; // 某些隐私模式下访问就会抛
  }
}

export function loadSession(): LoadResult {
  if (!canUseStorage()) return { status: "none" };

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { status: "none" };
  }
  if (!raw) return { status: "none" };

  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "incompatible", raw, reason: "存档内容不是一个对象" };
    }
    o = parsed as Record<string, unknown>;
  } catch {
    return { status: "incompatible", raw, reason: "存档不是合法 JSON（可能已损坏）" };
  }

  // 版本比当前新 —— 是「降级运行」，读下去可能丢字段，明确报不兼容
  const v = Number(o.v);
  if (Number.isFinite(v) && v > SESSION_VERSION) {
    return {
      status: "incompatible",
      raw,
      reason: `存档版本 v${v} 高于当前支持的 v${SESSION_VERSION}`,
    };
  }

  // 结构校验：核心字段缺一不可
  const bad = (why: string): LoadResult => ({ status: "incompatible", raw, reason: why });
  if (typeof o.size !== "number") return bad("存档缺少棋盘尺寸");
  if (!Array.isArray(o.tiles)) return bad("存档的方块列表已损坏");
  if (typeof o.score !== "number") return bad("存档缺少分数");
  if (typeof o.turn !== "number") return bad("存档缺少轮次");

  const tiles = (o.tiles as Tile[]).filter(
    (t) =>
      t &&
      typeof t.id === "number" &&
      typeof t.value === "number" &&
      typeof t.row === "number" &&
      typeof t.col === "number",
  );
  if (tiles.length !== (o.tiles as Tile[]).length) {
    return bad("存档里有结构不完整的方块");
  }

  return {
    status: "ok",
    session: {
      v: Number.isFinite(v) ? v : 0,
      size: o.size,
      tiles,
      score: o.score,
      turn: o.turn,
      memory: Array.isArray(o.memory) ? (o.memory as MemoryEntry[]) : [],
      history: Array.isArray(o.history) ? (o.history as TurnLog[]) : [],
      finished: Boolean(o.finished),
      savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    },
  };
}

/**
 * 待写入的对局。`v` 与 `savedAt` 由存储层自己填 —— 版本号是存储的实现细节，
 * 让每个调用方都记得写一遍迟早会漏。
 */
export type SessionInput = Omit<Session, "savedAt" | "v">;

/** 立即写入，不防抖。用于「重开」「结束」这类必须落盘的时点。 */
export function saveSessionNow(s: SessionInput): void {
  if (!canUseStorage()) return;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  const payload: Session = {
    ...s,
    v: SESSION_VERSION,
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
export function saveSession(s: SessionInput): void {
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

/**
 * 强行加载：从读不懂的数据里**尽力**抢救出可用部分。
 *
 * 与 loadSession() 的区别是「谁承担风险」：
 *   loadSession  严格校验，不合格就报不兼容，风险由应用承担
 *   forceLoad    只做最低限度的检查，能救多少救多少，风险由用户承担
 *
 * 场景：用户从旧版本升级上来，存档结构变了。严格模式下整局作废，
 * 但往往棋盘和分数这些核心字段结构没变 —— 强行加载能留住这部分。
 *
 * 只做必要检查：方块结构必须可用（否则没有可续玩的局面），
 * 其余字段缺失就用默认值补齐。
 */
export function forceLoadSession(raw: string): { session: Session; salvaged: string[] } | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;   // 连 JSON 都不是，无药可救
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;

  const r = o as Record<string, unknown>;
  const salvaged: string[] = [];

  // 方块：唯一不可缺的字段，但允许丢弃个别结构坏掉的
  const rawTiles = Array.isArray(r.tiles) ? (r.tiles as unknown[]) : [];
  const tiles = rawTiles.filter(
    (t): t is Tile =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as Tile).id === "number" &&
      typeof (t as Tile).value === "number" &&
      typeof (t as Tile).row === "number" &&
      typeof (t as Tile).col === "number",
  );
  if (tiles.length === 0) return null;         // 没有方块就没有可续玩的局面
  if (tiles.length !== rawTiles.length) {
    salvaged.push(`方块 ${rawTiles.length - tiles.length} 个损坏已丢弃`);
  }

  const num = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  const size = num(r.size, 4);
  const score = num(r.score, 0);
  const turn = num(r.turn, 0);

  if (!Number.isFinite(Number(r.size))) salvaged.push("棋盘尺寸已用默认值 4");
  if (!Number.isFinite(Number(r.score))) salvaged.push("分数已归零");
  if (!Number.isFinite(Number(r.turn))) salvaged.push("轮次已归零");

  const memory = Array.isArray(r.memory) ? (r.memory as MemoryEntry[]) : [];
  const history = Array.isArray(r.history) ? (r.history as TurnLog[]) : [];
  if (!Array.isArray(r.memory)) salvaged.push("记忆已清空");
  if (!Array.isArray(r.history)) salvaged.push("调用日志已清空");

  return {
    session: {
      v: SESSION_VERSION,
      size,
      tiles,
      score,
      turn,
      memory,
      history,
      finished: false,
      savedAt: "",
    },
    salvaged,
  };
}

/** 把强行加载的结果写回存储，之后就能正常读写了 */
export function commitForced(s: Session): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, savedAt: new Date().toISOString() }));
  } catch {
    /* 配额满就放弃，不影响本次会话 */
  }
}

/** 直接读出原始字符串，用于「导出旧的不兼容数据」 */
export function rawSession(): string | null {
  if (!canUseStorage()) return null;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
