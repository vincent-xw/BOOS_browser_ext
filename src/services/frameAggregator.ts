import type { LocateResult } from '../types/cdp';

/**
 * 跨 frame 结果聚合。
 *
 * AGENTS.md 明令禁止退化为「只读主 frame」。而 chrome.tabs.sendMessage 不带 frameId 时
 * 只会返回**第一个应答的 frame** —— 那正是被禁止的退化行为，且症状隐蔽：
 * 目标内容在子 frame 时会表现为「定位不到」，而不是报错。
 *
 * 所以必须显式向每个 frame 广播，再按评分取最优。
 */

/** 单个 frame 的应答。失败的 frame 保留 undefined，参与不了评分但不影响其余 frame。 */
export interface FrameOutcome<T> {
  frameId: number;
  result?: T;
}

/** 按评分取最优结果。评分相同时保留先出现的（主 frame 通常排在前）。 */
export function pickBestOutcome<T>(outcomes: readonly FrameOutcome<T>[], score: (value: T) => number): { frameId: number; result: T } | undefined {
  let best: { frameId: number; result: T } | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const outcome of outcomes) {
    if (outcome.result === undefined) continue;
    const current = score(outcome.result);
    if (current > bestScore) {
      bestScore = current;
      best = { frameId: outcome.frameId, result: outcome.result };
    }
  }
  return best;
}

/**
 * 定位结果评分。命中且可点击的排最前，命中但被遮挡的次之，未命中垫底。
 * 被遮挡仍优于未命中：调用方需要知道「元素在那儿但被挡住了」，这是可操作的信息。
 */
export function scoreLocateResult(result: LocateResult): number {
  if (!result.found) return 0;
  let score = 100;
  if (result.visible) score += 20;
  if (result.inViewport) score += 20;
  if (result.occluded) score -= 50;
  // 用户配置命中优先于站点兜底：用户明确配过的选择器更可能指向他要的元素。
  if (result.selectorSource === 'user-config') score += 10;
  return score;
}

/** 页面快照评分：内容更多的 frame 更可能是真正承载业务的那个。 */
export function scorePageSnapshot(snapshot: { bodyPreview?: string; candidates?: unknown[] }): number {
  const candidateCount = snapshot.candidates?.length ?? 0;
  return candidateCount * 1000 + (snapshot.bodyPreview?.length ?? 0);
}

/** 合并各 frame 的未命中信息，供全部失败时报告已尝试的选择器。 */
export function mergeTriedSelectors(outcomes: readonly FrameOutcome<LocateResult>[]): string[] {
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    for (const selector of outcome.result?.triedSelectors ?? []) seen.add(selector);
  }
  return [...seen];
}
