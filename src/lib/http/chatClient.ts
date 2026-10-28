/**
 * Dependency-free client for the Chat Completions REST API that Mistral and
 * OpenAI share: `GET /v1/models`, `POST /v1/chat/completions` (streamed or
 * not), authenticated with a bearer key through `apiFetch`. The provider
 * clients extend it (`mistral/client.ts` adds OCR). Only `baseUrl` is ever
 * contacted; the CSP in `public/_headers` enforces it.
 */
import { ApiError, toApiError, type ApiProvider } from "./apiError";
import { apiFetch } from "./apiFetch";
import { readChatStream } from "./chatStream";

export interface ChatClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Retries of 408/409/429/5xx and connection failures (default 2, like the Anthropic SDK). */
  maxRetries?: number;
}

export interface ChatResult<U> {
  content: string;
  /** "stop", "length", ... as reported by the provider. */
  finishReason: string | null;
  usage: U | null;
  model: string;
  /** Set when the model refused (safety) instead of answering (OpenAI). */
  refusal: string | null;
}

export interface ChatCallOptions {
  stream: boolean;
  signal?: AbortSignal | undefined;
  /** Called with every text delta of a streamed answer as it arrives. */
  onDelta?: ((delta: string, accumulated: string) => void) | undefined;
}

/** One request: what `apiFetch` takes besides the key and the client's settings. */
type Call = { method: "GET" | "POST"; body?: string; signal?: AbortSignal | undefined; accept?: string };

interface ChatResponse<U> {
  model: string;
  usage?: U | null;
  choices?: Array<{ message?: { content?: unknown; refusal?: string | null }; finish_reason?: string | null }>;
}

export class ChatCompletionsClient<Request extends { model: string }, Usage, Model> {
  readonly baseUrl: string;

  constructor(
    protected readonly provider: ApiProvider,
    defaultBaseUrl: string,
    private readonly options: ChatClientOptions,
  ) {
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");
  }

  /** Text of a message's or a delta's `content` (a string here; Mistral also sends chunk arrays). */
  protected contentText(content: unknown): string {
    return typeof content === "string" ? content : "";
  }

  /** Fields a streamed request adds to the body (OpenAI asks for the usage in the last chunk). */
  protected streamFields(): object {
    return {};
  }

  /** GET /v1/models. Also the cheapest way to validate an API key. */
  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const json = await this.getJson<{ data?: Model[] }>("/v1/models", "Model list", (j) => Array.isArray(j?.data), { method: "GET", signal });
    return json.data!;
  }

  /** One completion: streamed (progress through `onDelta`) or not. */
  complete(request: Request, options: ChatCallOptions): Promise<ChatResult<Usage>> {
    return options.stream ? this.chatStream(request, options) : this.chat(request, options.signal);
  }

  /** POST /v1/chat/completions without streaming. */
  async chat(request: Request, signal?: AbortSignal): Promise<ChatResult<Usage>> {
    const body = JSON.stringify({ ...request, stream: false });
    const json = await this.getJson<ChatResponse<Usage>>("/v1/chat/completions", "Chat response", (j) => !!j?.choices?.[0], { method: "POST", body, signal });
    const choice = json.choices![0]!;
    return {
      content: this.contentText(choice.message?.content),
      finishReason: choice.finish_reason ?? null,
      usage: json.usage ?? null,
      model: json.model,
      refusal: choice.message?.refusal ?? null,
    };
  }

  /** POST /v1/chat/completions with `stream: true`; works with `response_format` (JSON modes). */
  async chatStream(request: Request, options: Omit<ChatCallOptions, "stream"> = {}): Promise<ChatResult<Usage>> {
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...request, ...this.streamFields(), stream: true }),
      signal: options.signal,
      accept: "text/event-stream",
    });
    const out = await readChatStream<Usage>(res, {
      provider: this.provider,
      model: request.model,
      deltaText: (content) => this.contentText(content),
      onDelta: options.onDelta,
    });
    return { ...out, refusal: out.refusal || null };
  }

  /** A JSON response that passes `valid`, else a "protocol" error naming `what`. */
  protected async getJson<T>(path: string, what: string, valid: (json: T | null) => boolean, call: Call): Promise<T> {
    const res = await this.request(path, call);
    let json: T | null;
    try {
      json = (await res.json()) as T | null;
    } catch (err) {
      // A proxy's HTML error page, or a body cut off: the same "protocol" error as a JSON body of the wrong shape.
      if (err instanceof SyntaxError) throw new ApiError(`${what} is not JSON: ${err.message}`, "protocol", this.provider, res.status);
      throw toApiError(err, this.provider); // the connection dropped, or the request was cancelled, while the body was read
    }
    if (!valid(json)) throw new ApiError(`${what} has an unexpected shape`, "protocol", this.provider, res.status, json);
    return json!;
  }

  private request(path: string, call: Call): Promise<Response> {
    const { apiKey, fetchImpl, maxRetries } = this.options;
    return apiFetch(`${this.baseUrl}${path}`, { ...call, provider: this.provider, apiKey, maxRetries, ...(fetchImpl ? { fetchImpl } : {}) });
  }
}
