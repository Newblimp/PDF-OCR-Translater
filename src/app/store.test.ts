import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/storage/settings";
import { dockGroups } from "@/lib/util/dock";
import {
  excludedBlocks,
  initialState,
  makeOcrState,
  missingKeys,
  ocrBelongsTo,
  reducer,
  requiredProviders,
  restoredTranslation,
  selectSourceText,
  selectTextPages,
  translationDefaults,
  usableKey,
  type AppState,
  type OcrState,
  type TranslationState,
} from "./store";

const WITH_JSON = { ...DEFAULT_SETTINGS, jsonOutput: true };

/** The result tab each group shows. */
function shownTabs(state: AppState): string[] {
  return dockGroups(state.resultLayout).map((g) => g.active);
}

function translationFixture(patch: Partial<TranslationState> = {}): TranslationState {
  return {
    ...translationDefaults(),
    id: "t1",
    sourceName: "doc.pdf",
    sourceKind: "pdf",
    sourceHash: null,
    ocrKey: null,
    sourceText: "源文本",
    data: {},
    schema: {},
    schemaSource: "builtin",
    provider: "openai",
    model: "m",
    mode: "json_schema",
    finishReason: "stop",
    targetLanguage: "English",
    completedAt: 0,
    sourceChars: 0,
    ...patch,
  };
}

describe("streaming and OCR invalidation", () => {
  it("switches to the Structured text tab when the first stream text arrives", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, { type: "tab/set", tab: "ocr" });
    state = reducer(state, {
      type: "job/start",
      job: { kind: "translate", startedAt: 0, stages: ["translate"], events: [], receivedChars: {}, streamText: "", controller: new AbortController() },
    });
    expect(shownTabs(state)).toEqual(["ocr"]);
    state = reducer(state, {
      type: "job/event",
      event: { stage: "translate", status: "progress", message: "…", streamText: '{"a":', receivedChars: 5, timestamp: 0 },
    });
    expect(shownTabs(state)).toEqual(["structured"]);
    expect(state.job?.streamText).toBe('{"a":');
    expect(state.job?.receivedChars).toEqual({ translate: 5 });
  });

  it("keeps one progress event per stage while stages run side by side", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, {
      type: "job/start",
      job: {
        kind: "translate",
        startedAt: 0,
        stages: ["translate", "bbox_annotate"],
        events: [],
        receivedChars: {},
        streamText: "",
        controller: new AbortController(),
      },
    });
    const ev = (stage: "translate" | "bbox_annotate", message: string, status: "start" | "progress" = "progress") => ({
      type: "job/event" as const,
      event: { stage, status, message, timestamp: 0 },
    });
    for (const action of [
      ev("translate", "start", "start"),
      ev("bbox_annotate", "start", "start"),
      ev("translate", "t1"),
      ev("bbox_annotate", "b1"),
      ev("translate", "t2"),
      ev("bbox_annotate", "b2"),
    ]) {
      state = reducer(state, action);
    }
    expect(state.job?.events.map((e) => e.message)).toEqual(["start", "start", "t2", "b2"]);
  });

  it("drops a translation when a new OCR result from the API replaces the old one", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const translation = translationFixture();
    state = reducer(state, { type: "translation/set", translation });
    const ocr: OcrState = makeOcrState({
      source: "cache",
      model: "m",
      response: { model: "m", pages: [], usage_info: { pages_processed: 0 } },
      base: { text: "", pages: [], bboxes: [], pagesProcessed: 0, chars: 0 },
      docId: "d",
      requestKey: "m|all",
      cacheKey: null,
    });
    state = reducer(state, { type: "ocr/set", ocr });
    expect(state.translation).not.toBeNull();
    state = reducer(state, { type: "ocr/set", ocr: { ...ocr, source: "api" } });
    expect(state.translation).toBeNull();
  });
});

