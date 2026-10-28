/**
 * Application state: a single reducer with typed actions.
 *
 * Keeping all state transitions here (rather than scattered `useState`s)
 * makes the flows easy to follow and to extend: add a field to `AppState`,
 * an action, and a `case` below.
 */
import type { ProviderId, TokenUsage } from "@/lib/llm/provider";
import { OCR_PROVIDER, perProvider } from "@/lib/llm/registry";
import type { ModelOption } from "@/lib/mistral/models";
import type { JsonSchemaObject, OcrResponse } from "@/lib/mistral/types";
import type { ProgressEvent, StageId } from "@/lib/pipeline/events";
import { applyEdits, type BlockEdits } from "@/lib/pipeline/blockEdits";
import type { OcrCleanPage, OcrText } from "@/lib/pipeline/ocrText";
import type { StructuredMode } from "@/lib/pipeline/translate";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import type { FileKind } from "@/lib/files/fileKind";
import type { SavedTranslationSummary, SourceKind } from "@/lib/storage/history";
import type { Settings } from "@/lib/storage/settings";
import { activateTab, moveTab, resizeSplit, singleGroup, type DockNode, type DockTarget } from "@/lib/util/dock";
import { textFingerprint } from "@/lib/util/text";

/**
 * "ocr", "translate" and "both" are the three action buttons; "original" fills
 * the JSON format in the document's own language on demand; "retry" re-runs
 * the bounding boxes or text blocks that failed.
 */
export type JobKind = "ocr" | "translate" | "both" | "original" | "retry" | "edit";
/** Result tabs, in their default order. "bboxes" is shown first. */
export const RESULT_TABS = ["bboxes", "edit", "ocr", "structured", "schema", "json"] as const;
export type ResultTab = (typeof RESULT_TABS)[number];

/** All result tabs in one group, as before the user arranges them. */
export function defaultResultLayout(): DockNode<ResultTab> {
  return singleGroup(RESULT_TABS);
}

export type KeyStatus = "missing" | "unverified" | "checking" | "valid" | "invalid";

export interface KeyState {
  value: string | null;
  status: KeyStatus;
  /** Message shown inside the key dialog when verification fails. */
  error: string | null;
}

export interface DocState {
  id: string;
  file: File;
  name: string;
  size: number;
  kind: FileKind;
  mimeType: string;
  hash: string | null;
  pageCount: number | null;
  previews: string[];
  previewStatus: "idle" | "loading" | "ready" | "error";
  previewError: string | null;
  /** Contents of a dropped .txt/.md file. */
  textContent: string | null;
  /** Pages to OCR as typed by the user (1-based, e.g. "1-3, 7"); empty = all pages. */
  pageSelection: string;
}

export interface OcrState {
  source: "api" | "cache";
  model: string;
  response: OcrResponse;
  /** The OCR text as the API returned it. */
  base: OcrText;
  /** The user's block edits ("Edit bounding boxes"); null for none. Kept in the OCR cache with the result. */
  edits: BlockEdits | null;
  /** Earlier states of `edits`, for undo (this session only). */
  undo: Array<BlockEdits | null>;
  /** `base` with the edits applied: what every view and the translation read. */
  text: OcrText;
  /** Identity of this OCR result (its text as returned): translations remember it, and edits do not change it. */
  fingerprint: string;
  /** Document id the OCR belongs to. */
  docId: string;
  /** OCR model and pages the result was requested with (`ocrRequestKey()`): "OCR + Translate" reuses a result with the same key. */
  requestKey: string;
  /** Key of the result in this browser's OCR cache (null when the document hash is unknown). */
  cacheKey: string | null;
}

/** An OCR state for an OCR result (as returned) and its saved edits. */
export function makeOcrState(fields: Omit<OcrState, "edits" | "undo" | "text" | "fingerprint"> & { edits?: BlockEdits | null }): OcrState {
  const edits = fields.edits ?? null;
  return { ...fields, edits, undo: [], text: applyEdits(fields.base, edits), fingerprint: textFingerprint(fields.base.text) };
}

/** How many edits "Undo" goes back. */
const UNDO_LIMIT = 50;

/**
 * Whether `translation` was made from this OCR result, whatever was edited
 * since (its block translations fit the blocks that were not changed).
 * Translations saved before edits existed name it by their text.
 */
export function ocrBelongsTo(ocr: OcrState, translation: Pick<TranslationState, "sourceText" | "ocrFingerprint">): boolean {
  return translation.ocrFingerprint ? translation.ocrFingerprint === ocr.fingerprint : translation.sourceText === ocr.base.text;
}

