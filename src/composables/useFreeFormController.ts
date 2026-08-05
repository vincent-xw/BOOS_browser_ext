import { computed, ref } from 'vue';

import { BffError, runAgentSession } from '../agent/agentClient';
import type { StepEvent } from '../agent/agentClient';
import { createApprovalGate, summarizeAction } from '../agent/approvalGate';
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '../agent/approvalGate';
import { createMessageSender } from '../agent/toolExecutor';
import { cdpActionService } from '../services/cdpActionService';
import { toBffConfig } from '../services/llmService';
import { loadAllowRules } from '../services/permissionService';
import { isUrlAllowed } from '../services/urlAllowlist';
import { settingsService } from '../services/settingsService';
import { MessageType } from '../types/messages';
import type { OperationError, OperationState } from '../types/page-io';

/**
 * 自由指令控制器。
 *
 * 与 usePageIoController（BOSS 预设批量流程）并存：这里是「用户下一句话、agent 自己规划」，
 * 那里是写死的动作序列。等自由指令调到可用后再删预设路径。
 *
 * 多轮：同一 sessionId 连续下指令，harness 会自动带上历史，
 * 所以「点第三条结果」「回到上一页」这类指代才成立。
 */

/** 对话中的一条消息。 */
export interface ConversationTurn {
  role: 'user' | 'agent' | 'error';
  text: string
  timestamp: string;
  /** 该轮执行的步骤，仅 agent 轮次有。 */
  steps?: StepEvent[];
}

export function useFreeFormController() {
  const send = createMessageSender();

  const runState = ref<OperationState>('idle');
  const runError = ref<OperationError | null>(null);
  const instruction = ref('');
  const turns = ref<ConversationTurn[]>([]);
  const currentSteps = ref<StepEvent[]>([]);
  const sessionId = ref(newSessionId());
  const currentUrl = ref('');
  const currentTitle = ref('');
  const urlAllowed = ref(false);
  const urlAllowReason = ref('');

  /** 待用户批准的动作。非空时 UI 弹出审批对话框。 */
  const pendingApproval = ref<ApprovalRequest | null>(null);
  let approvalResolver: ((decision: ApprovalDecision) => void) | null = null;

  const settings = ref(settingsService.load().normalized);
  let abortController: AbortController | null = null;

  const isBusy = computed(() => runState.value === 'running');
  const canSubmit = computed(() => instruction.value.trim().length > 0 && !isBusy.value);

  /**
   * 审批实现：把请求交给 UI，等对话框 resolve。
   * agent 循环就跑在这个上下文里，所以不需要跨上下文暂停机制。
   */
  const approvalPrompt = (request: ApprovalRequest): Promise<ApprovalDecision> => {
    pendingApproval.value = request;
    return new Promise<ApprovalDecision>((resolve) => {
      approvalResolver = (decision) => {
        pendingApproval.value = null;
        approvalResolver = null;
        resolve(decision);
      };
    });
  };

  const approvalGate = createApprovalGate({ prompt: approvalPrompt });

  /** UI 调用：用户批准，并选择授权范围。 */
  function approve(scope: GrantScope): void {
    approvalResolver?.({ approved: true, scope });
  }

  /** UI 调用：用户拒绝。 */
  function deny(): void {
    approvalResolver?.({ approved: false, reason: '用户拒绝了该操作。' });
  }

  /** 刷新当前标签页信息与白名单判定，供 UI 展示与提交前校验。 */
  async function refreshPageContext(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    currentUrl.value = tab?.url ?? '';
    currentTitle.value = tab?.title ?? '';
    const rules = await loadAllowRules();
    const check = isUrlAllowed(currentUrl.value, rules);
    urlAllowed.value = check.allowed;
    urlAllowReason.value = check.reason;
  }

  /** 提交一条指令。 */
  async function submitInstruction(): Promise<void> {
    const text = instruction.value.trim();
    if (!text || isBusy.value) return;

    settings.value = settingsService.load().normalized;
    if (!settings.value.advanced.bffBaseUrl || !settings.value.advanced.bffApiToken) {
      runState.value = 'failed';
      runError.value = { code: 'CONFIG_MISSING', message: '请先在设置中配置 BFF 地址与接入 token。' };
      return;
    }

    await refreshPageContext();
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tab?.id;
    if (typeof tabId !== 'number') {
      runState.value = 'failed';
      runError.value = { code: 'ACTIVE_TAB_MISSING', message: '未找到活动标签页。' };
      return;
    }

    turns.value = [...turns.value, { role: 'user', text, timestamp: new Date().toISOString() }];
    instruction.value = '';
    currentSteps.value = [];
    runState.value = 'running';
    runError.value = null;
    abortController = new AbortController();

    // 写操作需要调试会话。读操作也一并建立，省得中途再要权限。
    const attached = await cdpActionService.attach();
    if (!attached.ok) {
      runState.value = 'failed';
      runError.value = attached.error ?? { code: 'NO_DEBUG_SESSION', message: '无法建立调试连接。' };
      appendTurn('error', runError.value.message);
      return;
    }

    try {
      const result = await runAgentSession(text, {
        config: toBffConfig(settings.value),
        sessionId: sessionId.value,
        tabId,
        send,
        approval: approvalGate,
        currentUrl: currentUrl.value,
        signal: abortController.signal,
        onStep: (event) => {
          currentSteps.value = [...currentSteps.value, event];
        },
      });
      appendTurn('agent', formatOutput(result.output), currentSteps.value);
      runState.value = 'succeeded';
    } catch (error) {
      const message = error instanceof BffError ? error.message : error instanceof Error ? error.message : String(error);
      runState.value = 'failed';
      runError.value = { code: 'EXECUTION_FAILED', message };
      appendTurn('error', message, currentSteps.value);
    } finally {
      // 任务结束即释放调试连接，调试横幅不该长期挂在页面上。
      await cdpActionService.detach();
      abortController = null;
    }
  }

  function appendTurn(role: ConversationTurn['role'], text: string, steps?: StepEvent[]): void {
    turns.value = [
      ...turns.value,
      { role, text, timestamp: new Date().toISOString(), ...(steps && steps.length ? { steps: [...steps] } : {}) },
    ];
  }

  /** 停止当前任务。 */
  async function stop(): Promise<void> {
    abortController?.abort();
    // 若正卡在审批对话框上，一并按拒绝处理，否则 Promise 永远不会 resolve。
    approvalResolver?.({ approved: false, reason: '任务已被停止。' });
    await cdpActionService.detach();
  }

  /** 开新会话：清空上下文与会话级授权。 */
  function newSession(): void {
    sessionId.value = newSessionId();
    turns.value = [];
    currentSteps.value = [];
    runState.value = 'idle';
    runError.value = null;
    approvalGate.resetSession();
  }

  return {
    runState,
    runError,
    instruction,
    turns,
    currentSteps,
    sessionId,
    currentUrl,
    currentTitle,
    urlAllowed,
    urlAllowReason,
    pendingApproval,
    isBusy,
    canSubmit,
    approve,
    deny,
    submitInstruction,
    stop,
    newSession,
    refreshPageContext,
    summarizeAction,
    MessageType,
  };
}

function newSessionId(): string {
  return `free-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 模型最终输出可能是字符串或结构化对象，统一转为可读文本。 */
function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '(无输出)';
  return JSON.stringify(output, null, 2);
}
