/**
 * Side-effectful operations that drive the store: loading a document,
 * verifying API keys, running the pipeline, saving results in this browser.
 * Components call these and render whatever ends up in the state.
 */
import { ApiError } from "@/lib/http/apiError";
import { addUsage, emptyUsage, type ProviderId } from "@/lib/llm/provider";
import { createProvider, PROVIDER_IDS, PROVIDERS } from "@/lib/llm/registry";
import { MistralClient } from "@/lib/mistral/client";
import { classifyFile } from "@/lib/files/fileKind";
import { fileToDataUrl } from "@/lib/files/dataUrl";
import { sha256Hex } from "@/lib/files/hash";
import { disposePageRenderer } from "@/lib/files/pageRenderCache";
import { openPdfPreview } from "@/lib/files/pdfPreview";
import { textBlocks } from "@/lib/pipeline/blockTranslate";
import { emit, type StageId } from "@/lib/pipeline/events";
import {
  blockTranslations,
  describeBboxes,
  ocrOnly,
  resolveSchema,
  structureOriginal,
  translateDocument,
  type PipelineContext,
  type PipelineSettings,
  type SchemaMode,
} from "@/lib/pipeline/pipeline";
import { parsePageSelection } from "@/lib/util/pageSelection";
import { buildOcrText, type OcrText } from "@/lib/pipeline/ocrText";
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
import { getCachedOcr, OCR_CACHE_VERSION, ocrCacheKey, putCachedOcr } from "@/lib/storage/ocrCache";
import { saveSettings, type Settings } from "@/lib/storage/settings";
import { applyTheme } from "@/lib/storage/theme";
import { formatBytes } from "@/lib/util/text";
import {
  canRunOcr,
  missingKeys,
  ocrRequestKey,
  selectSourceText,
  usableKey,
  type Action,
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
  rt.dispatch({
    type: "ocr/set",
    ocr: {
      source: "cache",
      model: entry.model,
      response: entry.response,
      text: buildOcrText(entry.response),
      docId,
      requestKey: ocrRequestKey(state.settings.ocrModel, pages),
      cacheKey: key,
    },
  });
  await restoreSavedTranslation(rt, docId, hash, key);
}

/** Show the newest saved translation of the same document (and OCR result) right away. */
async function restoreSavedTranslation(rt: Runtime, docId: string, sourceHash: string, ocrKey: string | null): Promise<void> {
  if (!rt.getState().settings.saveTranslations) return;
  const saved = await findSavedTranslation<TranslationState>(sourceHash, ocrKey);
  const state = rt.getState();
  if (!saved || state.doc?.id !== docId || state.translation || state.job) return;
  rt.dispatch({ type: "translation/set", translation: { ...saved.translation, restored: true } });
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
  let ocr: OcrState | null = null;
  const cached = saved.ocrKey ? await getCachedOcr(saved.ocrKey) : null;
  if (cached) {
    ocr = {
      source: "cache",
      model: cached.model,
      response: cached.response,
      text: buildOcrText(cached.response),
      docId: `saved:${saved.id}`,
      requestKey: "",
      cacheKey: saved.ocrKey,
    };
  }
  if (superseded()) return;
  releaseDocument(rt);
  const textSource = saved.sourceKind === "pasted" || saved.sourceKind === "text";
  rt.dispatch({ type: "history/open", ocr, translation: { ...saved.translation, restored: true }, pastedText: textSource ? saved.translation.sourceText : null });
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
  ctx: PipelineContext;
  controller: AbortController;
}

/**
 * Check keys and settings and start a job in the store; null when it cannot
 * start (the reason is shown). `forTranslation` runs a job that adds to that
 * translation (original-language structure, retries) in its own target
 * language, and with its own provider and model while their key is usable,
 * whatever Settings say now; such jobs do not use the schema setting.
 */
