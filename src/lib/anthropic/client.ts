/**
 * Dependency-free client for the Anthropic Messages API.
 * Only `baseUrl` (https://api.anthropic.com) is ever contacted; the CSP in
 * `public/_headers` enforces this. Browser calls must opt in to CORS with the
 * `anthropic-dangerous-direct-browser-access` header (the key is the user's own
 * and never leaves this browser except to the API).
 */
import { ApiError } from "../http/apiError";
import { apiFetch, extractErrorMessage, toApiError } from "../http/apiFetch";
import { readSseStream } from "../http/sse";
import type { Message, MessageCreateRequest, ModelInfo, ModelList, StopDetails, StopReason, StreamEvent, Usage } from "./types";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface AnthropicMessageResult {
  /** Concatenated text blocks; thinking blocks are left out. */
  content: string;
  stopReason: StopReason | null;
  /** Set on `stop_reason: "refusal"`. */
  stopDetails: StopDetails | null;
  usage: Usage | null;
  model: string;
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AnthropicClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: AnthropicClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl;
  }

  /** GET /v1/models (newest first). Also validates the key. */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request("/v1/models?limit=1000", { method: "GET", signal });
    const json = (await res.json()) as ModelList;
    if (!json || !Array.isArray(json.data)) {
      throw new ApiError("Model list has an unexpected shape", "protocol", "anthropic", res.status, json);
    }
    return json.data;
  }

  /** POST /v1/messages without streaming. */
  async messages(request: MessageCreateRequest, signal?: AbortSignal): Promise<AnthropicMessageResult> {
    const res = await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: false }),
      signal,
    });
    const json = (await res.json()) as Message;
    if (!json || !Array.isArray(json.content)) {
      throw new ApiError("Message response has no content", "protocol", "anthropic", res.status, json);
    }
    return {
      content: json.content.map((b) => (b.type === "text" && "text" in b ? b.text : "")).join(""),
      stopReason: json.stop_reason ?? null,
      stopDetails: json.stop_details ?? null,
      usage: json.usage ?? null,
      model: json.model,
    };
  }

  /** POST /v1/messages with `stream: true`; usage arrives in `message_start` and `message_delta`. */
  async messagesStream(
    request: MessageCreateRequest,
    options: { signal?: AbortSignal; onDelta?: (delta: string, accumulated: string) => void } = {},
  ): Promise<AnthropicMessageResult> {
    const res = await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
      signal: options.signal,
      accept: "text/event-stream",
    });
    if (!res.body) throw new ApiError("Streaming response has no body", "protocol", "anthropic", res.status);

    let accumulated = "";
    let stopReason: StopReason | null = null;
    let stopDetails: StopDetails | null = null;
    let usage: Usage | null = null;
    let model = request.model;
    let streamError: ApiError | null = null;

    try {
      await readSseStream(res.body, (ev) => {
        let event: StreamEvent;
        try {
          event = JSON.parse(ev.data) as StreamEvent;
        } catch {
          return;
        }
        switch (event.type) {
          case "message_start":
            if (event.message.model) model = event.message.model;
            if (event.message.usage) usage = event.message.usage;
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta" && "text" in event.delta && event.delta.text) {
              accumulated += event.delta.text;
              options.onDelta?.(event.delta.text, accumulated);
            }
            break;
          case "message_delta":
            if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
            if (event.delta.stop_details) stopDetails = event.delta.stop_details;
            if (event.usage) usage = { ...usage, ...withoutNulls(event.usage) };
            break;
          case "error":
            streamError = new ApiError(extractErrorMessage(event), "server", "anthropic", res.status, event);
            break;
        }
      });
    } catch (err) {
      throw toApiError(err, "anthropic");
    }
    if (streamError) throw streamError;
    return { content: accumulated, stopReason, stopDetails, usage, model };
  }

  private request(path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal | undefined; accept?: string }) {
    return apiFetch(`${this.baseUrl}${path}`, {
      provider: "anthropic",
      apiKey: this.apiKey,
      apiKeyHeader: "x-api-key",
      headers: { "anthropic-version": API_VERSION, "anthropic-dangerous-direct-browser-access": "true" },
      method: init.method,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.accept ? { accept: init.accept } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}

/** `message_delta` usage repeats only some fields; keep the earlier values for the rest. */
function withoutNulls(usage: Usage): Usage {
  return Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== null && v !== undefined)) as Usage;
}
