<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';

const props = defineProps<{
  modelValue: boolean;
  settings: AppSettings;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'save', value: AppSettings): void;
}>();

const form = reactive<AppSettings>(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings);

watch(
  () => props.settings,
  (value) => {
    Object.assign(form.basic, value.basic);
    Object.assign(form.advanced, value.advanced);
  },
  { immediate: true, deep: true },
);

const panelVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

function onSave() {
  emit('save', JSON.parse(JSON.stringify(form)) as AppSettings);
}
</script>

<template>
  <el-drawer v-model="panelVisible" title="设置中心" size="92%" destroy-on-close>
    <el-space direction="vertical" fill :size="16">
      <el-card shadow="never">
        <template #header>
          <div class="settings-header">
            <el-text tag="b">基础设置</el-text>
            <el-tag type="info" effect="plain">站点与页面选择器</el-tag>
          </div>
        </template>

        <el-form label-position="top">
          <el-form-item label="目标域名">
            <el-input v-model="form.basic.targetDomain" placeholder="例如：www.zhipin.com" />
          </el-form-item>
          <el-form-item label="候选人列表项选择器">
            <el-input
              v-model="form.basic.candidateListItemSelector"
              placeholder="例如：.candidate-item"
            />
          </el-form-item>
          <el-form-item label="候选人姓名选择器">
            <el-input v-model="form.basic.candidateNameSelector" placeholder="例如：.name" />
          </el-form-item>
          <el-form-item label="在线简历容器选择器">
            <el-input
              v-model="form.basic.resumeContainerSelector"
              placeholder="例如：.resume-detail-wrap"
            />
          </el-form-item>
          <el-form-item label="收藏按钮选择器">
            <el-input
              v-model="form.basic.favoriteButtonSelector"
              placeholder="例如：.btn-collect"
            />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header>
          <div class="settings-header">
            <el-text tag="b">高级设置</el-text>
            <el-tag type="warning" effect="plain">模型 API 配置</el-tag>
          </div>
        </template>

        <el-form label-position="top">
          <el-form-item label="LLM API Endpoint">
            <el-input
              v-model="form.advanced.llmApiEndpoint"
              placeholder="例如：https://api.openai.com/v1/chat/completions"
            />
          </el-form-item>
          <el-form-item label="LLM API Key">
            <el-input
              v-model="form.advanced.llmApiKey"
              type="password"
              show-password
              placeholder="输入你的 API Key"
            />
          </el-form-item>
          <el-form-item label="模型名称">
            <el-input v-model="form.advanced.llmModel" placeholder="例如：gpt-4o-mini" />
          </el-form-item>
          <el-form-item label="LLM 请求超时（毫秒）">
            <el-input-number
              v-model="form.advanced.llmRequestTimeoutMs"
              :min="5000"
              :max="120000"
              :step="1000"
              controls-position="right"
            />
          </el-form-item>
          <el-form-item label="单候选人处理超时（毫秒）">
            <el-input-number
              v-model="form.advanced.perCandidateTimeoutMs"
              :min="10000"
              :max="180000"
              :step="1000"
              controls-position="right"
            />
          </el-form-item>
        </el-form>
      </el-card>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="提示：当前 API Key 保存于 localStorage，请仅在可信环境中使用。"
      />

      <el-button type="primary" :loading="saving" @click="onSave">保存设置</el-button>
    </el-space>
  </el-drawer>
</template>

<style scoped>
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
