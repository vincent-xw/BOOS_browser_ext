/**
 * content script 侧的只读能力：DOM 读取、元素定位、坐标计算、结果验证。
 *
 * 这个文件里**不存在任何页面写操作**。没有 element.click()、没有 dispatchEvent、
 * 没有 value 赋值。这不是纪律要求而是结构要求：写能力一旦在 content script 里可达，
 * 下次调试时随手加一句 el.click() 兜底就会把方案滑回合成事件 —— 现有代码就是这么长出来的。
 * 所有写操作都必须经 Service Worker 的 CDP 通道。
 */

import { DEFAULT_STABLE_MS, DEFAULT_VERIFY_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS, VERIFY_POLL_INTERVAL_MS } from '../types/cdp';
import type {
  ElementLocator,
  ElementRect,
  LocateResult,
  PageSnapshot,
  PageSnapshotResult,
  RefResolution,
  SnapshotEntry,
  VerifyDimension,
  VerifyRequest,
  VerifyResult,
  WaitForRequest,
  WaitForResult,
} from '../types/cdp';
import { elementCenterInMainFrame, isRectInViewport, roundPoint } from './coordinates';
import type { FrameOffset } from './coordinates';
import { classifyCandidate, compareSnapshotCandidates } from './snapshotRanking';
import type { RankableCandidate } from './snapshotRanking';

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

/**
 * 元素是否可见，并把 computedStyle 一起带出来。
 *
 * 合并返回是为了性能：getComputedStyle 是快照里最贵的调用，而 cursor 启发式
 * 也需要它。复用同一个 style 对象，启发式判定几乎不增加额外开销。
 * 调用方应先用矩形排除零尺寸元素 —— 那一步不读样式，能挡掉绝大多数节点。
 */
function inspectVisibility(element: Element): { visible: boolean; style: CSSStyleDeclaration } {
  const style = window.getComputedStyle(element);
  const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  return { visible, style };
}

/** 元素是否可见。零尺寸、display:none、visibility:hidden、opacity:0 都算不可见。 */
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return inspectVisibility(element).visible;
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

/**
 * 命中测试：返回的不是目标元素或其后代，即判定被遮挡。
 *
 * 用 elementsFromPoint（复数）遍历整条命中栈，跳过 pointer-events:none 的节点 ——
 * portal 下拉常在选项上方铺一层透明的全屏 backdrop，用单点 elementFromPoint 会
 * 把每个选项都判成被遮挡，而 toolExecutor 遇到遮挡直接硬失败，动作根本发不出去。
 */
function detectOcclusion(element: Element, point: { x: number; y: number }): { occluded: boolean; occludedBy?: string } {
  const stack = document.elementsFromPoint(point.x, point.y);
  if (stack.length === 0) return { occluded: true, occludedBy: '(视口外或无命中)' };

  for (const hit of stack) {
    if (hit === element || element.contains(hit) || hit.contains(element)) return { occluded: false };
    // 穿透鼠标事件的节点不构成遮挡，正是透明 backdrop 这一类。
    if (window.getComputedStyle(hit).pointerEvents === 'none') continue;
    return { occluded: true, occludedBy: describeElement(hit) };
  }

  return { occluded: true, occludedBy: '(命中栈中无目标元素)' };
}

/**
 * 遮挡判定，中心点被压住时再探一个偏移点。
 *
 * 图标、角标之类压住正中心的情况很常见，单点判定会误报，而误报的代价是动作被拦。
 */
function detectOcclusionWithFallback(element: Element, rect: ElementRect): { occluded: boolean; occludedBy?: string } {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const primary = detectOcclusion(element, center);
  if (!primary.occluded) return primary;

  const offset = { x: rect.x + rect.width * 0.25, y: rect.y + rect.height * 0.25 };
  const secondary = detectOcclusion(element, offset);
  return secondary.occluded ? primary : secondary;
}

/**
 * 定位元素并返回坐标与可点击性判定。
 *
 * 两条路径：ref（来自 browser_snapshot，主路径）与显式 CSS 选择器。
 * 早先的 role 路径（BOSS 预设角色 + 站点兜底选择器）已随预设流程一并移除 ——
 * 自由指令下模型用 ref 指定目标，不需要预置角色枚举。
 */