/** Identifies an OCR request of a document: the model and the selected pages (null = all). */
export function ocrRequestKey(model: string, pages: number[] | null): string {
  return `${model}|${pages?.length ? pages.join(",") : "all"}`;
}

export interface TranslationState {
  /** Id of the saved copy in this browser ("Recent translations"). */
  id: string;
  /** File name, or "Pasted text". */
  sourceName: string;
  sourceKind: SourceKind;
  /** SHA-256 of the document (or of the text), to find saved translations of the same source. */
  sourceHash: string | null;
  /** OCR cache key of the OCR result that was translated, to restore it with a saved translation. */
  ocrKey: string | null;
  /** `OcrState.fingerprint` of the OCR result that was translated (null for text input). */
  ocrFingerprint: string | null;
  /** The text that was translated (needed for on-demand follow-ups and re-runs). */
  sourceText: string;
  /**
   * The blocks of a translation made without the JSON format (OCR blocks, or
   * the paragraphs of text input), so it can be shown without its OCR
   * result. Null with the JSON format.
   */
  pages: OcrCleanPage[] | null;
  /** The JSON format filled with the translation; null without the JSON format (see `hasStructure()`). */
  data: unknown;
  rawText: string;
  schema: JsonSchemaObject | null;
  schemaSource: "inferred" | "builtin" | "custom" | null;
  schemaWarnings: string[];
  usage: TokenUsage | null;
  inferUsage: TokenUsage | null;
  provider: ProviderId;
  model: string;
  mode: StructuredMode | null;
  violations: string[];
  finishReason: string | null;
  /** The output was cut off and only the fields received before were kept. */
  partial: boolean;
  targetLanguage: string;
  completedAt: number;
  /** Characters of source text that were translated (the whole source, whatever the block filter left out). */
  sourceChars: number;
  /** Bounding-box images handed to the vision model with the text. */
  imagesSent: number;
  /** Per-bounding-box descriptions by the vision model (empty when the stage did not run). */
  bboxAnnotations: BboxAnnotation[];
  bboxUsage: TokenUsage | null;
  /** Translation per text block id (`${pageIndex}:${blockIndex}`): the translation without the JSON format, a follow-up with it. */
  blockTranslations: Record<string, string>;
  blockUsage: TokenUsage | null;
  /** Same JSON format filled in the document's own language; null until (or unless) that stage runs. */
  originalData: unknown;
  originalRawText: string | null;
  originalUsage: TokenUsage | null;
  originalViolations: string[];
  /** Follow-up stages that failed after the translation succeeded (shown as warnings, not as a failed job). */
  warnings: string[];
  /** Reopened from this browser's saved translations rather than produced in this session. */
  restored: boolean;
}

/**
 * Every field of a translation that a new one starts without (its stages
 * fill them in): the base of a new translation, and the defaults a
 * translation saved by an earlier release gets for fields added since.
 */
export function translationDefaults(): Omit<
  TranslationState,
  "id" | "sourceName" | "sourceKind" | "sourceHash" | "ocrKey" | "sourceText" | "provider" | "model" | "targetLanguage" | "completedAt" | "sourceChars"
> {
  return {
    ocrFingerprint: null,
    pages: null,
    data: null,
    rawText: "",
    schema: null,
    schemaSource: null,
    schemaWarnings: [],
    usage: null,
    inferUsage: null,
    mode: null,
    violations: [],
    finishReason: null,
    partial: false,
    imagesSent: 0,
    bboxAnnotations: [],
    bboxUsage: null,
    blockTranslations: {},
    blockUsage: null,
    originalData: null,
    originalRawText: null,
    originalUsage: null,
    originalViolations: [],
    warnings: [],
    restored: false,
  };
}

/** A saved translation back on screen, with the defaults of the fields it was saved without. */
export function restoredTranslation(saved: TranslationState): TranslationState {
  return { ...translationDefaults(), ...saved, restored: true };
}

export interface JobState {
  kind: JobKind;
  startedAt: number;
  /** The stages this job runs, in the order shown by the job status card. */
  stages: StageId[];
  events: ProgressEvent[];
  /** Characters received so far, per streaming stage. */
  receivedChars: Partial<Record<StageId, number>>;
  /** Partial translation text while it streams in. */
  streamText: string;
  controller: AbortController;
}

