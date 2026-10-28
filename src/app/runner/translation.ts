/**
 * The translation jobs: "OCR only", "Translate only" and "OCR + Translate"
 * (`runJob()`), with or without the JSON output, and the jobs that add to a
 * translation on screen: its structure in the original language and the
 * retries of what failed.
 */
import { addUsage, emptyUsage } from "@/lib/llm/provider";
import { fileToDataUrl } from "@/lib/files/dataUrl";
import { ocrTextFromPages, shownTextBlockIds, textPages, type BlockFilter } from "@/lib/pipeline/blocks";
import { emit, type StageId } from "@/lib/pipeline/events";
import type { TranslationOutcome } from "@/lib/pipeline/pipeline";
import type { OcrCleanPage, OcrText } from "@/lib/pipeline/ocrText";
import type { SourceKind } from "@/lib/storage/history";
import { OCR_CACHE_VERSION, ocrCacheKey, putCachedOcr } from "@/lib/storage/ocrCache";
import type { Settings } from "@/lib/storage/settings";
import { parsePageSelection } from "@/lib/util/pageSelection";
import { formatBytes } from "@/lib/util/text";
import {
  canRunOcr,
  excludedBlocks,
  hasOriginal,
  hasStructure,
  makeOcrState,
  ocrBelongsTo,
  ocrRequestKey,
  selectSourceText,
  translationDefaults,
  type AppState,
  type DocState,
  type TranslationState,
} from "../store";
import { hashText } from "./document";
import { beginJob, endJob, followUps, type Job } from "./jobs";
import type { Runtime } from "./runtime";
import { saveTranslation } from "./savedTranslations";

/** The pipeline's stages (prompts, schemas, the steps), imported when the first job runs: the page does not need them before. */
const pipeline = () => import("@/lib/pipeline/pipeline");

/** The OCR result on screen, if it is the one `t` was translated from (not another page selection, document or source). */
function ocrOf(state: AppState, t: TranslationState): OcrText | undefined {
  return state.ocr && ocrBelongsTo(state.ocr, t) ? state.ocr.text : undefined;
}

/** The blocks the OCR text tab keeps for these pages: the block types not hidden there, minus the blocks left out one by one. */
function blockFilter(state: AppState, pages: readonly OcrCleanPage[]): BlockFilter {
  return { hiddenTypes: new Set(state.settings.ocrHiddenTypes), excluded: excludedBlocks(state, pages) };
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
  if (ctx.settings.structureOriginal === "always") rt.session.originalRequested.add(id);

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
  if (!force && (rt.session.originalRequested.has(t.id) || state.error)) return;
  const job = beginJob(rt, "original", ["structure_original"], true, t);
  if (!job) return;
  rt.session.originalRequested.add(t.id);
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
