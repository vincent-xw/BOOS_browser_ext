import { computed, ref } from 'vue';
import { chromeMcpService } from '../services/chromeMcpService';
import {
  buildCandidateKey,
  getResultsByKeys,
  saveResults,
  type CandidateDbResult,
} from '../services/candidateResultDb';
import { exportCandidatesXlsx } from '../services/exportService';
import { llmService } from '../services/llmService';
import { settingsService } from '../services/settingsService';
import type {
  CandidateQuerySelectors,
  CandidateSummary,
  OperationError,
  OperationState,
  PageCandidateOverview,
  ProviderKind,
  ProviderMode,
  WorkflowProgress,
} from '../types/page-io';
import type { AppSettings } from '../types/settings';

function createInitialProgress(): WorkflowProgress {
  return {
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    currentCandidateName: '',
    records: [],
  };
}

function createInitialCandidateOverview(): PageCandidateOverview {
  return {
    total: 0,
    loadedAt: '',
    changeState: 'idle',
    addedCount: 0,
    removedCount: 0,
    sampleNames: [],
    changeDescription: '尚未读取当前页面候选人数据。',
  };
}

function createSelectors(settings: AppSettings): CandidateQuerySelectors {
  return {
    listItemSelector: settings.basic.candidateListItemSelector,
    nameSelector: settings.basic.candidateNameSelector,
    resumeContainerSelector: settings.basic.resumeContainerSelector,
    favoriteButtonSelector: settings.basic.favoriteButtonSelector,
  };
}

