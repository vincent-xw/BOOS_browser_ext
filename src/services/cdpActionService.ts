import { runGreetFlow, createStepRunner } from '../agent/stepLoop';
import type { StepLoopResult, StepRecord } from '../agent/stepLoop';
import { createMessageSender } from '../agent/toolExecutor';
import { MessageType } from '../types/messages';
import type { DebugSessionState } from '../types/cdp';
import type { ServiceResult } from '../types/page-io';

/**
 * CDP 页面动作服务。
 *
 * 这是页面写操作的唯一入口。composable 与组件通过它使用 CDP 能力，
 * 不直接碰 `chrome.*` —— 与既有的 chromeMcpService 保持同一层服务边界。
 */

const send = createMessageSender();

/** 取当前活动标签页 ID。 */
async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

function fail<T>(code: 'ACTIVE_TAB_MISSING' | 'NO_DEBUG_SESSION' | 'EXECUTION_FAILED' | 'VERIFICATION_FAILED', message: string, details?: string): ServiceResult<T> {
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

  /**
   * 收藏候选人。
   *
   * 定位收藏按钮 → CDP 真实点击 → 验证按钮文案变化与收藏请求成功返回。
   * 「点击命令没报错」不作为成功判据。
   */
  async favoriteCandidate(options: { onStep?: (record: StepRecord) => void } = {}): Promise<ServiceResult<StepLoopResult>> {
    const tabId = await activeTabId();
    if (tabId === null) return fail('ACTIVE_TAB_MISSING', '未找到活动标签页。');

    const context = { tabId, send, ...(options.onStep ? { onStep: options.onStep } : {}) };
    try {
      await send<unknown>({ type: MessageType.CdpNetworkStart, tabId }).catch(() => undefined);
      const runner = createStepRunner(context);
      const clicked = await runner.clickStep('点击收藏按钮', 'favoriteButton', {
        expectDomChangeIn: '.like-icon-and-text, button[ka=like], .btn-like',
        expectNetwork: { urlPattern: 'favorite', expectSuccess: true },
      });
      const result = runner.finish(clicked);
      return clicked ? succeed(result) : fail('VERIFICATION_FAILED', result.message, result.failedStep);
    } catch (error) {
      return fail('EXECUTION_FAILED', errorText(error));
    }
  },

  /** 打开候选人详情。点击列表项后验证简历容器出现。 */
  async openCandidateDetail(index: number, options: { onStep?: (record: StepRecord) => void } = {}): Promise<ServiceResult<StepLoopResult>> {
    const tabId = await activeTabId();
    if (tabId === null) return fail('ACTIVE_TAB_MISSING', '未找到活动标签页。');

    const context = { tabId, send, ...(options.onStep ? { onStep: options.onStep } : {}) };
    try {
      const runner = createStepRunner(context);
      const opened = await runner.clickStep(
        `打开候选人详情 #${index}`,
        'candidateListItem',
        { expectDialog: '#resume, canvas#resume, .resume-item, .dialog-wrap.active' },
        { index },
      );
      const result = runner.finish(opened);
      return opened ? succeed(result) : fail('VERIFICATION_FAILED', result.message, result.failedStep);
    } catch (error) {
      return fail('EXECUTION_FAILED', errorText(error));
    }
  },

  /** 打招呼并发送消息。 */
  async greetCandidate(
    message: string,
    options: { sendVia?: 'button' | 'enter'; sendUrlPattern?: string; onStep?: (record: StepRecord) => void } = {},
  ): Promise<ServiceResult<StepLoopResult>> {
    const tabId = await activeTabId();
    if (tabId === null) return fail('ACTIVE_TAB_MISSING', '未找到活动标签页。');

    try {
      const result = await runGreetFlow({
        tabId,
        send,
        message,
        ...(options.sendVia ? { sendVia: options.sendVia } : {}),
        ...(options.sendUrlPattern ? { sendUrlPattern: options.sendUrlPattern } : {}),
        ...(options.onStep ? { onStep: options.onStep } : {}),
      });
      return result.ok ? succeed(result) : fail('VERIFICATION_FAILED', result.message, result.failedStep);
    } catch (error) {
      return fail('EXECUTION_FAILED', errorText(error));
    }
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { StepLoopResult, StepRecord };
