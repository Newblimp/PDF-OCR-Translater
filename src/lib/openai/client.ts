/**
 * Dependency-free client for the OpenAI Chat Completions API.
 * Only `baseUrl` (https://api.openai.com) is ever contacted; the CSP in
 * `public/_headers` enforces this.
 */
import { ApiError } from "../http/apiError";
import { apiFetch, extractErrorMessage, toApiError } from "../http/apiFetch";
import { readSseStream } from "../http/sse";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, FinishReason, ModelObject, ModelList, Usage } from "./types";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";

export interface OpenAIChatResult {
  content: string;
  finishReason: FinishReason | null;
  usage: Usage | null;
  model: string;
  /** Set when the model refused (safety) instead of answering. */
  refusal: string | null;
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: OpenAIClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl;
  }

  /** GET /v1/models. Also validates the key. */
  async listModels(signal?: AbortSignal): Promise<ModelObject[]> {
    const res = await this.request("/v1/models", { method: "GET", signal });
    const json = (await res.json()) as ModelList;
    if (!json || !Array.isArray(json.data)) {
      throw new ApiError("Model list has an unexpected shape", "protocol", "openai", res.status, json);
    }
    return json.data;
  }

  /** POST /v1/chat/completions without streaming. */
  async chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<OpenAIChatResult> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: false, stream_options: undefined }),
      signal,
    });
    const json = (await res.json()) as ChatCompletionResponse;
    const choice = json?.choices?.[0];
    if (!choice) throw new ApiError("Chat response has no choices", "protocol", "openai", res.status, json);
    return {
      content: choice.message?.content ?? "",
      finishReason: choice.finish_reason ?? null,
      usage: json.usage ?? null,
      model: json.model,
      refusal: choice.message?.refusal ?? null,
    };
  }

  /** POST /v1/chat/completions with `stream: true`; usage arrives in the final chunk. */
  async chatStream(
    request: ChatCompletionRequest,
    options: { signal?: AbortSignal; onDelta?: (delta: string, accumulated: string) => void } = {},
  ): Promise<OpenAIChatResult> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }),
      signal: options.signal,
      accept: "text/event-stream",
    });
    if (!res.body) throw new ApiError("Streaming response has no body", "protocol", "openai", res.status);

    let accumulated = "";
    let refusal = "";
    let finishReason: FinishReason | null = null;
    let usage: Usage | null = null;
    let model = request.model;
    let streamError: ApiError | null = null;

    try {
      await readSseStream(res.body, (ev) => {
        if (ev.data === "[DONE]") return;
        let chunk: ChatCompletionChunk & { error?: unknown };
        try {
          chunk = JSON.parse(ev.data) as typeof chunk;
        } catch {
          return;
        }
        if (chunk.error) {
          streamError = new ApiError(extractErrorMessage(chunk), "server", "openai", res.status, chunk);
          return;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta?.content;
          if (delta) {
            accumulated += delta;
            options.onDelta?.(delta, accumulated);
          }
          if (choice.delta?.refusal) refusal += choice.delta.refusal;
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      });
    } catch (err) {
      throw toApiError(err, "openai");
    }
    if (streamError) throw streamError;
    return { content: accumulated, finishReason, usage, model, refusal: refusal || null };
  }

  private request(path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal | undefined; accept?: string }) {
    return apiFetch(`${this.baseUrl}${path}`, {
      provider: "openai",
      apiKey: this.apiKey,
      method: init.method,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.accept ? { accept: init.accept } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}
