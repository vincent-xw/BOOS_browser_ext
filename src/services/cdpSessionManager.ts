import { CDP_PROTOCOL_VERSION } from '../types/cdp';
import type { DebugSessionState, DetachReason, ObservedRequest } from '../types/cdp';
import type { KeyModifier, PressableKey } from '../types/messages';

/**
 * chrome.debugger 会话管理器与 CDP 命令下发。
 *
 * 只在 Service Worker 中运行。设计上的两条硬约束：
 * 1. 一个标签页同时只允许一个调试会话，且任务期间保持连接 —— 不每次操作 attach/detach。
 * 2. 状态落 chrome.storage.session。MV3 Service Worker 约 30 秒空闲即挂起，
 *    而任务等待页面更新时正是空闲的 —— 那恰好是最容易被挂起的时刻。
 */

const SESSION_STORAGE_KEY = 'boos.cdp.session';

/** CDP 网络事件的原始载荷，只取需要的字段。 */
interface NetworkRequestEvent {
  requestId: string;
  request?: { url?: string; method?: string };
}

interface NetworkResponseEvent {
  requestId: string;
  response?: { url?: string; status?: number };
}

/** 会话在内存中的活动记录。挂起后丢失，靠 storage 恢复。 */
interface ActiveSession {
  tabId: number;
  attachedAt: number;
  networkObserving: boolean;
  requests: ObservedRequest[];
}

/** 抛出时带机器可判的原因，供路由层转成结构化响应。 */
export class CdpError extends Error {
  constructor(
    readonly code: 'ATTACH_FAILED' | 'SESSION_BUSY' | 'NO_DEBUG_SESSION' | 'CDP_COMMAND_FAILED',
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

/** 把 chrome.debugger 的 detach 原因映射为可读原因。 */
function toDetachReason(raw: string): DetachReason {
  if (raw === 'canceled_by_user') return 'canceled_by_user';
  if (raw === 'replaced_with_devtools') return 'replaced_with_devtools';
  if (raw === 'target_closed') return 'target_closed';
  return 'unknown';
}

/** 断连原因对应的用户可读提示。用户无需打开开发者工具即可理解。 */
export function describeDetachReason(reason: DetachReason): string {
  switch (reason) {
    case 'canceled_by_user':
      return '调试连接已被手动断开（页面顶部提示条被关闭），任务已中止。重新启动任务即可继续。';
    case 'replaced_with_devtools':
      return '该标签页的开发者工具已打开，抢占了调试连接。请关闭 DevTools 后重试。';
    case 'target_closed':
      return '目标标签页已关闭，任务已中止。';
    case 'stopped_by_user':
      return '任务已被手动停止。';
    case 'task_completed':
      return '任务已完成，调试连接已释放。';
    case 'task_failed':
      return '任务因错误中止，调试连接已释放。';
    default:
      return '调试连接已断开，任务已中止。';
  }
}

export function createCdpSessionManager() {
  /** 同一时刻只维护一个活动会话。 */
  let active: ActiveSession | null = null;
  let lastDetachReason: DetachReason | undefined;
  const detachListeners = new Set<(tabId: number, reason: DetachReason) => void>();

  /** 把会话状态写入 session storage，供 SW 唤醒后恢复。 */
  async function persist(): Promise<void> {
    const state: DebugSessionState = active
      ? { attached: true, tabId: active.tabId, attachedAt: active.attachedAt }
      : { attached: false, ...(lastDetachReason ? { detachReason: lastDetachReason } : {}) };
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: state });
  }

  async function loadPersisted(): Promise<DebugSessionState | undefined> {
    const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    return stored[SESSION_STORAGE_KEY] as DebugSessionState | undefined;
  }

  /** 该标签页当前是否真的还挂着调试器。SW 唤醒后不能只信 storage。 */
  async function isStillAttached(tabId: number): Promise<boolean> {
    const targets = await chrome.debugger.getTargets();
    return targets.some((target) => target.tabId === tabId && target.attached);
  }

