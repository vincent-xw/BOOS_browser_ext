<script setup lang="ts">
import { computed } from 'vue';
import ExtensionAppShell from '../../src/components/ExtensionAppShell.vue';
import { usePageIoController } from '../../src/composables/usePageIoController';

const {
  readState,
  writeState,
  readResult,
  writeResult,
  readError,
  writeError,
  writeText,
  isBusy,
  overallMessage,
  overallMessageType,
  providerLabel,
  modeLabel,
  handleRead,
  handleWrite,
} = usePageIoController();

const readTagType = computed(() => {
  switch (readState.value) {
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

const writeTagType = computed(() => {
  switch (writeState.value) {
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
</script>

<template>
  <ExtensionAppShell
    title="页面读写基础架构"
    description="一个面向后续扩展的浏览器插件壳层，用于验证 Chrome MCP 页面读写交互。"
    :provider-label="providerLabel"
    :mode-label="modeLabel"
    :status-message="overallMessage"
    :status-type="overallMessageType"
  >
    <div class="popup-layout">
      <el-row :gutter="12">
        <el-col :span="24">
          <el-card class="panel-card" shadow="never">
            <template #header>
              <div class="panel-header">
                <span>页面读取</span>
                <el-tag :type="readTagType" effect="plain">{{ readState }}</el-tag>
              </div>
            </template>

            <el-space direction="vertical" fill :size="12">
              <el-button type="primary" :loading="readState === 'running'" @click="handleRead">
                读取当前页面信息
              </el-button>

              <el-alert
                v-if="readError"
                :title="readError.message"
                type="error"
                :description="readError.details || '请检查当前标签页是否可访问。'"
                :closable="false"
                show-icon
              />

              <el-descriptions v-else-if="readResult" :column="1" border size="small">
                <el-descriptions-item label="页面标题">{{ readResult.title }}</el-descriptions-item>
                <el-descriptions-item label="页面地址">{{ readResult.url }}</el-descriptions-item>
                <el-descriptions-item label="当前选中文本">
                  {{ readResult.selectionText || '暂无选中文本' }}
                </el-descriptions-item>
                <el-descriptions-item label="激活元素">
                  {{ readResult.activeElementTag || '无' }}
                </el-descriptions-item>
                <el-descriptions-item label="正文预览">
                  {{ readResult.bodyPreview || '当前页面暂无可读取文本预览' }}
                </el-descriptions-item>
                <el-descriptions-item label="读取时间">{{ readResult.timestamp }}</el-descriptions-item>
              </el-descriptions>

              <el-empty v-else description="尚未执行页面读取" :image-size="72" />
            </el-space>
          </el-card>
        </el-col>

        <el-col :span="24">
          <el-card class="panel-card" shadow="never">
            <template #header>
              <div class="panel-header">
                <span>页面写入</span>
                <el-tag :type="writeTagType" effect="plain">{{ writeState }}</el-tag>
              </div>
            </template>

            <el-space direction="vertical" fill :size="12">
              <el-input
                v-model="writeText"
                type="textarea"
                :rows="5"
                resize="none"
                placeholder="输入要写入页面的内容；若页面存在激活输入框，将优先写入该位置。"
              />

              <el-button
                type="success"
                :disabled="!writeText.trim()"
                :loading="writeState === 'running'"
                @click="handleWrite"
              >
                写入当前页面
              </el-button>

              <el-alert
                v-if="writeError"
                :title="writeError.message"
                type="error"
                :description="writeError.details || '请聚焦一个可编辑区域后重试。'"
                :closable="false"
                show-icon
              />

              <el-result
                v-else-if="writeResult"
                :icon="writeState === 'succeeded' ? 'success' : 'info'"
                :title="writeResult.message"
                :sub-title="`写入目标：${writeResult.target} · 时间：${writeResult.timestamp}`"
              >
                <template #extra>
                  <el-text type="info">写入内容：{{ writeResult.writtenText }}</el-text>
                </template>
              </el-result>
            </el-space>
          </el-card>
        </el-col>
      </el-row>

      <el-divider />

      <el-space alignment="center" wrap>
        <el-tag type="info" effect="plain">共享状态：{{ isBusy ? 'busy' : 'ready' }}</el-tag>
        <el-tag type="warning" effect="plain">支持未来多入口扩展</el-tag>
      </el-space>
    </div>
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
