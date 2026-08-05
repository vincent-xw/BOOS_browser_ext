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
  PageSnapshotResult,
  RefResolution,
  SelectorSource,
  SnapshotEntry,
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
 *
 * 三条路径：ref（自由指令主路径）> selector（显式）> role（预设兜底）。
 * role 路径固定「用户配置优先、站点 fallback 兜底」，两者都不得省略。
 */
export function locateElement(locator: ElementLocator, config: LocatorSelectorConfig = {}): LocateResult {
  // ref 路径：元素引用已在快照时登记，直接取当前坐标。
  if (typeof locator.ref === 'number') {
    const resolved = resolveRef(locator.ref);
    if (!resolved.found) {
      return { found: false, message: resolved.message ?? `ref ${locator.ref} 已失效，请重新快照。` };
    }
    return {
      found: true,
      ...(resolved.x === undefined ? {} : { x: resolved.x }),
      ...(resolved.y === undefined ? {} : { y: resolved.y }),
      ...(resolved.rect ? { rect: resolved.rect } : {}),
      visible: true,
      inViewport: true,
      ...(resolved.occluded === undefined ? {} : { occluded: resolved.occluded }),
      ...(resolved.occludedBy ? { occludedBy: resolved.occludedBy } : {}),
      matchedSelector: `ref:${locator.ref}`,
      message: resolved.message ?? '按 ref 定位成功。',
    };
  }

  const explicit = locator.selector ? [locator.selector] : [];
  const userList = locator.role ? parseSelectorList(config.userSelectors?.[locator.role]) : [];
  const fallbackList = locator.role ? parseSelectorList(ROLE_FALLBACK_SELECTORS[locator.role]) : [];
  const attempts: Array<{ selector: string; source: SelectorSource }> = [
    ...explicit.map((selector) => ({ selector, source: 'user-config' as const })),
    ...userList.map((selector) => ({ selector, source: 'user-config' as const })),
    ...fallbackList.map((selector) => ({ selector, source: 'site-fallback' as const })),
  ];

  if (attempts.length === 0) {
    return { found: false, message: '定位请求既未给出 ref、也未给出 selector 或 role。' };
  }

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
    message: `未定位到 ${locator.role ?? locator.selector}，已尝试 ${tried.length} 个选择器。请检查选择器配置。`,
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

// ── 快照与 ref 引用 ────────────────────────────────────────────────

/**
 * ref → 元素 的注册表。
 *
 * 自由指令下模型无从猜测选择器，所以改为：快照给每个可交互元素分配一个 ref，
 * 模型按 ref 指定目标，执行动作前再按 ref 取**当前**坐标。
 * 坐标会因弹窗/滚动/重渲染失效，元素引用不会 —— 这样既保住了「每步重算坐标」，
 * 又不需要模型碰选择器。
 */
const refRegistry = new Map<number, WeakRef<Element>>();
let nextRef = 1;

/** 可交互元素的选择器。覆盖原生控件与常见的 ARIA / 可点击容器。 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[contenteditable=true]',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=combobox]',
  '[role=searchbox]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** 快照单页最多返回的元素数。超出会截断并告知模型。 */
const SNAPSHOT_LIMIT = 150;

/** 推断元素类型，供模型判断该用什么动作。 */
function inferKind(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  if (role) return role;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (element as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') return type;
    return 'textbox';
  }
  if (element instanceof HTMLElement && element.isContentEditable) return 'textbox';
  return 'clickable';
}

/**
 * 元素的可读标签。
 * 按可靠性排序取第一个非空值；文本兜底时压缩空白并截断，避免整段正文进快照。
 */
function inferLabel(element: Element): string {
  const candidates = [
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
    element.getAttribute('title'),
    element.getAttribute('alt'),
    element.getAttribute('value'),
    element.getAttribute('name'),
    (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
  ];
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text.slice(0, 80);
  }
  return `(${element.tagName.toLowerCase()})`;
}

/**
 * 快照当前页面的可交互元素。
 *
 * 只收视口内可见的元素：视口外的元素坐标无意义，且会把快照撑爆。
 * 模型需要更多内容时可以先 scroll 再重新快照。
 */
export function snapshotInteractive(): PageSnapshotResult {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const offsets = frameOffsets();
  const entries: SnapshotEntry[] = [];
  let skipped = 0;

  let elements: Element[];
  try {
    elements = [...document.querySelectorAll(INTERACTIVE_SELECTOR)];
  } catch {
    elements = [];
  }

  for (const element of elements) {
    if (!isVisible(element)) continue;
    const rect = toRect(element);
    if (!isRectInViewport(rect, viewport)) continue;
    if (entries.length >= SNAPSHOT_LIMIT) {
      skipped += 1;
      continue;
    }

    const ref = nextRef;
    nextRef += 1;
    refRegistry.set(ref, new WeakRef(element));

    const center = roundPoint(elementCenterInMainFrame(rect, offsets));
    const localCenter = roundPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const occlusion = detectOcclusion(element, localCenter);
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : undefined;

    entries.push({
      ref,
      tag: element.tagName.toLowerCase(),
      label: inferLabel(element),
      kind: inferKind(element),
      x: center.x,
      y: center.y,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      ...(occlusion.occluded ? { occluded: true } : {}),
      ...(isDisabled(element) ? { disabled: true } : {}),
      ...(value ? { value: value.slice(0, 120) } : {}),
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    entries,
    ...(skipped > 0 ? { truncated: skipped } : {}),
    frameId: window === window.top ? 'main' : window.location.href,
  };
}

/**
 * 按 ref 取当前坐标。
 * 元素已从 DOM 卸载时返回 stale，让模型重新快照而不是拿旧坐标重试。
 */
export function resolveRef(ref: number): RefResolution {
  const held = refRegistry.get(ref);
  const element = held?.deref();
  if (!element) {
    refRegistry.delete(ref);
    return { found: false, stale: true, message: `ref ${ref} 已失效（元素被回收），请重新快照。` };
  }
  if (!element.isConnected) {
    refRegistry.delete(ref);
    return { found: false, stale: true, message: `ref ${ref} 指向的元素已从页面移除，请重新快照。` };
  }
  if (!isVisible(element)) {
    return { found: false, message: `ref ${ref} 指向的元素当前不可见。` };
  }

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  let rect = toRect(element);
  // 不在视口内先滚入，再重算 —— 滚动会改变坐标。
  if (!isRectInViewport(rect, viewport)) {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    rect = toRect(element);
  }

  const center = roundPoint(elementCenterInMainFrame(rect, frameOffsets()));
  const localCenter = roundPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const occlusion = detectOcclusion(element, localCenter);

  return {
    found: true,
    x: center.x,
    y: center.y,
    rect,
    occluded: occlusion.occluded,
    ...(occlusion.occludedBy ? { occludedBy: occlusion.occludedBy } : {}),
    label: inferLabel(element),
    message: occlusion.occluded ? `元素被 ${occlusion.occludedBy} 遮挡，不应直接点击。` : '按 ref 取坐标成功。',
  };
}

/** 清空 ref 注册表。页面导航后调用，避免旧 ref 命中新页面的元素。 */
export function clearRefRegistry(): void {
  refRegistry.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
