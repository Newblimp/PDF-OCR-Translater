import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/storage/settings";
import { initialState, missingKeys, reducer, requiredProviders, usableKey, type OcrState, type TranslationState } from "./store";

describe("streaming and OCR invalidation", () => {
  it("switches to the Translation tab when the first stream text arrives", () => {
    let state = initialState({ mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = { ...state, activeTab: "ocr" };
    state = reducer(state, {
      type: "job/start",
      job: { kind: "translate", startedAt: 0, events: [], currentStage: "prepare", receivedChars: 0, streamText: "", controller: new AbortController() },
    });
    expect(state.activeTab).toBe("ocr");
    state = reducer(state, { type: "job/event", event: { stage: "translate", status: "progress", message: "…", streamText: '{"a":', receivedChars: 5, timestamp: 0 } });
    expect(state.activeTab).toBe("translation");
    expect(state.job?.streamText).toBe('{"a":');
  });

  it("drops a translation when a new OCR result from the API replaces the old one", () => {
    let state = initialState({ mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const translation: TranslationState = { data: {}, rawText: "", schema: {}, schemaSource: "builtin", schemaWarnings: [], usage: null, inferUsage: null, provider: "openai", model: "m", mode: "json_schema", violations: [], finishReason: "stop", targetLanguage: "English", completedAt: 0, sourceChars: 0, imagesSent: 0, bboxAnnotations: [], bboxUsage: null, blockTranslations: {}, blockUsage: null };
    state = reducer(state, { type: "translation/set", translation });
    const ocr: OcrState = { source: "cache", model: "m", response: { model: "m", pages: [], usage_info: { pages_processed: 0 } }, text: { text: "", pages: [], bboxes: [], pagesProcessed: 0, chars: 0 }, docId: "d" };
    state = reducer(state, { type: "ocr/set", ocr });
    expect(state.translation).not.toBeNull();
    state = reducer(state, { type: "ocr/set", ocr: { ...ocr, source: "api" } });
    expect(state.translation).toBeNull();
  });
});

describe("key gating", () => {
  it("requires only the Mistral key when Mistral translates, both otherwise", () => {
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "mistral" })).toEqual(["mistral"]);
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "openai" })).toEqual(["mistral", "openai"]);
  });

  it("treats a rejected key as missing", () => {
    let state = initialState({ mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    expect(missingKeys(state)).toEqual([]);
    state = reducer(state, { type: "key/status", provider: "openai", status: "invalid", error: "nope" });
    expect(usableKey(state.keys, "openai")).toBeNull();
    expect(missingKeys(state)).toEqual(["openai"]);
    // Unverified (network trouble) keys stay usable.
    state = reducer(state, { type: "key/status", provider: "openai", status: "unverified" });
    expect(missingKeys(state)).toEqual([]);
  });

  it("opens the key dialog initially only when a required key is missing", () => {
    expect(initialState({ mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "mistral" }).keyDialogOpen).toBe(false);
    expect(initialState({ mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "openai" }).keyDialogOpen).toBe(true);
  });

  it("evaluates missing keys against explicitly passed settings", () => {
    const state = initialState({ mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "mistral" });
    expect(missingKeys(state, { ...state.settings, provider: "openai" })).toEqual(["openai"]);
  });
});
