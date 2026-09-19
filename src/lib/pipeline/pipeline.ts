/**
 * Orchestrates the three user-facing operations, following Mistral's
 * annotation workflow with the vision LLM swapped for the selected provider:
 *
 *   document ──► Mistral OCR ──► Markdown + bounding boxes (images, blocks)
 *                                  │
 *                                  ├─► vision LLM per bounding box ──► bbox annotations
 *                                  │
 *                                  └─► Markdown + first 8 bbox images + JSON format
 *                                        ──► vision LLM ──► document annotation = translated JSON
 *
 *   - "OCR only"           : document → OCR
 *   - "Translate only"     : text (+ boxes when the OCR result is at hand) → JSON translation
 *   - "OCR and translate"  : both
 *
 * The functions are plain async operations with progress callbacks; the UI
 * store decides what to display and what to cache.
 */
import type { ChatProvider, ReasoningEffort } from "../llm/provider";
import type { MistralClient } from "../mistral/client";
import type { JsonSchemaObject } from "../mistral/types";
import { annotateBboxes, type BboxAnnotateOutcome } from "./bboxAnnotate";
import { translateBlocks, type BlockTranslateOutcome } from "./blockTranslate";
import { emit, type ProgressListener } from "./events";
import { inferSchema, type InferredSchema } from "./inferSchema";
import type { OcrText } from "./ocrText";
import type { PromptContext } from "./prompts";
import { DOCUMENT_ANNOTATION_MAX_IMAGES, runOcr, type OcrInput, type OcrOutcome } from "./runOcr";
import { getBuiltinSchema } from "./schemas";
import { sanitizeSchema } from "./schema";
import { translateStructured, type TranslationOutcome } from "./translate";

export type SchemaMode =
  | { kind: "infer" }
  | { kind: "builtin"; id: string }
  | { kind: "custom"; schema: JsonSchemaObject };

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

export interface TranslateTextResult {
  schema: SchemaResolution;
  translation: TranslationOutcome;
  /** Per-bounding-box descriptions, when the stage ran. */
  bboxes: BboxAnnotateOutcome | null;
}

export interface TranslateTextOptions {
  /** OCR result of the loaded document, so bounding boxes can be used. */
  ocr?: OcrText | undefined;
}

export async function ocrOnly(ctx: PipelineContext, input: OcrInput, pages: number[] | null = null): Promise<OcrOutcome> {
  return runOcr(ctx.ocr, input, { model: ctx.settings.ocrModel, pages, signal: ctx.signal, onProgress: ctx.onProgress });
}

/** Translate the OCR text blocks for the bounding-box view (runs after the main translation). */
export async function blockTranslations(ctx: PipelineContext, ocr: OcrText): Promise<BlockTranslateOutcome | null> {
  if (!ctx.settings.blockTranslations) {
    emit(ctx.onProgress, "block_translate", "skipped", "Block translations disabled in Settings");
    return null;
  }
  const { settings } = ctx;
  return translateBlocks(ctx.chat, ocr, {
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
    domainHint: settings.domainHint,
    model: settings.chatModel,
    reasoningEffort: settings.reasoningEffort,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
}

/** Resolve the output schema according to the selected mode. */
export async function resolveSchema(ctx: PipelineContext, documentText: string): Promise<SchemaResolution> {
  const { settings } = ctx;
  const mode = settings.schemaMode;
  if (mode.kind === "infer") {
    const inferred = await inferSchema(ctx.chat, documentText, {
      model: settings.chatModel,
      targetLanguage: settings.targetLanguage,
      sourceLanguage: settings.sourceLanguage,
      domainHint: settings.domainHint,
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

export async function translateText(ctx: PipelineContext, documentText: string, opts: TranslateTextOptions = {}): Promise<TranslateTextResult> {
  const { settings } = ctx;
  const promptCtx = { targetLanguage: settings.targetLanguage, sourceLanguage: settings.sourceLanguage, domainHint: settings.domainHint };
  const schema = await resolveSchema(ctx, documentText);

  // BBox annotation: one vision call per extracted box.
  let bboxes: BboxAnnotateOutcome | null = null;
  if (!opts.ocr) {
    emit(ctx.onProgress, "bbox_annotate", "skipped", "No bounding boxes (text input)");
  } else if (!settings.bboxAnnotations) {
    emit(ctx.onProgress, "bbox_annotate", "skipped", "Bounding-box descriptions disabled in Settings");
  } else {
    bboxes = await annotateBboxes(ctx.chat, opts.ocr, {
      ...promptCtx,
      model: settings.chatModel,
      maxBoxes: settings.maxBboxAnnotations,
      reasoningEffort: settings.reasoningEffort,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
  }

  // Document annotation: text + first eight bbox images + schema → translated JSON.
  const images =
    opts.ocr && settings.sendImages
      ? opts.ocr.bboxes
          .filter((b) => b.dataUrl)
          .slice(0, DOCUMENT_ANNOTATION_MAX_IMAGES)
          .map((b) => ({ id: b.id, dataUrl: b.dataUrl! }))
      : [];
  const translation = await translateStructured(ctx.chat, documentText, {
    ...promptCtx,
    model: settings.chatModel,
    schema: schema.schema,
    images,
    temperature: settings.temperature,
    reasoningEffort: settings.reasoningEffort,
    maxOutputTokens: settings.maxOutputTokens,
    streaming: settings.streaming,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
  return { schema, translation, bboxes };
}

export interface OcrAndTranslateResult extends TranslateTextResult {
  ocr: OcrOutcome;
}

export async function ocrAndTranslate(ctx: PipelineContext, input: OcrInput): Promise<OcrAndTranslateResult> {
  const ocr = await ocrOnly(ctx, input);
  const rest = await translateText(ctx, ocr.text.text, { ocr: ocr.text });
  return { ocr, ...rest };
}

export type { OcrText, OcrOutcome, TranslationOutcome, InferredSchema, BboxAnnotateOutcome };
