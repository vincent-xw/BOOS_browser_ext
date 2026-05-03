export type OperationState = 'idle' | 'running' | 'succeeded' | 'failed';

export type ProviderKind = 'chrome-mcp' | 'tabs-scripting-fallback' | 'unavailable';

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
    | 'TIMEOUT';
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

export interface PageWritePayload {
  text: string;
}

export interface PageWriteData {
  target: 'active-element' | 'hidden-buffer';
  writtenText: string;
  message: string;
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

export interface FavoriteActionData {
  clicked: boolean;
  message: string;
  timestamp: string;
  successSignals?: string[];
  networkEvents?: Array<{
    method: string;
    url: string;
    status: number;
  }>;
  beforeState?: {
    text: string;
    className: string;
  };
  afterState?: {
    text: string;
    className: string;
  };
}

export interface FavoriteNetworkEvent {
  method: string;
  url: string;
  status: number;
  frameUrl: string;
  isTopFrame?: boolean;
  timestamp: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
  keywordMatched?: boolean;
}

export interface FavoriteRecordFrameSummary {
  frameUrl: string;
  started?: boolean;
  eventsCaptured: number;
  note?: string;
}

export interface FavoriteRecordStartData {
  started: boolean;
  message: string;
  injectedFrameCount: number;
  startedFrameCount: number;
  frameSummaries: FavoriteRecordFrameSummary[];
}

export interface FavoriteNetworkRecording {
  startedAt: string;
  stoppedAt: string;
  endpointKeyword: string;
  events: FavoriteNetworkEvent[];
  frameSummaries?: FavoriteRecordFrameSummary[];
}

export interface FavoriteReplayResult {
  ok: boolean;
  message: string;
  replayedCount: number;
  responses: Array<{
    method: string;
    url: string;
    status: number;
  }>;
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

export interface ChromeMcpBridge {
  readPage: () => Promise<ServiceResult<PageReadData> | PageReadData>;
  writePage: (
    payload: PageWritePayload,
  ) => Promise<ServiceResult<PageWriteData> | PageWriteData>;
  readCandidateList?: (
    selectors: CandidateQuerySelectors,
  ) => Promise<ServiceResult<CandidateSummary[]> | CandidateSummary[]>;
  openCandidateDetail?: (
    candidate: CandidateSummary,
    selectors: CandidateQuerySelectors,
  ) => Promise<ServiceResult<{ opened: boolean; message: string }> | { opened: boolean; message: string }>;
  readCandidateProfile?: (
    selectors: CandidateQuerySelectors,
  ) => Promise<ServiceResult<CandidateProfile> | CandidateProfile>;
  clickFavoriteButton?: (
    selectors: CandidateQuerySelectors,
  ) => Promise<ServiceResult<FavoriteActionData> | FavoriteActionData>;
  startFavoriteNetworkRecording?: (
    endpointKeyword: string,
  ) => Promise<
    | ServiceResult<FavoriteRecordStartData>
    | FavoriteRecordStartData
  >;
  stopFavoriteNetworkRecording?: (
    endpointKeyword: string,
  ) => Promise<ServiceResult<FavoriteNetworkRecording> | FavoriteNetworkRecording>;
  replayFavoriteNetworkRequests?: (payload: {
    endpointKeyword: string;
    mode: 'favorite' | 'unfavorite';
  }) => Promise<ServiceResult<FavoriteReplayResult> | FavoriteReplayResult>;
}

declare global {
  interface Window {
    chromeMcp?: ChromeMcpBridge;
  }
}

export {};