export function locateElement(locator: ElementLocator): LocateResult {
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

  const attempts = parseSelectorList(locator.selector);
  if (attempts.length === 0) {
    return { found: false, message: '定位请求既未给出 ref，也未给出 selector。建议先调用 browser_snapshot 取 ref。' };
  }

  const tried: string[] = [];
  for (const selector of attempts) {
    tried.push(selector);
    let matches: Element[];
    try {
      matches = [...document.querySelectorAll(selector)];
    } catch {
      // 非法选择器不应中断整条尝试链，跳过继续。
      continue;
    }
    const visibleMatches = matches.filter(isVisible);
    const target = visibleMatches[locator.index ?? 0];
    if (!target) continue;
    return describeTarget(target, selector);
  }

  return {
    found: false,
    triedSelectors: tried,
    message: `未定位到 ${locator.selector}，已尝试 ${tried.length} 个选择器。`,
  };
}

/** 生成定位结果。元素不在视口内时先滚入视口再重算坐标。 */
function describeTarget(element: Element, matchedSelector: string): LocateResult {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  let rect = toRect(element);

  // 不在视口内则滚入后重算 —— 滚动会改变坐标，不能沿用滚动前的值。
  if (!isRectInViewport(rect, viewport)) {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    rect = toRect(element);
  }

  const offsets = frameOffsets();
  const center = roundPoint(elementCenterInMainFrame(rect, offsets));
  const occlusion = detectOcclusionWithFallback(element, rect);

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
    frameId: window === window.top ? 'main' : (window.location.href || 'sub-frame'),
    message: occlusion.occluded ? `元素中心点被 ${occlusion.occludedBy} 遮挡，不应直接点击。` : '定位成功。',
  };
}

/** 读取页面快照：标题、URL 与正文摘要。 */
export function readPageSnapshot(): PageSnapshot {
  return {
    title: document.title,
    url: window.location.href,
    bodyPreview: (document.body?.innerText ?? '').slice(0, 2000),
  };
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

/**
 * 等待页面达到某状态。
 *
 * 下拉/浮层类交互普遍是异步的：点开之后有动画，或者选项要等接口回来才渲染。
 * 没有这个工具，模型只能靠「再快照一次」自觉重试，经常拍到半渲染的中间态。
 *
 * 超时**不抛错**，返回 satisfied=false —— 预期变化没发生本身就是有用的观测结果，
 * 抛错只会让模型以为工具坏了。
 */
export async function waitFor(request: WaitForRequest): Promise<WaitForResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const elapsed = (): number => Date.now() - startedAt;

  if (request.condition === 'stable') {
    return waitForStable(request.stableMs ?? DEFAULT_STABLE_MS, deadline, startedAt);
  }

  const selector = request.selector?.trim();
  if (!selector) {
    return {
      satisfied: false,
      waitedMs: 0,
      condition: request.condition,
      observed: `condition=${request.condition} 需要提供 selector。`,
    };
  }

  const wantVisible = request.condition === 'appear';
  for (;;) {
    const present = queryAll(selector).some(isVisible);
    if (present === wantVisible) {
      return {
        satisfied: true,
        waitedMs: elapsed(),
        condition: request.condition,
        observed: wantVisible ? `${selector} 已出现` : `${selector} 已消失`,
      };
    }
    if (Date.now() >= deadline) {
      return {
        satisfied: false,
        waitedMs: elapsed(),
        condition: request.condition,
        observed: wantVisible ? `等待 ${timeoutMs}ms 后 ${selector} 仍未出现` : `等待 ${timeoutMs}ms 后 ${selector} 仍然存在`,
      };
    }
    await sleep(VERIFY_POLL_INTERVAL_MS);
  }
}

/**
 * 等 DOM 停止变化：连续 stableMs 内没有 mutation 即认为稳定。
 *
 * 页面上有轮询定时器时永远不会静默，此时会耗到超时并返回 satisfied=false ——
 * 这是有意的，让模型知道「页面一直在变」而不是无限等下去。
 */
