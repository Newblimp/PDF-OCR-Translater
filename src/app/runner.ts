/**
 * Side-effectful operations that drive the store: loading a document,
 * verifying API keys, running the pipeline, saving results in this browser.
 * Components call these and render whatever ends up in the state.
 */
import { ApiError } from "@/lib/http/apiError";
import { addUsage, emptyUsage, type ProviderId } from "@/lib/llm/provider";
import { createProvider, effortFor, PROVIDER_IDS, PROVIDERS } from "@/lib/llm/registry";
import type { OcrClient } from "@/lib/mistral/client";
import { classifyFile } from "@/lib/files/fileKind";
import { fileToDataUrl } from "@/lib/files/dataUrl";
import { sha256Hex } from "@/lib/files/hash";
import { disposePageRenderer, getPageRenderer, PAGE_RENDER_WIDTH } from "@/lib/files/pageRenderCache";
import { openPdfPreview } from "@/lib/files/pdfPreview";
import {
  applyCut,
  editableBlocks,
  emptyEdits,
  hasEdits,
  insertionIndex,
  newBlockId,
  newImageId,
  planCut,
  rectOf,
  withoutPage,
  withPage,
  type BlockEdits,
  type BoxEdit,
  type EditedBlock,
  type Rect,
} from "@/lib/pipeline/blockEdits";
import { ocrTextFromPages, shownTextBlockIds, textPages, type BlockFilter } from "@/lib/pipeline/blocks";
import { ocrRegion } from "@/lib/pipeline/regionOcr";
import { runPool } from "@/lib/util/pool";
import { emit, type StageId } from "@/lib/pipeline/events";
import type { PipelineContext, PipelineSettings, SchemaMode, TranslationOutcome } from "@/lib/pipeline/pipeline";
import { parsePageSelection } from "@/lib/util/pageSelection";
import { buildOcrText, type OcrCleanPage, type OcrText } from "@/lib/pipeline/ocrText";
import { OCR_MAX_FILE_BYTES } from "@/lib/pipeline/runOcr";
import { clearApiKey, loadApiKey, saveApiKey } from "@/lib/storage/apiKeys";
import {
  clearSavedTranslations,
  deleteSavedTranslation,
  findSavedTranslation,
  getSavedTranslation,
  HISTORY_VERSION,
  listSavedTranslations,
  putSavedTranslation,
  type SourceKind,
} from "@/lib/storage/history";
import { getCachedOcr, OCR_CACHE_VERSION, ocrCacheKey, putCachedOcr, type OcrCacheEntry } from "@/lib/storage/ocrCache";
import { saveSettings, type Settings } from "@/lib/storage/settings";
import { applyTheme } from "@/lib/storage/theme";
import { isPlainObject } from "@/lib/util/json";
import { formatBytes } from "@/lib/util/text";
import {
  canRunOcr,
  excludedBlocks,
  hasOriginal,
  hasStructure,
  missingKeys,
  makeOcrState,
  ocrBelongsTo,
  ocrRequestKey,
  restoredTranslation,
  selectSourceText,
  translationDefaults,
  usableKey,
  type Action,
  type AppError,
  type AppState,
  type DocState,
  type JobKind,
  type OcrState,
  type TranslationState,
} from "./store";

export interface Runtime {
  getState(): AppState;
  dispatch(action: Action): void;
}

/** The pipeline's stages (prompts, schemas, the steps), imported when the first job runs: the page does not need them before. */
const pipeline = () => import("@/lib/pipeline/pipeline");

/** How many pages to render as thumbnails when a PDF is dropped. */
const PREVIEW_PAGES = 4;
const PREVIEW_WIDTH_PX = 260;

// -------------------------------------------------------------------- keys

/** In-flight key verifications, one per provider; a newer request cancels the older one. */
const verifications = new Map<ProviderId, AbortController>();

/**
 * Store a key and verify it against the provider's model list (which also
 * fills the model dropdown). Returns true when the key was accepted.
 * Results are only applied if the key is still the current one when the
 * request completes (the user may have replaced or forgotten it meanwhile).
 */
export async function verifyAndSaveApiKey(rt: Runtime, provider: ProviderId, key: string): Promise<boolean> {
  verifications.get(provider)?.abort();
  const trimmed = key.trim();
  if (!trimmed) {
    clearApiKey(provider);
    rt.dispatch({ type: "key/set", provider, key: null });
    return false;
  }
  const controller = new AbortController();
  verifications.set(provider, controller);
  rt.dispatch({ type: "key/set", provider, key: trimmed });
  rt.dispatch({ type: "key/status", provider, status: "checking" });
  const stillCurrent = () => !controller.signal.aborted && rt.getState().keys[provider].value === trimmed;
  const remember = () => rt.getState().settings.rememberKeys;
  try {
    const options = await createProvider(provider, trimmed).listModels(controller.signal);
    if (!stillCurrent()) return false;
    rt.dispatch({ type: "models/set", provider, models: options.length ? options : [...PROVIDERS[provider].fallbackModels] });
    rt.dispatch({ type: "key/status", provider, status: "valid" });
    saveApiKey(provider, trimmed, remember());
    return true;
  } catch (err) {
    if (!stillCurrent()) return false;
    if (err instanceof ApiError && err.kind === "auth") {
      rt.dispatch({ type: "key/status", provider, status: "invalid", error: `${PROVIDERS[provider].label} rejected this key (${err.message}).` });
      return false;
    }
    // Network trouble: keep the key so the user can retry later.
    saveApiKey(provider, trimmed, remember());
    rt.dispatch({ type: "models/set", provider, models: [...PROVIDERS[provider].fallbackModels] });
    rt.dispatch({
      type: "key/status",
      provider,
      status: "unverified",
      error: `Could not verify the ${PROVIDERS[provider].label} key: ${err instanceof Error ? err.message : String(err)}. It was saved anyway.`,
    });
    return false;
  } finally {
    if (verifications.get(provider) === controller) verifications.delete(provider);
  }
}

