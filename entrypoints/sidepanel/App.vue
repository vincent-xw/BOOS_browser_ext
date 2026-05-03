<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Connection, Position, RefreshRight, Setting, Tickets, Download } from '@element-plus/icons-vue';
import ExtensionAppShell from '../../src/components/ExtensionAppShell.vue';
import ExtensionSettingsPanel from '../../src/components/ExtensionSettingsPanel.vue';
import { usePageIoController } from '../../src/composables/usePageIoController';
import { ref } from 'vue';
import { runDiagnostics, formatDiagnosticResult } from '../../src/services/diagnosticService';
import type { DiagnosticResult } from '../../src/services/diagnosticService';
import { buildCandidateKey } from '../../src/services/candidateResultDb';

const {
  runState,
  runStateLabel,
  runError,
  candidateOverview,
  candidateOverviewError,
  candidateOverviewLabel,
  pageCandidates,
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
  overallMessage,
  overallMessageType,
  providerLabel,
  modeLabel,
  getCandidateStatusLabel,
  saveSettings,
  checkDomainMatch,
  refreshCandidateOverview,
  handleRunWorkflow,
  processSingleCandidate,
  handleExport,
} = usePageIoController();

const settingsVisible = ref(false);
const settingsSaving = ref(false);
const diagnosticVisible = ref(false);
const diagnosticRunning = ref(false);
const diagnosticResult = ref<DiagnosticResult | null>(null);
const diagnosticOutput = ref('');

const runTagType = computed(() => {
  switch (runState.value) {
    case 'running':
      return 'warning';
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'info';
  }
});

const domainTagType = computed(() => {
  switch (domainStatus.value) {
    case 'matched':
      return 'success';
    case 'mismatched':
      return 'danger';
    default:
      return 'info';
  }
});

const domainLabel = computed(() => {
  switch (domainStatus.value) {
    case 'matched':
      return `站点匹配：${currentDomain.value}`;
    case 'mismatched':
      return `站点不匹配：${currentDomain.value || '未知'}`;
    default:
      return '站点待检测';
  }
});

const progressRate = computed(() => {
  if (!progress.value.total) {
    return 0;
  }

  return Math.round((progress.value.processed / progress.value.total) * 100);
});

const candidateOverviewTagType = computed(() => {
  switch (candidateOverview.value.changeState) {
    case 'changed':
      return 'warning';
    case 'stable':
      return 'success';
    default:
      return 'info';
  }
});

const candidateOverviewLoadedAtLabel = computed(() => {
  if (!candidateOverview.value.loadedAt) {
    return '未读取';
  }

  return new Date(candidateOverview.value.loadedAt).toLocaleString('zh-CN', {
    hour12: false,
  });
});

const candidatePreviewLabel = computed(() => {
  if (!candidateOverview.value.sampleNames.length) {
    return '暂无';
  }

  return candidateOverview.value.sampleNames.join('、');
});

const candidateResultSummary = computed(() => {
  let recommended = 0;
  let notRecommended = 0;
  let pending = 0;
  for (const c of pageCandidates.value) {
    const key = buildCandidateKey(c.name, c.previewText);
    const result = candidateResults.value.get(key);
    if (!result) {
      pending++;
    } else if (result.shouldFavorite) {
      recommended++;
    } else {
      notRecommended++;
    }
  }
  return { recommended, notRecommended, pending, total: pageCandidates.value.length };
});

const pageCandidatesEmptyText = computed(() => {
  if (candidateOverviewError.value) {
    return '页面数据读取失败';
  }

  if (!isSiteMatched.value) {
    return '当前站点不匹配';
  }

  if (isRefreshingCandidateOverview.value) {
    return '页面数据读取中...';
  }

  return '当前页面暂无候选人数据';
});

async function handleSaveSettings(nextSettings: typeof settings.value) {
  settingsSaving.value = true;

  try {
    const result = saveSettings(nextSettings);
    if (result.ok) {
      ElMessage.success('设置已保存并生效。');
    } else {
      ElMessage.warning(result.issues.join('；'));
    }

    settingsVisible.value = false;
    await refreshDomainStatus();
  } finally {
    settingsSaving.value = false;
  }
}

