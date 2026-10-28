/**
 * The app's IndexedDB database: OCR results (`ocrCache.ts`) and saved
 * translations (`history.ts`). Local to this browser; nothing here leaves it.
 */
const DB_NAME = "pdf-ocr-translater";
/** 1: OCR cache. 2: saved translations. 3: their summaries, so the list does not read every saved translation. */
const DB_VERSION = 3;

export const OCR_STORE = "ocr";
export const TRANSLATION_STORE = "translations";
/** Each saved translation without its `translation` (the large part): what "Recent translations" lists. */
export const TRANSLATION_SUMMARY_STORE = "translationSummaries";

/** A saved translation's summary record: the entry without its `translation`. */
export function withoutBody<T extends { translation?: unknown }>(entry: T): Omit<T, "translation"> {
  const { translation: _translation, ...summary } = entry;
  return summary;
}

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
      if (!db.objectStoreNames.contains(TRANSLATION_SUMMARY_STORE)) {
        const summaries = db.createObjectStore(TRANSLATION_SUMMARY_STORE, { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        // Translations saved before there were summaries: summarised once, in this upgrade (it completes before the database opens).
        const saved = req.transaction!.objectStore(TRANSLATION_STORE).openCursor();
        saved.onsuccess = () => {
          const cursor = saved.result;
          if (!cursor) return;
          summaries.put(withoutBody(cursor.value as { translation?: unknown }));
          cursor.continue();
        };
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
export function withStore<T>(store: string, mode: IDBTransactionMode, fn: (objects: IDBObjectStore) => Promise<T> | T): Promise<T> {
  return withStores([store], mode, ([objects]) => fn(objects!));
}

/** Run `fn` in one transaction on several stores (its writes land together or not at all) and close the database afterwards. */
export async function withStores<T>(stores: string[], mode: IDBTransactionMode, fn: (objects: IDBObjectStore[]) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(stores, mode);
    const done = transactionDone(tx);
    const result = await fn(stores.map((store) => tx.objectStore(store)));
    await done;
    return result;
  } finally {
    db.close();
  }
}

/**
 * Delete the oldest entries (by the `createdAt` index of `objects`) beyond
 * `max`, never `keep`, from `objects` and from the stores in `alsoFrom` (the
 * same keys). Call inside a readwrite transaction.
 */
export async function evictOldest(objects: IDBObjectStore, max: number, keep: IDBValidKey, alsoFrom: IDBObjectStore[] = []): Promise<void> {
  const keys = await requestToPromise(objects.index("createdAt").getAllKeys());
  // The oldest ones but `keep`: when it is among them (an older entry saved again), the next oldest goes instead.
  const evictable = keys.filter((key) => indexedDB.cmp(key, keep) !== 0);
  for (const key of evictable.slice(0, Math.max(0, keys.length - max))) {
    for (const store of [objects, ...alsoFrom]) store.delete(key);
  }
}
