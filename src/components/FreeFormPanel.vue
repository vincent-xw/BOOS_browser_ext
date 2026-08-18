<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowDown, Delete, QuestionFilled, Star, CopyDocument, Download, Upload, FolderOpened, Paperclip, Picture, Document, Loading } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useFreeFormController } from '../composables/useFreeFormController';
import type { GrantScope } from '../agent/approvalGate';
import { TOOLS_CATALOG } from '../services/toolsCatalog';
import { useSkillController } from '../composables/useSkillController';
import type { Skill } from '../services/skillStore';
import {
  exportFile,
  getGeneratedFiles,
  removeGeneratedFile,
  writeFile,
  initFileStore,
  clearAllFiles,
} from '../services/exportService';
import type { GeneratedFile } from '../services/exportService';
import { formatFreeFormDiagnostic } from '../services/freeFormDiagnostics';
import { formatDiagnosticResult, runDiagnostics } from '../services/diagnosticService';
import type { ConversationTurn } from '../services/freeFormSessionStore';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** 把 markdown 文本渲染为安全 HTML。 */
function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(raw);
}

const props = defineProps<{ skillToApply?: Skill | null; settingsSaved?: number }>();
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
  pendingPlan,
  planReasoning,
  isPlanning,
  isBusy,
  canSubmit,
  llmStatus,
  currentToolName,
  streamingContent,
  streamingReasoning,
  approve,
  deny,
  requestPlan,
  confirmPlan,
  rejectPlan,
  submitInstruction,
  stop,
  isStopping,
  startNewSession,
  switchSession,
  removeSession,
  refreshSessions,
  refreshPageContext,
  attachments,
} = useFreeFormController();

const { saveFromTurns } = useSkillController();

/** 工具说明面板是否展开。 */
const toolsHelpVisible = ref(false);
/** 用户是否已点过「我已了解」。首次需要显式确认，后续仅点击查阅不展示按钮。 */
const toolsHelpAcknowledged = ref(true);
const ONBOARDING_KEY = 'boos.onboarding.toolsHelpAcknowledged';

/** 首次确认按钮：标记已读并关闭面板。 */
function acknowledgeToolsHelp() {
  toolsHelpAcknowledged.value = true;
  toolsHelpVisible.value = false;
  void chrome.storage.local.set({ [ONBOARDING_KEY]: true });
}

