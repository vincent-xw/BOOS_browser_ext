<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';
import { checkBffConnectivity } from '../agent/agentClient';

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

const checkingConnectivity = ref(false);
const connectivityResult = ref<{ ok: boolean; message: string } | null>(null);

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

/** 连通性检查。区分「地址不可达」与「凭据无效」，两者的处置完全不同。 */
async function handleCheckConnectivity() {
  checkingConnectivity.value = true;
  connectivityResult.value = null;
  try {
    const result = await checkBffConnectivity({
      baseUrl: form.advanced.bffBaseUrl,
      apiToken: form.advanced.bffApiToken,
    });
    connectivityResult.value = { ok: result.ok, message: result.message };
  } finally {
    checkingConnectivity.value = false;
  }
}

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
              placeholder="例如：li.card-item 或 .card-item（也支持直接填 card-item）"
            />
          </el-form-item>
          <el-form-item label="候选人姓名选择器">
            <el-input
              v-model="form.basic.candidateNameSelector"
              placeholder="例如：.name（也支持直接填 name）"
            />
          </el-form-item>
          <el-form-item label="在线简历容器选择器">
            <el-input
              v-model="form.basic.resumeContainerSelector"
              placeholder="例如：#resume（也支持直接填 resume）"
            />
          </el-form-item>
          <el-form-item label="收藏按钮选择器">
            <el-input
              v-model="form.basic.favoriteButtonSelector"
              placeholder="例如：.like-icon-and-text（也支持直接填 like-icon-and-text）"
            />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header>
          <div class="settings-header">
            <el-text tag="b">高级设置</el-text>
            <el-tag type="warning" effect="plain">BFF 接入配置</el-tag>
          </div>
        </template>

        <el-form label-position="top">
          <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
            模型 Endpoint、模型名与 API Key 由 BFF 持有，扩展不再保存这些配置。
            下面的接入 token 不是 LLM API Key。
          </el-alert>
          <el-form-item label="BFF 地址">
            <el-input v-model="form.advanced.bffBaseUrl" placeholder="例如：http://localhost:8787" />
          </el-form-item>
          <el-form-item label="BFF 接入 token">
            <el-input
              v-model="form.advanced.bffApiToken"
              type="password"
              show-password
              placeholder="与 BFF 的 BFF_API_TOKEN 一致"
            />
          </el-form-item>
          <el-form-item label="连通性检查">
            <div class="connectivity-row">
              <el-button :loading="checkingConnectivity" @click="handleCheckConnectivity">检查 BFF 连通性</el-button>
              <el-tag v-if="connectivityResult" :type="connectivityResult.ok ? 'success' : 'danger'" effect="plain">
                {{ connectivityResult.message }}
              </el-tag>
            </div>
          </el-form-item>
          <el-form-item label="BFF 请求超时（毫秒）">
            <el-input-number
              v-model="form.advanced.bffRequestTimeoutMs"
              :min="5000"
              :max="300000"
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
          <el-form-item label="导出模式">
            <el-select v-model="form.advanced.exportMode" style="width: 100%">
              <el-option label="仅导出 LLM 已处理候选人（默认）" value="processed" />
              <el-option label="导出全部候选人（包括未处理）" value="all" />
            </el-select>
          </el-form-item>
          <el-form-item label="单批处理条数">
            <el-input-number
              v-model="form.advanced.batchSize"
              :min="1"
              :max="100"
              :step="1"
              controls-position="right"
            />
            <el-text type="info" size="small" style="margin-top: 4px; display: block;">
              「开始自动处理」每批向 LLM 提交的候选人数量，默认 10
            </el-text>
          </el-form-item>
        </el-form>
      </el-card>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="提示：任务运行期间目标标签页顶部会出现「正在被调试」提示条。手动关闭它会中止当前任务。"
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

.connectivity-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