export interface AppError {
  title: string;
  message: string;
  hint?: string;
  details?: string;
}

export interface AppState {
  keys: Record<ProviderId, KeyState>;
  keyDialogOpen: boolean;
  models: Record<ProviderId, ModelOption[]>;
  settings: Settings;
  settingsOpen: boolean;
  doc: DocState | null;
  /** Text pasted by the user when no document is loaded. */
  pastedText: string;
  pasteMode: boolean;
  ocr: OcrState | null;
  translation: TranslationState | null;
  job: JobState | null;
  error: AppError | null;
  /**
   * The result tabs arranged in groups and split views (dragged around like
   * VS Code's editor tabs); each group shows one of its tabs.
   */
  resultLayout: DockNode<ResultTab>;
  /**
   * Whether the OCR text and the structured text are shown translated or in
   * the document's own language ("Show translation" in both tabs).
   */
  showTranslation: boolean;
  /** Translations saved in this browser, newest first. */
  history: SavedTranslationSummary[];
  /**
   * Blocks left out of the OCR text one by one (picked on the page), for the
   * pages they were picked on: other pages (another OCR result or
   * translation) start with none left out.
   */
  blockSelection: { pages: readonly OcrCleanPage[]; excluded: ReadonlySet<string> } | null;
}

/** Whether the translation filled a JSON format (made with "JSON output" on). */
export function hasStructure(t: TranslationState): t is TranslationState & { schema: JsonSchemaObject } {
  return t.schema !== null;
}

/** Whether the JSON format has been filled in the document's own language too ("Show translation" off). */
export function hasOriginal(t: TranslationState): boolean {
  return t.originalData !== null && t.originalData !== undefined;
}

/** The tab a translation opens on: the structured text with the JSON output, the OCR text without it. */
function translationTab(translation: TranslationState, settings: Settings): ResultTab {
  return settings.jsonOutput && hasStructure(translation) ? "structured" : "ocr";
}

export type Action =
  | { type: "key/set"; provider: ProviderId; key: string | null }
  | { type: "key/status"; provider: ProviderId; status: KeyStatus; error?: string | null }
  | { type: "key/dialog"; open: boolean }
  | { type: "models/set"; provider: ProviderId; models: ModelOption[] }
  | { type: "settings/update"; patch: Partial<Settings> }
  | { type: "settings/toggle"; open?: boolean }
  | { type: "doc/set"; doc: DocState }
  | { type: "doc/patch"; id: string; patch: Partial<DocState> }
  | { type: "doc/clear" }
  | { type: "paste/mode"; enabled: boolean }
  | { type: "paste/text"; text: string }
  | { type: "ocr/set"; ocr: OcrState | null }
  /** New block edits of the OCR result on screen (null: back to the OCR as returned); the previous ones can be undone. */
  | { type: "ocr/edit"; edits: BlockEdits | null }
  | { type: "ocr/undo" }
  | { type: "translation/set"; translation: TranslationState | null }
  | { type: "translation/patch"; patch: Partial<TranslationState> }
  | { type: "job/start"; job: JobState }
  | { type: "job/event"; event: ProgressEvent }
  | { type: "job/end" }
  | { type: "error/set"; error: AppError | null }
  /** Show a result tab (in whichever group it is). */
  | { type: "tab/set"; tab: ResultTab }
  | { type: "layout/move"; tab: ResultTab; target: DockTarget }
  | { type: "layout/resize"; split: string; sizes: number[] }
  | { type: "layout/reset" }
  | { type: "view/translation"; show: boolean }
  | { type: "history/set"; history: SavedTranslationSummary[] }
  /** Leave a block out of the OCR text, or take it back. */
  | { type: "blocks/toggle"; pages: readonly OcrCleanPage[]; id: string }
  | { type: "blocks/includeAll" }
  | { type: "history/open"; ocr: OcrState | null; translation: TranslationState; pastedText: string | null };

function keyState(value: string | null): KeyState {
  return { value, status: value ? "unverified" : "missing", error: null };
}

/** Providers whose key is required for the given settings (OCR provider first). */
export function requiredProviders(settings: Settings): ProviderId[] {
  return settings.provider === OCR_PROVIDER ? [OCR_PROVIDER] : [OCR_PROVIDER, settings.provider];
}

/** A key that can be used for requests: present and not known to be rejected. */
export function usableKey(keys: Record<ProviderId, KeyState>, provider: ProviderId): string | null {
  const k = keys[provider];
  return k.value && k.status !== "invalid" ? k.value : null;
}

