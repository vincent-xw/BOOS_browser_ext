<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowDown, Delete, QuestionFilled, Star } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useFreeFormController } from '../composables/useFreeFormController';
import type { GrantScope } from '../agent/approvalGate';
import { TOOLS_CATALOG } from '../services/toolsCatalog';
import { useSkillController } from '../composables/useSkillController';
import type { Skill } from '../services/skillStore';

const props = defineProps<{ skillToApply?: Skill | null }>();
const emit = defineEmits<{ (event: 'skillApplied'): void; (event: 'saveSkill'): void }>();

const {
  runState,
  runError,
  instruction,
  turns,
  currentSteps,
  sessions,
  sessionId,
  currentUrl,
  currentTitle,
  urlAllowed,
  urlAllowReason,
  hostPermissionOk,
  requestingPermission,
  requestHostPermission,
  pendingApproval,
  isBusy,
  canSubmit,
  approve,
  deny,
  submitInstruction,
  stop,
  startNewSession,
  switchSession,
  removeSession,
  refreshSessions,
  refreshPageContext,
} = useFreeFormController();

const { saveFromTurns } = useSkillController();

/** 工具说明面板是否展开。 */
const toolsHelpVisible = ref(false);
const ONBOARDING_KEY = 'boos.onboarding.toolsHelpSeen';

onMounted(() => {
  void refreshPageContext();
  void refreshSessions();
  // 首次使用自动弹出工具说明。
  void chrome.storage.local.get(ONBOARDING_KEY).then((stored) => {
    if (!stored[ONBOARDING_KEY]) {
      toolsHelpVisible.value = true;
      void chrome.storage.local.set({ [ONBOARDING_KEY]: true });
    }
  });
  // 监听标签页导航与切换：页面跳到其他域名/子域时，host 权限可能失效，需要主动提示授权。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') void refreshPageContext();
  });
  chrome.tabs.onActivated.addListener(() => {
    void refreshPageContext();
  });
});

async function handleRequestHostPermission() {
  const result = await requestHostPermission();
  if (result.ok) {
    ElMessage.success(result.message);
  } else {
    ElMessage.warning(result.message);
  }
}

/** 监听技能应用：新会话 + 预填指令，不自动执行。 */
watch(
  () => props.skillToApply,
  (skill) => {
    if (!skill) return;
    startNewSession();
    instruction.value = skill.firstInstruction;
    emit('skillApplied');
    ElMessage.info(`已加载技能「${skill.name}」，确认后执行`);
  },
);

/** 保存当前会话为技能。 */
async function handleSaveSkill() {
  const result = await saveFromTurns(turns.value);
  if (result.ok) {
    ElMessage.success(result.message);
  } else {
    ElMessage.warning(result.message);
  }
}

/** 是否可保存为技能：至少有一轮对话。 */
const canSaveSkill = computed(() => turns.value.length > 0 && !isBusy.value);

/**
 * 把长 URL 压缩成「主域名 + 关键 path」形式，避免长 URL 挤崩布局。
 * 例如 https://example.com/a/b/c/d?x=1 -> example.com/a/b/c/d
 */
const shortUrl = computed(() => {
  if (!currentUrl.value) return '';
  try {
    const url = new URL(currentUrl.value);
    const host = url.host;
    // 只保留有意义的 path 段，去掉尾部空段；query/hash 不展示（太长且对操作无意义）。
    const path = url.pathname.replace(/\/+$/, '');
    const full = path ? `${host}${path}` : host;
    // 仍可能很长（路径深），超过 40 字截断。
    return full.length > 40 ? `${full.slice(0, 40)}…` : full;
  } catch {
    return currentUrl.value.length > 40 ? `${currentUrl.value.slice(0, 40)}…` : currentUrl.value;
  }
});

/** 审批档位。域名级授权带上当前域名，让用户清楚授权范围。 */
function currentHost(): string {
  try {
    return new URL(currentUrl.value).hostname;
  } catch {
    return '当前域名';
  }
}

function onApprove(scope: GrantScope) {
  approve(scope);
}

/** 当前会话在列表中的序号（1 起）。用于按钮文案。 */
const sessionIndex = computed(() => {
  const index = sessions.value.findIndex((session) => session.id === sessionId.value);
  return index >= 0 ? index + 1 : sessions.value.length + 1;
});

function handleSessionCommand(command: string | number | object) {
  if (command === '__new__') {
    startNewSession();
    return;
  }
  if (typeof command === 'string') void switchSession(command);
}

function handleDeleteSession(id: string) {
  void removeSession(id);
}

