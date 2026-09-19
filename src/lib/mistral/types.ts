/**
 * Wire-level types for the subset of the Mistral REST API this app uses.
 *
 * Field names are snake_case on purpose: these objects are serialised as-is.
 * Source of truth: the official TypeScript SDK (`@mistralai/mistralai`,
 * `src/models/components/*`) and https://docs.mistral.ai/api/.
 * We do not depend on the SDK at runtime to keep the bundle small and the
 * browser network surface fully explicit.
 */

// ---------------------------------------------------------------------------
// Structured output (shared by chat completions and OCR annotations)
// ---------------------------------------------------------------------------

/** A JSON Schema object. Kept loose on purpose; see `pipeline/schema.ts`. */
export type JsonSchemaObject = { [key: string]: unknown };

export interface JsonSchemaSpec {
  name: string;
  description?: string | null;
  schema: JsonSchemaObject;
  /** When true the API constrains decoding so the output must match the schema. */
  strict?: boolean;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchemaSpec };

// ---------------------------------------------------------------------------
// OCR  (POST /v1/ocr)
// ---------------------------------------------------------------------------

export type OcrDocument =
  | {
      type: "document_url";
      /** An https URL or a data URI such as `data:application/pdf;base64,...`. */
      document_url: string;
      document_name?: string | null;
    }
  | {
      type: "image_url";
      /** An https URL or a data URI such as `data:image/png;base64,...`. */
      image_url: string;
    }
  | { type: "file"; file_id: string };

export interface OcrRequest {
  model: string;
  document: OcrDocument;
  /** Page indices (0-based) or a range string such as "0-5". */
  pages?: number[] | string | null;
  include_image_base64?: boolean | null;
  image_limit?: number | null;
  image_min_size?: number | null;
  /** Only `json_schema` is valid here. Document annotation is limited to 8 pages by the API. */
  document_annotation_format?: ResponseFormat | null;
  document_annotation_prompt?: string | null;
  bbox_annotation_format?: ResponseFormat | null;
  table_format?: "markdown" | "html" | null;
  /** Move the page header out of `markdown` and into `header`. */
  extract_header?: boolean;
  /** Move the page footer out of `markdown` and into `footer`. */
  extract_footer?: boolean;
  include_blocks?: boolean;
  confidence_scores_granularity?: "page" | "word" | "block" | null;
}

export interface OcrImage {
  id: string;
  top_left_x: number | null;
  top_left_y: number | null;
  bottom_right_x: number | null;
  bottom_right_y: number | null;
  image_base64?: string | null;
  image_annotation?: string | null;
}

/**
 * Paragraph-level content block returned when `include_blocks` is set.
 * Coordinates are pixels of the page image described by `OcrPage.dimensions`.
 */
export interface OcrBlock {
  type: "text" | "title" | "table" | "image" | "header" | "footer" | "caption" | "list" | "equation" | "code" | "signature" | "references" | "aside_text" | string;
  top_left_x: number;
  top_left_y: number;
  bottom_right_x: number;
  bottom_right_y: number;
  /** Text/markdown/html content of this block */
  content: string;
  /** For image blocks: the id of the corresponding entry in `OcrPage.images`. */
  image_id?: string;
  table_id?: string | null;
}

export interface OcrPage {
  index: number;
  markdown: string;
  images: OcrImage[];
  header?: string | null;
  footer?: string | null;
  hyperlinks?: string[];
  dimensions: { dpi: number; height: number; width: number } | null;
  /** Present only when `include_blocks` is requested. */
  blocks?: OcrBlock[];
  tables?: unknown[];
  confidence_scores?: unknown;
}

export interface OcrUsageInfo {
  pages_processed: number;
  doc_size_bytes?: number | null;
}

export interface OcrResponse {
  model: string;
  pages: OcrPage[];
  /** JSON string when `document_annotation_format` was requested. */
  document_annotation?: string | null;
  usage_info: OcrUsageInfo;
}

// ---------------------------------------------------------------------------
// Chat completions  (POST /v1/chat/completions)
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant";

export type ContentChunk =
  | { type: "text"; text: string }
  | { type: "document_url"; document_url: string; document_name?: string | null }
  | { type: "image_url"; image_url: string | { url: string; detail?: string | null } }
  | { type: string; [key: string]: unknown };

export interface ChatMessage {
  role: ChatRole;
  /** Vision-capable models accept an array mixing text and `image_url` chunks (data URIs allowed). */
  content: string | ContentChunk[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  stream?: boolean;
  random_seed?: number | null;
  response_format?: ResponseFormat;
  safe_prompt?: boolean;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type FinishReason = "stop" | "length" | "model_length" | "error" | "tool_calls" | string;

export interface AssistantMessage {
  role?: "assistant";
  content?: string | ContentChunk[] | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  model: string;
  created: number;
  usage: UsageInfo;
  choices: Array<{
    index: number;
    message?: AssistantMessage;
    finish_reason: FinishReason;
  }>;
}

/** One SSE event body of a streamed chat completion. */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  model: string;
  created: number;
  usage?: UsageInfo | null;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | ContentChunk[] | null };
    finish_reason?: FinishReason | null;
  }>;
}

// ---------------------------------------------------------------------------
// Models  (GET /v1/models)
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  completion_chat?: boolean;
  function_calling?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  ocr?: boolean;
  [key: string]: boolean | undefined;
}

export interface ModelCard {
  id: string;
  object?: string;
  name?: string | null;
  description?: string | null;
  capabilities: ModelCapabilities;
  max_context_length?: number;
  aliases?: string[];
  deprecation?: string | null;
  default_model_temperature?: number | null;
  type?: "base" | "fine-tuned" | string;
}

export interface ModelList {
  object: string;
  data?: ModelCard[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Shape of error payloads returned by the API (best effort; fields vary). */
export interface ApiErrorBody {
  message?: string;
  detail?: unknown;
  type?: string;
  code?: string | number;
  object?: string;
  error?: { message?: string; type?: string; code?: string | number } | string;
}
