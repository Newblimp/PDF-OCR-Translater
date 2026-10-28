import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { requestToPromise, TRANSLATION_STORE, TRANSLATION_SUMMARY_STORE, withStore } from "./db";
import {
  clearSavedTranslations,
  deleteSavedTranslation,
  findSavedTranslation,
  getSavedTranslation,
  HISTORY_MAX_ENTRIES,
  HISTORY_VERSION,
  listSavedTranslations,
  putSavedTranslation,
  type SavedTranslation,
} from "./history";

function entry(id: string, createdAt: number, patch: Partial<SavedTranslation<{ big: string }>> = {}): SavedTranslation<{ big: string }> {
  return {
    id,
    version: HISTORY_VERSION,
    createdAt,
    sourceName: `${id}.pdf`,
    sourceKind: "pdf",
    sourceHash: `hash-${id}`,
    ocrKey: `ocr-${id}`,
    targetLanguage: "English",
    provider: "mistral",
    model: "mistral-small-latest",
    translation: { big: "x".repeat(1000) },
    ...patch,
  };
}

/** Everything in one store, as stored. */
function storeContents(store: string): Promise<Array<Record<string, unknown>>> {
  return withStore(store, "readonly", (objects) => requestToPromise(objects.getAll() as IDBRequest<Array<Record<string, unknown>>>));
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // a fresh, empty database per test
});

describe("saved translations", () => {
  it("lists summaries (newest first) without reading the translations, and opens one whole", async () => {
    await putSavedTranslation(entry("a", 1));
    await putSavedTranslation(entry("b", 2));
    const { translation: _a, version: _v, ...summaryA } = entry("a", 1);
    expect(await listSavedTranslations()).toEqual([expect.objectContaining({ id: "b" }), summaryA]);
    // The list's store holds no translation: listing never loads them.
    expect((await storeContents(TRANSLATION_SUMMARY_STORE)).some((s) => "translation" in s)).toBe(false);
    expect(await getSavedTranslation("a")).toEqual(entry("a", 1));
    expect((await findSavedTranslation("hash-b", "ocr-b"))?.id).toBe("b");
    expect(await findSavedTranslation("hash-b", "another OCR result")).toBeNull();
  });

  it("keeps the newest entries in both stores, never evicting the one just saved", async () => {
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 2; i++) await putSavedTranslation(entry(`e${i}`, 100 + i));
    // Saved last but dated first (createdAt is when it was translated): it stays.
    await putSavedTranslation(entry("old", 0));
    const listed = (await listSavedTranslations()).map((s) => s.id);
    expect(listed).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(listed).toContain("old");
    expect(listed).not.toContain("e0");
    expect((await storeContents(TRANSLATION_STORE)).map((e) => e["id"]).sort()).toEqual([...listed].sort());
  });

  it("deletes and clears both stores", async () => {
    await putSavedTranslation(entry("a", 1));
    await putSavedTranslation(entry("b", 2));
    await deleteSavedTranslation("a");
    expect((await listSavedTranslations()).map((s) => s.id)).toEqual(["b"]);
    expect(await getSavedTranslation("a")).toBeNull();
    await clearSavedTranslations();
    expect(await listSavedTranslations()).toEqual([]);
    expect(await storeContents(TRANSLATION_STORE)).toEqual([]);
  });

  it("does not list entries of another HISTORY_VERSION", async () => {
    await putSavedTranslation(entry("now", 2));
    await putSavedTranslation(entry("then", 1, { version: HISTORY_VERSION + 1 }));
    expect((await listSavedTranslations()).map((s) => s.id)).toEqual(["now"]);
    expect(await getSavedTranslation("then")).toBeNull();
  });

  it("summarises the translations saved before summaries existed when the database is upgraded", async () => {
    // A database as the previous release left it (version 2: the OCR cache and whole translations).
    const open = indexedDB.open("pdf-ocr-translater", 2);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("ocr", { keyPath: "key" }).createIndex("createdAt", "createdAt");
      const translations = open.result.createObjectStore("translations", { keyPath: "id" });
      translations.createIndex("createdAt", "createdAt");
      translations.put(entry("saved-before", 5));
    };
    (await requestToPromise(open)).close();

    expect((await listSavedTranslations()).map((s) => s.id)).toEqual(["saved-before"]);
    expect(await getSavedTranslation("saved-before")).toEqual(entry("saved-before", 5));
    // Saving after the upgrade evicts from both stores as usual.
    await putSavedTranslation(entry("after", 6));
    expect((await listSavedTranslations()).map((s) => s.id)).toEqual(["after", "saved-before"]);
  });
});
