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

/** BFF 运行结果。复数形态：一轮可能包含多个调用。reasoning 是模型思考链。 */
export type AgentRunResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  | { type: 'pending_tool_calls'; calls: PendingToolCall[] };

/** 计划阶段的结构化输出。与 BFF 侧 planningProtocol 对应。 */
export interface TaskPlan {
  feasible: boolean;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  steps: Array<{ action: string; tool: string; write: boolean; note?: string }>;
  risks: string[];
  cannotDo: string[];
}

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

/** 发起 agent 运行。promptName 用于选择 BFF 侧已注册的提示词。skipTools 时不发 tools 字段。 */
export function runAgent(
  config: BffConfig,
  sessionId: string,
  input: string,
  context: Record<string, unknown> = {},
  promptName?: string,
  skipTools?: boolean,
): Promise<AgentRunResult> {
  return callBff<AgentRunResult>(config, `/v1/agent/sessions/${encodeURIComponent(sessionId)}/run`, {
    input,
    context,
    ...(promptName ? { promptName } : {}),
    ...(skipTools ? { skipTools: true } : {}),
  });
}

/** 启动 SSE 驱动的执行。立即返回（BFF 返回 202），后续步骤通过 SSE 事件推送。 */
export async function startExecute(
  config: BffConfig,
  sessionId: string,
  input: string,
  context: Record<string, unknown> = {},
  promptName?: string,
): Promise<void> {
  await callBff<{ accepted: boolean }>(config, '/api/execute', {
    sessionId,
    input,
    context,
    ...(promptName ? { promptName } : {}),
  });
}

/** 回填单个工具结果。SSE 模式下 BFF 返回 202，后续步骤通过事件推送。 */
export async function submitToolResult(
  config: BffConfig,
  callId: string,
  sessionId: string,
  output: unknown,
): Promise<void> {
  await callBff<{ accepted: boolean }>(
    config,
    `/api/tool-results/${encodeURIComponent(callId)}`,
    { sessionId, output },
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
  /** 该步执行前模型的思考过程。 */
  reasoning?: string;
}
