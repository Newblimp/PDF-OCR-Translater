/**
 * Thin, dependency-free HTTP client for the Mistral API.
 *
 * Everything the app sends over the network goes through this file, which
 * makes the privacy model auditable: the only host contacted is `baseUrl`
 * (https://api.mistral.ai by default, also enforced by the CSP in
 * `public/_headers`).
 */
import type {
  ApiErrorBody,
  ChatCompletionChunk,
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
import { readSseStream } from "./sse";

export const DEFAULT_BASE_URL = "https://api.mistral.ai";

export type MistralErrorKind =
  | "network" // fetch itself failed: offline, DNS, CORS, blocked by CSP
  | "auth" // 401 / 403
  | "rate_limit" // 429
  | "request" // other 4xx (bad schema, file too large, ...)
  | "server" // 5xx
  | "aborted" // the caller cancelled
  | "protocol"; // unexpected response shape

export class MistralApiError extends Error {
  constructor(
    message: string,
    readonly kind: MistralErrorKind,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MistralApiError";
  }

  /** A short, user-facing explanation with a hint on what to do. */
  get hint(): string {
    switch (this.kind) {
      case "network":
        return "The request never reached the Mistral API. Check your connection. If you are online, the browser may have blocked the call (CORS or Content-Security-Policy).";
      case "auth":
        return "The API key was rejected. Open the key dialog and enter a valid Mistral API key.";
      case "rate_limit":
        return "Rate limit or quota exceeded on your Mistral account. Wait a moment and retry.";
      case "request":
        return "The API rejected the request. See the details below.";
      case "server":
        return "The Mistral API had an internal problem. Retrying usually helps.";
      case "aborted":
        return "The request was cancelled.";
      case "protocol":
        return "The API answered with an unexpected payload.";
    }
  }
}

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
}

export class MistralClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MistralClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  // ----------------------------------------------------------------- models

  /** GET /v1/models. Also the cheapest way to validate an API key. */
  async listModels(signal?: AbortSignal): Promise<ModelCard[]> {
    const res = await this.request("/v1/models", { method: "GET", signal });
    const json = (await res.json()) as ModelList;
    if (!json || !Array.isArray(json.data)) {
      throw new MistralApiError("Model list has an unexpected shape", "protocol", res.status, json);
    }
    return json.data;
  }

  // -------------------------------------------------------------------- ocr

  /** POST /v1/ocr */
  async ocr(request: OcrRequest, signal?: AbortSignal): Promise<OcrResponse> {
    const res = await this.request("/v1/ocr", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
    const json = (await res.json()) as OcrResponse;
    if (!json || !Array.isArray(json.pages)) {
      throw new MistralApiError("OCR response has an unexpected shape", "protocol", res.status, json);
    }
    return json;
  }

  // ------------------------------------------------------------------- chat

  /** POST /v1/chat/completions without streaming. */
  async chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: false }),
      signal,
    });
    const json = (await res.json()) as ChatCompletionResponse;
    const choice = json?.choices?.[0];
    if (!choice) {
      throw new MistralApiError("Chat response has no choices", "protocol", res.status, json);
    }
    return {
      content: contentToText(choice.message?.content),
      finishReason: choice.finish_reason ?? null,
      usage: json.usage ?? null,
      model: json.model,
    };
  }

  /**
   * POST /v1/chat/completions with `stream: true`.
   * Text deltas are reported through `onDelta`; the full result is returned
   * once the stream ends. Works with `response_format` (JSON modes).
   */
  async chatStream(request: ChatCompletionRequest, options: ChatStreamOptions = {}): Promise<ChatResult> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, stream: true }),
      signal: options.signal,
      accept: "text/event-stream",
    });
    if (!res.body) throw new MistralApiError("Streaming response has no body", "protocol", res.status);

    let accumulated = "";
    let finishReason: FinishReason | null = null;
    let usage: UsageInfo | null = null;
    let model = request.model;
    let streamError: MistralApiError | null = null;

    try {
      await readSseStream(res.body, (ev) => {
        if (ev.data === "[DONE]") return;
        let chunk: ChatCompletionChunk & ApiErrorBody;
        try {
          chunk = JSON.parse(ev.data) as ChatCompletionChunk & ApiErrorBody;
        } catch {
          return; // ignore malformed keep-alive frames
        }
        if (!chunk.choices && (chunk.message || chunk.error)) {
          streamError = new MistralApiError(extractErrorMessage(chunk), "server", res.status, chunk);
          return;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          const delta = contentToText(choice.delta?.content);
          if (delta) {
            accumulated += delta;
            options.onDelta?.(delta, accumulated);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      });
    } catch (err) {
      throw toApiError(err);
    }
    if (streamError) throw streamError;
    return { content: accumulated, finishReason, usage, model };
  }

  // ---------------------------------------------------------------- private

  private async request(
    path: string,
    init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal | undefined; accept?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: init.accept ?? "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      const request: RequestInit = { method: init.method, headers };
      if (init.body !== undefined) request.body = init.body;
      if (init.signal) request.signal = init.signal;
      res = await this.fetchImpl(`${this.baseUrl}${path}`, request);
    } catch (err) {
      throw toApiError(err);
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }
}

// --------------------------------------------------------------------- utils

/** Normalise `content` (string | chunk[] | null) into plain text. */
export function contentToText(content: string | ContentChunk[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .join("");
}

function toApiError(err: unknown): MistralApiError {
  if (err instanceof MistralApiError) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return new MistralApiError("Request cancelled", "aborted");
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new MistralApiError("Request cancelled", "aborted");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new MistralApiError(`Network error: ${message}`, "network");
}

async function errorFromResponse(res: Response): Promise<MistralApiError> {
  let body: unknown = null;
  let message = `HTTP ${res.status} ${res.statusText}`.trim();
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
      const extracted = extractErrorMessage(body as ApiErrorBody);
      if (extracted) message = `${message}: ${extracted}`;
    } catch {
      body = text;
      if (text) message = `${message}: ${text.slice(0, 500)}`;
    }
  } catch {
    // ignore: body could not be read
  }
  const kind: MistralErrorKind =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 429
        ? "rate_limit"
        : res.status >= 500
          ? "server"
          : "request";
  return new MistralApiError(message, kind, res.status, body);
}

function extractErrorMessage(body: ApiErrorBody | null | undefined): string {
  if (!body || typeof body !== "object") return "";
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && typeof body.error.message === "string") {
    return body.error.message;
  }
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) {
    return body.detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
      .join("; ");
  }
  if (body.detail && typeof body.detail === "object") return JSON.stringify(body.detail);
  return "";
}
