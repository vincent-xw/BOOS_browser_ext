import type { ElementRole, LocateResult, ObservedRequest, PageSnapshot, VerifyRequest, VerifyResult } from '../types/cdp';
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
  'browser.read_page',
  'browser.locate_element',
  'browser.click',
  'browser.input_text',
  'browser.press_key',
  'browser.scroll',
  'browser.verify',
  'browser.screenshot',
] as const;

export type ToolName = (typeof TOOL_ALLOWLIST)[number];

const allowSet = new Set<string>(TOOL_ALLOWLIST);

/** 工具名是否在白名单内。 */
export function isAllowedTool(name: string): name is ToolName {
  return allowSet.has(name);
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
    return invalid('缺少有效的 x / y 坐标（必须是有限数值，单位为 CSS 像素）。');
  }
  return { ok: true, value: { x, y } };
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
      case 'browser.read_page':
        return await send<PageSnapshot>({
          type: MessageType.ContentReadPage,
          tabId,
          includeCandidateList: input.includeCandidateList === true,
        });

      case 'browser.locate_element': {
        const role = input.role;
        if (!isElementRole(role)) return invalid(`role 不是受支持的元素角色：${String(role)}`);
        return await send<LocateResult>({
          type: MessageType.ContentLocate,
          tabId,
          locator: {
            role,
            ...(typeof input.selector === 'string' ? { selector: input.selector } : {}),
            ...(typeof input.index === 'number' ? { index: input.index } : {}),
          },
        });
      }

      case 'browser.click': {
        const point = requirePoint(input);
        if (!point.ok) return point;
        return await send({
          type: MessageType.CdpClick,
          tabId,
          x: point.value.x,
          y: point.value.y,
          ...(typeof input.label === 'string' ? { label: input.label } : {}),
        });
      }

      case 'browser.input_text': {
        const point = requirePoint(input);
        if (!point.ok) return point;
        const text = requireString(input, 'text');
        if (!text.ok) return text;
        return await send({ type: MessageType.CdpInputText, tabId, x: point.value.x, y: point.value.y, text: text.value });
      }

      case 'browser.press_key': {
        const key = input.key;
        if (typeof key !== 'string') return invalid('缺少 key 字段。');
        return await send({
          type: MessageType.CdpPressKey,
          tabId,
          key: key as PressableKey,
          ...(Array.isArray(input.modifiers) ? { modifiers: input.modifiers as KeyModifier[] } : {}),
        });
      }

      case 'browser.scroll': {
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

      case 'browser.verify':
        return await runVerification(input as VerifyRequest, options);

      case 'browser.screenshot':
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

/** 受支持的元素角色。与 BFF 侧工具定义中的枚举保持一致。 */
const ELEMENT_ROLES = [
  'candidateListItem',
  'candidateName',
  'resumeContainer',
  'favoriteButton',
  'greetButton',
  'messageInput',
  'sendButton',
  'dialog',
] as const satisfies readonly ElementRole[];

function isElementRole(value: unknown): value is ElementRole {
  return typeof value === 'string' && (ELEMENT_ROLES as readonly string[]).includes(value);
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
