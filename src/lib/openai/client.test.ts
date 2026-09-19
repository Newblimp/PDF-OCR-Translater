import { describe, expect, it } from "vitest";
import { OpenAIClient } from "./client";

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

describe("OpenAIClient", () => {
  it("posts to /v1/chat/completions with the bearer token and no stream options when not streaming", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = new OpenAIClient({
      apiKey: "sk-openai",
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return jsonResponse({
          id: "c",
          object: "chat.completion",
          model: "gpt-5.6-luna",
          created: 0,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 0 } },
          choices: [{ index: 0, message: { role: "assistant", content: '{"a":1}' }, finish_reason: "stop" }],
        });
      },
    });
    const result = await client.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" });
    expect(seen!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-openai");
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toMatchObject({ model: "gpt-5.6-luna", stream: false, reasoning_effort: "none" });
    expect(body).not.toHaveProperty("stream_options");
    expect(result.content).toBe('{"a":1}');
    expect(result.usage?.total_tokens).toBe(15);
  });

  it("streams deltas and picks up usage from the final chunk", async () => {
    let body: Record<string, unknown> = {};
    const frames = [
      'data: {"id":"c","object":"chat.completion.chunk","model":"gpt-5.6-luna","created":0,"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","model":"gpt-5.6-luna","created":0,"choices":[{"index":0,"delta":{"content":"{\\"a\\":"}}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","model":"gpt-5.6-luna","created":0,"choices":[{"index":0,"delta":{"content":"1}"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","model":"gpt-5.6-luna","created":0,"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ];
    const client = new OpenAIClient({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse(frames);
      },
    });
    const deltas: string[] = [];
    const result = await client.chatStream({ model: "gpt-5.6-luna", messages: [] }, { onDelta: (d) => deltas.push(d) });
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(result.content).toBe('{"a":1}');
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.total_tokens).toBe(10);
    expect(deltas).toEqual(['{"a":', "1}"]);
  });

  it("maps OpenAI error payloads", async () => {
    const client = new OpenAIClient({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: { message: "Unsupported parameter: 'temperature'", type: "invalid_request_error" } }, 400),
    });
    const err = await client.chat({ model: "m", messages: [] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "request", provider: "openai", status: 400 });
    expect((err as Error).message).toMatch(/^HTTP 400.*Unsupported parameter: 'temperature'$/);
  });
});
