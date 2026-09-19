/**
 * Step 3: translate the document into a JSON object that follows a schema.
 *
 * Uses the provider's structured output mode (`json_schema`, strict) so the
 * API only returns well-formed JSON matching the schema. If the API rejects
 * the request (unsupported schema keyword, streaming/format combination), we
 * fall back step by step and finally to `json_object` mode with the schema
 * in the prompt.
 */
import { ApiError } from "../http/apiError";
import type { ChatProvider, JsonChatResult, ReasoningEffort, TokenUsage } from "../llm/provider";
import type { JsonSchemaObject } from "../mistral/types";
import { parseModelJson } from "../util/json";
import { emit, type ProgressListener } from "./events";
import { translationSystemPrompt, translationUserPrompt, type PromptContext } from "./prompts";
import { findSchemaViolations } from "./schema";

export type StructuredMode = "json_schema" | "json_object";

export interface TranslateOptions extends PromptContext {
  model: string;
  schema: JsonSchemaObject;
  temperature?: number | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  maxOutputTokens?: number | undefined;
  /** Stream tokens to report progress (default true). */
  streaming?: boolean | undefined;
  /** Source-language extraction by Mistral OCR for the same schema, if available. */
  annotationJson?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

export interface TranslationOutcome {
  data: unknown;
  rawText: string;
  usage: TokenUsage | null;
  model: string;
  mode: StructuredMode;
  /** Gross mismatches between the output and the schema (should be empty). */
  violations: string[];
  finishReason: string | null;
}

export async function translateStructured(provider: ChatProvider, documentText: string, options: TranslateOptions): Promise<TranslationOutcome> {
  const { onProgress } = options;
  const schemaJson = JSON.stringify(options.schema, null, 2);
  const system = translationSystemPrompt(options);
  const user = translationUserPrompt(documentText, schemaJson, options.annotationJson);

  emit(onProgress, "translate", "start", `Translating with ${options.model} (${provider.label}) into ${options.targetLanguage}`);

  // Attempts, in order. Each fallback only triggers on a 4xx "bad request";
  // every other error propagates immediately.
  const streaming = options.streaming !== false;
  const attempts: Array<{ mode: StructuredMode; stream: boolean }> = [
    { mode: "json_schema", stream: streaming },
    ...(streaming ? [{ mode: "json_schema" as const, stream: false }] : []),
    { mode: "json_object", stream: false },
  ];

  let result: JsonChatResult | null = null;
  let mode: StructuredMode = "json_schema";
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    try {
      result = await complete(provider, system, user, options, attempt.mode, attempt.stream);
      mode = attempt.mode;
      break;
    } catch (err) {
      const next = attempts[i + 1];
      if (!isFormatRejection(err) || !next) throw err;
      emit(
        onProgress,
        "translate",
        "warning",
        `The API rejected the request (${attempt.mode}${attempt.stream ? ", streaming" : ""}); retrying with ${next.mode}${next.stream ? ", streaming" : ""}`,
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
    mode,
    violations,
    finishReason: result.finishReason,
  };
}

/**
 * Only 4xx rejections that could be caused by the response format or the
 * streaming flag are worth a retry with a different format. Refusals,
 * unsupported parameters and unknown models fail the same way every time.
 */
function isFormatRejection(err: unknown): err is ApiError {
  if (!(err instanceof ApiError) || err.kind !== "request") return false;
  return !/unsupported parameter|unsupported value|model_not_found|does not exist|do not have access|invalid model|not supported/i.test(err.message);
}

function complete(provider: ChatProvider, system: string, user: string, options: TranslateOptions, mode: StructuredMode, stream: boolean) {
  let lastReport = 0;
  return provider.completeJson({
    model: options.model,
    system,
    user,
    format:
      mode === "json_schema"
        ? {
            type: "json_schema",
            name: "translated_document",
            description: "Translation of the document, one field per schema property.",
            schema: options.schema,
            strict: true,
          }
        : { type: "json_object" },
    stream,
    temperature: options.temperature ?? 0.2,
    reasoningEffort: options.reasoningEffort,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
    onDelta: stream
      ? (_delta, accumulated) => {
          // Throttle UI updates to roughly 10/s.
          const now = Date.now();
          if (now - lastReport > 100) {
            lastReport = now;
            emit(options.onProgress, "translate", "progress", "Receiving translation…", { receivedChars: accumulated.length });
          }
        }
      : undefined,
  });
}
