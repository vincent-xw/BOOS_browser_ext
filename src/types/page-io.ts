export type OperationState = 'idle' | 'running' | 'succeeded' | 'failed';

export type ProviderKind = 'chrome-mcp' | 'tabs-scripting-fallback' | 'unavailable';

export type ProviderMode = 'live' | 'fallback';

export interface OperationError {
  code:
    | 'MCP_UNAVAILABLE'
    | 'ACTIVE_TAB_MISSING'
    | 'EXECUTION_FAILED'
    | 'WRITE_UNSUPPORTED'
    | 'INVALID_INPUT';
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
}

declare global {
  interface Window {
    chromeMcp?: ChromeMcpBridge;
  }
}

export {};