function randomDelayMs(minSeconds: number, maxSeconds: number): number {
  const min = Math.ceil(minSeconds * 1000);
  const max = Math.floor(maxSeconds * 1000);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildCandidateSnapshotSignature(candidates: CandidateSummary[]): string {
  return candidates
    .map((candidate) => `${candidate.index}|${candidate.name}|${candidate.previewText}`)
    .join('\n');
}

function createCandidateLookup(candidates: CandidateSummary[]): Set<string> {
  return new Set(candidates.map((candidate) => `${candidate.name}|${candidate.previewText}`));
}

function buildCandidateOverview(
  candidates: CandidateSummary[],
  previousCandidates: CandidateSummary[] | null,
): PageCandidateOverview {
  const sampleNames = candidates.slice(0, 3).map((candidate) => candidate.name);

  if (!previousCandidates) {
    return {
      total: candidates.length,
      loadedAt: new Date().toISOString(),
      changeState: 'stable',
      addedCount: 0,
      removedCount: 0,
      sampleNames,
      changeDescription: candidates.length
        ? '已读取当前页面候选人数据。'
        : '当前页面未读取到候选人数据。',
    };
  }

  const previousSignature = buildCandidateSnapshotSignature(previousCandidates);
  const currentSignature = buildCandidateSnapshotSignature(candidates);
  if (previousSignature === currentSignature) {
    return {
      total: candidates.length,
      loadedAt: new Date().toISOString(),
      changeState: 'stable',
      addedCount: 0,
      removedCount: 0,
      sampleNames,
      changeDescription: '页面候选人数据无变化。',
    };
  }

  const previousLookup = createCandidateLookup(previousCandidates);
  const currentLookup = createCandidateLookup(candidates);
  let addedCount = 0;
  let removedCount = 0;

  for (const item of currentLookup) {
    if (!previousLookup.has(item)) {
      addedCount += 1;
    }
  }

  for (const item of previousLookup) {
    if (!currentLookup.has(item)) {
      removedCount += 1;
    }
  }

  const changeDescription =
    addedCount || removedCount
      ? `页面候选人数据已变化：新增 ${addedCount}，减少 ${removedCount}。`
      : '页面候选人数据已变化，可能是排序或候选人内容发生更新。';

  return {
    total: candidates.length,
    loadedAt: new Date().toISOString(),
    changeState: 'changed',
    addedCount,
    removedCount,
    sampleNames,
    changeDescription,
  };
}

export function usePageIoController() {
  const loadedSettings = settingsService.load();

  const runState = ref<OperationState>('idle');
  const runError = ref<OperationError | null>(null);
  const candidateOverviewError = ref<OperationError | null>(null);
  const promptText = ref('请根据岗位匹配度、稳定性、沟通能力判断是否值得收藏。');
  const progress = ref<WorkflowProgress>(createInitialProgress());
  const candidateOverview = ref<PageCandidateOverview>(createInitialCandidateOverview());
  const pageCandidates = ref<CandidateSummary[]>([]);
  const provider = ref<ProviderKind>('unavailable');
  const mode = ref<ProviderMode>('fallback');
  const domainStatus = ref<'unknown' | 'matched' | 'mismatched'>('unknown');
  const currentDomain = ref('');
  const settings = ref<AppSettings>(loadedSettings.normalized);
  const settingsWarnings = ref<string[]>(loadedSettings.issues);
  const isRefreshingCandidateOverview = ref(false);
  const lastCandidateSnapshot = ref<CandidateSummary[] | null>(null);
  const candidateResults = ref<Map<string, CandidateDbResult>>(new Map());
  const singleProcessingKeys = ref<Set<string>>(new Set());

  const isBusy = computed(() => runState.value === 'running');
  const overallState = computed<OperationState>(() => runState.value);
  const runStateLabel = computed(() => {
    switch (runState.value) {
      case 'running':
        return '执行中';
      case 'succeeded':
        return '已完成';
      case 'failed':
        return '失败';
      default:
        return '待执行';
    }
  });

  const providerLabel = computed(() => {
    switch (provider.value) {
      case 'chrome-mcp':
        return 'Chrome MCP';
      case 'tabs-scripting-fallback':
        return '标签页脚本回退';
      default:
        return '能力不可用';
    }
  });

  const modeLabel = computed(() => (mode.value === 'live' ? '实时模式' : '回退模式'));

  function getCandidateStatusLabel(status: WorkflowProgress['records'][number]['status']) {
    switch (status) {
      case 'favorited':
        return '推荐跟进';
      case 'skipped':
        return '暂不跟进';
      case 'failed':
        return '失败';
      default:
        return status;
    }
  }

  const overallMessage = computed(() => {
    switch (overallState.value) {
      case 'running':
        return '正在执行牛人自动处理流程，请保持在候选人列表页面。';
      case 'succeeded':
        return `流程已完成：成功 ${progress.value.succeeded}，失败 ${progress.value.failed}。`;
      case 'failed':
        return runError.value?.message || '流程执行失败，请检查配置后重试。';
      default:
        return '请先确认目标站点与高级设置，然后输入 Prompt 开始处理候选人。';
    }
  });

  const overallMessageType = computed(() => {
    switch (overallState.value) {
      case 'running':
        return 'info';
      case 'succeeded':
        return 'success';
      case 'failed':
        return 'error';
      default:
        return 'warning';
    }
  });

  const candidateOverviewLabel = computed(() => {
    switch (candidateOverview.value.changeState) {
      case 'changed':
        return '已发现变更';
      case 'stable':
        return '已同步';
      default:
        return '待读取';
    }
  });

  function loadSettings() {
    const loaded = settingsService.load();
    settings.value = loaded.normalized;
    settingsWarnings.value = loaded.issues;
  }

  function saveSettings(next: AppSettings): { ok: boolean; issues: string[] } {
    const saved = settingsService.save(next);
    settings.value = saved.normalized;
    settingsWarnings.value = saved.issues;

    return {
      ok: saved.valid,
      issues: saved.issues,
    };
  }

  async function checkDomainMatch(): Promise<boolean> {
    const result = await chromeMcpService.getCurrentDomain();
    provider.value = result.provider;
    mode.value = result.mode;

    if (!result.ok || !result.data) {
      domainStatus.value = 'unknown';
      currentDomain.value = '';
      runError.value = result.error ?? {
        code: 'EXECUTION_FAILED',
        message: '读取当前站点失败。',
      };
      return false;
    }

    currentDomain.value = result.data;
    const matched = result.data === settings.value.basic.targetDomain;
    domainStatus.value = matched ? 'matched' : 'mismatched';
    return matched;
  }

  async function loadCandidateResultsFromDb(candidates: CandidateSummary[]) {
    if (!candidates.length) return;
    const keys = candidates.map((c) => buildCandidateKey(c.name, c.previewText));
    try {
      const map = await getResultsByKeys(keys);
      candidateResults.value = map;
    } catch {
      // Non-critical — silently ignore DB read errors
    }
  }

  async function refreshCandidateOverview() {
    if (runState.value === 'running') {
      return;
    }

    isRefreshingCandidateOverview.value = true;
    candidateOverviewError.value = null;

    try {
      const matched = await checkDomainMatch();
      if (!matched) {
        candidateOverview.value = {
          ...createInitialCandidateOverview(),
          changeDescription: '当前站点不匹配，无法读取候选人数据。',
        };
        return;
      }

      const selectors = createSelectors(settings.value);
      const listResult = await chromeMcpService.readCandidateList(selectors);
      provider.value = listResult.provider;
      mode.value = listResult.mode;

      if (!listResult.ok || !listResult.data) {
        candidateOverviewError.value = listResult.error ?? {
          code: 'EXECUTION_FAILED',
          message: '读取当前页面候选人数据失败。',
        };
        candidateOverview.value = {
          ...candidateOverview.value,
          loadedAt: new Date().toISOString(),
          changeDescription: candidateOverviewError.value.message,
        };
        return;
      }

      const candidates = listResult.data;
      pageCandidates.value = candidates;
      candidateOverview.value = buildCandidateOverview(candidates, lastCandidateSnapshot.value);
      lastCandidateSnapshot.value = candidates;
      void loadCandidateResultsFromDb(candidates).then(() => highlightAllProcessedOnPage());
    } finally {
      isRefreshingCandidateOverview.value = false;
    }
  }

  function appendRecord(record: WorkflowProgress['records'][number]) {
    progress.value.records.push(record);
    progress.value.processed += 1;
    if (record.status === 'failed') {
      progress.value.failed += 1;
      return;
    }

    progress.value.succeeded += 1;
  }

  async function highlightAllProcessedOnPage() {
    if (!pageCandidates.value.length) return;
    const items = pageCandidates.value
      .map((c) => {
        const res = candidateResults.value.get(buildCandidateKey(c.name, c.previewText));
        if (!res) return null;
        return { index: c.index, shouldFavorite: res.shouldFavorite, reason: res.reason };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (!items.length) return;
    try {
      const result = await chromeMcpService.highlightCandidates(
        items,
        settings.value.basic.candidateListItemSelector,
      );
      console.info('[BOOS Highlight] injected', {
        candidateCount: pageCandidates.value.length,
        processedCount: items.length,
        recommendedIndexes: items.filter((i) => i.shouldFavorite).map((i) => i.index),
        skippedIndexes: items.filter((i) => !i.shouldFavorite).map((i) => i.index),
        selector: settings.value.basic.candidateListItemSelector,
        ...result,
      });
    } catch (error) {
      console.warn('[BOOS Highlight] inject failed', error);
    }
  }

  async function handleRunWorkflow() {
    runState.value = 'running';
    runError.value = null;
    progress.value = createInitialProgress();

    if (!promptText.value.trim()) {
      runState.value = 'failed';
      runError.value = {
        code: 'INVALID_INPUT',
        message: '请输入用于评估候选人的 Prompt。',
      };
      return;
    }

    const matched = await checkDomainMatch();
    if (!matched) {
      runState.value = 'failed';
      runError.value = {
        code: 'DOMAIN_MISMATCH',
        message: `当前站点 ${currentDomain.value || '未知'} 与配置域名 ${settings.value.basic.targetDomain} 不匹配。`,
      };
      return;
    }

    if (!settings.value.advanced.llmApiEndpoint || !settings.value.advanced.llmApiKey) {
      runState.value = 'failed';
      runError.value = {
        code: 'CONFIG_MISSING',
        message: '请先在高级设置中配置大模型 API Endpoint 与 API Key。',
      };
      return;
    }

    const selectors = createSelectors(settings.value);
    const listResult = await chromeMcpService.readCandidateList(selectors);
    provider.value = listResult.provider;
    mode.value = listResult.mode;

    if (!listResult.ok || !listResult.data) {
      runState.value = 'failed';
      runError.value = listResult.error ?? {
        code: 'EXECUTION_FAILED',
        message: '读取候选人列表失败。',
      };
      return;
    }

    // Only update the visible list when it's empty or clearly changed — preserve existing data during reprocessing
    const fetchedCandidates = listResult.data;
    if (!pageCandidates.value.length) {
      pageCandidates.value = fetchedCandidates;
    }
    candidateOverview.value = buildCandidateOverview(fetchedCandidates, lastCandidateSnapshot.value);
    lastCandidateSnapshot.value = fetchedCandidates;

    // Reload DB results for this candidate list and skip already-processed ones
    await loadCandidateResultsFromDb(fetchedCandidates);
    const pendingCandidates = fetchedCandidates.filter(
      (c) => !candidateResults.value.has(buildCandidateKey(c.name, c.previewText)),
    );

    progress.value.total = pendingCandidates.length;

    if (!pendingCandidates.length) {
      progress.value.currentCandidateName = '';
      runState.value = 'succeeded';
      return;
    }

    const batchSize = Math.max(1, settings.value.advanced.batchSize ?? 10);

    try {
      for (let offset = 0; offset < pendingCandidates.length; offset += batchSize) {
        const batch = pendingCandidates.slice(offset, offset + batchSize);
        progress.value.currentCandidateName = `正在处理第 ${offset + 1}–${Math.min(offset + batchSize, pendingCandidates.length)} 条...`;

        const batchResult = await llmService.assessCandidateList(
          settings.value,
          promptText.value,
          batch,
        );

        const decisionMap = new Map(batchResult.decisions.map((item) => [item.index, item]));
        const dbRecordsToSave: CandidateDbResult[] = [];

        for (const candidate of batch) {
          const decision = decisionMap.get(candidate.index);
          if (!decision) {
            appendRecord({
              candidate,
              status: 'failed',
              reason: 'LLM 未返回该候选人的判断结果。',
            });
            continue;
          }

          appendRecord({
            candidate,
            status: decision.shouldFavorite ? 'favorited' : 'skipped',
            reason: decision.reason,
          });

          const dbRecord: CandidateDbResult = {
            key: buildCandidateKey(candidate.name, candidate.previewText),
            name: candidate.name,
            previewText: candidate.previewText,
            shouldFavorite: decision.shouldFavorite,
            reason: decision.reason,
            processedAt: new Date().toISOString(),
            model: settings.value.advanced.llmModel,
          };
          dbRecordsToSave.push(dbRecord);
          candidateResults.value.set(dbRecord.key, dbRecord);
        }

        try {
          await saveResults(dbRecordsToSave);
        } catch {
          // Non-critical — continue even if DB write fails
        }

        // Highlight processed candidates on page after each batch
        void highlightAllProcessedOnPage();

        if (offset + batchSize < pendingCandidates.length) {
          await delay(randomDelayMs(0.3, 0.6));
        }
      }
    } catch (error) {
      runState.value = 'failed';
      runError.value = {
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : 'LLM 批量评估失败。',
      };
      progress.value.currentCandidateName = '';
      return;
    }

    progress.value.currentCandidateName = '';
    runState.value = progress.value.failed > 0 ? 'failed' : 'succeeded';
    if (progress.value.failed > 0) {
      runError.value = {
        code: 'EXECUTION_FAILED',
        message: '流程已完成，但存在失败候选人，请查看处理记录。',
      };
    }
  }

  function handleExport() {
    exportCandidatesXlsx(
      pageCandidates.value,
      candidateResults.value,
      settings.value.advanced.exportMode,
      buildCandidateKey,
    );
  }

  async function processSingleCandidate(candidate: CandidateSummary) {
    const key = buildCandidateKey(candidate.name, candidate.previewText);
    if (singleProcessingKeys.value.has(key)) return;

    singleProcessingKeys.value = new Set(singleProcessingKeys.value).add(key);

    try {
      const batchResult = await llmService.assessCandidateList(
        settings.value,
        promptText.value,
        [candidate],
      );

      const decision = batchResult.decisions.find((d) => d.index === candidate.index);
      const dbRecord: CandidateDbResult = {
        key,
        name: candidate.name,
        previewText: candidate.previewText,
        shouldFavorite: decision?.shouldFavorite ?? false,
        reason: decision?.reason ?? 'LLM 未返回结果。',
        processedAt: new Date().toISOString(),
        model: settings.value.advanced.llmModel,
      };

      await saveResults([dbRecord]);
      const next = new Map(candidateResults.value);
      next.set(key, dbRecord);
      candidateResults.value = next;
      void highlightAllProcessedOnPage();
    } finally {
      const next = new Set(singleProcessingKeys.value);
      next.delete(key);
      singleProcessingKeys.value = next;
    }
  }

  return {
    runState,
    runStateLabel,
    runError,
    candidateOverview,
    pageCandidates,
    candidateOverviewError,
    candidateOverviewLabel,
    promptText,
    progress,
    settings,
    settingsWarnings,
    domainStatus,
    currentDomain,
    isBusy,
    isRefreshingCandidateOverview,
    candidateResults,
    singleProcessingKeys,
    overallState,
    overallMessage,
    overallMessageType,
    providerLabel,
    modeLabel,
    getCandidateStatusLabel,
    loadSettings,
    saveSettings,
    checkDomainMatch,
    refreshCandidateOverview,
    handleRunWorkflow,
    processSingleCandidate,
    handleExport,
  };
}
