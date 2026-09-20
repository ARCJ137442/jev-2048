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

/**
 * ⚠ 只能放**假**密钥。
 *
 * 这里曾经逐字粘贴过一把真实密钥 —— 它因此进了 git 历史。更糟的是，
 * 同一文件里混进了裸控制字节，git 把它判为二进制，而 CI 的密钥扫描
 * 用的是 `grep -I`（跳过二进制），恰好把它漏掉了。
 *
 * 两条教训：
 *   1. 测试 fixture 一律用假值，真值永远不该进测试
 *   2. 扫描的判据不能依赖「像不像密钥」，必须覆盖二进制文件
 */
const FAKE_KEY = "vck_TESTONLY_0000000000000000000000000000000000000000";

test("封存后不含明文", () => {
  const s = seal(FAKE_KEY);
  assert.ok(!s.includes(FAKE_KEY), "密文里出现了完整明文");
  assert.ok(!s.includes("vck_"), "密文里出现了密钥前缀");
  assert.ok(s.length > 0);
});

test("往返无损", () => {
  const cases = [FAKE_KEY, "short", "含中文的密钥", "a".repeat(500)];
  for (const v of cases) {
    assert.equal(unseal(seal(v)), v, `往返失败：${v.slice(0, 20)}`);
  }
});

test("同一明文两次封存得到不同密文（随机盐 + IV）", () => {
  const a = seal(FAKE_KEY);
  const b = seal(FAKE_KEY);
  assert.notEqual(a, b, "两次密文相同，说明盐或 IV 没随机化");
  assert.equal(unseal(a), unseal(b));
});

test("isSealed 能区分封存内容与普通文本", () => {
  assert.equal(isSealed(seal(FAKE_KEY)), true);
  assert.equal(isSealed(FAKE_KEY), false);
  assert.equal(isSealed("随便一段文字"), false);
  assert.equal(isSealed(""), false);
});

test("篡改密文 → 安全失败返回 null（GCM 认证）", () => {
  const s = seal(FAKE_KEY);
  assert.equal(unseal(s.slice(0, -8) + "AAAAAAAA"), null, "篡改后仍能解开，认证失效");
  assert.equal(unseal(s.slice(0, 60) + "ZZZZ" + s.slice(64)), null);
});

test("非封存内容 → 返回 null，不抛异常", () => {
  const bad = ["", "hello", "not base64 !!!", "vck_3Qqw", "=".repeat(30)];
  for (const b of bad) {
    assert.doesNotThrow(() => unseal(b), `unseal 在输入 ${b.length} 字符时抛异常`);
    assert.equal(unseal(b), null);
  }
});

test("极端输入不崩", () => {
  assert.doesNotThrow(() => unseal("A".repeat(100_000)));
  // 控制字符一律用转义写，绝不直接粘贴 ——
  // 裸控制字节会让 git 把整个文件判为二进制，从而绕过密钥扫描
  const withControlChars = ["\u0000\u0001\u0002", "\u0000"];
  for (const v of withControlChars) {
    assert.doesNotThrow(() => unseal(v));
    assert.equal(unseal(v), null);
  }
});
