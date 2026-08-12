/**
 * 快照候选元素的分类与排序。
 *
 * 这里刻意只处理**纯数据**，不碰 DOM —— 扩展的测试跑在 node 环境（无 jsdom），
 * 把判定逻辑从 domLocator 抽出来才测得到。domLocator 负责读 DOM 生成描述对象，
 * 本模块负责「这算不算可交互」「谁该排前面」。
 */

/** 元素的可交互性层级。数字小的排前面。 */
export const TIER_EXPLICIT = 0;
export const TIER_SOFT = 1;

/** 从 DOM 读出的元素描述。domLocator 负责填，本模块只做判断。 */
export interface CandidateDescriptor {
  /** 是否命中显式可交互选择器（button / a[href] / [role=button] 等）。 */
  explicit: boolean;
  /** aria-expanded 的原始值。 */
  ariaExpanded?: string | null;
  /** getComputedStyle().cursor。 */
  cursor?: string;
  /** 是否位于弹层容器内。 */
  inPopupContainer: boolean;
}

/** 分类结果，直接对应快照条目上的字段。 */
export interface CandidateClass {
  tier: number;
  /** 是否收录。启发式不成立且非显式可交互时为 false。 */
  include: boolean;
  expanded?: boolean;
  soft?: boolean;
  inPopup?: boolean;
}

/**
 * 判断一个候选元素是否收录、以及带哪些标记。
 *
 * 收录条件：命中显式选择器，或位于弹层内，或 cursor 表明可点。
 * 弹层内的元素即使没有任何 ARIA 属性也要收 —— 各种 UI 库的下拉项
 * （如 el-select-dropdown__item）正是这一类，它们此前完全进不了快照。
 */
export function classifyCandidate(descriptor: CandidateDescriptor): CandidateClass {
  const expanded = descriptor.ariaExpanded === 'true';
  const clickableCursor = descriptor.cursor === 'pointer';

  if (descriptor.explicit) {
    return {
      tier: TIER_EXPLICIT,
      include: true,
      ...(expanded ? { expanded: true } : {}),
      ...(descriptor.inPopupContainer ? { inPopup: true } : {}),
    };
  }

  // 非显式可交互：只有「在弹层里」或「cursor 表明可点」才值得占用快照名额。
  if (!descriptor.inPopupContainer && !clickableCursor) {
    return { tier: TIER_SOFT, include: false };
  }

  return {
    tier: TIER_SOFT,
    include: true,
    soft: true,
    ...(expanded ? { expanded: true } : {}),
    ...(descriptor.inPopupContainer ? { inPopup: true } : {}),
  };
}

/** 参与排序的候选。 */
export interface RankableCandidate {
  /** 文档顺序，稳定兜底用。 */
  index: number;
  inPopup: boolean;
  /** 与当前焦点元素处于同一区域。 */
  nearFocus: boolean;
  tier: number;
}

/**
 * 快照候选的排序：决定 SNAPSHOT_LIMIT 截断时谁能留下。
 *
 * 弹层内优先 —— 用户刚点开的浮层是当下最相关的东西，而它恰恰最容易
 * 因为在文档末尾（portal 到 body）被上限截掉。
 */
export function compareSnapshotCandidates(a: RankableCandidate, b: RankableCandidate): number {
  if (a.inPopup !== b.inPopup) return a.inPopup ? -1 : 1;
  if (a.nearFocus !== b.nearFocus) return a.nearFocus ? -1 : 1;
  if (a.tier !== b.tier) return a.tier - b.tier;
  return a.index - b.index;
}
