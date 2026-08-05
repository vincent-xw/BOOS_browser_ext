/**
 * content script 侧的只读能力：DOM 读取、元素定位、坐标计算、结果验证。
 *
 * 这个文件里**不存在任何页面写操作**。没有 element.click()、没有 dispatchEvent、
 * 没有 value 赋值。这不是纪律要求而是结构要求：写能力一旦在 content script 里可达，
 * 下次调试时随手加一句 el.click() 兜底就会把方案滑回合成事件 —— 现有代码就是这么长出来的。
 * 所有写操作都必须经 Service Worker 的 CDP 通道。
 */

import { DEFAULT_VERIFY_TIMEOUT_MS, VERIFY_POLL_INTERVAL_MS } from '../types/cdp';
import type {
  ElementLocator,
  ElementRect,
  ElementRole,
  LocateResult,
  PageSnapshot,
  SelectorSource,
  VerifyDimension,
  VerifyRequest,
  VerifyResult,
} from '../types/cdp';
import { elementCenterInMainFrame, isRectInViewport, roundPoint } from './coordinates';
import type { FrameOffset } from './coordinates';

/** 各角色的站点兜底选择器。用户配置未命中时使用，不得移除。 */
export const ROLE_FALLBACK_SELECTORS: Record<ElementRole, string> = {
  candidateListItem: 'li.card-item, .card-item, .job-card-wrapper, .candidate-item, .geek-item',
  candidateName: '.name, .geek-name, .candidate-name',
  resumeContainer: '#resume, canvas#resume, .resume-item, .resume-detail-wrap, .geek-resume-container, .resume-box',
  favoriteButton: '.like-icon-and-text, button[ka=like], .btn-like, .btn-collect, .collect-btn, [data-action=favorite]',
  greetButton: 'button[ka=chat], .btn-greet, .btn-chat, .start-chat-btn, [ka*=greet]',
  messageInput: 'textarea.input-area, .chat-input textarea, [contenteditable=true].chat-input, textarea[placeholder*=消息]',
  sendButton: '.btn-send, button[type=submit].send, [ka=send-message]',
  dialog: '.dialog-wrap.active, .boss-dialog__wrapper, .lib-resume-recommend, .greet-dialog',
};

/** 解析逗号分隔的选择器列表，去空去重。 */
export function parseSelectorList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** 元素是否可见。零尺寸、display:none、visibility:hidden、opacity:0 都算不可见。 */
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

