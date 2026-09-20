/**
 * 2048 引擎单元测试。
 *
 * 重点覆盖两类问题：
 *  1. 规则正确性 —— 四个方向的合并、计分、边界
 *  2. **纯度** —— moveTiles / validMoves / isGameOver 绝不修改入参
 *
 * 第 2 类是曾经真实出过的 bug：validMoves 用「对每个方向试走一步」实现，
 * 而 moveTiles 当时会原地改 tile，于是每次询问合法方向都把棋盘搅乱一次，
 * 表现为「某些方向走起来行列对不上」。用 makeTile 造新对象的测试覆盖不到它。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { setBoardSize, SIZE, type Direction, type Grid, type Tile } from "../shared/types.js";
import {
  makeTile,
  moveTiles,
  toGrid,
  validMoves,
  isGameOver,
  spawnTile,
  pickSpawnValue,
  isPowerOfTwo,
  emptyCells,
  maxTile,
} from "../client/engine.js";
import { trajectoryCells } from "../client/metrics.js";

/* ══════════════ 工具 ══════════════ */

function gridToTiles(g: Grid): Tile[] {
  const out: Tile[] = [];
  for (let r = 0; r < g.length; r++) {
    for (let c = 0; c < g.length; c++) {
      if (g[r][c]) out.push(makeTile(g[r][c], r, c));
    }
  }
  return out;
}

function moved(g: Grid, d: Direction): Grid {
  return toGrid(moveTiles(gridToTiles(g), d).tiles);
}

/**
 * 与 engine 无共享代码的参考实现：直接在行列上压实。
 * 用「从行进方向的末端往回读」的写法，与 engine 的「反向序列」写法思路不同，
 * 避免同一个思维错误在两处同时出现。
 */
function reference(g: Grid, d: Direction): Grid {
  const n = g.length;
  const out = g.map((r) => [...r]);

  const pack = (arr: number[]): number[] => {
    const xs = arr.filter((v) => v !== 0);
    const res: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      if (i + 1 < xs.length && xs[i] === xs[i + 1]) {
        res.push(xs[i] * 2);
        i++;
      } else {
        res.push(xs[i]);
      }
    }
    while (res.length < n) res.push(0);
    return res;
  };

  if (d === "left") {
    for (let r = 0; r < n; r++) out[r] = pack(out[r]);
  } else if (d === "right") {
    for (let r = 0; r < n; r++) out[r] = pack([...out[r]].reverse()).reverse();
  } else if (d === "up") {
    for (let c = 0; c < n; c++) {
      const col = pack(Array.from({ length: n }, (_, r) => out[r][c]));
      for (let r = 0; r < n; r++) out[r][c] = col[r];
    }
  } else {
    for (let c = 0; c < n; c++) {
      const col = pack(Array.from({ length: n }, (_, r) => out[r][c]).reverse()).reverse();
      for (let r = 0; r < n; r++) out[r][c] = col[r];
    }
  }
  return out;
}

/* ══════════════ 1. 纯度（回归测试）══════════════ */

test("moveTiles 不修改传入的 tile 对象", () => {
  setBoardSize(4);
  const tiles = gridToTiles([
    [2, 2, 0, 0],
    [4, 0, 4, 0],
    [0, 0, 0, 8],
    [0, 2, 0, 0],
  ]);
  const before = JSON.stringify(tiles);

  for (const d of ["up", "down", "left", "right"] as Direction[]) {
    moveTiles(tiles, d);
    assert.equal(JSON.stringify(tiles), before, `moveTiles(${d}) 修改了入参`);
  }
});

test("validMoves 不修改传入的 tile 对象（回归：曾导致棋盘被搅乱）", () => {
  setBoardSize(4);
  const tiles = gridToTiles([
    [2, 0, 4, 0],
    [0, 4, 0, 2],
    [8, 0, 2, 0],
    [0, 2, 0, 4],
  ]);
  const before = JSON.stringify(tiles);

  const moves = validMoves(tiles);

  assert.equal(JSON.stringify(tiles), before, "validMoves 修改了入参");
  assert.ok(moves.length > 0);
});

