import * as XLSX from 'xlsx';

/**
 * 文件导出服务。
 *
 * 在扩展侧（浏览器内）生成 txt / csv / xlsx，通过 chrome.downloads 触发下载。
 * 不走 BFF -- 文件内容来自 agent 的对话结果，扩展侧已有。
 */

export type ExportFormat = 'txt' | 'csv' | 'xlsx';

export interface ExportOptions {
  /** 文件名（不含扩展名）。 */
  filename: string;
  /** 导出格式。 */
  format: ExportFormat;
  /** 文本内容（txt 直接用；csv/xlsx 按「每行一条记录」处理）。 */
  content: string;
}

/**
 * 生成并下载文件。
 *
 * txt：直接写文本。
 * csv：把文本按行拆成单列 CSV。
 * xlsx：把文本按行拆成单列，用 SheetJS 生成 .xlsx。
 *
 * 如果 content 是 JSON 数组，会尝试按对象的 keys 做表头、每条记录做一行。
 */
export async function exportFile(options: ExportOptions): Promise<{ ok: boolean; message: string }> {
  const { filename, format, content } = options;
  let blob: Blob;
  let ext: string;

  // 尝试解析为结构化数据（JSON 数组），否则按纯文本处理。
  let jsonData: unknown[] | null = null;
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) jsonData = parsed;
  } catch {
    // 不是 JSON，按纯文本处理。
  }

  if (format === 'txt') {
    blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    ext = 'txt';
  } else if (format === 'csv') {
    const csv = jsonData ? jsonToCsv(jsonData) : textToCsv(content);
    // BOM 让 Excel 正确识别 UTF-8。
    blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    ext = 'csv';
  } else {
    // xlsx
    const ws = jsonData ? jsonToSheet(jsonData) : textToSheet(content);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '结果');
    const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    ext = 'xlsx';
  }

  // 用 dataUrl + chrome.downloads 触发下载。
  const dataUrl = await blobToDataUrl(blob);
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: `${filename}.${ext}`,
      saveAs: true,
    });
    return { ok: true, message: `已导出 ${filename}.${ext}` };
  } catch (error) {
    return { ok: false, message: `导出失败：${error instanceof Error ? error.message : String(error)}` };
  }
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

/** JSON 数组转 SheetJS worksheet。 */
function jsonToSheet(data: unknown[]): XLSX.WorkSheet {
  return XLSX.utils.json_to_sheet(data);
}

/** 纯文本转 SheetJS worksheet（每行一条记录，列名「内容」）。 */
function textToSheet(text: string): XLSX.WorkSheet {
  const rows = text.split('\n').filter((line) => line.trim()).map((line) => ({ 内容: line }));
  return XLSX.utils.json_to_sheet(rows);
}

/** CSV 值转义：含逗号、引号、换行的用双引号包裹，内部引号双写。 */
function escapeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Blob 转 dataUrl，供 chrome.downloads.download 使用。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
