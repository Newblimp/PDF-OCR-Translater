/**
 * Application state: a single reducer with typed actions.
 *
 * Keeping all state transitions here (rather than scattered `useState`s)
 * makes the flows easy to follow and to extend: add a field to `AppState`,
 * an action, and a `case` below.
 */
import type { ModelOption } from "@/lib/mistral/models";
import type { JsonSchemaObject, OcrResponse, UsageInfo } from "@/lib/mistral/types";
import type { ProgressEvent, StageId } from "@/lib/pipeline/events";
import type { OcrText } from "@/lib/pipeline/ocrText";
import type { StructuredMode } from "@/lib/pipeline/translate";
import type { FileKind } from "@/lib/files/fileKind";
import type { Settings } from "@/lib/storage/settings";

export type JobKind = "ocr" | "translate" | "both";
export type ResultTab = "translation" | "ocr" | "schema" | "json";

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
  usage: UsageInfo | null;
  inferUsage: UsageInfo | null;
  model: string;
  mode: StructuredMode;
  violations: string[];
  finishReason: string | null;
  targetLanguage: string;
  completedAt: number;
  /** Characters of source text that were translated. */
  sourceChars: number;
}

export interface JobState {
  kind: JobKind;
  startedAt: number;
  events: ProgressEvent[];
  currentStage: StageId;
  receivedChars: number;
  controller: AbortController;
}

export interface AppError {
  title: string;
  message: string;
  hint?: string;
  details?: string;
}

export interface AppState {
  apiKey: string | null;
  keyStatus: "missing" | "unverified" | "checking" | "valid" | "invalid";
  /** Message shown inside the key dialog when verification fails. */
  keyError: string | null;
  keyDialogOpen: boolean;
  models: ModelOption[];
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
  | { type: "key/set"; key: string | null }
  | { type: "key/status"; status: AppState["keyStatus"]; error?: string | null }
  | { type: "key/dialog"; open: boolean }
  | { type: "models/set"; models: ModelOption[] }
  | { type: "settings/update"; patch: Partial<Settings> }
  | { type: "settings/toggle"; open?: boolean }
  | { type: "doc/set"; doc: DocState }
  | { type: "doc/patch"; id: string; patch: Partial<DocState> }
  | { type: "doc/clear" }
  | { type: "paste/mode"; enabled: boolean }
  | { type: "paste/text"; text: string }
  | { type: "ocr/set"; ocr: OcrState | null }
  | { type: "translation/set"; translation: TranslationState | null }
  | { type: "job/start"; job: JobState }
  | { type: "job/event"; event: ProgressEvent }
  | { type: "job/end" }
  | { type: "error/set"; error: AppError | null }
  | { type: "tab/set"; tab: ResultTab };

export function initialState(apiKey: string | null, settings: Settings): AppState {
  return {
    apiKey,
    keyStatus: apiKey ? "unverified" : "missing",
    keyError: null,
    keyDialogOpen: !apiKey,
    models: [],
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
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "key/set":
      return { ...state, apiKey: action.key, keyStatus: action.key ? "unverified" : "missing", keyError: null };
    case "key/status":
      return { ...state, keyStatus: action.status, keyError: action.error ?? null };
    case "key/dialog":
      return { ...state, keyDialogOpen: action.open };
    case "models/set":
      return { ...state, models: action.models };
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
        activeTab: "translation",
      };
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
      return { ...state, ocr: action.ocr };
    case "translation/set":
      return { ...state, translation: action.translation, activeTab: action.translation ? "translation" : state.activeTab };
    case "job/start":
      return { ...state, job: action.job, error: null };
    case "job/event": {
      if (!state.job) return state;
      const ev = action.event;
      const events =
        ev.status === "progress" && state.job.events.at(-1)?.status === "progress" && state.job.events.at(-1)?.stage === ev.stage
          ? [...state.job.events.slice(0, -1), ev]
          : [...state.job.events, ev];
      return {
        ...state,
        job: {
          ...state.job,
          events,
          currentStage: ev.stage,
          receivedChars: ev.receivedChars ?? (ev.stage === state.job.currentStage ? state.job.receivedChars : 0),
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