function waitForStable(stableMs: number, deadline: number, startedAt: number): Promise<WaitForResult> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => restartQuietTimer());

    const finish = (satisfied: boolean, observed: string): void => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      observer.disconnect();
      resolve({ satisfied, waitedMs: Date.now() - startedAt, condition: 'stable', observed });
    };

    function restartQuietTimer(): void {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true, `DOM 连续 ${stableMs}ms 未变化`), stableMs);
    }

    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    restartQuietTimer();

    const remaining = Math.max(0, deadline - Date.now());
    deadlineTimer = setTimeout(() => finish(false, `等待期间 DOM 持续变化，未出现 ${stableMs}ms 的静默窗口`), remaining);
  });
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
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=combobox]',
  '[role=searchbox]',
  '[role=option]',
  '[role=treeitem]',
  '[role=switch]',
  '[aria-expanded]',
  '[aria-haspopup]',
  '[aria-selected]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 弹层/浮层容器。各种 UI 库的下拉都会 portal 到 body 下的这类容器里。
 *
 * 这是本方案的关键：Element UI 的 li.el-select-dropdown__item 没有 href / role /
 * onclick / tabindex，一条显式选择器都不匹配，此前完全进不了快照 —— 模型看不见，
 * 只能瞎猜坐标。改为「先找浮层容器，再扫容器内的条目」把它们捞出来。
 */
const POPUP_CONTAINER_SELECTOR = [
  '[role=listbox]',
  '[role=menu]',
  '[role=dialog]',
  '[role=tree]',
  '[aria-modal=true]',
  '[class*=dropdown]',
  '[class*=popper]',
  '[class*=popover]',
  '[class*=select]',
  '[class*=picker]',
  '[class*=cascader]',
].join(',');

/** 浮层内的候选条目。范围窄，只在已确认可见的浮层容器内使用。 */
const POPUP_ITEM_SELECTOR = ['li', '[class*=option]', '[class*=item]', '[class*=cell]'].join(',');

/**
 * cursor 探测的候选标签。
 *
 * 自定义控件多是 div/span 加事件监听，没有任何可被选择器识别的语义标记，
 * 只能靠 cursor:pointer 认出来。范围限定在这些常见容器标签，不扫全部元素。
 */
const CURSOR_PROBE_SELECTOR = ['div', 'span', 'li', 'td', 'label', 'p'].join(',');

/**
 * cursor 探测的候选上限。
 *
 * getComputedStyle 是快照里最贵的调用，绝不能全文档扫 div/span。这个上限只作用于
 * 浮层内候选，正常页面远达不到。
 */
