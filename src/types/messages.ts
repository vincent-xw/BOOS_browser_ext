/**
 * Service Worker 消息协议。
 *
 * 每个消息类型都要在这里显式声明。加上 CDP 动作、定位、验证与 agent 工具后会有十几个类型，
 * 没有集中定义就会退化成一长串 if (message.type === ...)。
 */

import type { ElementLocator, LocateResult, ObservedRequest, VerifyRequest, VerifyResult } from './cdp';

/** 消息类型常量。前缀统一为 BOOS_，避免与页面自身或其他扩展的消息冲突。 */
export const MessageType = {
  /** 读取该标签页最近一次候选人列表接口 URL（既有能力）。 */
  GetLastGeekListUrl: 'BOOS_GET_LAST_GEEK_LIST_URL',

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

/** 请求消息的判别联合。tabId 一律显式传递，不依赖 sender 推断。 */
export type ExtensionRequest =
  | { type: typeof MessageType.GetLastGeekListUrl; tabId: number }
  | { type: typeof MessageType.CdpAttach; tabId: number }
  | { type: typeof MessageType.CdpDetach; tabId: number }
  | { type: typeof MessageType.CdpSessionState; tabId: number }
  | { type: typeof MessageType.CdpClick; tabId: number; x: number; y: number; label?: string }
  | { type: typeof MessageType.CdpInputText; tabId: number; x: number; y: number; text: string }
  | { type: typeof MessageType.CdpPressKey; tabId: number; key: PressableKey; modifiers?: KeyModifier[] }
  | { type: typeof MessageType.CdpScroll; tabId: number; deltaY: number; x?: number; y?: number }
  | { type: typeof MessageType.CdpScreenshot; tabId: number; format?: 'png' | 'jpeg' }
  | { type: typeof MessageType.CdpNetworkStart; tabId: number }
  | { type: typeof MessageType.CdpNetworkCollect; tabId: number; urlPattern?: string }
  | { type: typeof MessageType.ContentPing; tabId: number }
  | { type: typeof MessageType.ContentLocate; tabId: number; locator: ElementLocator }
  | { type: typeof MessageType.ContentVerify; tabId: number; request: VerifyRequest }
  | { type: typeof MessageType.ContentReadPage; tabId: number; includeCandidateList?: boolean }
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
  | 'TIMEOUT';

export type { ElementLocator, LocateResult, ObservedRequest, VerifyRequest, VerifyResult };
