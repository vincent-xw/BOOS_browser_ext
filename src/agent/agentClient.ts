import type { ApprovalGate } from './approvalGate';
import { executeTool, isAllowedTool } from './toolExecutor';
import type { MessageSender } from './toolExecutor';
import type { AppSettings } from '../types/settings';

/**
 * Tool Host 客户端。
 *
 * 扩展只做两件事：向 BFF 发起 run，然后执行 BFF 要求的白名单工具并回填结果。
 * 扩展不持有模型 Endpoint、模型名或 API Key —— 那些只存在于 BFF 进程环境。
 */

/** BFF 连接配置。接入 token 不是 LLM API Key。 */
export interface BffConfig {
  baseUrl: string;
  apiToken: string;
  requestTimeoutMs?: number;
}

/** 从扩展设置构造 BFF 连接配置。 */
export function toBffConfig(settings: AppSettings): BffConfig {
  return {
    baseUrl: settings.advanced.bffBaseUrl,
    apiToken: settings.advanced.bffApiToken,
    requestTimeoutMs: settings.advanced.bffRequestTimeoutMs,
  };
}

/** BFF 返回的挂起工具调用。 */
export interface PendingToolCall {
  callId: string;
  toolName: string;
  input: unknown;
}

/** BFF 运行结果。复数形态：一轮可能包含多个调用。 */
export type AgentRunResult =
  | { type: 'final'; output: unknown }
  | { type: 'pending_tool_calls'; calls: PendingToolCall[] };

/** BFF 错误响应。只含这三项，不回显 Prompt 正文或密钥。 */
export interface BffErrorPayload {
  code: string;
  requestId: string;
  message: string;
}

