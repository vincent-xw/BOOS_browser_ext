import { computed, ref } from 'vue';
import { chromeMcpService } from '../services/chromeMcpService';
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    window.setTimeout(() => {
      reject(new Error(`操作超时（>${timeoutMs}ms）`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
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
        return '已收藏';
      case 'skipped':
        return '已跳过';
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

  async function processSingleCandidate(candidate: CandidateSummary): Promise<void> {
    const selectors = createSelectors(settings.value);
    progress.value.currentCandidateName = candidate.name;

    const detailResult = await chromeMcpService.openCandidateDetail(candidate, selectors);
    provider.value = detailResult.provider;
    mode.value = detailResult.mode;

    if (!detailResult.ok || !detailResult.data?.opened) {
      appendRecord({
        candidate,
        status: 'failed',
        reason: detailResult.data?.message || detailResult.error?.message || '打开候选人详情失败。',
      });
      return;
    }

    await delay(450);

    const profileResult = await chromeMcpService.readCandidateProfile(selectors);
    provider.value = profileResult.provider;
    mode.value = profileResult.mode;

    if (!profileResult.ok || !profileResult.data) {
      appendRecord({
        candidate,
        status: 'failed',
        reason: profileResult.error?.message || '读取在线简历失败。',
      });
      return;
    }

    if (!profileResult.data.resumeText.trim()) {
      appendRecord({
        candidate,
        status: 'failed',
        reason: '简历内容为空，无法进行模型评估。',
      });
      return;
    }

    const assessment = await llmService.assessCandidate(
      settings.value,
      promptText.value,
      candidate,
      profileResult.data,
    );

    if (!assessment.shouldFavorite) {
      appendRecord({
        candidate,
        status: 'skipped',
        reason: assessment.reason,
      });
      return;
    }

    const favoriteResult = await chromeMcpService.clickFavoriteButton(selectors);
    provider.value = favoriteResult.provider;
    mode.value = favoriteResult.mode;

    if (!favoriteResult.ok || !favoriteResult.data?.clicked) {
      appendRecord({
        candidate,
        status: 'failed',
        reason: favoriteResult.data?.message || favoriteResult.error?.message || '点击收藏失败。',
      });
      return;
    }

    appendRecord({
      candidate,
      status: 'favorited',
      reason: assessment.reason,
    });
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

    progress.value.total = listResult.data.length;
    pageCandidates.value = listResult.data;
    candidateOverview.value = buildCandidateOverview(listResult.data, lastCandidateSnapshot.value);
    lastCandidateSnapshot.value = listResult.data;

    for (const candidate of listResult.data) {
      try {
        await withTimeout(
          processSingleCandidate(candidate),
          settings.value.advanced.perCandidateTimeoutMs,
        );
      } catch (error) {
        appendRecord({
          candidate,
          status: 'failed',
          reason: error instanceof Error ? error.message : '候选人处理超时或失败。',
        });
      }

      await delay(randomDelayMs(1, 5));
    }

    progress.value.currentCandidateName = '';
    runState.value = progress.value.failed > 0 ? 'failed' : 'succeeded';
    if (progress.value.failed > 0) {
      runError.value = {
        code: 'EXECUTION_FAILED',
        message: '流程已完成，但存在失败候选人，请查看处理记录。',
      };
    }

    await refreshCandidateOverview();
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
  };
}
