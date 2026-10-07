/**
 * The pipeline's stages, following Mistral's annotation workflow with the
 * vision LLM swapped for the selected provider:
 *
 *   document ──► Mistral OCR ──► Markdown + bounding boxes (images, blocks)
 *                                  │
 *                                  ├─► vision LLM per bounding box ──► bbox annotations
 *                                  │
 *                                  └─► Markdown + first 8 bbox images + JSON format
 *                                        ──► vision LLM ──► document annotation = translated JSON
 *
 * Follow-up stages, each behind a setting: `structureOriginal()` fills the
 * same JSON format with the document's own wording (on demand by default),
 * and `blockTranslations()` translates the OCR blocks one by one.
 *
 * The runner (`src/app/runner.ts`) composes the stages and runs the
 * independent ones concurrently: the bbox annotation alongside the
 * translation, the follow-ups alongside each other. Long documents are
 * filled in parts (`chunks.ts`) and merged.
 *
 * The functions are plain async operations with progress callbacks; the UI
 * store decides what to display and what to cache.
 */
import { addUsage, emptyUsage, type ChatProvider, type ReasoningEffort } from "../llm/provider";
import type { MistralClient } from "../mistral/client";
import type { JsonSchemaObject } from "../mistral/types";
import { parsePartialJson } from "../util/partialJson";
import { annotateBboxes, type BboxAnnotateOutcome } from "./bboxAnnotate";
import { translateBlocks, type BlockTranslateOutcome } from "./blockTranslate";
import { mergeStructured, splitDocument } from "./chunks";
import { emit, type ProgressListener, type ProgressEvent } from "./events";
import { inferSchema, type InferredSchema } from "./inferSchema";
import type { OcrText } from "./ocrText";
import type { PromptContext } from "./prompts";
import { DOCUMENT_ANNOTATION_MAX_IMAGES, runOcr, type OcrInput, type OcrOutcome } from "./runOcr";
import { findSchemaViolations, sanitizeSchema } from "./schema";
import { getBuiltinSchema } from "./schemas";
import { translateStructured, type StructureTarget, type TranslationOutcome } from "./translate";

export type SchemaMode =
  | { kind: "infer" }
  | { kind: "builtin"; id: string }
  | { kind: "custom"; schema: JsonSchemaObject };

/** When the JSON format is also filled in the document's own language. */
export type StructureOriginalMode = "always" | "on_demand" | "never";

export interface PipelineSettings extends PromptContext {
  ocrModel: string;
  chatModel: string;
  schemaMode: SchemaMode;
  streaming: boolean;
  temperature: number;
  reasoningEffort?: ReasoningEffort | undefined;
  maxOutputTokens?: number | undefined;
  /** Send the first bounding-box images with the text to the vision model (document annotation). */
  sendImages: boolean;
  /** Describe each bounding box with the vision model (bbox annotation). */
  bboxAnnotations: boolean;
  /** Upper bound on bounding boxes described per run. */
  maxBboxAnnotations: number;
  /** Translate the OCR text blocks for the bounding-box view. */
  blockTranslations: boolean;
  /** Fill the JSON format with the document's own wording after every translation, only when asked for, or never. */
  structureOriginal: StructureOriginalMode;
}

