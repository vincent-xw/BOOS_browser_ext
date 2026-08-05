export type OperationState = 'idle' | 'running' | 'succeeded' | 'failed';

/**
 * 执行通道。
 * cdp-debugger 是页面写操作的唯一通道：经 chrome.debugger 下发真实输入事件。
 * 其余通道只承担读取。
 */
export type ProviderKind = 'chrome-mcp' | 'tabs-scripting-fallback' | 'cdp-debugger' | 'unavailable';

export type ProviderMode = 'live' | 'fallback';

export interface OperationError {
  code:
    | 'MCP_UNAVAILABLE'
    | 'ACTIVE_TAB_MISSING'
    | 'EXECUTION_FAILED'
    | 'WRITE_UNSUPPORTED'
    | 'INVALID_INPUT'
    | 'DOMAIN_MISMATCH'
    | 'CONFIG_MISSING'
    | 'TIMEOUT'
    /** 目标标签页没有可用的调试会话，写操作无法下发。 */
    | 'NO_DEBUG_SESSION'
    /** 动作已下发但验证未通过：命令成功不等于页面产生了变化。 */
    | 'VERIFICATION_FAILED';
  message: string;
  details?: string;
}

export interface PageReadData {
  title: string;
  url: string;
  selectionText: string;
  bodyPreview: string;
  activeElementTag: string | null;
  timestamp: string;
}

export interface CandidateSummary {
  id: string;
  index: number;
  name: string;
  previewText: string;
  encGeekId?: string;
  securityId?: string;
}

export interface PageCandidateOverview {
  total: number;
  loadedAt: string;
  changeState: 'idle' | 'stable' | 'changed';
  addedCount: number;
  removedCount: number;
  sampleNames: string[];
  changeDescription: string;
}

export interface CandidateProfile {
  name: string;
  resumeText: string;
  sourceUrl: string;
  timestamp: string;
}

export interface LlmAssessmentInput {
  userPrompt: string;
  candidate: CandidateSummary;
  profile: CandidateProfile;
}

export interface LlmAssessmentResult {
  shouldFavorite: boolean;
  reason: string;
  rawText: string;
}

export interface CandidateProcessRecord {
  candidate: CandidateSummary;
  status: 'favorited' | 'skipped' | 'failed';
  reason: string;
}

export interface WorkflowProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentCandidateName: string;
  records: CandidateProcessRecord[];
}

export interface CandidateQuerySelectors {
  listItemSelector: string;
  nameSelector: string;
  resumeContainerSelector: string;
  favoriteButtonSelector: string;
}

export interface ServiceResult<T> {
  ok: boolean;
  provider: ProviderKind;
  mode: ProviderMode;
  data?: T;
  error?: OperationError;
}

/**
 * window.chromeMcp 桥接：只读能力。
 *
 * 写操作不在这里 —— 页面写入全部经 Service Worker 的 chrome.debugger + CDP 下发真实事件。
 * 桥接运行在页面上下文，它能做到的只有 DOM 合成事件，而那类事件 isTrusted 为 false，
 * 触发不了真实焦点流转与 user activation。
 */
export interface ChromeMcpBridge {
  readPage: () => Promise<ServiceResult<PageReadData> | PageReadData>;
  readCandidateList?: (
    selectors: CandidateQuerySelectors,
  ) => Promise<ServiceResult<CandidateSummary[]> | CandidateSummary[]>;
  readCandidateProfile?: (
    selectors: CandidateQuerySelectors,
  ) => Promise<ServiceResult<CandidateProfile> | CandidateProfile>;
}

declare global {
  interface Window {
    chromeMcp?: ChromeMcpBridge;
  }
}

export {};