/**
 * 步骤输出的简短摘要。失败与被拒的步骤要能一眼看出。
 * 优先使用 humanizeStepOutput 注入的 humanText，不暴露错误码。
 */
function stepSummary(output: unknown): { text: string; type: 'success' | 'warning' | 'danger' } {
  const record = (output ?? {}) as Record<string, unknown>;
  if (typeof record.humanText === 'string') {
    const reason = typeof record.reason === 'string' && record.reason ? `：${record.reason}` : '';
    return { text: `${record.humanText}${reason}`.slice(0, 80), type: record.code === 'USER_DENIED' ? 'warning' : 'danger' };
  }
  if (record.ok === false) return { text: String(record.message ?? '失败').slice(0, 60), type: 'danger' };
  if (Array.isArray(record.entries)) return { text: `快照 ${record.entries.length} 个元素`, type: 'success' };
  if (record.passed === true) return { text: '验证通过', type: 'success' };
  if (record.passed === false) return { text: '验证未通过', type: 'danger' };
  return { text: String(record.message ?? '完成').slice(0, 60), type: 'success' };
}
</script>

<template>
  <el-card shadow="never">
    <template #header>
      <div class="panel-header">
        <div class="title-row">
          <el-text tag="b">自由指令</el-text>
          <!-- 工具能力说明：popup 浮层，点击 ? 触发；首次自动弹出由 v-model 控制 -->
          <el-popover
            v-model:visible="toolsHelpVisible"
            placement="bottom-start"
            :width="320"
            trigger="click"
            popper-class="tools-help-popover"
          >
            <template #reference>
              <el-tooltip content="查看可用工具与操作边界" placement="bottom">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </template>
            <div class="tools-help">
              <el-text size="small" type="info">
                你的指令会触发以下工具。读操作自动执行，写操作需要你逐个批准。
              </el-text>
              <div v-for="tool in TOOLS_CATALOG" :key="tool.name" class="tool-item">
                <div class="tool-header">
                  <el-text size="small" tag="b">{{ tool.title }}</el-text>
                  <el-tag size="small" :type="tool.category === 'write' ? 'warning' : 'info'" effect="plain">
                    {{ tool.category === 'write' ? '写' : '读' }}
                  </el-tag>
                </div>
                <el-text size="small" type="info">{{ tool.description }}</el-text>
              </div>
            </div>
          </el-popover>
        </div>
        <el-space>
          <el-tag :type="urlAllowed ? 'success' : 'warning'" effect="plain" size="small">
            {{ urlAllowed ? '当前页面已允许' : '当前页面未允许' }}
          </el-tag>
          <!-- 会话列表：切回旧会话继续多轮上下文。sessionId 是 BFF 侧历史的钥匙。 -->
          <el-dropdown v-if="sessions.length" trigger="click" @command="handleSessionCommand">
            <el-button link size="small" :disabled="isBusy">
              会话 {{ sessionIndex }}
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="(session, index) in sessions"
                  :key="session.id"
                  :command="session.id"
                  :disabled="session.id === sessionId"
                >
                  <span class="session-item">
                    <span class="session-title">{{ session.title }}</span>
                    <el-icon class="session-delete" @click.stop="handleDeleteSession(session.id)"><Delete /></el-icon>
                  </span>
                </el-dropdown-item>
                <el-dropdown-item divided :command="'__new__'" :disabled="isBusy">＋ 新会话</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button v-else link size="small" :disabled="isBusy" @click="startNewSession">新会话</el-button>
          <el-button link size="small" @click="refreshPageContext">刷新</el-button>
        </el-space>
      </div>
    </template>

    <el-space direction="vertical" fill :size="12" style="width: 100%">
      <!-- host 权限缺失：没有它 content script 注入与 CDP 都失败，任务会在中途断掉，必须先授权 -->
      <el-alert
        v-if="currentUrl && !hostPermissionOk"
        type="error"
        :closable="false"
        show-icon
        title="当前页面未授权"
      >
        <div class="permission-alert">
          <span>扩展没有当前页面的访问权限，继续操作会在执行中失败。</span>
          <el-button size="small" type="primary" :loading="requestingPermission" @click="handleRequestHostPermission">
            授权访问
          </el-button>
        </div>
      </el-alert>

      <el-alert v-if="!urlAllowed" type="warning" :closable="false" show-icon :title="urlAllowReason">
        读取与快照仍可进行，但写操作会被拒绝。请在设置中把该域名加入白名单。
      </el-alert>

      <div class="page-context">
        <el-text size="small" type="info" truncated>{{ currentTitle || '(未获取页面标题)' }}</el-text>
        <el-tooltip v-if="currentUrl" :content="currentUrl" placement="top">
          <el-text size="small" type="info" class="url-text">{{ shortUrl }}</el-text>
        </el-tooltip>
      </div>

      <!-- 对话记录：多轮上下文让「点第三条结果」这类指代成立 -->
      <div v-if="turns.length" class="conversation">
        <div v-for="(turn, index) in turns" :key="index" :class="['turn', `turn-${turn.role}`]">
          <el-text size="small" tag="b">{{ turn.role === 'user' ? '你' : turn.role === 'agent' ? 'Agent' : '错误' }}</el-text>
          <div class="turn-text">{{ turn.text }}</div>
          <el-collapse v-if="turn.steps?.length" class="turn-steps">
            <el-collapse-item :title="`执行了 ${turn.steps.length} 步`" :name="index">
              <div v-for="step in turn.steps" :key="step.step" class="step-row">
                <el-tag size="small" effect="plain">{{ step.step }}</el-tag>
                <el-text size="small">{{ step.toolName }}</el-text>
                <el-tag size="small" :type="stepSummary(step.output).type" effect="plain">
                  {{ stepSummary(step.output).text }}
                </el-tag>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>

      <!-- 执行中的实时步骤 -->
      <div v-if="isBusy && currentSteps.length" class="live-steps">
        <el-text size="small" type="info">正在执行第 {{ currentSteps.length }} 步…</el-text>
        <div v-for="step in currentSteps.slice(-3)" :key="step.step" class="step-row">
          <el-tag size="small" effect="plain">{{ step.step }}</el-tag>
          <el-text size="small">{{ step.toolName }}</el-text>
          <el-tag size="small" :type="stepSummary(step.output).type" effect="plain">
            {{ stepSummary(step.output).text }}
          </el-tag>
        </div>
      </div>

      <el-input
        v-model="instruction"
        type="textarea"
        :rows="3"
        resize="none"
        :disabled="isBusy"
        placeholder="用一句话描述你想做什么，例如：在搜索框输入 Vue3 并搜索"
        @keydown.enter.meta.prevent="submitInstruction"
      />

      <el-space wrap>
        <el-button type="primary" :loading="isBusy" :disabled="!canSubmit" @click="submitInstruction">
          执行指令
        </el-button>
        <el-button v-if="isBusy" type="danger" plain @click="stop">停止</el-button>
        <el-button :icon="Star" :disabled="!canSaveSkill" plain size="small" @click="handleSaveSkill">
          保存为技能
        </el-button>
        <el-text size="small" type="info">⌘ + Enter 快速执行</el-text>
      </el-space>

      <el-alert
        v-if="runError && runState === 'failed'"
        :title="runError.message"
        :description="runError.details"
        type="error"
        :closable="false"
        show-icon
      />
    </el-space>

    <!-- 审批对话框：写操作需要用户逐个批准 -->
    <el-dialog
      :model-value="pendingApproval !== null"
      title="需要你批准这个操作"
      width="90%"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
      append-to-body
    >
      <template v-if="pendingApproval">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="动作">{{ pendingApproval.summary }}</el-descriptions-item>
          <el-descriptions-item label="工具">{{ pendingApproval.toolName }}</el-descriptions-item>
          <el-descriptions-item label="页面">{{ pendingApproval.url }}</el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-space direction="vertical" fill style="width: 100%">
          <el-button type="primary" style="width: 100%" @click="onApprove('once')">允许本次</el-button>
          <el-button style="width: 100%" @click="onApprove('session-tool')">
            本会话内该类动作都允许
          </el-button>
          <el-button style="width: 100%" @click="onApprove('domain-tool')">
            {{ currentHost() }} 下永久允许
          </el-button>
          <el-button type="danger" plain style="width: 100%" @click="deny">拒绝</el-button>
        </el-space>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.help-icon {
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 16px;
}

.help-icon:hover {
  color: var(--el-color-primary);
}

.tools-help {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}

.tool-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.tool-item:last-child {
  border-bottom: none;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 160px;
}

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.session-delete {
  color: var(--el-color-danger);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page-context {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.url-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

.permission-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.conversation {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 4px;
}

.turn {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}

.turn-user {
  background: var(--el-color-primary-light-9);
}

.turn-error {
  background: var(--el-color-danger-light-9);
}

.turn-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  margin-top: 2px;
}

.turn-steps {
  margin-top: 6px;
}

.step-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.live-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--el-color-info-light-9);
  border-radius: 4px;
}
</style>
