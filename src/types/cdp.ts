/**
 * CDP 交互与 DOM 定位的共享契约。
 *
 * 坐标约定（全文件适用，也是整个方案最容易出错的地方）：
 * x / y 一律是相对**主页面 viewport** 的 CSS 像素，来自 getBoundingClientRect()，
 * 且**不乘 devicePixelRatio**。乘了 DPR 在 Retina 上会点到约两倍偏移处 ——
 * 因为往往仍落在页面某个元素上，症状是「点了但点错」而非报错，比崩溃更难查。
 */

/** 元素的语义角色。扩展据此选择对应的选择器列表。 */
export type ElementRole =
  | 'candidateListItem'
  | 'candidateName'
  | 'resumeContainer'
  | 'favoriteButton'
  | 'greetButton'
  | 'messageInput'
  | 'sendButton'
  | 'dialog';

/** 定位意图。selector 显式给出时优先于 role 对应的配置。 */
export interface ElementLocator {
  role: ElementRole;
  selector?: string;
  index?: number;
}

/** 元素矩形，CSS 像素。 */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 选择器命中来源。用于诊断「是用户配置生效了还是走了站点兜底」。 */
export type SelectorSource = 'user-config' | 'site-fallback';

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
  selectorSource?: SelectorSource;
  frameId?: string;
  /** 全部未命中时列出已尝试的选择器，便于用户调整配置。 */
  triedSelectors?: string[];
  message?: string;
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
  candidates?: Array<{ index: number; name: string; previewText: string }>;
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
