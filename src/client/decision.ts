/**
 * 决策策略 —— 把 Jev 的概率分布转换成实际执行的方向。
 *
 * 设计原则：**只测量 Jev，不引入任何启发式算法。**
 *
 * 因此这里没有规则兜底、没有启发式接管。当 Jev 不确定时，正确的做法不是
 * 悄悄换成别的算法（那会污染测量），而是**把不确定性暴露给用户**：
 * 用户看着置信度追踪图，自己决定阈值该设多少。
 *
 * 为此提供 `UNCERTAINTY_THRESHOLD`（用户可调，默认 0 = 不启用）：
 * 当最高概率低于该值时，本回合**暂停并标记**，交由用户处置。
 */
import type { ChoiceAnswer, Direction } from "../shared/types.js";
import { t } from "./i18n.js";

export type Strategy = "greedy" | "sample" | "threshold";

export interface Resolution {
  move: Direction;
  /** 人类可读的决策依据（已按当前界面语言翻译） */
  reason: string;
  /**
   * `reason` 对应的词条 key 与参数。
   *
   * 界面切换语言时，决策面板要按新语言重画 —— 面板是「一次性画好」的，
   * 只有拿得到 key 才能重新翻译，否则会留下上一门语言的残留。
   */
  reasonKey: string;
  reasonParams?: Record<string, string | number>;
  /** Jev 首选非法、退而取其分布内的次优合法方向 */
  coerced: boolean;
  /** 最高概率低于用户设定的阈值（仅在 threshold 策略下可能为真） */
  belowThreshold: boolean;
}

/** 按概率降序的 [方向, 概率] 列表 */
export function rankProbabilities(answer: ChoiceAnswer): Array<[Direction, number]> {
  return (Object.entries(answer.probabilities) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k as Direction, v]);
}

/** 概率最高的合法方向 */
export function bestLegalMove(
  answer: ChoiceAnswer,
  legal: Direction[],
): { move: Direction; prob: number } | null {
  const set = new Set(legal);
  for (const [move, prob] of rankProbabilities(answer)) {
    if (set.has(move)) return { move, prob };
  }
  return null;
}

/**
 * @param answer     Jev 的 choice 答案
 * @param legal      当前合法方向
 * @param strategy   贪心 / 概率采样 / 置信度门槛
 * @param threshold  置信度门槛（仅 threshold 策略使用）
 */
export function resolveDecision(
  answer: ChoiceAnswer,
  legal: Direction[],
  strategy: Strategy,
  threshold: number,
): Resolution {
  const ranked = rankProbabilities(answer);
  /** 同时给出译文与 key —— 译文供当前渲染，key 供日后重新翻译 */
  const mk = (key: string, params?: Record<string, string | number>) => ({
    reason: t(key, params),
    reasonKey: key,
    reasonParams: params,
  });

  if (ranked.length === 0) {
    return {
      move: legal[0],
      ...mk("reason.noProb"),
      coerced: true,
      belowThreshold: false,
    };
  }

  const legalSet = new Set(legal);
  const [topMove, topProb] = ranked[0];
  const belowThreshold = strategy === "threshold" && threshold > 0 && topProb < threshold;

  // 概率采样：只在合法方向里按归一化概率轮盘赌
  if (strategy === "sample") {
    const pool = ranked.filter(([d]) => legalSet.has(d));
    if (pool.length > 0) {
      const total = pool.reduce((s, [, p]) => s + p, 0) || 1;
      let r = Math.random() * total;
      for (const [move, p] of pool) {
        r -= p;
        if (r <= 0) {
          return { move, ...mk("reason.sampled"), coerced: move !== topMove, belowThreshold };
        }
      }
      return { move: pool[0][0], ...mk("reason.sampled"), coerced: false, belowThreshold };
    }
  }

  // 贪心 / 门槛：取概率最高的合法方向
  if (legalSet.has(topMove)) {
    return {
      move: topMove,
      ...(belowThreshold
        ? mk("reason.belowThreshold", {
            p: (topProb * 100).toFixed(0),
            t: (threshold * 100).toFixed(0),
          })
        : mk("reason.takeTop")),
      coerced: false,
      belowThreshold,
    };
  }

  // Jev 首选非法 —— 从它自己的分布里退而求其次，不引入外部规则
  const alt = bestLegalMove(answer, legal);
  if (alt) {
    return {
      move: alt.move,
      ...mk("reason.coerced", { move: t(`dir.${topMove}`) }),
      coerced: true,
      belowThreshold,
    };
  }

  return {
    move: legal[0],
    ...mk("reason.noLegal"),
    coerced: true,
    belowThreshold,
  };
}
