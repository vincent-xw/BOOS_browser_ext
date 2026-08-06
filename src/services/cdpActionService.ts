import { MessageType } from '../types/messages';
import type { DebugSessionState } from '../types/cdp';
import type { ServiceResult } from '../types/page-io';
import { createMessageSender } from '../agent/toolExecutor';

/**
 * CDP 调试会话服务。
 *
 * composable 与组件通过它管理调试会话，不直接碰 `chrome.*` ——
 * 与其余 `src/services/` 保持同一层服务边界。
 *
 * 具体的页面动作不在这里：它们由 agent 经 `toolExecutor` 下发，
 * 动作序列由模型规划而非代码写死。
 */

const send = createMessageSender();

/** 取当前活动标签页 ID。 */
async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

function fail<T>(code: 'ACTIVE_TAB_MISSING' | 'NO_DEBUG_SESSION' | 'EXECUTION_FAILED', message: string, details?: string): ServiceResult<T> {
  return {
    ok: false,
    provider: 'cdp-debugger',
    mode: 'live',
    error: { code, message, ...(details ? { details } : {}) },
  };
}

function succeed<T>(data: T): ServiceResult<T> {
  return { ok: true, provider: 'cdp-debugger', mode: 'live', data };
}

export const cdpActionService = {
  /** 建立调试会话。任务开始时调用一次，整个任务期间复用。 */
  async attach(): Promise<ServiceResult<DebugSessionState>> {
    const tabId = await activeTabId();
    if (tabId === null) return fail('ACTIVE_TAB_MISSING', '未找到活动标签页。');
    try {
      return succeed(await send<DebugSessionState>({ type: MessageType.CdpAttach, tabId }));
    } catch (error) {
      return fail('NO_DEBUG_SESSION', errorText(error));
    }
  },

  /** 释放调试会话。任务结束、失败或用户停止时调用。 */
  async detach(): Promise<ServiceResult<{ detached: boolean }>> {
    const tabId = await activeTabId();
    if (tabId === null) return succeed({ detached: true });
    try {
      return succeed(await send<{ detached: boolean }>({ type: MessageType.CdpDetach, tabId }));
    } catch {
      // 会话已断开时 detach 必然失败，属预期路径。
      return succeed({ detached: true });
    }
  },

  async sessionState(): Promise<ServiceResult<DebugSessionState>> {
    const tabId = await activeTabId();
    if (tabId === null) return fail('ACTIVE_TAB_MISSING', '未找到活动标签页。');
    try {
      return succeed(await send<DebugSessionState>({ type: MessageType.CdpSessionState, tabId }));
    } catch (error) {
      return fail('EXECUTION_FAILED', errorText(error));
    }
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