describe("result tabs", () => {
  it("starts on the bounding boxes tab and shows the structured text once a translation arrives (JSON output on)", () => {
    const state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, WITH_JSON);
    expect(shownTabs(state)).toEqual(["bboxes"]);
    expect(state.showTranslation).toBe(true);
    const translation = translationFixture();
    const withTranslation = reducer(state, { type: "translation/set", translation });
    expect(shownTabs(withTranslation)).toEqual(["structured"]);
    expect(reducer(withTranslation, { type: "view/translation", show: false }).showTranslation).toBe(false);
  });

  it("shows the OCR text once a translation arrives without the JSON output, or for one made without a JSON format", () => {
    const state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    expect(shownTabs(reducer(state, { type: "translation/set", translation: translationFixture() }))).toEqual(["ocr"]);
    const withJson = initialState({ anthropic: "a", mistral: "m", openai: "o" }, WITH_JSON);
    const blocksOnly = translationFixture({ schema: null, schemaSource: null, mode: null, data: null, pages: [] });
    expect(shownTabs(reducer(withJson, { type: "translation/set", translation: blocksOnly }))).toEqual(["ocr"]);
  });

  it("shows a requested tab in its own group, leaving the other split views alone, until the layout is reset", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, WITH_JSON);
    state = reducer(state, { type: "layout/move", tab: "ocr", target: { group: "g1", side: "right" } });
    expect(shownTabs(state)).toEqual(["bboxes", "ocr"]);
    state = reducer(state, { type: "translation/set", translation: translationFixture() });
    expect(shownTabs(state)).toEqual(["structured", "ocr"]);
    state = reducer(state, { type: "layout/reset" });
    expect(dockGroups(state.resultLayout).map((g) => g.tabs)).toEqual([["bboxes", "edit", "ocr", "structured", "schema", "json"]]);
  });
});

describe("history", () => {
  it("opens a saved translation without a document and offers its source text for a new translation", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, WITH_JSON);
    state = reducer(state, { type: "history/open", ocr: null, translation: translationFixture({ restored: true }), pastedText: null });
    expect(shownTabs(state)).toEqual(["structured"]);
    expect(selectSourceText(state)).toEqual({ text: "源文本", origin: "saved" });
    state = reducer(state, {
      type: "history/open",
      ocr: null,
      translation: translationFixture({ restored: true, sourceKind: "pasted" }),
      pastedText: "源文本",
    });
    expect(state.pasteMode).toBe(true);
    expect(selectSourceText(state)).toEqual({ text: "源文本", origin: "pasted" });
  });

  it("gives a translation saved by an earlier release the defaults of the fields added since", () => {
    const { pages: _pages, ocrFingerprint: _fingerprint, warnings: _warnings, blockTranslations: _blocks, ...older } = translationFixture({ id: "old" });
    const restored = restoredTranslation(older as TranslationState);
    expect(restored).toEqual(translationFixture({ id: "old", restored: true }));
    expect(restored).toMatchObject({ pages: null, ocrFingerprint: null, warnings: [], blockTranslations: {} });
    // What was saved wins over the defaults.
    expect(restoredTranslation(translationFixture({ warnings: ["w"], restored: false }))).toMatchObject({ warnings: ["w"], restored: true });
  });

  it("keeps a saved source translatable after it was translated again", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, { type: "history/open", ocr: null, translation: translationFixture({ restored: true }), pastedText: null });
    state = reducer(state, { type: "translation/set", translation: translationFixture({ id: "t2", restored: false }) });
    expect(selectSourceText(state)).toEqual({ text: "源文本", origin: "saved" });
  });

  it("keeps a reopened OCR result (no document) until a translation of something else replaces its translation", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const ocr: OcrState = makeOcrState({
      source: "cache",
      model: "m",
      response: { model: "m", pages: [], usage_info: { pages_processed: 0 } },
      base: { text: "源文本", pages: [], bboxes: [], pagesProcessed: 0, chars: 3 },
      docId: "saved:t1",
      requestKey: "",
      cacheKey: "k",
    });
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

describe("block selection", () => {
  const page = { index: 0, markdown: "a", header: null, footer: null, imageCount: 0, width: 10, height: 10, blocks: [] };

  it("leaves blocks out for the pages they were picked on only", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const pages = [page];
    state = reducer(state, { type: "blocks/toggle", pages, id: "0:1" });
    state = reducer(state, { type: "blocks/toggle", pages, id: "0:2" });
    expect([...excludedBlocks(state, pages)]).toEqual(["0:1", "0:2"]);
    expect(excludedBlocks(state, [{ ...page }]).size).toBe(0);
    state = reducer(state, { type: "blocks/toggle", pages, id: "0:1" });
    expect([...excludedBlocks(state, pages)]).toEqual(["0:2"]);
    // Picking on other pages starts afresh.
    const other = [{ ...page }];
    state = reducer(state, { type: "blocks/toggle", pages: other, id: "0:3" });
    expect([...excludedBlocks(state, other)]).toEqual(["0:3"]);
    expect(excludedBlocks(state, pages).size).toBe(0);
    state = reducer(state, { type: "blocks/includeAll" });
    expect(excludedBlocks(state, other).size).toBe(0);
  });

  it("shows the blocks of a translation without its OCR result in the OCR text tab", () => {
    const pages = [page];
    const ocr: OcrState = makeOcrState({
      source: "api",
      model: "m",
      response: { model: "m", pages: [], usage_info: { pages_processed: 0 } },
      base: { text: "源文本", pages: [{ ...page }], bboxes: [], pagesProcessed: 1, chars: 3 },
      docId: "d",
      requestKey: "",
      cacheKey: null,
    });
    expect(selectTextPages({ ocr: null, translation: translationFixture({ pages }) })).toEqual({ pages, fromOcr: false });
    // Its own OCR result on screen: the OCR pages (where blocks are picked).
    expect(selectTextPages({ ocr, translation: translationFixture({ pages }) })).toEqual({ pages: ocr.text.pages, fromOcr: true });
    expect(selectTextPages({ ocr, translation: translationFixture({ pages, sourceText: "别的" }) })).toEqual({ pages, fromOcr: false });
    expect(selectTextPages({ ocr: null, translation: translationFixture() })).toBeNull();
  });
});

