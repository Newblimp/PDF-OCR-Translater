import { describe, expect, it } from "vitest";
import { MistralApiError, MistralClient } from "../mistral/client";
import type { ChatCompletionRequest } from "../mistral/types";
import type { ProgressEvent } from "./events";
import { translateStructured } from "./translate";

const schema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

function fakeClient(handler: (req: ChatCompletionRequest) => string): MistralClient {
  const client = new MistralClient({ apiKey: "k", fetchImpl: async () => new Response("", { status: 500 }) });
  const respond = (req: ChatCompletionRequest) => ({ content: handler(req), finishReason: "stop" as const, usage: null, model: req.model });
  client.chat = async (req) => respond(req);
  client.chatStream = async (req, opts) => {
    const r = respond(req);
    opts?.onDelta?.(r.content, r.content);
    return r;
  };
  return client;
}

const base = { model: "m", schema, targetLanguage: "English", sourceLanguage: "auto", domainHint: "test" };

describe("translateStructured", () => {
  it("uses strict json_schema mode with streaming by default", async () => {
    const seen: ChatCompletionRequest[] = [];
    const client = fakeClient((req) => {
      seen.push(req);
      return '{"title":"Hello"}';
    });
    const out = await translateStructured(client, "你好", { ...base });
    expect(out.data).toEqual({ title: "Hello" });
    expect(out.mode).toBe("json_schema");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, name: "translated_document" } });
    expect(out.violations).toEqual([]);
  });

  it("falls back to non-streaming and then json_object on 4xx errors, reporting warnings", async () => {
    const calls: string[] = [];
    const events: ProgressEvent[] = [];
    const client = fakeClient(() => "unused");
    client.chatStream = async () => {
      calls.push("stream");
      throw new MistralApiError("bad schema", "request", 400);
    };
    client.chat = async (req) => {
      calls.push(`chat:${req.response_format?.type}`);
      if (req.response_format?.type === "json_schema") throw new MistralApiError("still bad", "request", 422);
      return { content: '```json\n{"title":"ok"}\n```', finishReason: "stop", usage: null, model: "m" };
    };
    const out = await translateStructured(client, "text", { ...base, onProgress: (e) => events.push(e) });
    expect(calls).toEqual(["stream", "chat:json_schema", "chat:json_object"]);
    expect(out.mode).toBe("json_object");
    expect(out.data).toEqual({ title: "ok" });
    expect(events.filter((e) => e.status === "warning")).toHaveLength(2);
  });

  it("does not retry on auth or network errors", async () => {
    const client = fakeClient(() => "unused");
    client.chatStream = async () => {
      throw new MistralApiError("nope", "auth", 401);
    };
    await expect(translateStructured(client, "text", { ...base })).rejects.toMatchObject({ kind: "auth" });
  });

  it("reports schema deviations from json_object output", async () => {
    const client = fakeClient(() => '{"wrong":1}');
    const out = await translateStructured(client, "text", { ...base, streaming: false });
    expect(out.violations).toEqual(["$.title: missing"]);
  });
});
