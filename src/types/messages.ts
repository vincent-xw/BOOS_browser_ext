/**
 * Service Worker 消息协议。
 *
 * 每个消息类型都要在这里显式声明。加上 CDP 动作、定位、验证与 agent 工具后会有十几个类型，
 * 没有集中定义就会退化成一长串 if (message.type === ...)。
 */

import type { ElementLocator, LocateResult, ObservedRequest, VerifyRequest, VerifyResult } from './cdp';

/** 消息类型常量。前缀统一为 BOOS_，避免与页面自身或其他扩展的消息冲突。 */
export const MessageType = {
  /** 建立 / 释放调试会话。 */
  CdpAttach: 'BOOS_CDP_ATTACH',
  CdpDetach: 'BOOS_CDP_DETACH',
  CdpSessionState: 'BOOS_CDP_SESSION_STATE',

  /** CDP 写动作。 */
  CdpClick: 'BOOS_CDP_CLICK',
  CdpInputText: 'BOOS_CDP_INPUT_TEXT',
  CdpPressKey: 'BOOS_CDP_PRESS_KEY',
  CdpScroll: 'BOOS_CDP_SCROLL',
  CdpScreenshot: 'BOOS_CDP_SCREENSHOT',
  /** 浏览器原生返回。用于从非预期导航中恢复。 */
  CdpGoBack: 'BOOS_CDP_GO_BACK',

  /** CDP Network 域观测。 */
  CdpNetworkStart: 'BOOS_CDP_NETWORK_START',
  CdpNetworkCollect: 'BOOS_CDP_NETWORK_COLLECT',

  /** content script 侧的只读能力。 */
  ContentPing: 'BOOS_CONTENT_PING',
  ContentLocate: 'BOOS_CONTENT_LOCATE',
  ContentVerify: 'BOOS_CONTENT_VERIFY',
  ContentReadPage: 'BOOS_CONTENT_READ_PAGE',
  /** 可交互元素快照与 ref 解析：自由指令的定位主路径。 */
  ContentSnapshot: 'BOOS_CONTENT_SNAPSHOT',
  ContentResolveRef: 'BOOS_CONTENT_RESOLVE_REF',
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** 按键名，与 CDP Input.dispatchKeyEvent 支持的键对应。 */
export type PressableKey = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowUp' | 'ArrowDown';

export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/**
 * 写操作后的导航检测结果。
 *
 * 这是给模型的强信号：点击/输入/按键可能导致页面跳转，模型自己往往察觉不到，
 * 会继续在「以为的原页面」上操作。扩展检测到导航后把结果塞进工具返回值，
 * 模型据此判断是否需要返回。
 */
export interface NavigationInfo {
  /** 操作前的完整 URL。 */
  from: string;
  /** 操作后的完整 URL。 */
  to: string;
  /** 是否跨域名（host 变化）。跨域名通常意味着离开了任务相关页面。 */
  changedDomain: boolean;
  /** 给模型的中文提示，直接说明发生了什么、建议怎么做。 */
  note: string;
}

/** 请求消息的判别联合。tabId 一律显式传递，不依赖 sender 推断。 */
export type ExtensionRequest =
  | { type: typeof MessageType.CdpAttach; tabId: number }
  | { type: typeof MessageType.CdpDetach; tabId: number }
  | { type: typeof MessageType.CdpSessionState; tabId: number }
  | { type: typeof MessageType.CdpClick; tabId: number; x: number; y: number; label?: string }
  | { type: typeof MessageType.CdpInputText; tabId: number; x: number; y: number; text: string }
  | { type: typeof MessageType.CdpPressKey; tabId: number; key: PressableKey; modifiers?: KeyModifier[] }
  | { type: typeof MessageType.CdpScroll; tabId: number; deltaY: number; x?: number; y?: number }
  | { type: typeof MessageType.CdpScreenshot; tabId: number; format?: 'png' | 'jpeg' }
  | { type: typeof MessageType.CdpGoBack; tabId: number }
  | { type: typeof MessageType.CdpNetworkStart; tabId: number }
  | { type: typeof MessageType.CdpNetworkCollect; tabId: number; urlPattern?: string }
  | { type: typeof MessageType.ContentPing; tabId: number }
  | { type: typeof MessageType.ContentLocate; tabId: number; locator: ElementLocator }
  | { type: typeof MessageType.ContentVerify; tabId: number; request: VerifyRequest }
  | { type: typeof MessageType.ContentReadPage; tabId: number }
  | { type: typeof MessageType.ContentSnapshot; tabId: number }
  | { type: typeof MessageType.ContentResolveRef; tabId: number; ref: number };

/** 统一响应信封。失败一律带 code 与可读 message，不抛裸异常给调用方。 */
export type MessageResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: MessageErrorCode; message: string; details?: string };

export type MessageErrorCode =
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'INVALID_INPUT'
  | 'NO_DEBUG_SESSION'
  | 'ATTACH_FAILED'
  | 'SESSION_BUSY'
  | 'CDP_COMMAND_FAILED'
  | 'CONTENT_UNAVAILABLE'
  | 'TAB_MISSING'
  | 'NOT_FOUND'
  /** 目标页面不在用户配置的白名单内，写操作被拒。 */
  | 'URL_NOT_ALLOWED'
  /** 没有目标页面的 host 权限，页面脚本无法注入。 */
  | 'HOST_PERMISSION_MISSING'
  | 'TIMEOUT';

export type { ElementLocator, LocateResult, ObservedRequest, VerifyRequest, VerifyResult };
