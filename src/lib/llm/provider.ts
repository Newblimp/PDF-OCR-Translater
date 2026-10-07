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

export interface AttachedImage {
  /** Identifier used in the text (e.g. the OCR image id) so the model can relate them. */
  id: string;
  /** `data:image/...;base64,...` */
  dataUrl: string;
}

export interface JsonChatRequest {
  model: string;
  system: string;
  /**
   * Shared document context, placed first in the user message (before the
   * images). Requests that send the same `system`, `context` and `images`
   * share a prompt prefix the provider can cache; the task goes in `user`.
   */
  context?: string | undefined;
  /** The task, placed last in the user message (after the context and the images). */
  user: string;
  /** Images placed after the context and before the task (vision models). Omitted when empty. */
  images?: AttachedImage[] | undefined;
  /** Mark the shared prefix (system, context, images) for prompt caching where the API needs it (Anthropic). */
  cachePrefix?: boolean | undefined;
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
  /** Prompt tokens served from the provider's prompt cache (included in `prompt_tokens`). */
  cache_read_tokens?: number | undefined;
  /** Prompt tokens written to the prompt cache (Anthropic; included in `prompt_tokens`). */
  cache_write_tokens?: number | undefined;
}

/** Add `add` to `total` in place (missing counts count as 0); returns `total`. */
export function addUsage(total: TokenUsage, add: TokenUsage | null | undefined): TokenUsage {
  if (!add) return total;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
    const value = add[key];
    if (value !== undefined) total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

/** A fresh usage record with the three main counts at zero. */
export function emptyUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
