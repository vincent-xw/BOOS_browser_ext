import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  const requestFilter: chrome.webRequest.RequestFilter = {
    urls: ['https://*.zhipin.com/*'],
    types: ['xmlhttprequest'],
  };

  type NetworkTrace = {
    requestId: string;
    tabId: number;
    method?: string;
    url?: string;
    type?: string;
    initiator?: string;
    statusCode?: number;
    timeStamp?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: unknown;
    error?: string;
  };

  const traces = new Map<string, NetworkTrace>();
  const latestGeekListUrlByTab = new Map<number, string>();
  const GEEK_LIST_API_RE = /\/wapi\/zpjob\/rec\/geek\/list/i;

  const toHeaderObject = (
    headers?: chrome.webRequest.HttpHeader[],
  ): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const item of headers ?? []) {
      if (!item.name) {
        continue;
      }
      result[item.name] = item.value ?? '';
    }
    return result;
  };

  const finalizeTrace = (requestId: string) => {
    const trace = traces.get(requestId);
    if (!trace) {
      return;
    }

    traces.delete(requestId);
  };

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId >= 0 && GEEK_LIST_API_RE.test(details.url)) {
        latestGeekListUrlByTab.set(details.tabId, details.url);
      }

      traces.set(details.requestId, {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        url: details.url,
        type: details.type,
        initiator: details.initiator,
        timeStamp: details.timeStamp,
        requestBody: details.requestBody,
      });
    },
    requestFilter,
    ['requestBody'],
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'BOOS_GET_LAST_GEEK_LIST_URL') {
      return;
    }

    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (typeof tabId !== 'number' || tabId < 0) {
      sendResponse({ ok: false, message: 'invalid-tab-id' });
      return;
    }

    const url = latestGeekListUrlByTab.get(tabId);
    if (!url) {
      sendResponse({ ok: false, message: 'no-cached-url' });
      return;
    }

    sendResponse({ ok: true, url });
  });

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const current = traces.get(details.requestId) ?? {
        requestId: details.requestId,
        tabId: details.tabId,
      };

      traces.set(details.requestId, {
        ...current,
        method: current.method ?? details.method,
        url: current.url ?? details.url,
        requestHeaders: toHeaderObject(details.requestHeaders),
      });
    },
    requestFilter,
    ['requestHeaders', 'extraHeaders'],
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const current = traces.get(details.requestId) ?? {
        requestId: details.requestId,
        tabId: details.tabId,
      };

      traces.set(details.requestId, {
        ...current,
        method: current.method ?? details.method,
        url: current.url ?? details.url,
        statusCode: details.statusCode,
        responseHeaders: toHeaderObject(details.responseHeaders),
      });
    },
    requestFilter,
    ['responseHeaders', 'extraHeaders'],
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const current = traces.get(details.requestId);
      if (current) {
        traces.set(details.requestId, {
          ...current,
          statusCode: details.statusCode,
          timeStamp: details.timeStamp,
        });
      }
      finalizeTrace(details.requestId);
    },
    requestFilter,
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const current = traces.get(details.requestId) ?? {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        url: details.url,
      };

      traces.set(details.requestId, {
        ...current,
        error: details.error,
        timeStamp: details.timeStamp,
      });
      finalizeTrace(details.requestId);
    },
    requestFilter,
  );

  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => {
      console.warn('[BOOS] Failed to enable openPanelOnActionClick:', error);
    });
});