describe("box edits", () => {
  const block = (content: string, y: number) => ({ type: "text", top_left_x: 0, top_left_y: y, bottom_right_x: 10, bottom_right_y: y + 5, content });
  const base = {
    text: "甲\n\n乙",
    pages: [{ index: 0, markdown: "甲\n\n乙", header: null, footer: null, imageCount: 0, width: 10, height: 20, blocks: [block("甲", 0), block("乙", 10)] }],
    bboxes: [],
    pagesProcessed: 1,
    chars: 3,
  };
  const ocrState = () =>
    makeOcrState({
      source: "api",
      model: "m",
      response: { model: "m", pages: [], usage_info: { pages_processed: 1 } },
      base,
      docId: "d",
      requestKey: "",
      cacheKey: null,
    });

  it("applies edits on top of the OCR result, undoes them, and keeps blocks left out one by one", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    state = reducer(state, { type: "ocr/set", ocr: ocrState() });
    state = reducer(state, { type: "blocks/toggle", pages: state.ocr!.text.pages, id: "0:0" });
    const edits = { pages: { 0: [{ ...block("丙", 10), id: "0:e1" }] }, images: [], next: 2 };
    state = reducer(state, { type: "ocr/edit", edits });
    expect(state.ocr!.text.text).toBe("丙");
    expect(state.ocr!.base).toBe(base);
    expect([...excludedBlocks(state, state.ocr!.text.pages)]).toEqual(["0:0"]);
    state = reducer(state, { type: "ocr/undo" });
    expect(state.ocr!.text.text).toBe("甲\n\n乙");
    expect(state.ocr!.edits).toBeNull();
    expect(reducer(state, { type: "ocr/undo" })).toBe(state); // nothing left to undo
  });

  it("keeps a translation with its OCR result whatever was edited since", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    const ocr = ocrState();
    state = reducer(state, { type: "ocr/set", ocr });
    state = reducer(state, { type: "ocr/edit", edits: { pages: { 0: [{ ...block("丙", 10), id: "0:e1" }] }, images: [], next: 2 } });
    const edited = state.ocr!;
    // Made from the edited text, or from the text as returned: both belong; another OCR result does not.
    expect(ocrBelongsTo(edited, translationFixture({ sourceText: "丙", ocrFingerprint: ocr.fingerprint }))).toBe(true);
    expect(ocrBelongsTo(edited, translationFixture({ sourceText: "甲\n\n乙", ocrFingerprint: ocr.fingerprint }))).toBe(true);
    expect(ocrBelongsTo(edited, translationFixture({ sourceText: "丙", ocrFingerprint: "other" }))).toBe(false);
    // Saved before translations remembered the OCR result: by the text as returned.
    expect(ocrBelongsTo(edited, translationFixture({ sourceText: "甲\n\n乙", ocrFingerprint: null }))).toBe(true);
  });
});

describe("key gating", () => {
  it("requires only the Mistral key when Mistral translates, both otherwise", () => {
    expect(requiredProviders(DEFAULT_SETTINGS)).toEqual(["mistral"]);
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "anthropic" })).toEqual(["mistral", "anthropic"]);
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "openai" })).toEqual(["mistral", "openai"]);
  });

  it("treats a rejected key as missing", () => {
    let state = initialState({ anthropic: "a", mistral: "m", openai: "o" }, { ...DEFAULT_SETTINGS, provider: "anthropic" });
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
