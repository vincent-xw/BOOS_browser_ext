<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import ExtensionAppShell from '../../src/components/ExtensionAppShell.vue';
import ExtensionSettingsPanel from '../../src/components/ExtensionSettingsPanel.vue';
import { usePageIoController } from '../../src/composables/usePageIoController';
import { ref } from 'vue';

const {
  runState,
  runError,
  promptText,
  progress,
  settings,
  settingsWarnings,
  domainStatus,
  currentDomain,
  isBusy,
  overallMessage,
  overallMessageType,
  providerLabel,
  modeLabel,
  saveSettings,
  checkDomainMatch,
  handleRunWorkflow,
} = usePageIoController();

const settingsVisible = ref(false);
const settingsSaving = ref(false);

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
  } finally {
    settingsSaving.value = false;
  }
}

async function handleCheckSite() {
  const matched = await checkDomainMatch();
  if (matched) {
    ElMessage.success('当前页面域名匹配配置，可执行自动处理。');
    return;
  }

  ElMessage.warning('当前页面域名不匹配，请检查基础设置中的目标域名。');
}
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
      <el-button size="small" plain @click="settingsVisible = true">设置</el-button>
    </template>

    <div class="popup-layout">
      <el-card class="panel-card" shadow="never">
        <template #header>
          <div class="panel-header">
            <span>自动收藏执行面板</span>
            <el-tag :type="runTagType" effect="plain">{{ runState }}</el-tag>
          </div>
        </template>

        <el-space direction="vertical" fill :size="12">
          <el-input
            v-model="promptText"
            type="textarea"
            :rows="6"
            resize="none"
            placeholder="请输入用于评估候选人的 Prompt（例如：优先收藏 3 年以上 Java 后端经验、近两年稳定性高的候选人）"
          />

          <el-space wrap>
            <el-button :disabled="isBusy" @click="handleCheckSite">检测当前站点</el-button>
            <el-button
              type="primary"
              :loading="runState === 'running'"
              :disabled="!promptText.trim()"
              @click="handleRunWorkflow"
            >
              开始自动处理
            </el-button>
          </el-space>

          <el-space wrap>
            <el-tag :type="domainTagType" effect="plain">{{ domainLabel }}</el-tag>
            <el-tag type="info" effect="plain">目标域名：{{ settings.basic.targetDomain }}</el-tag>
            <el-tag type="warning" effect="plain">当前模式：{{ modeLabel }}</el-tag>
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

          <el-progress
            :percentage="progressRate"
            :status="runState === 'failed' ? 'exception' : runState === 'succeeded' ? 'success' : undefined"
            :stroke-width="10"
          />

          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="总候选人数">{{ progress.total }}</el-descriptions-item>
            <el-descriptions-item label="已处理">{{ progress.processed }}</el-descriptions-item>
            <el-descriptions-item label="成功/跳过">{{ progress.succeeded }}</el-descriptions-item>
            <el-descriptions-item label="失败">{{ progress.failed }}</el-descriptions-item>
            <el-descriptions-item label="当前处理">
              {{ progress.currentCandidateName || '暂无' }}
            </el-descriptions-item>
          </el-descriptions>

          <el-table :data="progress.records" size="small" max-height="220">
            <el-table-column prop="candidate.name" label="候选人" min-width="140" />
            <el-table-column prop="status" label="结果" width="90" />
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
</style>