  /**
   * SW 唤醒后恢复会话状态。
   * storage 说还连着、但实际已断开时必须清理并返回未连接 ——
   * 否则后续命令会打到一个失效会话上。
   */
  async function restore(): Promise<DebugSessionState> {
    if (active) return { attached: true, tabId: active.tabId, attachedAt: active.attachedAt };
    const persisted = await loadPersisted();
    if (!persisted?.attached || typeof persisted.tabId !== 'number') {
      return { attached: false, ...(persisted?.detachReason ? { detachReason: persisted.detachReason } : {}) };
    }
    if (!(await isStillAttached(persisted.tabId))) {
      lastDetachReason = 'unknown';
      active = null;
      await persist();
      return { attached: false, detachReason: 'unknown' };
    }
    active = {
      tabId: persisted.tabId,
      attachedAt: persisted.attachedAt ?? Date.now(),
      networkObserving: false,
      requests: [],
    };
    return { attached: true, tabId: active.tabId, attachedAt: active.attachedAt };
  }

  /** 下发一条 CDP 命令。 */
  async function send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const session = active;
    if (!session) {
      throw new CdpError('NO_DEBUG_SESSION', '当前标签页没有可用的调试会话，请先启动任务以建立调试连接。');
    }
    try {
      return (await chrome.debugger.sendCommand({ tabId: session.tabId }, method, params)) as T;
    } catch (error) {
      throw new CdpError('CDP_COMMAND_FAILED', `CDP 命令执行失败：${method}`, errorText(error));
    }
  }

  async function attach(tabId: number): Promise<DebugSessionState> {
    const current = await restore();
    if (current.attached) {
      if (current.tabId === tabId) return current;
      throw new CdpError('SESSION_BUSY', `已有任务正在标签页 ${current.tabId} 运行，请先结束该任务。`);
    }
    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    } catch (error) {
      const detail = errorText(error);
      // 同一标签页只允许一个调试客户端，DevTools 会抢占。这个原因必须说清楚，否则用户无从下手。
      const hint = /another debugger|already attached/i.test(detail)
        ? '该标签页已被其他调试客户端占用，请先关闭 DevTools 或其他调试工具后重试。'
        : `无法附加调试器到标签页 ${tabId}。`;
      throw new CdpError('ATTACH_FAILED', hint, detail);
    }
    active = { tabId, attachedAt: Date.now(), networkObserving: false, requests: [] };
    lastDetachReason = undefined;
    await persist();
    return { attached: true, tabId, attachedAt: active.attachedAt };
  }

  async function detach(reason: DetachReason = 'task_completed'): Promise<void> {
    const session = active;
    active = null;
    lastDetachReason = reason;
    await persist();
    if (!session) return;
    try {
      await chrome.debugger.detach({ tabId: session.tabId });
    } catch {
      // 标签页已关闭或调试器已断开时 detach 必然失败，这是预期路径，不必上报。
    }
  }

  async function state(): Promise<DebugSessionState> {
    return restore();
  }

  /**
   * 真实点击：mouseMoved → mousePressed → mouseReleased 三段序列。
   * 中途失败要指出是哪一段 —— 否则「点击失败」这条信息没有可操作性。
   */
  async function click(x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left' as const, clickCount: 1 };
    await dispatchPhase('mouseMoved', { type: 'mouseMoved', x, y });
    await dispatchPhase('mousePressed', { ...base, type: 'mousePressed' });
    await dispatchPhase('mouseReleased', { ...base, type: 'mouseReleased' });
  }

  async function dispatchPhase(phase: string, params: Record<string, unknown>): Promise<void> {
    try {
      await send('Input.dispatchMouseEvent', params);
    } catch (error) {
      throw new CdpError(
        'CDP_COMMAND_FAILED',
        `点击在 ${phase} 阶段失败`,
        error instanceof CdpError ? error.details : errorText(error),
      );
    }
  }

  /** 文本输入。中文与普通文本都走 insertText，不改 value。 */
  async function insertText(text: string): Promise<void> {
    await send('Input.insertText', { text });
  }

  /** 按键。keyDown + keyUp 成对下发。 */
  async function pressKey(key: PressableKey, modifiers: KeyModifier[] = []): Promise<void> {
    const descriptor = KEY_DESCRIPTORS[key];
    const modifierMask = modifiers.reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0);
    const params = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers: modifierMask,
      ...(descriptor.text ? { text: descriptor.text } : {}),
    };
    await send('Input.dispatchKeyEvent', { ...params, type: descriptor.text ? 'keyDown' : 'rawKeyDown' });
    await send('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
  }

  /** 滚动。省略锚点时用视口中心。 */
  async function scroll(deltaY: number, anchor?: { x: number; y: number }): Promise<void> {
    const metrics = await send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics');
    const viewport = metrics.cssLayoutViewport;
    const x = anchor?.x ?? Math.floor((viewport?.clientWidth ?? 1280) / 2);
    const y = anchor?.y ?? Math.floor((viewport?.clientHeight ?? 800) / 2);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  async function screenshot(format: 'png' | 'jpeg' = 'png'): Promise<{ dataUrl: string; width: number; height: number }> {
    const shot = await send<{ data: string }>('Page.captureScreenshot', { format });
    const metrics = await send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics');
    return {
      dataUrl: `data:image/${format};base64,${shot.data}`,
      width: metrics.cssLayoutViewport?.clientWidth ?? 0,
      height: metrics.cssLayoutViewport?.clientHeight ?? 0,
    };
  }

  /**
   * 开启 Network 域观测。
   * 相比在页面上下文里改写 window.fetch / XMLHttpRequest，CDP 观测在页面外部：
   * 不侵入站点运行时，也没有「恢复失败就永久污染页面」这个失败模式。
   */
  async function startNetworkObservation(): Promise<void> {
    const session = active;
    if (!session) throw new CdpError('NO_DEBUG_SESSION', '没有可用的调试会话，无法开启网络观测。');
    session.requests = [];
    if (session.networkObserving) return;
    await send('Network.enable');
    session.networkObserving = true;
  }

  /** 取回观测到的请求，可按 URL 关键字过滤。 */
  function collectRequests(urlPattern?: string): ObservedRequest[] {
    const requests = active?.requests ?? [];
    if (!urlPattern) return [...requests];
    return requests.filter((request) => request.url.includes(urlPattern));
  }

  /** 记录 CDP 事件。由 background 的 onEvent 监听转发进来。 */
  function handleDebuggerEvent(tabId: number, method: string, params: unknown): void {
    const session = active;
    if (!session || session.tabId !== tabId || !session.networkObserving) return;
    if (method === 'Network.requestWillBeSent') {
      const event = params as NetworkRequestEvent;
      session.requests.push({
        url: event.request?.url ?? '',
        method: event.request?.method ?? 'GET',
        timestamp: Date.now(),
      });
      return;
    }
    if (method === 'Network.responseReceived') {
      const event = params as NetworkResponseEvent;
      const match = session.requests.find((request) => request.url === event.response?.url && request.status === undefined);
      if (match) match.status = event.response?.status;
      return;
    }
    if (method === 'Network.loadingFailed') {
      const event = params as { requestId: string };
      void event;
      const pending = session.requests.find((request) => request.status === undefined && !request.failed);
      if (pending) pending.failed = true;
    }
  }

  /** 处理调试器断连。清理内存状态并通知订阅方，让任务能正确置失败。 */
  function handleDetach(tabId: number, rawReason: string): void {
    const reason = toDetachReason(rawReason);
    if (active?.tabId === tabId) active = null;
    lastDetachReason = reason;
    void persist();
    for (const listener of detachListeners) listener(tabId, reason);
  }

  function onDetach(listener: (tabId: number, reason: DetachReason) => void): void {
    detachListeners.add(listener);
  }

  return {
    attach,
    detach,
    state,
    restore,
    click,
    insertText,
    pressKey,
    scroll,
    screenshot,
    startNetworkObservation,
    collectRequests,
    handleDebuggerEvent,
    handleDetach,
    onDetach,
    send,
    get activeTabId(): number | undefined {
      return active?.tabId;
    },
  };
}

export type CdpSessionManager = ReturnType<typeof createCdpSessionManager>;

/** CDP 按键描述。text 仅对会产生字符输入的键给出。 */
const KEY_DESCRIPTORS: Record<PressableKey, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
};

/** CDP modifiers 位掩码。 */
const MODIFIER_BITS: Record<KeyModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