test("isGameOver 不修改传入的 tile 对象", () => {
  setBoardSize(3);
  const tiles = gridToTiles([
    [2, 4, 8],
    [4, 8, 16],
    [8, 16, 32],
  ]);
  const before = JSON.stringify(tiles);
  isGameOver(tiles);
  assert.equal(JSON.stringify(tiles), before);
});

test("连续调用 validMoves 结果稳定（棋盘不会被逐步搅乱）", () => {
  setBoardSize(4);
  const tiles = gridToTiles([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [0, 0, 0, 2],
  ]);

  const first = validMoves(tiles);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(validMoves(tiles), first, `第 ${i + 2} 次 validMoves 结果变了`);
  }
});

test("试算若干方向后再执行移动，结果与直接执行一致", () => {
  setBoardSize(4);
  const start: Grid = [
    [0, 0, 0, 2],
    [0, 0, 0, 4],
    [0, 2, 0, 8],
    [0, 4, 2, 16],
  ];

  // 模拟真实流程：先反复询问合法方向，再真的走一步
  const tiles = gridToTiles(start);
  for (let i = 0; i < 3; i++) validMoves(tiles);
  const got = toGrid(moveTiles(tiles, "down").tiles);

  const fresh = gridToTiles(start);
  const expected = toGrid(moveTiles(fresh, "down").tiles);

  assert.deepEqual(got, expected);
});

/* ══════════════ 2. 方向规则 ══════════════ */

test("down：整列向下压实，行列不串位", () => {
  setBoardSize(4);
  const got = moved(
    [
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [4, 0, 0, 0],
    ],
    "down",
  );
  assert.deepEqual(got, [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 0, 0, 0],
    [4, 0, 0, 0],
  ]);
});

test("down：每列独立处理，不会跨列", () => {
  setBoardSize(4);
  const got = moved(
    [
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    "down",
  );
  assert.deepEqual(got, [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 4, 8, 16],
  ]);
});

test("down：列内合并", () => {
  setBoardSize(4);
  const got = moved(
    [
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [4, 0, 0, 0],
      [4, 0, 0, 0],
    ],
    "down",
  );
  assert.deepEqual(got, [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [4, 0, 0, 0],
    [8, 0, 0, 0],
  ]);
});

