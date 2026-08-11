import type {
  LocateResult,
  ObservedRequest,
  PageSnapshot,
  PageSnapshotResult,
  RefResolution,
  VerifyRequest,
  VerifyResult,
  WaitForRequest,
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
  'browser_hover',
  'browser_wait_for',
  'browser_input_text',
  'browser_press_key',
  'browser_scroll',
  'browser_go_back',
  'browser_verify',
  'browser_screenshot',
  'browser_save_file',
  'browser_read_file',
  'browser_write_file',
] as const;

/** 只读工具：不改变页面状态，审批时可自动放行。 */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'browser_snapshot',
  'browser_read_page',
  'browser_locate_element',
  'browser_verify',
  'browser_screenshot',
  // hover 只移动鼠标，不能提交/导航/输入。若要审批，每次探索下拉都会弹窗，
  // 反而训练用户盲点「同意」。
  'browser_hover',
  'browser_wait_for',
  'browser_save_file',
  'browser_read_file',
  'browser_write_file',
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

/**
 * 校验并归一化 browser_wait_for 的入参。
 *
 * 抽成纯函数是为了可测：扩展的测试跑在 node 环境，碰不到 DOM 与 chrome。
 */
export function normalizeWaitFor(input: Record<string, unknown>): Validated<WaitForRequest> {
  const condition = input.condition;
  if (condition !== 'appear' && condition !== 'disappear' && condition !== 'stable') {
    return invalid('condition 必须是 appear / disappear / stable 之一。');
  }

  const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
  if (condition !== 'stable' && !selector) {
    return invalid(`condition=${condition} 需要提供 selector。`);
  }

  return {
    ok: true,
    value: {
      condition,
      ...(selector ? { selector } : {}),
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: clamp(input.timeoutMs, 100, 15_000) } : {}),
      ...(typeof input.stableMs === 'number' ? { stableMs: clamp(input.stableMs, 100, 3_000) } : {}),
    },
  };
}

/** 把数值夹到区间内。模型给出越界值时纠正而不是报错。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
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

      case 'browser_hover': {
        const target = await resolveTargetPoint(input, options);
        if (!target.ok) return target;
        const label = typeof input.label === 'string' ? input.label : target.value.label;
        return await send({
          type: MessageType.CdpHover,
          tabId,
          x: target.value.x,
          y: target.value.y,
          ...(label ? { label } : {}),
          ...(typeof input.settleMs === 'number' ? { settleMs: input.settleMs } : {}),
        });
      }

      case 'browser_wait_for': {
        const request = normalizeWaitFor(input);
        if (!request.ok) return request;
        return await send({ type: MessageType.ContentWaitFor, tabId, request: request.value });
      }

      case 'browser_input_text': {
        const target = await resolveTargetPoint(input, options);
        if (!target.ok) return target;
        const text = requireString(input, 'text');
        if (!text.ok) return text;
        // clearFirst 交给 background 在同一次消息里处理：清空依赖「焦点已建立」的选区，
        // 若在这里先发一条清空消息，紧随其后的输入消息会再点击一次，把选区冲掉。
        return await send({
          type: MessageType.CdpInputText,
          tabId,
          x: target.value.x,
          y: target.value.y,
          text: text.value,
          ...(input.clearFirst === true ? { clearFirst: true } : {}),
        });
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

      case 'browser_go_back':
        // 浏览器原生返回。用于点击链接触发非预期导航后回到原页面。
        return await send({ type: MessageType.CdpGoBack, tabId });

      case 'browser_screenshot': {
        const shot = await send<{ dataUrl: string; width: number; height: number }>({
          type: MessageType.CdpScreenshot,
          tabId,
          ...(input.format === 'jpeg' || input.format === 'png' ? { format: input.format } : {}),
        });
        // 截图存入 generatedFiles，UI 展示缩略图供用户查看和下载。
        const { generateScreenshot } = await import('../services/exportService');
        const format = (input.format === 'jpeg' ? 'jpeg' : 'png') as 'png' | 'jpeg';
        const screenshot = generateScreenshot(shot.dataUrl, format, shot.width, shot.height);
        // 绝不把 base64 返回给模型：一张截图约 4 万 token，会挤爆上下文窗口，
        // 导致模型输出退化成畸形字符串（曾表现为工具名被污染后整轮中断）。
        // base64 已存入 generatedFiles 供 UI 使用，模型只需要知道截图存在。
        return {
          width: shot.width,
          height: shot.height,
          screenshotId: screenshot.id,
          message: `截图已保存（${shot.width}x${shot.height}），用户可在对话区域查看和下载。`,
        };
      }

      case 'browser_save_file': {
        // agent 产出数据生成文件。这是只读工具（不改页面），不需要 CDP。
        // 文件在扩展内存里生成，UI 展示下载按钮。
        const filename = typeof input.filename === 'string' ? input.filename : '导出数据';
        const format = input.format;
        const content = typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? '');
        const validFormats = ['txt', 'csv', 'xlsx', 'json'] as const;
        if (!validFormats.includes(format as (typeof validFormats)[number])) {
          return invalid(`不支持的格式：${String(format)}。支持 txt / csv / xlsx / json。`);
        }
        const { generateFile } = await import('../services/exportService');
        const file = generateFile(filename, format as 'txt' | 'csv' | 'xlsx' | 'json', content);
        return {
          ok: true,
          message: `已生成文件 ${file.filename}（${(file.size / 1024).toFixed(1)}KB）。在最终回复里用 markdown 链接 [${file.filename}](${file.url}) 给出下载；如果链接不可用，告诉用户点输入框旁的附件按钮下载。`,
          fileId: file.id,
          filename: file.filename,
        };
      }

      case 'browser_read_file': {
        // 从 IndexedDB 读取持久化的文本文件。跨会话可用。
        const name = input.name;
        if (typeof name !== 'string' || !name.trim()) {
          return invalid('缺少文件名（name 字段）。');
        }
        const { readFile } = await import('../services/exportService');
        const file = await readFile(name);
        if (!file) {
          return {
            ok: false,
            code: 'TOOL_EXECUTION_FAILED',
            message: `文件「${name}」不存在。可用文件列表请参考上下文中的 fileList。`,
          };
        }
        // 大文件截断：默认返回前 50000 字符 + 总长度提示。
        const maxChars = 50000;
        const truncated = file.content.length > maxChars;
        return {
          ok: true,
          name: file.name,
          content: truncated ? file.content.slice(0, maxChars) : file.content,
          size: file.size,
          truncated,
          totalLength: file.content.length,
          message: truncated
            ? `文件「${name}」共 ${file.content.length} 字符，已返回前 ${maxChars} 字符。如需更多内容请分段读取。`
            : `文件「${name}」读取成功，共 ${file.content.length} 字符。`,
        };
      }

      case 'browser_write_file': {
        // 将文本写入 IndexedDB，跨会话持久化。
        const name = input.name;
        const content = input.content;
        if (typeof name !== 'string' || !name.trim()) {
          return invalid('缺少文件名（name 字段）。');
        }
        if (typeof content !== 'string') {
          return invalid('缺少文件内容（content 字段，必须是字符串）。');
        }
        const { writeFile } = await import('../services/exportService');
        const file = await writeFile(name, content);
        return {
          ok: true,
          name: file.name,
          size: file.size,
          message: `文件「${name}」已保存（${(file.size / 1024).toFixed(1)}KB）。下次会话可直接读取，无需重传。`,
        };
      }
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
