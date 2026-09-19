/**
 * Step 3: translate the document into a JSON object that follows a schema.
 *
 * Uses Mistral structured outputs (`response_format.type = "json_schema"`,
 * `strict: true`) so the API only returns well-formed JSON matching the
 * schema. If the API rejects the schema (unsupported keyword, too complex),
 * we fall back once to `json_object` mode with the schema in the prompt.
 */
import { MistralApiError, type MistralClient } from "../mistral/client";
import type { ChatCompletionRequest, JsonSchemaObject, UsageInfo } from "../mistral/types";
import { parseModelJson } from "../util/json";
import { emit, type ProgressListener } from "./events";
import { translationSystemPrompt, translationUserPrompt, type PromptContext } from "./prompts";
import { findSchemaViolations } from "./schema";

export type StructuredMode = "json_schema" | "json_object";

export interface TranslateOptions extends PromptContext {
  model: string;
  schema: JsonSchemaObject;
  temperature?: number;
  /** Stream tokens to report progress (default true). */
  streaming?: boolean;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
}

export interface TranslationOutcome {
  data: unknown;
  rawText: string;
  usage: UsageInfo | null;
  model: string;
  mode: StructuredMode;
  /** Gross mismatches between the output and the schema (should be empty). */
  violations: string[];
  finishReason: string | null;
}

export async function translateStructured(
  client: MistralClient,
  documentText: string,
  options: TranslateOptions,
): Promise<TranslationOutcome> {
  const { onProgress } = options;
  const schemaJson = JSON.stringify(options.schema, null, 2);
  const messages: ChatCompletionRequest["messages"] = [
    { role: "system", content: translationSystemPrompt(options) },
    { role: "user", content: translationUserPrompt(documentText, schemaJson) },
  ];

  emit(onProgress, "translate", "start", `Translating with ${options.model} into ${options.targetLanguage}`);

  // Attempts, in order. Each fallback only triggers on a 4xx "bad request"
  // (typically an unsupported schema keyword or a streaming/format combination
  // the model does not accept); every other error propagates immediately.
  const streaming = options.streaming !== false;
  const attempts: Array<{ mode: StructuredMode; stream: boolean }> = [
    { mode: "json_schema", stream: streaming },
    ...(streaming ? [{ mode: "json_schema" as const, stream: false }] : []),
    { mode: "json_object", stream: false },
  ];

  let result: Awaited<ReturnType<typeof complete>> | null = null;
  let mode: StructuredMode = "json_schema";
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    try {
      result = await complete(client, messages, options, attempt.mode, attempt.stream);
      mode = attempt.mode;
      break;
    } catch (err) {
      const next = attempts[i + 1];
      if (!(err instanceof MistralApiError) || err.kind !== "request" || !next) throw err;
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
    throw new Error(`Translation output could not be parsed: ${parsed.error}`);
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

async function complete(
  client: MistralClient,
  messages: ChatCompletionRequest["messages"],
  options: TranslateOptions,
  mode: StructuredMode,
  stream: boolean,
) {
  const request: ChatCompletionRequest = {
    model: options.model,
    temperature: options.temperature ?? 0.2,
    messages,
    response_format:
      mode === "json_schema"
        ? {
            type: "json_schema",
            json_schema: {
              name: "translated_document",
              description: "Translation of the document, one field per schema property.",
              schema: options.schema,
              strict: true,
            },
          }
        : { type: "json_object" },
  };

  if (!stream) {
    return client.chat(request, options.signal);
  }
  let lastReport = 0;
  const streamOptions: Parameters<MistralClient["chatStream"]>[1] = {
    onDelta: (_delta, accumulated) => {
      // Throttle UI updates to roughly 10/s.
      const now = Date.now();
      if (now - lastReport > 100) {
        lastReport = now;
        emit(options.onProgress, "translate", "progress", "Receiving translation…", {
          receivedChars: accumulated.length,
        });
      }
    },
  };
  if (options.signal) streamOptions.signal = options.signal;
  return client.chatStream(request, streamOptions);
}