/** 取元素矩形，转为纯数据对象。 */
function toRect(element: Element): ElementRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** 元素的简短描述，用于遮挡报告。 */
function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const className = typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/).join('.')}` : '';
  return `${element.tagName.toLowerCase()}${id}${className}`.slice(0, 120);
}

/**
 * 当前 frame 相对主页面的偏移链。
 * 跨 frame 时逐层向上累加 frameElement 的位置，把坐标换算到主页面坐标系。
 */
function frameOffsets(): FrameOffset[] {
  const offsets: FrameOffset[] = [];
  let currentWindow: Window = window;
  // 跨源 frame 访问 parent 会抛异常；捕获后停止上溯，用已知的偏移尽力换算。
  try {
    while (currentWindow !== currentWindow.parent) {
      const frameElement = currentWindow.frameElement;
      if (!frameElement) break;
      const rect = frameElement.getBoundingClientRect();
      offsets.unshift({ x: rect.x, y: rect.y });
      currentWindow = currentWindow.parent;
    }
  } catch {
    // 跨源边界，保留已收集的偏移。
  }
  return offsets;
}

/** 中心点命中测试：返回的不是目标元素或其后代，即判定被遮挡。 */
function detectOcclusion(element: Element, point: { x: number; y: number }): { occluded: boolean; occludedBy?: string } {
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit) return { occluded: true, occludedBy: '(视口外或无命中)' };
  if (hit === element || element.contains(hit) || hit.contains(element)) return { occluded: false };
  return { occluded: true, occludedBy: describeElement(hit) };
}

/** 定位所需的用户配置选择器，按角色给出。 */
export interface LocatorSelectorConfig {
  userSelectors?: Partial<Record<ElementRole, string>>;
}

/**
 * 定位元素并返回坐标与可点击性判定。
 * 顺序固定：用户配置优先、站点 fallback 兜底 —— 两者都不得省略。
 */
export function locateElement(locator: ElementLocator, config: LocatorSelectorConfig = {}): LocateResult {
  const explicit = locator.selector ? [locator.selector] : [];
  const userList = parseSelectorList(config.userSelectors?.[locator.role]);
  const fallbackList = parseSelectorList(ROLE_FALLBACK_SELECTORS[locator.role]);
  const attempts: Array<{ selector: string; source: SelectorSource }> = [
    ...explicit.map((selector) => ({ selector, source: 'user-config' as const })),
    ...userList.map((selector) => ({ selector, source: 'user-config' as const })),
    ...fallbackList.map((selector) => ({ selector, source: 'site-fallback' as const })),
  ];

  const tried: string[] = [];
  for (const attempt of attempts) {
    tried.push(attempt.selector);
    let matches: Element[];
    try {
      matches = [...document.querySelectorAll(attempt.selector)];
    } catch {
      // 非法选择器不应中断整条尝试链，跳过继续。
      continue;
    }
    const visibleMatches = matches.filter(isVisible);
    const target = visibleMatches[locator.index ?? 0];
    if (!target) continue;
    return describeTarget(target, attempt.selector, attempt.source);
  }

  return {
    found: false,
    triedSelectors: tried,
    message: `未定位到 ${locator.role}，已尝试 ${tried.length} 个选择器。请检查选择器配置。`,
  };
}

/** 生成定位结果。元素不在视口内时先滚入视口再重算坐标。 */
function describeTarget(element: Element, matchedSelector: string, selectorSource: SelectorSource): LocateResult {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  let rect = toRect(element);

  // 不在视口内则滚入后重算 —— 滚动会改变坐标，不能沿用滚动前的值。
  if (!isRectInViewport(rect, viewport)) {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    rect = toRect(element);
  }

  const offsets = frameOffsets();
  const center = roundPoint(elementCenterInMainFrame(rect, offsets));
  // 命中测试用 frame 内的局部坐标，因为 elementFromPoint 是相对当前 frame 的。
  const localCenter = roundPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const occlusion = detectOcclusion(element, localCenter);

  return {
    found: true,
    x: center.x,
    y: center.y,
    rect,
    visible: isVisible(element),
    inViewport: isRectInViewport(rect, viewport),
    occluded: occlusion.occluded,
    ...(occlusion.occludedBy ? { occludedBy: occlusion.occludedBy } : {}),
    matchedSelector,
    selectorSource,
    frameId: window === window.top ? 'main' : (window.location.href || 'sub-frame'),
    message: occlusion.occluded ? `元素中心点被 ${occlusion.occludedBy} 遮挡，不应直接点击。` : '定位成功。',
  };
}

/** 读取页面快照。 */
export function readPageSnapshot(includeCandidateList = false, listSelector?: string, nameSelector?: string): PageSnapshot {
  const snapshot: PageSnapshot = {
    title: document.title,
    url: window.location.href,
    bodyPreview: (document.body?.innerText ?? '').slice(0, 2000),
  };
  if (!includeCandidateList) return snapshot;

  const selectors = [...parseSelectorList(listSelector), ...parseSelectorList(ROLE_FALLBACK_SELECTORS.candidateListItem)];
  const nameSelectors = [...parseSelectorList(nameSelector), ...parseSelectorList(ROLE_FALLBACK_SELECTORS.candidateName)];
  for (const selector of selectors) {
    let items: Element[];
    try {
      items = [...document.querySelectorAll(selector)];
    } catch {
      continue;
    }
    if (items.length === 0) continue;
    snapshot.candidates = items.map((item, index) => ({
      index,
      name: firstText(item, nameSelectors),
      previewText: (item.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    }));
    break;
  }
  return snapshot;
}

function firstText(scope: Element, selectors: string[]): string {
  for (const selector of selectors) {
    try {
      const found = scope.querySelector(selector);
      const text = found?.textContent?.trim();
      if (text) return text;
    } catch {
      continue;
    }
  }
  return '';
}

/** 元素是否处于禁用态。同时看 disabled 属性与常见禁用类名。 */
function isDisabled(element: Element): boolean {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return true;
  const className = typeof element.className === 'string' ? element.className : '';
  return /\b(disabled|is-disabled|btn-disabled|gray)\b/.test(className);
}

/** 读取输入框当前值，兼容 contenteditable。 */
function readInputValue(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  return (element as HTMLElement).innerText ?? element.textContent ?? '';
}

/** 元素的可比较状态快照，用于 DOM 变化判定。 */
function stateOf(selector: string): string {
  const element = safeQuery(selector);
  if (!element) return '(不存在)';
  const className = typeof element.className === 'string' ? element.className : '';
  return `${(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}|${className}`;
}

function safeQuery(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * 多维度结果验证。
 *
 * 轮询直到全部维度满足或超时。不用固定 setTimeout：快的时候白等、慢的时候不够，两头都错。
 * 「命令没报错」不是成功判据 —— 这是当前实现最大的可靠性缺口。
 */
export async function verify(request: VerifyRequest, baseline?: Record<string, string>): Promise<VerifyResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let dimensions: VerifyDimension[] = [];

  for (;;) {
    dimensions = evaluate(request, baseline);
    if (dimensions.length === 0) {
      return { passed: false, dimensions, message: '未指定任何验证维度，无法判定动作是否生效。' };
    }
    // 条件提前满足就立刻返回，不消耗剩余等待时间。
    if (dimensions.every((dimension) => dimension.passed)) {
      return { passed: true, dimensions, message: '全部验证维度均已通过。' };
    }
    if (Date.now() >= deadline) {
      const failed = dimensions.filter((dimension) => !dimension.passed).map((dimension) => `${dimension.dimension}=${dimension.observed}`);
      return {
        passed: false,
        dimensions,
        timedOut: true,
        message: `等待 ${timeoutMs}ms 后仍未满足：${failed.join('；')}`,
      };
    }
    await sleep(VERIFY_POLL_INTERVAL_MS);
  }
}

/** 逐维度求值。只评估调用方实际给出的维度。 */
function evaluate(request: VerifyRequest, baseline?: Record<string, string>): VerifyDimension[] {
  const dimensions: VerifyDimension[] = [];

  if (request.expectDialog) {
    const dialog = safeQuery(request.expectDialog);
    const visible = Boolean(dialog && isVisible(dialog));
    dimensions.push({ dimension: 'dialogAppeared', passed: visible, observed: visible ? '弹窗已出现' : '弹窗未出现' });
  }

  if (request.expectDomChangeIn) {
    const current = stateOf(request.expectDomChangeIn);
    const before = baseline?.[request.expectDomChangeIn];
    const changed = before !== undefined && before !== current;
    dimensions.push({
      dimension: 'domChanged',
      passed: changed,
      observed: before === undefined ? '缺少变更前基线，无法判定' : changed ? '已变化' : `未变化（${current.slice(0, 80)}）`,
    });
  }

  if (request.expectInputValue) {
    const input = safeQuery(request.expectInputValue.selector);
    const actual = input ? readInputValue(input) : '';
    const matched = actual.trim() === request.expectInputValue.text.trim();
    dimensions.push({
      dimension: 'inputValue',
      passed: matched,
      observed: input ? `实际值="${actual.slice(0, 120)}"` : '未找到输入框',
    });
  }

  if (request.expectButtonEnabled) {
    const button = safeQuery(request.expectButtonEnabled);
    const enabled = Boolean(button && !isDisabled(button));
    dimensions.push({
      dimension: 'buttonEnabled',
      passed: enabled,
      observed: button ? (enabled ? '按钮可用' : '按钮仍为禁用态') : '未找到按钮',
    });
  }

  return dimensions;
}

/** 采集变更前基线，供 domChanged 维度比对。 */
export function captureBaseline(selectors: string[]): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const selector of selectors) baseline[selector] = stateOf(selector);
  return baseline;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
