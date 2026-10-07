/**
 * Thin, dependency-free HTTP client for the Mistral API (OCR, chat, models).
 *
 * The only host contacted is `baseUrl` (https://api.mistral.ai by default,
 * also enforced by the CSP in `public/_headers`).
 */
import { ApiError } from "../http/apiError";
import { apiFetch } from "../http/apiFetch";
import { readChatStream } from "../http/chatStream";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ContentChunk,
  FinishReason,
  ModelCard,
  ModelList,
  OcrRequest,
  OcrResponse,
  UsageInfo,
} from "./types";

export const DEFAULT_BASE_URL = "https://api.mistral.ai";

export interface ChatStreamOptions {
  signal?: AbortSignal;
  /** Called with every text delta as it arrives. */
  onDelta?: (delta: string, accumulated: string) => void;
}

export interface ChatResult {
  content: string;
  finishReason: FinishReason | null;
  usage: UsageInfo | null;
  model: string;
}

export interface MistralClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Retries of 408/409/429/5xx and connection failures (default 2, like the Anthropic SDK). */
  maxRetries?: number;
}

export class MistralClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly maxRetries: number | undefined;

  constructor(options: MistralClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl;
    this.maxRetries = options.maxRetries;
  }

  /** GET /v1/models. Also the cheapest way to validate an API key. */
  async listModels(signal?: AbortSignal): Promise<ModelCard[]> {
    const res = await this.request("/v1/models", { method: "GET", signal });
    const json = (await res.json()) as ModelList;
    if (!json || !Array.isArray(json.data)) {
      throw new ApiError("Model list has an unexpected shape", "protocol", "mistral", res.status, json);
    }
    return json.data;
  }

  /** POST /v1/ocr */
  async ocr(request: OcrRequest, signal?: AbortSignal): Promise<OcrResponse> {
    const res = await this.request("/v1/ocr", { method: "POST", body: JSON.stringify(request), signal });
    const json = (await res.json()) as OcrResponse;
    if (!json || !Array.isArray(json.pages)) {
      throw new ApiError("OCR response has an unexpected shape", "protocol", "mistral", res.status, json);
    }
    return json;
  }

  /** POST /v1/chat/completions without streaming. */
  async chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: false }),
      signal,
    });
    const json = (await res.json()) as ChatCompletionResponse;
    const choice = json?.choices?.[0];
    if (!choice) throw new ApiError("Chat response has no choices", "protocol", "mistral", res.status, json);
    return {
      content: contentToText(choice.message?.content),
      finishReason: choice.finish_reason ?? null,
      usage: json.usage ?? null,
      model: json.model,
    };
  }

  /** POST /v1/chat/completions with `stream: true`. Works with `response_format` (JSON modes). */
  async chatStream(request: ChatCompletionRequest, options: ChatStreamOptions = {}): Promise<ChatResult> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
      signal: options.signal,
      accept: "text/event-stream",
    });
    const out = await readChatStream<UsageInfo>(res, { provider: "mistral", model: request.model, deltaText: contentToText, onDelta: options.onDelta });
    return { content: out.content, finishReason: out.finishReason, usage: out.usage, model: out.model };
  }

  private request(path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal | undefined; accept?: string }) {
    return apiFetch(`${this.baseUrl}${path}`, {
      provider: "mistral",
      apiKey: this.apiKey,
      method: init.method,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.accept ? { accept: init.accept } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      maxRetries: this.maxRetries,
    });
  }
}

/** Normalise `content` (string | chunk[] | null) into plain text. Thinking chunks are ignored. */
export function contentToText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentChunk[])
    .map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .join("");
}