const CURSOR_PROBE_LIMIT = 400;

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
  const labelSources = [
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
    element.getAttribute('title'),
    element.getAttribute('alt'),
    element.getAttribute('value'),
    element.getAttribute('name'),
    (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
  ];
  for (const source of labelSources) {
    const text = source?.trim();
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
  const activeElement = document.activeElement;

  const candidates = collectCandidates(viewport, activeElement);
  // 排序决定截断时谁能留下：浮层内的元素往往在文档末尾（portal 到 body），
  // 不排序就会被上限砍掉 —— 而它恰恰是用户刚点开、当下最相关的东西。
  candidates.sort(compareSnapshotCandidates);

  const kept = candidates.slice(0, SNAPSHOT_LIMIT);
  const skipped = candidates.length - kept.length;

  // ref 在截断之后才铸：在扫描过程中铸会让被丢弃的元素白占 ref 号。
  const refByElement = new Map<Element, number>();
  for (const candidate of kept) {
    const ref = nextRef;
    nextRef += 1;
    refRegistry.set(ref, new WeakRef(candidate.element));
    refByElement.set(candidate.element, ref);
  }

  const entries: SnapshotEntry[] = kept.map((candidate) => {
    const { element, rect } = candidate;
    const center = roundPoint(elementCenterInMainFrame(rect, offsets));
    const occlusion = detectOcclusionWithFallback(element, rect);
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : undefined;
    const parent = findParentRef(element, refByElement);

    return {
      ref: refByElement.get(element) as number,
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
      ...(parent === undefined ? {} : { parent }),
      ...(candidate.expanded ? { expanded: true } : {}),
      ...(candidate.inPopup ? { inPopup: true } : {}),
      ...(candidate.soft ? { soft: true } : {}),
    };
  });

  return {
    url: window.location.href,
    title: document.title,
    entries,
    ...(skipped > 0 ? { truncated: skipped } : {}),
    frameId: window === window.top ? 'main' : window.location.href,
  };
}

/** 快照候选：DOM 引用 + 排序所需的元数据。 */
interface SnapshotCandidate extends RankableCandidate {
  element: Element;
  rect: ElementRect;
  expanded?: boolean;
  soft?: boolean;
}

/**
 * 收集候选元素：显式可交互 + 浮层内条目。
 *
 * 分两阶段是为了性能。阶段一是纯 CSS 匹配；阶段二只在**已确认可见**的浮层容器内
 * 扫描，cursor 探测也只在这个范围内做，绝不全文档扫 div/span。
 */
function collectCandidates(viewport: { width: number; height: number }, activeElement: Element | null): SnapshotCandidate[] {
  const candidates: SnapshotCandidate[] = [];
  const seen = new Set<Element>();
  let index = 0;
  let cursorProbes = 0;

  const popupContainers = queryAll(POPUP_CONTAINER_SELECTOR).filter(isVisible);
  const inPopupContainer = (element: Element): boolean => popupContainers.some((container) => container.contains(element));

  /** 通过可见性与视口检查后登记候选。 */
  const consider = (element: Element, explicit: boolean): void => {
    if (seen.has(element)) return;

    // 先做纯几何判断：不读样式，能把绝大多数节点挡在 getComputedStyle 之前。
    const rect = toRect(element);
    if (rect.width <= 0 || rect.height <= 0) return;
    const insidePopup = inPopupContainer(element);
    // 浮层内的元素豁免视口检查：长下拉列表下半截本来就在视口外，
    // 但它是可滚动到的，resolveRef 动作前会 scrollIntoView。
    if (!insidePopup && !isRectInViewport(rect, viewport)) return;

    const { visible, style } = inspectVisibility(element);
    if (!visible) return;

    // cursor 只对非显式候选才需要读，且总数有上限。
    let cursor: string | undefined;
    if (!explicit && cursorProbes < CURSOR_PROBE_LIMIT) {
      cursor = style.cursor;
      cursorProbes += 1;
    }

    const classified = classifyCandidate({
      explicit,
      ariaExpanded: element.getAttribute('aria-expanded'),
      ...(cursor === undefined ? {} : { cursor }),
      inPopupContainer: insidePopup,
    });
    if (!classified.include) return;

    seen.add(element);
    candidates.push({
      element,
      rect,
      index: index++,
      inPopup: classified.inPopup === true,
      nearFocus: isNearFocus(element, activeElement),
      tier: classified.tier,
      ...(classified.expanded ? { expanded: true } : {}),
      ...(classified.soft ? { soft: true } : {}),
    });
  };

  // 阶段一：显式可交互元素。先跑，保证真实控件不会被标成 soft。
  for (const element of queryAll(INTERACTIVE_SELECTOR)) consider(element, true);

  // 阶段二：浮层容器内的条目。UI 库下拉项在这里被捞出来。
  for (const container of popupContainers) {
    for (const element of queryAll(POPUP_ITEM_SELECTOR, container)) consider(element, false);
  }

  // 阶段三：视口内靠 cursor:pointer 识别的自定义控件（卡片、自绘开关等）。
  // 放在最后跑，前两阶段已收录的元素会被 seen 挡掉，不会被降级成 soft。
  // 成本可控的关键是先做矩形与视口判断：它不读样式，能把绝大多数节点挡在 getComputedStyle 之前。
  for (const element of queryAll(CURSOR_PROBE_SELECTOR)) {
    if (cursorProbes >= CURSOR_PROBE_LIMIT) break;
    consider(element, false);
  }

  return candidates;
}

/** querySelectorAll 的安全包装：非法选择器不该让整个快照挂掉。 */
function queryAll(selector: string, root: ParentNode = document): Element[] {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

/** 元素是否与当前焦点同处一个区域。用于排序时让焦点附近的内容优先。 */
function isNearFocus(element: Element, activeElement: Element | null): boolean {
  if (!activeElement || activeElement === document.body) return false;
  return element === activeElement || activeElement.contains(element) || element.contains(activeElement);
}

/** 找最近的、本身也在快照里的祖先 ref。扁平列表靠它表达层级。 */
function findParentRef(element: Element, refByElement: Map<Element, number>): number | undefined {
  let current = element.parentElement;
  while (current) {
    const ref = refByElement.get(current);
    if (ref !== undefined) return ref;
    current = current.parentElement;
  }
  return undefined;
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
  const occlusion = detectOcclusionWithFallback(element, rect);

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
