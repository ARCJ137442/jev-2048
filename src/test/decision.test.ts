/**
 * 决策策略（resolveDecision）的单元测试。
 *
 * 重点是 `coerced` 标记的语义：它表示「Jev 首选非法 → 取次优合法」，
 * 日志面板据此把该行标成警示。它必须只反映首选是否合法 ——
 * 否则「首选非法率」这一测量会被正常的采样结果污染。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDecision } from "../client/decision.js";
import type { ChoiceAnswer, Direction } from "../shared/types.js";

const ALL: Direction[] = ["up", "down", "left", "right"];

function answer(probabilities: Record<string, number>): ChoiceAnswer {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: "choice", choice, probabilities, confidence: 0.5 };
}

const dist = answer({ up: 0.4, left: 0.3, right: 0.2, down: 0.1 });

/* ══════════════ greedy ══════════════ */

test("greedy：首选合法 → 取首选，不标 coerced", () => {
  const r = resolveDecision(dist, ALL, "greedy", 0);
  assert.equal(r.move, "up");
  assert.equal(r.coerced, false);
  assert.equal(r.reasonKey, "reason.takeTop");
});

test("greedy：首选非法 → 取分布内次优合法方向，标 coerced", () => {
  const r = resolveDecision(dist, ["left", "right", "down"], "greedy", 0);
  assert.equal(r.move, "left");
  assert.equal(r.coerced, true);
  assert.equal(r.reasonKey, "reason.coerced");
});

/* ══════════════ threshold ══════════════ */

test("threshold：最高概率低于门槛 → belowThreshold 为真，仍取首选", () => {
  const r = resolveDecision(dist, ALL, "threshold", 0.5);
  assert.equal(r.move, "up");
  assert.equal(r.belowThreshold, true);
  assert.equal(r.reasonKey, "reason.belowThreshold");
});

test("threshold：门槛为 0 表示不启用", () => {
  const r = resolveDecision(dist, ALL, "threshold", 0);
  assert.equal(r.belowThreshold, false);
});

/* ══════════════ sample ══════════════ */

test("sample：首选合法时，抽到非首选方向不算 coerced", () => {
  // 累计 up 0.4 → left 0.7：rand=0.5 落在 left
  const r = resolveDecision(dist, ALL, "sample", 0, () => 0.5);
  assert.equal(r.move, "left");
  assert.equal(r.coerced, false, "按分布抽到非首选是采样的正常结果，不是纠正");
  assert.equal(r.reasonKey, "reason.sampled");
});

test("sample：首选合法且抽中首选 → 不算 coerced", () => {
  const r = resolveDecision(dist, ALL, "sample", 0, () => 0);
  assert.equal(r.move, "up");
  assert.equal(r.coerced, false);
});

test("sample：首选非法 → 无论抽到哪个合法方向都标 coerced", () => {
  const legal: Direction[] = ["left", "right", "down"];
  for (const x of [0, 0.3, 0.6, 0.999]) {
    const r = resolveDecision(dist, legal, "sample", 0, () => x);
    assert.ok(legal.includes(r.move), `rand=${x} 抽到了非法方向 ${r.move}`);
    assert.equal(r.coerced, true, `rand=${x}：首选 up 非法，应标 coerced`);
  }
});

test("sample：rand 取上边界时同样按首选是否合法标记 coerced", () => {
  // 上边界附近 r 可能因浮点残留而走到循环后的兜底分支，两条路径的标记必须一致
  const legal: Direction[] = ["left", "right", "down"];
  const r = resolveDecision(dist, legal, "sample", 0, () => 1);
  assert.ok(legal.includes(r.move));
  assert.equal(r.coerced, true);
});

test("sample：只在合法方向里采样", () => {
  const legal: Direction[] = ["right", "down"];
  for (let i = 0; i < 50; i++) {
    const r = resolveDecision(dist, legal, "sample", 0, () => i / 50);
    assert.ok(legal.includes(r.move));
  }
});
