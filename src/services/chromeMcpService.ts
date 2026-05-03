import type {
  ChromeMcpBridge,
  OperationError,
  PageReadData,
  PageWriteData,
  PageWritePayload,
  ProviderKind,
  ProviderMode,
  ServiceResult,
} from '../types/page-io';

function buildError(
  error: OperationError,
  provider: ProviderKind,
  mode: ProviderMode,
): ServiceResult<never> {
  return {
    ok: false,
    provider,
    mode,
    error,
  };
}

function normalizeResult<T>(
  value: ServiceResult<T> | T,
  provider: ProviderKind,
  mode: ProviderMode,
): ServiceResult<T> {
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    return value as ServiceResult<T>;
  }

  return {
    ok: true,
    provider,
    mode,
    data: value as T,
  };
}

function getWindowBridge(): ChromeMcpBridge | null {
  if (typeof window !== 'undefined' && window.chromeMcp) {
    return window.chromeMcp;
  }

  return null;
}

async function withActiveTab<T>(
  runner: (tabId: number) => Promise<T>,
): Promise<ServiceResult<T>> {
  if (!chrome?.tabs?.query) {
    return buildError(
      {
        code: 'MCP_UNAVAILABLE',
        message: '当前环境不支持 Chrome 标签页访问。',
      },
      'unavailable',
      'fallback',
    );
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    return buildError(
      {
        code: 'ACTIVE_TAB_MISSING',
        message: '未找到当前活动标签页，请切换到目标页面后重试。',
      },
      'tabs-scripting-fallback',
      'fallback',
    );
  }

  try {
    const data = await runner(tab.id);
    return {
      ok: true,
      provider: 'tabs-scripting-fallback',
      mode: 'fallback',
      data,
    };
  } catch (error) {
    return buildError(
      {
        code: 'EXECUTION_FAILED',
        message: '页面脚本执行失败，可能是当前页面不允许注入。',
        details: error instanceof Error ? error.message : String(error),
      },
      'tabs-scripting-fallback',
      'fallback',
    );
  }
}

async function readWithTabsScripting(): Promise<ServiceResult<PageReadData>> {
  if (!chrome?.scripting?.executeScript) {
    return buildError(
      {
        code: 'MCP_UNAVAILABLE',
        message: '当前环境不支持页面读取能力。',
      },
      'unavailable',
      'fallback',
    );
  }

  return withActiveTab<PageReadData>(async (tabId) => {
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const activeElement = document.activeElement as HTMLElement | null;
        const selectionText = window.getSelection?.()?.toString() ?? '';
        const bodyPreview = document.body?.innerText?.trim().slice(0, 200) ?? '';

        return {
          title: document.title,
          url: location.href,
          selectionText,
          bodyPreview,
          activeElementTag: activeElement?.tagName ?? null,
          timestamp: new Date().toISOString(),
        };
      },
    });

    return injectionResult.result as PageReadData;
  });
}

async function writeWithTabsScripting(
  payload: PageWritePayload,
): Promise<ServiceResult<PageWriteData>> {
  if (!payload.text.trim()) {
    return buildError(
      {
        code: 'INVALID_INPUT',
        message: '请输入要写入页面的内容。',
      },
      'tabs-scripting-fallback',
      'fallback',
    );
  }

  if (!chrome?.scripting?.executeScript) {
    return buildError(
      {
        code: 'MCP_UNAVAILABLE',
        message: '当前环境不支持页面写入能力。',
      },
      'unavailable',
      'fallback',
    );
  }

  return withActiveTab<PageWriteData>(async (tabId) => {
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [payload.text],
      func: (text: string) => {
        const activeElement = document.activeElement as HTMLElement | null;
        const timestamp = new Date().toISOString();

        const dispatchEvents = (target: HTMLElement) => {
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        };

        if (
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement
        ) {
          activeElement.focus();
          activeElement.value = text;
          dispatchEvents(activeElement);
          return {
            target: 'active-element' as const,
            writtenText: text,
            message: '已将内容写入当前激活的输入控件。',
            timestamp,
          };
        }

        if (activeElement?.isContentEditable) {
          activeElement.focus();
          activeElement.textContent = text;
          dispatchEvents(activeElement);
          return {
            target: 'active-element' as const,
            writtenText: text,
            message: '已将内容写入当前可编辑区域。',
            timestamp,
          };
        }

        let hiddenBuffer = document.getElementById(
          'boos-extension-write-buffer',
        ) as HTMLDivElement | null;
        if (!hiddenBuffer) {
          hiddenBuffer = document.createElement('div');
          hiddenBuffer.id = 'boos-extension-write-buffer';
          hiddenBuffer.setAttribute('data-boos-extension', 'true');
          hiddenBuffer.style.display = 'none';
          document.body.appendChild(hiddenBuffer);
        }

        hiddenBuffer.textContent = text;
        return {
          target: 'hidden-buffer' as const,
          writtenText: text,
          message: '未检测到可编辑区域，已将内容写入隐藏缓冲区作为回退方案。',
          timestamp,
        };
      },
    });

    return injectionResult.result as PageWriteData;
  });
}

export const chromeMcpService = {
  async readPage(): Promise<ServiceResult<PageReadData>> {
    const bridge = getWindowBridge();
    if (bridge) {
      try {
        const result = await bridge.readPage();
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 读取页面失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    return readWithTabsScripting();
  },

  async writePage(
    payload: PageWritePayload,
  ): Promise<ServiceResult<PageWriteData>> {
    const bridge = getWindowBridge();
    if (bridge) {
      try {
        const result = await bridge.writePage(payload);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 写入页面失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    return writeWithTabsScripting(payload);
  },
};
