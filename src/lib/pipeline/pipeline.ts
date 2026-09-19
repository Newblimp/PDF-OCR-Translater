/**
 * Orchestrates the three user-facing operations:
 *   - "OCR only"           : document → OCR text
 *   - "Translate only"     : text → (schema) → JSON translation
 *   - "OCR and translate"  : document → OCR text → (schema) → JSON translation
 *
 * The functions are plain async operations with progress callbacks; the UI
 * store decides what to display and what to cache.
 */
import type { MistralClient } from "../mistral/client";
import type { JsonSchemaObject } from "../mistral/types";
import { emit, type ProgressListener } from "./events";
import { inferSchema, type InferredSchema } from "./inferSchema";
import type { OcrText } from "./ocrText";
import type { PromptContext } from "./prompts";
import { runOcr, type OcrInput, type OcrOutcome } from "./runOcr";
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
}

export interface PipelineContext {
  client: MistralClient;
  settings: PipelineSettings;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
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
}

export async function ocrOnly(ctx: PipelineContext, input: OcrInput): Promise<OcrOutcome> {
  return runOcr(ctx.client, input, {
    model: ctx.settings.ocrModel,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  });
}

/** Resolve the output schema according to the selected mode. */
export async function resolveSchema(ctx: PipelineContext, documentText: string): Promise<SchemaResolution> {
  const { settings } = ctx;
  const mode = settings.schemaMode;
  if (mode.kind === "infer") {
    const inferred = await inferSchema(ctx.client, documentText, {
      model: settings.chatModel,
      targetLanguage: settings.targetLanguage,
      sourceLanguage: settings.sourceLanguage,
      domainHint: settings.domainHint,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
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

export async function translateText(ctx: PipelineContext, documentText: string): Promise<TranslateTextResult> {
  const schema = await resolveSchema(ctx, documentText);
  const translation = await translateStructured(ctx.client, documentText, {
    model: ctx.settings.chatModel,
    schema: schema.schema,
    temperature: ctx.settings.temperature,
    streaming: ctx.settings.streaming,
    targetLanguage: ctx.settings.targetLanguage,
    sourceLanguage: ctx.settings.sourceLanguage,
    domainHint: ctx.settings.domainHint,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  });
  return { schema, translation };
}

export interface OcrAndTranslateResult extends TranslateTextResult {
  ocr: OcrOutcome;
}

export async function ocrAndTranslate(ctx: PipelineContext, input: OcrInput): Promise<OcrAndTranslateResult> {
  const ocr = await ocrOnly(ctx, input);
  const rest = await translateText(ctx, ocr.text.text);
  return { ocr, ...rest };
}

export type { OcrText, OcrOutcome, TranslationOutcome, InferredSchema };
