/**
 * 界面国际化的单元测试。
 *
 * 这里最有价值的是**词条完整性**那条：漏翻一条在运行时只表现为界面上
 * 冒出一句中文（或英文），很难被注意到；把它变成测试断言之后，
 * 「zh 与 en 的 key 集合必须一致」就成了每次跑测试都会检查的硬约束。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyDom,
  dictFor,
  getLang,
  langFromTag,
  onLangChange,
  setLang,
  t,
  type Lang,
} from "../client/i18n.js";

/* ══════════════ 词条表的完整性 ══════════════ */

test("词条表：zh 与 en 的 key 集合完全一致（防止漏译）", () => {
  const zh = Object.keys(dictFor("zh"));
  const en = Object.keys(dictFor("en"));

  const onlyZh = zh.filter((k) => !(k in dictFor("en")));
  const onlyEn = en.filter((k) => !(k in dictFor("zh")));

  assert.deepEqual(onlyZh, [], `这些 key 只有中文，缺英文：${onlyZh.join(", ")}`);
  assert.deepEqual(onlyEn, [], `这些 key 只有英文，缺中文：${onlyEn.join(", ")}`);
});

test("词条表：没有任何空词条", () => {
  for (const lang of ["zh", "en"] as Lang[]) {
    for (const [key, value] of Object.entries(dictFor(lang))) {
      assert.ok(
        value.trim().length > 0,
        `${lang} 的 "${key}" 是空串 —— 界面上会显示成一片空白`,
      );
    }
  }
});

test("词条表：key 用点分命名空间，且不含空白", () => {
  for (const lang of ["zh", "en"] as Lang[]) {
    for (const key of Object.keys(dictFor(lang))) {
      assert.match(key, /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/, `key 不合规范：${key}`);
    }
  }
});

/* ══════════════ t() ══════════════ */

test("t()：按当前语言取词条", () => {
  setLang("zh");
  assert.equal(t("nav.game"), "游戏");
  setLang("en");
  assert.equal(t("nav.game"), "Game");
  setLang("zh");
});

test("t()：对 {name} 占位符做参数插值", () => {
  setLang("zh");
  assert.equal(t("status.retrying", { n: 3, s: "1.6" }), "重试 3（1.6s 后）");
});

test("t()：同一词条在两门语言下都做了插值", () => {
  setLang("en");
  assert.equal(t("status.retrying", { n: 3, s: "1.6" }), "Retry 3 (in 1.6s)");
  setLang("zh");
});

test("t()：未提供参数时保留占位符原样，而不是打出 undefined", () => {
  setLang("zh");
  const s = t("status.retrying", { n: 3 });
  assert.ok(s.includes("{s}"), `缺参数时占位符应原样保留，实际得到：${s}`);
  assert.ok(!s.includes("undefined"));
});

test("t()：未知 key 回落到 key 本身，绝不抛异常", () => {
  // 界面不该因为漏了一条词条就整个白屏 —— 这个项目踩过「一个 null 中断整个启动」的坑
  assert.doesNotThrow(() => t("no.such.key"));
  assert.equal(t("no.such.key"), "no.such.key");
});

test("t()：未知 key 且带参数时也不抛异常", () => {
  assert.equal(t("no.such.key", { a: 1 }), "no.such.key");
});

/* ══════════════ 语言状态 ══════════════ */

test("setLang / getLang：读写当前语言", () => {
  setLang("en");
  assert.equal(getLang(), "en");
  setLang("zh");
  assert.equal(getLang(), "zh");
});

test("setLang：设成同一个值不触发广播", () => {
  setLang("zh");
  let called = 0;
  const off = onLangChange(() => called++);

  setLang("zh");
  assert.equal(called, 0, "同值不该广播");

  setLang("en");
  assert.equal(called, 1, "真正变化时应广播一次");

  setLang("zh");
  off();
});

test("onLangChange：取消订阅后不再收到广播", () => {
  setLang("zh");
  let called = 0;
  const off = onLangChange(() => called++);

  setLang("en");
  assert.equal(called, 1);

  off();
  setLang("zh");
  assert.equal(called, 1, "取消订阅后不该再被调用");
});

test("onLangChange：多个订阅者都会收到", () => {
  setLang("zh");
  let a = 0;
  let b = 0;
  const offA = onLangChange(() => a++);
  const offB = onLangChange(() => b++);

  setLang("en");
  assert.equal(a, 1);
  assert.equal(b, 1);

  setLang("zh");
  offA();
  offB();
});

/* ══════════════ 语言探测 ══════════════ */

test("langFromTag：zh 开头一律中文（含地区与变体）", () => {
  assert.equal(langFromTag("zh"), "zh");
  assert.equal(langFromTag("zh-CN"), "zh");
  assert.equal(langFromTag("zh-Hant-TW"), "zh");
});

test("langFromTag：其余语言一律英文（本项目只有两门）", () => {
  assert.equal(langFromTag("en"), "en");
  assert.equal(langFromTag("en-US"), "en");
  assert.equal(langFromTag("ja-JP"), "en");
  assert.equal(langFromTag(""), "en");
});

test("langFromTag：缺失标签时不崩，回落到英文", () => {
  assert.equal(langFromTag(undefined), "en");
});

/* ══════════════ applyDom ══════════════ */

/** 造一个只带 dataset 的假元素，够 applyDom 用 */
function fakeEl(attrs: Record<string, string>): Record<string, unknown> {
  const el: Record<string, unknown> = {
    dataset: {},
    textContent: "",
    innerHTML: "",
    title: "",
    placeholder: "",
  };
  const ds = el.dataset as Record<string, string>;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "data-i18n") ds.i18n = v;
    if (k === "data-i18n-html") ds.i18nHtml = v;
    if (k === "data-i18n-title") ds.i18nTitle = v;
    if (k === "data-i18n-ph") ds.i18nPh = v;
  }
  return el;
}

/** 按选择器分发的假 root */
function fakeRoot(map: Record<string, unknown[]>): ParentNode {
  return {
    querySelectorAll: (sel: string) => map[sel] ?? [],
  } as unknown as ParentNode;
}

test("applyDom：分别写回 textContent / title / placeholder", () => {
  setLang("en");

  const text = fakeEl({ "data-i18n": "nav.game" });
  const titled = fakeEl({ "data-i18n-title": "nav.gameTitle" });
  const ph = fakeEl({ "data-i18n-ph": "game.phWidth" });
  const html = fakeEl({ "data-i18n-html": "incompat.salvage" });

  applyDom(
    fakeRoot({
      "[data-i18n]": [text],
      "[data-i18n-title]": [titled],
      "[data-i18n-ph]": [ph],
      "[data-i18n-html]": [html],
    }),
  );

  assert.equal(text.textContent, "Game");
  assert.equal(titled.title, t("nav.gameTitle"));
  assert.equal(ph.placeholder, "W 4");
  assert.equal(html.innerHTML, t("incompat.salvage"));

  setLang("zh");
});

test("applyDom：遇到没有 key 的元素不会写坏内容", () => {
  setLang("en");
  const el = fakeEl({});
  el.textContent = "原文";

  assert.doesNotThrow(() => applyDom(fakeRoot({ "[data-i18n]": [el] })));
  assert.equal(el.textContent, "原文", "没有 data-i18n 值时应原样不动");

  setLang("zh");
});
