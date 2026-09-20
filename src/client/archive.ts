/**
 * 存档导入导出。
 *
 * 四类内容各自独立成档：
 *   game      对局 + 游戏设置 + 历史最高分/最大瓷砖
 *   strategy  上下文文本 + 规则（策略、阈值、记忆）
 *   api       API 的非敏感设置（重试）。**密钥从不参与**
 *   log       调用日志，只导出不导入
 *
 * 每份档案都带 `v`（schema 版本）与 `kind`。导入时逐项校验，
 * 不匹配就明确报错而不是半途写坏状态。
 */
import type { TurnLog } from "../shared/types.js";
import {
  DEFAULT_API,
  DEFAULT_CONTEXT,
  DEFAULT_GAME,
  type ApiSettings,
  type ContextSettings,
  type GameSettings,
  type Persisted,
} from "./config.js";
import type { SessionInput } from "./session.js";

/** 档案格式版本。字段结构变更时递增，用于识别不兼容的旧档。 */
export const ARCHIVE_VERSION = 1;

export type ArchiveKind = "game" | "strategy" | "api" | "log" | "all";

export interface Archive {
  app: "jev2048";
  v: number;
  kind: ArchiveKind;
  exportedAt: string;
  /** 导出时的应用信息，便于人工辨认 */
  meta?: { boardSize?: number; turn?: number; score?: number };
  payload: unknown;
}

/* ══════════════ 导出 ══════════════ */

export interface GamePayload {
  game: GameSettings;
  session: SessionInput | null;
  highScores: Record<string, number>;
  bestTiles: Record<string, number>;
}

export interface StrategyPayload {
  context: ContextSettings;
  game: Pick<GameSettings, "strategy" | "threshold" | "memory">;
}

export interface ApiPayload {
  api: ApiSettings;
}

export interface LogPayload {
  history: TurnLog[];
}

export function buildArchive(
  kind: ArchiveKind,
  store: Persisted,
  session: SessionInput | null,
  history: TurnLog[],
): Archive {
  const base = { app: "jev2048" as const, v: ARCHIVE_VERSION, exportedAt: new Date().toISOString() };

  switch (kind) {
    case "game":
      return {
        ...base,
        kind,
        meta: { boardSize: store.game.boardSize, turn: session?.turn ?? 0, score: session?.score ?? 0 },
        payload: {
          game: store.game,
          session,
          highScores: store.highScores,
          bestTiles: store.bestTiles,
        } satisfies GamePayload,
      };

    case "strategy":
      return {
        ...base,
        kind,
        payload: {
          context: store.context,
          game: {
            strategy: store.game.strategy,
            threshold: store.game.threshold,
            memory: store.game.memory,
          },
        } satisfies StrategyPayload,
      };

    case "api":
      return { ...base, kind, payload: { api: store.api } satisfies ApiPayload };

    case "log":
      return { ...base, kind, payload: { history } satisfies LogPayload };

    case "all":
      return {
        ...base,
        kind,
        meta: { boardSize: store.game.boardSize, turn: session?.turn ?? 0, score: session?.score ?? 0 },
        payload: {
          game: store.game,
          context: store.context,
          api: store.api,
          session,
          highScores: store.highScores,
          bestTiles: store.bestTiles,
          history,
        },
      };
  }
}

