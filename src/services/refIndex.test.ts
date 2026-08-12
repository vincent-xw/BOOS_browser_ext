import { describe, expect, it } from 'vitest';

import { mergeFrameSnapshots } from './refIndex';
import type { FrameSnapshot } from './refIndex';
import type { SnapshotEntry } from '../types/cdp';

function entry(ref: number, label: string, extra: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return { ref, tag: 'div', label, kind: 'clickable', x: 0, y: 0, width: 10, height: 10, ...extra };
}

function frame(frameId: number, entries: SnapshotEntry[], extra: { url?: string; title?: string; truncated?: number } = {}): FrameSnapshot {
  return {
    frameId,
    result: { url: extra.url ?? '', title: extra.title ?? '', entries, ...(extra.truncated ? { truncated: extra.truncated } : {}) },
  };
}

describe('mergeFrameSnapshots', () => {
  it('给每个 frame 的元素铸全局唯一 ref', () => {
    const merged = mergeFrameSnapshots([
      frame(0, [entry(1, '主-a'), entry(2, '主-b')]),
      frame(7, [entry(1, '子-a'), entry(2, '子-b')]),
    ]);

    expect(merged.snapshot.entries.map((item) => item.ref)).toEqual([1, 2, 3, 4]);
  });

  /**
   * 这是线上事故的形态：两个 frame 各自铸出 ref 53，模型指定 53 时
   * 解析到的是主 frame 那个同号元素，点击落在完全无关的位置且不报错。
   */
  it('同号本地 ref 分属不同 frame 时不再撞车', () => {
    const merged = mergeFrameSnapshots([
      frame(0, [entry(53, '侧边栏链接', { tag: 'a', kind: 'link' })]),
      frame(357, [entry(53, '请输入下单人电话', { tag: 'input', kind: 'textbox' })]),
    ]);

    const [mainEntry, frameEntry] = merged.snapshot.entries;
    expect(mainEntry?.ref).not.toBe(frameEntry?.ref);
    expect(merged.owners.get(mainEntry?.ref as number)).toEqual({ frameId: 0, localRef: 53 });
    expect(merged.owners.get(frameEntry?.ref as number)).toEqual({ frameId: 357, localRef: 53 });
  });

  it('owners 记录每个全局 ref 的 frame 与本地号', () => {
    const merged = mergeFrameSnapshots([frame(0, [entry(9, '主')]), frame(4, [entry(3, '子')])]);

    expect(merged.owners.get(1)).toEqual({ frameId: 0, localRef: 9 });
    expect(merged.owners.get(2)).toEqual({ frameId: 4, localRef: 3 });
  });

  it('parent 引用一并重编号到全局 ref', () => {
    const merged = mergeFrameSnapshots([
      frame(0, [entry(1, '主容器'), entry(2, '主子项', { parent: 1 })]),
      frame(5, [entry(1, '子容器'), entry(2, '子子项', { parent: 1 })]),
    ]);

    const subChild = merged.snapshot.entries.find((item) => item.label === '子子项');
    const subContainer = merged.snapshot.entries.find((item) => item.label === '子容器');
    // 重编号后必须指向同一 frame 内的容器，而不是主 frame 的 ref 1。
    expect(subChild?.parent).toBe(subContainer?.ref);
    expect(subChild?.parent).not.toBe(1);
  });

  it('parent 在本 frame 内解析不到时省略该字段', () => {
    const merged = mergeFrameSnapshots([frame(0, [entry(2, '孤儿', { parent: 99 })])]);

    expect(merged.snapshot.entries[0]).not.toHaveProperty('parent');
  });

  it('子 frame 的元素带上 frameId，主 frame 的省略', () => {
    const merged = mergeFrameSnapshots([frame(0, [entry(1, '主')]), frame(357, [entry(1, '子')])]);

    expect(merged.snapshot.entries[0]?.frameId).toBeUndefined();
    expect(merged.snapshot.entries[1]?.frameId).toBe(357);
  });

  it('url 与 title 取主 frame', () => {
    const merged = mergeFrameSnapshots([
      frame(9, [entry(1, '子')], { url: 'http://sub.example/inner', title: '子页' }),
      frame(0, [entry(1, '主')], { url: 'http://example/index', title: '主页' }),
    ]);

    expect(merged.snapshot.url).toBe('http://example/index');
    expect(merged.snapshot.title).toBe('主页');
  });

  it('没有主 frame 时退回第一个 frame 的 url', () => {
    const merged = mergeFrameSnapshots([frame(9, [entry(1, '子')], { url: 'http://sub.example/inner', title: '子页' })]);

    expect(merged.snapshot.url).toBe('http://sub.example/inner');
  });

  it('truncated 跨 frame 累加', () => {
    const merged = mergeFrameSnapshots([
      frame(0, [entry(1, '主')], { truncated: 12 }),
      frame(3, [entry(1, '子')], { truncated: 30 }),
    ]);

    expect(merged.snapshot.truncated).toBe(42);
  });

  it('无截断时不带 truncated 字段', () => {
    const merged = mergeFrameSnapshots([frame(0, [entry(1, '主')])]);

    expect(merged.snapshot).not.toHaveProperty('truncated');
  });

  it('保留 entry 的其余字段', () => {
    const merged = mergeFrameSnapshots([
      frame(0, [entry(1, '输入框', { tag: 'input', kind: 'textbox', value: 'abc', occluded: true, inPopup: true })]),
    ]);

    expect(merged.snapshot.entries[0]).toMatchObject({ tag: 'input', kind: 'textbox', value: 'abc', occluded: true, inPopup: true });
  });

  it('空输入返回空快照', () => {
    const merged = mergeFrameSnapshots([]);

    expect(merged.snapshot.entries).toEqual([]);
    expect(merged.owners.size).toBe(0);
  });

  it('跳过没有元素的 frame，不占用 ref 号', () => {
    const merged = mergeFrameSnapshots([frame(0, []), frame(2, [entry(1, '子')])]);

    expect(merged.snapshot.entries.map((item) => item.ref)).toEqual([1]);
    expect(merged.owners.get(1)).toEqual({ frameId: 2, localRef: 1 });
  });
});
