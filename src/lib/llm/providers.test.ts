import { describe, expect, it } from "vitest";
import { createAnthropicClient } from "../anthropic/client";
import { OpenAIClient } from "../openai/client";
import { MistralClient } from "../mistral/client";
import { AnthropicProvider } from "./anthropicProvider";
import { OpenAIProvider } from "./openaiProvider";
import { MistralProvider } from "./mistralProvider";
import type { JsonChatRequest } from "./provider";
import { ApiError } from "../http/apiError";

const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

function captureAnthropic(message: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        id: "msg",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: '{"a":"b"}' },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 },
        ...message,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { calls, fetchImpl };
}

/** An Anthropic SSE frame; the SDK dispatches on the `event:` name. */
function frame(data: { type: string } & Record<string, unknown>): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(frames: string[]): typeof fetch {
  return async () => new Response(frames.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function capture() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        model: "m",
        created: 0,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ index: 0, message: { role: "assistant", content: '{"a":"b"}' }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { calls, fetchImpl };
}

const request: JsonChatRequest = {
  model: "m",
  system: "sys",
  user: "usr",
  format: { type: "json_schema", name: "doc", schema, strict: true },
  stream: false,
  temperature: 0.2,
  reasoningEffort: "low",
  maxOutputTokens: 1000,
};

describe("providers map the generic request onto each API", () => {
  it("OpenAI: strict json_schema, reasoning_effort, max_completion_tokens, no temperature", async () => {
    const { calls, fetchImpl } = capture();
    const provider = new OpenAIProvider(new OpenAIClient({ apiKey: "k", fetchImpl }));
    const result = await provider.completeJson(request);
    expect(result.content).toBe('{"a":"b"}');
    const body = calls[0]!.body;
    expect(body).toMatchObject({
      model: "m",
      reasoning_effort: "low",
      max_completion_tokens: 1000,
      response_format: { type: "json_schema", json_schema: { name: "doc", strict: true, schema } },
    });
    expect(body).not.toHaveProperty("temperature");
    expect((body["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("Mistral: strict json_schema, temperature, max_tokens, no reasoning_effort", async () => {
    const { calls, fetchImpl } = capture();
    const provider = new MistralProvider(new MistralClient({ apiKey: "k", fetchImpl }));
    await provider.completeJson(request);
    const body = calls[0]!.body;
    expect(body).toMatchObject({ temperature: 0.2, max_tokens: 1000, response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("Anthropic: structured outputs, effort, max_tokens, system prompt, base64 images, no temperature; text blocks only", async () => {
    const { calls, fetchImpl } = captureAnthropic();
    const provider = new AnthropicProvider(createAnthropicClient("k", { fetch: fetchImpl }));
    const result = await provider.completeJson({ ...request, images: [{ id: "img-0.jpeg", dataUrl: "data:image/jpeg;base64,QUJD" }] });
    expect(result).toMatchObject({ content: '{"a":"b"}', finishReason: "stop", usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } });
    const body = calls[0]!.body;
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body).toMatchObject({
      model: "m",
      max_tokens: 1000,
      system: "sys",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    expect(body["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "usr" },
          { type: "text", text: 'Image "img-0.jpeg":' },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
        ],
      },
    ]);
  });

  it("Anthropic: json_object mode sends no format, \"none\" effort maps to low, and max_tokens has a default", async () => {
    const { calls, fetchImpl } = captureAnthropic();
    const provider = new AnthropicProvider(createAnthropicClient("k", { fetch: fetchImpl }));
    await provider.completeJson({ ...request, format: { type: "json_object" }, reasoningEffort: "none", maxOutputTokens: undefined });
    expect(calls[0]!.body["output_config"]).toEqual({ effort: "low" });
    expect(calls[0]!.body["max_tokens"]).toBe(64_000);
  });

  it("Anthropic: a refusal without output throws; max_tokens and model_context_window_exceeded map to length", async () => {
    const refused = captureAnthropic({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } });
    const err = await new AnthropicProvider(createAnthropicClient("k", { fetch: refused.fetchImpl })).completeJson(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "refusal", provider: "anthropic", message: "The model refused to answer: cyber" });
    const truncated = captureAnthropic({ stop_reason: "max_tokens" });
    const result = await new AnthropicProvider(createAnthropicClient("k", { fetch: truncated.fetchImpl })).completeJson(request);
    expect(result.finishReason).toBe("length");
    const overflowed = captureAnthropic({ stop_reason: "model_context_window_exceeded" });
    const cutOff = await new AnthropicProvider(createAnthropicClient("k", { fetch: overflowed.fetchImpl })).completeJson(request);
    expect(cutOff.finishReason).toBe("length");
  });

  it("Anthropic: streams text deltas, skips thinking deltas, and takes usage from message_start and message_delta", async () => {
    const frames = [
      frame({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 2 } } }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "ping" }),
      frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: '{"a":' } }),
      frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: '"b"}' } }),
      frame({ type: "content_block_stop", index: 1 }),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3, input_tokens: null } }),
      frame({ type: "message_stop" }),
    ];
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse(frames)(url, init);
    };
    const deltas: Array<[string, string]> = [];
    const provider = new AnthropicProvider(createAnthropicClient("k", { fetch: fetchImpl }));
    const result = await provider.completeJson({ ...request, stream: true, onDelta: (delta, accumulated) => deltas.push([delta, accumulated]) });
    expect(body).toMatchObject({ stream: true, max_tokens: 1000 });
    expect(deltas).toEqual([
      ['{"a":', '{"a":'],
      ['"b"}', '{"a":"b"}'],
    ]);
    expect(result).toEqual({
      content: '{"a":"b"}',
      finishReason: "stop",
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      model: "claude-haiku-5-5",
    });
  });

  it("Anthropic: a streamed refusal reports its stop details", async () => {
    const frames = [
      frame({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } }),
      frame({ type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "cyber", explanation: "declined" } }, usage: { output_tokens: 0 } }),
      frame({ type: "message_stop" }),
    ];
    const err = await new AnthropicProvider(createAnthropicClient("k", { fetch: sse(frames) })).completeJson({ ...request, stream: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "refusal", provider: "anthropic", message: "The model refused to answer: declined" });
  });

  it("Anthropic: listModels asks for one page of 1000, filters it, and throws ApiErrors", async () => {
    const urls: string[] = [];
    const models = [
      { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 1_000_000 },
      { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", max_input_tokens: 1_000_000 },
      { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000 },
    ];
    const listing: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: models, has_more: false, first_id: null, last_id: null }), { headers: { "Content-Type": "application/json" } });
    };
    const options = await new AnthropicProvider(createAnthropicClient("k", { fetch: listing })).listModels();
    expect(urls).toEqual(["https://api.anthropic.com/v1/models?limit=1000"]);
    expect(options.map((o) => o.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);

    const rejected: typeof fetch = async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    const err = await new AnthropicProvider(createAnthropicClient("k", { fetch: rejected })).listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: "auth", provider: "anthropic", status: 401 });
  });

  it("json_object mode is passed through", async () => {
    const { calls, fetchImpl } = capture();
    const provider = new OpenAIProvider(new OpenAIClient({ apiKey: "k", fetchImpl }));
    await provider.completeJson({ ...request, format: { type: "json_object" } });
    expect(calls[0]!.body["response_format"]).toEqual({ type: "json_object" });
  });
});