/** 触发浏览器下载。文件名带时间戳，便于多次导出后区分。 */
export function download(archive: Archive, label: string): void {
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

  const blob = new Blob([JSON.stringify(archive, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jev2048-${label}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 交给浏览器读完再回收，立即 revoke 在部分浏览器上会截断下载
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 把任意 JSON 文本下载下来（用于「导出旧的不兼容数据」） */
export function downloadRaw(text: string, label: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jev2048-${label}-raw.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ══════════════ 导入 ══════════════ */

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 解析并校验一份档案。
 *
 * 校验刻意做得严格：宁可明确报错让用户重新导出，也不要把结构不对的数据
 * 悄悄写进状态 —— 那会产出更难排查的问题。
 */
export function parseArchive(text: string): Archive {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new ArchiveError("不是合法的 JSON 文件");
  }
  if (!isObj(o)) throw new ArchiveError("档案内容不是一个对象");
  if (o.app !== "jev2048") throw new ArchiveError("这不像是本应用的存档（缺少 app 标记）");

  const v = Number(o.v);
  if (!Number.isFinite(v)) throw new ArchiveError("档案缺少版本号");
  if (v > ARCHIVE_VERSION) {
    throw new ArchiveError(
      `档案版本 v${v} 高于当前支持的 v${ARCHIVE_VERSION}，请升级应用后再导入`,
    );
  }

  const kinds: ArchiveKind[] = ["game", "strategy", "api", "log", "all"];
  if (!kinds.includes(o.kind as ArchiveKind)) {
    throw new ArchiveError(`未知的档案类型：${String(o.kind)}`);
  }
  if (!("payload" in o) || !isObj(o.payload)) {
    throw new ArchiveError("档案缺少 payload");
  }

  return o as unknown as Archive;
}

export interface ImportResult {
  game?: GameSettings;
  context?: ContextSettings;
  api?: ApiSettings;
  session?: SessionInput | null;
  highScores?: Record<string, number>;
  bestTiles?: Record<string, number>;
  /** 是否携带了历史最高分等累计数据 */
  hasScores: boolean;
  /** 该档案属于哪一类 */
  kind: ArchiveKind;
}

/** 把档案里的字段取出来并做类型兜底，交给调用方决定如何应用 */
export function extract(archive: Archive): ImportResult {
  const p = archive.payload as Record<string, unknown>;
  const out: ImportResult = { kind: archive.kind, hasScores: false };

  const asGame = (v: unknown): GameSettings | undefined =>
    isObj(v) ? { ...DEFAULT_GAME, ...(v as Partial<GameSettings>) } : undefined;
  const asContext = (v: unknown): ContextSettings | undefined =>
    isObj(v) ? { ...DEFAULT_CONTEXT, ...(v as Partial<ContextSettings>) } : undefined;
  const asApi = (v: unknown): ApiSettings | undefined =>
    isObj(v) ? { ...DEFAULT_API, ...(v as Partial<ApiSettings>) } : undefined;
  const asScores = (v: unknown): Record<string, number> | undefined =>
    isObj(v) ? (v as Record<string, number>) : undefined;

  if (archive.kind === "all") {
    out.game = asGame(p.game);
    out.context = asContext(p.context);
    out.api = asApi(p.api);
    out.session = (p.session as SessionInput | null) ?? null;
    out.highScores = asScores(p.highScores);
    out.bestTiles = asScores(p.bestTiles);
    out.hasScores = Boolean(out.highScores || out.bestTiles);
    return out;
  }

  if (archive.kind === "game") {
    out.game = asGame(p.game);
    out.session = (p.session as SessionInput | null) ?? null;
    out.highScores = asScores(p.highScores);
    out.bestTiles = asScores(p.bestTiles);
    out.hasScores = Boolean(out.highScores || out.bestTiles);
    return out;
  }

  if (archive.kind === "strategy") {
    out.context = asContext(p.context);
    // 策略档里的 game 只含 strategy/threshold/memory，合并时不要冲掉棋盘等设置
    if (isObj(p.game)) {
      const g = p.game as Partial<GameSettings>;
      out.game = {
        ...DEFAULT_GAME,
        ...(typeof g.strategy === "string" ? { strategy: g.strategy } : {}),
        ...(typeof g.threshold === "number" ? { threshold: g.threshold } : {}),
        ...("memory" in g ? { memory: g.memory as number | null } : {}),
      };
    }
    return out;
  }

  if (archive.kind === "api") {
    out.api = asApi(p.api);
    return out;
  }

  // log：只导出，导入时明确拒绝
  throw new ArchiveError("日志档案不支持导入");
}

/** 读取用户选中的文件 */
export function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(new ArchiveError("读取文件失败"));
    fr.readAsText(file);
  });
}