/** Verify every key entered in the dialog; closes it when all required keys are accepted. */
export async function submitApiKeys(rt: Runtime, keys: Partial<Record<ProviderId, string>>): Promise<void> {
  await Promise.all(
    (Object.entries(keys) as Array<[ProviderId, string]>).map(([provider, key]) => {
      const current = rt.getState().keys[provider];
      if (key.trim() === (current.value ?? "") && current.status === "valid") return Promise.resolve(true);
      return verifyAndSaveApiKey(rt, provider, key);
    }),
  );
  const state = rt.getState();
  // Stay open while a required key is missing or rejected, or an entered optional key was rejected.
  const blocking = missingKeys(state).length > 0 || Object.values(state.keys).some((k) => k.status === "invalid" && k.value);
  if (!blocking) rt.dispatch({ type: "key/dialog", open: false });
}

export function forgetApiKeys(rt: Runtime): void {
  for (const provider of PROVIDER_IDS) {
    verifications.get(provider)?.abort();
    clearApiKey(provider);
    rt.dispatch({ type: "key/set", provider, key: null });
    rt.dispatch({ type: "models/set", provider, models: [] });
  }
  rt.dispatch({ type: "key/dialog", open: true });
}

export function updateSettings(rt: Runtime, patch: Partial<Settings>): void {
  const before = rt.getState().settings;
  rt.dispatch({ type: "settings/update", patch });
  const settings = rt.getState().settings;
  saveSettings(settings);
  if (patch.theme) applyTheme(patch.theme);
  // "Remember keys" changed: move the stored keys between localStorage and sessionStorage.
  if (patch.rememberKeys !== undefined && patch.rememberKeys !== before.rememberKeys) {
    for (const provider of PROVIDER_IDS) {
      const stored = loadApiKey(provider);
      if (stored) saveApiKey(provider, stored, patch.rememberKeys);
    }
  }
  // Switching to a provider without a usable key: ask for it right away.
  if (patch.provider && missingKeys(rt.getState(), settings).length > 0) rt.dispatch({ type: "key/dialog", open: true });
}

// ---------------------------------------------------------------- document

/** Free what the current document holds outside the store: preview object URLs and the open pdf.js document. */
function releaseDocument(rt: Runtime): void {
  for (const url of rt.getState().doc?.previews ?? []) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  disposePageRenderer();
}

