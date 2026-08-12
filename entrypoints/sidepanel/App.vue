<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Collection, Setting, Tickets } from '@element-plus/icons-vue';
import ExtensionAppShell from '../../src/components/ExtensionAppShell.vue';
import ExtensionSettingsPanel from '../../src/components/ExtensionSettingsPanel.vue';
import FreeFormPanel from '../../src/components/FreeFormPanel.vue';
import SkillPanel from '../../src/components/SkillPanel.vue';
import { runDiagnostics, formatDiagnosticResult } from '../../src/services/diagnosticService';
import type { DiagnosticResult } from '../../src/services/diagnosticService';
import { settingsService } from '../../src/services/settingsService';
import type { AppSettings } from '../../src/types/settings';
import type { Skill } from '../../src/services/skillStore';

const loaded = settingsService.load();
const settings = ref<AppSettings>(loaded.normalized);
const settingsWarnings = ref<string[]>(loaded.issues);
const settingsVisible = ref(false);
const settingsSaving = ref(false);

const diagnosticVisible = ref(false);
const diagnosticRunning = ref(false);
const diagnosticResult = ref<DiagnosticResult | null>(null);
const diagnosticOutput = ref('');

const skillPanelVisible = ref(false);

/** 技能应用回调：预填指令到自由指令面板。通过 ref 传递。 */
const skillToApply = ref<Skill | null>(null);

function handleApplySkill(skill: Skill) {
  skillToApply.value = skill;
}

/** BFF 是否已配置。未配置时自由指令无法执行，需要在壳层就提示。 */
const bffConfigured = computed(
  () => Boolean(settings.value.advanced.bffBaseUrl) && Boolean(settings.value.advanced.bffApiToken),
);

const statusMessage = computed(() =>
  bffConfigured.value
    ? '在允许的页面上用一句话描述你想做的事，agent 会自行规划并执行。'
    : '请先在设置中配置 BFF 地址与接入 token。',
);

const statusType = computed(() => (bffConfigured.value ? 'info' : 'warning'));

const settingsSaved = ref(0);

function handleSaveSettings(next: AppSettings) {
  settingsSaving.value = true;
  try {
    const saved = settingsService.save(next);
    settings.value = saved.normalized;
    settingsWarnings.value = saved.issues;
    if (saved.valid) {
      ElMessage.success('设置已保存');
      settingsVisible.value = false;
      settingsSaved.value++;
    } else {
      ElMessage.warning(saved.issues.join('；'));
    }
  } finally {
    settingsSaving.value = false;
  }
}

async function runDiagnostic() {
  diagnosticRunning.value = true;
  diagnosticOutput.value = '';
  try {
    const result = await runDiagnostics();
    diagnosticResult.value = result;
    diagnosticOutput.value = formatDiagnosticResult(result);
  } catch (error) {
    diagnosticOutput.value = `诊断执行失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    diagnosticRunning.value = false;
  }
}

onMounted(() => {
  if (settingsWarnings.value.length) ElMessage.warning(settingsWarnings.value.join('；'));
});
</script>

<template>
  <ExtensionAppShell
    title="浏览器 AI 助手"
    description="用自然语言指令驱动网页操作"
    :status-message="statusMessage"
    :status-type="statusType"
  >
    <template #header-actions>
      <div class="header-indicators">
        <el-tooltip content="技能管理" placement="bottom">
          <el-button :icon="Collection" circle plain @click="skillPanelVisible = true" />
        </el-tooltip>
        <el-tooltip content="打开设置" placement="bottom">
          <el-button :icon="Setting" circle plain @click="settingsVisible = true" />
        </el-tooltip>

        <el-tooltip content="诊断页面操作能力" placement="bottom">
          <el-button :icon="Tickets" circle plain @click="diagnosticVisible = true" />
        </el-tooltip>
      </div>
    </template>

    <div class="popup-layout">
      <el-alert
        v-if="!bffConfigured"
        type="warning"
        :closable="false"
        show-icon
        title="尚未配置 BFF"
        description="模型凭据由 BFF 持有，扩展不保存。请在设置中填写 BFF 地址与接入 token。"
      />

      <FreeFormPanel :skill-to-apply="skillToApply" :settings-saved="settingsSaved" @skill-applied="skillToApply = null" />

      <SkillPanel v-model="skillPanelVisible" @apply="handleApplySkill" />
    </div>

    <ExtensionSettingsPanel
      v-model="settingsVisible"
      :settings="settings"
      :saving="settingsSaving"
      @save="handleSaveSettings"
    />

    <el-dialog
      v-model="diagnosticVisible"
      title="页面操作能力诊断"
      width="90%"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <div class="diagnostic-panel">
        <el-alert
          title="诊断说明"
          type="info"
          :closable="false"
          description="检查 debugger 权限、调试会话占用情况与 content script 是否就绪。页面操作依赖这三项。"
          show-icon
        />

        <el-button type="primary" :loading="diagnosticRunning" @click="runDiagnostic">开始诊断</el-button>

        <el-scrollbar v-if="diagnosticOutput" max-height="320">
          <pre class="diagnostic-output">{{ diagnosticOutput }}</pre>
        </el-scrollbar>
      </div>
    </el-dialog>
  </ExtensionAppShell>
</template>

<style scoped>
.popup-layout {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.header-indicators {
  display: flex;
  align-items: center;
  gap: 8px;
}

.diagnostic-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diagnostic-output {
  margin: 0;
  padding: 10px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
