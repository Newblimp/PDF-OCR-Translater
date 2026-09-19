/**
 * Provider-agnostic interface for the JSON-producing chat calls of the
 * pipeline (schema inference and translation). Adding a provider means
 * implementing this interface and registering it in `registry.ts`.
 */
import type { ModelOption } from "../mistral/models";
import type { JsonSchemaObject } from "../mistral/types";
import type { ApiProvider } from "../http/apiError";

export type ProviderId = ApiProvider;

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export type JsonFormat =
  | { type: "json_object" }
  | { type: "json_schema"; name: string; description?: string; schema: JsonSchemaObject; strict: boolean };

export interface JsonChatRequest {
  model: string;
  system: string;
  user: string;
  format: JsonFormat;
  stream: boolean;
  /** Sampling temperature; providers that do not support it ignore it. */
  temperature?: number | undefined;
  /** Reasoning budget for hybrid/reasoning models; ignored by providers without it. */
  reasoningEffort?: ReasoningEffort | undefined;
  /** Upper bound for generated tokens; ignored when undefined. */
  maxOutputTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  onDelta?: ((delta: string, accumulated: string) => void) | undefined;
}

export interface TokenUsage {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  reasoning_tokens?: number | undefined;
}

export interface JsonChatResult {
  content: string;
  /** "stop", "length", ... as reported by the provider. */
  finishReason: string | null;
  usage: TokenUsage | null;
  model: string;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Run one JSON-producing completion. Throws `ApiError` on failure. */
  completeJson(request: JsonChatRequest): Promise<JsonChatResult>;
  /** List models suitable for the translation step. Also validates the key. */
  listModels(signal?: AbortSignal): Promise<ModelOption[]>;
}