export async function loadDocument(rt: Runtime, file: File): Promise<void> {
  const classified = classifyFile(file);
  if (!classified) {
    rt.dispatch({
      type: "error/set",
      error: { title: "Unsupported file", message: `"${file.name}" is not a PDF, image (PNG/JPEG/WebP) or text file.` },
    });
    return;
  }
  rt.getState().job?.controller.abort();
  releaseDocument(rt);

  const doc: DocState = {
    id: crypto.randomUUID(),
    file,
    name: file.name,
    size: file.size,
    kind: classified.kind,
    mimeType: classified.mimeType,
    hash: null,
    pageCount: null,
    previews: [],
    previewStatus: classified.kind === "text" ? "ready" : "loading",
    previewError: null,
    textContent: null,
    pageSelection: "",
  };
  rt.dispatch({ type: "doc/set", doc });
  const patch = (p: Partial<DocState>) => rt.dispatch({ type: "doc/patch", id: doc.id, patch: p });
  const stillCurrent = () => rt.getState().doc?.id === doc.id;

  if (file.size > OCR_MAX_FILE_BYTES && classified.kind !== "text") {
    rt.dispatch({
      type: "error/set",
      error: {
        title: "File too large for Mistral OCR",
        message: `${file.name} is ${formatBytes(file.size)}; the OCR API accepts up to ${formatBytes(OCR_MAX_FILE_BYTES)}.`,
      },
    });
  }

  try {
    if (classified.kind === "text") {
      const text = await file.text();
      if (stillCurrent()) {
        patch({ textContent: text, previewStatus: "ready" });
        void restoreSavedTranslation(rt, doc.id, await hashText(text), null);
      }
      return;
    }

    const buffer = await file.arrayBuffer();
    // Hash and preview in parallel; both are local computations.
    const hashing = sha256Hex(buffer).then(async (hash) => {
      if (!stillCurrent()) return;
      patch({ hash });
      await restoreCachedOcr(rt, doc.id, hash);
    });

    if (classified.kind === "image") {
      patch({ previews: [URL.createObjectURL(file)], pageCount: 1, previewStatus: "ready" });
    } else {
      const preview = await openPdfPreview(buffer);
      try {
        if (!stillCurrent()) return;
        patch({ pageCount: preview.pageCount });
        const pages = Math.min(PREVIEW_PAGES, preview.pageCount);
        const previews: string[] = [];
        for (let i = 1; i <= pages; i++) {
          const url = await preview.renderPage(i, PREVIEW_WIDTH_PX);
          if (!stillCurrent()) {
            URL.revokeObjectURL(url);
            return;
          }
          previews.push(url);
          patch({ previews: [...previews], previewStatus: i === pages ? "ready" : "loading" });
        }
        if (pages === 0) patch({ previewStatus: "ready" });
      } finally {
        preview.destroy();
      }
    }
    await hashing;
  } catch (err) {
    if (stillCurrent()) {
      patch({ previewStatus: "error", previewError: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Update the pages-to-OCR selection of the loaded document and re-check the local cache for it. */
export function setPageSelection(rt: Runtime, text: string): void {
  const doc = rt.getState().doc;
  if (!doc) return;
  rt.dispatch({ type: "doc/patch", id: doc.id, patch: { pageSelection: text } });
  if (rt.getState().ocr?.source === "cache") rt.dispatch({ type: "ocr/set", ocr: null });
  if (doc.hash) void restoreCachedOcr(rt, doc.id, doc.hash);
}

function selectedPages(rt: Runtime): number[] | null {
  const doc = rt.getState().doc;
  if (!doc) return null;
  const parsed = parsePageSelection(doc.pageSelection, doc.pageCount);
  return parsed.error ? null : parsed.pages;
}

async function restoreCachedOcr(rt: Runtime, docId: string, hash: string): Promise<void> {
  const state = rt.getState();
  if (!state.settings.cacheOcr) return;
  const pages = selectedPages(rt);
  const key = ocrCacheKey(hash, state.settings.ocrModel, pages);
  const entry = await getCachedOcr(key);
  if (!entry) return;
  if (rt.getState().doc?.id !== docId || rt.getState().ocr) return;
  rt.dispatch({ type: "ocr/set", ocr: cachedOcrState(entry, docId, ocrRequestKey(state.settings.ocrModel, pages), key) });
  await restoreSavedTranslation(rt, docId, hash, key);
}

/** An OCR result from this browser's cache, with its saved edits. */
function cachedOcrState(entry: OcrCacheEntry, docId: string, requestKey: string, cacheKey: string): OcrState {
  const { model, response, edits } = entry;
  return makeOcrState({ source: "cache", model, response, base: buildOcrText(response), edits: edits ?? null, docId, requestKey, cacheKey });
}

/** Show the newest saved translation of the same document (and OCR result) right away. */
async function restoreSavedTranslation(rt: Runtime, docId: string, sourceHash: string, ocrKey: string | null): Promise<void> {
  if (!rt.getState().settings.saveTranslations) return;
  const saved = await findSavedTranslation<TranslationState>(sourceHash, ocrKey);
  const state = rt.getState();
  if (!saved || state.doc?.id !== docId || state.translation || state.job) return;
  rt.dispatch({ type: "translation/set", translation: restoredTranslation(saved.translation) });
}

export function clearDocument(rt: Runtime): void {
  rt.getState().job?.controller.abort();
  releaseDocument(rt);
  rt.dispatch({ type: "doc/clear" });
}

async function hashText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

// --------------------------------------------------------------- history

export async function refreshHistory(rt: Runtime): Promise<void> {
  rt.dispatch({ type: "history/set", history: await listSavedTranslations() });
}

/** Latest "Open" request; an older one that finishes reading later gives way. */
let openRequest = 0;

/** Reopen a saved translation (with its OCR result when the OCR cache still has it). */
export async function openSavedTranslation(rt: Runtime, id: string): Promise<void> {
  if (rt.getState().job) return;
  const request = ++openRequest;
  const docBefore = rt.getState().doc?.id;
  // A document loaded or another entry opened while IndexedDB was read is the user's latest action: keep it.
  const superseded = () => request !== openRequest || rt.getState().doc?.id !== docBefore || !!rt.getState().job;
  const saved = await getSavedTranslation<TranslationState>(id);
  if (superseded()) return;
  if (!saved) {
    rt.dispatch({ type: "error/set", error: { title: "Saved translation not found", message: "It may have been removed in another tab." } });
    await refreshHistory(rt);
    return;
  }
  const cached = saved.ocrKey ? await getCachedOcr(saved.ocrKey) : null;
  const ocr = cached && saved.ocrKey ? cachedOcrState(cached, `saved:${saved.id}`, "", saved.ocrKey) : null;
  if (superseded()) return;
  releaseDocument(rt);
  const textSource = saved.sourceKind === "pasted" || saved.sourceKind === "text";
  rt.dispatch({ type: "history/open", ocr, translation: restoredTranslation(saved.translation), pastedText: textSource ? saved.translation.sourceText : null });
}

/** Saved translations the user deleted: a later job on the same result on screen must not write them back. */
const deletedIds = new Set<string>();

export async function deleteSaved(rt: Runtime, id: string): Promise<void> {
  deletedIds.add(id);
  await deleteSavedTranslation(id);
  await refreshHistory(rt);
}

export async function clearHistory(rt: Runtime): Promise<void> {
  for (const entry of rt.getState().history) deletedIds.add(entry.id);
  const current = rt.getState().translation?.id;
  if (current) deletedIds.add(current);
  await clearSavedTranslations();
  await refreshHistory(rt);
}

async function saveTranslation(rt: Runtime): Promise<void> {
  const { translation, settings } = rt.getState();
  if (!translation || !settings.saveTranslations || deletedIds.has(translation.id)) return;
  await putSavedTranslation({
    id: translation.id,
    version: HISTORY_VERSION,
    createdAt: translation.completedAt,
    sourceName: translation.sourceName,
    sourceKind: translation.sourceKind,
    sourceHash: translation.sourceHash,
    ocrKey: translation.ocrKey,
    targetLanguage: translation.targetLanguage,
    provider: translation.provider,
    model: translation.model,
    translation: { ...translation, restored: false },
  });
  await refreshHistory(rt);
}

// --------------------------------------------------------------------- jobs

export function cancelJob(rt: Runtime): void {
  rt.getState().job?.controller.abort();
}

interface Job {
  kind: JobKind;
  ctx: PipelineContext;
  controller: AbortController;
  /** Id of the translation this job put on screen, once it has. */
  producedId?: string;
}

/**
 * Check keys and settings and start a job in the store; null when it cannot
 * start (the reason is shown). `forTranslation` runs a job that adds to that
 * translation (original-language structure, retries) in its own target
 * language, whatever Settings say now, with the provider and model from
 * Settings (so picking another model there recovers from a failing one);
 * such jobs do not use the schema setting.
 */
function beginJob(rt: Runtime, kind: JobKind, stages: StageId[], needsChat: boolean, forTranslation?: TranslationState): Job | null {
  const state = rt.getState();
  if (state.job) return null;
  let settings = state.settings;
  // Editing boxes uses OCR only: an invalid custom schema in Settings must not block it.
  if (kind === "edit") settings = { ...settings, schemaMode: { kind: "infer" } };
  if (forTranslation) {
    settings = {
      ...settings,
      targetLanguage: forTranslation.targetLanguage as Settings["targetLanguage"],
      // Its schema travels with the translation; an invalid custom schema in Settings must not block it.
      schemaMode: { kind: "infer" },
    };
  }
  const mistralKey = usableKey(state.keys, "mistral");
  const chatKey = usableKey(state.keys, settings.provider);
  const needsOcr = kind === "ocr" || kind === "both" || kind === "edit";
  if ((needsOcr && !mistralKey) || (needsChat && !chatKey)) {
    rt.dispatch({ type: "key/dialog", open: true });
    return null;
  }
  const pipelineSettings = toPipelineSettings(settings);
  if ("error" in pipelineSettings) {
    rt.dispatch({ type: "error/set", error: pipelineSettings.error });
    return null;
  }
  const controller = new AbortController();
  rt.dispatch({ type: "job/start", job: { kind, startedAt: Date.now(), stages, events: [], receivedChars: {}, streamText: "", controller } });
  return {
    kind,
    controller,
    ctx: {
      ocr: ocrClient(mistralKey ?? ""),
      chat: createProvider(settings.provider, chatKey ?? mistralKey ?? ""),
      settings: pipelineSettings,
      signal: controller.signal,
      onProgress: (event) => rt.dispatch({ type: "job/event", event }),
    },
  };
}

/** Mistral OCR with this key; the client (and the HTTP layer) is imported with the first request. */
function ocrClient(apiKey: string): OcrClient {
  return {
    async ocr(request, signal) {
      const { MistralClient } = await import("@/lib/mistral/client");
      return new MistralClient({ apiKey }).ocr(request, signal);
    },
  };
}

/** Report a job's failure (`err`) unless it was cancelled; always ends the job. */
function endJob(rt: Runtime, job: Job, err?: unknown): void {
  if (err !== undefined) {
    // A translation whose job was cancelled or failed after it appeared gets no automatic follow-up: the user decides.
    if (job.producedId) originalRequested.add(job.producedId);
    if (!isCancellation(err, job)) {
      rt.dispatch({ type: "error/set", error: toAppError(err, JOB_TITLES[job.kind]) });
      job.controller.abort(); // stop stages still running in the background
    }
  }
  rt.dispatch({ type: "job/end" });
}

/** Translations whose original-language structure was already requested or settled (it is not requested again automatically). */
const originalRequested = new Set<string>();

/** The OCR result on screen, if it is the one `t` was translated from (not another page selection, document or source). */
function ocrOf(state: AppState, t: TranslationState): OcrText | undefined {
  return state.ocr && ocrBelongsTo(state.ocr, t) ? state.ocr.text : undefined;
}

/** The blocks the OCR text tab keeps for these pages: the block types not hidden there, minus the blocks left out one by one. */
function blockFilter(state: AppState, pages: readonly OcrCleanPage[]): BlockFilter {
  return { hiddenTypes: new Set(state.settings.ocrHiddenTypes), excluded: excludedBlocks(state, pages) };
}

function isCancellation(err: unknown, job: Job): boolean {
  return job.controller.signal.aborted || (err instanceof ApiError && err.kind === "aborted");
}

/** The stages a translation runs, for the job status card. */
function translationStages(settings: Settings, withOcr: boolean, withBoxes: boolean): StageId[] {
  const stages: StageId[] = withOcr ? ["prepare", "ocr"] : [];
  if (!settings.jsonOutput) {
    if (withBoxes && settings.bboxAnnotations) stages.push("bbox_annotate");
    stages.push("block_translate");
    return stages;
  }
  stages.push("infer_schema");
  if (withBoxes && settings.bboxAnnotations) stages.push("bbox_annotate");
  stages.push("translate");
  if (settings.structureOriginal === "always") stages.push("structure_original");
  if (withBoxes && settings.blockTranslations) stages.push("block_translate");
  return stages;
}

/** What is being translated, for the result and its saved copy. */
interface Source {
  text: string;
  ocr: OcrText | undefined;
  name: string;
  kind: SourceKind;
  hash: string | null;
  ocrKey: string | null;
  /** `OcrState.fingerprint` of the OCR result translated; null for text input. */
  ocrFingerprint: string | null;
}

export async function runJob(rt: Runtime, kind: "ocr" | "translate" | "both"): Promise<void> {
  const state = rt.getState();
  if (state.job) return;
  const translateSource = kind === "translate" ? selectSourceText(state) : null;
  const withBoxes = kind === "both" || translateSource?.origin === "ocr";
  const stages = kind === "ocr" ? (["prepare", "ocr"] as StageId[]) : translationStages(state.settings, kind === "both", withBoxes);
  const job = beginJob(rt, kind, stages, kind !== "ocr");
  if (!job) return;

  try {
    let source: Source;
    if (kind === "translate") {
      if (!translateSource) throw new Error("Nothing to translate: run OCR first, drop a text file, or paste text.");
      source = await describeSource(rt.getState(), translateSource.text, translateSource.origin);
    } else {
      const doc = state.doc;
      if (!doc || !canRunOcr(state)) throw new Error("Load a PDF or image first.");
      const ocr = await runOcrStage(rt, job, doc, kind === "both");
      if (kind === "ocr") {
        rt.dispatch({ type: "tab/set", tab: "ocr" });
        return endJob(rt, job);
      }
      source = { text: ocr.text.text, ocr: ocr.text, name: doc.name, kind: doc.kind, hash: doc.hash, ocrKey: ocr.cacheKey, ocrFingerprint: ocr.fingerprint };
    }
    if (!source.text.trim()) throw new Error("OCR returned no text to translate.");
    await runTranslation(rt, job, source);
    endJob(rt, job);
  } catch (err) {
    endJob(rt, job, err);
  }
}

/**
 * OCR the loaded document, or reuse the result already loaded for it with the
 * same model and pages (`reuse`, used by "OCR + Translate": no second charge).
 */
async function runOcrStage(rt: Runtime, job: Job, doc: DocState, reuse: boolean): Promise<{ text: OcrText; cacheKey: string | null; fingerprint: string }> {
  const { ctx } = job;
  const settings = rt.getState().settings;
  const selection = parsePageSelection(doc.pageSelection, doc.pageCount);
  if (selection.error) throw new Error(`Pages to OCR: ${selection.error}`);
  const requestKey = ocrRequestKey(settings.ocrModel, selection.pages);
  const cacheKey = doc.hash ? ocrCacheKey(doc.hash, settings.ocrModel, selection.pages) : null;

  const loaded = rt.getState().ocr;
  if (reuse && loaded && loaded.docId === doc.id && loaded.requestKey === requestKey) {
    emit(ctx.onProgress, "prepare", "skipped", "The document was already OCR'd with these settings");
    emit(
      ctx.onProgress,
      "ocr",
      "skipped",
      `Reusing the OCR result ${loaded.source === "cache" ? "from this browser's cache" : "of this session"}: no new OCR charge`,
    );
    return { text: loaded.text, cacheKey: loaded.cacheKey ?? cacheKey, fingerprint: loaded.fingerprint };
  }

  const { ocrOnly } = await pipeline();
  emit(ctx.onProgress, "prepare", "start", `Encoding ${doc.name} (${formatBytes(doc.size)})`);
  const dataUrl = await fileToDataUrl(doc.file, doc.mimeType);
  emit(ctx.onProgress, "prepare", "done", "Document encoded");
  const outcome = await ocrOnly(ctx, { dataUrl, mimeType: doc.mimeType, fileName: doc.name }, selection.pages);
  job.controller.signal.throwIfAborted();
  const ocr = makeOcrState({
    source: "api",
    model: outcome.response.model,
    response: outcome.response,
    base: outcome.text,
    docId: doc.id,
    requestKey,
    cacheKey,
  });
  rt.dispatch({ type: "ocr/set", ocr });
  if (settings.cacheOcr && cacheKey) {
    void putCachedOcr({
      key: cacheKey,
      version: OCR_CACHE_VERSION,
      fileName: doc.name,
      fileSize: doc.size,
      model: outcome.response.model,
      createdAt: Date.now(),
      response: outcome.response,
    });
  }
  return { text: ocr.text, cacheKey, fingerprint: ocr.fingerprint };
}

async function describeSource(state: AppState, text: string, origin: "ocr" | "textfile" | "pasted" | "saved"): Promise<Source> {
  const { doc, ocr, translation } = state;
  if (origin === "ocr" && ocr) {
    if (doc) return { text, ocr: ocr.text, name: doc.name, kind: doc.kind, hash: doc.hash, ocrKey: ocr.cacheKey, ocrFingerprint: ocr.fingerprint };
    // OCR reopened from "Recent translations".
    return {
      text,
      ocr: ocr.text,
      name: translation?.sourceName ?? "Saved document",
      kind: translation?.sourceKind ?? "pdf",
      hash: translation?.sourceHash ?? null,
      ocrKey: ocr.cacheKey,
      ocrFingerprint: ocr.fingerprint,
    };
  }
  if (origin === "saved" && translation) {
    return {
      text,
      ocr: undefined,
      name: translation.sourceName,
      kind: translation.sourceKind,
      hash: translation.sourceHash,
      ocrKey: null,
      ocrFingerprint: null,
    };
  }
  const name = origin === "textfile" && doc ? doc.name : "Pasted text";
  return { text, ocr: undefined, name, kind: origin === "textfile" ? "text" : "pasted", hash: await hashText(text), ocrKey: null, ocrFingerprint: null };
}

/**
 * Put this job's translation of `source` on screen and return its id: what
 * the job ran with (Settings may have changed meanwhile), the stages' results
 * in `fields`, the rest empty until the follow-ups fill it in.
 */
function showNewTranslation(rt: Runtime, job: Job, source: Source, fields: Partial<TranslationState>): string {
  const { chat, settings } = job.ctx;
  const translation: TranslationState = {
    ...translationDefaults(),
    id: crypto.randomUUID(),
    sourceName: source.name,
    sourceKind: source.kind,
    sourceHash: source.hash,
    ocrKey: source.ocrKey,
    ocrFingerprint: source.ocrFingerprint,
    sourceText: source.text,
    provider: chat.id,
    model: settings.chatModel,
    targetLanguage: settings.targetLanguage,
    completedAt: Date.now(),
    sourceChars: source.text.length,
    ...fields,
  };
  job.producedId = translation.id;
  rt.dispatch({ type: "translation/set", translation });
  return translation.id;
}

/** A translation's fields for the JSON format filled in the document's own language. */
function originalFields(o: TranslationOutcome): Partial<TranslationState> {
  return { originalData: o.data, originalRawText: o.rawText, originalUsage: o.usage, originalViolations: o.violations };
}

/** Patches of translation `id`, applied while it is the one on screen (a document loaded meanwhile replaces it). */
function translationPatcher(rt: Runtime, id: string): (patch: Partial<TranslationState>) => void {
  return (patch) => {
    if (rt.getState().translation?.id === id) rt.dispatch({ type: "translation/patch", patch });
  };
}

/** Runs a step whose failure leaves a warning (collected in `warnings`) on the result instead of failing the job. */
function followUps(job: Job, warnings: string[]) {
  return <T>(stage: StageId, label: string, task: Promise<T | null>): Promise<T | null> =>
    task.catch((err: unknown) => {
      if (isCancellation(err, job)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${label} failed: ${message}`);
      emit(job.ctx.onProgress, stage, "warning", `${label} failed`, { detail: message });
      emit(job.ctx.onProgress, stage, "done", "Stopped; the translation is unaffected");
      return null;
    });
}

/** With the JSON format: schema → document annotation; without it: the text blocks one by one. */
function runTranslation(rt: Runtime, job: Job, source: Source): Promise<void> {
  return job.ctx.settings.structured ? translateStructured(rt, job, source) : translateByBlocks(rt, job, source);
}

/**
 * Without the JSON format: the text blocks the OCR text tab keeps (OCR
 * blocks, or the paragraphs of text input) are translated one by one, with
 * the bbox annotation alongside. The translation is on screen from the start
 * and fills in batch by batch.
 */
async function translateByBlocks(rt: Runtime, job: Job, source: Source): Promise<void> {
  const { ctx, controller } = job;
  const { blockTranslations, describeBboxes } = await pipeline();
  const warnings: string[] = [];
  const followUp = followUps(job, warnings);
  const pages = source.ocr?.pages ?? textPages(source.text);
  const onlyIds = shownTextBlockIds(pages, blockFilter(rt.getState(), pages));
  if (!onlyIds.size) throw new Error("Nothing to translate: every text block is left out by the block filters of the OCR text tab.");

  const bboxes = followUp("bbox_annotate", "Bounding-box descriptions", describeBboxes(ctx, source.ocr));
  void bboxes.catch(() => undefined); // awaited below; a failing translation must not leave it unhandled

  const id = showNewTranslation(rt, job, source, { pages });
  const patch = translationPatcher(rt, id);
  const received: Record<string, string> = {};
  try {
    const out = await blockTranslations(ctx, source.ocr ?? ocrTextFromPages(source.text, pages), onlyIds, (batch) => {
      Object.assign(received, batch);
      patch({ blockTranslations: { ...received } });
    });
    controller.signal.throwIfAborted();
    patch({ blockTranslations: out.translations, blockUsage: out.usage, completedAt: Date.now() });
    if (!Object.keys(out.translations).length) throw new Error(`None of the ${onlyIds.size} text block(s) came back translated; the job steps above say why.`);
    const b = await bboxes;
    if (b) patch({ bboxAnnotations: b.annotations, bboxUsage: b.usage });
  } finally {
    // Keep what was translated even when the job was cancelled or a batch failed.
    if (warnings.length) patch({ warnings });
    if (Object.keys(received).length && rt.getState().translation?.id === id) await saveTranslation(rt);
  }
}

/**
 * Schema → translation, with the bbox annotation running alongside (it does
 * not feed into the translation), then the follow-ups side by side. A
 * follow-up that fails leaves a warning on the result instead of failing
 * the job: the translation is already there.
 */
async function translateStructured(rt: Runtime, job: Job, source: Source): Promise<void> {
  const { ctx, controller } = job;
  const { blockTranslations, describeBboxes, resolveSchema, structureOriginal, translateDocument } = await pipeline();
  const warnings: string[] = [];
  const followUp = followUps(job, warnings);

  const schema = await resolveSchema(ctx, source.text);
  controller.signal.throwIfAborted();
  const bboxes = followUp("bbox_annotate", "Bounding-box descriptions", describeBboxes(ctx, source.ocr));
  void bboxes.catch(() => undefined); // awaited below; a failing translation must not leave it unhandled

  const translation = await translateDocument(ctx, source.text, schema.schema, source.ocr);
  controller.signal.throwIfAborted();
  const id = showNewTranslation(rt, job, source, {
    ...translation, // the data and how it was made: the model that answered, the mode, usage, deviations, ...
    schema: schema.schema,
    schemaSource: schema.source,
    schemaWarnings: schema.warnings,
    inferUsage: schema.inferred?.usage ?? null,
  });
  const patch = translationPatcher(rt, id);
  // In "always" mode the stage runs below; whatever its outcome, the view must not request it again by itself.
  if (ctx.settings.structureOriginal === "always") originalRequested.add(id);

  // Follow-ups, side by side; each result shows up as soon as it is in.
  // The original-language structure reads the document prefix the translation just cached.
  try {
    await Promise.all([
      bboxes.then((b) => b && patch({ bboxAnnotations: b.annotations, bboxUsage: b.usage })),
      ctx.settings.structureOriginal === "always"
        ? followUp("structure_original", "Structured text in the original language", structureOriginal(ctx, source.text, schema.schema, source.ocr)).then(
            (o) => o && patch(originalFields(o)),
          )
        : null,
      !source.ocr
        ? emit(ctx.onProgress, "block_translate", "skipped", "No text blocks (text input)")
        : !ctx.settings.blockTranslations
          ? emit(ctx.onProgress, "block_translate", "skipped", "Block translations disabled in Settings")
          : followUp(
              "block_translate",
              "Block translations",
              blockTranslations(ctx, source.ocr, shownTextBlockIds(source.ocr.pages, blockFilter(rt.getState(), source.ocr.pages))),
            ).then((b) => b && patch({ blockTranslations: b.translations, blockUsage: b.usage })),
    ]);
  } finally {
    // Keep the translation even when the follow-ups were cancelled.
    if (warnings.length) patch({ warnings });
    await saveTranslation(rt);
  }
}

/**
 * Fill the JSON format in the document's own language for the translation on
 * screen: automatically once when the structured text is viewed with "Show
 * translation" off, or when the user asks for it (`force`).
 */
export async function ensureOriginalStructure(rt: Runtime, force = false): Promise<void> {
  const state = rt.getState();
  const t = state.translation;
  if (!t || !hasStructure(t) || state.job || hasOriginal(t) || state.settings.structureOriginal === "never") return;
  // Not by itself while an error is shown (an automatic job would also clear it), nor twice for one translation.
  if (!force && (originalRequested.has(t.id) || state.error)) return;
  const job = beginJob(rt, "original", ["structure_original"], true, t);
  if (!job) return;
  originalRequested.add(t.id);
  try {
    const { structureOriginal } = await pipeline();
    const ocr = ocrOf(state, t);
    const original = await structureOriginal(job.ctx, t.sourceText, t.schema, ocr);
    job.controller.signal.throwIfAborted();
    if (rt.getState().translation?.id === t.id) {
      rt.dispatch({ type: "translation/patch", patch: originalFields(original) });
      await saveTranslation(rt);
    }
    endJob(rt, job);
  } catch (err) {
    endJob(rt, job, err);
  }
}

/**
 * Run the bounding boxes or text blocks that failed (or came back empty)
 * again, and merge the results in. For blocks: the ones the OCR text tab
 * keeps, which includes blocks taken back after the translation.
 */
export async function retryFailed(rt: Runtime, what: "bboxes" | "blocks"): Promise<void> {
  const state = rt.getState();
  const t = state.translation;
  const ocr = t ? ocrOf(state, t) : undefined;
  // Without its OCR result, a translation made without the JSON format still has its blocks.
  const pages = ocr?.pages ?? t?.pages;
  if (!t || state.job || (what === "bboxes" ? !ocr : !pages)) return;
  const ids =
    what === "bboxes"
      ? new Set(t.bboxAnnotations.filter((a) => !a.data).map((a) => a.id))
      : new Set([...shownTextBlockIds(pages!, blockFilter(state, pages!))].filter((id) => !t.blockTranslations[id]?.trim()));
  if (!ids.size) return;
  const job = beginJob(rt, "retry", [what === "bboxes" ? "bbox_annotate" : "block_translate"], true, t);
  if (!job) return;
  try {
    const { blockTranslations, describeBboxes } = await pipeline();
    if (what === "bboxes") {
      const out = await describeBboxes(job.ctx, ocr, ids);
      job.controller.signal.throwIfAborted();
      const current = rt.getState().translation;
      if (out && current?.id === t.id) {
        const fresh = new Map(out.annotations.map((a) => [a.id, a]));
        rt.dispatch({
          type: "translation/patch",
          patch: {
            bboxAnnotations: current.bboxAnnotations.map((a) => fresh.get(a.id) ?? a),
            bboxUsage: addUsage(addUsage(emptyUsage(), current.bboxUsage), out.usage),
          },
        });
      }
    } else {
      const out = await blockTranslations(job.ctx, ocr ?? ocrTextFromPages(t.sourceText, pages!), ids);
      job.controller.signal.throwIfAborted();
      const current = rt.getState().translation;
      if (out && current?.id === t.id) {
        rt.dispatch({
          type: "translation/patch",
          patch: {
            blockTranslations: { ...current.blockTranslations, ...out.translations },
            blockUsage: addUsage(addUsage(emptyUsage(), current.blockUsage), out.usage),
          },
        });
      }
    }
    await saveTranslation(rt);
    endJob(rt, job);
  } catch (err) {
    endJob(rt, job, err);
  }
}

// --------------------------------------------------------------- box edits

/**
 * Edit the boxes of the OCR result on screen. Deleting and changing blocks
 * happen at once; cutting through text, making a block of a selection and
 * reading a block again send those areas to Mistral OCR (job "edit"). The
 * edits are kept with the OCR result (and in the OCR cache) and can be
 * undone.
 */
export async function editBoxes(rt: Runtime, edit: BoxEdit): Promise<void> {
  const state = rt.getState();
  const ocr = state.ocr;
  const page = ocr?.text.pages.find((p) => p.index === edit.pageIndex);
  if (!ocr || !page || state.job) return;
  const blocks = editableBlocks(page);
  let edits = ocr.edits ?? emptyEdits();

  if (edit.kind === "delete") {
    const ids = new Set(edit.ids);
    return commitEdits(
      rt,
      withPage(
        edits,
        page.index,
        blocks.filter((b) => !ids.has(b.id)),
      ),
    );
  }
  if (edit.kind === "change") {
    const block = blocks.find((b) => b.id === edit.id);
    if (!block) return;
    let id = block.id;
    // Another text is another block: a translation of the old text no longer fits it.
    if (edit.content !== block.content) [id, edits] = newBlockId(edits, page.index);
    const changed = blocks.map((b) => (b.id === block.id ? { ...b, id, type: edit.type, content: edit.content } : b));
    return commitEdits(rt, withPage(edits, page.index, changed));
  }

  // The areas to read again: what is left of the text blocks a selection crosses, the selection itself, a block.
  const plan = edit.kind === "reread" ? null : planCut(blocks, edit.rect);
  if (edit.kind === "cut" && plan && !plan.removed.length && !plan.trimmed.length) return; // it touches no block
  const reads: Array<{ key: string; region: Rect; blank: Rect[] }> = [];
  for (const t of plan?.trimmed ?? []) if (t.reread) reads.push({ key: t.block.id, region: t.box, blank: [t.blank] });
  if (edit.kind === "make" && edit.type !== "image") reads.push({ key: "selection", region: edit.rect, blank: [] });
  if (edit.kind === "reread") {
    const block = blocks.find((b) => b.id === edit.id);
    if (!block) return;
    reads.push({ key: block.id, region: rectOf(block), blank: [] });
  }
  if (edit.kind === "cut" && plan && !reads.length) return commitEdits(rt, withPage(edits, page.index, applyCut(blocks, plan, new Map())));

  const doc = state.doc;
  if (!doc || doc.id !== ocr.docId || !page.width) {
    rt.dispatch({
      type: "error/set",
      error: { title: "The page is needed", message: "Load the document this OCR result was made from to read parts of its pages again." },
    });
    return;
  }
  const renderer = getPageRenderer(
    doc.id,
    doc.file,
    doc.kind === "image" ? "image" : "pdf",
    doc.kind === "image" ? (doc.previews[0] ?? null) : null,
    PAGE_RENDER_WIDTH,
  );
  const pageWidth = page.width;
  const job = beginJob(rt, "edit", ["region_ocr"], false);
  if (!job) return;
  const { ctx, controller } = job;
  try {
    const model = rt.getState().settings.ocrModel;
    const texts = new Map<string, string>();
    emit(
      ctx.onProgress,
      "region_ocr",
      "start",
      reads.length ? `Reading ${reads.length} area(s) of page ${page.index + 1} again with ${model}` : `Cutting the image out of page ${page.index + 1}`,
    );
    let done = 0;
    await runPool(reads, 3, async (r) => {
      const image = await renderer.region(page.index, pageWidth, r.region, r.blank);
      texts.set(r.key, await ocrRegion(ctx.ocr, model, image, controller.signal));
      emit(ctx.onProgress, "region_ocr", "progress", `Read ${++done} of ${reads.length} area(s)`);
    });
    controller.signal.throwIfAborted();
    // Another OCR result or other edits meanwhile: these would not fit them.
    if (rt.getState().ocr !== ocr) return endJob(rt, job);

    let next: EditedBlock[];
    if (edit.kind === "reread") {
      const content = texts.get(edit.id) ?? "";
      if (!content.trim()) throw new Error("Mistral OCR found no text in this block.");
      let id: string;
      [id, edits] = newBlockId(edits, page.index);
      next = blocks.map((b) => (b.id === edit.id ? { ...b, id, content } : b));
    } else {
      const reread = new Map<string, { id: string; content: string }>();
      for (const t of plan!.trimmed) {
        if (!t.reread) continue;
        let id: string;
        [id, edits] = newBlockId(edits, page.index);
        reread.set(t.block.id, { id, content: texts.get(t.block.id) ?? "" });
      }
      next = applyCut(blocks, plan!, reread);
      if (edit.kind === "make")
        [next, edits] = await addSelectionBlock(blocks, next, edits, edit, texts.get("selection") ?? "", () =>
          renderer.region(page.index, pageWidth, edit.rect, []),
        );
    }
    emit(ctx.onProgress, "region_ocr", "done", `Page ${page.index + 1} edited`);
    commitEdits(rt, withPage(edits, page.index, next));
    endJob(rt, job);
  } catch (err) {
    endJob(rt, job, err);
  }
}

/** "Make a block": the selection as a new block (its text read by OCR, or the area as an image), where the blocks it took from were. */
async function addSelectionBlock(
  before: EditedBlock[],
  after: EditedBlock[],
  edits: BlockEdits,
  edit: Extract<BoxEdit, { kind: "make" }>,
  text: string,
  image: () => Promise<string>,
): Promise<[EditedBlock[], BlockEdits]> {
  const { rect } = edit;
  const place = { top_left_x: rect.x0, top_left_y: rect.y0, bottom_right_x: rect.x1, bottom_right_y: rect.y1 };
  let id: string;
  [id, edits] = newBlockId(edits, edit.pageIndex);
  let block: EditedBlock;
  if (edit.type === "image") {
    let imageId: string;
    [imageId, edits] = newImageId(edits);
    edits = { ...edits, images: [...edits.images, { id: imageId, pageIndex: edit.pageIndex, box: rect, dataUrl: await image() }] };
    block = { id, type: "image", ...place, content: "", image_id: imageId };
  } else {
    if (!text.trim()) throw new Error("Mistral OCR found no text in the selection.");
    block = { id, type: edit.type, ...place, content: text };
  }
  // In reading order where the first block it took from was; else by its place on the page.
  const kept = new Set(after.map((b) => b.id));
  const first = before.findIndex((b) => {
    const r = rectOf(b);
    return r.x0 < rect.x1 && r.x1 > rect.x0 && r.y0 < rect.y1 && r.y1 > rect.y0;
  });
  const index = first >= 0 ? before.slice(0, first).filter((b) => kept.has(b.id)).length : insertionIndex(after, rect);
  return [[...after.slice(0, index), block, ...after.slice(index)], edits];
}

/** Put new block edits on screen (none left: the OCR as returned) and keep them with the cached OCR result. */
function commitEdits(rt: Runtime, edits: BlockEdits | null): void {
  rt.dispatch({ type: "ocr/edit", edits: hasEdits(edits) ? edits : null });
  void persistOcrEdits(rt);
}

/** Undo the last edit of the boxes. */
export function undoBoxEdit(rt: Runtime): void {
  const { ocr, job } = rt.getState();
  if (!ocr?.undo.length || job) return;
  rt.dispatch({ type: "ocr/undo" });
  void persistOcrEdits(rt);
}

/** Back to the OCR as returned: one page, or every page. */
export function resetBoxEdits(rt: Runtime, pageIndex?: number): void {
  const { ocr, job } = rt.getState();
  if (!ocr?.edits || job) return;
  commitEdits(rt, pageIndex === undefined ? null : withoutPage(ocr.edits, pageIndex));
}

async function persistOcrEdits(rt: Runtime): Promise<void> {
  const { ocr, settings } = rt.getState();
  if (!ocr?.cacheKey || !settings.cacheOcr) return;
  const entry = await getCachedOcr(ocr.cacheKey);
  const current = rt.getState().ocr;
  if (!entry || current?.fingerprint !== ocr.fingerprint) return;
  await putCachedOcr({ ...entry, edits: current.edits });
}

/** The error title of a job of each kind. */
const JOB_TITLES: Record<JobKind, string> = {
  ocr: "OCR failed",
  translate: "Translation failed",
  both: "OCR + translation failed",
  original: "Structured text in the original language failed",
  retry: "Retry failed",
  edit: "Editing the bounding boxes failed",
};

function toPipelineSettings(settings: Settings): PipelineSettings | { error: AppError } {
  // Inferred and built-in schemas are named the same way in both; a custom one is parsed here.
  let schemaMode: SchemaMode;
  if (settings.schemaMode.kind !== "custom") schemaMode = settings.schemaMode;
  else {
    try {
      const parsed: unknown = JSON.parse(settings.schemaMode.schemaText || "{}");
      if (!isPlainObject(parsed)) throw new Error("Schema must be a JSON object");
      schemaMode = { kind: "custom", schema: parsed };
    } catch (err) {
      return {
        error: {
          title: "Custom schema is not valid JSON",
          message: err instanceof Error ? err.message : String(err),
          hint: "Fix the schema in Settings or switch to inferred / built-in schema.",
        },
      };
    }
  }
  const info = PROVIDERS[settings.provider];
  return {
    ocrModel: settings.ocrModel,
    chatModel: settings.chatModels[settings.provider] || info.defaultModel,
    structured: settings.jsonOutput,
    schemaMode,
    streaming: settings.streaming,
    temperature: settings.temperature,
    reasoningEffort: info.supportsReasoningEffort ? effortFor(settings.provider, settings.reasoningEffort) : undefined,
    maxOutputTokens: settings.maxOutputTokens ?? undefined,
    sendImages: settings.sendImages,
    bboxAnnotations: settings.bboxAnnotations,
    maxBboxAnnotations: settings.maxBboxAnnotations,
    blockTranslations: settings.blockTranslations,
    structureOriginal: settings.structureOriginal,
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
    domainHint: settings.domainHint,
    glossary: settings.glossary,
  };
}

export function toAppError(err: unknown, title: string): AppError {
  if (err instanceof ApiError) {
    const error: AppError = { title, message: err.message, hint: err.hint };
    if (err.body !== undefined && err.body !== null) {
      error.details = typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2);
    }
    return error;
  }
  if (err instanceof Error) {
    const error: AppError = { title, message: err.message };
    if (err.stack) error.details = err.stack;
    return error;
  }
  return { title, message: String(err) };
}
