<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';
import { checkBffConnectivity } from '../agent/agentClient';
import { listPersistedGrants, revokeDomainGrants } from '../agent/approvalGate';
import { addAllowRule, loadAllowRules, removeAllowRule } from '../services/permissionService';
import type { UrlAllowRule } from '../services/urlAllowlist';
import { clearAllFiles } from '../services/exportService';
import { ElMessage, ElMessageBox } from 'element-plus';

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

// ── 写操作白名单 ────────────────────────────────────────────────

const allowRules = ref<UrlAllowRule[]>([]);
const newRule = reactive<{ domain: string; pathPrefix: string }>({ domain: '', pathPrefix: '' });
const addingRule = ref(false);
const ruleFeedback = ref<{ ok: boolean; message: string } | null>(null);
const currentHost = ref('');
const grantEntries = ref<Array<{ domain: string; tools: string[] }>>([]);

async function refreshAllowState(): Promise<void> {
  allowRules.value = await loadAllowRules();
  const grants = await listPersistedGrants();
  grantEntries.value = Object.entries(grants).map(([domain, tools]) => ({ domain, tools }));
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    currentHost.value = tab?.url ? new URL(tab.url).hostname : '';
  } catch {
    currentHost.value = '';
  }
}

function useCurrentHost(): void {
  newRule.domain = currentHost.value;
}

/** 添加规则。权限申请必须由用户手势触发，所以只能从这个点击事件里发起。 */
async function handleAddRule(): Promise<void> {
  addingRule.value = true;
  ruleFeedback.value = null;
  try {
    const rule: UrlAllowRule = {
      domain: newRule.domain.trim(),
      ...(newRule.pathPrefix.trim() ? { pathPrefix: newRule.pathPrefix.trim() } : {}),
    };
    const result = await addAllowRule(rule);
    ruleFeedback.value = result;
    if (result.ok) {
      newRule.domain = '';
      newRule.pathPrefix = '';
      await refreshAllowState();
    }
  } finally {
    addingRule.value = false;
  }
}

async function handleRemoveRule(index: number): Promise<void> {
  await removeAllowRule(index);
  await refreshAllowState();
}

async function handleRevoke(domain: string): Promise<void> {
  await revokeDomainGrants(domain);
  await refreshAllowState();
}

// 抽屉每次打开都刷新：权限与授权可能在别处被改过。
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) void refreshAllowState();
  },
  { immediate: true },
);

watch(
  () => props.settings,
  (value) => {
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

const clearingFiles = ref(false);
async function handleClearFiles() {
  try {
    await ElMessageBox.confirm(
      '将删除所有通过 agent 生成、截图或上传的文件（含 IndexedDB 中跨会话保存的文件）。此操作不可恢复。',
      '清空所有文件',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  clearingFiles.value = true;
  try {
    await clearAllFiles();
    ElMessage.success('已清空所有文件');
  } finally {
    clearingFiles.value = false;
  }
}
</script>

<template>
  <el-drawer v-model="panelVisible" title="设置中心" size="92%" destroy-on-close>
    <el-space direction="vertical" fill :size="16">
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
          <el-form-item label="任务最大步数">
            <el-input-number
              v-model="form.advanced.maxSteps"
              :min="5"
              :max="200"
              :step="5"
              controls-position="right"
            />
            <el-text type="info" size="small" style="margin-left: 8px;">
              防止模型无限循环，中等复杂度建议 50-80
            </el-text>
          </el-form-item>
          <el-form-item label="LLM 重试次数">
            <el-input-number
              v-model="form.advanced.llmMaxRetries"
              :min="0"
              :max="5"
              :step="1"
              controls-position="right"
            />
            <el-text type="info" size="small" style="margin-left: 8px;">
              网络错误与 5xx 自动重试，4xx 不重试
            </el-text>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 允许操作的页面：白名单是「防止过于自由」的主要闸门 -->
      <el-card shadow="never">
        <template #header>
          <div class="settings-header">
            <el-text tag="b">允许操作的页面</el-text>
            <el-tag type="danger" effect="plain">写操作白名单</el-tag>
          </div>
        </template>

        <el-space direction="vertical" fill :size="12" style="width: 100%">
          <el-alert type="info" :closable="false" show-icon>
            只有列在这里的页面才允许执行点击、输入等写操作。添加域名时浏览器会请求该站点的访问权限。
            留空表示不允许任何写操作。
          </el-alert>

          <el-table v-if="allowRules.length" :data="allowRules" size="small" border>
            <el-table-column prop="domain" label="域名" min-width="140" show-overflow-tooltip />
            <el-table-column label="路径限制" min-width="120" show-overflow-tooltip>
              <template #default="scope">
                {{ scope.row.pathPrefix || scope.row.pathPattern || '(不限)' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70">
              <template #default="scope">
                <el-button link type="danger" size="small" @click="handleRemoveRule(scope.$index)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-text v-else type="info" size="small">尚未添加任何域名，写操作会全部被拒绝。</el-text>

          <el-form label-position="top">
            <el-form-item label="域名">
              <el-input v-model="newRule.domain" placeholder="例如 example.com 或 *.example.com">
                <template #append>
                  <el-button :disabled="!currentHost" @click="useCurrentHost">用当前站点</el-button>
                </template>
              </el-input>
            </el-form-item>
            <el-form-item label="路径前缀（可选）">
              <el-input v-model="newRule.pathPrefix" placeholder="例如 /search，留空表示不限路径" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="addingRule" @click="handleAddRule">添加并授权</el-button>
            </el-form-item>
          </el-form>

          <el-alert
            v-if="ruleFeedback"
            :type="ruleFeedback.ok ? 'success' : 'error'"
            :closable="false"
            show-icon
            :title="ruleFeedback.message"
          />
        </el-space>
      </el-card>

      <!-- 已授权的免审批动作：让用户能看到并撤销「永久允许」 -->
      <el-card v-if="grantEntries.length" shadow="never">
        <template #header>
          <div class="settings-header">
            <el-text tag="b">免审批授权</el-text>
            <el-tag type="warning" effect="plain">{{ grantEntries.length }} 个域名</el-tag>
          </div>
        </template>
        <el-space direction="vertical" fill :size="8" style="width: 100%">
          <div v-for="entry in grantEntries" :key="entry.domain" class="grant-row">
            <div>
              <el-text size="small" tag="b">{{ entry.domain }}</el-text>
              <el-text size="small" type="info" style="display: block">{{ entry.tools.join('、') }}</el-text>
            </div>
            <el-button link type="danger" size="small" @click="handleRevoke(entry.domain)">撤销</el-button>
          </div>
        </el-space>
      </el-card>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="提示：任务运行期间目标标签页顶部会出现「正在被调试」提示条。手动关闭它会中止当前任务。"
      />

      <el-card shadow="never">
        <template #header>
          <el-text tag="b">存储</el-text>
        </template>
        <el-space>
          <el-button type="danger" plain :loading="clearingFiles" @click="handleClearFiles">
            清空所有文件与截图
          </el-button>
          <el-text type="info" size="small">删除 IndexedDB 中保存的全部 agent 生成文件、截图和上传文件。</el-text>
        </el-space>
      </el-card>

      <el-button type="primary" :loading="saving" @click="onSave">保存设置</el-button>
    </el-space>
  </el-drawer>
</template>

<style scoped>
.grant-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
}

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
