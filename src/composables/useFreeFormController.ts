import { computed, ref } from 'vue';

import { BffError, runAgent, startExecute, submitToolResult, toBffConfig } from '../agent/agentClient';
import type { StepEvent, TaskPlan } from '../agent/agentClient';
import { createApprovalGate, summarizeAction } from '../agent/approvalGate';
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '../agent/approvalGate';
import { createSseClient } from '../agent/sseClient';
import { createMessageSender, executeTool, isAllowedTool } from '../agent/toolExecutor';
import { cdpActionService } from '../services/cdpActionService';
import { hasUrlPermission, loadAllowRules, requestPermissionForUrl, addAllowRule } from '../services/permissionService';
import {
  deleteSession,
  getSession,
  loadSessions,
  newSessionId,
  saveSession,
  buildTitlePrompt,
} from '../services/freeFormSessionStore';
import type { ConversationTurn, StoredSession } from '../services/freeFormSessionStore';
import { isUrlAllowed } from '../services/urlAllowlist';
import { settingsService } from '../services/settingsService';
import { useFileAttachments } from './useFileAttachments';
import { MessageType } from '../types/messages';
import type { OperationError, OperationState } from '../types/page-io';

/**
 * 传给计划阶段的正文摘要上限。
 * 足够判断「这是哪个页面、上面有什么」，又不至于把长列表页的全文灌进上下文。
 */
const PAGE_TEXT_LIMIT = 1500;

/**
 * 构造当前日期上下文。
 *
 * 模型没有可靠的「今天」锚点：日期相对指令（最近一周、上个月、下周三）若不告诉它
 * 今天是几号、星期几，它会靠猜测推算，常见症状是算出一个既不是上周也不是下周的
 * 莫名其妙的区间。这里同时显式说明「最近一周」的默认口径，减少歧义。
 */
