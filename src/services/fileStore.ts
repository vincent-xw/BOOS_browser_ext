/**
 * 基于 IndexedDB 的文本文件存储。
 *
 * 只存文本文件（txt/csv/json/md 等），不存二进制。
 * 跨会话持久化：用户选的文件和 agent 写入的文件都存在这里，下次会话直接可用。
 *
 * 二进制文件（xlsx）不存这里 -- 那是 browser_save_file 最后生成下载用的。
 */

export interface StoredFile {
  /** 文件名（含扩展名），唯一键。 */
  name: string;
  /** 文本内容。 */
  content: string;
  /** 文件大小（字节）。 */
  size: number;
  /** 创建/更新时间。 */
  updatedAt: string;
}

const DB_NAME = 'boos-file-store';
const DB_VERSION = 1;
const STORE_NAME = 'files';

/** 打开 IndexedDB。 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 写入或更新文件。 */
export async function writeFile(name: string, content: string): Promise<StoredFile> {
  const db = await openDB();
  const file: StoredFile = {
    name,
    content,
    size: new TextEncoder().encode(content).length,
    updatedAt: new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(file);
    tx.oncomplete = () => { resolve(file); db.close(); };
    tx.onerror = () => { reject(tx.error); db.close(); };
  });
}

/** 读取单个文件。 */
export async function readFile(name: string): Promise<StoredFile | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(name);
    request.onsuccess = () => { resolve(request.result as StoredFile | undefined); db.close(); };
    request.onerror = () => { reject(request.error); db.close(); };
  });
}

/** 列出全部文件（不含 content，避免大对象传输）。 */
export async function listFiles(): Promise<Array<Omit<StoredFile, 'content'>>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const files = (request.result as StoredFile[]).map(({ content, ...meta }) => meta);
      resolve(files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      db.close();
    };
    request.onerror = () => { reject(request.error); db.close(); };
  });
}

/** 删除文件。 */
export async function deleteFile(name: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(name);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror = () => { reject(tx.error); db.close(); };
  });
}
