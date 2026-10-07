import { describe, expect, it } from "vitest";
import { ApiError } from "../http/apiError";
import type { ChatProvider, JsonChatRequest, JsonChatResult } from "../llm/provider";
import type { ProgressEvent } from "./events";
import { translateStructured } from "./translate";

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };

function fakeProvider(handler: (req: JsonChatRequest) => JsonChatResult | Promise<JsonChatResult>): ChatProvider {
  return {
    id: "openai",
    label: "Fake",
    listModels: async () => [],
    completeJson: async (req) => {
      const r = await handler(req);
      if (req.stream) req.onDelta?.(r.content, r.content);
      return r;
    },
  };
}

const ok = (content: string): JsonChatResult => ({ content, finishReason: "stop", usage: null, model: "m" });
const base = { model: "m", schema, targetLanguage: "English", sourceLanguage: "auto", domainHint: "test" };

describe("translateStructured", () => {
  it("uses strict json_schema mode with streaming by default", async () => {
    const seen: JsonChatRequest[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      return ok('{"title":"Hello"}');
    });
    const out = await translateStructured(provider, "你好", { ...base, reasoningEffort: "none" });
    expect(out.data).toEqual({ title: "Hello" });
    expect(out.mode).toBe("json_schema");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.format).toMatchObject({ type: "json_schema", strict: true, name: "translated_document" });
    expect(seen[0]?.stream).toBe(true);
    expect(seen[0]?.reasoningEffort).toBe("none");
    // The document goes in the shared, cached context; the task (and schema) last.
    expect(seen[0]?.context).toContain("你好");
    expect(seen[0]?.user).toMatch(/^Task: /);
    expect(seen[0]?.user).toContain('"title"');
    expect(seen[0]?.cachePrefix).toBe(true);
    expect(out.violations).toEqual([]);
    expect(out.partial).toBe(false);
  });

  it("keeps the source language and its own stage with target \"original\"", async () => {
    const seen: JsonChatRequest[] = [];
    const events: ProgressEvent[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      return ok('{"title":"你好"}');
    });
    const out = await translateStructured(provider, "你好", {
      ...base,
      target: "original",
      stage: "structure_original",
      streaming: false,
      onProgress: (e) => events.push(e),
    });
    expect(out.data).toEqual({ title: "你好" });
    expect(seen[0]?.format).toMatchObject({ type: "json_schema", strict: true, name: "original_document" });
    expect(seen[0]?.stream).toBe(false);
    expect(seen[0]?.user).toContain("Do NOT translate");
    expect(seen[0]?.context).toContain("你好");
    expect(events.every((e) => e.stage === "structure_original")).toBe(true);
  });

  it("falls back to non-streaming and then json_object on 4xx errors, reporting warnings", async () => {
    const calls: string[] = [];
    const events: ProgressEvent[] = [];
    const provider = fakeProvider((req) => {
      calls.push(`${req.format.type}:${req.stream ? "stream" : "plain"}`);
      if (req.format.type === "json_schema") throw new ApiError("bad schema", "request", "openai", 400);
      return ok('```json\n{"title":"ok"}\n```');
    });
    const out = await translateStructured(provider, "text", { ...base, onProgress: (e) => events.push(e) });
    expect(calls).toEqual(["json_schema:stream", "json_schema:plain", "json_object:plain"]);
    expect(out.mode).toBe("json_object");
    expect(out.data).toEqual({ title: "ok" });
    expect(events.filter((e) => e.status === "warning")).toHaveLength(2);
  });

  it("keeps the images when the rejection is about the schema, and only drops streaming / strict mode", async () => {
    const seen: JsonChatRequest[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      if (req.format.type === "json_schema") throw new ApiError("HTTP 400: Invalid schema for response_format 'translated_document'", "request", "openai", 400);
      return ok('{"title":"ok"}');
    });
    const images = [{ id: "img-0.jpeg", dataUrl: "data:image/png;base64,AA" }];
    const out = await translateStructured(provider, "text", { ...base, images });
    expect(seen.map((r) => `${r.format.type}:${r.stream ? "stream" : "plain"}:${r.images?.length ?? 0}`)).toEqual([
      "json_schema:stream:1",
      "json_schema:plain:1",
      "json_object:plain:1",
    ]);
    expect(out.imagesSent).toBe(1);
  });

  it("attaches bounding-box images, lists their ids in the prompt, and drops them if the model rejects images", async () => {
    const seen: JsonChatRequest[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      if (req.images?.length) throw new ApiError("HTTP 400: Invalid content type. image_url is only supported by certain models.", "request", "openai", 400);
      return ok('{"title":"ok"}');
    });
    const images = [
      { id: "img-0.jpeg", dataUrl: "data:image/png;base64,AA" },
      { id: "img-1.jpeg", dataUrl: "data:image/png;base64,BB" },
    ];
    const out = await translateStructured(provider, "text", { ...base, images, streaming: false });
    expect(seen[0]?.images).toHaveLength(2);
    expect(seen[0]?.context).toContain('"img-0.jpeg", "img-1.jpeg"');
    expect(seen[1]?.images).toBeUndefined();
    expect(out.imagesSent).toBe(0);
    expect(out.mode).toBe("json_schema");
  });

  it("reports the number of images sent and streams partial text", async () => {
    const events: ProgressEvent[] = [];
    const provider = fakeProvider(() => ok('{"title":"streamed"}'));
    const out = await translateStructured(provider, "text", {
      ...base,
      images: [{ id: "x", dataUrl: "data:image/png;base64,AA" }],
      onProgress: (e) => events.push(e),
    });
    expect(out.imagesSent).toBe(1);
    expect(events.some((e) => e.status === "progress" && e.streamText === '{"title":"streamed"}')).toBe(true);
  });

  it("does not retry on refusals or on rejections a different format cannot fix", async () => {
    let calls = 0;
    const refusing = fakeProvider(() => {
      calls++;
      throw new ApiError("The model refused to answer: no", "refusal", "openai");
    });
    await expect(translateStructured(refusing, "text", { ...base })).rejects.toMatchObject({ kind: "refusal" });
    expect(calls).toBe(1);

    calls = 0;
    const unsupported = fakeProvider(() => {
      calls++;
      throw new ApiError("HTTP 400: Unsupported parameter: 'reasoning_effort' is not supported with this model.", "request", "openai", 400);
    });
    await expect(translateStructured(unsupported, "text", { ...base })).rejects.toMatchObject({ kind: "request" });
    expect(calls).toBe(1);
  });

  it("explains a content-filter stop instead of a parse error", async () => {
    const provider = fakeProvider(() => ({ content: "", finishReason: "content_filter", usage: null, model: "m" }));
    await expect(translateStructured(provider, "text", { ...base, streaming: false })).rejects.toThrow(/content filter/);
  });

  it("does not retry on auth or network errors", async () => {
    const provider = fakeProvider(() => {
      throw new ApiError("nope", "auth", "openai", 401);
    });
    await expect(translateStructured(provider, "text", { ...base })).rejects.toMatchObject({ kind: "auth" });
  });

  it("shares one system prompt and document context between the translation and the original-language structure", async () => {
    const seen: JsonChatRequest[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      return ok('{"title":"x"}');
    });
    const images = [{ id: "img-0.jpeg", dataUrl: "data:image/png;base64,AA" }];
    await translateStructured(provider, "文本", { ...base, images, glossary: "审查员 = examiner" });
    await translateStructured(provider, "文本", { ...base, images, glossary: "审查员 = examiner", target: "original", streaming: false });
    expect(seen[0]?.system).toBe(seen[1]?.system);
    expect(seen[0]?.context).toBe(seen[1]?.context);
    expect(seen[0]?.system).toContain("审查员 → examiner");
    expect(seen[0]?.user).not.toBe(seen[1]?.user);
  });

  it("labels the part of a long document in the context", async () => {
    const seen: JsonChatRequest[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      return ok('{"title":"x"}');
    });
    await translateStructured(provider, "text", { ...base, part: { index: 1, count: 3, label: "pages 4-6" } });
    expect(seen[0]?.context).toMatch(/^This is part 2 of 3 of a longer document \(pages 4-6\)/);
  });

  it("keeps the fields received before the output limit cut the JSON off", async () => {
    const events: ProgressEvent[] = [];
    const provider = fakeProvider(() => ({ content: '{"title":"Complete","body":"Half a sent', finishReason: "length", usage: null, model: "m" }));
    const out = await translateStructured(provider, "text", { ...base, streaming: false, onProgress: (e) => events.push(e) });
    expect(out.partial).toBe(true);
    expect(out.data).toEqual({ title: "Complete", body: "Half a sent" });
    expect(events.some((e) => e.status === "warning" && /Kept the 2 field/.test(e.message))).toBe(true);
    // Without a cut-off, unparsable output is still an error.
    const broken = fakeProvider(() => ({ content: '{"title":"x"', finishReason: "stop", usage: null, model: "m" }));
    await expect(translateStructured(broken, "text", { ...base, streaming: false })).rejects.toThrow(/could not be parsed/);
  });

  it("reports schema deviations and truncation", async () => {
    const events: ProgressEvent[] = [];
    const provider = fakeProvider(() => ({ content: '{"wrong":1}', finishReason: "length", usage: null, model: "m" }));
    const out = await translateStructured(provider, "text", { ...base, streaming: false, onProgress: (e) => events.push(e) });
    expect(out.violations).toEqual(["$.title: missing"]);
    expect(out.finishReason).toBe("length");
    expect(events.some((e) => e.status === "warning" && /truncated/.test(e.message))).toBe(true);
  });
});