function beginJob(rt: Runtime, kind: JobKind, stages: StageId[], needsChat: boolean, forTranslation?: TranslationState): Job | null {
  const state = rt.getState();
  if (state.job) return null;
  let settings = state.settings;
  if (forTranslation) {
    const own = usableKey(state.keys, forTranslation.provider) !== null;
    settings = {
      ...settings,
      targetLanguage: forTranslation.targetLanguage as Settings["targetLanguage"],
      // Its schema travels with the translation; an invalid custom schema in Settings must not block it.
      schemaMode: { kind: "infer" },
      ...(own ? { provider: forTranslation.provider, chatModels: { ...settings.chatModels, [forTranslation.provider]: forTranslation.model } } : {}),
    };
  }
  const mistralKey = usableKey(state.keys, "mistral");
  const chatKey = usableKey(state.keys, settings.provider);
  const needsOcr = kind === "ocr" || kind === "both";
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
    controller,
    ctx: {
      ocr: new MistralClient({ apiKey: mistralKey ?? "" }),
      chat: createProvider(settings.provider, chatKey ?? mistralKey ?? ""),
      settings: pipelineSettings,
      signal: controller.signal,
      onProgress: (event) => rt.dispatch({ type: "job/event", event }),
    },
  };
}

/** Report a job's failure unless it was cancelled; always ends the job. */
function endJob(rt: Runtime, job: Job, title: string, err?: unknown): void {
  if (err !== undefined) {
    // After a cancelled or failed job, nothing starts by itself: the user decides what runs next.
    const current = rt.getState().translation?.id;
    if (current) originalRequested.add(current);
    if (!isCancellation(err, job)) {
      rt.dispatch({ type: "error/set", error: toAppError(err, title) });
      job.controller.abort(); // stop stages still running in the background
    }
  }
  rt.dispatch({ type: "job/end" });
}

/** Translations whose original-language structure was already requested or settled (it is not requested again automatically). */
const originalRequested = new Set<string>();

/** The OCR result on screen, if it is the one `t` was translated from (not another page selection, document or source). */
function ocrOf(state: AppState, t: TranslationState): OcrText | undefined {
  return state.ocr && state.ocr.text.text === t.sourceText ? state.ocr.text : undefined;
}

function isCancellation(err: unknown, job: Job): boolean {
  return job.controller.signal.aborted || (err instanceof ApiError && err.kind === "aborted");
}

/** The stages a translation runs, for the job status card. */
function translationStages(settings: Settings, withOcr: boolean, withBoxes: boolean): StageId[] {
  const stages: StageId[] = withOcr ? ["prepare", "ocr"] : [];
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
        return endJob(rt, job, jobTitle(kind));
      }
      source = { text: ocr.text.text, ocr: ocr.text, name: doc.name, kind: doc.kind, hash: doc.hash, ocrKey: ocr.cacheKey };
    }
    if (!source.text.trim()) throw new Error("OCR returned no text to translate.");
    await runTranslation(rt, job, source);
    endJob(rt, job, jobTitle(kind));
  } catch (err) {
    endJob(rt, job, jobTitle(kind), err);
  }
}

/**
 * OCR the loaded document, or reuse the result already loaded for it with the
 * same model and pages (`reuse`, used by "OCR + Translate": no second charge).
 */
async function runOcrStage(rt: Runtime, job: Job, doc: DocState, reuse: boolean): Promise<{ text: OcrText; cacheKey: string | null }> {
  const { ctx } = job;
  const settings = rt.getState().settings;
  const selection = parsePageSelection(doc.pageSelection, doc.pageCount);
  if (selection.error) throw new Error(`Pages to OCR: ${selection.error}`);
  const requestKey = ocrRequestKey(settings.ocrModel, selection.pages);
  const cacheKey = doc.hash ? ocrCacheKey(doc.hash, settings.ocrModel, selection.pages) : null;

  const loaded = rt.getState().ocr;
  if (reuse && loaded && loaded.docId === doc.id && loaded.requestKey === requestKey) {
    emit(ctx.onProgress, "prepare", "skipped", "The document was already OCR'd with these settings");
    emit(ctx.onProgress, "ocr", "skipped", `Reusing the OCR result ${loaded.source === "cache" ? "from this browser's cache" : "of this session"}: no new OCR charge`);
    return { text: loaded.text, cacheKey: loaded.cacheKey ?? cacheKey };
  }

  emit(ctx.onProgress, "prepare", "start", `Encoding ${doc.name} (${formatBytes(doc.size)})`);
  const dataUrl = await fileToDataUrl(doc.file, doc.mimeType);
  emit(ctx.onProgress, "prepare", "done", "Document encoded");
  const outcome = await ocrOnly(ctx, { dataUrl, mimeType: doc.mimeType, fileName: doc.name }, selection.pages);
  job.controller.signal.throwIfAborted();
  rt.dispatch({
    type: "ocr/set",
    ocr: { source: "api", model: outcome.response.model, response: outcome.response, text: outcome.text, docId: doc.id, requestKey, cacheKey },
  });
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
  return { text: outcome.text, cacheKey };
}

