/**
 * 统一的文件存储（IndexedDB + 内存镜像）。
 *
 * 合并了旧的两套系统：
 * - exportService 的内存 generatedFiles（截图 / xlsx 等二进制下载）
 * - fileStore 的 IndexedDB 文本文件
 *
 * 现在文本和二进制都存在 IndexedDB 的同一个 store，跨会话持久化。
 * 内存里保留一份元数据镜像（不含大字段），保证 generateFile / generateScreenshot
 * 可以同步返回（它们在工具执行器里被同步调用）。
 *
 * 设计要点：
 * - 截图的 base64 只留在本地，绝不进 LLM 上下文；模型只拿到 screenshotId。
 * - 文本文件（txt/csv/json/md 等）内容可被用户勾选后注入上下文。
 * - xlsx 是二进制，不能注入上下文，但可下载。
 */
import * as XLSX from 'xlsx';

export type SaveFileFormat = 'txt' | 'csv' | 'xlsx' | 'json' | 'md';
export type ScreenshotFormat = 'png' | 'jpeg';
export type GeneratedFormat = SaveFileFormat | ScreenshotFormat;

export interface GeneratedFile {
  /** 唯一标识，用于 UI 管理和模型引用。 */
  id: string;
  /** 文件名（含扩展名）。 */
  filename: string;
  /** 文件大小（字节）。 */
  size: number;
  /** 创建时间。 */
  createdAt: string;
  /** 文件格式。 */
  format: GeneratedFormat;
  /** 是否是图片（截图）。 */
  isImage: boolean;
  /** 图片宽度（仅截图有）。 */
  width?: number;
  /** 图片高度（仅截图有）。 */
  height?: number;
  /**
   * Blob URL，用于下载和 <img> 展示。启动时从 IndexedDB 重建，删除时 revoke。
   */
  url: string;
  /**
   * 文本内容。仅文本格式（txt/csv/json/md）有；截图和 xlsx 为 undefined。
   * 供「勾选注入上下文」和 read_file 使用。
   */
  text?: string;
}

const DB_NAME = 'boos-file-store';
const DB_VERSION = 2;
const STORE = 'files';

/** IndexedDB 里存的完整记录（含 Blob，不含 blob: URL）。 */
interface StoredRecord {
  id: string;
  filename: string;
  size: number;
  createdAt: string;
  format: GeneratedFormat;
  isImage: boolean;
  width?: number;
  height?: number;
  text?: string;
  blob: Blob;
}

// 内存镜像：id -> 元数据（含 url，不含 blob）。
const files = new Map<string, GeneratedFile>();
let dbPromise: Promise<IDBDatabase> | null = null;
let initialized = false;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 旧 store（'files' in old fileStore, keyPath:name）和 v2 新结构冲突。
      // v2 直接重建：旧数据是纯文本，用户重新上传即可，不值得写迁移。
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function putRecord(record: StoredRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecords(): Promise<StoredRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as StoredRecord[]);
    request.onerror = () => reject(request.error);
  });
}

