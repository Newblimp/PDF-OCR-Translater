import { describe, expect, it } from "vitest";
import { OpenAIClient } from "../openai/client";
import { MistralClient } from "../mistral/client";
import { OpenAIProvider } from "./openaiProvider";
import { MistralProvider } from "./mistralProvider";
import type { JsonChatRequest } from "./provider";

const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

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

  it("json_object mode is passed through", async () => {
    const { calls, fetchImpl } = capture();
    const provider = new OpenAIProvider(new OpenAIClient({ apiKey: "k", fetchImpl }));
    await provider.completeJson({ ...request, format: { type: "json_object" } });
    expect(calls[0]!.body["response_format"]).toEqual({ type: "json_object" });
  });
});