onMounted(() => {
  void refreshPageContext();
  void refreshSessions();
  void initFileStore().then(() => refreshAllFiles());
  // 首次使用自动弹出工具说明，等用户点「我已了解」才关闭并记录。
  void chrome.storage.local.get(ONBOARDING_KEY).then((stored) => {
    if (!stored[ONBOARDING_KEY]) {
      toolsHelpVisible.value = true;
      toolsHelpAcknowledged.value = false;
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

/** 导出对话内容。把所有 agent 回复拼接为文本，按选定格式导出。 */
async function handleExport(format: 'txt' | 'csv' | 'xlsx') {
  // 把对话内容拼接：每条轮次带角色标签，agent 的步骤摘要也包含进去。
  const lines: string[] = [];
  for (const turn of turns.value) {
    const role = turn.role === 'user' ? '用户' : turn.role === 'agent' ? 'Agent' : '错误';
    lines.push(`【${role}】`);
    lines.push(turn.text);
    if (Array.isArray(turn.steps) && turn.steps.length) {
      lines.push(`（执行了 ${turn.steps.length} 步）`);
      for (const step of turn.steps) {
        const summary = stepSummary(step.output);
        lines.push(`  ${step.step}. ${step.toolName} -> ${summary.text}`);
      }
    }
    lines.push('');
  }
  const content = lines.join('\n');
  const timestamp = newDatetoISOString().slice(0, 19).replace(/[:T]/g, '-');
  const result = await exportFile({ filename: `对话记录-${timestamp}`, format, content });
  if (result.ok) ElMessage.success(result.message);
  else ElMessage.warning(result.message);
}

function newDatetoISOString(): string {
  return new Date().toISOString();
}

/** 全部文件（截图 + 生成文件 + 上传文件），从统一存储取。 */
const allFiles = ref<GeneratedFile[]>([]);

function refreshAllFiles() {
  allFiles.value = getGeneratedFiles();
}

// 每步执行后检查是否有新文件生成（browser_screenshot / browser_save_file）。
watch(currentSteps, () => refreshAllFiles(), { deep: true });

// 设置保存后刷新页面上下文（白名单、授权状态等）。
watch(() => props.settingsSaved, () => {
  if (typeof props.settingsSaved === 'number') void refreshPageContext();
});

/** 附件管理弹窗。 */
const fileManagerVisible = ref(false);

function openFileManager() {
  refreshAllFiles();
  fileManagerVisible.value = true;
}

/** 下载文件。 */
function downloadFile(file: GeneratedFile) {
  const a = document.createElement('a');
  a.href = file.url;
  a.download = file.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * 某一轮里 agent 生成的文件。
 *
 * 从步骤输出的 fileId / screenshotId 反查，而不是让模型在正文里写 markdown 链接 ——
 * 正文经 DOMPurify 净化，blob: 协议不在其默认白名单里，href 会被剥掉，
 * 表现为「链接看得见但点了没反应」。放开 blob: 白名单等于允许模型注入任意链接，
 * 所以改成由 UI 按 id 渲染卡片，模型只需提到文件名。
 */
function turnFiles(turn: ConversationTurn): GeneratedFile[] {
  const ids = new Set<string>();
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  for (const step of steps) {
    const output = step.output as { fileId?: unknown; screenshotId?: unknown } | null;
    if (typeof output?.fileId === 'string') ids.add(output.fileId);
    if (typeof output?.screenshotId === 'string') ids.add(output.screenshotId);
  }
  if (ids.size === 0) return [];
  return allFiles.value.filter((file) => ids.has(file.id));
}

/** 删除文件（同时取消勾选）。 */
function handleRemoveFile(id: string) {
  removeGeneratedFile(id);
  refreshAllFiles();
}

/** 截图预览。 */
const screenshotPreviewVisible = ref(false);
const previewingScreenshot = ref<GeneratedFile | null>(null);

function previewScreenshot(file: GeneratedFile) {
  previewingScreenshot.value = file;
  screenshotPreviewVisible.value = true;
}

/** 本地上传文本文件。 */
const fileInputRef = ref<HTMLInputElement | null>(null);

function triggerFilePicker() {
  fileInputRef.value?.click();
}

async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  for (const file of input.files) {
    const text = await file.text();
    await writeFile(file.name, text);
    ElMessage.success(`已上传 ${file.name}`);
  }
  input.value = '';
  refreshAllFiles();
}

/** 清空全部文件。 */
async function handleClearAllFiles() {
  await clearAllFiles();
  refreshAllFiles();
  ElMessage.success('已清空所有文件');
}

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

/** 复制对话文本到剪贴板。 */
function copyTurnText(text: string, index: number) {
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success({ message: '已复制', duration: 1500 });
  }).catch(() => {
    ElMessage.warning('复制失败，请手动选择文本复制');
  });
  void index;
}

/**
 * 复制失败轮次的诊断日志，供用户贴给大模型排查。
 *
 * 有意包含完整的工具入参出参 —— 省略掉的往往正是关键。代价是可能含简历/沟通原文，
 * 所以 toast 必须提示，让用户外发前自己过一眼。
 */
async function copyDiagnosticLog(turn: ConversationTurn) {
  const text = formatFreeFormDiagnostic({
    sessionId: sessionId.value,
    timestamp: turn.timestamp,
    extensionVersion: chrome.runtime.getManifest().version,
    url: currentUrl.value,
    error: {
      code: turn.error?.bffCode ?? turn.error?.code ?? 'UNKNOWN',
      message: turn.error?.message ?? turn.text,
      ...(turn.error?.requestId ? { requestId: turn.error.requestId } : {}),
    },
    steps: Array.isArray(turn.steps) ? turn.steps : [],
    environment: formatDiagnosticResult(await runDiagnostics()),
  });
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success({ message: '已复制（含完整输入输出，可能包含简历/消息原文）', duration: 4000 });
  } catch {
    ElMessage.warning('复制失败，请手动选择文本复制');
  }
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
  if (typeof record.satisfied === 'boolean') {
    return record.satisfied
      ? { text: `等待完成（${record.observed ?? ''}）`.slice(0, 60), type: 'success' }
      : { text: `等待超时（${record.observed ?? ''}）`.slice(0, 60), type: 'warning' };
  }
  if (record.passed === true) return { text: '验证通过', type: 'success' };
  if (record.passed === false) return { text: '验证未通过', type: 'danger' };
  return { text: String(record.message ?? '完成').slice(0, 60), type: 'success' };
}

/** 复制步骤详情到剪贴板，方便排查。 */
function copyStepDetail(step: { toolName: string; input: unknown; output: unknown }) {
  const lines: string[] = [];
  lines.push(`工具：${step.toolName}`);
  lines.push(`入参：${JSON.stringify(step.input, null, 2)}`);
  lines.push(`出参：${JSON.stringify(step.output, null, 2)}`);
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    ElMessage.success({ message: '步骤详情已复制', duration: 1500 });
  }).catch(() => {
    ElMessage.warning('复制失败，请手动选择文本复制');
  });
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
            :width="520"
            trigger="click"
            popper-class="tools-help-popover"
          >
            <template #reference>
              <el-icon class="help-icon" title="查看可用工具与操作边界"><QuestionFilled /></el-icon>
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
              <!-- 首次需要显式确认已阅读；后续点击图标查看时不再展示按钮 -->
              <div v-if="!toolsHelpAcknowledged" class="tools-help-actions">
                <el-button type="primary" size="small" @click="acknowledgeToolsHelp">我已了解，开始使用</el-button>
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

    <el-space direction="vertical" fill :size="10" style="width: 100%; flex: 1; min-height: 0; overflow: hidden">
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
          <div class="turn-header">
            <el-text size="small" tag="b">{{ turn.role === 'user' ? '你' : turn.role === 'agent' ? 'Agent' : '错误' }}</el-text>
            <el-button v-if="turn.text" link size="small" class="copy-btn" @click="copyTurnText(turn.text, index)">
              <el-icon><CopyDocument /></el-icon>
            </el-button>
            <el-button
              v-if="turn.role === 'error'"
              link
              size="small"
              class="copy-btn"
              @click="copyDiagnosticLog(turn)"
            >
              复制诊断日志
            </el-button>
          </div>
          <div v-if="turn.role === 'agent'" class="turn-text markdown-body" v-html="renderMarkdown(turn.text)"></div>
          <div v-else class="turn-text">{{ turn.text }}</div>
          <div v-if="turn.role === 'agent' && turnFiles(turn).length" class="turn-files">
            <div v-for="file in turnFiles(turn)" :key="file.id" class="turn-file">
              <img
                v-if="file.isImage"
                :src="file.url"
                class="turn-file-thumb"
                :alt="file.filename"
                @click="previewScreenshot(file)"
              />
              <el-icon v-else class="turn-file-icon"><Document /></el-icon>
              <div class="turn-file-info">
                <el-text size="small" truncated>{{ file.filename }}</el-text>
                <el-text size="small" type="info">{{ (file.size / 1024).toFixed(1) }}KB</el-text>
              </div>
              <el-button link size="small" @click="downloadFile(file)">下载</el-button>
            </div>
          </div>
          <el-collapse v-if="Array.isArray(turn.steps) && turn.steps.length" class="turn-steps">
            <el-collapse-item :title="`执行了 ${turn.steps.length} 步`" :name="index">
              <div v-for="step in turn.steps" :key="step.step" class="step-row">
                <el-tag size="small" effect="plain">{{ step.step }}</el-tag>
                <el-text size="small">{{ step.toolName }}</el-text>
                <el-tag size="small" :type="stepSummary(step.output).type" effect="plain">
                  {{ stepSummary(step.output).text }}
                </el-tag>
                <el-button :icon="CopyDocument" link size="small" class="step-copy" @click="copyStepDetail(step)" />
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>

      <!-- LLM 流式输出：reasoning 思考过程 -->
      <div v-if="isBusy && streamingReasoning" class="turn turn-agent streaming-turn">
        <el-collapse class="turn-steps">
          <el-collapse-item title="模型思考中…" :name="'streaming-reasoning'">
            <div class="streaming-reasoning">{{ streamingReasoning }}</div>
          </el-collapse-item>
        </el-collapse>
      </div>

      <!-- LLM 流式输出：正文逐字出现 -->
      <div v-if="isBusy && streamingContent" class="turn turn-agent">
        <div class="turn-header">
          <el-text size="small" tag="b">Agent</el-text>
        </div>
        <div class="turn-text markdown-body streaming-cursor" v-html="renderMarkdown(streamingContent)"></div>
      </div>

      <!-- 执行中的实时步骤 -->
      <div v-if="isBusy" class="live-steps">
        <div v-if="llmStatus && !currentToolName" class="step-row">
          <el-icon class="is-loading"><Loading /></el-icon>
          <el-text size="small" type="info">{{ llmStatus }}</el-text>
        </div>
        <div v-if="currentToolName" class="step-row">
          <el-icon class="is-loading"><Loading /></el-icon>
          <el-text size="small">{{ currentToolName }}…</el-text>
        </div>
        <template v-if="currentSteps.length">
          <el-text size="small" type="info">已完成 {{ currentSteps.length }} 步</el-text>
          <div v-for="step in currentSteps.slice(-3)" :key="step.step" class="step-row">
            <el-tag size="small" effect="plain">{{ step.step }}</el-tag>
            <el-text size="small">{{ step.toolName }}</el-text>
            <el-tag size="small" :type="stepSummary(step.output).type" effect="plain">
              {{ stepSummary(step.output).text }}
            </el-tag>
            <el-button :icon="CopyDocument" link size="small" class="step-copy" @click="copyStepDetail(step)" />
          </div>
        </template>
      </div>

      <!-- 已勾选带入上下文的附件 -->
      <div v-if="attachments.selectedCount() > 0" class="attached-chips">
        <el-tag
          v-for="file in allFiles.filter((f) => attachments.isSelected(f.id))"
          :key="file.id"
          size="small"
          closable
          @close="attachments.toggle(file.id)"
        >
          <el-icon v-if="file.isImage" class="chip-icon"><Picture /></el-icon>
          <el-icon v-else class="chip-icon"><Document /></el-icon>
          {{ file.filename }}
        </el-tag>
      </div>

      <div class="input-toolbar">
        <el-button :icon="Paperclip" link @click="openFileManager" title="附件与文件管理">
          {{ attachments.selectedCount() > 0 ? `附件（${attachments.selectedCount()}）` : '附件' }}
        </el-button>
      </div>
      <el-input
        v-model="instruction"
        type="textarea"
        :rows="3"
        resize="none"
        :disabled="isBusy"
        placeholder="用一句话描述你想做什么，例如：在搜索框输入 Vue3 并搜索"
        @keydown.enter.meta.prevent="requestPlan"
      />
      <input
        ref="fileInputRef"
        type="file"
        multiple
        accept=".txt,.csv,.json,.md,.xml,.html,.js,.ts,.py,.yaml,.yml,text/*"
        style="display: none"
        @change="handleFileSelect"
      />

      <!-- 文件管理弹窗 -->
      <el-dialog v-model="fileManagerVisible" title="附件与文件管理" width="640px" append-to-body>
        <template #header>
          <div class="fm-header">
            <span>附件与文件管理</span>
            <el-button :icon="Upload" link size="small" @click="triggerFilePicker">上传文件</el-button>
          </div>
        </template>
        <div v-if="!allFiles.length" class="fm-empty">
          还没有文件。agent 生成的截图、导出的文件会出现在这里；也可以点右上角上传。
        </div>
        <div v-else class="fm-list">
          <div v-for="file in allFiles" :key="file.id" class="fm-item">
            <el-checkbox
              :model-value="attachments.isSelected(file.id)"
              @change="attachments.toggle(file.id)"
            >
              <span class="fm-name">
                <el-icon v-if="file.isImage" class="fm-icon"><Picture /></el-icon>
                <el-icon v-else class="fm-icon"><Document /></el-icon>
                {{ file.filename }}
              </span>
            </el-checkbox>
            <div class="fm-meta">
              <el-text size="small" type="info">
                {{ file.isImage ? `${file.width}x${file.height} · ` : '' }}{{ (file.size / 1024).toFixed(1) }}KB
              </el-text>
              <el-button
                v-if="file.isImage"
                link size="small"
                @click="previewScreenshot(file)"
              >预览</el-button>
              <el-button link size="small" @click="downloadFile(file)">下载</el-button>
              <el-button :icon="Delete" link size="small" @click="handleRemoveFile(file.id)" />
            </div>
          </div>
        </div>
        <template #footer>
          <el-button @click="handleClearAllFiles" plain type="danger">清空全部</el-button>
          <el-button type="primary" @click="fileManagerVisible = false">完成</el-button>
        </template>
      </el-dialog>

      <!-- 截图大图预览 -->
      <el-dialog
        v-model="screenshotPreviewVisible"
        title="截图预览"
        width="95%"
        :close-on-click-modal="true"
        append-to-body
      >
        <img v-if="previewingScreenshot" :src="previewingScreenshot.url" style="width: 100%; max-height: 70vh; object-fit: contain" />
      </el-dialog>

      <el-space wrap>
        <el-button type="primary" :loading="isPlanning" :disabled="!canSubmit" @click="requestPlan">
          {{ isPlanning ? '评估中...' : '评估' }}
        </el-button>
        <el-button v-if="isBusy && !isPlanning" type="danger" plain :loading="isStopping" @click="stop">停止</el-button>
        <el-button :icon="Star" :disabled="!canSaveSkill" plain @click="handleSaveSkill">
          保存为技能
        </el-button>
        <el-dropdown :disabled="!canSaveSkill" trigger="click" @command="handleExport">
          <el-button :icon="Download" :disabled="!canSaveSkill" plain>
            导出
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="txt">导出为 TXT</el-dropdown-item>
              <el-dropdown-item command="csv">导出为 CSV</el-dropdown-item>
              <el-dropdown-item command="xlsx">导出为 Excel (XLSX)</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-text size="small" type="info">⌘ + Enter 快速评估</el-text>
      </el-space>

      <!-- 计划预览：模型评估完成后展示，等用户确认或取消 -->
      <el-card v-if="pendingPlan" shadow="never" class="plan-card">
        <template #header>
          <div class="plan-header">
            <el-text tag="b">任务评估</el-text>
            <el-tag :type="pendingPlan.feasible ? 'success' : 'danger'" effect="plain" size="small">
              {{ pendingPlan.feasible ? '可行' : '不可行' }}
            </el-tag>
            <el-tag v-if="pendingPlan.feasible" :type="pendingPlan.confidence === 'high' ? 'success' : pendingPlan.confidence === 'medium' ? 'warning' : 'danger'" effect="plain" size="small">
              置信度：{{ pendingPlan.confidence === 'high' ? '高' : pendingPlan.confidence === 'medium' ? '中' : '低' }}
            </el-tag>
          </div>
        </template>

        <el-text size="small">{{ pendingPlan.summary }}</el-text>

        <!-- 模型思考链（reasoning_content）：可折叠 -->
        <el-collapse v-if="planReasoning" class="plan-reasoning">
          <el-collapse-item title="模型思考过程">
            <pre class="reasoning-text">{{ planReasoning }}</pre>
          </el-collapse-item>
        </el-collapse>

        <!-- 步骤列表 -->
        <div v-if="pendingPlan.steps.length" class="plan-steps">
          <div v-for="(step, index) in pendingPlan.steps" :key="index" class="plan-step">
            <el-text size="small" tag="b">{{ index + 1 }}.</el-text>
            <el-text size="small">{{ step.action }}</el-text>
            <el-tag size="small" :type="step.write ? 'warning' : 'info'" effect="plain">{{ step.tool }}</el-tag>
            <el-text v-if="step.note" size="small" type="warning">{{ step.note }}</el-text>
          </div>
        </div>

        <!-- 风险 -->
        <el-alert v-if="pendingPlan.risks.length" type="warning" :closable="false" show-icon :title="`风险：${pendingPlan.risks.join('；')}`" />

        <!-- 做不到的部分 -->
        <el-alert v-if="pendingPlan.cannotDo.length" type="error" :closable="false" show-icon :title="`无法完成：${pendingPlan.cannotDo.join('；')}`" />

        <!-- 确认/取消按钮 -->
        <div v-if="pendingPlan.feasible" class="plan-actions">
          <el-button type="primary" @click="confirmPlan">确认执行</el-button>
          <el-button @click="rejectPlan">取消</el-button>
        </div>
        <div v-else class="plan-actions">
          <el-button @click="rejectPlan">知道了</el-button>
        </div>
      </el-card>

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
  justify-content: space-between;
  gap: 8px;
}

