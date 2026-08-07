import { computed, ref } from 'vue';

import { BffError, runAgent, runAgentSession, toBffConfig } from '../agent/agentClient';
import type { StepEvent, TaskPlan } from '../agent/agentClient';
import { createApprovalGate, summarizeAction } from '../agent/approvalGate';
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '../agent/approvalGate';
import { createMessageSender } from '../agent/toolExecutor';
import { cdpActionService } from '../services/cdpActionService';
import { hasUrlPermission, loadAllowRules, requestPermissionForUrl } from '../services/permissionService';
import {
  deleteSession,
  getSession,
  loadSessions,
  newSessionId,
  saveSession,
} from '../services/freeFormSessionStore';
import type { ConversationTurn, StoredSession } from '../services/freeFormSessionStore';
import { isUrlAllowed } from '../services/urlAllowlist';
import { settingsService } from '../services/settingsService';
import { MessageType } from '../types/messages';
import type { OperationError, OperationState } from '../types/page-io';

/** 工具错误码到可读中文的映射。未知错误码走兜底。 */
const TOOL_ERROR_LABELS: Record<string, string> = {
  TOOL_NOT_ALLOWED: '当前不支持这类操作',
  TOOL_INPUT_INVALID: '指令参数不合法',
  TOOL_EXECUTION_FAILED: '操作执行失败',
  USER_DENIED: '已拒绝',
};

/**
 * 把工具失败的结构化结果转成用户可读的中文。
 * 不暴露错误码 -- 用户看到的是「当前不支持这类操作」而非 TOOL_NOT_ALLOWED。
 */
function humanizeStepOutput(output: unknown): unknown {
  if (typeof output !== 'object' || output === null) return output;
  const record = output as Record<string, unknown>;
  if (record.ok === false && typeof record.code === 'string') {
    const reason = typeof record.message === 'string' ? record.message : '';
    return { ...record, humanText: TOOL_ERROR_LABELS[record.code] ?? '操作未能完成', reason };
  }
  return output;
}

/**
 * 自由指令控制器。
 *
 * 用户下一句自然语言，agent 自己规划动作序列并执行。这是扩展唯一的执行路径 ——
 * 早先写死的 BOSS 动作序列已删除。
 *
 * 多轮：同一 sessionId 连续下指令，harness 会自动带上历史，
 * 所以「点第三条结果」「回到上一页」这类指代才成立。
 */

