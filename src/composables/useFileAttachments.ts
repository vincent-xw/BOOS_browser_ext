import { ref } from 'vue';
import { getFile, getGeneratedFiles, isTextFormat } from '../services/exportService';
import type { GeneratedFile } from '../services/exportService';

/**
 * 附件选择状态。
 *
 * 被勾选的文件会在 run/plan 时读进 LLM 上下文（context.fileList）。
 * 截图和 xlsx 等二进制文件不能注入文本，只作为引用；模型需要时用 read_file 读，
 * 但 read_file 目前只支持文本，所以二进制勾选了也只是告诉模型「有这个文件」。
 */
const selectedIds = ref<Set<string>>(new Set());

export function useFileAttachments() {
  function toggle(id: string): void {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
  }

  function isSelected(id: string): boolean {
    return selectedIds.value.has(id);
  }

  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  const selectedCount = () => selectedIds.value.size;

  /**
   * 读取已勾选的文本文件，组装成 context.fileList。
   * 截图/二进制只列元信息，不读内容。大文件截断到 50000 字符。
   */
  function buildFileList(): Array<{
    id: string;
    name: string;
    size: number;
    format: GeneratedFile['format'];
    isImage: boolean;
    content?: string;
    truncated?: boolean;
    totalLength?: number;
  }> {
    const result: ReturnType<typeof buildFileList> = [];
    for (const id of selectedIds.value) {
      const file = getFile(id);
      if (!file) continue;
      if (isTextFormat(file.format) && file.text !== undefined) {
        const maxChars = 50000;
        const truncated = file.text.length > maxChars;
        result.push({
          id: file.id,
          name: file.filename,
          size: file.size,
          format: file.format,
          isImage: false,
          content: truncated ? file.text.slice(0, maxChars) : file.text,
          ...(truncated ? { truncated: true, totalLength: file.text.length } : {}),
        });
      } else {
        result.push({
          id: file.id,
          name: file.filename,
          size: file.size,
          format: file.format,
          isImage: file.isImage,
        });
      }
    }
    return result;
  }

  return {
    files: getGeneratedFiles,
    selectedIds,
    toggle,
    isSelected,
    clearSelection,
    selectedCount,
    buildFileList,
  };
}
