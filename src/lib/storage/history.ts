/**
 * Translations kept in this browser (IndexedDB), so a result survives a
 * reload and can be reopened from the "Recent translations" list. The OCR
 * result a translation was made from is restored from the OCR cache by key.
 * Nothing here leaves the browser.
 */
import { evictOldest, requestToPromise, TRANSLATION_STORE, withStore } from "./db";

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

export type SavedTranslationSummary = Omit<SavedTranslation<unknown>, "translation" | "version">;

function summary<T>(entry: SavedTranslation<T>): SavedTranslationSummary {
  const { translation: _translation, version: _version, ...rest } = entry;
  return rest;
}

/** Newest first. */
export async function listSavedTranslations(): Promise<SavedTranslationSummary[]> {
  try {
    const all = await withStore(TRANSLATION_STORE, "readonly", (objects) => requestToPromise(objects.getAll() as IDBRequest<Array<SavedTranslation<unknown>>>));
    return all.filter((e) => e.version === HISTORY_VERSION).map(summary).sort((a, b) => b.createdAt - a.createdAt);
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
    await withStore(TRANSLATION_STORE, "readwrite", async (objects) => {
      objects.put(entry);
      await evictOldest(objects, HISTORY_MAX_ENTRIES, entry.id);
    });
  } catch {
    // Best effort: the result is still on screen.
  }
}

export async function deleteSavedTranslation(id: string): Promise<void> {
  try {
    await withStore(TRANSLATION_STORE, "readwrite", (objects) => void objects.delete(id));
  } catch {
    // ignore
  }
}

export async function clearSavedTranslations(): Promise<void> {
  try {
    await withStore(TRANSLATION_STORE, "readwrite", (objects) => void objects.clear());
  } catch {
    // ignore
  }
}