export function useFreeFormController() {
  const send = createMessageSender();

  const runState = ref<OperationState>('idle');
  const runError = ref<OperationError | null>(null);
  const instruction = ref('');
  const turns = ref<ConversationTurn[]>([]);
  const currentSteps = ref<StepEvent[]>([]);
  const sessionId = ref(newSessionId());
  /** 会话列表。持久化在 chrome.storage.local，切回旧会话靠它拿到 sessionId。 */
  const sessions = ref<StoredSession[]>([]);
  const currentUrl = ref('');
  const currentTitle = ref('');
  const urlAllowed = ref(false);
  const urlAllowReason = ref('');
  /** 当前 URL 是否已授予 host 权限。没权限时 content script 注入与 CDP 都会失败。 */
  const hostPermissionOk = ref(true);
  /** 申请权限中的状态，避免重复点击。 */
  const requestingPermission = ref(false);

  /** 待用户批准的动作。非空时 UI 弹出审批对话框。 */
  const pendingApproval = ref<ApprovalRequest | null>(null);
  let approvalResolver: ((decision: ApprovalDecision) => void) | null = null;

  const settings = ref(settingsService.load().normalized);
  let abortController: AbortController | null = null;

  /** 计划阶段的输出。非空时 UI 展示计划等待用户确认。 */
  const pendingPlan = ref<TaskPlan | null>(null);
  /** 计划阶段的 reasoning（模型思考链），供 UI 展示。 */
  const planReasoning = ref<string>('');
  /** 计划阶段是否正在请求中。 */
  const isPlanning = ref(false);

  const isBusy = computed(() => runState.value === 'running' || isPlanning.value);
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
    // host 权限与白名单是两回事：在白名单里但没授予 host 权限，content script 仍然注入失败。
    // 主动检测并提示，避免任务执行到一半因注入失败中断。
    hostPermissionOk.value = currentUrl.value ? await hasUrlPermission(currentUrl.value) : true;
  }

  /**
   * 主动为当前页面申请 host 权限。
   * 必须由用户点击触发（chrome.permissions.request 要求用户手势），不能在自动流程里直接调。
   */
  async function requestHostPermission(): Promise<{ ok: boolean; message: string }> {
    if (!currentUrl.value) return { ok: false, message: '当前没有可授权的页面。' };
    if (requestingPermission.value) return { ok: false, message: '正在申请中...' };
    requestingPermission.value = true;
    try {
      const result = await requestPermissionForUrl(currentUrl.value);
      if (result.ok) await refreshPageContext();
      return { ok: result.ok, message: result.message };
    } finally {
      requestingPermission.value = false;
    }
  }

  /**
   * 计划阶段：先快照当前页面，再调 BFF 的 planning prompt 让模型评估并输出计划。
   * 不执行任何写操作。计划返回后等用户确认。
   */
  async function requestPlan(): Promise<void> {
    const text = instruction.value.trim();
    if (!text || isBusy.value) return;

    settings.value = settingsService.load().normalized;
    if (!settings.value.advanced.bffBaseUrl || !settings.value.advanced.bffApiToken) {
      runState.value = 'failed';
      runError.value = { code: 'CONFIG_MISSING', message: '请先在设置中配置 BFF 地址与接入 token。' };
      return;
    }

    await refreshPageContext();
    isPlanning.value = true;
    runError.value = null;
    pendingPlan.value = null;
    planReasoning.value = '';

    try {
      // 先快照当前页面，把快照作为 context 传给 planning prompt。
      // 快照只读，不需要调试会话 -- 但需要 host 权限。
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = tab?.id;
      if (typeof tabId !== 'number') {
        isPlanning.value = false;
        runState.value = 'failed';
        runError.value = { code: 'ACTIVE_TAB_MISSING', message: '未找到活动标签页。' };
        return;
      }

      let snapshot: unknown = null;
      try {
        snapshot = await send({ type: MessageType.ContentSnapshot, tabId });
      } catch {
        // 快照失败不阻断计划 -- 模型仍可基于指令评估，只是看不到当前页面。
      }

      const result = await runAgent(
        toBffConfig(settings.value),
        sessionId.value,
        text,
        snapshot ? { snapshot } : {},
        'planning',
        true, // skipTools: 计划阶段不让模型调工具
      );

      if (result.type !== 'final') {
        // skipTools 时模型不应返回 tool_calls，但防御性处理。
        isPlanning.value = false;
        runState.value = 'failed';
        runError.value = { code: 'EXECUTION_FAILED', message: '计划阶段意外收到工具调用请求。' };
        return;
      }

      // result.output 是 planningProtocol 校验后的结构化对象。
      pendingPlan.value = result.output as TaskPlan;
      planReasoning.value = result.reasoning ?? '';
      isPlanning.value = false;
    } catch (error) {
      isPlanning.value = false;
      runState.value = 'failed';
      const message = error instanceof BffError ? error.message : error instanceof Error ? error.message : String(error);
      runError.value = { code: 'EXECUTION_FAILED', message };
    }
  }

  /** 用户确认计划后进入执行阶段。 */
  async function confirmPlan(): Promise<void> {
    if (!pendingPlan.value) return;
    pendingPlan.value = null;
    // 执行阶段用原指令走 free-form prompt（带 tools）。
    await submitInstruction();
  }

  /** 用户取消计划。 */
  function rejectPlan(): void {
    pendingPlan.value = null;
    planReasoning.value = '';
    runState.value = 'idle';
    runError.value = null;
  }

  /** 提交一条指令，直接进入执行循环（不经过计划阶段）。 */
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
          currentSteps.value = [...currentSteps.value, { ...event, output: humanizeStepOutput(event.output) }];
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
    // 每轮都落库：sessionId 是切回旧会话的唯一凭据，丢了它 BFF 侧的上下文就不可达了。
    void saveSession({ id: sessionId.value, turns: turns.value });
  }

  /** 刷新会话列表。 */
  async function refreshSessions(): Promise<void> {
    sessions.value = await loadSessions();
  }

  /**
   * 切到另一个会话。
   * 恢复 turns 只是为了展示；真正让多轮指代继续成立的是 sessionId ——
   * BFF 会按这个 id 从 SQLite 里取回完整历史。
   */
  async function switchSession(id: string): Promise<void> {
    if (isBusy.value || id === sessionId.value) return;
    const target = await getSession(id);
    if (!target) return;
    sessionId.value = target.id;
    turns.value = [...target.turns];
    currentSteps.value = [];
    runState.value = 'idle';
    runError.value = null;
    // 会话级授权不跨会话沿用：切过去等于换了一个上下文，重新征询更安全。
    approvalGate.resetSession();
  }

  /** 删除一个会话。删的是当前会话时同时开一个新的。 */
  async function removeSession(id: string): Promise<void> {
    await deleteSession(id);
    await refreshSessions();
    if (id === sessionId.value) startNewSession();
  }

  /** 停止当前任务。 */
  async function stop(): Promise<void> {
    abortController?.abort();
    // 若正卡在审批对话框上，一并按拒绝处理，否则 Promise 永远不会 resolve。
    approvalResolver?.({ approved: false, reason: '任务已被停止。' });
    await cdpActionService.detach();
  }

  /**
   * 开新会话。
   * 只切换到新 id，不删除旧会话 —— 旧会话仍在列表里，可以切回去继续。
   */
  function startNewSession(): void {
    sessionId.value = newSessionId();
    turns.value = [];
    currentSteps.value = [];
    runState.value = 'idle';
    runError.value = null;
    approvalGate.resetSession();
    void refreshSessions();
  }

  return {
    runState,
    runError,
    instruction,
    turns,
    currentSteps,
    sessionId,
    sessions,
    currentUrl,
    currentTitle,
    urlAllowed,
    urlAllowReason,
    hostPermissionOk,
    requestingPermission,
    requestHostPermission,
    pendingApproval,
    pendingPlan,
    planReasoning,
    isPlanning,
    isBusy,
    canSubmit,
    approve,
    deny,
    requestPlan,
    confirmPlan,
    rejectPlan,
    submitInstruction,
    stop,
    startNewSession,
    switchSession,
    removeSession,
    refreshSessions,
    refreshPageContext,
    summarizeAction,
    MessageType,
  };
}

/** 模型最终输出可能是字符串或结构化对象，统一转为可读文本。 */
function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '(无输出)';
  return JSON.stringify(output, null, 2);
}