async function describeSource(state: AppState, text: string, origin: "ocr" | "textfile" | "pasted" | "saved"): Promise<Source> {
  const { doc, ocr, translation } = state;
  if (origin === "ocr" && ocr) {
    if (doc) return { text, ocr: ocr.text, name: doc.name, kind: doc.kind, hash: doc.hash, ocrKey: ocr.cacheKey };
    // OCR reopened from "Recent translations".
    return { text, ocr: ocr.text, name: translation?.sourceName ?? "Saved document", kind: translation?.sourceKind ?? "pdf", hash: translation?.sourceHash ?? null, ocrKey: ocr.cacheKey };
  }
  if (origin === "saved" && translation) {
    return { text, ocr: undefined, name: translation.sourceName, kind: translation.sourceKind, hash: translation.sourceHash, ocrKey: null };
  }
  const name = origin === "textfile" && doc ? doc.name : "Pasted text";
  return { text, ocr: undefined, name, kind: origin === "textfile" ? "text" : "pasted", hash: await hashText(text), ocrKey: null };
}

/**
 * Schema → translation, with the bbox annotation running alongside (it does
 * not feed into the translation), then the follow-ups side by side. A
 * follow-up that fails leaves a warning on the result instead of failing
 * the job: the translation is already there.
 */
async function runTranslation(rt: Runtime, job: Job, source: Source): Promise<void> {
  const { ctx, controller } = job;
  const appSettings = rt.getState().settings;
  const warnings: string[] = [];
  const followUp = <T>(stage: StageId, label: string, task: Promise<T | null>): Promise<T | null> =>
    task.catch((err: unknown) => {
      if (isCancellation(err, job)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${label} failed: ${message}`);
      emit(ctx.onProgress, stage, "warning", `${label} failed`, { detail: message });
      emit(ctx.onProgress, stage, "done", "Stopped; the translation is unaffected");
      return null;
    });

  const schema = await resolveSchema(ctx, source.text);
  controller.signal.throwIfAborted();
  const bboxes = followUp("bbox_annotate", "Bounding-box descriptions", describeBboxes(ctx, source.ocr));
  void bboxes.catch(() => undefined); // awaited below; a failing translation must not leave it unhandled

  const translation = await translateDocument(ctx, source.text, schema.schema, source.ocr);
  controller.signal.throwIfAborted();
  const completedAt = Date.now();
  const id = crypto.randomUUID();
  rt.dispatch({
    type: "translation/set",
    translation: {
      id,
      sourceName: source.name,
      sourceKind: source.kind,
      sourceHash: source.hash,
      ocrKey: source.ocrKey,
      sourceText: source.text,
      data: translation.data,
      rawText: translation.rawText,
      schema: schema.schema,
      schemaSource: schema.source,
      schemaWarnings: schema.warnings,
      usage: translation.usage,
      inferUsage: schema.inferred?.usage ?? null,
      provider: appSettings.provider,
      model: translation.model,
      mode: translation.mode,
      violations: translation.violations,
      finishReason: translation.finishReason,
      partial: translation.partial,
      targetLanguage: appSettings.targetLanguage,
      completedAt,
      sourceChars: source.text.length,
      imagesSent: translation.imagesSent,
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
    },
  });
  const patch = (p: Partial<TranslationState>) => rt.dispatch({ type: "translation/patch", patch: p });
  // In "always" mode the stage runs below; whatever its outcome, the view must not request it again by itself.
  if (ctx.settings.structureOriginal === "always") originalRequested.add(id);

  // Follow-ups, side by side; each result shows up as soon as it is in.
  // The original-language structure reads the document prefix the translation just cached.
  try {
    await Promise.all([
      bboxes.then((b) => b && patch({ bboxAnnotations: b.annotations, bboxUsage: b.usage })),
      ctx.settings.structureOriginal === "always"
        ? followUp("structure_original", "Structured text in the original language", structureOriginal(ctx, source.text, schema.schema, source.ocr)).then(
            (o) => o && patch({ originalData: o.data, originalRawText: o.rawText, originalUsage: o.usage, originalViolations: o.violations }),
          )
        : null,
      source.ocr
        ? followUp("block_translate", "Block translations", blockTranslations(ctx, source.ocr)).then(
            (b) => b && patch({ blockTranslations: b.translations, blockUsage: b.usage }),
          )
        : emit(ctx.onProgress, "block_translate", "skipped", "No text blocks (text input)"),
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
  if (!t || state.job || (t.originalData !== null && t.originalData !== undefined) || state.settings.structureOriginal === "never") return;
  if (!force && originalRequested.has(t.id)) return;
  const job = beginJob(rt, "original", ["structure_original"], true, t);
  if (!job) return;
  originalRequested.add(t.id);
  try {
    const ocr = ocrOf(state, t);
    const original = await structureOriginal(job.ctx, t.sourceText, t.schema, ocr);
    job.controller.signal.throwIfAborted();
    if (rt.getState().translation?.id === t.id) {
      rt.dispatch({
        type: "translation/patch",
        patch: { originalData: original.data, originalRawText: original.rawText, originalUsage: original.usage, originalViolations: original.violations },
      });
      await saveTranslation(rt);
    }
    endJob(rt, job, jobTitle("original"));
  } catch (err) {
    endJob(rt, job, jobTitle("original"), err);
  }
}

/** Run the bounding boxes or text blocks that failed (or came back empty) again, and merge the results in. */
export async function retryFailed(rt: Runtime, what: "bboxes" | "blocks"): Promise<void> {
  const state = rt.getState();
  const t = state.translation;
  const ocr = t ? ocrOf(state, t) : undefined;
  if (!t || !ocr || state.job) return;
  const ids =
    what === "bboxes"
      ? new Set(t.bboxAnnotations.filter((a) => !a.data).map((a) => a.id))
      : new Set(ocr.pages.flatMap((p) => textBlocks(p).map((b) => b.id)).filter((id) => !t.blockTranslations[id]?.trim()));
  if (!ids.size) return;
  const job = beginJob(rt, "retry", [what === "bboxes" ? "bbox_annotate" : "block_translate"], true, t);
  if (!job) return;
  try {
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
      const out = await blockTranslations(job.ctx, ocr, ids);
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
    endJob(rt, job, jobTitle("retry"));
  } catch (err) {
    endJob(rt, job, jobTitle("retry"), err);
  }
}

function jobTitle(kind: JobKind): string {
  switch (kind) {
    case "ocr":
      return "OCR failed";
    case "translate":
      return "Translation failed";
    case "both":
      return "OCR + translation failed";
    case "original":
      return "Structured text in the original language failed";
    case "retry":
      return "Retry failed";
  }
}

function toPipelineSettings(settings: Settings): PipelineSettings | { error: NonNullable<AppState["error"]> } {
  let schemaMode: SchemaMode;
  switch (settings.schemaMode.kind) {
    case "infer":
      schemaMode = { kind: "infer" };
      break;
    case "builtin":
      schemaMode = { kind: "builtin", id: settings.schemaMode.id };
      break;
    case "custom": {
      try {
        const parsed: unknown = JSON.parse(settings.schemaMode.schemaText || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Schema must be a JSON object");
        schemaMode = { kind: "custom", schema: parsed as Record<string, unknown> };
      } catch (err) {
        return {
          error: {
            title: "Custom schema is not valid JSON",
            message: err instanceof Error ? err.message : String(err),
            hint: "Fix the schema in Settings or switch to inferred / built-in schema.",
          },
        };
      }
      break;
    }
  }
  const info = PROVIDERS[settings.provider];
  return {
    ocrModel: settings.ocrModel,
    chatModel: settings.chatModels[settings.provider] || info.defaultModel,
    schemaMode,
    streaming: settings.streaming,
    temperature: settings.temperature,
    reasoningEffort: info.supportsReasoningEffort ? settings.reasoningEffort : undefined,
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

export function toAppError(err: unknown, title: string): NonNullable<AppState["error"]> {
  if (err instanceof ApiError) {
    const error: NonNullable<AppState["error"]> = { title, message: err.message, hint: err.hint };
    if (err.body !== undefined && err.body !== null) {
      error.details = typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2);
    }
    return error;
  }
  if (err instanceof Error) {
    const error: NonNullable<AppState["error"]> = { title, message: err.message };
    if (err.stack) error.details = err.stack;
    return error;
  }
  return { title, message: String(err) };
}