async function deleteRecord(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearStore(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function recordToFile(record: StoredRecord): GeneratedFile {
  return {
    id: record.id,
    filename: record.filename,
    size: record.size,
    createdAt: record.createdAt,
    format: record.format,
    isImage: record.isImage,
    url: URL.createObjectURL(record.blob),
    ...(record.width !== undefined ? { width: record.width } : {}),
    ...(record.height !== undefined ? { height: record.height } : {}),
    ...(record.text !== undefined ? { text: record.text } : {}),
  };
}

function fileToRecord(file: GeneratedFile, blob: Blob): StoredRecord {
  return {
    id: file.id,
    filename: file.filename,
    size: file.size,
    createdAt: file.createdAt,
    format: file.format,
    isImage: file.isImage,
    blob,
    ...(file.width !== undefined ? { width: file.width } : {}),
    ...(file.height !== undefined ? { height: file.height } : {}),
    ...(file.text !== undefined ? { text: file.text } : {}),
  };
}

/**
 * 启动时调用一次：把 IndexedDB 里的文件加载进内存镜像，重建 Blob URL。
 * 幂等。失败不抛出（IndexedDB 不可用时退化为纯内存）。
 */
export async function initFileStore(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    for (const record of await getAllRecords()) {
      files.set(record.id, recordToFile(record));
    }
  } catch {
    // IndexedDB 不可用：纯内存模式，刷新后丢失，但不影响本次会话。
  }
}

/** 是否为可注入上下文的文本格式。 */
export function isTextFormat(format: GeneratedFormat): boolean {
  return format === 'txt' || format === 'csv' || format === 'json' || format === 'md';
}

/** 获取所有文件（按创建时间倒序）。 */
export function getGeneratedFiles(): GeneratedFile[] {
  return [...files.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 按 id 取文件。 */
export function getFile(id: string): GeneratedFile | undefined {
  return files.get(id);
}

/**
 * 从 agent 传入的数据生成文件，返回文件信息。
 * 同步返回（工具执行器需要），持久化在后台进行。
 */
export function generateFile(filename: string, format: SaveFileFormat, content: string): GeneratedFile {
  let blob: Blob;
  let text: string | undefined = content;
  const ext = format;

  let jsonData: unknown[] | null = null;
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) jsonData = parsed;
  } catch {
    // 不是 JSON，按纯文本处理。
  }

  if (format === 'json') {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      text = content;
    }
    blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  } else if (format === 'txt' || format === 'md') {
    blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  } else if (format === 'csv') {
    text = jsonData ? jsonToCsv(jsonData) : textToCsv(content);
    blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  } else {
    // xlsx：二进制，不保留 text
    const ws = jsonData ? XLSX.utils.json_to_sheet(jsonData) : XLSX.utils.json_to_sheet(
      content.split('\n').filter((line) => line.trim()).map((line) => ({ 内容: line })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '数据');
    const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    text = undefined;
  }

  const file: GeneratedFile = {
    id: makeId('file'),
    filename: `${filename}.${ext}`,
    size: blob.size,
    createdAt: new Date().toISOString(),
    url: URL.createObjectURL(blob),
    format,
    isImage: false,
    ...(text !== undefined ? { text } : {}),
  };
  files.set(file.id, file);
  void putRecord(fileToRecord(file, blob));
  return file;
}

/**
 * 存储截图。dataUrl 是 base64，转成 Blob 后存 IndexedDB。
 * 同步返回（先用 dataUrl 作为 <img src> 保证立即可见），后台转 Blob 并持久化。
 */
export function generateScreenshot(dataUrl: string, format: ScreenshotFormat, width: number, height: number): GeneratedFile {
  const file: GeneratedFile = {
    id: makeId('screenshot'),
    filename: `截图-${[...files.values()].filter((f) => f.isImage).length + 1}.${format}`,
    size: Math.floor(dataUrl.length * 0.75),
    createdAt: new Date().toISOString(),
    // 先用 dataUrl，保证截图立即可见；后台替换成 blob: URL。
    url: dataUrl,
    format,
    isImage: true,
    width,
    height,
  };
  files.set(file.id, file);

  void (async () => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await putRecord(fileToRecord(file, blob));
      // 用 blob: URL 替换 data: URL，释放 base64 字符串占用的内存。
      const objectUrl = URL.createObjectURL(blob);
      const current = files.get(file.id);
      if (current) {
        if (current.url.startsWith('data:')) URL.revokeObjectURL(current.url);
        files.set(file.id, { ...current, url: objectUrl, size: blob.size });
      }
    } catch {
      // 转换失败也无所谓：dataUrl 仍能显示，只是不持久化。
    }
  })();

  return file;
}

/** 删除一个文件。 */
export function removeGeneratedFile(id: string): void {
  const file = files.get(id);
  if (!file) return;
  files.delete(id);
  URL.revokeObjectURL(file.url);
  void deleteRecord(id);
}

/** 清空所有文件。 */
export async function clearAllFiles(): Promise<void> {
  for (const file of files.values()) URL.revokeObjectURL(file.url);
  files.clear();
  try {
    await clearStore();
  } catch {
    // 内存已清空即可。
  }
}

/**
 * 导出对话记录（旧功能，保留）。立即触发下载。
 */
export async function exportFile(options: { filename: string; format: 'txt' | 'csv' | 'xlsx'; content: string }): Promise<{ ok: boolean; message: string }> {
  const { filename, format, content } = options;
  const file = generateFile(filename, format, content);
  const a = document.createElement('a');
  a.href = file.url;
  a.download = file.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return { ok: true, message: `已导出 ${file.filename}` };
}

// --- 供 browser_read_file / browser_write_file 工具使用的 API ---

/** 写入或更新一个文本文件（按文件名）。 */
export async function writeFile(name: string, content: string): Promise<{ id: string; name: string; size: number; updatedAt: string }> {
  const existing = [...files.values()].find((f) => f.filename === name && isTextFormat(f.format));
  if (existing) removeGeneratedFile(existing.id);

  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = (dot > 0 ? name.slice(dot + 1) : 'txt').toLowerCase() as SaveFileFormat;
  const format = isTextFormat(ext as GeneratedFormat) ? ext : 'txt';
  const file = generateFile(base, format, content);
  return { id: file.id, name: file.filename, size: file.size, updatedAt: file.createdAt };
}

/** 读取单个文本文件（按文件名或 id）。 */
export async function readFile(nameOrId: string): Promise<{ name: string; content: string; size: number } | undefined> {
  const byId = files.get(nameOrId);
  const file = byId ?? [...files.values()].find((f) => f.filename === nameOrId);
  if (!file || file.text === undefined) return undefined;
  return { name: file.filename, content: file.text, size: file.size };
}

/** 列出所有文本文件的元信息（不含 content）。 */
export async function listFiles(): Promise<Array<{ id: string; name: string; size: number; updatedAt: string }>> {
  return getGeneratedFiles()
    .filter((f) => f.text !== undefined)
    .map((f) => ({ id: f.id, name: f.filename, size: f.size, updatedAt: f.createdAt }));
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

function textToCsv(text: string): string {
  return text.split('\n').map((line) => escapeCsvValue(line)).join('\n');
}

function escapeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}
