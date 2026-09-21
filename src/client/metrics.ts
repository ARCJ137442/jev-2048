/**
 * 棋盘特征计算。
 *
 * 注意：这些函数**只用于描述局面**（写进发给 Jev 的 state.features），
 * 不参与任何决策。本 Demo 不做启发式决策 —— 阈值由用户看着置信度图自己调。
 *
 * 棋盘为矩形（COLS × ROWS），所有遍历都要分别取宽高。
 */
import { COLS, ROWS, type Grid, type Tile } from "../shared/types.js";

export function countEmpty(grid: Grid): number {
  let n = 0;
  for (const row of grid) for (const v of row) if (v === 0) n++;
  return n;
}

/**
 * 单调性：行/列上数值越单调，返回值越接近 0（越整齐）。
 * 取每行/列两个方向中较小者累加，恒为非正数，绝对值越大越乱。
 */
export function monotonicity(grid: Grid): number {
  const l2 = (v: number): number => Math.log2(Math.max(v, 1));
  let total = 0;

  // 横向：逐行
  for (let r = 0; r < ROWS; r++) {
    let inc = 0;
    let dec = 0;
    for (let c = 0; c + 1 < COLS; c++) {
      const a = l2(grid[r][c]);
      const b = l2(grid[r][c + 1]);
      if (a > b) dec += b - a;
      else inc += a - b;
    }
    total += Math.max(inc, dec);
  }

  // 纵向：逐列
  for (let c = 0; c < COLS; c++) {
    let inc = 0;
    let dec = 0;
    for (let r = 0; r + 1 < ROWS; r++) {
      const a = l2(grid[r][c]);
      const b = l2(grid[r + 1][c]);
      if (a > b) dec += b - a;
      else inc += a - b;
    }
    total += Math.max(inc, dec);
  }

  return total;
}

/** 最大方块是否位于四角之一 */
export function maxInCorner(grid: Grid): boolean {
  let mx = 0;
  let mr = 0;
  let mc = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] > mx) {
        mx = grid[r][c];
        mr = r;
        mc = c;
      }
    }
  }
  return (mr === 0 || mr === ROWS - 1) && (mc === 0 || mc === COLS - 1);
}

/**
 * 本手「方块划过的轨迹格子」。
 *
 * 不能用前后网格做 diff —— 一个方块从第 0 行滑到第 3 行时，中间第 1 行
 * 前后都是空的，diff 会认为它没变。但那一格确实是方块经过的轨迹。
 *
 * 所以这里按每个方块的**原位置 → 目标位置逐格标记**：
 *   - 存活且位移过的方块：标记整条路径（含起点与终点）
 *   - 合并产生的新方块、新生成的方块：标记其所在格
 *   - 被合并吃掉的方块：起点在 before、终点写在 dying 上，同样要标整条路径
 *
 * 结果是一个去重后的格子集合，正好覆盖这一手所有「有东西动过」的位置。
 */
export function trajectoryCells(
  before: Tile[],
  after: Tile[],
  dying: Tile[] = [],
): Array<{ row: number; col: number }> {
  const prev = new Map(before.map((t) => [t.id, t]));
  const seen = new Set<string>();

  const mark = (r: number, c: number): void => {
    seen.add(`${r},${c}`);
  };

  /** 从 (r0,c0) 逐格标记到 (r1,c1)，含两端 */
  const trace = (r0: number, c0: number, r1: number, c1: number): void => {
    mark(r0, c0);
    const dr = Math.sign(r1 - r0);
    const dc = Math.sign(c1 - c0);
    let r = r0;
    let c = c0;
    while (r !== r1 || c !== c1) {
      r += dr;
      c += dc;
      mark(r, c);
    }
  };

  // 存活的方块：起点在 before，终点在 after
  for (const t of after) {
    const p = prev.get(t.id);
    if (!p) {
      mark(t.row, t.col);
      continue;
    }
    if (p.row === t.row && p.col === t.col) continue;
    trace(p.row, p.col, t.row, t.col);
  }

  // 被合并吃掉的方块：终点是 moveTiles 写在 dying 上的目标格。
  // 这条路径不能省 —— 从远处滑过来参与合并的方块，轨迹同样要完整。
  for (const d of dying) {
    const p = prev.get(d.id);
    if (!p) {
      mark(d.row, d.col);
      continue;
    }
    trace(p.row, p.col, d.row, d.col);
  }

  return [...seen].map((s) => {
    const [r, c] = s.split(",");
    return { row: Number(r), col: Number(c) };
  });
}
