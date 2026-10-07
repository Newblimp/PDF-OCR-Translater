import { describe, expect, it } from "vitest";
import { AnthropicClient } from "../anthropic/client";
import { OpenAIClient } from "../openai/client";
import { MistralClient } from "../mistral/client";
import { AnthropicProvider } from "./anthropicProvider";
import { OpenAIProvider } from "./openaiProvider";
import { MistralProvider } from "./mistralProvider";
import type { JsonChatRequest } from "./provider";

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
        content: [{ type: "text", text: '{"a":"b"}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 },
        ...message,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { calls, fetchImpl };
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

  it("Anthropic: structured outputs, effort, max_tokens, system prompt, base64 images, no temperature", async () => {
    const { calls, fetchImpl } = captureAnthropic();
    const provider = new AnthropicProvider(new AnthropicClient({ apiKey: "k", fetchImpl }));
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
    const provider = new AnthropicProvider(new AnthropicClient({ apiKey: "k", fetchImpl }));
    await provider.completeJson({ ...request, format: { type: "json_object" }, reasoningEffort: "none", maxOutputTokens: undefined });
    expect(calls[0]!.body["output_config"]).toEqual({ effort: "low" });
    expect(calls[0]!.body["max_tokens"]).toBe(64_000);
  });

  it("Anthropic: a refusal without output throws; max_tokens maps to length", async () => {
    const refused = captureAnthropic({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } });
    const err = await new AnthropicProvider(new AnthropicClient({ apiKey: "k", fetchImpl: refused.fetchImpl })).completeJson(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "refusal", provider: "anthropic" });
    const truncated = captureAnthropic({ stop_reason: "max_tokens" });
    const result = await new AnthropicProvider(new AnthropicClient({ apiKey: "k", fetchImpl: truncated.fetchImpl })).completeJson(request);
    expect(result.finishReason).toBe("length");
  });

  it("json_object mode is passed through", async () => {
    const { calls, fetchImpl } = capture();
    const provider = new OpenAIProvider(new OpenAIClient({ apiKey: "k", fetchImpl }));
    await provider.completeJson({ ...request, format: { type: "json_object" } });
    expect(calls[0]!.body["response_format"]).toEqual({ type: "json_object" });
  });
});
