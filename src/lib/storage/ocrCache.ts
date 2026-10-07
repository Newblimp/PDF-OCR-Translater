/**
 * Local-only cache of OCR results in IndexedDB, keyed by the SHA-256 of the
 * file bytes, the OCR model and the selected pages. Lets "Translate only"
 * and "OCR + Translate" reuse an earlier OCR run without paying for it again,
 * and survives page reloads. Nothing here leaves the browser.
 */
import type { OcrResponse } from "../mistral/types";
import { evictOldest, OCR_STORE, requestToPromise, withStore } from "./db";

/** Bump when the cached response shape changes; older entries are ignored. */
export const OCR_CACHE_VERSION = 2;

/** Keep the newest entries only; OCR responses carry bounding-box images and can be large. */
export const OCR_CACHE_MAX_ENTRIES = 20;

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

export async function getCachedOcr(key: string): Promise<OcrCacheEntry | null> {
  try {
    const entry = await withStore(OCR_STORE, "readonly", (objects) => requestToPromise(objects.get(key) as IDBRequest<OcrCacheEntry | undefined>));
    if (entry && entry.version !== OCR_CACHE_VERSION) {
      void deleteCachedOcr(key); // stale shape from an older release
      return null;
    }
    return entry ?? null;
  } catch {
    return null;
  }
}

async function deleteCachedOcr(key: string): Promise<void> {
  try {
    await withStore(OCR_STORE, "readwrite", (objects) => void objects.delete(key));
  } catch {
    // ignore
  }
}

export async function putCachedOcr(entry: OcrCacheEntry): Promise<void> {
  try {
    await withStore(OCR_STORE, "readwrite", async (objects) => {
      objects.put(entry);
      await evictOldest(objects, OCR_CACHE_MAX_ENTRIES, entry.key);
    });
  } catch {
    // Cache is best effort.
  }
}

export async function clearOcrCache(): Promise<void> {
  try {
    await withStore(OCR_STORE, "readwrite", (objects) => void objects.clear());
  } catch {
    // ignore
  }
}
