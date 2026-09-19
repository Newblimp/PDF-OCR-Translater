/**
 * Orchestrates the three user-facing operations:
 *   - "OCR only"           : document → OCR text                 (Mistral OCR)
 *   - "Translate only"     : text → (schema) → JSON translation  (chat provider)
 *   - "OCR and translate"  : both
 *
 * The functions are plain async operations with progress callbacks; the UI
 * store decides what to display and what to cache.
 */
import type { ChatProvider, ReasoningEffort } from "../llm/provider";
import type { MistralClient } from "../mistral/client";
import type { JsonSchemaObject } from "../mistral/types";
import { emit, type ProgressListener } from "./events";
import { inferSchema, type InferredSchema } from "./inferSchema";
import type { OcrText } from "./ocrText";
import type { PromptContext } from "./prompts";
import { annotateWithOcr, runOcr, type AnnotationOutcome, type OcrInput, type OcrOutcome } from "./runOcr";
import { annotationPrompt } from "./prompts";
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
  /** Send the resolved JSON format to Mistral OCR as document annotation before translating. */
  annotateWithOcr: boolean;
}

export interface PipelineContext {
  /** Mistral client used for OCR. */
  ocr: MistralClient;
  /** Chat provider used for schema inference and translation. */
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
  /** Mistral OCR's own extraction into the schema, when the stage ran. */
  annotation: AnnotationOutcome | null;
  /** Why the annotation stage did not run (shown in the UI). */
  annotationNote: string | null;
}

export interface TranslateTextOptions {
  /** The original document, needed to run the annotation stage. */
  document?: OcrInput | undefined;
  pageCount?: number | null | undefined;
}

export async function ocrOnly(ctx: PipelineContext, input: OcrInput): Promise<OcrOutcome> {
  return runOcr(ctx.ocr, input, { model: ctx.settings.ocrModel, signal: ctx.signal, onProgress: ctx.onProgress });
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
  const schema = await resolveSchema(ctx, documentText);

  let annotation: AnnotationOutcome | null = null;
  let annotationNote: string | null = null;
  if (!ctx.settings.annotateWithOcr) {
    annotationNote = "Disabled in Settings.";
    emit(ctx.onProgress, "annotate", "skipped", "Mistral OCR annotation disabled in Settings");
  } else if (!opts.document) {
    annotationNote = "Only possible when the source is a PDF or image; pasted or text-file input skips it.";
    emit(ctx.onProgress, "annotate", "skipped", "No document to annotate (text input)");
  } else {
    annotation = await annotateWithOcr(ctx.ocr, opts.document, {
      model: ctx.settings.ocrModel,
      schema: schema.schema,
      pageCount: opts.pageCount,
      prompt: annotationPrompt(ctx.settings),
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
  }

  const translation = await translateStructured(ctx.chat, documentText, {
    annotationJson: annotation ? JSON.stringify(annotation.data, null, 2) : undefined,
    model: ctx.settings.chatModel,
    schema: schema.schema,
    temperature: ctx.settings.temperature,
    reasoningEffort: ctx.settings.reasoningEffort,
    maxOutputTokens: ctx.settings.maxOutputTokens,
    streaming: ctx.settings.streaming,
    targetLanguage: ctx.settings.targetLanguage,
    sourceLanguage: ctx.settings.sourceLanguage,
    domainHint: ctx.settings.domainHint,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
  return { schema, translation, annotation, annotationNote };
}

export interface OcrAndTranslateResult extends TranslateTextResult {
  ocr: OcrOutcome;
}

export async function ocrAndTranslate(ctx: PipelineContext, input: OcrInput): Promise<OcrAndTranslateResult> {
  const ocr = await ocrOnly(ctx, input);
  const rest = await translateText(ctx, ocr.text.text, { document: input, pageCount: ocr.text.pagesProcessed });
  return { ocr, ...rest };
}

export type { OcrText, OcrOutcome, TranslationOutcome, InferredSchema, AnnotationOutcome };
