import { defineBackground } from 'wxt/utils/define-background';

import { MessageType } from '../src/types/messages';
import type { ExtensionRequest, MessageErrorCode, MessageResponse, NavigationInfo } from '../src/types/messages';
import type { LocateResult, PageSnapshot, PageSnapshotResult, RefResolution, WaitForResult } from '../src/types/cdp';
import { CdpError, createCdpSessionManager, describeDetachReason } from '../src/services/cdpSessionManager';
import { mergeTriedSelectors, pickBestOutcome, scoreLocateResult, scorePageSnapshot } from '../src/services/frameAggregator';
import type { FrameOutcome } from '../src/services/frameAggregator';
import { mergeFrameSnapshots } from '../src/services/refIndex';
import type { RefOwner } from '../src/services/refIndex';
import { ALLOWLIST_STORAGE_KEY, isUrlAllowed } from '../src/services/urlAllowlist';
import type { UrlAllowRule } from '../src/services/urlAllowlist';
import { detectUrlChange } from '../src/services/navigationDetector';

export default defineBackground(() => {
  const cdp = createCdpSessionManager();

  /**
   * 全局 ref → 所属 frame 的索引。
   *
   * 存 chrome.storage.session 而不是内存 Map：MV3 的 Service Worker 空闲约 30s 就被杀，
   * 而快照与后续动作之间隔着一次模型往返，几乎必然跨过这个窗口。存内存会导致
   * 「刚拍完快照的 ref 立刻就说不在快照中」。session 存储在浏览器关闭时自动清空。
   *
   * 每次快照覆盖对应 tab 的条目：ref 是快照铸的，旧索引对新快照无意义。
   */
  const REF_OWNER_KEY = 'BOOS_REF_OWNERS';

  type StoredOwners = Record<string, Record<string, RefOwner>>;

  async function saveRefOwners(tabId: number, owners: Map<number, RefOwner>): Promise<void> {
    const stored = ((await chrome.storage.session.get(REF_OWNER_KEY))[REF_OWNER_KEY] ?? {}) as StoredOwners;
    stored[String(tabId)] = Object.fromEntries([...owners].map(([ref, owner]) => [String(ref), owner]));
    await chrome.storage.session.set({ [REF_OWNER_KEY]: stored });
  }

  async function loadRefOwner(tabId: number, ref: number): Promise<RefOwner | undefined> {
    const stored = ((await chrome.storage.session.get(REF_OWNER_KEY))[REF_OWNER_KEY] ?? {}) as StoredOwners;
    return stored[String(tabId)]?.[String(ref)];
  }

  async function clearRefOwners(tabId: number): Promise<void> {
    const stored = ((await chrome.storage.session.get(REF_OWNER_KEY))[REF_OWNER_KEY] ?? {}) as StoredOwners;
    delete stored[String(tabId)];
    await chrome.storage.session.set({ [REF_OWNER_KEY]: stored });
  }

  // ── CDP 会话事件 ────────────────────────────────────────────────

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId === 'number') cdp.handleDebuggerEvent(source.tabId, method, params);
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (typeof source.tabId !== 'number') return;
    cdp.handleDetach(source.tabId, reason);
  });

  cdp.onDetach((tabId, reason) => {
    // 广播给 UI，使任务能置失败并展示可读原因。UI 未打开时 sendMessage 会 reject，属预期。
    void chrome.runtime
      .sendMessage({ type: MessageType.CdpSessionState, tabId, reason, message: describeDetachReason(reason) })
      .catch(() => undefined);
  });

  // 标签页关闭时释放会话，避免把命令打到已失效的 target 上。
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearRefOwners(tabId);
    if (cdp.activeTabId === tabId) void cdp.detach('target_closed');
  });

  // ── 消息路由 ────────────────────────────────────────────────────

  /** 每个 handler 返回 data，异常由路由统一转成结构化失败。 */
  const handlers: {
    [K in ExtensionRequest['type']]: (message: Extract<ExtensionRequest, { type: K }>) => Promise<unknown>;
  } = {
    [MessageType.CdpAttach]: (message) => cdp.attach(message.tabId),
    [MessageType.CdpDetach]: async (message) => {
      void message;
      await cdp.detach('stopped_by_user');
      return { detached: true };
    },
    [MessageType.CdpSessionState]: async () => cdp.state(),

    [MessageType.CdpClick]: async (message) => {
      await requireWritable(message.tabId);
      const beforeUrl = await currentTabUrl(message.tabId);
      await cdp.click(message.x, message.y);
      const navigation = await detectNavigation(message.tabId, beforeUrl);
      return {
        ok: true,
        message: `已在 (${message.x}, ${message.y}) 下发真实点击${message.label ? `：${message.label}` : ''}`,
        ...(navigation ? { navigation } : {}),
      };
    },

    [MessageType.CdpHover]: async (message) => {
      await requireWritable(message.tabId);
      await cdp.hover(message.x, message.y);
      // 悬停后等浮层渲染：不等的话紧随其后的快照会拍到菜单出现之前的状态。
      await new Promise((resolve) => setTimeout(resolve, message.settleMs ?? 300));
      return {
        ok: true,
        message: `已悬停在 (${message.x}, ${message.y})${message.label ? `：${message.label}` : ''}`,
      };
    },

    [MessageType.CdpInputText]: async (message) => {
      await requireWritable(message.tabId);
      const beforeUrl = await currentTabUrl(message.tabId);
      // 先点击建立真实焦点，再 insertText。不改 value —— 那会绕过输入法与框架的受控更新路径。
      await cdp.click(message.x, message.y);
      const focus = await readFocusState(message.tabId, message.frameId);
      if (!focus.focused) {
        return { ok: false, message: `点击输入框后焦点未落在可编辑元素上（当前焦点：${focus.activeTag}），未写入文本。`, focused: false };
      }
      // 清空必须在确认焦点之后、insertText 之前，且和输入在同一次消息里完成：
      // 拆成两次消息会让「点击」重新落一次光标，把选区冲掉。
      if (message.clearFirst) await cdp.selectAll();
      await cdp.insertText(message.text);
      const after = await readFocusState(message.tabId, message.frameId);
      const navigation = await detectNavigation(message.tabId, beforeUrl);
      // 回读实际值并校验：清空+输入是「预期值应完全等于 text」的唯一场景，
      // 不一致说明选区没生效（曾出现拼接成 2026-2026-08-2707-27），必须让模型知道。
      if (message.clearFirst && after.value !== undefined && after.value !== message.text) {
        return {
          ok: false,
          message: `清空后写入的实际值与预期不一致：预期「${message.text}」，实际「${after.value}」。输入框可能未被清空，请重新定位后再试。`,
          focused: true,
          actualValue: after.value,
          ...(navigation ? { navigation } : {}),
        };
      }
      return {
        ok: true,
        message: '文本已通过 Input.insertText 写入。',
        focused: true,
        actualValue: after.value,
        ...(navigation ? { navigation } : {}),
      };
    },

    [MessageType.CdpPressKey]: async (message) => {
      await requireWritable(message.tabId);
      const beforeUrl = await currentTabUrl(message.tabId);
      await cdp.pressKey(message.key, message.modifiers ?? []);
      const navigation = await detectNavigation(message.tabId, beforeUrl);
      return {
        ok: true,
        message: `已下发按键 ${message.key}`,
        ...(navigation ? { navigation } : {}),
      };
    },

    [MessageType.CdpScroll]: async (message) => {
      await requireWritable(message.tabId);
      const anchor = typeof message.x === 'number' && typeof message.y === 'number' ? { x: message.x, y: message.y } : undefined;
      await cdp.scroll(message.deltaY, anchor);
      return { ok: true, message: `已滚动 ${message.deltaY}px。所有既有坐标已失效，请重新定位。` };
    },

    [MessageType.CdpScreenshot]: async (message) => {
      await requireSession(message.tabId);
      return cdp.screenshot(message.format ?? 'png');
    },

    [MessageType.CdpGoBack]: async (message) => {
      await requireWritable(message.tabId);
      const beforeUrl = await currentTabUrl(message.tabId);
      try {
        await chrome.tabs.goBack(message.tabId);
      } catch (error) {
        return { ok: false, message: `浏览器返回失败：${error instanceof Error ? error.message : String(error)}` };
      }
      const navigation = await detectNavigation(message.tabId, beforeUrl);
      return {
        ok: true,
        message: '已执行浏览器返回。',
        ...(navigation ? { navigation } : {}),
      };
    },

    [MessageType.CdpNetworkStart]: async (message) => {
      await requireSession(message.tabId);
      await cdp.startNetworkObservation();
      return { observing: true };
    },

    [MessageType.CdpNetworkCollect]: async (message) => {
      await requireSession(message.tabId);
      return { requests: cdp.collectRequests(message.urlPattern) };
    },

    [MessageType.ContentPing]: (message) => forwardToContent(message.tabId, message),
    [MessageType.ContentLocate]: async (message) => {
      // ref 路径必须定向到登记它的 frame：ref 现在是全局号，广播出去会被各 frame
      // 当成自己的本地号解析，撞车后返回错误的元素（步骤日志里表现为坐标指向无关元素）。
      if (typeof message.locator.ref === 'number') {
        const owner = await loadRefOwner(message.tabId, message.locator.ref);
        if (!owner) {
          return {
            found: false,
            message: `ref ${message.locator.ref} 不在最近一次快照中，请重新调用 browser_snapshot。`,
          } satisfies LocateResult;
        }
        const scoped = { ...message, locator: { ...message.locator, ref: owner.localRef } };
        const response = (await sendToFrame(message.tabId, scoped, owner.frameId)) as MessageResponse<LocateResult> | undefined;
        if (response?.ok) return { ...response.data, frameId: String(owner.frameId) };
        return {
          found: false,
          message: `ref ${message.locator.ref} 所属 frame（frameId=${owner.frameId}）未应答，请重新快照。`,
        } satisfies LocateResult;
      }
      // 选择器路径：向所有 frame 广播后按评分取最优。不能用 tabs.sendMessage 的默认行为 ——
      // 它只返回第一个应答的 frame，等于退化成「只读主 frame」。
      const outcomes = await broadcastToFrames<LocateResult>(message.tabId, message);
      const best = pickBestOutcome(outcomes, scoreLocateResult);
      if (best?.result.found) return { ...best.result, frameId: String(best.frameId) };
      const tried = mergeTriedSelectors(outcomes);
      return {
        found: false,
        triedSelectors: tried,
        message: `全部 ${outcomes.length} 个 frame 均未定位到目标，已尝试 ${tried.length} 个选择器${describeSilentFrames(outcomes) || '。建议先调用 browser_snapshot 取 ref'}。`,
      } satisfies LocateResult;
    },
    [MessageType.ContentVerify]: (message) => forwardToContent(message.tabId, message),
    [MessageType.ContentWaitFor]: async (message) => {
      // 广播而非只发主 frame：等待的元素常在子 frame 里（嵌入式表单），
      // 只问主 frame 会稳定超时，看起来像「元素永远没出现」。
      const outcomes = await broadcastToFrames<WaitForResult>(message.tabId, message);
      const results = outcomes.map((outcome) => outcome.result).filter((result): result is WaitForResult => result !== undefined);
      if (results.length === 0) throw new RoutedError('CONTENT_UNAVAILABLE', '没有任何 frame 响应等待请求，请刷新目标页面后重试。');
      // 任一 frame 满足即满足；都不满足时取第一条的观察结果作为回执。
      return results.find((result) => result.satisfied) ?? results[0];
    },
    [MessageType.ContentReadPage]: async (message) => {
      const outcomes = await broadcastToFrames<PageSnapshot>(message.tabId, message);
      const best = pickBestOutcome(outcomes, scorePageSnapshot);
      if (!best) throw new RoutedError('CONTENT_UNAVAILABLE', '没有任何 frame 返回页面内容，请刷新目标页面后重试。');
      const silent = describeSilentFrames(outcomes);
      return silent ? { ...best.result, warning: `部分内容未读取到${silent}。` } : best.result;
    },

    [MessageType.ContentSnapshot]: async (message) => {
      // 快照合并所有 frame 的结果而不是取最优：自由指令下模型需要看到整页的可交互元素，
      // 目标很可能在某个子 frame 里（比如嵌入式搜索框）。
      const outcomes = await broadcastToFrames<PageSnapshotResult>(message.tabId, message);
      const collected = outcomes
        .filter((outcome): outcome is { frameId: number; result: PageSnapshotResult } => outcome.result !== undefined)
        .map((outcome) => ({ frameId: outcome.frameId, result: outcome.result }));
      if (collected.length === 0) {
        throw new RoutedError('CONTENT_UNAVAILABLE', '没有任何 frame 返回快照，请刷新目标页面后重试。');
      }
      // 各 frame 的本地 ref 都从 1 开始，必须重编号成全局唯一并记住归属，
      // 否则动作会按撞车的 ref 号解析到别的 frame 的同号元素。
      const { snapshot, owners } = mergeFrameSnapshots(collected);
      await saveRefOwners(message.tabId, owners);
      // 有 frame 没应答时必须明说：否则「子 frame 的元素缺席」看起来就是「页面上没有这个元素」，
      // 模型只会不停换选择器重试。
      const silent = describeSilentFrames(outcomes);
      return silent ? { ...snapshot, warning: `部分内容未纳入快照${silent}。` } : snapshot;
    },

    [MessageType.ContentResolveRef]: async (message) => {
      // ref 只在登记它的那个 frame 里有效，靠快照建立的索引定向投递。
      const owner = await loadRefOwner(message.tabId, message.ref);
      if (!owner) {
        return {
          found: false,
          stale: true,
          message: `ref ${message.ref} 不在最近一次快照中，请重新调用 browser_snapshot。`,
        } satisfies RefResolution;
      }
      const scoped = { ...message, ref: owner.localRef };
      const response = (await sendToFrame(message.tabId, scoped, owner.frameId)) as MessageResponse<RefResolution> | undefined;
      if (response?.ok) return { ...response.data, frameId: owner.frameId };
      return {
        found: false,
        stale: true,
        message: `ref ${message.ref} 所属 frame（frameId=${owner.frameId}）未应答，页面可能已重新加载，请重新快照。`,
      } satisfies RefResolution;
    },
  };

  chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse) => {
    const handler = handlers[message?.type as ExtensionRequest['type']] as
      | ((request: ExtensionRequest) => Promise<unknown>)
      | undefined;

    // 未知消息类型返回结构化失败，不静默忽略 —— 静默忽略会让调用方一直等待。
    if (!handler) {
      sendResponse({ ok: false, code: 'UNKNOWN_MESSAGE_TYPE', message: `不支持的消息类型：${String(message?.type)}` } satisfies MessageResponse);
      return false;
    }

    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (typeof tabId !== 'number' || tabId < 0) {
      sendResponse({ ok: false, code: 'TAB_MISSING', message: '缺少有效的标签页 ID。' } satisfies MessageResponse);
      return false;
    }

    handler({ ...message, tabId })
      .then((data) => sendResponse({ ok: true, data } satisfies MessageResponse))
      .catch((error: unknown) => sendResponse(toFailure(error)));
    return true;
  });

  /** 确认调试会话仍然有效。SW 唤醒后 storage 可能说还连着、但实际已断开。 */
  async function requireSession(tabId: number): Promise<void> {
    const state = await cdp.restore();
    if (!state.attached || state.tabId !== tabId) {
      throw new RoutedError(
        'NO_DEBUG_SESSION',
        state.detachReason
          ? describeDetachReason(state.detachReason)
          : '当前标签页没有可用的调试会话，请先启动任务以建立调试连接。',
      );
    }
  }

  /**
   * 写操作前校验目标页面是否在白名单内。
   *
   * 校验点必须在 Service Worker：放在 UI 侧的话，绕过 UI 直接 sendMessage 就失效了。
   * 白名单从 chrome.storage.local 读，与设置界面共享同一份数据。
   */
  async function requireAllowedUrl(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const url = tab?.url ?? '';
    const rules = await loadAllowRules();
    const check = isUrlAllowed(url, rules);
    if (!check.allowed) {
      throw new RoutedError('URL_NOT_ALLOWED', `该页面不允许执行写操作：${check.reason}`, url);
    }
  }

  /**
   * 检测写操作后是否发生了页面导航。
   *
   * 等 URL 稳定后用纯函数比对，结果作为强信号注入工具返回值。
   * 纯逻辑在 src/services/navigationDetector.ts，单测覆盖。
   */
  async function detectNavigation(tabId: number, beforeUrl: string | undefined): Promise<NavigationInfo | undefined> {
    // 给导航一个发生并稳定的窗口：CDP 点击触发的导航是异步的，立即取 URL 可能还是旧值。
    await new Promise((resolve) => setTimeout(resolve, 350));
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    return detectUrlChange(beforeUrl, tab?.url);
  }

  /** 读取白名单规则。存储不可用或格式不对时返回空数组（即拒绝一切写操作）。 */
  async function loadAllowRules(): Promise<UrlAllowRule[]> {
    try {
      const stored = await chrome.storage.local.get(ALLOWLIST_STORAGE_KEY);
      const value = stored[ALLOWLIST_STORAGE_KEY];
      return Array.isArray(value) ? (value as UrlAllowRule[]) : [];
    } catch {
      return [];
    }
  }

  /** 写操作的公共前置：会话可用 + 页面在白名单内。 */
  async function requireWritable(tabId: number): Promise<void> {
    await requireSession(tabId);
    await requireAllowedUrl(tabId);
  }

  /**
   * 读取焦点状态。用于确认 CDP 点击是否真的把焦点落在了输入框上。
   *
   * 必须在目标元素所属的 frame 里读：主 frame 的 activeElement 在跨 frame 场景下
   * 就是那个 <iframe> 元素本身，会把「焦点已正确落在子 frame 的输入框」误判成失败。
   */
  async function readFocusState(tabId: number, frameId?: number): Promise<{ focused: boolean; activeTag: string; value: string }> {
    // 已知目标 frame 时只读它；未知（按 x/y 直接操作）时读全部 frame 再挑出真正持有焦点的那个。
    // 主 frame 的 activeElement 在跨 frame 场景下是 <iframe> 本身，只读主 frame 必然误判。
    const target = typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true as const };
    const results = await chrome.scripting.executeScript({
      target,
      func: () => {
        const active = document.activeElement;
        const tag = active?.tagName?.toLowerCase() ?? 'none';
        const editable =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable);
        const value =
          active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
            ? active.value
            : active instanceof HTMLElement
              ? active.innerText
              : '';
        return { focused: editable, activeTag: tag, value };
      },
    });
    const states = results
      .map((item) => item.result as { focused: boolean; activeTag: string; value: string } | undefined)
      .filter((state): state is { focused: boolean; activeTag: string; value: string } => state !== undefined);
    // 任一 frame 报持有可编辑焦点即成立：焦点在整个标签页里只有一处。
    return (
      states.find((state) => state.focused) ??
      states[0] ?? {
        focused: false,
        activeTag: 'unknown',
        value: '',
      }
    );
  }

  /** 转发到 content script，未就绪时按需注入并重试一次。 */
  async function forwardToContent(tabId: number, message: ExtensionRequest): Promise<unknown> {
    const response = await sendToTab(tabId, message);
    if (response) return unwrap(response);

    await injectContentScript(tabId);

    const retried = await sendToTab(tabId, message);
    if (!retried) throw new RoutedError('CONTENT_UNAVAILABLE', '页面脚本注入后仍无响应，请刷新目标页面后重试。');
    return unwrap(retried);
  }

  /**
   * 向标签页的每个 frame 分别投递并收集结果。
   * 单个 frame 失败（跨源、已卸载、脚本未注入）只留空结果，不影响其余 frame。
   *
   * 只要**有 frame 未应答**就补一次注入并重试那些 frame —— 早先的条件是「全部未应答」，
   * 而主 frame 几乎总会应答，于是缺脚本的子 frame 永远等不到注入。症状是子 frame 里的
   * 元素在快照/定位中完全不存在，与「元素真的不存在」无法区分。
   */
  async function broadcastToFrames<T>(tabId: number, message: ExtensionRequest): Promise<Array<FrameOutcome<T>>> {
    let frames = await listFrames(tabId);
    if (frames.length === 0) frames = [0];

    const askFrame = async (frameId: number): Promise<FrameOutcome<T>> => {
      try {
        const response = (await chrome.tabs.sendMessage(tabId, message, { frameId })) as MessageResponse<T> | undefined;
        return response?.ok ? { frameId, result: response.data } : { frameId };
      } catch {
        return { frameId };
      }
    };

    const outcomes = await Promise.all(frames.map(askFrame));
    const silent = outcomes.filter((outcome) => outcome.result === undefined);
    if (silent.length === 0) return outcomes;

    await injectContentScript(tabId);
    const retried = await Promise.all(silent.map((outcome) => askFrame(outcome.frameId)));
    const byFrame = new Map(retried.map((outcome) => [outcome.frameId, outcome]));
    return outcomes.map((outcome) => byFrame.get(outcome.frameId) ?? outcome);
  }

  /** 枚举到的 frame 与实际应答的 frame 的差额。用于把「脚本没跑起来」和「元素不存在」区分开。 */
  function describeSilentFrames(outcomes: readonly FrameOutcome<unknown>[]): string {
    const silent = outcomes.filter((outcome) => outcome.result === undefined).length;
    if (silent === 0) return '';
    return `：${outcomes.length} 个 frame 中有 ${silent} 个未返回内容（脚本未注入或跨源受限），其中的元素不会出现在快照里。请确认白名单已覆盖 iframe 自身的地址，或刷新页面后重试`;
  }

  async function listFrames(tabId: number): Promise<number[]> {
    try {
      const frames = await chrome.webNavigation?.getAllFrames({ tabId });
      return (frames ?? []).map((frame) => frame.frameId);
    } catch {
      return [];
    }
  }

  async function injectContentScript(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content-scripts/content.js'] });
    } catch (error) {
      // 最常见的注入失败原因是「没有该页面的 host 权限」—— 这跟白名单无关：
      // 白名单只影响写操作，而注入是读取/快照/定位都需要的。没有权限时 executeScript
      // 抛 "Cannot access contents of the page"，必须把这个跟真正需要刷新的情况区分开，
      // 否则用户会反复刷新却毫无帮助。
      const detail = errorText(error)
      const url = await currentTabUrl(tabId)
      if (url && !(await hasHostPermission(url))) {
        throw new RoutedError(
          'HOST_PERMISSION_MISSING',
          `没有 ${hostOf(url)} 的访问权限，无法注入页面脚本。请先在设置中添加该域名并授权。`,
          detail,
        )
      }
      throw new RoutedError('CONTENT_UNAVAILABLE', '页面脚本未就绪且注入失败，请刷新目标页面后重试。', detail)
    }
  }

  /** 读取标签页当前 URL；拿不到时返回 undefined。 */
  async function currentTabUrl(tabId: number): Promise<string | undefined> {
    try {
      return (await chrome.tabs.get(tabId))?.url
    } catch {
      return undefined
    }
  }

  /** 判断扩展是否有某 URL 的 host 权限。权限不足时 executeScript 会失败。 */
  async function hasHostPermission(url: string): Promise<boolean> {
    try {
      // 需要把 URL 转成 match pattern（http/https 后接域名）。
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      return await chrome.permissions.contains({ origins: [`*://${parsed.hostname}/*`] })
    } catch {
      return false
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  }

  async function sendToTab(tabId: number, message: ExtensionRequest): Promise<MessageResponse | undefined> {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return undefined;
    }
  }

  /** 定向投递到指定 frame。ref 类操作必须定向：各 frame 的本地 ref 号会撞车。 */
  async function sendToFrame(tabId: number, message: ExtensionRequest, frameId: number): Promise<MessageResponse | undefined> {
    try {
      return await chrome.tabs.sendMessage(tabId, message, { frameId });
    } catch {
      return undefined;
    }
  }

  function unwrap(response: MessageResponse): unknown {
    if (response.ok) return response.data;
    throw new RoutedError(response.code, response.message, response.details);
  }

  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
      console.warn('[BOOS] Failed to enable openPanelOnActionClick:', error);
    });
  }
});

/** 带错误码的路由异常。 */
class RoutedError extends Error {
  constructor(
    readonly code: MessageErrorCode,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'RoutedError';
  }
}

/** 把任意异常归一化为结构化失败响应。 */
function toFailure(error: unknown): MessageResponse {
  if (error instanceof RoutedError) {
    return { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof CdpError) {
    return { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { ok: false, code: 'CDP_COMMAND_FAILED', message: '操作执行失败', details: errorText(error) };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
