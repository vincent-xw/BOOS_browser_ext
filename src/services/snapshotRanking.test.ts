import { describe, expect, it } from 'vitest';

import { TIER_EXPLICIT, TIER_SOFT, classifyCandidate, compareSnapshotCandidates } from './snapshotRanking';
import type { RankableCandidate } from './snapshotRanking';

describe('classifyCandidate', () => {
  it('显式可交互元素直接收录，不标 soft', () => {
    const result = classifyCandidate({ explicit: true, inPopupContainer: false });
    expect(result.include).toBe(true);
    expect(result.tier).toBe(TIER_EXPLICIT);
    expect(result.soft).toBeUndefined();
  });

  it('浮层内的普通元素也收录 —— 这正是 UI 库下拉项此前进不了快照的原因', () => {
    const result = classifyCandidate({ explicit: false, inPopupContainer: true });
    expect(result.include).toBe(true);
    expect(result.inPopup).toBe(true);
    expect(result.soft).toBe(true);
    expect(result.tier).toBe(TIER_SOFT);
  });

  it('cursor 为 pointer 的非显式元素收录并标 soft', () => {
    const result = classifyCandidate({ explicit: false, cursor: 'pointer', inPopupContainer: false });
    expect(result.include).toBe(true);
    expect(result.soft).toBe(true);
  });

  it('既不在浮层内也不可点的元素不收录，避免快照被无关元素挤爆', () => {
    expect(classifyCandidate({ explicit: false, cursor: 'default', inPopupContainer: false }).include).toBe(false);
    expect(classifyCandidate({ explicit: false, inPopupContainer: false }).include).toBe(false);
  });

  it('aria-expanded 为 true 时标记 expanded', () => {
    expect(classifyCandidate({ explicit: true, ariaExpanded: 'true', inPopupContainer: false }).expanded).toBe(true);
    expect(classifyCandidate({ explicit: true, ariaExpanded: 'false', inPopupContainer: false }).expanded).toBeUndefined();
    expect(classifyCandidate({ explicit: true, ariaExpanded: null, inPopupContainer: false }).expanded).toBeUndefined();
  });
});

describe('compareSnapshotCandidates', () => {
  const make = (overrides: Partial<RankableCandidate>): RankableCandidate => ({
    index: 0,
    inPopup: false,
    nearFocus: false,
    tier: TIER_EXPLICIT,
    ...overrides,
  });

  it('浮层内优先，即使它在文档里靠后', () => {
    // 浮层 portal 到 body 末尾，不排序就会被 SNAPSHOT_LIMIT 砍掉。
    const popup = make({ index: 900, inPopup: true });
    const normal = make({ index: 1 });
    expect([normal, popup].sort(compareSnapshotCandidates)[0]).toBe(popup);
  });

  it('同为浮层时焦点附近优先', () => {
    const focused = make({ index: 50, inPopup: true, nearFocus: true });
    const other = make({ index: 10, inPopup: true });
    expect([other, focused].sort(compareSnapshotCandidates)[0]).toBe(focused);
  });

  it('其余条件相同时显式可交互排在启发式之前', () => {
    const soft = make({ index: 2, tier: TIER_SOFT });
    const explicit = make({ index: 5, tier: TIER_EXPLICIT });
    expect([soft, explicit].sort(compareSnapshotCandidates)[0]).toBe(explicit);
  });

  it('全部条件相同时按文档顺序稳定排列', () => {
    const sorted = [make({ index: 3 }), make({ index: 1 }), make({ index: 2 })].sort(compareSnapshotCandidates);
    expect(sorted.map((candidate) => candidate.index)).toEqual([1, 2, 3]);
  });
});