function buildDateContext(): string {
  const now = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const weekAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const wa = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, '0')}-${String(weekAgo.getDate()).padStart(2, '0')}`;
  return `今天是 ${y}-${m}-${d}（${weekdays[now.getDay()]}）。涉及日期范围时，「最近一周 / 近 7 天」若无特别说明指从今天往前推 7 天（${wa} 至 ${y}-${m}-${d}，含今天），不要理解成某个自然周或未来的一周。`;
}

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

  const attachments = useFileAttachments();

  // SSE 客户端：BFF 通过事件流推送 tool_call/final/error。
  const sse = createSseClient();
  const llmStatus = ref('');
  const currentToolName = ref('');
  let currentTabId = -1;
  let currentInstruction = '';

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

  // ── SSE 事件处理 ──────────────────────────────────────

  sse.onToolCall(async (event) => {
    if (event.sessionId !== sessionId.value || runState.value !== 'running') return;
    await handleToolCall(event.callId, event.toolName, event.input);
  });

  sse.onFinal((event) => {
    if (event.sessionId !== sessionId.value || runState.value !== 'running') return;
    appendTurn('agent', formatOutput(event.output), currentSteps.value);
    runState.value = 'succeeded';
    llmStatus.value = '';
    currentToolName.value = '';
    void cdpActionService.detach();
    void generateSessionTitle();
  });

  sse.onError((event) => {
    if (event.sessionId && event.sessionId !== sessionId.value) return;
    runState.value = 'failed';
    runError.value = { code: 'EXECUTION_FAILED', message: event.message };
    appendTurn('error', event.message, currentSteps.value, runError.value);
    llmStatus.value = '';
    currentToolName.value = '';
    void cdpActionService.detach();
  });

  sse.onLlmStatus((event) => {
    if (runState.value !== 'running') return;
    llmStatus.value = event.type === 'llm_request' ? '思考中…' : '';
  });

  async function handleToolCall(callId: string, toolName: string, rawInput: unknown): Promise<void> {
    const step = currentSteps.value.length + 1;
    const allowed = isAllowedTool(toolName);
    currentToolName.value = toolName;

    let output: unknown;
    let denied = false;

    if (!allowed) {
      output = await executeTool(toolName, rawInput, { tabId: currentTabId, send, userInstruction: currentInstruction });
    } else if (settings.value.advanced.approvalEnabled) {
      const decision = await approvalGate.requestPermission(toolName, rawInput, currentUrl.value);
      if (decision.approved) {
        output = await executeTool(toolName, rawInput, { tabId: currentTabId, send, userInstruction: currentInstruction });
      } else {
        denied = true;
        output = {
          ok: false,
          code: 'USER_DENIED',
          message: decision.reason ?? '用户拒绝了该操作，动作未执行。请不要尝试绕过，直接说明该步未获批准。',
        };
      }
    } else {
      output = await executeTool(toolName, rawInput, { tabId: currentTabId, send, userInstruction: currentInstruction });
    }

    currentSteps.value = [...currentSteps.value, {
      step,
      toolName,
      input: rawInput,
      output: humanizeStepOutput(output),
      allowed,
      ...(denied ? { denied } : {}),
    }];
    currentToolName.value = '';

    try {
      await submitToolResult(toBffConfig(settings.value), callId, sessionId.value, output);
    } catch (error) {
      runState.value = 'failed';
      const message = error instanceof BffError ? error.message : error instanceof Error ? error.message : String(error);
      runError.value = { code: 'EXECUTION_FAILED', message };
      appendTurn('error', message, currentSteps.value, runError.value);
      void cdpActionService.detach();
    }
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
      // 同时申请 Chrome host 权限和写入白名单，避免用户需要授权两次。
      // 先请求权限，再写入白名单；权限被拒则白名单不写。
      const result = await requestPermissionForUrl(currentUrl.value);
      if (result.ok) {
        try {
          const parsed = new URL(currentUrl.value);
          const domain = parsed.hostname;
          await addAllowRule({ domain, pathPrefix: '' });
        } catch {
          // 白名单写入失败不影响本次授权，只是下次还需要手动添加。
        }
        await refreshPageContext();
      }
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

      // 正文摘要单独取：快照只有可交互元素列表，没有正文，模型看得到一堆按钮
      // 却不知道页面在讲什么，判断不出「已经在目标结果页」。
      let pageText = '';
      try {
        const page = await send<{ bodyPreview?: string }>({ type: MessageType.ContentReadPage, tabId });
        pageText = page?.bodyPreview ?? '';
      } catch {
        // 读正文失败不阻断计划。
      }

      const fileList = attachments.buildFileList();
      const context: Record<string, unknown> = {};
      if (snapshot) context.snapshot = snapshot;
      if (fileList.length) context.fileList = fileList;
      // 日期锚点：模型没有可靠的「今天」，缺了它会把「最近一周」算成莫名其妙的区间。
      context.currentDate = buildDateContext();
      // URL / 标题 / 正文摘要让模型能判断当前页面是否已满足目标，从而跳过重复流程
      // （例如已经停在某个搜索结果页时不必再走一遍搜索）。
      if (tab?.url) context.currentUrl = tab.url;
      if (tab?.title) context.pageTitle = tab.title;
      if (pageText) context.pageText = pageText.slice(0, PAGE_TEXT_LIMIT);

      const result = await runAgent(
        toBffConfig(settings.value),
        sessionId.value,
        text,
        context,
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
    currentTabId = tabId;
    currentInstruction = text;

    turns.value = [...turns.value, { role: 'user', text, timestamp: new Date().toISOString() }];
    instruction.value = '';
    currentSteps.value = [];
    runState.value = 'running';
    runError.value = null;
    llmStatus.value = '';
    currentToolName.value = '';
    abortController = new AbortController();

    // 立即持久化用户轮次，确保会话在任何异步操作前就已入库。
    void saveSession({ id: sessionId.value, turns: turns.value });

    // 写操作需要调试会话。读操作也一并建立，省得中途再要权限。
    const attached = await cdpActionService.attach();
    if (!attached.ok) {
      runState.value = 'failed';
      runError.value = attached.error ?? { code: 'NO_DEBUG_SESSION', message: '无法建立调试连接。' };
      appendTurn('error', runError.value.message);
      return;
    }

    // 确保 SSE 已连接后再启动执行。
    if (sse.status.value === 'disconnected') {
      sse.connect(settings.value.advanced.bffBaseUrl, settings.value.advanced.bffApiToken);
    }

    try {
      const fileList = attachments.buildFileList();
      const context: Record<string, unknown> = {};
      if (fileList.length) context.fileList = fileList;
      context.currentDate = buildDateContext();
      if (currentUrl.value) context.currentUrl = currentUrl.value;
      if (currentTitle.value) context.pageTitle = currentTitle.value;

      await startExecute(toBffConfig(settings.value), sessionId.value, text, context);
    } catch (error) {
      const message = error instanceof BffError ? error.message : error instanceof Error ? error.message : String(error);
      const bff = error instanceof BffError ? error : null;
      runState.value = 'failed';
      runError.value = {
        code: 'EXECUTION_FAILED',
        message,
        ...(bff?.code ? { bffCode: bff.code } : {}),
        ...(bff?.requestId ? { requestId: bff.requestId } : {}),
      };
      appendTurn('error', message, currentSteps.value, runError.value);
      await cdpActionService.detach();
    }
  }

  function appendTurn(role: ConversationTurn['role'], text: string, steps?: StepEvent[], error?: OperationError): void {
    turns.value = [
      ...turns.value,
      {
        role,
        text,
        timestamp: new Date().toISOString(),
        ...(steps && steps.length ? { steps: [...steps] } : {}),
        ...(error ? { error } : {}),
      },
    ];
    // 每轮都落库：sessionId 是切回旧会话的唯一凭据，丢了它 BFF 侧的上下文就不可达了。
    void saveSession({ id: sessionId.value, turns: turns.value });
  }

  /**
   * 用 LLM 为当前会话生成一个简短标题。
   *
   * 只在 agent 首次回复后执行一次（titleGenerated=false 时才跑）。
   * 调 BFF 的 run 接口，用 planning prompt（skipTools，纯文本输出），
   * 让模型根据用户指令和执行结果生成一个 10-20 字的标题。
   * 失败时静默 -- 标题不生成不影响功能，只是列表展示用截断的指令文本。
   */
  async function generateSessionTitle(): Promise<void> {
    const targetSessionId = sessionId.value;
    try {
      const existing = sessions.value.find((s) => s.id === targetSessionId);
      if (existing?.titleGenerated) return;

      const titlePrompt = buildTitlePrompt(turns.value);
      const result = await runAgent(
        toBffConfig(settings.value),
        targetSessionId,
        `根据以下对话内容，生成一个10-20字的中文标题，概括这个任务的主题。只输出标题文本，不要标点、不要解释、不要引号。\n\n${titlePrompt}`,
        {},
        'planning',
      );

      if (result.type !== 'final') return;
      const title = String(result.output).trim().slice(0, 30);
      if (!title) return;

      // 异步期间用户可能已切到别的会话，不要写错会话。
      if (sessionId.value !== targetSessionId) return;

      await saveSession({ id: targetSessionId, turns: turns.value, title, titleGenerated: true });
      await refreshSessions();
    } catch {
      // 标题生成失败不影响功能。
    }
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
    turns.value = (Array.isArray(target.turns) ? target.turns : []).map((turn) => ({
      ...turn,
      ...(Array.isArray(turn.steps) ? {} : { steps: [] }),
    }));
    currentSteps.value = [];
    runState.value = 'idle';
    runError.value = null;
    llmStatus.value = '';
    currentToolName.value = '';
    pendingPlan.value = null;
    planReasoning.value = '';
    approvalGate.resetSession();
  }

  /** 删除一个会话。删的是当前会话时同时开一个新的。 */
  async function removeSession(id: string): Promise<void> {
    await deleteSession(id);
    await refreshSessions();
    if (id === sessionId.value) startNewSession();
  }

  /** 停止当前任务。 */
  const isStopping = ref(false);
  async function stop(): Promise<void> {
    isStopping.value = true;
    abortController?.abort();
    approvalResolver?.({ approved: false, reason: '任务已被停止。' });
    llmStatus.value = '';
    currentToolName.value = '';
    await cdpActionService.detach();
    isStopping.value = false;
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
    llmStatus.value = '';
    currentToolName.value = '';
    pendingPlan.value = null;
    planReasoning.value = '';
    approvalGate.resetSession();
    void refreshSessions();
  }

  // 初始化时尝试连接 SSE（设置已配置时）。
  if (settings.value.advanced.bffBaseUrl && settings.value.advanced.bffApiToken) {
    sse.connect(settings.value.advanced.bffBaseUrl, settings.value.advanced.bffApiToken);
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
    llmStatus,
    currentToolName,
    sseStatus: sse.status,
    approve,
    deny,
    requestPlan,
    confirmPlan,
    rejectPlan,
    submitInstruction,
    stop,
    isStopping,
    startNewSession,
    switchSession,
    removeSession,
    refreshSessions,
    refreshPageContext,
    summarizeAction,
    MessageType,
    attachments,
  };
}

/** 模型最终输出可能是字符串或结构化对象，统一转为可读文本。 */
function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '(无输出)';
  return JSON.stringify(output, null, 2);
}
