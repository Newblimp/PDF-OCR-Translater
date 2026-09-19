/**
 * Document annotation step (Mistral's workflow, performed by the vision
 * model): the OCR Markdown, the first bounding-box images and the JSON
 * format go to the vision LLM, which returns the JSON. In this app the JSON
 * is the translation of the document.
 *
 * The same call, with `target: "original"`, fills the same JSON without
 * translating, which backs the "show translation" toggle of the
 * "Structured text" tab.
 *
 * Uses the provider's structured output mode (`json_schema`, strict) so the
 * API only returns well-formed JSON matching the schema. If the API rejects
 * the request, we fall back step by step: without images (models without
 * vision), non-streaming, and finally `json_object` mode.
 */
import { ApiError } from "../http/apiError";
import type { AttachedImage, ChatProvider, JsonChatResult, ReasoningEffort, TokenUsage } from "../llm/provider";
import type { JsonSchemaObject } from "../mistral/types";
import { parseModelJson } from "../util/json";
import { emit, type ProgressListener, type StageId } from "./events";
import {
  originalStructureSystemPrompt,
  originalStructureUserPrompt,
  translationSystemPrompt,
  translationUserPrompt,
  type PromptContext,
} from "./prompts";
import { findSchemaViolations } from "./schema";

export type StructuredMode = "json_schema" | "json_object";

/**
 * What the call should produce: the translated JSON (the default) or the same
 * JSON with every value left in the document's own language, which backs the
 * "Structured text" tab with the translation toggle off.
 */
export type StructureTarget = "translated" | "original";

