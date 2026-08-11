/**
 * CDP 交互与 DOM 定位的共享契约。
 *
 * 坐标约定（全文件适用，也是整个方案最容易出错的地方）：
 * x / y 一律是相对**主页面 viewport** 的 CSS 像素，来自 getBoundingClientRect()，
 * 且**不乘 devicePixelRatio**。乘了 DPR 在 Retina 上会点到约两倍偏移处 ——
 * 因为往往仍落在页面某个元素上，症状是「点了但点错」而非报错，比崩溃更难查。
 */

/**
 * 定位意图。两种方式，优先级从高到低：
 * 1. ref —— 来自 browser_snapshot 的元素引用，主路径
 * 2. selector —— 显式 CSS 选择器
 */
export interface ElementLocator {
  selector?: string;
  ref?: number;
  index?: number;
}

/**
 * 快照条目：一个可交互元素。
 *
 * ref 是稳定标识，坐标不是 —— 模型按 ref 指定目标，执行前再按 ref 取当前坐标。
 * 这样既保住「每步重新算坐标」的纪律，又不必让模型猜选择器。
 */
export interface SnapshotEntry {
  ref: number;
  tag: string;
  /** 可读标签：优先 aria-label / 文本 / placeholder / title / name。 */
  label: string;
  /** 元素类型提示，例如 button / link / textbox / checkbox。 */
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 是否被遮挡。被遮挡的元素不应直接点击。 */
  occluded?: boolean;
  disabled?: boolean;
  /** 输入类元素的当前值，便于模型判断是否需要先清空。 */
  value?: string;
  /** 最近的、本身也在快照里的祖先 ref。扁平列表靠它表达层级，比嵌套 JSON 省 token。 */
  parent?: number;
  /** aria-expanded 为真。配合 inPopup 让模型判断下拉是开还是关。 */
  expanded?: boolean;
  /** 位于弹层/浮层容器内。浮层存在本身就说明下拉已展开。 */
  inPopup?: boolean;
  /** 仅靠启发式识别（cursor:pointer 等），未命中显式可交互选择器，可能不可点。 */
  soft?: boolean;
  /** 元素所属 frame。主 frame 省略；子 frame 内的元素带上，便于排查坐标类问题。 */
  frameId?: number;
}

/** 页面快照。 */
export interface PageSnapshotResult {
  url: string;
  title: string;
  entries: SnapshotEntry[];
  /** 超出上限被省略的元素数量。必须告知模型，否则它会以为看到了全部。 */
  truncated?: number;
  /** 快照来源 frame 的可读标识，仅用于日志排查。frame 归属以 SnapshotEntry.frameId 为准。 */
  sourceFrame?: string;
  /** 有 frame 未返回内容时的提示。缺席的元素与「不存在」无法区分，必须显式告知模型。 */
  warning?: string;
}

/** 按 ref 取当前坐标的结果。 */
export interface RefResolution {
  found: boolean;
  /** 元素已从 DOM 卸载。模型应重新快照而不是重试。 */
  stale?: boolean;
  x?: number;
  y?: number;
  rect?: ElementRect;
  occluded?: boolean;
  occludedBy?: string;
  label?: string;
  message?: string;
  /** 元素所属 frame。动作要在这个 frame 里检查焦点、回读值。 */
  frameId?: number;
}

/** 元素矩形，CSS 像素。 */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 定位结果。坐标已换算到主页面坐标系。 */
export interface LocateResult {
  found: boolean;
  x?: number;
  y?: number;
  rect?: ElementRect;
  visible?: boolean;
  inViewport?: boolean;
  occluded?: boolean;
  occludedBy?: string;
  matchedSelector?: string;
  frameId?: string;
  /** 全部未命中时列出已尝试的选择器，便于用户调整配置。 */
  triedSelectors?: string[];
  message?: string;
}

/** 等待条件。appear / disappear 需要 selector；stable 等 DOM 停止变化。 */
export type WaitForCondition = 'appear' | 'disappear' | 'stable';

/** 等待请求。 */
export interface WaitForRequest {
  condition: WaitForCondition;
  selector?: string;
  timeoutMs?: number;
  /** stable 条件下判定「不再变化」的静默时长。 */
  stableMs?: number;
}

/** 等待结果。超时不算错误，satisfied=false 让模型据此改变策略。 */
export interface WaitForResult {
  satisfied: boolean;
  waitedMs: number;
  condition: WaitForCondition;
  observed: string;
}

/** 验证维度。 */
export type VerifyDimensionName =
  | 'dialogAppeared'
  | 'domChanged'
  | 'inputValue'
  | 'buttonEnabled'
  | 'networkRequest';

/** 单个维度的观测结果。 */
export interface VerifyDimension {
  dimension: VerifyDimensionName;
  passed: boolean;
  /** 实际观测值。失败时这是唯一能定位原因的信息，不能省。 */
  observed: string;
}

/** 验证请求。各字段可组合，只校验实际给出的维度。 */
export interface VerifyRequest {
  expectDialog?: string;
  expectDomChangeIn?: string;
  expectInputValue?: { selector: string; text: string };
  expectButtonEnabled?: string;
  expectNetwork?: { urlPattern: string; expectSuccess?: boolean };
  timeoutMs?: number;
}

/** 验证结果。 */
export interface VerifyResult {
  passed: boolean;
  dimensions: VerifyDimension[];
  timedOut?: boolean;
  message: string;
}

/** CDP 动作的通用结果。 */
export interface CdpActionResult {
  ok: boolean;
  message: string;
  /** 失败发生的阶段，例如 mousePressed。三段序列中途失败时用于定位。 */
  failedPhase?: string;
}

/** 文本输入结果，额外带焦点与回读值。 */
export interface CdpInputResult extends CdpActionResult {
  focused?: boolean;
  actualValue?: string;
}

/** 调试会话状态。 */
export interface DebugSessionState {
  attached: boolean;
  tabId?: number;
  attachedAt?: number;
  /** 断连原因，仅在会话已断开时有值。 */
  detachReason?: DetachReason;
}

/**
 * 断连原因。这三类对用户的含义完全不同，必须分开：
 * - canceled_by_user：用户点了调试横幅的关闭按钮
 * - replaced_with_devtools：用户为该标签页打开了 DevTools，抢占了唯一的调试客户端
 * - target_closed：标签页被关闭
 */
export type DetachReason =
  | 'canceled_by_user'
  | 'replaced_with_devtools'
  | 'target_closed'
  | 'task_completed'
  | 'task_failed'
  | 'stopped_by_user'
  | 'unknown';

/** 页面只读快照。 */
export interface PageSnapshot {
  title: string;
  url: string;
  bodyPreview: string;
  /** 有 frame 未返回内容时的提示，避免把「读不到」当成「页面上没有」。 */
  warning?: string;
}

/** CDP Network 域观测到的请求。用于验证写操作是否真的产生了副作用。 */
export interface ObservedRequest {
  url: string;
  method: string;
  status?: number;
  failed?: boolean;
  timestamp: number;
}

/** CDP 协议版本。1.3 是当前稳定版。 */
export const CDP_PROTOCOL_VERSION = '1.3';

/** 各验证维度的默认等待上限。POC 实测后应据实际耗时分布调整（任务 11.6）。 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 5000;

/** 验证轮询间隔。 */
export const VERIFY_POLL_INTERVAL_MS = 120;

/** browser_wait_for 的默认等待上限。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 5000;

/** stable 条件下判定「不再变化」的默认静默时长。 */
export const DEFAULT_STABLE_MS = 500;