export interface PipelineContext {
  /** Mistral client used for OCR. */
  ocr: MistralClient;
  /** Vision-capable chat provider used for schema inference, bbox annotation and translation. */
  chat: ChatProvider;
  settings: PipelineSettings;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

export interface SchemaResolution {
  schema: JsonSchemaObject;
  source: "inferred" | "builtin" | "custom";
  inferred?: InferredSchema;
  warnings: string[];
}

function promptContext(settings: PipelineSettings): PromptContext {
  return {
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
    domainHint: settings.domainHint,
    glossary: settings.glossary,
  };
}

export async function ocrOnly(ctx: PipelineContext, input: OcrInput, pages: number[] | null = null): Promise<OcrOutcome> {
  return runOcr(ctx.ocr, input, { model: ctx.settings.ocrModel, pages, signal: ctx.signal, onProgress: ctx.onProgress });
}

/** Resolve the output schema according to the selected mode. */
export async function resolveSchema(ctx: PipelineContext, documentText: string): Promise<SchemaResolution> {
  const { settings } = ctx;
  const mode = settings.schemaMode;
  if (mode.kind === "infer") {
    const inferred = await inferSchema(ctx.chat, documentText, {
      ...promptContext(settings),
      model: settings.chatModel,
      reasoningEffort: settings.reasoningEffort,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
    return { schema: inferred.schema, source: "inferred", inferred, warnings: inferred.warnings };
  }
  if (mode.kind === "builtin") {
    const builtin = getBuiltinSchema(mode.id);
    if (!builtin) throw new Error(`Unknown built-in schema "${mode.id}"`);
    emit(ctx.onProgress, "infer_schema", "skipped", `Using built-in schema: ${builtin.label}`);
    return { schema: builtin.schema, source: "builtin", warnings: [] };
  }
  const { schema, warnings } = sanitizeSchema(mode.schema);
  emit(ctx.onProgress, "infer_schema", "skipped", "Using custom schema", {
    detail: warnings.length ? `${warnings.length} adjustment(s) made for strict mode` : undefined,
  });
  return { schema, source: "custom", warnings };
}

/**
 * BBox annotation: one vision call per extracted box. Null when the stage is
 * skipped (text input, or disabled in Settings unless `onlyIds` retries boxes).
 */
export async function describeBboxes(ctx: PipelineContext, ocr: OcrText | undefined, onlyIds?: ReadonlySet<string>): Promise<BboxAnnotateOutcome | null> {
  const { settings } = ctx;
  if (!ocr) {
    emit(ctx.onProgress, "bbox_annotate", "skipped", "No bounding boxes (text input)");
    return null;
  }
  if (!settings.bboxAnnotations && !onlyIds) {
    emit(ctx.onProgress, "bbox_annotate", "skipped", "Bounding-box descriptions disabled in Settings");
    return null;
  }
  return annotateBboxes(ctx.chat, ocr, {
    ...promptContext(settings),
    model: settings.chatModel,
    maxBoxes: settings.maxBboxAnnotations,
    onlyIds,
    reasoningEffort: settings.reasoningEffort,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
}

/** Document annotation: text + first eight bbox images + schema → translated JSON. */
export function translateDocument(ctx: PipelineContext, documentText: string, schema: JsonSchemaObject, ocr?: OcrText): Promise<TranslationOutcome> {
  return fillStructure(ctx, documentText, schema, ocr, "translated");
}

/**
 * Fill the same JSON format with the document's own language, so the
 * "Structured text" tab can show the original next to the translation.
 * Runs after the translation (reading the document prefix from the prompt
 * cache), or on demand.
 */
export function structureOriginal(ctx: PipelineContext, documentText: string, schema: JsonSchemaObject, ocr?: OcrText): Promise<TranslationOutcome> {
  return fillStructure(ctx, documentText, schema, ocr, "original");
}

/** Translate the OCR text blocks for the bounding-box view; `onlyIds` retries the blocks that came back without a translation. */
export async function blockTranslations(ctx: PipelineContext, ocr: OcrText, onlyIds?: ReadonlySet<string>): Promise<BlockTranslateOutcome | null> {
  if (!ctx.settings.blockTranslations && !onlyIds) {
    emit(ctx.onProgress, "block_translate", "skipped", "Block translations disabled in Settings");
    return null;
  }
  const { settings } = ctx;
  return translateBlocks(ctx.chat, ocr, {
    ...promptContext(settings),
    model: settings.chatModel,
    reasoningEffort: settings.reasoningEffort,
    onlyIds,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
}

/** Bounding-box images handed to the vision model with the text: those of the given pages, capped, and only when enabled. */
function annotationImages(ctx: PipelineContext, ocr: OcrText | undefined, pageIndices: number[] | null): Array<{ id: string; dataUrl: string }> {
  if (!ocr || !ctx.settings.sendImages) return [];
  return ocr.bboxes
    .filter((b) => b.dataUrl && (!pageIndices || pageIndices.includes(b.pageIndex)))
    .slice(0, DOCUMENT_ANNOTATION_MAX_IMAGES)
    .map((b) => ({ id: b.id, dataUrl: b.dataUrl! }));
}

/** Fill the JSON format (translated or original), one request per part of the document, and merge the parts. */
async function fillStructure(
  ctx: PipelineContext,
  documentText: string,
  schema: JsonSchemaObject,
  ocr: OcrText | undefined,
  target: StructureTarget,
): Promise<TranslationOutcome> {
  const { settings } = ctx;
  const stage = target === "original" ? "structure_original" : "translate";
  const chunks = splitDocument(documentText, ocr);
  if (chunks.length > 1) {
    emit(ctx.onProgress, stage, "start", `Long document: ${chunks.length} parts (${chunks.map((c) => c.label).join(", ")}), filled one after another and merged`);
  }
  const outcomes: TranslationOutcome[] = [];
  let merged: unknown = undefined;
  let charsBefore = 0;
  for (const [index, chunk] of chunks.entries()) {
    const outcome = await translateStructured(ctx.chat, chunk.text, {
      ...promptContext(settings),
      model: settings.chatModel,
      schema,
      images: annotationImages(ctx, ocr, chunk.pageIndices),
      temperature: settings.temperature,
      reasoningEffort: settings.reasoningEffort,
      maxOutputTokens: settings.maxOutputTokens,
      // Only the translation streams into the UI; the original-language structure is a follow-up.
      streaming: target === "translated" && settings.streaming,
      target,
      stage,
      part: chunks.length > 1 ? { index, count: chunks.length, label: chunk.label } : undefined,
      signal: ctx.signal,
      onProgress: index === 0 ? ctx.onProgress : withEarlierParts(ctx.onProgress, merged, charsBefore),
    });
    merged = mergeStructured(merged, outcome.data);
    charsBefore += outcome.rawText.length;
    outcomes.push(outcome);
  }
  return combineOutcomes(outcomes, merged, schema);
}

/** While part n streams, show it merged with the parts already done, so the live view keeps what came before. */
function withEarlierParts(listener: ProgressListener | undefined, earlier: unknown, charsBefore: number): ProgressListener | undefined {
  if (!listener) return undefined;
  return (event: ProgressEvent) => {
    if (event.streamText === undefined) return listener(event);
    let current: unknown;
    try {
      current = parsePartialJson(event.streamText);
    } catch {
      current = undefined;
    }
    listener({
      ...event,
      streamText: JSON.stringify(mergeStructured(earlier, current ?? {})),
      receivedChars: charsBefore + (event.receivedChars ?? 0),
    });
  };
}

function combineOutcomes(outcomes: TranslationOutcome[], merged: unknown, schema: JsonSchemaObject): TranslationOutcome {
  if (outcomes.length === 1) return outcomes[0]!;
  const usage = emptyUsage();
  for (const o of outcomes) addUsage(usage, o.usage);
  const reasons = outcomes.map((o) => o.finishReason);
  return {
    data: merged,
    rawText: outcomes.map((o) => o.rawText).join("\n"),
    usage,
    model: outcomes.at(-1)!.model,
    mode: outcomes.some((o) => o.mode === "json_object") ? "json_object" : "json_schema",
    imagesSent: outcomes.reduce((n, o) => n + o.imagesSent, 0),
    violations: findSchemaViolations(merged, schema),
    finishReason: reasons.find((r) => r === "length" || r === "model_length") ?? reasons.find((r) => r === "content_filter") ?? reasons.at(-1) ?? null,
    partial: outcomes.some((o) => o.partial),
  };
}

export type { OcrText, OcrOutcome, TranslationOutcome, InferredSchema, BboxAnnotateOutcome, BlockTranslateOutcome };
