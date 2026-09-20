/**
 * 密钥封存的单元测试。
 *
 * 重点不是「加密强度」——默认口令就在源码里，本就不指望它挡住针对性攻击。
 * 要守住的是三件事：
 *   1. 磁盘上**不出现明文**
 *   2. 往返**无损**
 *   3. 任何异常输入都**安全失败**（返回 null），而不是抛异常炸掉启动流程
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSealed, seal, unseal } from "../server/seal.js";

const KEY = "vck_TESTONLY_0000000000000000000000000000000000000000";

test("封存后不含明文", () => {
  const s = seal(KEY);
  assert.ok(!s.includes(KEY), "密文里出现了完整明文");
  assert.ok(!s.includes("vck_"), "密文里出现了密钥前缀");
  assert.ok(s.length > 0);
});

test("往返无损", () => {
  for (const v of [KEY, "short", "含中文的密钥", "a".repeat(500)]) {
    assert.equal(unseal(seal(v)), v, `往返失败：${v.slice(0, 20)}`);
  }
});

test("同一明文两次封存得到不同密文（随机盐 + IV）", () => {
  const a = seal(KEY);
  const b = seal(KEY);
  assert.notEqual(a, b, "两次密文相同，说明盐或 IV 没随机化");
  assert.equal(unseal(a), unseal(b));
});

test("isSealed 能区分封存内容与普通文本", () => {
  assert.equal(isSealed(seal(KEY)), true);
  assert.equal(isSealed(KEY), false);
  assert.equal(isSealed("随便一段文字"), false);
  assert.equal(isSealed(""), false);
});

test("篡改密文 → 安全失败返回 null（GCM 认证）", () => {
  const s = seal(KEY);
  // 改动末尾若干字符
  const tampered = s.slice(0, -8) + "AAAAAAAA";
  assert.equal(unseal(tampered), null, "篡改后仍能解开，认证失效");

  // 改动中段
  const mid = s.slice(0, 60) + "ZZZZ" + s.slice(64);
  assert.equal(unseal(mid), null);
});

test("非封存内容 → 返回 null，不抛异常", () => {
  for (const bad of ["", "hello", "not base64 !!!", "vck_3Qqw", "=".repeat(30)]) {
    assert.doesNotThrow(() => unseal(bad), `unseal(${JSON.stringify(bad)}) 抛了异常`);
    assert.equal(unseal(bad), null);
  }
});

test("极端输入不崩", () => {
  assert.doesNotThrow(() => unseal("A".repeat(100_000)));
  assert.doesNotThrow(() => unseal("\0"));
});
