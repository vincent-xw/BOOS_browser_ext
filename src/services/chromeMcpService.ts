import type {
  CandidateProfile,
  CandidateQuerySelectors,
  CandidateSummary,
  ChromeMcpBridge,
  OperationError,
  PageReadData,
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
