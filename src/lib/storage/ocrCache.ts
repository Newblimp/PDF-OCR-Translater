/**
 * Local-only cache of OCR results in IndexedDB, keyed by the SHA-256 of the
 * file bytes and the OCR model. Lets "Translate only" reuse an earlier OCR
 * run without paying for it again, and survives page reloads.
 * Nothing here leaves the browser.
 */
import type { OcrResponse } from "../mistral/types";

const DB_NAME = "pdf-ocr-translater";
const DB_VERSION = 1;
const STORE = "ocr";

/** Bump when the cached response shape changes; older entries are ignored. */
export const OCR_CACHE_VERSION = 2;

export interface OcrCacheEntry {
  key: string;
  version?: number;
  fileName: string;
  fileSize: number;
  model: string;
  createdAt: number;
  response: OcrResponse;
}

export function ocrCacheKey(fileHash: string, model: string, pages: number[] | null = null): string {
  return `${fileHash}:${model}${pages?.length ? `:p${pages.join(",")}` : ""}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function getCachedOcr(key: string): Promise<OcrCacheEntry | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const entry = await requestToPromise(tx.objectStore(STORE).get(key) as IDBRequest<OcrCacheEntry | undefined>);
    db.close();
    if (entry && entry.version !== OCR_CACHE_VERSION) {
      void deleteCachedOcr(key); // stale shape from an older release
      return null;
    }
    return entry ?? null;
  } catch {
    return null;
  }
}

/** Keep the newest entries only; OCR responses now carry bounding-box images and can be large. */
export const OCR_CACHE_MAX_ENTRIES = 20;

async function deleteCachedOcr(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function putCachedOcr(entry: OcrCacheEntry): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(entry);
    // Evict the oldest entries beyond the cap (the createdAt index is ascending).
    const keys = await requestToPromise(store.index("createdAt").getAllKeys() as IDBRequest<IDBValidKey[]>);
    const excess = keys.length - OCR_CACHE_MAX_ENTRIES;
    if (excess > 0) {
      const oldest = await requestToPromise(store.index("createdAt").getAll(undefined, excess) as IDBRequest<OcrCacheEntry[]>);
      for (const old of oldest) if (old.key !== entry.key) store.delete(old.key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
    db.close();
  } catch {
    // Cache is best effort.
  }
}

export async function clearOcrCache(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // ignore
  }
}