/** Required providers without a usable key, for the given (or current) settings. */
export function missingKeys(state: AppState, settings: Settings = state.settings): ProviderId[] {
  return requiredProviders(settings).filter((p) => !usableKey(state.keys, p));
}

export function initialState(keys: Record<ProviderId, string | null>, settings: Settings, resultLayout = defaultResultLayout()): AppState {
  const state: AppState = {
    keys: perProvider((id) => keyState(keys[id])),
    keyDialogOpen: false,
    models: perProvider(() => []),
    settings,
    settingsOpen: false,
    doc: null,
    pastedText: "",
    pasteMode: false,
    ocr: null,
    translation: null,
    job: null,
    error: null,
    resultLayout,
    showTranslation: true,
    history: [],
    blockSelection: null,
  };
  state.keyDialogOpen = missingKeys(state).length > 0;
  return state;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "key/set":
      return { ...state, keys: { ...state.keys, [action.provider]: keyState(action.key) } };
    case "key/status":
      return {
        ...state,
        keys: { ...state.keys, [action.provider]: { ...state.keys[action.provider], status: action.status, error: action.error ?? null } },
      };
    case "key/dialog":
      return { ...state, keyDialogOpen: action.open };
    case "models/set":
      return { ...state, models: { ...state.models, [action.provider]: action.models } };
    case "settings/update":
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case "settings/toggle":
      return { ...state, settingsOpen: action.open ?? !state.settingsOpen };
    case "doc/set":
      return {
        ...state,
        doc: action.doc,
        pasteMode: false,
        ocr: null,
        translation: null,
        error: null,
        blockSelection: null,
        resultLayout: activateTab(state.resultLayout, "bboxes"),
      };
    case "doc/patch":
      if (!state.doc || state.doc.id !== action.id) return state;
      return { ...state, doc: { ...state.doc, ...action.patch } };
    case "doc/clear":
      return { ...state, doc: null, ocr: null, translation: null, error: null, blockSelection: null };
    case "paste/mode":
      return { ...state, pasteMode: action.enabled, error: null };
    case "paste/text":
      return { ...state, pastedText: action.text };
    case "ocr/set":
      // A fresh OCR result invalidates a translation made from the previous one.
      return { ...state, ocr: action.ocr, translation: action.ocr?.source === "api" ? null : state.translation, blockSelection: null };
    case "ocr/edit":
    case "ocr/undo": {
      const ocr = state.ocr;
      if (!ocr || (action.type === "ocr/undo" && !ocr.undo.length)) return state;
      const edits = action.type === "ocr/edit" ? action.edits : (ocr.undo[ocr.undo.length - 1] ?? null);
      const undo = action.type === "ocr/edit" ? [...ocr.undo, ocr.edits].slice(-UNDO_LIMIT) : ocr.undo.slice(0, -1);
      const text = applyEdits(ocr.base, edits);
      // Blocks left out one by one stay out: the ids of the blocks that were not changed hold.
      const blockSelection = state.blockSelection?.pages === ocr.text.pages ? { ...state.blockSelection, pages: text.pages } : state.blockSelection;
      return { ...state, ocr: { ...ocr, edits, undo, text }, blockSelection };
    }
    case "translation/set":
      return {
        ...state,
        translation: action.translation,
        // An OCR result reopened from "Recent translations" (no document) leaves with the translation it came with
        // when a translation of something else (pasted text) replaces it.
        ocr: !state.doc && state.ocr && action.translation && !ocrBelongsTo(state.ocr, action.translation) ? null : state.ocr,
        resultLayout: action.translation ? activateTab(state.resultLayout, translationTab(action.translation, state.settings)) : state.resultLayout,
        // The finished translation replaces the live stream view while follow-ups run.
        job: state.job && action.translation ? { ...state.job, streamText: "" } : state.job,
      };
    case "translation/patch":
      return state.translation ? { ...state, translation: { ...state.translation, ...action.patch } } : state;
    case "job/start":
      return { ...state, job: action.job, error: null };
    case "job/event": {
      if (!state.job) return state;
      const ev = action.event;
      // The live stream lives in the Structured text tab: switch to it when streaming starts.
      const resultLayout = ev.streamText && !state.job.streamText && !state.translation ? activateTab(state.resultLayout, "structured") : state.resultLayout;
      // Stages run concurrently: a progress event replaces the previous event of its stage when that was progress too.
      const events = [...state.job.events];
      let previous = events.length - 1;
      while (previous >= 0 && events[previous]!.stage !== ev.stage) previous--;
      if (ev.status === "progress" && previous >= 0 && events[previous]!.status === "progress") events.splice(previous, 1);
      // The stream text lives in `job.streamText`; events keep only the message.
      const { streamText: _streamText, ...stored } = ev;
      events.push(stored);
      return {
        ...state,
        resultLayout,
        job: {
          ...state.job,
          events,
          receivedChars: ev.receivedChars === undefined ? state.job.receivedChars : { ...state.job.receivedChars, [ev.stage]: ev.receivedChars },
          streamText: ev.streamText ?? state.job.streamText,
        },
      };
    }
    case "job/end":
      return { ...state, job: null };
    case "error/set":
      return { ...state, error: action.error };
    case "tab/set":
      return { ...state, resultLayout: activateTab(state.resultLayout, action.tab) };
    case "layout/move":
      return { ...state, resultLayout: moveTab(state.resultLayout, action.tab, action.target) };
    case "layout/resize":
      return { ...state, resultLayout: resizeSplit(state.resultLayout, action.split, action.sizes) };
    case "layout/reset":
      return { ...state, resultLayout: defaultResultLayout() };
    case "view/translation":
      return { ...state, showTranslation: action.show };
    case "history/set":
      return { ...state, history: action.history };
    case "blocks/toggle": {
      const excluded = new Set(state.blockSelection?.pages === action.pages ? state.blockSelection.excluded : []);
      if (!excluded.delete(action.id)) excluded.add(action.id);
      return { ...state, blockSelection: { pages: action.pages, excluded } };
    }
    case "blocks/includeAll":
      return { ...state, blockSelection: null };
    case "history/open":
      return {
        ...state,
        doc: null,
        pasteMode: action.pastedText !== null,
        pastedText: action.pastedText ?? state.pastedText,
        ocr: action.ocr,
        translation: action.translation,
        error: null,
        blockSelection: null,
        resultLayout: activateTab(state.resultLayout, translationTab(action.translation, state.settings)),
      };
    default:
      return state;
  }
}

