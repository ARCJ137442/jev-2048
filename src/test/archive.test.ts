/**
 * 存档导入导出的单元测试。
 *
 * 重点在**校验的严格性**：宁可明确报错让用户重新导出，
 * 也不要把结构不对的数据悄悄写进状态 —— 那会产出更难排查的问题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_VERSION,
  ArchiveError,
  buildArchive,
  extract,
  parseArchive,
  type ArchiveKind,
} from "../client/archive.js";
import {
  DEFAULT_API,
  DEFAULT_CONTEXT,
  DEFAULT_GAME,
  type Persisted,
} from "../client/config.js";
import type { SessionInput } from "../client/session.js";

function makeStore(): Persisted {
  return {
    game: {
      ...DEFAULT_GAME,
      boardWidth: 6,
      boardHeight: 5,
      strategy: "sample",
      threshold: 0.4,
      memory: 8,
    },
    context: { ...DEFAULT_CONTEXT, ruleDesc: "测试规则", strategyHint: "测试提示", consequences: false },
    api: { retryMax: 5, retryBaseMs: 1200 },
    highScores: { "4x4": 100, "6x5": 250 },
    bestTiles: { "4x4": 64, "6x5": 128 },
    lastWidth: 6,
    lastHeight: 5,
  };
}

function makeSession(): SessionInput {
  return {
    cols: 6,
    rows: 5,
    tiles: [
      { id: 1, value: 2, row: 0, col: 0 },
      { id: 9, value: 4, row: 5, col: 5 },
    ],
    score: 321,
    turn: 17,
    memory: [{ turn: 17, board: [[2]], move: "left", score: 321 }],
    history: [],
    finished: false,
  };
}

/* ══════════════ 导出 ══════════════ */

test("buildArchive：五类档案都带 app / v / kind / exportedAt", () => {
  const store = makeStore();
  const kinds: ArchiveKind[] = ["game", "strategy", "api", "log", "all"];
  for (const k of kinds) {
    const a = buildArchive(k, store, makeSession(), []);
    assert.equal(a.app, "jev2048");
    assert.equal(a.v, ARCHIVE_VERSION);
    assert.equal(a.kind, k);
    assert.ok(typeof a.exportedAt === "string" && a.exportedAt.length > 0);
  }
});

test("buildArchive：api 档绝不包含密钥字段", () => {
  const a = buildArchive("api", makeStore(), null, []);
  const text = JSON.stringify(a);
  assert.ok(!text.includes("apiKey"), "api 档不应出现 apiKey");
  assert.ok(!text.includes("vck_"), "api 档不应出现密钥前缀");
});

test("buildArchive：strategy 档只带策略相关的游戏字段", () => {
  const a = buildArchive("strategy", makeStore(), null, []);
  const r = extract(a);
  assert.equal(r.game?.strategy, "sample");
  assert.equal(r.game?.threshold, 0.4);
  assert.equal(r.game?.memory, 8);
  // 棋盘尺寸不该出现在策略档的语义里（合并时也不会被它覆盖）
  assert.equal(r.context?.ruleDesc, "测试规则");
});

test("buildArchive：game 档带对局与历史纪录", () => {
  const r = extract(buildArchive("game", makeStore(), makeSession(), []));
  assert.equal(r.session?.turn, 17);
  assert.equal(r.session?.score, 321);
  assert.equal(r.highScores?.["6x5"], 250);
  assert.equal(r.bestTiles?.["4x4"], 64);
  assert.equal(r.hasScores, true);
});

/* ══════════════ 解析与校验 ══════════════ */

test("parseArchive：拒绝非法 JSON", () => {
  assert.throws(() => parseArchive("{不是 JSON"), ArchiveError);
});

test("parseArchive：拒绝非对象", () => {
  assert.throws(() => parseArchive("[1,2,3]"), ArchiveError);
  assert.throws(() => parseArchive('"字符串"'), ArchiveError);
});

test("parseArchive：拒绝缺少 app 标记的文件", () => {
  assert.throws(() => parseArchive('{"v":1,"kind":"game","payload":{}}'), ArchiveError);
});

test("parseArchive：拒绝缺少版本号", () => {
  assert.throws(
    () => parseArchive('{"app":"jev2048","kind":"game","payload":{}}'),
    ArchiveError,
  );
});

test("parseArchive：拒绝高于当前支持的版本", () => {
  const future = JSON.stringify({
    app: "jev2048",
    v: ARCHIVE_VERSION + 1,
    kind: "game",
    payload: {},
  });
  assert.throws(() => parseArchive(future), /高于当前支持/);
});

test("parseArchive：拒绝未知的档案类型", () => {
  const bad = JSON.stringify({ app: "jev2048", v: 1, kind: "nonsense", payload: {} });
  assert.throws(() => parseArchive(bad), /未知的档案类型/);
});

test("parseArchive：拒绝缺少 payload", () => {
  const bad = JSON.stringify({ app: "jev2048", v: 1, kind: "game" });
  assert.throws(() => parseArchive(bad), /缺少 payload/);
});

test("parseArchive：接受本版本导出的档案（往返一致）", () => {
  const a = buildArchive("all", makeStore(), makeSession(), []);
  const parsed = parseArchive(JSON.stringify(a));
  assert.equal(parsed.kind, "all");
  assert.deepEqual(parsed.payload, a.payload);
});

/* ══════════════ 提取 ══════════════ */

test("extract：log 档不参与导入", () => {
  const a = buildArchive("log", makeStore(), null, []);
  assert.throws(() => extract(a), /不支持导入/);
});

test("extract：缺字段时用默认值兜底，而不是抛出", () => {
  const partial = parseArchive(
    JSON.stringify({ app: "jev2048", v: 1, kind: "strategy", payload: {} }),
  );
  const r = extract(partial);
  // 没有 context 字段 → undefined（调用方据此跳过），而不是写坏状态
  assert.equal(r.context, undefined);
});

test("extract：all 档能一次带出全部四类", () => {
  const r = extract(buildArchive("all", makeStore(), makeSession(), []));
  assert.ok(r.game);
  assert.ok(r.context);
  assert.ok(r.api);
  assert.ok(r.session);
  assert.ok(r.highScores);
  assert.ok(r.bestTiles);
});

test("extract：API 档案只带 api，不带其他", () => {
  const r = extract(buildArchive("api", makeStore(), null, []));
  assert.deepEqual(r.api, { retryMax: 5, retryBaseMs: 1200 });
  assert.equal(r.game, undefined);
  assert.equal(r.context, undefined);
  assert.equal(r.session, undefined);
});

test("extract：api 兜底值与 DEFAULT_API 一致", () => {
  const partial = parseArchive(
    JSON.stringify({ app: "jev2048", v: 1, kind: "api", payload: { api: {} } }),
  );
  const r = extract(partial);
  assert.deepEqual(r.api, DEFAULT_API);
});
