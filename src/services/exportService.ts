import * as XLSX from 'xlsx';

/**
 * 文件生成服务。
 *
 * agent 调用 browser_save_file 工具时，把数据交给这里生成文件。
 * 文件存在内存里（Blob URL），扩展在对话区域展示一个下载按钮，用户点击下载。
 *
 * 与导出对话记录的 exportFile 不同：这个是 agent 在执行过程中产出的结构化数据，
 * 不是对话日志。
 */

export type SaveFileFormat = 'txt' | 'csv' | 'xlsx' | 'json';
export type ScreenshotFormat = 'png' | 'jpeg';
export type GeneratedFormat = SaveFileFormat | ScreenshotFormat;

export interface GeneratedFile {
  /** 唯一标识，用于 UI 管理。 */
  id: string;
  /** 文件名（含扩展名）。 */
  filename: string;
  /** 文件大小（字节）。 */
  size: number;
  /** 创建时间。 */
  createdAt: string;
  /** Blob URL 或 data URL，用户点击下载/查看时用。 */
  url: string;
  /** 文件格式。 */
  format: GeneratedFormat;
  /** 是否是图片（截图）。图片在 UI 里展示缩略图而非下载按钮。 */
  isImage: boolean;
  /** 图片宽度（仅截图有）。 */
  width?: number;
  /** 图片高度（仅截图有）。 */
  height?: number;
}

/** 内存中保存已生成的文件，供 UI 展示下载按钮。 */
const generatedFiles: GeneratedFile[] = [];

/** 获取所有已生成的文件。 */
export function getGeneratedFiles(): GeneratedFile[] {
  return [...generatedFiles];
}

/**
 * 从 agent 传入的数据生成文件，返回文件信息。
 *
 * @param filename 文件名（不含扩展名）
 * @param format 格式
 * @param content 文本内容或 JSON 数据
 *   - txt：直接写入文本
 *   - json：JSON.stringify 后写入
 *   - csv：JSON 数组按字段做表头，纯文本按行做单列
 *   - xlsx：JSON 数组按字段做表头，纯文本按行做单列
 */
export function generateFile(filename: string, format: SaveFileFormat, content: string): GeneratedFile {
  let blob: Blob;
  const ext = format;

  // 尝试解析为 JSON 数组（csv/xlsx 会按结构化处理）。
  let jsonData: unknown[] | null = null;
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) jsonData = parsed;
  } catch {
    // 不是 JSON，按纯文本处理。
  }

  if (format === 'json') {
    // json 格式：把 content 解析后美化输出，或直接写入。
    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      jsonStr = content;
    }
    blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  } else if (format === 'txt') {
    blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  } else if (format === 'csv') {
    const csv = jsonData ? jsonToCsv(jsonData) : textToCsv(content);
    blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  } else {
    // xlsx
    const ws = jsonData ? XLSX.utils.json_to_sheet(jsonData) : XLSX.utils.json_to_sheet(
      content.split('\n').filter((line) => line.trim()).map((line) => ({ 内容: line })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '数据');
    const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const url = URL.createObjectURL(blob);
  const file: GeneratedFile = {
    id: `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    filename: `${filename}.${ext}`,
    size: blob.size,
    createdAt: new Date().toISOString(),
    url,
    format,
    isImage: false,
  };
  generatedFiles.unshift(file);

  // 最多保留 20 个文件，避免内存泄漏。旧的 URL 释放掉。
  while (generatedFiles.length > 20) {
    const old = generatedFiles.pop();
    if (old && !old.isImage) URL.revokeObjectURL(old.url);
    // 截图用的是 dataUrl，不需要 revoke
  }

  return file;
}

/**
 * 存储截图，供 UI 展示。
 * 截图的 url 是 dataUrl（base64），不需要创建 Blob。
 */
export function generateScreenshot(dataUrl: string, format: ScreenshotFormat, width: number, height: number): GeneratedFile {
  // 估算大小：base64 字符串长度 * 0.75 ≈ 原始字节数。
  const size = Math.floor(dataUrl.length * 0.75);
  const file: GeneratedFile = {
    id: `screenshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    filename: `截图-${generatedFiles.filter((f) => f.isImage).length + 1}.${format}`,
    size,
    createdAt: new Date().toISOString(),
    url: dataUrl,
    format,
    isImage: true,
    width,
    height,
  };
  generatedFiles.unshift(file);

  while (generatedFiles.length > 20) {
    const old = generatedFiles.pop();
    if (old && !old.isImage) URL.revokeObjectURL(old.url);
  }

  return file;
}

/** 删除一个已生成的文件。 */
export function removeGeneratedFile(id: string): void {
  const index = generatedFiles.findIndex((file) => file.id === id);
  if (index < 0) return;
  const [removed] = generatedFiles.splice(index, 1);
  URL.revokeObjectURL(removed.url);
}

/** JSON 数组转 CSV 字符串。 */
function jsonToCsv(data: unknown[]): string {
  if (data.length === 0) return '';
  const first = data[0] as Record<string, unknown>;
  const headers = Object.keys(first);
  const rows = data.map((item) => {
    const record = item as Record<string, unknown>;
    return headers.map((header) => escapeCsvValue(record[header])).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

/** 纯文本转 CSV（每行一条记录，单列）。 */
function textToCsv(text: string): string {
  return text.split('\n').map((line) => escapeCsvValue(line)).join('\n');
}

/** CSV 值转义。 */
function escapeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * 导出对话记录（旧功能，保留）。
 * 与 generateFile 的区别：这个是把整个对话记录导出，不是 agent 产出的数据。
 */
export async function exportFile(options: { filename: string; format: 'txt' | 'csv' | 'xlsx'; content: string }): Promise<{ ok: boolean; message: string }> {
  const { filename, format, content } = options;
  const file = generateFile(filename, format, content);
  // 立即触发下载（旧行为）。
  const a = document.createElement('a');
  a.href = file.url;
  a.download = file.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return { ok: true, message: `已导出 ${file.filename}` };
}
