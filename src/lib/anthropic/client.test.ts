import { describe, expect, it } from "vitest";
import { AnthropicClient } from "./client";

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

function frame(data: Record<string, unknown>): string {
  return `event: ${String(data["type"])}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("AnthropicClient", () => {
  it("posts to /v1/messages with x-api-key, the API version and the browser CORS opt-in; skips thinking blocks", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = new AnthropicClient({
      apiKey: "sk-ant",
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return jsonResponse({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [
            { type: "thinking", thinking: "", signature: "s" },
            { type: "text", text: '{"a":1}' },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    });
    const result = await client.messages({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 100, stream: false });
    expect(result).toMatchObject({ content: '{"a":1}', stopReason: "end_turn", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it("streams text deltas, ignores thinking deltas, and merges usage from message_start and message_delta", async () => {
    let body: Record<string, unknown> = {};
    const frames = [
      frame({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 2 } } }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      frame({ type: "content_block_stop", index: 0 }),
      "event: ping\ndata: {\"type\":\"ping\"}\n\n",
      frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: '{"a":' } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "1}" } }),
      frame({ type: "content_block_stop", index: 1 }),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3, input_tokens: null } }),
      frame({ type: "message_stop" }),
    ];
    const client = new AnthropicClient({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse(frames);
      },
    });
    const deltas: string[] = [];
    const result = await client.messagesStream({ model: "claude-haiku-5-5", max_tokens: 100, messages: [] }, { onDelta: (d) => deltas.push(d) });
    expect(body).toMatchObject({ stream: true });
    expect(deltas).toEqual(['{"a":', "1}"]);
    expect(result).toMatchObject({ content: '{"a":1}', stopReason: "end_turn", usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } });
  });

  it("reports a refusal's stop details", async () => {
    const frames = [
      frame({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } }),
      frame({ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" } }, usage: { output_tokens: 0 } }),
      frame({ type: "message_stop" }),
    ];
    const client = new AnthropicClient({ apiKey: "k", fetchImpl: async () => sseResponse(frames) });
    const result = await client.messagesStream({ model: "claude-haiku-5-5", max_tokens: 100, messages: [] });
    expect(result).toMatchObject({ content: "", stopReason: "refusal", stopDetails: { category: "cyber", explanation: "declined" } });
  });

  it("turns a mid-stream error event into an ApiError", async () => {
    const frames = [frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })];
    const client = new AnthropicClient({ apiKey: "k", fetchImpl: async () => sseResponse(frames) });
    const err = await client.messagesStream({ model: "m", max_tokens: 1, messages: [] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "server", provider: "anthropic", message: "Overloaded" });
  });

  it("maps Anthropic error payloads", async () => {
    const client = new AnthropicClient({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401),
    });
    const err = await client.listModels().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "auth", provider: "anthropic", status: 401 });
    expect((err as Error).message).toMatch(/^HTTP 401.*invalid x-api-key$/);
  });
});
