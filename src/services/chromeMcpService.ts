import type {
  CandidateProfile,
  CandidateQuerySelectors,
  FavoriteRecordStartData,
  FavoriteNetworkRecording,
  FavoriteReplayResult,
  CandidateSummary,
  ChromeMcpBridge,
  FavoriteActionData,
  OperationError,
  PageReadData,
  PageWriteData,
  PageWritePayload,
  ProviderKind,
  ProviderMode,
  ServiceResult,
} from '../types/page-io';

let lastFavoriteNetworkRecording: FavoriteNetworkRecording | null = null;

const BOSS_FALLBACK_SELECTORS: CandidateQuerySelectors = {
  listItemSelector: 'li.card-item, .card-item',
  nameSelector: '.name',
  resumeContainerSelector: '#resume, canvas#resume, .resume-item, .resume-detail-wrap',
  favoriteButtonSelector: '.like-icon-and-text, button[ka=like], .btn-like',
};

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

function parseSelectorList(selector: string): string[] {
  return selector
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeSelectorLists(...selectors: string[]): string {
  const merged = new Set<string>();

  for (const selector of selectors) {
    for (const item of parseSelectorList(selector)) {
      merged.add(item);
    }
  }

  return Array.from(merged).join(', ');
}

function withBossFallbackSelectors(selectors: CandidateQuerySelectors): CandidateQuerySelectors {
  return {
    listItemSelector: mergeSelectorLists(
      selectors.listItemSelector,
      BOSS_FALLBACK_SELECTORS.listItemSelector,
    ),
    nameSelector: mergeSelectorLists(selectors.nameSelector, BOSS_FALLBACK_SELECTORS.nameSelector),
    resumeContainerSelector: mergeSelectorLists(
      selectors.resumeContainerSelector,
      BOSS_FALLBACK_SELECTORS.resumeContainerSelector,
    ),
    favoriteButtonSelector: mergeSelectorLists(
      selectors.favoriteButtonSelector,
      BOSS_FALLBACK_SELECTORS.favoriteButtonSelector,
    ),
  };
}

function queryFirstBySelectorList(root: ParentNode, selector: string): Element | null {
  for (const item of parseSelectorList(selector)) {
    const found = root.querySelector(item);
    if (found) {
      return found;
    }
  }

  return null;
}

function pickBestInjectionResult<T>(
  results: Array<chrome.scripting.InjectionResult<T>>,
  score: (data: T) => number,
): T | undefined {
  let bestResult: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const item of results) {
    if (typeof item.result === 'undefined') {
      continue;
    }

    const currentScore = score(item.result);
    if (currentScore > bestScore) {
      bestScore = currentScore;
      bestResult = item.result;
    }
  }

  return bestResult;
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
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
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

    const bestResult = pickBestInjectionResult(injectionResults, (data) => {
      const bodyScore = data.bodyPreview?.length ?? 0;
      const selectionScore = data.selectionText?.length ?? 0;
      return bodyScore + selectionScore;
    });

    return (bestResult ?? injectionResults[0]?.result) as PageReadData;
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
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
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

    const bestResult = pickBestInjectionResult(injectionResults, (data) =>
      data.target === 'active-element' ? 2 : 1,
    );

    return (bestResult ?? injectionResults[0]?.result) as PageWriteData;
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

  async getCurrentDomain(): Promise<ServiceResult<string>> {
    const result = await this.readPage();
    if (!result.ok || !result.data) {
      return buildError(
        result.error ?? {
          code: 'EXECUTION_FAILED',
          message: '读取当前页面地址失败。',
        },
        result.provider,
        result.mode,
      );
    }

    try {
      return {
        ok: true,
        provider: result.provider,
        mode: result.mode,
        data: new URL(result.data.url).host,
      };
    } catch {
      return buildError(
        {
          code: 'EXECUTION_FAILED',
          message: '当前页面 URL 解析失败。',
          details: result.data.url,
        },
        result.provider,
        result.mode,
      );
    }
  },

  async readCandidateList(
    selectors: CandidateQuerySelectors,
  ): Promise<ServiceResult<CandidateSummary[]>> {
    const effectiveSelectors = withBossFallbackSelectors(selectors);
    const bridge = getWindowBridge();
    if (bridge?.readCandidateList) {
      try {
        const result = await bridge.readCandidateList(effectiveSelectors);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 读取候选人列表失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持候选人列表读取能力。',
        },
        'unavailable',
        'fallback',
      );
    }

    return withActiveTab<CandidateSummary[]>(async (tabId) => {
      // 步骤 1: 从 background 读取最近一次 list 接口 URL，并主动拉取响应数据
      let latestListUrl = '';
      try {
        const messageResp = await chrome.runtime.sendMessage({
          type: 'BOOS_GET_LAST_GEEK_LIST_URL',
          tabId,
        });
        if (messageResp?.ok && typeof messageResp.url === 'string') {
          latestListUrl = messageResp.url;
        } else {
        }
      } catch (err) {
      }

      // 步骤 2: DOM 抓取候选人列表
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        args: [effectiveSelectors.listItemSelector, effectiveSelectors.nameSelector],
        func: (listItemSelector: string, nameSelector: string) => {
          const listItems = Array.from(document.querySelectorAll(listItemSelector));

          return listItems.map((item, index) => {
            const nameElement = (() => {
              const nameSelectors = nameSelector
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);

              for (const selector of nameSelectors) {
                const found = item.querySelector(selector);
                if (found) {
                  return found;
                }
              }

              return null;
            })();

            const name = nameElement?.textContent?.trim() || `候选人#${index + 1}`;
            const previewText = item.textContent?.trim().replace(/\s+/g, ' ').slice(0, 180) || '';

            return {
              id: `${index}`,
              index,
              name,
              previewText,
            };
          });
        },
      });

      const bestResult = pickBestInjectionResult(injectionResults, (data) => data.length);
      const candidates = bestResult ?? [];

      // 步骤 3: 等待 API 拦截完成

      // 步骤 4: 读取缓存的 API 数据
      const apiGeekList = latestListUrl
        ? (
            (await chrome.scripting.executeScript({
              target: { tabId, allFrames: false },
              world: 'MAIN',
              args: [latestListUrl],
              func: async (listUrl: string) => {
                try {
                  const resp = await fetch(listUrl, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                      'X-Requested-With': 'XMLHttpRequest',
                    },
                  });

                  const json = await resp.json().catch(() => null);
                  if (!json?.zpData?.geekList || !Array.isArray(json.zpData.geekList)) {
                    return [];
                  }

                  const extracted = json.zpData.geekList
                    .map((geek: any) => {
                      if (!geek?.geekCard) {
                        return null;
                      }
                      return {
                        encryptGeekId: geek.geekCard.encryptGeekId,
                        securityId: geek.geekCard.securityId,
                        name: geek.geekCard.geekName,
                      };
                    })
                    .filter(Boolean);

                  return extracted;
                } catch (error) {
                  return [];
                }
              },
            }))[0]?.result ?? []
          )
        : [];


      // 步骤 5: 关联数据
      return candidates.map((candidate, index) => {
        if (index < apiGeekList.length) {
          const apiData = apiGeekList[index];
          return {
            ...candidate,
            encGeekId: apiData.encryptGeekId,
            securityId: apiData.securityId,
          };
        }
        return candidate;
      });
    });
  },

  async openCandidateDetail(
    candidate: CandidateSummary,
    selectors: CandidateQuerySelectors,
  ): Promise<ServiceResult<{ opened: boolean; message: string }>> {
    const effectiveSelectors = withBossFallbackSelectors(selectors);
    const bridge = getWindowBridge();
    if (bridge?.openCandidateDetail) {
      try {
        const result = await bridge.openCandidateDetail(candidate, effectiveSelectors);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: `Chrome MCP 打开候选人详情失败：${candidate.name}`,
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持候选人详情打开能力。',
        },
        'unavailable',
        'fallback',
      );
    }

    return withActiveTab<{ opened: boolean; message: string }>(async (tabId) => {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        args: [effectiveSelectors.listItemSelector, candidate.index],
        func: (listItemSelector: string, index: number) => {
          const listItems = Array.from(document.querySelectorAll(listItemSelector));
          const target = listItems[index] as HTMLElement | undefined;

          if (!target) {
            return {
              opened: false,
              message: `未找到索引为 ${index} 的候选人列表项。`,
            };
          }

          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.click();

          return {
            opened: true,
            message: '已点击候选人列表项。',
          };
        },
      });

      const bestResult = pickBestInjectionResult(injectionResults, (data) =>
        data.opened ? 1 : 0,
      );

      return bestResult ?? {
        opened: false,
        message: '点击候选人列表项失败。',
      };
    });
  },

  async readCandidateProfile(
    selectors: CandidateQuerySelectors,
  ): Promise<ServiceResult<CandidateProfile>> {
    const effectiveSelectors = withBossFallbackSelectors(selectors);
    const bridge = getWindowBridge();
    if (bridge?.readCandidateProfile) {
      try {
        const result = await bridge.readCandidateProfile(effectiveSelectors);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 读取候选人在线简历失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持候选人简历读取能力。',
        },
        'unavailable',
        'fallback',
      );
    }

    return withActiveTab<CandidateProfile>(async (tabId) => {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        args: [effectiveSelectors.resumeContainerSelector, effectiveSelectors.nameSelector],
        func: (resumeContainerSelector: string, nameSelector: string) => {
          const queryFirst = (root: ParentNode, selector: string): Element | null => {
            const selectors = selector
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);

            for (const one of selectors) {
              const found = root.querySelector(one);
              if (found) {
                return found;
              }
            }

            return null;
          };

          const resumeContainer = queryFirst(document, resumeContainerSelector) ?? document.body;
          const nameElement = queryFirst(document, nameSelector);
          const resumeText =
            resumeContainer?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 12000) || '';

          return {
            name: nameElement?.textContent?.trim() || '',
            resumeText,
            sourceUrl: location.href,
            timestamp: new Date().toISOString(),
          };
        },
      });

      const bestResult = pickBestInjectionResult(injectionResults, (data) => {
        const textScore = data.resumeText?.length ?? 0;
        const nameScore = data.name?.length ?? 0;
        return textScore + nameScore;
      });

      return (bestResult ?? injectionResults[0]?.result) as CandidateProfile;
    });
  },

  async clickFavoriteButton(
    selectors: CandidateQuerySelectors,
  ): Promise<ServiceResult<FavoriteActionData>> {
    const effectiveSelectors = withBossFallbackSelectors(selectors);
    const bridge = getWindowBridge();
    if (bridge?.clickFavoriteButton) {
      try {
        const result = await bridge.clickFavoriteButton(effectiveSelectors);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 点击收藏失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持收藏动作。',
        },
        'unavailable',
        'fallback',
      );
    }

    return withActiveTab<FavoriteActionData>(async (tabId) => {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [effectiveSelectors.favoriteButtonSelector],
        func: async (favoriteButtonSelector: string) => {
          const selectors = favoriteButtonSelector
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

          const activeDialog = document.querySelector(
            '.dialog-wrap.active, .boss-dialog__wrapper.dialog-lib-resume, .lib-resume-recommend',
          ) as HTMLElement | null;

          const queryInScopes = <T extends Element>(selector: string): T | null => {
            const inDialog = activeDialog?.querySelector(selector) as T | null;
            if (inDialog) {
              return inDialog;
            }

            return document.querySelector(selector) as T | null;
          };

          let target: HTMLElement | null = null;
          for (const selector of selectors) {
            const found = queryInScopes<HTMLElement>(selector);
            if (found) {
              target = found;
              break;
            }
          }

          if (!target) {
            return {
              clicked: false,
              message: '未找到收藏按钮。',
              timestamp: new Date().toISOString(),
              successSignals: [],
            };
          }

          const beforeState = {
            text: target.textContent?.trim() ?? '',
            className: target.className ?? '',
          };

          const networkEvents: Array<{ method: string; url: string; status: number }> = [];
          const successSignals: string[] = [];

          const isFavoriteLikeRequest = (url: string) =>
            /favorite|collect|like|bookmark|geek|candidate|resume/i.test(url);

          const originalFetch = window.fetch;
          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSend = XMLHttpRequest.prototype.send;

          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            try {
              const req = args[0] as RequestInfo | URL;
              const init = (args[1] as RequestInit | undefined) ?? undefined;
              const url =
                typeof req === 'string'
                  ? req
                  : req instanceof Request
                    ? req.url
                    : String(req);
              const method = (init?.method || (req instanceof Request ? req.method : 'GET')).toUpperCase();

              if (isFavoriteLikeRequest(url)) {
                networkEvents.push({ method, url, status: response.status });
                if (response.ok) {
                  successSignals.push(`检测到收藏相关 fetch 成功：${response.status}`);
                }
              }
            } catch {
              // ignore
            }

            return response;
          };

          XMLHttpRequest.prototype.open = function (
            method: string,
            url: string | URL,
            ...rest: unknown[]
          ) {
            (this as XMLHttpRequest & { __boosMethod?: string; __boosUrl?: string }).__boosMethod =
              method;
            (this as XMLHttpRequest & { __boosMethod?: string; __boosUrl?: string }).__boosUrl =
              String(url);
            return (originalOpen as unknown as (...args: unknown[]) => unknown).apply(this, [
              method,
              url,
              ...rest,
            ]);
          };

          XMLHttpRequest.prototype.send = function (...args: unknown[]) {
            const xhr = this as XMLHttpRequest & { __boosMethod?: string; __boosUrl?: string };
            const onLoadEnd = () => {
              const url = xhr.__boosUrl ?? '';
              if (isFavoriteLikeRequest(url)) {
                const method = (xhr.__boosMethod || 'GET').toUpperCase();
                networkEvents.push({ method, url, status: xhr.status });
                if (xhr.status >= 200 && xhr.status < 300) {
                  successSignals.push(`检测到收藏相关 XHR 成功：${xhr.status}`);
                }
              }
            };

            xhr.addEventListener('loadend', onLoadEnd, { once: true });
            return originalSend.apply(xhr, args as [Document | XMLHttpRequestBodyInit | null | undefined]);
          };

          const dispatchClickChain = (element: HTMLElement) => {
            const events: Array<[string, MouseEventInit]> = [
              ['pointerdown', { bubbles: true, cancelable: true, composed: true }],
              ['mousedown', { bubbles: true, cancelable: true, composed: true, button: 0 }],
              ['mouseup', { bubbles: true, cancelable: true, composed: true, button: 0 }],
              ['click', { bubbles: true, cancelable: true, composed: true, button: 0 }],
            ];

            for (const [eventName, eventInit] of events) {
              element.dispatchEvent(new MouseEvent(eventName, eventInit));
            }
          };

          target.scrollIntoView({ behavior: 'smooth', block: 'center' });

          try {
            target.focus?.();
            dispatchClickChain(target);
            target.click();

            await new Promise((resolve) => window.setTimeout(resolve, 1400));
          } finally {
            window.fetch = originalFetch;
            XMLHttpRequest.prototype.open = originalOpen;
            XMLHttpRequest.prototype.send = originalSend;
          }

          const afterState = {
            text: target.textContent?.trim() ?? '',
            className: target.className ?? '',
          };

          if (beforeState.text !== afterState.text) {
            successSignals.push(`按钮文本变化：${beforeState.text || '(空)'} -> ${afterState.text || '(空)'}`);
          }

          if (beforeState.className !== afterState.className) {
            successSignals.push('按钮样式状态发生变化');
          }

          const dialogText = activeDialog?.textContent?.replace(/\s+/g, ' ').slice(0, 800) ?? '';
          if (/已收藏|取消收藏|已关注|已处理|收藏成功/.test(dialogText)) {
            successSignals.push('检测到页面成功文案信号');
          }

          const clicked = successSignals.length > 0;

          return {
            clicked,
            message: clicked
              ? '已完成收藏动作分析并检测到成功信号。'
              : '已触发点击，但暂未检测到明确成功信号。',
            timestamp: new Date().toISOString(),
            successSignals,
            networkEvents,
            beforeState,
            afterState,
          };
        },
      });

      const bestResult = pickBestInjectionResult(injectionResults, (data) =>
        (data.clicked ? 100 : 0) + (data.successSignals?.length ?? 0),
      );

      return (bestResult ?? injectionResults[0]?.result) as FavoriteActionData;
    });
  },

  async startFavoriteNetworkRecording(
    endpointKeyword: string,
  ): Promise<ServiceResult<FavoriteRecordStartData>> {
    const bridge = getWindowBridge();
    if (bridge?.startFavoriteNetworkRecording) {
      try {
        const result = await bridge.startFavoriteNetworkRecording(endpointKeyword);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 启动网络录制失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持网络录制能力。',
        },
        'unavailable',
        'fallback',
      );
    }

    return withActiveTab<FavoriteRecordStartData>(async (tabId) => {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [endpointKeyword],
        func: (keyword: string) => {
          const g = window as unknown as Record<string, unknown>;
          const recorderKey = '__boosFavoriteRecorder';
          const now = new Date().toISOString();

          if (g[recorderKey] && typeof g[recorderKey] === 'object') {
            const existing = g[recorderKey] as Record<string, unknown>;
            if (existing.active) {
              return {
                started: false,
                message: `网络录制已在运行中（frame: ${location.href}）。`,
                frameUrl: location.href,
              };
            }
          }

          const recorder = {
            active: true,
            endpointKeyword: keyword,
            startedAt: now,
            frameUrl: location.href,
            events: [] as Array<{
              method: string;
              url: string;
              status: number;
              frameUrl: string;
              isTopFrame?: boolean;
              timestamp: string;
              requestBody?: string;
              requestHeaders?: Record<string, string>;
              keywordMatched?: boolean;
            }>,
            originalFetch: window.fetch,
            originalXhrOpen: XMLHttpRequest.prototype.open,
            originalXhrSend: XMLHttpRequest.prototype.send,
            originalXhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
            originalBeacon: Navigator.prototype.sendBeacon,
          };

          const matchKeyword = (url: string) =>
            !keyword.trim() || url.toLowerCase().includes(keyword.toLowerCase());

          const normalizeBody = (value: unknown): string => {
            if (typeof value === 'string') {
              return value.slice(0, 2000);
            }

            if (value instanceof URLSearchParams) {
              return value.toString().slice(0, 2000);
            }

            if (value instanceof FormData) {
              const pairs: string[] = [];
              value.forEach((v, k) => {
                pairs.push(`${k}=${typeof v === 'string' ? v : '[blob]'}`);
              });
              return pairs.join('&').slice(0, 2000);
            }

            if (value instanceof Blob) {
              return `[blob:${value.type || 'unknown'}:${value.size}]`;
            }

            if (typeof value === 'object' && value !== null) {
              try {
                return JSON.stringify(value).slice(0, 2000);
              } catch {
                return '[object]';
              }
            }

            return '';
          };

          const normalizeHeaders = (
            headersInput: HeadersInit | undefined,
          ): Record<string, string> => {
            const result: Record<string, string> = {};
            if (!headersInput) {
              return result;
            }

            if (headersInput instanceof Headers) {
              headersInput.forEach((value, key) => {
                result[key] = value;
              });
              return result;
            }

            if (Array.isArray(headersInput)) {
              for (const [key, value] of headersInput) {
                result[String(key)] = String(value);
              }
              return result;
            }

            for (const [key, value] of Object.entries(headersInput)) {
              result[key] = String(value);
            }
            return result;
          };

          window.fetch = async (...args) => {
            const req = args[0] as RequestInfo | URL;
            const init = (args[1] as RequestInit | undefined) ?? undefined;
            const url =
              typeof req === 'string'
                ? req
                : req instanceof Request
                  ? req.url
                  : String(req);
            const method = (init?.method || (req instanceof Request ? req.method : 'GET')).toUpperCase();

            let requestBody = '';
            let requestHeaders: Record<string, string> = {};
            try {
              if (typeof init?.body !== 'undefined') {
                requestBody = normalizeBody(init.body);
              } else if (req instanceof Request) {
                const cloned = req.clone();
                requestBody = (await cloned.text()).slice(0, 2000);
              }

              if (init?.headers) {
                requestHeaders = normalizeHeaders(init.headers);
              } else if (req instanceof Request) {
                requestHeaders = normalizeHeaders(req.headers);
              }
            } catch {
              requestBody = '';
              requestHeaders = {};
            }

            const response = await recorder.originalFetch(...args);

            recorder.events.push({
              method,
              url,
              status: response.status,
              frameUrl: location.href,
              isTopFrame: window.top === window,
              timestamp: new Date().toISOString(),
              requestBody: requestBody || undefined,
              requestHeaders: Object.keys(requestHeaders).length ? requestHeaders : undefined,
              keywordMatched: matchKeyword(url),
            });

            return response;
          };

          XMLHttpRequest.prototype.open = function (
            method: string,
            url: string | URL,
            ...rest: unknown[]
          ) {
            const xhr = this as XMLHttpRequest & {
              __boosMethod?: string;
              __boosUrl?: string;
              __boosBody?: string;
              __boosHeaders?: Record<string, string>;
            };
            xhr.__boosMethod = method;
            xhr.__boosUrl = String(url);
            xhr.__boosHeaders = {};

            return (recorder.originalXhrOpen as unknown as (...args: unknown[]) => unknown).apply(this, [
              method,
              url,
              ...rest,
            ]);
          };

          XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
            const xhr = this as XMLHttpRequest & {
              __boosHeaders?: Record<string, string>;
            };
            if (!xhr.__boosHeaders) {
              xhr.__boosHeaders = {};
            }
            xhr.__boosHeaders[name] = value;
            return recorder.originalXhrSetRequestHeader.call(this, name, value);
          };

          XMLHttpRequest.prototype.send = function (...args: unknown[]) {
            const xhr = this as XMLHttpRequest & {
              __boosMethod?: string;
              __boosUrl?: string;
              __boosBody?: string;
              __boosHeaders?: Record<string, string>;
            };
            xhr.__boosBody = normalizeBody(args[0]);

            xhr.addEventListener(
              'loadend',
              () => {
                const url = xhr.__boosUrl ?? '';
                recorder.events.push({
                  method: (xhr.__boosMethod || 'GET').toUpperCase(),
                  url,
                  status: xhr.status,
                  frameUrl: location.href,
                  isTopFrame: window.top === window,
                  timestamp: new Date().toISOString(),
                  requestBody: xhr.__boosBody || undefined,
                  requestHeaders:
                    xhr.__boosHeaders && Object.keys(xhr.__boosHeaders).length
                      ? xhr.__boosHeaders
                      : undefined,
                  keywordMatched: matchKeyword(url),
                });
              },
              { once: true },
            );

            return recorder.originalXhrSend.apply(this, args as [Document | XMLHttpRequestBodyInit | null | undefined]);
          };

          try {
            Navigator.prototype.sendBeacon = function (url: string | URL, data?: BodyInit | null) {
              const beaconUrl = String(url);
              recorder.events.push({
                method: 'BEACON',
                url: beaconUrl,
                status: 0,
                frameUrl: location.href,
                isTopFrame: window.top === window,
                timestamp: new Date().toISOString(),
                requestBody: normalizeBody(data),
                keywordMatched: matchKeyword(beaconUrl),
              });

              return recorder.originalBeacon.call(this, url, data);
            };
          } catch {
            // 某些页面环境下 sendBeacon 不可重写，忽略即可。
          }

          g[recorderKey] = recorder;

          return {
            started: true,
            message: `已开始网络录制（frame: ${location.href}）。`,
            frameUrl: location.href,
          };
        },
      });

      const frameSummaries = injectionResults.map((item) => ({
        frameUrl: item.result?.frameUrl || `frame#${item.frameId}`,
        started: Boolean(item.result?.started),
        eventsCaptured: 0,
        note: item.result?.message,
      }));
      const startedFrameCount = frameSummaries.filter((item) => item.started).length;
      const injectedFrameCount = frameSummaries.length;

      const bestResult = pickBestInjectionResult(injectionResults, (data) => (data.started ? 2 : 1));

      if (!injectedFrameCount) {
        return {
          started: false,
          message: '未注入到任何 frame，可能是页面权限或沙箱 iframe 限制。',
          injectedFrameCount,
          startedFrameCount,
          frameSummaries,
        };
      }

      return {
        started: startedFrameCount > 0,
        message:
          bestResult?.message ||
          `录制器未成功启动（已注入 ${injectedFrameCount} 个 frame，成功启动 0 个）。`,
        injectedFrameCount,
        startedFrameCount,
        frameSummaries,
      };
    });
  },

  async stopFavoriteNetworkRecording(
    endpointKeyword: string,
  ): Promise<ServiceResult<FavoriteNetworkRecording>> {
    const bridge = getWindowBridge();
    if (bridge?.stopFavoriteNetworkRecording) {
      try {
        const result = await bridge.stopFavoriteNetworkRecording(endpointKeyword);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 停止网络录制失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持网络录制能力。',
        },
        'unavailable',
        'fallback',
      );
    }

    return withActiveTab<FavoriteNetworkRecording>(async (tabId) => {
      const stoppedAt = new Date().toISOString();
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          const g = window as unknown as Record<string, unknown>;
          const recorderKey = '__boosFavoriteRecorder';
          const recorder = g[recorderKey] as
            | {
                active: boolean;
                startedAt: string;
                endpointKeyword: string;
                events: Array<{
                  method: string;
                  url: string;
                  status: number;
                  frameUrl: string;
                  isTopFrame?: boolean;
                  timestamp: string;
                  requestBody?: string;
                  requestHeaders?: Record<string, string>;
                  keywordMatched?: boolean;
                }>;
                originalFetch: typeof window.fetch;
                originalXhrOpen: typeof XMLHttpRequest.prototype.open;
                originalXhrSend: typeof XMLHttpRequest.prototype.send;
                originalXhrSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader;
                originalBeacon: typeof Navigator.prototype.sendBeacon;
              }
            | undefined;

          if (!recorder || !recorder.active) {
            return {
              frameUrl: location.href,
              startedAt: '',
              endpointKeyword: '',
              events: [] as Array<{
                method: string;
                url: string;
                status: number;
                frameUrl: string;
                isTopFrame?: boolean;
                timestamp: string;
                requestBody?: string;
                requestHeaders?: Record<string, string>;
                keywordMatched?: boolean;
              }>,
            };
          }

          window.fetch = recorder.originalFetch;
          XMLHttpRequest.prototype.open = recorder.originalXhrOpen;
          XMLHttpRequest.prototype.send = recorder.originalXhrSend;
          XMLHttpRequest.prototype.setRequestHeader = recorder.originalXhrSetRequestHeader;
          try {
            Navigator.prototype.sendBeacon = recorder.originalBeacon;
          } catch {
            // ignore
          }

          recorder.active = false;
          const payload = {
            frameUrl: location.href,
            startedAt: recorder.startedAt,
            endpointKeyword: recorder.endpointKeyword,
            events: recorder.events,
          };

          delete g[recorderKey];
          return payload;
        },
      });

      const frameSummaries = injectionResults.map((item) => ({
        frameUrl: item.result?.frameUrl || `frame#${item.frameId}`,
        eventsCaptured: item.result?.events?.length ?? 0,
        note: item.result?.events?.length
          ? `捕获 ${item.result.events.length} 条请求`
          : '未捕获请求',
      }));

      const mergedEvents = injectionResults
        .map((item) => item.result)
        .flatMap((item) => item?.events ?? [])
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const startedAt =
        injectionResults.find((item) => item.result?.startedAt)?.result?.startedAt || stoppedAt;
      const keywordFromRecorder =
        injectionResults.find((item) => item.result?.endpointKeyword)?.result?.endpointKeyword ||
        endpointKeyword;

      const recording: FavoriteNetworkRecording = {
        startedAt,
        stoppedAt,
        endpointKeyword: keywordFromRecorder,
        events: mergedEvents,
        frameSummaries,
      };

      lastFavoriteNetworkRecording = recording;
      return recording;
    });
  },

  async replayFavoriteNetworkRequests(payload: {
    endpointKeyword: string;
    mode: 'favorite' | 'unfavorite';
  }): Promise<ServiceResult<FavoriteReplayResult>> {
    const bridge = getWindowBridge();
    if (bridge?.replayFavoriteNetworkRequests) {
      try {
        const result = await bridge.replayFavoriteNetworkRequests(payload);
        return normalizeResult(result, 'chrome-mcp', 'live');
      } catch (error) {
        return buildError(
          {
            code: 'EXECUTION_FAILED',
            message: 'Chrome MCP 回放网络请求失败。',
            details: error instanceof Error ? error.message : String(error),
          },
          'chrome-mcp',
          'live',
        );
      }
    }

    if (!chrome?.scripting?.executeScript) {
      return buildError(
        {
          code: 'MCP_UNAVAILABLE',
          message: '当前环境不支持请求回放能力。',
        },
        'unavailable',
        'fallback',
      );
    }

    if (!lastFavoriteNetworkRecording?.events.length) {
      return buildError(
        {
          code: 'INVALID_INPUT',
          message: '未找到可回放的录制请求，请先完成一次录制。',
        },
        'tabs-scripting-fallback',
        'fallback',
      );
    }

    const keyword = payload.endpointKeyword.trim().toLowerCase();
    const modeKeywordReg =
      payload.mode === 'favorite'
        ? /(favorite|collect|like|bookmark|add|save|usermark\/add)/i
        : /(cancel|unfavorite|dislike|uncollect|remove|delete|del|usermark\/(delete|del))/i;

    const matchedEvents = lastFavoriteNetworkRecording.events.filter((event) => {
      const urlBody = `${event.url} ${event.requestBody || ''}`;
      const passKeyword = keyword ? urlBody.toLowerCase().includes(keyword) : true;
      return passKeyword && modeKeywordReg.test(urlBody);
    });

    const candidates = matchedEvents.length
      ? matchedEvents
      : lastFavoriteNetworkRecording.events.filter((event) =>
          keyword ? `${event.url} ${event.requestBody || ''}`.toLowerCase().includes(keyword) : true,
        );

    if (!candidates.length) {
      return buildError(
        {
          code: 'INVALID_INPUT',
          message: '没有匹配到可回放请求，请检查接口关键字或先重新录制。',
        },
        'tabs-scripting-fallback',
        'fallback',
      );
    }

    const picked = payload.mode === 'favorite' ? candidates[0] : candidates[candidates.length - 1];

    return withActiveTab<FavoriteReplayResult>(async (tabId) => {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [picked],
        func: async (event) => {
          if (!event || !event.url) {
            return {
              ok: false,
              message: '无效的回放事件。',
              replayedCount: 0,
              responses: [] as Array<{ method: string; url: string; status: number }>,
            };
          }

          if (location.href !== event.frameUrl) {
            return {
              ok: false,
              message: `跳过 frame：${location.href}`,
              replayedCount: 0,
              responses: [] as Array<{ method: string; url: string; status: number }>,
            };
          }

          const method = (event.method || 'POST').toUpperCase();
          const sanitizeHeaders = (raw: Record<string, string> | undefined) => {
            const blocked = [
              /^host$/i,
              /^cookie$/i,
              /^content-length$/i,
              /^sec-/i,
              /^origin$/i,
              /^referer$/i,
              /^priority$/i,
              /^accept-encoding$/i,
              /^connection$/i,
              /^user-agent$/i,
            ];

            const allowed = new Set(['content-type', 'x-requested-with', 'zp_token', 'accept']);
            const out: Record<string, string> = {};
            for (const [key, value] of Object.entries(raw || {})) {
              const lower = key.toLowerCase();
              if (blocked.some((rule) => rule.test(lower))) {
                continue;
              }
              if (allowed.has(lower) || lower.startsWith('x-')) {
                out[key] = String(value);
              }
            }
            return out;
          };

          const headers: Record<string, string> = sanitizeHeaders(event.requestHeaders);

          let body: string | undefined;
          if (typeof event.requestBody === 'string' && event.requestBody.trim()) {
            body = event.requestBody;
            if (!headers['Content-Type'] && !headers['content-type'] && event.requestBody.includes('=')) {
              headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            }
            if (!headers['Content-Type'] && !headers['content-type'] && event.requestBody.trim().startsWith('{')) {
              headers['Content-Type'] = 'application/json;charset=UTF-8';
            }
          } else if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
          }

          const response = await fetch(event.url, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : body,
            credentials: 'include',
          });

          return {
            ok: response.ok,
            message: response.ok ? '回放成功。' : `回放失败（HTTP ${response.status}）`,
            replayedCount: 1,
            responses: [
              {
                method,
                url: event.url,
                status: response.status,
              },
            ],
          };
        },
      });

      const best = pickBestInjectionResult(injectionResults, (data) => (data.replayedCount > 0 ? 2 : 1));
      return (
        best ?? {
          ok: false,
          message: '未在目标 frame 执行到回放。',
          replayedCount: 0,
          responses: [],
        }
      );
    });
  },

  async highlightCandidates(
    items: Array<{ index: number; shouldFavorite: boolean; reason: string }>,
    listItemSelector: string,
  ): Promise<{
    totalFrames: number;
    matchedFrames: number;
    maxFoundInFrame: number;
    details: Array<{ frameId?: number; totalFound: number; recommendedApplied: number; skippedApplied: number }>;
  }> {
    if (!chrome?.scripting?.executeScript) {
      return {
        totalFrames: 0,
        matchedFrames: 0,
        maxFoundInFrame: 0,
        details: [],
      };
    }
    if (!items.length) {
      return {
        totalFrames: 0,
        matchedFrames: 0,
        maxFoundInFrame: 0,
        details: [],
      };
    }

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      return {
        totalFrames: 0,
        matchedFrames: 0,
        maxFoundInFrame: 0,
        details: [],
      };
    }

    const effectiveSelector = withBossFallbackSelectors({
      listItemSelector,
      nameSelector: '.name',
      resumeContainerSelector: '',
      favoriteButtonSelector: '',
    }).listItemSelector;

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: [items, effectiveSelector],
      func: (
        highlightItems: Array<{ index: number; shouldFavorite: boolean; reason: string }>,
        selector: string,
      ) => {
        const STYLE_ID = 'boos-ext-highlight-style';
        const TOOLTIP_ID = 'boos-ext-tooltip';

        // --- Style (refresh on every inject to avoid stale old rules) ---
        const styleEl =
          (document.getElementById(STYLE_ID) as HTMLStyleElement | null) ??
          (() => {
            const s = document.createElement('style');
            s.id = STYLE_ID;
            document.head.appendChild(s);
            return s;
          })();

        styleEl.textContent = [
          '@keyframes boos-ai-pulse-ring {',
          '  0% {',
          '    transform: scale(0.985);',
          '    opacity: 0.78;',
          '    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.48);',
          '  }',
          '  65% {',
          '    transform: scale(1.005);',
          '    opacity: 0.22;',
          '    box-shadow: 0 0 0 10px rgba(34, 197, 94, 0.0);',
          '  }',
          '  100% {',
          '    transform: scale(1.01);',
          '    opacity: 0;',
          '    box-shadow: 0 0 0 14px rgba(34, 197, 94, 0.0);',
          '  }',
          '}',
          '.boos-ext-recommended {',
          '  position: relative !important;',
          '}',
          '.boos-ext-recommended::after {',
          '  content: "AI推荐";',
          '  position: absolute;',
          '  top: 6px;',
          '  right: 8px;',
          '  z-index: 12;',
          '  font-size: 11px;',
          '  color: #052e16;',
          '  background: #86efac;',
          '  border: 1px solid #22c55e;',
          '  border-radius: 999px;',
          '  padding: 0 6px;',
          '}',
          '.boos-ext-focus-node.boos-ext-recommended-inner {',
          '  position: relative !important;',
          '  border: 2px solid #16a34a !important;',
          '  border-radius: 10px !important;',
          '  background: rgba(34, 197, 94, 0.12) !important;',
          '  box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.16) !important;',
          '}',
          '.boos-ext-focus-node.boos-ext-recommended-inner::before {',
          '  content: "";',
          '  position: absolute;',
          '  inset: -2px;',
          '  border-radius: 12px;',
          '  pointer-events: none;',
          '  border: 2px solid rgba(34, 197, 94, 0.75);',
          '  animation: boos-ai-pulse-ring 1.8s ease-out infinite !important;',
          '}',
          '.boos-ext-not-recommended {',
          '  opacity: 0.82 !important;',
          '}',
          '.boos-ext-not-recommended .candidate-card-wrap,',
          '.boos-ext-not-recommended .card-inner {',
          '  filter: grayscale(0.12);',
          '}',
        ].join('\n');

        // --- Tooltip (create once, fully inline-styled) ---
        let tip = document.getElementById(TOOLTIP_ID) as HTMLElement | null;
        if (!tip) {
          tip = document.createElement('div');
          tip.id = TOOLTIP_ID;
          tip.style.cssText = [
            'position:fixed',
            'z-index:2147483647',
            'max-width:260px',
            'padding:8px 12px',
            'background:#1e293b',
            'color:#f8fafc',
            'font-size:13px',
            'line-height:1.6',
            'border-radius:8px',
            'box-shadow:0 4px 20px rgba(0,0,0,0.35)',
            'pointer-events:none',
            'white-space:pre-wrap',
            'word-break:break-all',
            'opacity:0',
            'transition:opacity 0.15s',
            'left:-9999px',
            'top:-9999px',
          ].join(';');
          document.body.appendChild(tip);
        }
        const tipEl = tip;

        // --- Build index map ---
        const itemMap = new Map(
          highlightItems.map((item) => [item.index, item]),
        );

        // --- Core apply function ---
        // querySelectorAll with a combined selector returns unique elements in DOM order,
        // matching the same index-based order used when reading the candidate list.
        function applyHighlights() {
          const allItems = Array.from(
            document.querySelectorAll(selector),
          ) as HTMLElement[];

          let recommendedApplied = 0;
          let skippedApplied = 0;

          allItems.forEach((el, idx) => {
            // Always reset first so stale classes don't accumulate
            el.classList.remove('boos-ext-recommended', 'boos-ext-not-recommended');
            delete el.dataset.boosHighlight;
            delete el.dataset.boosReason;
            const oldFocusNode = el.querySelector('.boos-ext-focus-node.boos-ext-recommended-inner');
            if (oldFocusNode) {
              oldFocusNode.classList.remove('boos-ext-focus-node', 'boos-ext-recommended-inner');
            }
            const data = itemMap.get(idx);
            if (!data) return;

            const focusNode =
              (el.querySelector('.candidate-card-wrap') as HTMLElement | null) ??
              (el.querySelector('.card-inner') as HTMLElement | null) ??
              el;

            if (data.shouldFavorite) {
              el.classList.add('boos-ext-recommended');
              el.dataset.boosHighlight = 'recommended';
              el.dataset.boosReason = data.reason;
              focusNode.classList.add('boos-ext-focus-node', 'boos-ext-recommended-inner');
              recommendedApplied += 1;
              // Bind listeners only once — no cloneNode (would detach Vue vnode)
              if (!el.dataset.boosEventsBound) {
                el.dataset.boosEventsBound = '1';
                const reason = data.reason;
                el.addEventListener('mouseenter', function (e) {
                  tipEl.textContent = '\uD83E\uDD16 ' + reason;
                  tipEl.style.opacity = '1';
                  tipEl.style.left =
                    Math.min((e as MouseEvent).clientX + 16, window.innerWidth - 280) + 'px';
                  tipEl.style.top =
                    Math.min((e as MouseEvent).clientY + 16, window.innerHeight - 80) + 'px';
                });
                el.addEventListener('mousemove', function (e) {
                  tipEl.style.left =
                    Math.min((e as MouseEvent).clientX + 16, window.innerWidth - 280) + 'px';
                  tipEl.style.top =
                    Math.min((e as MouseEvent).clientY + 16, window.innerHeight - 80) + 'px';
                });
                el.addEventListener('mouseleave', function () {
                  tipEl.style.opacity = '0';
                });
              }
            } else {
              el.classList.add('boos-ext-not-recommended');
              el.dataset.boosHighlight = 'skipped';
              el.dataset.boosReason = data.reason;
              skippedApplied += 1;
            }
          });

          return {
            totalFound: allItems.length,
            recommendedApplied,
            skippedApplied,
          };
        }

        // Apply immediately, then retry after short delays to survive Vue re-renders
        const firstPass = applyHighlights();
        window.setTimeout(applyHighlights, 300);
        window.setTimeout(applyHighlights, 1000);

        return firstPass;
      },
    });

    const details = injectionResults.map((item) => ({
      frameId: item.frameId,
      totalFound: item.result?.totalFound ?? 0,
      recommendedApplied: item.result?.recommendedApplied ?? 0,
      skippedApplied: item.result?.skippedApplied ?? 0,
    }));
    const matchedFrames = details.filter((d) => d.totalFound > 0).length;
    const maxFoundInFrame = details.reduce((max, d) => Math.max(max, d.totalFound), 0);

    return {
      totalFrames: details.length,
      matchedFrames,
      maxFoundInFrame,
      details,
    };
  },
};
