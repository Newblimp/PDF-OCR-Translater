/**
 * Wire-level types for the subset of the Anthropic Messages API used for
 * translation (Claude Haiku 5.5 and other current Claude models).
 * Source of truth: the official `@anthropic-ai/sdk` npm package
 * (`src/resources/messages`, `src/resources/models`).
 */
import type { JsonSchemaObject } from "../mistral/types";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ImageSource =
  | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
  | { type: "url"; url: string };

export type ContentBlockParam = { type: "text"; text: string } | { type: "image"; source: ImageSource };

export interface MessageParam {
  role: "user" | "assistant";
  /** User messages may mix text and images (vision). */
  content: string | ContentBlockParam[];
}

export interface OutputConfig {
  /** Thinking depth and overall token spend; the model default applies when omitted. */
  effort?: Effort;
  /** Structured outputs: the response text is JSON matching the schema. */
  format?: { type: "json_schema"; schema: JsonSchemaObject };
}

export interface MessageCreateRequest {
  model: string;
  /** Required by the API; includes thinking tokens. */
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  output_config?: OutputConfig;
  stream?: boolean;
}

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** "end_turn", "max_tokens", "refusal", ... */
export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | string;

export interface StopDetails {
  type: "refusal";
  category?: string | null;
  explanation?: string | null;
}

/** Text is the answer; thinking blocks (adaptive thinking) and others are ignored. */
export type ContentBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: string };

export interface Message {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_details?: StopDetails | null;
  usage?: Usage | null;
}

/** Server-sent events of a streamed message (`event:` name equals `type`). */
export type StreamEvent =
  | { type: "message_start"; message: Message }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: StopReason | null; stop_details?: StopDetails | null }; usage?: Usage | null }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

export interface ModelInfo {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  /** Context window, when reported. */
  max_input_tokens?: number | null;
  /** Output cap, when reported. */
  max_tokens?: number | null;
}

export interface ModelList {
  data: ModelInfo[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