.tool-header .el-text {
  flex: 1;
}

.tools-help-actions {
  display: flex;
  justify-content: center;
  padding-top: 8px;
  margin-top: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
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
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.turn {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  min-width: 0;
  overflow: hidden;
}

.turn-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.copy-btn {
  opacity: 0;
  transition: opacity 0.2s;
}

.turn:hover .copy-btn {
  opacity: 1;
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
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Markdown 渲染样式 */
.markdown-body {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Markdown 渲染样式 */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 8px 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.markdown-body :deep(h1) { font-size: 16px; }
.markdown-body :deep(h2) { font-size: 15px; }

.markdown-body :deep(p) {
  margin: 4px 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  margin: 2px 0;
}

.markdown-body :deep(code) {
  background: var(--el-fill-color-dark);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  font-family: monospace;
}

.markdown-body :deep(pre) {
  background: var(--el-fill-color-dark);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  max-width: 100%;
  margin: 4px 0;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--el-border-color);
  padding-left: 10px;
  margin: 4px 0;
  color: var(--el-text-color-secondary);
}

.markdown-body :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 4px 0;
  display: block;
  overflow-x: auto;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 4px 8px;
  font-size: 12px;
}

.markdown-body :deep(strong) {
  font-weight: 600;
}

.turn-steps {
  margin-top: 6px;
}

.turn-files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.turn-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
}
.turn-file-thumb {
  width: 48px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.turn-file-icon {
  font-size: 20px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}
.turn-file-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.step-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}
.step-copy {
  flex-shrink: 0;
  margin-left: auto;
}

.live-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--el-color-info-light-9);
  border-radius: 4px;
  flex-shrink: 0;
}

.streaming-reasoning {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.streaming-cursor::after {
  content: '▊';
  animation: blink 1s step-start infinite;
  color: var(--el-color-primary);
  margin-left: 2px;
}

@keyframes blink {
  50% { opacity: 0; }
}

.plan-card {
  border: 1px solid var(--el-color-primary-light-5);
}

.plan-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plan-reasoning {
  margin: 8px 0;
}

.reasoning-text {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-secondary);
}

.plan-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
}

.plan-step {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.plan-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.input-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.input-toolbar .el-button {
  margin-left: 0;
  padding-left: 4px;
}

.attached-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.chip-icon {
  margin-right: 2px;
  vertical-align: -2px;
}

.fm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fm-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.fm-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 50vh;
  overflow-y: auto;
}
.fm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 4px;
  border-radius: 4px;
}
.fm-item:hover {
  background: var(--el-fill-color-light);
}
.fm-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fm-icon {
  flex-shrink: 0;
}
.fm-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
</style>
