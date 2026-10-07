/**
 * The app's IndexedDB database: OCR results (`ocrCache.ts`) and saved
 * translations (`history.ts`). Local to this browser; nothing here leaves it.
 */
const DB_NAME = "pdf-ocr-translater";
/** 1: OCR cache. 2: saved translations. */
const DB_VERSION = 2;

export const OCR_STORE = "ocr";
export const TRANSLATION_STORE = "translations";

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OCR_STORE)) {
        db.createObjectStore(OCR_STORE, { keyPath: "key" }).createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(TRANSLATION_STORE)) {
        db.createObjectStore(TRANSLATION_STORE, { keyPath: "id" }).createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
}

export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when the transaction commits; rejects when it fails or aborts. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Run `fn` in a transaction on `store` and close the database afterwards. */
export async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (objects: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(store, mode);
    const done = transactionDone(tx);
    const result = await fn(tx.objectStore(store));
    await done;
    return result;
  } finally {
    db.close();
  }
}

/** Delete the oldest entries (by the `createdAt` index) beyond `max`, never `keep`. Call inside a readwrite transaction. */
export async function evictOldest(objects: IDBObjectStore, max: number, keep: IDBValidKey): Promise<void> {
  const keys = await requestToPromise(objects.index("createdAt").getAllKeys());
  const excess = keys.length - max;
  for (const key of keys.slice(0, Math.max(0, excess))) if (key !== keep) objects.delete(key);
}
