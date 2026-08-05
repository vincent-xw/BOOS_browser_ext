<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { ArrowDown, Delete } from '@element-plus/icons-vue';
import { useFreeFormController } from '../composables/useFreeFormController';
import type { GrantScope } from '../agent/approvalGate';

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

onMounted(() => {
  void refreshPageContext();
  void refreshSessions();
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

/** 步骤输出的简短摘要。失败与被拒的步骤要能一眼看出。 */
function stepSummary(output: unknown): { text: string; type: 'success' | 'warning' | 'danger' } {
  const record = (output ?? {}) as Record<string, unknown>;
  if (record.code === 'USER_DENIED') return { text: '已拒绝', type: 'warning' };
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
        <el-text tag="b">自由指令</el-text>
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
      <el-alert v-if="!urlAllowed" type="warning" :closable="false" show-icon :title="urlAllowReason">
        读取与快照仍可进行，但写操作会被拒绝。请在设置中把该域名加入白名单。
      </el-alert>

      <div class="page-context">
        <el-text size="small" type="info" truncated>{{ currentTitle || '(未获取页面标题)' }}</el-text>
        <el-text size="small" type="info" truncated>{{ currentUrl || '(未获取页面地址)' }}</el-text>
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
