import { computed, ref } from 'vue';
import { chromeMcpService } from '../services/chromeMcpService';
import type {
  OperationError,
  OperationState,
  PageReadData,
  PageWriteData,
  ProviderKind,
  ProviderMode,
} from '../types/page-io';

export function usePageIoController() {
  const readState = ref<OperationState>('idle');
  const writeState = ref<OperationState>('idle');
  const readResult = ref<PageReadData | null>(null);
  const writeResult = ref<PageWriteData | null>(null);
  const readError = ref<OperationError | null>(null);
  const writeError = ref<OperationError | null>(null);
  const writeText = ref('你好，来自 BOOS Browser Extension。');
  const provider = ref<ProviderKind>('unavailable');
  const mode = ref<ProviderMode>('fallback');

  const isBusy = computed(
    () => readState.value === 'running' || writeState.value === 'running',
  );

  const overallState = computed<OperationState>(() => {
    if (isBusy.value) {
      return 'running';
    }

    if (readState.value === 'failed' || writeState.value === 'failed') {
      return 'failed';
    }

    if (readState.value === 'succeeded' || writeState.value === 'succeeded') {
      return 'succeeded';
    }

    return 'idle';
  });

  const providerLabel = computed(() => {
    switch (provider.value) {
      case 'chrome-mcp':
        return 'Chrome MCP';
      case 'tabs-scripting-fallback':
        return '标签页脚本回退';
      default:
        return '能力不可用';
    }
  });

  const modeLabel = computed(() =>
    mode.value === 'live' ? '实时模式' : '回退模式',
  );

  const overallMessage = computed(() => {
    switch (overallState.value) {
      case 'running':
        return '正在执行页面读写操作，请稍候。';
      case 'succeeded':
        return '最近一次页面操作已完成，可以继续读取或写入。';
      case 'failed':
        return '最近一次页面操作失败，请查看错误反馈后重试。';
      default:
        return '基础架构已就绪，可通过下方按钮验证页面读取与写入能力。';
    }
  });

  const overallMessageType = computed(() => {
    switch (overallState.value) {
      case 'running':
        return 'info';
      case 'succeeded':
        return 'success';
      case 'failed':
        return 'error';
      default:
        return 'warning';
    }
  });

  async function handleRead() {
    readState.value = 'running';
    readError.value = null;

    const result = await chromeMcpService.readPage();
    provider.value = result.provider;
    mode.value = result.mode;

    if (result.ok && result.data) {
      readResult.value = result.data;
      readState.value = 'succeeded';
      return;
    }

    readResult.value = null;
    readError.value = result.error ?? {
      code: 'EXECUTION_FAILED',
      message: '读取页面失败。',
    };
    readState.value = 'failed';
  }

  async function handleWrite() {
    writeState.value = 'running';
    writeError.value = null;

    const result = await chromeMcpService.writePage({ text: writeText.value });
    provider.value = result.provider;
    mode.value = result.mode;

    if (result.ok && result.data) {
      writeResult.value = result.data;
      writeState.value = 'succeeded';
      return;
    }

    writeResult.value = null;
    writeError.value = result.error ?? {
      code: 'EXECUTION_FAILED',
      message: '写入页面失败。',
    };
    writeState.value = 'failed';
  }

  return {
    readState,
    writeState,
    readResult,
    writeResult,
    readError,
    writeError,
    writeText,
    isBusy,
    overallState,
    overallMessage,
    overallMessageType,
    providerLabel,
    modeLabel,
    handleRead,
    handleWrite,
  };
}
