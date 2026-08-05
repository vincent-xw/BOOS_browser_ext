import { describe, expect, it } from 'vitest';

import { mergeTriedSelectors, pickBestOutcome, scoreLocateResult, scorePageSnapshot } from './frameAggregator';
import type { FrameOutcome } from './frameAggregator';
import type { LocateResult } from '../types/cdp';

/** 构造一条定位结果。 */
function located(overrides: Partial<LocateResult> = {}): LocateResult {
  return { found: true, x: 10, y: 20, visible: true, inViewport: true, occluded: false, ...overrides };
}

describe('pickBestOutcome', () => {
  it('取评分最高的 frame', () => {
    const outcomes: Array<FrameOutcome<number>> = [
      { frameId: 0, result: 1 },
      { frameId: 7, result: 9 },
      { frameId: 3, result: 5 },
    ];
    expect(pickBestOutcome(outcomes, (value) => value)).toEqual({ frameId: 7, result: 9 });
  });

  it('忽略无应答的 frame', () => {
    const outcomes: Array<FrameOutcome<number>> = [{ frameId: 0 }, { frameId: 1, result: 3 }];
    expect(pickBestOutcome(outcomes, (value) => value)).toEqual({ frameId: 1, result: 3 });
  });

  it('全部无应答返回 undefined', () => {
    expect(pickBestOutcome([{ frameId: 0 }, { frameId: 1 }], () => 1)).toBeUndefined();
  });

  it('评分相同时保留先出现的', () => {
    const outcomes: Array<FrameOutcome<string>> = [
      { frameId: 0, result: 'main' },
      { frameId: 5, result: 'sub' },
    ];
    expect(pickBestOutcome(outcomes, () => 1)?.frameId).toBe(0);
  });
});

describe('scoreLocateResult', () => {
  it('未命中得 0 分', () => {
    expect(scoreLocateResult({ found: false })).toBe(0);
  });

  it('命中且可点击优于命中但被遮挡', () => {
    expect(scoreLocateResult(located())).toBeGreaterThan(scoreLocateResult(located({ occluded: true })));
  });

  it('被遮挡仍优于未命中', () => {
    // 「元素在那儿但被挡住了」是可操作的信息，比「找不到」更有价值。
    expect(scoreLocateResult(located({ occluded: true }))).toBeGreaterThan(scoreLocateResult({ found: false }));
  });

  it('视口内优于视口外', () => {
    expect(scoreLocateResult(located())).toBeGreaterThan(scoreLocateResult(located({ inViewport: false })));
  });

  it('用户配置命中优于站点兜底', () => {
    expect(scoreLocateResult(located({ selectorSource: 'user-config' }))).toBeGreaterThan(
      scoreLocateResult(located({ selectorSource: 'site-fallback' })),
    );
  });

  it('子 frame 命中会胜过主 frame 未命中', () => {
    // 这是「聚合取最优」存在的核心理由：目标内容常常在子 frame 里。
    const outcomes: Array<FrameOutcome<LocateResult>> = [
      { frameId: 0, result: { found: false, triedSelectors: ['.a'] } },
      { frameId: 12, result: located() },
    ];
    expect(pickBestOutcome(outcomes, scoreLocateResult)?.frameId).toBe(12);
  });
});

describe('scorePageSnapshot', () => {
  it('候选人数量优先于正文长度', () => {
    const withCandidates = scorePageSnapshot({ bodyPreview: 'x', candidates: [{}, {}] });
    const longBodyOnly = scorePageSnapshot({ bodyPreview: 'x'.repeat(1500) });
    expect(withCandidates).toBeGreaterThan(longBodyOnly);
  });

  it('都无候选人时按正文长度比较', () => {
    expect(scorePageSnapshot({ bodyPreview: 'xxx' })).toBeGreaterThan(scorePageSnapshot({ bodyPreview: 'x' }));
  });

  it('空快照得 0 分', () => {
    expect(scorePageSnapshot({})).toBe(0);
  });
});

describe('mergeTriedSelectors', () => {
  it('合并各 frame 已尝试的选择器并去重', () => {
    const outcomes: Array<FrameOutcome<LocateResult>> = [
      { frameId: 0, result: { found: false, triedSelectors: ['.a', '.b'] } },
      { frameId: 1, result: { found: false, triedSelectors: ['.b', '.c'] } },
      { frameId: 2 },
    ];
    expect(mergeTriedSelectors(outcomes)).toEqual(['.a', '.b', '.c']);
  });

  it('无尝试记录时返回空数组', () => {
    expect(mergeTriedSelectors([{ frameId: 0 }])).toEqual([]);
  });
});
