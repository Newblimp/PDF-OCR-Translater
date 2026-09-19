/**
 * Wire-level types for the subset of the OpenAI Chat Completions API used
 * for translation (GPT Luna and other GPT-5.x models).
 * Source of truth: the official `openai` npm package (`src/resources/chat/completions`).
 */
import type { JsonSchemaObject } from "../mistral/types";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; description?: string; schema: JsonSchemaObject; strict?: boolean } };

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  response_format?: ResponseFormat;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  /** Upper bound for generated tokens, including reasoning tokens. */
  max_completion_tokens?: number | null;
  /** GPT-5.x only; omit for models that do not support it. */
  reasoning_effort?: ReasoningEffort | null;
  temperature?: number | null;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

export type FinishReason = "stop" | "length" | "content_filter" | "tool_calls" | string;

export interface ChatCompletionResponse {
  id: string;
  object: string;
  model: string;
  created: number;
  usage?: Usage | null;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; refusal?: string | null };
    finish_reason: FinishReason | null;
  }>;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  model: string;
  created: number;
  /** Present only in the final chunk when `stream_options.include_usage` is set. */
  usage?: Usage | null;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null; refusal?: string | null };
    finish_reason?: FinishReason | null;
  }>;
}

export interface ModelObject {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

export interface ModelList {
  object: string;
  data: ModelObject[];
}
