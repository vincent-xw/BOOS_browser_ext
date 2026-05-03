import type {
  CandidateProfile,
  CandidateQuerySelectors,
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

      return bestResult ?? [];
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

          return {
            name: nameElement?.textContent?.trim() || '',
            resumeText:
              resumeContainer?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 12000) || '',
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
        args: [effectiveSelectors.favoriteButtonSelector],
        func: (favoriteButtonSelector: string) => {
          const selectors = favoriteButtonSelector
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

          let target: HTMLElement | null = null;
          for (const selector of selectors) {
            const found = document.querySelector(selector) as HTMLElement | null;
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
            };
          }

          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.click();

          return {
            clicked: true,
            message: '已触发收藏按钮点击。',
            timestamp: new Date().toISOString(),
          };
        },
      });

      const bestResult = pickBestInjectionResult(injectionResults, (data) =>
        data.clicked ? 1 : 0,
      );

      return (bestResult ?? injectionResults[0]?.result) as FavoriteActionData;
    });
  },
};
