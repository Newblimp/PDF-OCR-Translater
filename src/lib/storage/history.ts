/**
 * Translations kept in this browser (IndexedDB), so a result survives a
 * reload and can be reopened from the "Recent translations" list. The OCR
 * result a translation was made from is restored from the OCR cache by key.
 * Nothing here leaves the browser.
 *
 * Each entry is kept twice: whole (`TRANSLATION_STORE`, read when one is
 * opened) and as its summary (`TRANSLATION_SUMMARY_STORE`, what the list
 * reads), written, evicted and deleted together in one transaction.
 */
import { evictOldest, requestToPromise, TRANSLATION_STORE, TRANSLATION_SUMMARY_STORE, withoutBody, withStore, withStores } from "./db";

/** Bump when the stored shape changes; older entries are ignored. */
export const HISTORY_VERSION = 1;
export const HISTORY_MAX_ENTRIES = 30;

export type SourceKind = "pdf" | "image" | "text" | "pasted";

export interface SavedTranslation<T> {
  id: string;
  version: number;
  createdAt: number;
  sourceName: string;
  sourceKind: SourceKind;
  /** SHA-256 of the document bytes (PDF/image) or of the text; null when unknown. */
  sourceHash: string | null;
  /** OCR cache key of the OCR result the translation was made from. */
  ocrKey: string | null;
  targetLanguage: string;
  provider: string;
  model: string;
  translation: T;
}

/** A summary as stored: the entry without its `translation`. */
type SummaryRecord = Omit<SavedTranslation<unknown>, "translation">;

export type SavedTranslationSummary = Omit<SummaryRecord, "version">;

/** Newest first. */
export async function listSavedTranslations(): Promise<SavedTranslationSummary[]> {
  try {
    const all = await withStore(TRANSLATION_SUMMARY_STORE, "readonly", (objects) => requestToPromise(objects.getAll() as IDBRequest<SummaryRecord[]>));
    return all
      .filter((e) => e.version === HISTORY_VERSION)
      .map(({ version: _version, ...summary }) => summary)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function getSavedTranslation<T>(id: string): Promise<SavedTranslation<T> | null> {
  try {
    const entry = await withStore(TRANSLATION_STORE, "readonly", (objects) => requestToPromise(objects.get(id) as IDBRequest<SavedTranslation<T> | undefined>));
    return entry && entry.version === HISTORY_VERSION ? entry : null;
  } catch {
    return null;
  }
}

/** The newest saved translation of the same source (and OCR result, when given). */
export async function findSavedTranslation<T>(sourceHash: string, ocrKey: string | null): Promise<SavedTranslation<T> | null> {
  const match = (await listSavedTranslations()).find((e) => e.sourceHash === sourceHash && (ocrKey === null || e.ocrKey === ocrKey));
  return match ? getSavedTranslation<T>(match.id) : null;
}

export async function putSavedTranslation<T>(entry: SavedTranslation<T>): Promise<void> {
  try {
    await withStores([TRANSLATION_STORE, TRANSLATION_SUMMARY_STORE], "readwrite", async ([entries, summaries]) => {
      entries!.put(entry);
      summaries!.put(withoutBody(entry));
      await evictOldest(summaries!, HISTORY_MAX_ENTRIES, entry.id, [entries!]);
    });
  } catch {
    // Best effort: the result is still on screen.
  }
}

export async function deleteSavedTranslation(id: string): Promise<void> {
  try {
    await withStores([TRANSLATION_STORE, TRANSLATION_SUMMARY_STORE], "readwrite", (stores) => stores.forEach((objects) => objects.delete(id)));
  } catch {
    // ignore
  }
}

export async function clearSavedTranslations(): Promise<void> {
  try {
    await withStores([TRANSLATION_STORE, TRANSLATION_SUMMARY_STORE], "readwrite", (stores) => stores.forEach((objects) => objects.clear()));
  } catch {
    // ignore
  }
}
