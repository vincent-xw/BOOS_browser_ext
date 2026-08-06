import type {
  LocateResult,
  ObservedRequest,
  PageSnapshot,
  PageSnapshotResult,
  RefResolution,
  VerifyRequest,
  VerifyResult,
} from '../types/cdp';
import { evaluateNetworkDimension } from '../services/networkVerifier';
import { MessageType } from '../types/messages';
import type { ExtensionRequest, KeyModifier, MessageResponse, PressableKey } from '../types/messages';

/**
 * 远端工具的扩展侧实现。
 *
 * 每个工具都对应 BFF 侧注册的一个 `execution: 'remote'` 定义。BFF 只校验结构，
 * 真正的页面操作在这里发生 —— 读取/定位/验证转给 content script，写操作转给 CDP。
 */

/** 白名单。BFF 下发的工具名必须在这里，否则拒绝执行任何页面动作。 */
export const TOOL_ALLOWLIST = [
  'browser_snapshot',
  'browser_read_page',
  'browser_locate_element',
  'browser_click',
  'browser_input_text',
  'browser_press_key',
  'browser_scroll',
  'browser_verify',
  'browser_screenshot',
] as const;

/** 只读工具：不改变页面状态，审批时可自动放行。 */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'browser_snapshot',
  'browser_read_page',
  'browser_locate_element',
  'browser_verify',
  'browser_screenshot',
];

export type ToolName = (typeof TOOL_ALLOWLIST)[number];

const allowSet = new Set<string>(TOOL_ALLOWLIST);
const readOnlySet = new Set<string>(READ_ONLY_TOOLS);

/** 工具名是否在白名单内。 */
export function isAllowedTool(name: string): name is ToolName {
  return allowSet.has(name);
}

/** 该工具是否只读。只读工具不改变页面状态，审批可自动放行。 */
export function isReadOnlyTool(name: string): boolean {
  return readOnlySet.has(name);
}

/** 工具执行失败的结构化结果。会被回填给 BFF，让模型知道发生了什么。 */
export interface ToolFailure {
  ok: false;
  code: 'TOOL_NOT_ALLOWED' | 'TOOL_INPUT_INVALID' | 'TOOL_EXECUTION_FAILED';
  message: string;
}

/** 输入校验结果。 */
type Validated<T> = { ok: true; value: T } | ToolFailure;

function invalid(message: string): ToolFailure {
  return { ok: false, code: 'TOOL_INPUT_INVALID', message };
}

/** 校验坐标对。坐标必须是有限数值 —— NaN 传给 CDP 不会报错，只是点不到东西。 */
function requirePoint(input: Record<string, unknown>): Validated<{ x: number; y: number }> {
  const { x, y } = input;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    return invalid('缺少有效的定位信息：请给出 ref（推荐，来自 browser_snapshot），或有限数值的 x / y 坐标。');
  }
  return { ok: true, value: { x, y } };
}

/**
 * 解析动作目标的坐标。
 *
 * 传了 ref 就按 ref 取**当前**坐标 —— 这是「每步重新算坐标」纪律的实现点：
 * 模型可以放心引用几轮之前快照里的 ref，坐标由这里保证新鲜。
 * 只传 x/y 时按原样使用（预设流程走这条）。
 */
async function resolveTargetPoint(
  input: Record<string, unknown>,
  options: ToolExecutorOptions,
): Promise<Validated<{ x: number; y: number; label?: string }>> {
  if (typeof input.ref === 'number') {
    const resolution = await options.send<RefResolution>({
      type: MessageType.ContentResolveRef,
      tabId: options.tabId,
      ref: input.ref,
    });
    if (!resolution.found || typeof resolution.x !== 'number' || typeof resolution.y !== 'number') {
      return {
        ok: false,
        code: 'TOOL_INPUT_INVALID',
        message: resolution.message ?? `ref ${input.ref} 无法解析为坐标，请重新调用 browser_snapshot。`,
      };
    }
    if (resolution.occluded) {
      return {
        ok: false,
        code: 'TOOL_EXECUTION_FAILED',
        message: `目标被 ${resolution.occludedBy ?? '其他元素'} 遮挡，未执行动作。请先处理遮挡。`,
      };
    }
    return { ok: true, value: { x: resolution.x, y: resolution.y, ...(resolution.label ? { label: resolution.label } : {}) } };
  }
  const point = requirePoint(input);
  if (!point.ok) return point;
  return { ok: true, value: point.value };
}

function requireString(input: Record<string, unknown>, key: string): Validated<string> {
  const value = input[key];
  if (typeof value !== 'string') return invalid(`缺少字符串字段 ${key}。`);
  return { ok: true, value };
}

/** 消息发送器。抽成参数便于测试时替换，也避免这里直接依赖 chrome。 */
export type MessageSender = <T>(message: ExtensionRequest) => Promise<T>;

/** 创建消息发送器：把 MessageResponse 信封拆开，失败转异常。 */
export function createMessageSender(): MessageSender {
  return async <T>(message: ExtensionRequest): Promise<T> => {
    const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T> | undefined;
    if (!response) throw new Error('Service Worker 无响应');
    if (!response.ok) throw new Error(`${response.code}: ${response.message}${response.details ? `（${response.details}）` : ''}`);
    return response.data;
  };
}

export interface ToolExecutorOptions {
  tabId: number;
  send: MessageSender;
}

