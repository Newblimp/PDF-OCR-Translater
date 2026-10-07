import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/storage/settings";
import { initialState, missingKeys, reducer, requiredProviders, selectSourceText, usableKey, type OcrState, type TranslationState } from "./store";

function translationFixture(patch: Partial<TranslationState> = {}): TranslationState {
  return {
    id: "t1", sourceName: "doc.pdf", sourceKind: "pdf", sourceHash: null, ocrKey: null, sourceText: "源文本",
    data: {}, rawText: "", schema: {}, schemaSource: "builtin", schemaWarnings: [], usage: null, inferUsage: null, provider: "openai", model: "m",
    mode: "json_schema", violations: [], finishReason: "stop", partial: false, targetLanguage: "English", completedAt: 0, sourceChars: 0, imagesSent: 0,
    bboxAnnotations: [], bboxUsage: null, blockTranslations: {}, blockUsage: null, originalData: null, originalRawText: null, originalUsage: null,
    originalViolations: [], warnings: [], restored: false,
    ...patch,
  };
}

describe("streaming and OCR invalidation", () => {
  it("switches to the Structured text tab when the first stream text arrives", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = { ...state, activeTab: "ocr" };
    state = reducer(state, {
      type: "job/start",
      job: { kind: "translate", startedAt: 0, stages: ["translate"], events: [], receivedChars: {}, streamText: "", controller: new AbortController() },
    });
    expect(state.activeTab).toBe("ocr");
    state = reducer(state, { type: "job/event", event: { stage: "translate", status: "progress", message: "…", streamText: '{"a":', receivedChars: 5, timestamp: 0 } });
    expect(state.activeTab).toBe("structured");
    expect(state.job?.streamText).toBe('{"a":');
    expect(state.job?.receivedChars).toEqual({ translate: 5 });
  });

  it("keeps one progress event per stage while stages run side by side", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, {
      type: "job/start",
      job: { kind: "translate", startedAt: 0, stages: ["translate", "bbox_annotate"], events: [], receivedChars: {}, streamText: "", controller: new AbortController() },
    });
    const ev = (stage: "translate" | "bbox_annotate", message: string, status: "start" | "progress" = "progress") => ({ type: "job/event" as const, event: { stage, status, message, timestamp: 0 } });
    for (const action of [ev("translate", "start", "start"), ev("bbox_annotate", "start", "start"), ev("translate", "t1"), ev("bbox_annotate", "b1"), ev("translate", "t2"), ev("bbox_annotate", "b2")]) {
      state = reducer(state, action);
    }
    expect(state.job?.events.map((e) => e.message)).toEqual(["start", "start", "t2", "b2"]);
  });

  it("drops a translation when a new OCR result from the API replaces the old one", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const translation = translationFixture();
    state = reducer(state, { type: "translation/set", translation });
    const ocr: OcrState = { source: "cache", model: "m", response: { model: "m", pages: [], usage_info: { pages_processed: 0 } }, text: { text: "", pages: [], bboxes: [], pagesProcessed: 0, chars: 0 }, docId: "d", requestKey: "m|all", cacheKey: null };
    state = reducer(state, { type: "ocr/set", ocr });
    expect(state.translation).not.toBeNull();
    state = reducer(state, { type: "ocr/set", ocr: { ...ocr, source: "api" } });
    expect(state.translation).toBeNull();
  });
});

describe("result tabs", () => {
  it("starts on the bounding boxes tab and shows the structured text once a translation arrives", () => {
    const state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    expect(state.activeTab).toBe("bboxes");
    expect(state.showTranslation).toBe(true);
    const translation = translationFixture();
    const withTranslation = reducer(state, { type: "translation/set", translation });
    expect(withTranslation.activeTab).toBe("structured");
    expect(reducer(withTranslation, { type: "view/translation", show: false }).showTranslation).toBe(false);
  });
});

describe("history", () => {
  it("opens a saved translation without a document and offers its source text for a new translation", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, { type: "history/open", ocr: null, translation: translationFixture({ restored: true }), pastedText: null });
    expect(state.activeTab).toBe("structured");
    expect(selectSourceText(state)).toEqual({ text: "源文本", origin: "saved" });
    state = reducer(state, { type: "history/open", ocr: null, translation: translationFixture({ restored: true, sourceKind: "pasted" }), pastedText: "源文本" });
    expect(state.pasteMode).toBe(true);
    expect(selectSourceText(state)).toEqual({ text: "源文本", origin: "pasted" });
  });

  it("keeps a saved source translatable after it was translated again", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, { type: "history/open", ocr: null, translation: translationFixture({ restored: true }), pastedText: null });
    state = reducer(state, { type: "translation/set", translation: translationFixture({ id: "t2", restored: false }) });
    expect(selectSourceText(state)).toEqual({ text: "源文本", origin: "saved" });
  });

  it("keeps a reopened OCR result (no document) until a translation of something else replaces its translation", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const ocr: OcrState = { source: "cache", model: "m", response: { model: "m", pages: [], usage_info: { pages_processed: 0 } }, text: { text: "源文本", pages: [], bboxes: [], pagesProcessed: 0, chars: 3 }, docId: "saved:t1", requestKey: "", cacheKey: "k" };
    state = reducer(state, { type: "history/open", ocr, translation: translationFixture({ restored: true }), pastedText: null });
    expect(selectSourceText(state)?.origin).toBe("ocr");
    // Opening and closing the paste box loses nothing.
    state = reducer(state, { type: "paste/mode", enabled: true });
    state = reducer(state, { type: "paste/mode", enabled: false });
    expect(state.ocr).toBe(ocr);
    // A new translation of the same OCR text keeps it; a translation of pasted text drops it.
    state = reducer(state, { type: "translation/set", translation: translationFixture({ id: "t2" }) });
    expect(state.ocr).toBe(ocr);
    state = reducer(state, { type: "translation/set", translation: translationFixture({ id: "t3", sourceKind: "pasted", sourceText: "别的文本" }) });
    expect(state.ocr).toBeNull();
  });
});

describe("key gating", () => {
  it("requires only the Mistral key when Mistral translates, both otherwise", () => {
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "mistral" })).toEqual(["mistral"]);
    expect(requiredProviders(DEFAULT_SETTINGS)).toEqual(["mistral", "anthropic"]);
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "openai" })).toEqual(["mistral", "openai"]);
  });

  it("treats a rejected key as missing", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    expect(missingKeys(state)).toEqual([]);
    state = reducer(state, { type: "key/status", provider: "anthropic", status: "invalid", error: "nope" });
    expect(usableKey(state.keys, "anthropic")).toBeNull();
    expect(missingKeys(state)).toEqual(["anthropic"]);
    // Unverified (network trouble) keys stay usable.
    state = reducer(state, { type: "key/status", provider: "anthropic", status: "unverified" });
    expect(missingKeys(state)).toEqual([]);
  });

  it("opens the key dialog initially only when a required key is missing", () => {
    expect(initialState({ anthropic: null, mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "mistral" }).keyDialogOpen).toBe(false);
    expect(initialState({ anthropic: null, mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "openai" }).keyDialogOpen).toBe(true);
  });

  it("evaluates missing keys against explicitly passed settings", () => {
    const state = initialState({ anthropic: null, mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "mistral" });
    expect(missingKeys(state, { ...state.settings, provider: "openai" })).toEqual(["openai"]);
  });
});
