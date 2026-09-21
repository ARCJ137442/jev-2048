/**
 * 2048 游戏引擎 —— **全部纯函数**，不触碰 DOM，也不修改入参。
 *
 * ⚠ 纯度是硬约束，不是风格偏好。
 * `validMoves()` 的实现是「对每个方向试着走一步，看是否发生移动」——
 * 如果 moveTiles 会原地修改传入的 tile，那么每次询问合法方向都会
 * **真的把棋盘搅乱一次**。行为表现就是「某些方向走起来行列对不上」。
 *
 * 因此 moveTiles 内部一律先克隆，返回全新的 tile 对象
 * （id 会被保留，所以渲染层仍能按 id 追踪同一块方块的位移动画）。
 *
 * 棋盘为**矩形**：宽 COLS、高 ROWS，两者独立可配。
 */
import {
  COLS,
  ROWS,
  SPAWN_MIN_LIMIT,
  SPAWN_MAX_LIMIT,
  type Direction,
  type Grid,
  type SpawnDist,
  type Tile,
} from "../shared/types.js";

let tileSeq = 0;

export function makeTile(value: number, row: number, col: number): Tile {
  return { id: ++tileSeq, value, row, col };
}

/** 供测试与重置用：让 id 从 0 重新计数 */
export function resetTileSeq(): void {
  tileSeq = 0;
}

/**
 * 把 id 计数器顶到 n 之上。
 *
 * 从 localStorage 还原对局时必须调用 —— 否则新生成的方块会与还原出来的方块
 * **id 撞车**，而渲染层是按 id 追踪方块的，撞车会导致串位或闪跳。
 */
export function ensureTileSeqAbove(n: number): void {
  if (Number.isFinite(n) && n > tileSeq) tileSeq = Math.floor(n);
}

export interface MoveResult {
  tiles: Tile[];
  score: number;
  moved: boolean;
  /** 因合并而消失的方块（渲染层把它们滑到目标格后淡出） */
  dying: Tile[];
}

/**
 * 对 tile 列表执行一次移动。**纯函数：不修改 tiles 中的任何对象。**
 *
 * 所有方向统一处理：按行进方向取出该线（行或列）的 tile 序列 →
 * 压实并合并 → 写回新位置。行与列的独立处理天然支持矩形棋盘。
 */
export function moveTiles(tiles: Tile[], dir: Direction): MoveResult {
  const horizontal = dir === "left" || dir === "right";
  const forward = dir === "left" || dir === "up";
  const cols = COLS;
  const rows = ROWS;

  // 关键：先克隆，后续所有修改都作用在副本上
  const grid: (Tile | null)[][] = Array.from({ length: rows }, () =>
    Array<Tile | null>(cols).fill(null),
  );
  for (const t of tiles) grid[t.row][t.col] = { ...t };

  const next: Tile[] = [];
  const dying: Tile[] = [];
  let score = 0;
  let moved = false;

  // 水平方向逐行处理，垂直方向逐列处理
  const lines = horizontal ? rows : cols;
  const span = horizontal ? cols : rows;

  for (let line = 0; line < lines; line++) {
    const seq: Tile[] = [];
    for (let i = 0; i < span; i++) {
      const r = horizontal ? line : i;
      const c = horizontal ? i : line;
      const t = grid[r][c];
      if (t) seq.push(t);
    }
    if (!forward) seq.reverse();

    interface Slot {
      a: Tile;
      b?: Tile;
      value: number;
    }
    const slots: Slot[] = [];
    let k = 0;
    while (k < seq.length) {
      if (k + 1 < seq.length && seq[k].value === seq[k + 1].value) {
        slots.push({ a: seq[k], b: seq[k + 1], value: seq[k].value * 2 });
        k += 2;
      } else {
        slots.push({ a: seq[k], value: seq[k].value });
        k += 1;
      }
    }

    slots.forEach((slot, idx) => {
      const pos = forward ? idx : span - 1 - idx;
      const r = horizontal ? line : pos;
      const c = horizontal ? pos : line;

      if (slot.b) {
        score += slot.value;
        moved = true;
        for (const src of [slot.a, slot.b]) {
          dying.push({ ...src, row: r, col: c, dying: true });
        }
        next.push({ id: ++tileSeq, value: slot.value, row: r, col: c, isMerged: true });
      } else {
        const t = slot.a;
        if (t.row !== r || t.col !== c) moved = true;
        next.push({ ...t, row: r, col: c, isMerged: false });
      }
    });
  }

  return { tiles: next, score, moved, dying };
}

export function emptyCells(tiles: Tile[]): Array<{ row: number; col: number }> {
  const used = new Set(tiles.map((t) => t.row * COLS + t.col));
  const out: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < ROWS * COLS; i++) {
    if (!used.has(i)) out.push({ row: Math.floor(i / COLS), col: i % COLS });
  }
  return out;
}

/* ---------- 生成区间 ---------- */

/** 区间内可用的 2 的幂次（按值升序） */
export function spawnCandidates(minV: number, maxV: number): number[] {
  const lo = Math.max(minV, SPAWN_MIN_LIMIT);
  const hi = Math.min(maxV, SPAWN_MAX_LIMIT);
  const out: number[] = [];
  for (let v = SPAWN_MIN_LIMIT; v <= hi; v *= 2) {
    if (v >= lo) out.push(v);
  }
  return out;
}

/**
 * 在 [minV, maxV] 内抽取一个生成值。
 *
 *   uniform   等概率
 *   weighted  权重为值的**倒数** —— 越大的值越罕见。
 *             例如 2 与 4：P(2)=2/3、P(4)=1/3
 */
export function pickSpawnValue(
  minV: number,
  maxV: number,
  dist: SpawnDist = "uniform",
  rand: () => number = Math.random,
): number {
  const cands = spawnCandidates(minV, maxV);
  if (cands.length === 0) return SPAWN_MIN_LIMIT;
  if (cands.length === 1) return cands[0];

  if (dist === "weighted") {
    const weights = cands.map((v) => 1 / v);
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rand() * total;
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  return cands[Math.floor(rand() * cands.length)];
}

/** 在随机空位生成新方块 */
export function spawnTile(
  tiles: Tile[],
  minV = 2,
  maxV = 4,
  dist: SpawnDist = "uniform",
): Tile | null {
  const cells = emptyCells(tiles);
  if (cells.length === 0) return null;
  const c = cells[Math.floor(Math.random() * cells.length)];
  const t = makeTile(pickSpawnValue(minV, maxV, dist), c.row, c.col);
  t.isNew = true;
  return t;
}

export function validMoves(tiles: Tile[]): Direction[] {
  const all: Direction[] = ["up", "down", "left", "right"];
  return all.filter((d) => moveTiles(tiles, d).moved);
}

export function isGameOver(tiles: Tile[]): boolean {
  return validMoves(tiles).length === 0;
}

export function maxTile(tiles: Tile[]): number {
  return tiles.reduce((m, t) => Math.max(m, t.value), 0);
}

/** 派生二维数字网格（发给 Jev 的 state、启发式评估都用它） */
export function toGrid(tiles: Tile[]): Grid {
  const g: Grid = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0));
  for (const t of tiles) g[t.row][t.col] = t.value;
  return g;
}

export function cloneTiles(tiles: Tile[]): Tile[] {
  return tiles.map((t) => ({ ...t }));
}