/**
 * 执行一个远端工具。
 *
 * 白名单外的工具名不执行任何页面动作 —— 直接回填「未授权」。
 * 这是扩展作为 Tool Host 的核心安全边界：BFF 被攻破也不能让它驱动任意浏览器操作。
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  options: ToolExecutorOptions,
): Promise<unknown> {
  if (!isAllowedTool(name)) {
    return { ok: false, code: 'TOOL_NOT_ALLOWED', message: `工具未授权：${name}。扩展仅执行白名单内的远端工具。` } satisfies ToolFailure;
  }

  const input = (rawInput ?? {}) as Record<string, unknown>;
  const { tabId, send } = options;

  try {
    switch (name) {
      case 'browser_snapshot':
        return await send<PageSnapshotResult>({ type: MessageType.ContentSnapshot, tabId });

      case 'browser_read_page':
        return await send<PageSnapshot>({ type: MessageType.ContentReadPage, tabId });

      case 'browser_locate_element': {
        // ref 与 selector 至少给一个。
        if (input.ref === undefined && input.selector === undefined) {
          return invalid('定位需要 ref 或 selector。建议先调用 browser_snapshot 取 ref。');
        }
        return await send<LocateResult>({
          type: MessageType.ContentLocate,
          tabId,
          locator: {
            ...(typeof input.selector === 'string' ? { selector: input.selector } : {}),
            ...(typeof input.ref === 'number' ? { ref: input.ref } : {}),
            ...(typeof input.index === 'number' ? { index: input.index } : {}),
          },
        });
      }

      case 'browser_click': {
        const target = await resolveTargetPoint(input, options);
        if (!target.ok) return target;
        const label = typeof input.label === 'string' ? input.label : target.value.label;
        return await send({
          type: MessageType.CdpClick,
          tabId,
          x: target.value.x,
          y: target.value.y,
          ...(label ? { label } : {}),
        });
      }

      case 'browser_input_text': {
        const target = await resolveTargetPoint(input, options);
        if (!target.ok) return target;
        const text = requireString(input, 'text');
        if (!text.ok) return text;
        // clearFirst：先全选再让 insertText 覆盖。不这样做会追加到已有内容后面。
        if (input.clearFirst === true) {
          await send({ type: MessageType.CdpClick, tabId, x: target.value.x, y: target.value.y });
          await send({ type: MessageType.CdpPressKey, tabId, key: 'Backspace', modifiers: ['Meta'] });
        }
        return await send({ type: MessageType.CdpInputText, tabId, x: target.value.x, y: target.value.y, text: text.value });
      }

      case 'browser_press_key': {
        const key = input.key;
        if (typeof key !== 'string') return invalid('缺少 key 字段。');
        return await send({
          type: MessageType.CdpPressKey,
          tabId,
          key: key as PressableKey,
          ...(Array.isArray(input.modifiers) ? { modifiers: input.modifiers as KeyModifier[] } : {}),
        });
      }

      case 'browser_scroll': {
        const deltaY = input.deltaY;
        if (typeof deltaY !== 'number' || !Number.isFinite(deltaY)) return invalid('缺少有效的 deltaY。');
        return await send({
          type: MessageType.CdpScroll,
          tabId,
          deltaY,
          ...(typeof input.x === 'number' ? { x: input.x } : {}),
          ...(typeof input.y === 'number' ? { y: input.y } : {}),
        });
      }

      case 'browser_verify':
        return await runVerification(input as VerifyRequest, options);

      case 'browser_screenshot':
        return await send({
          type: MessageType.CdpScreenshot,
          tabId,
          ...(input.format === 'jpeg' || input.format === 'png' ? { format: input.format } : {}),
        });
    }
  } catch (error) {
    return {
      ok: false,
      code: 'TOOL_EXECUTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    } satisfies ToolFailure;
  }
}

/**
 * 验证需要跨两个上下文合并：
 * DOM 维度在 content script 里读，网络维度的数据源在 Service Worker 的 CDP Network 事件里。
 */
async function runVerification(request: VerifyRequest, options: ToolExecutorOptions): Promise<VerifyResult> {
  const { tabId, send } = options;
  const domRequest: VerifyRequest = { ...request };
  delete domRequest.expectNetwork;

  const hasDomDimension = Boolean(
    domRequest.expectDialog || domRequest.expectDomChangeIn || domRequest.expectInputValue || domRequest.expectButtonEnabled,
  );

  const domResult = hasDomDimension
    ? await send<VerifyResult>({ type: MessageType.ContentVerify, tabId, request: domRequest })
    : { passed: true, dimensions: [], message: '' };

  if (!request.expectNetwork) return domResult;

  const { requests } = await send<{ requests: ObservedRequest[] }>({
    type: MessageType.CdpNetworkCollect,
    tabId,
    urlPattern: request.expectNetwork.urlPattern,
  });
  const networkDimension = evaluateNetworkDimension(requests, request.expectNetwork);

  const dimensions = [...domResult.dimensions, networkDimension];
  const passed = dimensions.every((dimension) => dimension.passed);
  const failed = dimensions.filter((dimension) => !dimension.passed);
  return {
    passed,
    dimensions,
    ...(domResult.timedOut ? { timedOut: true } : {}),
    message: passed
      ? '全部验证维度均已通过。'
      : `未通过：${failed.map((dimension) => `${dimension.dimension}=${dimension.observed}`).join('；')}`,
  };
}