// ----------------------------------------------------------------- selectors

export type SourceOrigin = "ocr" | "textfile" | "pasted" | "saved";

/** Text that "Translate only" would use, and where it comes from. */
export function selectSourceText(state: AppState): { text: string; origin: SourceOrigin } | null {
  if (state.pasteMode) {
    const text = state.pastedText.trim();
    return text ? { text, origin: "pasted" } : null;
  }
  if (state.doc?.kind === "text" && state.doc.textContent?.trim()) {
    return { text: state.doc.textContent, origin: "textfile" };
  }
  if (state.ocr && state.ocr.text.text.trim() && (state.doc ? state.ocr.docId === state.doc.id : true)) {
    // Without a document: an OCR result reopened from "Recent translations".
    return { text: state.ocr.text.text, origin: "ocr" };
  }
  if (!state.doc && !state.ocr && state.translation?.sourceText.trim()) {
    // A reopened translation whose OCR result is no longer cached (or a re-translation of it): its source text can be translated again.
    return { text: state.translation.sourceText, origin: "saved" };
  }
  return null;
}

/** The blocks left out one by one of these pages (none when they were picked on other pages). */
export function excludedBlocks(state: Pick<AppState, "blockSelection">, pages: readonly OcrCleanPage[]): ReadonlySet<string> {
  return state.blockSelection?.pages === pages ? state.blockSelection.excluded : NOTHING_EXCLUDED;
}
const NOTHING_EXCLUDED: ReadonlySet<string> = new Set();

/**
 * The pages the OCR text tab shows: the OCR result, or the blocks of a
 * translation made without the JSON format when the OCR result on screen is
 * not the one it was made from (text input, a saved translation whose OCR
 * result is no longer cached).
 */
export function selectTextPages(state: Pick<AppState, "ocr" | "translation">): { pages: OcrCleanPage[]; fromOcr: boolean } | null {
  const { ocr, translation } = state;
  if (translation?.pages && !(ocr && ocrBelongsTo(ocr, translation))) return { pages: translation.pages, fromOcr: false };
  return ocr ? { pages: ocr.text.pages, fromOcr: true } : null;
}

export function canRunOcr(state: AppState): boolean {
  return !state.job && !state.pasteMode && !!state.doc && (state.doc.kind === "pdf" || state.doc.kind === "image");
}
