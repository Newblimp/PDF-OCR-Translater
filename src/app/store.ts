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
import type { Settings } from "@/lib/storage/settings";

export type JobKind = "ocr" | "translate" | "both";
export type ResultTab = "translation" | "bboxes" | "ocr" | "schema" | "json";

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
}

export interface TranslationState {
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
}

export interface JobState {
  kind: JobKind;
  startedAt: number;
  events: ProgressEvent[];
  currentStage: StageId;
  receivedChars: number;
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
  | { type: "tab/set"; tab: ResultTab };

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
    activeTab: "translation",
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
      return { ...state, doc: action.doc, pasteMode: false, ocr: null, translation: null, error: null, activeTab: "translation" };
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
      return { ...state, translation: action.translation, activeTab: action.translation ? "translation" : state.activeTab };
    case "translation/patch":
      return state.translation ? { ...state, translation: { ...state.translation, ...action.patch } } : state;
    case "job/start":
      return { ...state, job: action.job, error: null };
    case "job/event": {
      if (!state.job) return state;
      const ev = action.event;
      const last = state.job.events.at(-1);
      // The live stream lives in the Translation tab: switch to it when streaming starts.
      const activeTab = ev.streamText && !state.job.streamText ? "translation" : state.activeTab;
      const events =
        ev.status === "progress" && last?.status === "progress" && last.stage === ev.stage
          ? [...state.job.events.slice(0, -1), ev]
          : [...state.job.events, ev];
      return {
        ...state,
        activeTab,
        job: {
          ...state.job,
          events,
          currentStage: ev.stage,
          receivedChars: ev.receivedChars ?? (ev.stage === state.job.currentStage ? state.job.receivedChars : 0),
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
    default:
      return state;
  }
}

// ----------------------------------------------------------------- selectors

/** Text that "Translate only" would use, and where it comes from. */
export function selectSourceText(state: AppState): { text: string; origin: "ocr" | "textfile" | "pasted" } | null {
  if (state.pasteMode) {
    const text = state.pastedText.trim();
    return text ? { text, origin: "pasted" } : null;
  }
  if (state.doc?.kind === "text" && state.doc.textContent?.trim()) {
    return { text: state.doc.textContent, origin: "textfile" };
  }
  if (state.ocr && state.doc && state.ocr.docId === state.doc.id && state.ocr.text.text.trim()) {
    return { text: state.ocr.text.text, origin: "ocr" };
  }
  return null;
}

export function canRunOcr(state: AppState): boolean {
  return !state.job && !state.pasteMode && !!state.doc && (state.doc.kind === "pdf" || state.doc.kind === "image");
}
