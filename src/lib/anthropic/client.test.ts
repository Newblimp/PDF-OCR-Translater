import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../http/apiError";
import { createAnthropicClient, toAnthropicApiError } from "./client";

const encoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** SSE frames as the API sends them; the SDK dispatches on the `event:` name. */
function frame(data: { type: string } & Record<string, unknown>): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const messageStart = frame({
  type: "message_start",
  message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } },
});

const message = {
  id: "msg",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "{}" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const params = { model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user" as const, content: "hi" }] };

/** Run a call and return the `ApiError` it maps to. */
async function mappedError(call: () => Promise<unknown>): Promise<ApiError> {
  const err = await call().then(
    () => null,
    (e: unknown) => toAnthropicApiError(e),
  );
  expect(err).toBeInstanceOf(ApiError);
  return err!;
}

describe("createAnthropicClient", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("talks to api.anthropic.com with x-api-key, the API version and the browser CORS opt-in, never Authorization", async () => {
    // Neither an env base URL nor an env token may redirect the request or add a bearer token.
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token");
    const calls: Array<{ url: string; headers: Headers }> = [];
    const client = await createAnthropicClient("sk-ant", {
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return jsonResponse({ data: [{ type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }], has_more: false, first_id: null, last_id: null });
      },
    });
    const page = await client.models.list({ limit: 1000 });
    expect(page.data.map((m) => m.id)).toEqual(["claude-haiku-5-5"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    const headers = calls[0]!.headers;
    expect(headers.get("x-api-key")).toBe("sk-ant");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.has("authorization")).toBe(false);
  });

  it("accepts a non-streaming request with max_tokens 64000 (the explicit timeout skips the SDK's streaming-required guard)", async () => {
    let body: Record<string, unknown> = {};
    const client = await createAnthropicClient("k", {
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(message);
      },
    });
    await expect(client.messages.create({ ...params, max_tokens: 64_000 })).resolves.toMatchObject({ id: "msg" });
    expect(body).toMatchObject({ max_tokens: 64_000 });
    expect(body).not.toHaveProperty("stream");
  });

  it("retries overloaded responses, honouring retry-after-ms", async () => {
    let calls = 0;
    const client = await createAnthropicClient("k", {
      fetch: async () =>
        ++calls < 3
          ? jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529, { "retry-after-ms": "1" })
          : jsonResponse(message),
    });
    await expect(client.messages.create(params)).resolves.toMatchObject({ id: "msg" });
    expect(calls).toBe(3);
  });
});

describe("toAnthropicApiError", () => {
  it("maps 401 to auth, with apiFetch's message format and the parsed body", async () => {
    const body = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };
    const client = await createAnthropicClient("k", { fetch: async () => jsonResponse(body, 401) });
    const err = await mappedError(() => client.models.list({ limit: 1000 }));
    expect(err).toMatchObject({ kind: "auth", provider: "anthropic", status: 401, message: "HTTP 401: invalid x-api-key", body });
  });

  it("maps other 4xx to request (the translation fallback ladder keys on it) and keeps a text body", async () => {
    const client = await createAnthropicClient("k", {
      fetch: async () => jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "image: unsupported media type" } }, 400),
    });
    const err = await mappedError(() => client.messages.create(params));
    expect(err).toMatchObject({ kind: "request", status: 400, message: "HTTP 400: image: unsupported media type" });

    const proxy = await createAnthropicClient("k", { fetch: async () => new Response("Request Entity Too Large", { status: 413 }) });
    expect(await mappedError(() => proxy.messages.create(params))).toMatchObject({
      kind: "request",
      status: 413,
      message: "HTTP 413: Request Entity Too Large",
      body: "Request Entity Too Large",
    });
  });

  it("maps 429 to rate_limit and 5xx to server once the SDK stops retrying", async () => {
    let calls = 0;
    const limited = await createAnthropicClient("k", {
      fetch: async () => {
        calls++;
        return jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } }, 429, { "retry-after-ms": "1" });
      },
    });
    expect(await mappedError(() => limited.messages.create(params))).toMatchObject({ kind: "rate_limit", status: 429, message: "HTTP 429: Slow down" });
    expect(calls).toBe(3);

    const broken = await createAnthropicClient("k", {
      fetch: async () => jsonResponse({ type: "error", error: { type: "api_error", message: "Internal" } }, 500, { "x-should-retry": "false" }),
    });
    expect(await mappedError(() => broken.messages.create(params))).toMatchObject({ kind: "server", status: 500, message: "HTTP 500: Internal" });
  });

  it("maps an error event in the middle of a stream to server", async () => {
    const client = await createAnthropicClient("k", {
      fetch: async () => sseResponse([messageStart, frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]),
    });
    const err = await mappedError(() => client.messages.stream(params).finalMessage());
    expect(err).toMatchObject({ kind: "server", provider: "anthropic", status: undefined, message: "Overloaded" });
  });

  it("maps cancelling to aborted, before the request and in the middle of a stream", async () => {
    const before = new AbortController();
    before.abort();
    const client = await createAnthropicClient("k", { fetch: async () => jsonResponse(message) });
    expect(await mappedError(() => client.messages.create(params, { signal: before.signal }))).toMatchObject({ kind: "aborted" });

    // A body that, like fetch's, errors once the request signal aborts.
    const streaming = await createAnthropicClient("k", {
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(messageStart + frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
              controller.enqueue(encoder.encode(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{" } })));
              init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const during = new AbortController();
    const stream = streaming.messages.stream(params, { signal: during.signal });
    stream.on("text", () => during.abort());
    expect(await mappedError(() => stream.finalMessage())).toMatchObject({ kind: "aborted", message: "Request cancelled" });

    expect(toAnthropicApiError(new DOMException("Aborted", "AbortError"))).toMatchObject({ kind: "aborted" });
  });

  it("maps connection failures to network, also when the connection drops mid-stream", async () => {
    // A rejected fetch (offline, CORS or CSP block) becomes the SDK's APIConnectionError, with what fetch threw as `cause`.
    let calls = 0;
    const offline = await createAnthropicClient("k", {
      fetch: async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await mappedError(() => offline.messages.create(params, { maxRetries: 0 }))).toMatchObject({
      kind: "network",
      provider: "anthropic",
      message: "Network error: Failed to fetch",
    });
    expect(calls).toBe(1);

    // createAnthropicClient() above loaded the SDK, so toAnthropicApiError recognises its error classes even when this test runs alone.
    const { APIConnectionError, APIConnectionTimeoutError } = await import("@anthropic-ai/sdk");
    expect(toAnthropicApiError(new APIConnectionError({ cause: new TypeError("Failed to fetch") }))).toMatchObject({
      kind: "network",
      message: "Network error: Failed to fetch",
    });
    expect(toAnthropicApiError(new APIConnectionTimeoutError())).toMatchObject({ kind: "network", message: "Network error: Request timed out." });

    const client = await createAnthropicClient("k", {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(messageStart));
              controller.error(new TypeError("network error"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    expect(await mappedError(() => client.messages.stream(params).finalMessage())).toMatchObject({ kind: "network", message: "Network error: network error" });
  });

  it("maps a stream that ends without a message to protocol", async () => {
    const client = await createAnthropicClient("k", { fetch: async () => sseResponse([messageStart]) });
    expect(await mappedError(() => client.messages.stream(params).finalMessage())).toMatchObject({ kind: "protocol", provider: "anthropic" });
  });
});
