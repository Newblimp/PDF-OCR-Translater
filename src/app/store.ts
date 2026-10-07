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
import type { OcrText } from "@/lib/pipeline/ocrText";
import type { StructuredMode } from "@/lib/pipeline/translate";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import type { FileKind } from "@/lib/files/fileKind";
import type { SavedTranslationSummary, SourceKind } from "@/lib/storage/history";
import type { Settings } from "@/lib/storage/settings";

/**
 * "ocr", "translate" and "both" are the three action buttons; "original" fills
 * the JSON format in the document's own language on demand; "retry" re-runs
 * the bounding boxes or text blocks that failed.
 */
export type JobKind = "ocr" | "translate" | "both" | "original" | "retry";
/** Result tabs, in the order they are shown. "bboxes" is the default. */
export type ResultTab = "bboxes" | "ocr" | "structured" | "schema" | "json";

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
  text: OcrText;
  /** Document id the OCR belongs to. */
  docId: string;
  /** OCR model and pages the result was requested with (`ocrRequestKey()`): "OCR + Translate" reuses a result with the same key. */
  requestKey: string;
  /** Key of the result in this browser's OCR cache (null when the document hash is unknown). */
  cacheKey: string | null;
}

/** Whether `translation` was made from this OCR result (its text is exactly what was translated). */
export function ocrBelongsTo(ocr: OcrState, translation: Pick<TranslationState, "sourceText">): boolean {
  return ocr.text.text === translation.sourceText;
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
  /** The text that was translated (needed for on-demand follow-ups and re-runs). */
  sourceText: string;
  data: unknown;
  rawText: string;
  schema: JsonSchemaObject;
  schemaSource: "inferred" | "builtin" | "custom";
  schemaWarnings: string[];
  usage: TokenUsage | null;
  inferUsage: TokenUsage | null;
  provider: ProviderId;
  model: string;
  mode: StructuredMode;
  violations: string[];
  finishReason: string | null;
  /** The output was cut off and only the fields received before were kept. */
  partial: boolean;
  targetLanguage: string;
  completedAt: number;
  /** Characters of source text that were translated. */
  sourceChars: number;
  /** Bounding-box images handed to the vision model with the text. */
  imagesSent: number;
  /** Per-bounding-box descriptions by the vision model (empty when the stage did not run). */
  bboxAnnotations: BboxAnnotation[];
  bboxUsage: TokenUsage | null;
  /** Translation per OCR text block id (`${pageIndex}:${blockIndex}`), filled after the main translation. */
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
  activeTab: ResultTab;
  /**
   * Whether the OCR text and the structured text are shown translated or in
   * the document's own language ("Show translation" in both tabs).
   */
  showTranslation: boolean;
  /** Translations saved in this browser, newest first. */
  history: SavedTranslationSummary[];
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
  | { type: "translation/set"; translation: TranslationState | null }
  | { type: "translation/patch"; patch: Partial<TranslationState> }
  | { type: "job/start"; job: JobState }
  | { type: "job/event"; event: ProgressEvent }
  | { type: "job/end" }
  | { type: "error/set"; error: AppError | null }
  | { type: "tab/set"; tab: ResultTab }
  | { type: "view/translation"; show: boolean }
  | { type: "history/set"; history: SavedTranslationSummary[] }
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

export function initialState(keys: Record<ProviderId, string | null>, settings: Settings): AppState {
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
    activeTab: "bboxes",
    showTranslation: true,
    history: [],
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
      return { ...state, doc: action.doc, pasteMode: false, ocr: null, translation: null, error: null, activeTab: "bboxes" };
    case "doc/patch":
      if (!state.doc || state.doc.id !== action.id) return state;
      return { ...state, doc: { ...state.doc, ...action.patch } };
    case "doc/clear":
      return { ...state, doc: null, ocr: null, translation: null, error: null };
    case "paste/mode":
      return { ...state, pasteMode: action.enabled, error: null };
    case "paste/text":
      return { ...state, pastedText: action.text };
    case "ocr/set":
      // A fresh OCR result invalidates a translation made from the previous one.
      return { ...state, ocr: action.ocr, translation: action.ocr?.source === "api" ? null : state.translation };
    case "translation/set":
      return {
        ...state,
        translation: action.translation,
        // An OCR result reopened from "Recent translations" (no document) leaves with the translation it came with
        // when a translation of something else (pasted text) replaces it.
        ocr: !state.doc && state.ocr && action.translation && !ocrBelongsTo(state.ocr, action.translation) ? null : state.ocr,
        activeTab: action.translation ? "structured" : state.activeTab,
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
      const activeTab: ResultTab = ev.streamText && !state.job.streamText && !state.translation ? "structured" : state.activeTab;
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
        activeTab,
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
      return { ...state, activeTab: action.tab };
    case "view/translation":
      return { ...state, showTranslation: action.show };
    case "history/set":
      return { ...state, history: action.history };
    case "history/open":
      return {
        ...state,
        doc: null,
        pasteMode: action.pastedText !== null,
        pastedText: action.pastedText ?? state.pastedText,
        ocr: action.ocr,
        translation: action.translation,
        error: null,
        activeTab: "structured",
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

export function canRunOcr(state: AppState): boolean {
  return !state.job && !state.pasteMode && !!state.doc && (state.doc.kind === "pdf" || state.doc.kind === "image");
}
