import type { PageSnapshotResult, SnapshotEntry } from '../types/cdp';

/**
 * 跨 frame 的 ref 命名空间。
 *
 * 每个 frame 的 content script 各自从 1 开始铸 ref，互相不知道对方铸了什么。
 * 合并快照时若直接拼接，同一个 ref 号会在多个 frame 里同时存在 —— 而解析 ref 时
 * 广播取「第一个命中的」，命中的往往是主 frame 那个同号元素。
 * 症状是「点了但点错、且不报错」：模型看到的 ref 和执行时解析的 ref 不是同一个元素。
 *
 * 所以合并时必须重编号成全局唯一，并记住每个全局 ref 属于哪个 frame、
 * 在那个 frame 里的本地号是多少，动作才能定向投递回去。
 */

/** 全局 ref 的归属。 */
export interface RefOwner {
  frameId: number;
  localRef: number;
}

/** 一个 frame 的快照及其来源 frameId。 */
export interface FrameSnapshot {
  frameId: number;
  result: PageSnapshotResult;
}

/** 合并结果：重编号后的快照 + 全局 ref 归属索引。 */
export interface MergedSnapshot {
  snapshot: PageSnapshotResult;
  owners: Map<number, RefOwner>;
}

/**
 * 合并多个 frame 的快照，把各 frame 的本地 ref 重编号为全局唯一。
 *
 * frame 内的 parent 引用同样要重编号 —— 漏掉它会让层级指向别的 frame 的元素。
 * parent 一律在同一 frame 内解析：跨 frame 的 DOM 父子关系表达不了，也不需要。
 */
export function mergeFrameSnapshots(snapshots: readonly FrameSnapshot[]): MergedSnapshot {
  const owners = new Map<number, RefOwner>();
  const entries: SnapshotEntry[] = [];
  let nextRef = 1;

  for (const { frameId, result } of snapshots) {
    // 先把本 frame 的本地 ref 全部映射好，再改写 entry —— parent 可能指向后面才出现的元素。
    const localToGlobal = new Map<number, number>();
    for (const entry of result.entries) {
      const globalRef = nextRef;
      nextRef += 1;
      localToGlobal.set(entry.ref, globalRef);
      owners.set(globalRef, { frameId, localRef: entry.ref });
    }

    for (const entry of result.entries) {
      const parent = entry.parent === undefined ? undefined : localToGlobal.get(entry.parent);
      const { parent: _dropped, ...rest } = entry;
      entries.push({
        ...rest,
        ref: localToGlobal.get(entry.ref) as number,
        // parent 解析不到时整个字段省略，不留悬空引用。
        ...(parent === undefined ? {} : { parent }),
        ...(frameId === 0 ? {} : { frameId }),
      });
    }
  }

  const main = snapshots.find((item) => item.frameId === 0) ?? snapshots[0];
  const truncated = snapshots.reduce((sum, item) => sum + (item.result.truncated ?? 0), 0);

  return {
    snapshot: {
      url: main?.result.url ?? '',
      title: main?.result.title ?? '',
      entries,
      ...(truncated > 0 ? { truncated } : {}),
    },
    owners,
  };
}