export interface TranslateOptions extends PromptContext {
  model: string;
  schema: JsonSchemaObject;
  /** Bounding-box images handed to the vision model with the text (already capped by the caller). */
  images?: AttachedImage[] | undefined;
  temperature?: number | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  maxOutputTokens?: number | undefined;
  /** Stream tokens to report progress (default true). */
  streaming?: boolean | undefined;
  /** Translate the document (default) or keep its original language. */
  target?: StructureTarget | undefined;
  /** Stage the progress events belong to (default "translate"). */
  stage?: StageId | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

export interface TranslationOutcome {
  data: unknown;
  rawText: string;
  usage: TokenUsage | null;
  model: string;
  mode: StructuredMode;
  /** Number of images that were actually sent with the successful attempt. */
  imagesSent: number;
  /** Gross mismatches between the output and the schema (should be empty). */
  violations: string[];
  finishReason: string | null;
}

interface Attempt {
  mode: StructuredMode;
  stream: boolean;
  images: boolean;
}

export async function translateStructured(provider: ChatProvider, documentText: string, options: TranslateOptions): Promise<TranslationOutcome> {
  const { onProgress } = options;
  const images = options.images ?? [];
  const schemaJson = JSON.stringify(options.schema, null, 2);
  const target = options.target ?? "translated";
  const stage = options.stage ?? "translate";
  const system = target === "original" ? originalStructureSystemPrompt(options) : translationSystemPrompt(options);

  emit(
    onProgress,
    stage,
    "start",
    target === "original"
      ? `Structuring the original text with ${options.model} (${provider.label})${images.length ? `, with ${images.length} bounding-box image(s)` : ""}`
      : `Translating with ${options.model} (${provider.label}) into ${options.targetLanguage}${images.length ? `, with ${images.length} bounding-box image(s)` : ""}`,
  );

  // Fallback ladder. A retry only happens on a 4xx "bad request" that a
  // different request shape could fix; every other error propagates.
  //   image-related rejection  -> same request without images
  //   otherwise, streaming     -> non-streaming (images kept)
  //   otherwise, json_schema   -> json_object (images kept)
  const streaming = options.streaming !== false;
  let attempt: Attempt = { mode: "json_schema", stream: streaming, images: images.length > 0 };
  let result: JsonChatResult | null = null;
  let used: Attempt = attempt;
  for (let guard = 0; guard < 6; guard++) {
    try {
      result = await complete(provider, system, documentText, schemaJson, attempt.images ? images : [], options, attempt, target, stage);
      used = attempt;
      break;
    } catch (err) {
      if (!isRetryableRejection(err)) throw err;
      const next: Attempt | null =
        attempt.images && isImageRejection(err)
          ? { ...attempt, images: false }
          : attempt.stream
            ? { ...attempt, stream: false }
            : attempt.mode === "json_schema"
              ? { ...attempt, mode: "json_object" }
              : null;
      if (!next) throw err;
      emit(onProgress, stage, "warning", `The API rejected the request (${describe(attempt)}); retrying (${describe(next)})`, {
        detail: err.message,
      });
      attempt = next;
    }
  }
  if (!result) throw new Error("Translation did not run.");

  if (result.finishReason === "length" || result.finishReason === "model_length") {
    emit(onProgress, stage, "warning", "The model hit its output limit; the output may be truncated.");
  }

  const parsed = parseModelJson(result.content);
  if (!parsed.ok) {
    if (result.finishReason === "content_filter") {
      throw new Error("The provider's content filter stopped the output before any JSON was produced. Try another model or split the document.");
    }
    throw new Error(`Translation output could not be parsed: ${parsed.error}`);
  }
  if (result.finishReason === "content_filter") {
    emit(onProgress, stage, "warning", "The provider's content filter stopped the output early; the output may be incomplete.");
  }
  const violations = findSchemaViolations(parsed.value, options.schema);
  emit(onProgress, stage, "done", `${target === "original" ? "Structured original text" : "Translation"} received (${result.content.length.toLocaleString()} characters)`, {
    detail: violations.length ? `${violations.length} schema deviation(s)` : undefined,
  });
  return {
    data: parsed.value,
    rawText: result.content,
    usage: result.usage,
    model: result.model,
    mode: used.mode,
    imagesSent: used.images ? images.length : 0,
    violations,
    finishReason: result.finishReason,
  };
}

/** The provider complained about the images themselves (no vision support, bad content type, payload too large). */
function isImageRejection(err: ApiError): boolean {
  return err.status === 413 || /image|vision|content type|multimodal|too large|payload/i.test(err.message);
}

function describe(a: Attempt): string {
  return `${a.mode}${a.stream ? ", streaming" : ""}${a.images ? ", with images" : ", text only"}`;
}

/**
 * Only 4xx rejections that a different request shape could fix are worth a
 * retry: unsupported images/vision, schema keywords, streaming. Refusals,
 * unsupported parameters and unknown models fail the same way every time.
 */
function isRetryableRejection(err: unknown): err is ApiError {
  if (!(err instanceof ApiError) || err.kind !== "request") return false;
  return !/unsupported parameter|unsupported value|model_not_found|does not exist|do not have access|invalid model/i.test(err.message);
}

function complete(
  provider: ChatProvider,
  system: string,
  documentText: string,
  schemaJson: string,
  images: AttachedImage[],
  options: TranslateOptions,
  attempt: Attempt,
  target: StructureTarget,
  stage: StageId,
) {
  let lastReport = 0;
  const userPrompt = target === "original" ? originalStructureUserPrompt : translationUserPrompt;
  return provider.completeJson({
    model: options.model,
    system,
    user: userPrompt(documentText, schemaJson, images.map((i) => i.id)),
    images: images.length ? images : undefined,
    format:
      attempt.mode === "json_schema"
        ? {
            type: "json_schema",
            name: target === "original" ? "original_document" : "translated_document",
            description:
              target === "original"
                ? "The document's own text, one field per schema property, untranslated."
                : "Translation of the document, one field per schema property.",
            schema: options.schema,
            strict: true,
          }
        : { type: "json_object" },
    stream: attempt.stream,
    temperature: options.temperature ?? 0.2,
    reasoningEffort: options.reasoningEffort,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
    onDelta: attempt.stream
      ? (_delta, accumulated) => {
          // Throttle UI updates to roughly 10/s; the partial text lets the UI render live.
          const now = Date.now();
          if (now - lastReport > 100) {
            lastReport = now;
            emit(options.onProgress, stage, "progress", target === "original" ? "Receiving the structured original text…" : "Receiving translation…", {
              receivedChars: accumulated.length,
              streamText: accumulated,
            });
          }
        }
      : undefined,
  });
}
