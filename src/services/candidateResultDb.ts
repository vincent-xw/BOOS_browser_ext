const DB_NAME = 'boos-ext-db';
const DB_VERSION = 1;
const STORE_NAME = 'candidateResults';

export interface CandidateDbResult {
  /** Composite key: `${name}|${previewText}` */
  key: string;
  name: string;
  previewText: string;
  shouldFavorite: boolean;
  reason: string;
  processedAt: string;
  model: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function buildCandidateKey(name: string, previewText: string): string {
  return `${name}|${previewText}`;
}

export async function getResultsByKeys(
  keys: string[],
): Promise<Map<string, CandidateDbResult>> {
  if (!keys.length) return new Map();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const map = new Map<string, CandidateDbResult>();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result) map.set(key, req.result as CandidateDbResult);
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => {
      db.close();
      resolve(map);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveResults(results: CandidateDbResult[]): Promise<void> {
  if (!results.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const result of results) {
      store.put(result);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}
