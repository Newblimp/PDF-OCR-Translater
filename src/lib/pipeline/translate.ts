/**
 * Document annotation step (Mistral's workflow, performed by the vision
 * model): the OCR Markdown, the first bounding-box images and the JSON
 * format go to the vision LLM, which returns the JSON. In this app the JSON
 * is the translation of the document.
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
import { emit, type ProgressListener } from "./events";
import { translationSystemPrompt, translationUserPrompt, type PromptContext } from "./prompts";
import { findSchemaViolations } from "./schema";

export type StructuredMode = "json_schema" | "json_object";

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
  const system = translationSystemPrompt(options);

  emit(
    onProgress,
    "translate",
    "start",
    `Translating with ${options.model} (${provider.label}) into ${options.targetLanguage}${images.length ? `, with ${images.length} bounding-box image(s)` : ""}`,
  );

  // Attempts, in order. A fallback only triggers on a 4xx "bad request" that a
  // different request shape could fix; every other error propagates.
  const streaming = options.streaming !== false;
  const attempts: Attempt[] = [];
  const push = (a: Attempt) => {
    if (!attempts.some((x) => x.mode === a.mode && x.stream === a.stream && x.images === a.images)) attempts.push(a);
  };
  push({ mode: "json_schema", stream: streaming, images: images.length > 0 });
  if (images.length) push({ mode: "json_schema", stream: streaming, images: false });
  if (streaming) push({ mode: "json_schema", stream: false, images: false });
  push({ mode: "json_object", stream: false, images: false });

  let result: JsonChatResult | null = null;
  let used: Attempt = attempts[0]!;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    try {
      result = await complete(provider, system, documentText, schemaJson, attempt.images ? images : [], options, attempt);
      used = attempt;
      break;
    } catch (err) {
      const next = attempts[i + 1];
      if (!isRetryableRejection(err) || !next) throw err;
      emit(
        onProgress,
        "translate",
        "warning",
        `The API rejected the request (${describe(attempt)}); retrying (${describe(next)})`,
        { detail: err.message },
      );
    }
  }
  if (!result) throw new Error("Translation did not run.");

  if (result.finishReason === "length" || result.finishReason === "model_length") {
    emit(onProgress, "translate", "warning", "The model hit its output limit; the translation may be truncated.");
  }

  const parsed = parseModelJson(result.content);
  if (!parsed.ok) {
    if (result.finishReason === "content_filter") {
      throw new Error("The provider's content filter stopped the output before any JSON was produced. Try another model or split the document.");
    }
    throw new Error(`Translation output could not be parsed: ${parsed.error}`);
  }
  if (result.finishReason === "content_filter") {
    emit(onProgress, "translate", "warning", "The provider's content filter stopped the output early; the translation may be incomplete.");
  }
  const violations = findSchemaViolations(parsed.value, options.schema);
  emit(onProgress, "translate", "done", `Translation received (${result.content.length.toLocaleString()} characters)`, {
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
) {
  let lastReport = 0;
  return provider.completeJson({
    model: options.model,
    system,
    user: translationUserPrompt(documentText, schemaJson, images.map((i) => i.id)),
    images: images.length ? images : undefined,
    format:
      attempt.mode === "json_schema"
        ? {
            type: "json_schema",
            name: "translated_document",
            description: "Translation of the document, one field per schema property.",
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
            emit(options.onProgress, "translate", "progress", "Receiving translation…", {
              receivedChars: accumulated.length,
              streamText: accumulated,
            });
          }
        }
      : undefined,
  });
}
