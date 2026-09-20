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
 * 设计：tile 列表模型（而非二维数组），因为方块需要稳定 id 才能做过渡动画。
 * 二维数组只在展示 / 发送给模型时由 toGrid() 派生。
 */
import { SIZE, type Direction, type Grid, type Tile } from "../shared/types.js";

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
 * 所有方向统一处理：按行进方向取出该线的 tile 序列 → 压实并合并 → 写回新位置。
 */
export function moveTiles(tiles: Tile[], dir: Direction): MoveResult {
  const n = SIZE;

  // 关键：先克隆，后续所有修改都作用在副本上
  const grid: (Tile | null)[][] = Array.from({ length: n }, () =>
    Array<Tile | null>(n).fill(null),
  );
  for (const t of tiles) grid[t.row][t.col] = { ...t };

  const horizontal = dir === "left" || dir === "right";
  const forward = dir === "left" || dir === "up";

  const next: Tile[] = [];
  const dying: Tile[] = [];
  let score = 0;
  let moved = false;

  for (let line = 0; line < n; line++) {
    const seq: Tile[] = [];
    for (let i = 0; i < n; i++) {
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
      const pos = forward ? idx : n - 1 - idx;
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
  const used = new Set(tiles.map((t) => t.row * SIZE + t.col));
  const out: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!used.has(i)) out.push({ row: Math.floor(i / SIZE), col: i % SIZE });
  }
  return out;
}

/* ---------- 生成区间 ---------- */

/** 是否为 2 的幂次（1 也算，即 2^0） */
export function isPowerOfTwo(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && (v & (v - 1)) === 0;
}

/**
 * 在 [minV, maxV] 内均匀抽取一个 2 的幂次。
 * 抽的是**指数**均匀，例如 2–8 对应指数 1..3，三个值各 1/3。
 * maxV 为 null 时视作与 minV 相同。
 */
export function pickSpawnValue(minV: number, maxV: number | null): number {
  const lo = Math.round(Math.log2(Math.max(1, minV)));
  const hi = maxV === null ? lo : Math.round(Math.log2(Math.max(1, maxV)));
  if (hi <= lo) return Math.pow(2, lo);
  const e = lo + Math.floor(Math.random() * (hi - lo + 1));
  return Math.pow(2, e);
}

/** 在随机空位生成新方块，取值来自配置区间 */
export function spawnTile(tiles: Tile[], minV = 2, maxV: number | null = null): Tile | null {
  const cells = emptyCells(tiles);
  if (cells.length === 0) return null;
  const c = cells[Math.floor(Math.random() * cells.length)];
  const t = makeTile(pickSpawnValue(minV, maxV), c.row, c.col);
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
  const g: Grid = Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));
  for (const t of tiles) g[t.row][t.col] = t.value;
  return g;
}

export function cloneTiles(tiles: Tile[]): Tile[] {
  return tiles.map((t) => ({ ...t }));
}