const isSiteMatched = computed(() => domainStatus.value === 'matched');
const isCapabilityAvailable = computed(() => providerLabel.value !== '能力不可用');
const isLiveMode = computed(() => modeLabel.value === '实时模式');

const siteStatusLabel = computed(() => {
  if (domainStatus.value === 'matched') {
    return `当前运行于 ${currentDomain.value}`;
  }

  if (domainStatus.value === 'mismatched') {
    return `当前页面不是 ${settings.value.basic.targetDomain}`;
  }

  return '正在检测当前站点';
});

const capabilityStatusLabel = computed(() =>
  isCapabilityAvailable.value ? '页面能力可用' : '页面能力不可用',
);

const modeStatusLabel = computed(() =>
  isLiveMode.value ? '当前为实时模式' : '当前为回退模式',
);

async function refreshDomainStatus() {
  await checkDomainMatch();
}

async function refreshPageOverview() {
  await refreshCandidateOverview();
}

async function runDiagnostic() {
  diagnosticRunning.value = true;
  diagnosticOutput.value = '诊断中...';

  try {
    const result = await runDiagnostics();
    diagnosticResult.value = result;
    diagnosticOutput.value = formatDiagnosticResult(result);
  } catch (error) {
    diagnosticOutput.value = `诊断失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    diagnosticRunning.value = false;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void refreshDomainStatus();
    void refreshPageOverview();
  }
}

onMounted(() => {
  void refreshDomainStatus();
  void refreshPageOverview();
  window.addEventListener('focus', refreshDomainStatus);
  window.addEventListener('focus', refreshPageOverview);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshDomainStatus);
  window.removeEventListener('focus', refreshPageOverview);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <ExtensionAppShell
    title="BOSS助手"
    description="基于AI大模型的BOSS人才挖掘工具"
    :provider-label="providerLabel"
    :mode-label="modeLabel"
    :status-message="overallMessage"
    :status-type="overallMessageType"
  >
    <template #header-actions>
      <div class="header-indicators">
        <el-tooltip :content="siteStatusLabel" placement="bottom">
          <button class="status-indicator" type="button">
            <el-icon class="status-indicator__icon"><Position /></el-icon>
            <span
              class="status-indicator__light"
              :class="isSiteMatched ? 'is-green' : 'is-red'"
            />
          </button>
        </el-tooltip>

        <el-tooltip :content="capabilityStatusLabel" placement="bottom">
          <button class="status-indicator" type="button">
            <el-icon class="status-indicator__icon"><Connection /></el-icon>
            <span
              class="status-indicator__light"
              :class="isCapabilityAvailable ? 'is-green' : 'is-red'"
            />
          </button>
        </el-tooltip>

        <el-tooltip :content="modeStatusLabel" placement="bottom">
          <button class="status-indicator" type="button">
            <el-icon class="status-indicator__icon"><Connection /></el-icon>
            <span
              class="status-indicator__light"
              :class="isLiveMode ? 'is-green' : 'is-red'"
            />
          </button>
        </el-tooltip>

        <el-tooltip content="打开设置" placement="bottom">
          <el-button :icon="Setting" circle plain @click="settingsVisible = true" />
        </el-tooltip>

        <el-tooltip content="诊断数据读取能力" placement="bottom">
          <el-button :icon="Tickets" circle plain @click="diagnosticVisible = true" />
        </el-tooltip>
      </div>
    </template>

    <div class="popup-layout">
      <el-card class="panel-card" shadow="never">
        <template #header>
          <div class="panel-header">
            <span>自动处理执行面板</span>
            <el-tag :type="runTagType" effect="plain">{{ runStateLabel }}</el-tag>
          </div>
        </template>

        <el-space direction="vertical" fill :size="12">
          <el-input
            v-model="promptText"
            type="textarea"
            :rows="6"
            resize="none"
            placeholder="请输入评估策略 Prompt（例如：优先推荐 3 年以上 Java 后端经验、稳定性高的候选人）"
          />

          <el-space wrap>
            <el-button
              type="primary"
              :loading="runState === 'running'"
              :disabled="!promptText.trim()"
              @click="handleRunWorkflow"
            >
              开始自动处理
            </el-button>

            <el-button
              plain
              :icon="RefreshRight"
              :loading="isRefreshingCandidateOverview"
              :disabled="isBusy"
              @click="refreshPageOverview"
            >
              刷新页面数据
            </el-button>
          </el-space>

          <el-alert
            v-if="settingsWarnings.length"
            type="warning"
            :closable="false"
            show-icon
            :title="settingsWarnings.join('；')"
          />

          <el-alert
            v-if="runError"
            :title="runError.message"
            :description="runError.details"
            type="error"
            :closable="false"
            show-icon
          />

          <el-alert
            v-if="candidateOverviewError"
            :title="candidateOverviewError.message"
            :description="candidateOverviewError.details"
            type="warning"
            :closable="false"
            show-icon
          />

          <div class="page-overview-bar">
            <el-tag :type="candidateOverviewTagType" effect="plain">
              {{ candidateOverviewLabel }}
            </el-tag>
            <span class="page-overview-bar__text">{{ candidateOverview.changeDescription }}</span>
          </div>

          <el-progress
            :percentage="progressRate"
            :status="runState === 'failed' ? 'exception' : runState === 'succeeded' ? 'success' : undefined"
            :stroke-width="10"
          />

          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="页面候选人数">
              {{ candidateOverview.total }}
            </el-descriptions-item>
            <el-descriptions-item label="最近刷新">
              {{ candidateOverviewLoadedAtLabel }}
            </el-descriptions-item>
            <el-descriptions-item label="页面数据状态">
              {{ candidateOverviewLabel }}
            </el-descriptions-item>
            <el-descriptions-item label="候选人预览">
              {{ candidatePreviewLabel }}
            </el-descriptions-item>
            <el-descriptions-item label="执行目标数">{{ progress.total }}</el-descriptions-item>
            <el-descriptions-item label="已处理">{{ progress.processed }}</el-descriptions-item>
            <el-descriptions-item label="成功/跳过">{{ progress.succeeded }}</el-descriptions-item>
            <el-descriptions-item label="失败">{{ progress.failed }}</el-descriptions-item>
            <el-descriptions-item label="当前处理">
              {{ progress.currentCandidateName || '暂无' }}
            </el-descriptions-item>
          </el-descriptions>

          <div class="section-title-row">
            <span class="section-title">当前页面候选人数据</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <el-tag size="small" effect="plain">{{ pageCandidates.length }} 条</el-tag>
              <el-tooltip :content="settings.advanced.exportMode === 'processed' ? '导出 LLM 已处理的候选人' : '导出全部候选人'" placement="top">
                <el-button
                  :icon="Download"
                  size="small"
                  plain
                  :disabled="!pageCandidates.length"
                  @click="handleExport"
                >
                  导出 XLSX
                </el-button>
              </el-tooltip>
            </div>
          </div>

          <div v-if="pageCandidates.length" class="candidate-result-summary">
            <el-tag type="success" effect="plain" size="small">
              推荐跟进 {{ candidateResultSummary.recommended }}
            </el-tag>
            <el-tag type="info" effect="plain" size="small">
              暂不跟进 {{ candidateResultSummary.notRecommended }}
            </el-tag>
            <el-tag type="warning" effect="plain" size="small">
              待处理 {{ candidateResultSummary.pending }}
            </el-tag>
          </div>

          <el-table
            :data="pageCandidates"
            size="small"
            max-height="320"
            :empty-text="pageCandidatesEmptyText"
          >
            <el-table-column label="#" width="42">
              <template #default="scope">
                {{ scope.row.index + 1 }}
              </template>
            </el-table-column>
            <el-table-column prop="name" label="候选人" min-width="80" />
            <el-table-column prop="previewText" label="摘要" min-width="120" show-overflow-tooltip />
            <el-table-column label="AI 结果" min-width="90">
              <template #default="scope">
                <template v-if="candidateResults.get(buildCandidateKey(scope.row.name, scope.row.previewText))">
                  <el-tag
                    :type="candidateResults.get(buildCandidateKey(scope.row.name, scope.row.previewText))!.shouldFavorite ? 'success' : 'info'"
                    size="small"
                    effect="plain"
                  >
                    {{ candidateResults.get(buildCandidateKey(scope.row.name, scope.row.previewText))!.shouldFavorite ? '推荐' : '跳过' }}
                  </el-tag>
                </template>
                <span v-else class="candidate-pending-label">待处理</span>
              </template>
            </el-table-column>
            <el-table-column label="理由" min-width="160" show-overflow-tooltip>
              <template #default="scope">
                {{ candidateResults.get(buildCandidateKey(scope.row.name, scope.row.previewText))?.reason ?? '—' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="64" fixed="right">
              <template #default="scope">
                <el-button
                  size="small"
                  :loading="singleProcessingKeys.has(buildCandidateKey(scope.row.name, scope.row.previewText))"
                  :disabled="isBusy"
                  @click="processSingleCandidate(scope.row)"
                >
                  处理
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="section-title-row">
            <span class="section-title">自动处理记录</span>
            <el-tag size="small" effect="plain">{{ progress.records.length }} 条</el-tag>
          </div>

          <el-table :data="progress.records" size="small" max-height="320">
            <el-table-column prop="candidate.name" label="候选人" min-width="140" />
            <el-table-column label="结果" width="90">
              <template #default="scope">
                {{ getCandidateStatusLabel(scope.row.status) }}
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="说明" min-width="220" show-overflow-tooltip />
          </el-table>
        </el-space>
      </el-card>
    </div>

    <ExtensionSettingsPanel
      v-model="settingsVisible"
      :settings="settings"
      :saving="settingsSaving"
      @save="handleSaveSettings"
    />

    <el-dialog
      v-model="diagnosticVisible"
      title="数据读取能力诊断"
      width="600px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <div class="diagnostic-panel">
        <el-alert
          title="诊断说明"
          type="info"
          :closable="false"
          description="此诊断工具用于排查数据读取能力。会测试当前浏览器标签页是否允许脚本注入读取 DOM 数据。"
          show-icon
        />

        <el-button
          type="primary"
          :loading="diagnosticRunning"
          @click="runDiagnostic"
        >
          开始诊断
        </el-button>

        <el-scrollbar v-if="diagnosticOutput" max-height="300">
          <pre class="diagnostic-output">{{ diagnosticOutput }}</pre>
        </el-scrollbar>

        <div v-if="diagnosticResult" class="diagnostic-summary">
          <el-statistic label="候选人读取" :value="diagnosticResult.candidateCount" />
          <el-statistic
            label="权限状态"
            :value="diagnosticResult.hostPermissionOk ? '已授予' : '未授予'"
          />
        </div>
      </div>

      <template #footer>
        <el-button @click="diagnosticVisible = false">关闭</el-button>
      </template>
    </el-dialog>

  </ExtensionAppShell>
</template>

<style scoped>
.popup-layout {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel-card {
  border-radius: 14px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
}

:deep(.el-card__header) {
  padding-bottom: 12px;
}

.page-overview-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.page-overview-bar__text {
  color: #64748b;
  font-size: 12px;
}

.candidate-result-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 0 2px;
}

.candidate-pending-label {
  color: #94a3b8;
  font-size: 12px;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}

.header-indicators {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid #dbe5f0;
  border-radius: 999px;
  background: #fff;
  color: #475569;
}

.status-indicator__icon {
  font-size: 14px;
}

.status-indicator__light {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
  box-shadow: 0 0 0 2px rgba(148, 163, 184, 0.15);
}

.status-indicator__light.is-green {
  background: #22c55e;
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
}

.status-indicator__light.is-red {
  background: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
}

.diagnostic-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diagnostic-output {
  background: #f5f7fa;
  border: 1px solid #dbe5f0;
  border-radius: 4px;
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
  color: #475569;
  margin: 12px 0;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
}

.diagnostic-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  background: #f0f9ff;
  border-radius: 4px;
}

</style>