test("up / left / right 基础规则", () => {
  setBoardSize(4);
  const g: Grid = [
    [2, 0, 0, 2],
    [0, 0, 0, 0],
    [4, 0, 4, 0],
    [0, 0, 0, 0],
  ];
  assert.deepEqual(moved(g, "left"), [
    [4, 0, 0, 0],
    [0, 0, 0, 0],
    [8, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(moved(g, "right"), [
    [0, 0, 0, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 8],
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(moved(g, "up"), [
    [2, 0, 4, 2],
    [4, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

/* ══════════════ 3. 合并规则细节 ══════════════ */

test("一行 2,2,2,2 向左合并成 4,4（不是 8）", () => {
  setBoardSize(4);
  const r = moveTiles(gridToTiles([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
  assert.deepEqual(toGrid(r.tiles), [
    [4, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

test("合并得分等于新方块数值之和", () => {
  setBoardSize(4);
  const r = moveTiles(gridToTiles([[2, 2, 4, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
  assert.equal(r.score, 4 + 8);
});

test("没有可合并时得分为 0", () => {
  setBoardSize(4);
  const r = moveTiles(gridToTiles([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
  assert.equal(r.score, 0);
  assert.equal(r.moved, false);
});

test("已贴边的移动判为未移动", () => {
  setBoardSize(4);
  const g: Grid = [
    [2, 4, 8, 16],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  assert.equal(moveTiles(gridToTiles(g), "left").moved, false);
  assert.equal(moveTiles(gridToTiles(g), "up").moved, false);
  assert.equal(moveTiles(gridToTiles(g), "down").moved, true);
});

test("合并产生的 dying 恰好是两个源方块，且都落在目标格", () => {
  setBoardSize(4);
  const r = moveTiles(gridToTiles([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
  assert.equal(r.dying.length, 2);
  for (const d of r.dying) {
    assert.equal(d.row, 0);
    assert.equal(d.col, 0);
  }
});

/* ══════════════ 4. 差分：与参考实现比对 ══════════════ */

test("差分测试：随机棋盘 × 全部方向 × 多种尺寸，与参考实现一致", () => {
  const dirs: Direction[] = ["up", "down", "left", "right"];
  let checked = 0;

  for (const n of [3, 4, 5, 6]) {
    setBoardSize(n);
    for (let trial = 0; trial < 400; trial++) {
      const g: Grid = Array.from({ length: n }, () =>
        Array.from({ length: n }, () =>
          Math.random() < 0.3 ? [2, 4, 8, 16, 32][Math.floor(Math.random() * 5)] : 0,
        ),
      );
      for (const d of dirs) {
        assert.deepEqual(moved(g, d), reference(g, d), `${n}×${n} dir=${d} 输入=${JSON.stringify(g)}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 6400, `比对次数过少：${checked}`);
});

/* ══════════════ 4b. 轴对齐：动画不得出现跨轴位移 ══════════════ */

test("上下移动时，任何方块都不得改变列号（动画不会有左右分量）", () => {
  const dirs: Direction[] = ["up", "down"];
  for (const n of [3, 4, 5, 6]) {
    setBoardSize(n);
    for (let trial = 0; trial < 300; trial++) {
      const g: Grid = Array.from({ length: n }, () =>
        Array.from({ length: n }, () =>
          Math.random() < 0.35 ? [2, 4, 8, 16][Math.floor(Math.random() * 4)] : 0,
        ),
      );
      const src = gridToTiles(g);
      const byId = new Map(src.map((t) => [t.id, t]));

      for (const d of dirs) {
        const r = moveTiles(src, d);
        // 存活方块：列号不变，只有行号可变
        for (const t of r.tiles) {
          const origin = byId.get(t.id);
          if (!origin) continue; // 合并产生的新方块，无来源
          assert.equal(t.col, origin.col, `${n}×${n} dir=${d} 方块列号被改变`);
        }
        // 合并消失的方块：滑向目标格也必须同列
        for (const t of r.dying) {
          const origin = byId.get(t.id);
          assert.ok(origin);
          assert.equal(t.col, origin.col, `${n}×${n} dir=${d} 合并源列号被改变`);
        }
        // 合并产生的新方块，必须落在某个源方块所在的列上
        const cols = new Set(src.map((t) => t.col));
        for (const t of r.tiles) {
          if (!byId.has(t.id)) {
            assert.ok(cols.has(t.col), `${n}×${n} dir=${d} 合并产物落在非法列`);
          }
        }
      }
    }
  }
  setBoardSize(4);
});

test("左右移动时，任何方块都不得改变行号（动画不会有上下分量）", () => {
  const dirs: Direction[] = ["left", "right"];
  for (const n of [3, 4, 5, 6]) {
    setBoardSize(n);
    for (let trial = 0; trial < 300; trial++) {
      const g: Grid = Array.from({ length: n }, () =>
        Array.from({ length: n }, () =>
          Math.random() < 0.35 ? [2, 4, 8, 16][Math.floor(Math.random() * 4)] : 0,
        ),
      );
      const src = gridToTiles(g);
      const byId = new Map(src.map((t) => [t.id, t]));

      for (const d of dirs) {
        const r = moveTiles(src, d);
        for (const t of r.tiles) {
          const origin = byId.get(t.id);
          if (!origin) continue;
          assert.equal(t.row, origin.row, `${n}×${n} dir=${d} 方块行号被改变`);
        }
        for (const t of r.dying) {
          const origin = byId.get(t.id);
          assert.ok(origin);
          assert.equal(t.row, origin.row, `${n}×${n} dir=${d} 合并源行号被改变`);
        }
        const rows = new Set(src.map((t) => t.row));
        for (const t of r.tiles) {
          if (!byId.has(t.id)) {
            assert.ok(rows.has(t.row), `${n}×${n} dir=${d} 合并产物落在非法行`);
          }
        }
      }
    }
  }
  setBoardSize(4);
});

test("列内下移：同一列内方块的行号单调不降，且不越界", () => {
  setBoardSize(4);
  const g: Grid = [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [4, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const r = moveTiles(gridToTiles(g), "down");
  const col0 = r.tiles.filter((t) => t.col === 0).sort((a, b) => a.row - b.row);
  assert.deepEqual(
    col0.map((t) => [t.row, t.value]),
    [
      [2, 2],
      [3, 4],
    ],
  );
});

/* ══════════════ 4c. 轨迹格子（粒子动效的生成位置）══════════════ */

const keyOf = (c: { row: number; col: number }): string => `${c.row},${c.col}`;
const sortedKeys = (cells: Array<{ row: number; col: number }>): string[] =>
  [...new Set(cells.map(keyOf))].sort();

test("trajectoryCells：覆盖整条路径，含中间格（diff 会漏掉的那些）", () => {
  setBoardSize(4);
  // 一个方块从 (0,0) 一路滑到 (3,0)，中间 (1,0)(2,0) 前后都是空的
  const before = gridToTiles([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const moved = moveTiles(before, "down");
  assert.deepEqual(sortedKeys(trajectoryCells(before, moved.tiles, moved.dying)), [
    "0,0", "1,0", "2,0", "3,0",
  ]);
});

test("trajectoryCells：未受影响的区域不出现", () => {
  setBoardSize(4);
  const before = gridToTiles([
    [2, 0, 0, 0],
    [4, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 8, 0, 0],   // 第 1 列的 8 已贴底，down 时不动
  ]);
  const moved = moveTiles(before, "down");
  const cells = trajectoryCells(before, moved.tiles, moved.dying);

  // 第 0 列动过；第 1 列的 8 原地不动 → 不该出现
  assert.deepEqual(sortedKeys(cells), ["0,0", "1,0", "2,0", "3,0"]);
});

test("trajectoryCells：无位移时返回空数组", () => {
  setBoardSize(4);
  const before = gridToTiles([
    [2, 0, 0, 0],
    [4, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  // up 是无效移动，moveTiles 返回的 tiles 位置不变
  const moved = moveTiles(before, "up");
  assert.equal(moved.moved, false);
  assert.deepEqual(trajectoryCells(before, moved.tiles, moved.dying), []);
});

test("trajectoryCells：合并时包含两个源格与产物格", () => {
  setBoardSize(4);
  const before = gridToTiles([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const moved = moveTiles(before, "down");
  const cells = sortedKeys(trajectoryCells(before, moved.tiles, moved.dying));
  // (0,0) 源、(2,0) 源与产物同格、(3,0) 产物 —— 整条路径都在
  assert.deepEqual(cells, ["0,0", "1,0", "2,0", "3,0"]);
});

test("trajectoryCells：新生成的方块所在格也算轨迹", () => {
  setBoardSize(4);
  const before = gridToTiles([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const moved = moveTiles(before, "down");
  const withSpawn = [...moved.tiles, makeTile(4, 1, 3)];
  const cells = sortedKeys(trajectoryCells(before, withSpawn));
  assert.ok(cells.includes("1,3"), "新方块所在格应被标记");
});

test("trajectoryCells：结果始终在棋盘范围内且不重复", () => {
  for (const n of [3, 4, 6, 8]) {
    setBoardSize(n);
    for (let trial = 0; trial < 120; trial++) {
      const g: Grid = Array.from({ length: n }, () =>
        Array.from({ length: n }, () =>
          Math.random() < 0.4 ? [2, 4, 8][Math.floor(Math.random() * 3)] : 0,
        ),
      );
      const before = gridToTiles(g);
      for (const d of ["up", "down", "left", "right"] as Direction[]) {
        const moved = moveTiles(before, d);
        const cells = trajectoryCells(before, moved.tiles, moved.dying);
        const keys = cells.map(keyOf);
        assert.equal(keys.length, new Set(keys).size, "结果有重复格");
        for (const c of cells) {
          assert.ok(c.row >= 0 && c.row < n && c.col >= 0 && c.col < n, "越界");
        }
      }
    }
  }
  setBoardSize(4);
});

/* ══════════════ 5. 生成区间 ══════════════ */

test("isPowerOfTwo", () => {
  for (const v of [1, 2, 4, 8, 16, 1024]) assert.ok(isPowerOfTwo(v), `${v} 应为 2 的幂`);
  for (const v of [0, 3, 6, 7, 12, -2, 1.5]) assert.ok(!isPowerOfTwo(v), `${v} 不应为 2 的幂`);
});

test("pickSpawnValue：落在区间内且恒为 2 的幂", () => {
  for (const [lo, hi] of [[2, 2], [2, 4], [2, 8], [4, 16], [1, 1]] as Array<[number, number]>) {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const v = pickSpawnValue(lo, hi);
      assert.ok(isPowerOfTwo(v), `产生了非 2 的幂：${v}`);
      assert.ok(v >= lo && v <= hi, `${v} 超出 [${lo}, ${hi}]`);
      seen.add(v);
    }
    // 指数区间内的每个值都应有机会出现
    const loE = Math.round(Math.log2(lo));
    const hiE = Math.round(Math.log2(hi));
    if (hiE > loE) {
      assert.equal(seen.size, hiE - loE + 1, `[${lo},${hi}] 未覆盖全部取值`);
    } else {
      assert.equal(seen.size, 1);
    }
  }
});

test("pickSpawnValue：max 为 null 时等同于 min", () => {
  for (let i = 0; i < 50; i++) assert.equal(pickSpawnValue(4, null), 4);
});

test("spawnTile：落在空位，且不修改入参", () => {
  setBoardSize(4);
  const tiles = gridToTiles([
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 0],
  ]);
  const before = JSON.stringify(tiles);
  const t = spawnTile(tiles, 2, 2);
  assert.equal(JSON.stringify(tiles), before, "spawnTile 修改了入参");
  assert.ok(t);
  assert.equal(t!.row, 3);
  assert.equal(t!.col, 3);
  assert.equal(t!.value, 2);
});

test("spawnTile：棋盘已满返回 null", () => {
  setBoardSize(3);
  const tiles = gridToTiles([
    [2, 4, 8],
    [4, 8, 16],
    [8, 16, 32],
  ]);
  assert.equal(spawnTile(tiles, 2, 2), null);
});

/* ══════════════ 6. 辅助函数 ══════════════ */

test("emptyCells 行列索引正确", () => {
  setBoardSize(3);
  const tiles = gridToTiles([
    [2, 0, 0],
    [0, 0, 0],
    [0, 0, 4],
  ]);
  const cells = emptyCells(tiles);
  assert.equal(cells.length, 7);
  assert.ok(!cells.some((c) => c.row === 0 && c.col === 0));
  assert.ok(!cells.some((c) => c.row === 2 && c.col === 2));
  assert.ok(cells.some((c) => c.row === 0 && c.col === 2));
});

test("toGrid 行列映射正确（不会转置）", () => {
  setBoardSize(3);
  const tiles = [makeTile(2, 0, 2), makeTile(8, 2, 0)];
  assert.deepEqual(toGrid(tiles), [
    [0, 0, 2],
    [0, 0, 0],
    [8, 0, 0],
  ]);
});

test("maxTile", () => {
  setBoardSize(4);
  assert.equal(maxTile(gridToTiles([[2, 4], [8, 16]])), 16);
  assert.equal(maxTile([]), 0);
});

test("非 4×4 尺寸下四方向均正确", () => {
  for (const n of [3, 5, 6]) {
    setBoardSize(n);
    assert.equal(SIZE, n);
    const g: Grid = Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => (r === 0 && c === 0 ? 2 : 0)),
    );
    assert.deepEqual(
      moved(g, "down"),
      Array.from({ length: n }, (_, r) =>
        Array.from({ length: n }, (_, c) => (r === n - 1 && c === 0 ? 2 : 0)),
      ),
      `${n}×${n} down 失败`,
    );
  }
  setBoardSize(4);
});
