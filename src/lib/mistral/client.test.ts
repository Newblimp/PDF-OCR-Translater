import { describe, expect, it } from "vitest";
import { ApiError } from "../http/apiError";
import { contentToText, MistralClient } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("MistralClient", () => {
  it("sends the bearer token and JSON body to the OCR endpoint", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = new MistralClient({
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return jsonResponse({ model: "mistral-ocr-latest", pages: [], usage_info: { pages_processed: 0 } });
      },
    });
    await client.ocr({ model: "mistral-ocr-latest", document: { type: "document_url", document_url: "data:application/pdf;base64,AA==" } });
    expect(seen).not.toBeNull();
    const { url, init } = seen!;
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "mistral-ocr-latest" });
  });

  it("maps 401 to an auth error with the API message", async () => {
    const client = new MistralClient({ apiKey: "bad", fetchImpl: async () => jsonResponse({ message: "Unauthorized" }, 401) });
    await expect(client.listModels()).rejects.toMatchObject({ kind: "auth", status: 401, provider: "mistral" });
  });

  it("maps fetch failures to network errors", async () => {
    const client = new MistralClient({
      apiKey: "k",
      maxRetries: 0,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("network");
  });

  it("retries 429 and 5xx responses, honouring retry-after-ms, then gives up", async () => {
    const statuses: number[] = [];
    const answers = [429, 503, 200];
    const client = new MistralClient({
      apiKey: "k",
      fetchImpl: async () => {
        const status = answers.shift()!;
        statuses.push(status);
        return status === 200
          ? jsonResponse({ object: "list", data: [] })
          : new Response(JSON.stringify({ message: "slow down" }), { status, headers: { "Content-Type": "application/json", "retry-after-ms": "1" } });
      },
    });
    await expect(client.listModels()).resolves.toEqual([]);
    expect(statuses).toEqual([429, 503, 200]);

    let calls = 0;
    const limited = new MistralClient({
      apiKey: "k",
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } });
      },
    });
    await expect(limited.listModels()).rejects.toMatchObject({ kind: "rate_limit", status: 429 });
    expect(calls).toBe(3);
  });

  it("does not retry other 4xx errors, nor wait for a retry-after beyond a minute", async () => {
    let calls = 0;
    const client = new MistralClient({
      apiKey: "k",
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: calls === 1 ? 400 : 429, headers: { "retry-after": "3600" } });
      },
    });
    await expect(client.listModels()).rejects.toMatchObject({ kind: "request" });
    await expect(client.listModels()).rejects.toMatchObject({ kind: "rate_limit" });
    expect(calls).toBe(2);
  });

  it("stops waiting for a retry when cancelled", async () => {
    const controller = new AbortController();
    const client = new MistralClient({
      apiKey: "k",
      fetchImpl: async () => {
        setTimeout(() => controller.abort(), 5);
        return new Response("{}", { status: 503, headers: { "retry-after": "30" } });
      },
    });
    await expect(client.listModels(controller.signal)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reports an error chunk in the middle of a stream", async () => {
    const frames = [
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","created":0,"choices":[{"index":0,"delta":{"content":"{"}}]}\n\n',
      'data: {"object":"error","message":"Service unavailable"}\n\n',
    ];
    const client = new MistralClient({ apiKey: "k", fetchImpl: async () => sseResponse(frames) });
    await expect(client.chatStream({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ kind: "server", message: "Service unavailable" });
  });

  it("assembles streamed deltas", async () => {
    const frames = [
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","created":0,"choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"a\\":"}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","created":0,"choices":[{"index":0,"delta":{"content":"1}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ];
    const client = new MistralClient({ apiKey: "k", fetchImpl: async () => sseResponse(frames) });
    const deltas: string[] = [];
    const result = await client.chatStream({ model: "m", messages: [{ role: "user", content: "hi" }] }, { onDelta: (d) => deltas.push(d) });
    expect(result.content).toBe('{"a":1}');
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.total_tokens).toBe(5);
    expect(deltas).toEqual(['{"a":', "1}"]);
  });
});

describe("contentToText", () => {
  it("handles strings, chunk arrays (ignoring thinking) and null", () => {
    expect(contentToText("x")).toBe("x");
    expect(
      contentToText([
        { type: "thinking", thinking: [{ type: "text", text: "hmm" }] },
        { type: "text", text: "a" },
        { type: "image_url", image_url: "u" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
    expect(contentToText(null)).toBe("");
  });
});
