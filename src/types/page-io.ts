/**
 * 页面操作的共享类型。
 *
 * 历史上这里堆了 BOSS 流程专用的候选人类型与 chromeMcp 桥接声明；
 * 动作序列现由 agent 规划，这些类型已随预设流程一并移除。
 */

export type OperationState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface OperationError {
  code:
    | 'ACTIVE_TAB_MISSING'
    | 'EXECUTION_FAILED'
    | 'INVALID_INPUT'
    | 'CONFIG_MISSING'
    | 'TIMEOUT'
    | 'NO_DEBUG_SESSION'
    | 'VERIFICATION_FAILED'
    | 'CONTENT_UNAVAILABLE'
    | 'HOST_PERMISSION_MISSING'
    | 'URL_NOT_ALLOWED'
    | 'TOOL_NOT_ALLOWED'
    | 'TOOL_INPUT_INVALID'
    | 'TOOL_EXECUTION_FAILED';
  message: string;
  details?: string;
}

/** ServiceResult 的 provider 字段。当前唯一的执行通道是 CDP 调试器。 */
export type ProviderKind = 'cdp-debugger' | 'unavailable';
export type ProviderMode = 'live';

export interface ServiceResult<T> {
  ok: boolean;
  provider: ProviderKind;
  mode: ProviderMode;
  data?: T;
  error?: OperationError;
}