export class BffError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BffError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 发起一次带超时的 BFF 请求。 */
async function callBff<T>(config: BffConfig, path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${path}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as T | BffErrorPayload | null;
    if (!response.ok) {
      const error = (payload ?? {}) as BffErrorPayload;
      // 401 单独处理：这是配置问题而不是运行时故障，提示必须指向设置项。
      if (response.status === 401) {
        throw new BffError('UNAUTHORIZED', 'BFF 鉴权失败，请检查设置中的 BFF 地址与接入 token。', error.requestId, 401);
      }
      throw new BffError(error.code ?? 'BFF_ERROR', error.message ?? `BFF 返回 HTTP ${response.status}`, error.requestId, response.status);
    }
    if (!payload) throw new BffError('BFF_ERROR', 'BFF 响应不是有效 JSON。');
    return payload as T;
  } catch (error) {
    if (error instanceof BffError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BffError('TIMEOUT', `BFF 请求超时（${config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS}ms）。`);
    }
    throw new BffError('NETWORK_ERROR', `无法连接 BFF：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 发起 agent 运行。promptName 用于选择 BFF 侧已注册的提示词。 */
export function runAgent(
  config: BffConfig,
  sessionId: string,
  input: string,
  context: Record<string, unknown> = {},
  promptName?: string,
): Promise<AgentRunResult> {
  return callBff<AgentRunResult>(config, `/v1/agent/sessions/${encodeURIComponent(sessionId)}/run`, {
    input,
    context,
    ...(promptName ? { promptName } : {}),
  });
}

/** 回填单个工具结果。 */
export function submitToolResult(config: BffConfig, sessionId: string, callId: string, output: unknown): Promise<AgentRunResult> {
  return callBff<AgentRunResult>(
    config,
    `/v1/agent/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(callId)}`,
    { output },
  );
}

/** 连通性检查。区分「地址不可达」与「凭据无效」—— 两者的处置完全不同。 */
export async function checkBffConnectivity(config: BffConfig): Promise<{ ok: boolean; reason: 'reachable' | 'unreachable' | 'unauthorized'; message: string }> {
  try {
    // 用一个必然存在的路径探活。鉴权失败会先于业务逻辑返回 401。
    await runAgent({ ...config, requestTimeoutMs: 8000 }, `connectivity-${Date.now()}`, 'ping', {});
    return { ok: true, reason: 'reachable', message: 'BFF 可达且凭据有效。' };
  } catch (error) {
    if (error instanceof BffError) {
      if (error.status === 401) return { ok: false, reason: 'unauthorized', message: '接入 token 无效，请检查设置中的 token 是否与 BFF 的 BFF_API_TOKEN 一致。' };
      if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
        return { ok: false, reason: 'unreachable', message: `BFF 地址不可达：${error.message}` };
      }
      // 能返回业务错误码说明 HTTP 通路与鉴权都是通的。
      return { ok: true, reason: 'reachable', message: `BFF 可达（返回 ${error.code}），凭据有效。` };
    }
    return { ok: false, reason: 'unreachable', message: String(error) };
  }
}

/** 单步执行事件，供 UI 展示当前进度。 */
export interface StepEvent {
  step: number;
  toolName: string;
  input: unknown;
  output: unknown;
  allowed: boolean;
  /** 是否被用户拒绝。与 allowed=false（白名单外）区分开。 */
  denied?: boolean;
}

export interface AgentSessionOptions {
  config: BffConfig;
  sessionId: string;
  tabId: number;
  send: MessageSender;
  /** 最大轮次上限，防止模型陷入循环。 */
  maxSteps?: number;
  onStep?: (event: StepEvent) => void;
  signal?: AbortSignal;
  /** 指定 BFF 侧的提示词。省略时用 BFF 的默认提示词（free-form）。 */
  promptName?: string;
  /** 审批门。提供时写操作需先获批；省略时不做审批（预设流程走这条）。 */
  approval?: ApprovalGate;
  /** 当前页面 URL，用于审批展示与域名级授权判定。 */
  currentUrl?: string;
}

/**
 * 驱动完整的 agent 闭环。
 *
 * 每收到 pending_tool_calls 就逐个执行并回填 —— 同轮全部回填后 BFF 才推进模型。
 * 白名单外的工具名不执行任何页面动作，直接回填未授权结果。
 * 注入审批门时，写操作需先获得用户批准；被拒绝的动作把拒绝原因回填给模型，
 * 让它知道该动作没有发生，而不是误以为成功。
 */
export async function runAgentSession(input: string, options: AgentSessionOptions): Promise<{ output: unknown; steps: number }> {
  const { config, sessionId, tabId, send, onStep, approval } = options;
  const maxSteps = options.maxSteps ?? 30;

  let result = await runAgent(config, sessionId, input, {}, options.promptName);
  let step = 0;

  while (result.type === 'pending_tool_calls') {
    if (options.signal?.aborted) throw new BffError('ABORTED', '任务已被停止。');
    if (step >= maxSteps) throw new BffError('STEP_LIMIT', `已达最大步数 ${maxSteps}，任务中止以避免无限循环。`);

    let next: AgentRunResult = result;
    for (const call of result.calls) {
      if (options.signal?.aborted) throw new BffError('ABORTED', '任务已被停止。');
      step += 1;
      const allowed = isAllowedTool(call.toolName);

      let output: unknown;
      let denied = false;
      if (!allowed) {
        output = await executeTool(call.toolName, call.input, { tabId, send });
      } else if (approval) {
        const decision = await approval.requestPermission(call.toolName, call.input, options.currentUrl ?? '');
        if (decision.approved) {
          output = await executeTool(call.toolName, call.input, { tabId, send });
        } else {
          denied = true;
          output = {
            ok: false,
            code: 'USER_DENIED',
            message: decision.reason ?? '用户拒绝了该操作，动作未执行。请不要尝试绕过，直接说明该步未获批准。',
          };
        }
      } else {
        output = await executeTool(call.toolName, call.input, { tabId, send });
      }

      onStep?.({ step, toolName: call.toolName, input: call.input, output, allowed, ...(denied ? { denied } : {}) });
      // 逐个回填。全部回填完毕后 BFF 才会推进模型并返回下一轮或 final。
      next = await submitToolResult(config, sessionId, call.callId, output);
    }
    result = next;
  }

  return { output: result.output, steps: step };
}
