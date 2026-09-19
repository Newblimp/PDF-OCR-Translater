import { describe, expect, it } from "vitest";
import type { ChatProvider, JsonChatRequest } from "../llm/provider";
import { annotateBboxes } from "./bboxAnnotate";
import type { OcrText } from "./ocrText";
import type { ProgressEvent } from "./events";

function fakeProvider(handler: (req: JsonChatRequest) => string): ChatProvider {
  return {
    id: "openai",
    label: "Fake",
    listModels: async () => [],
    completeJson: async (req) => ({ content: handler(req), finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: "m" }),
  };
}

const ocr: OcrText = {
  text: "[Image: a] text [Image: b]",
  chars: 10,
  pagesProcessed: 1,
  pages: [{ index: 0, markdown: "before [Image: a] after", header: null, footer: null, imageCount: 2, width: 100, height: 100, blocks: [] }],
  bboxes: [
    { id: "a", pageIndex: 0, x0: 0, y0: 0, x1: 1, y1: 1, pageWidth: 100, pageHeight: 100, dataUrl: "data:image/png;base64,AA" },
    { id: "b", pageIndex: 0, x0: 0, y0: 0, x1: 1, y1: 1, pageWidth: 100, pageHeight: 100, dataUrl: "data:image/png;base64,BB" },
    { id: "c", pageIndex: 0, x0: 0, y0: 0, x1: 1, y1: 1, pageWidth: 100, pageHeight: 100, dataUrl: null },
  ],
};
const base = { model: "m", targetLanguage: "English", sourceLanguage: "auto", domainHint: "test", maxBoxes: 20 };

describe("annotateBboxes", () => {
  it("calls the vision model once per box with an image, in strict json_schema mode, with context", async () => {
    const seen: JsonChatRequest[] = [];
    const provider = fakeProvider((req) => {
      seen.push(req);
      return JSON.stringify({ image_type: "stamp", short_description: "d", summary: "s", text_in_image: "", text_translated: "" });
    });
    const events: ProgressEvent[] = [];
    const out = await annotateBboxes(provider, ocr, { ...base, onProgress: (e) => events.push(e) });
    expect(seen).toHaveLength(2); // box c has no image
    expect(seen.map((r) => r.images?.[0]?.id).sort()).toEqual(["a", "b"]);
    expect(seen[0]?.format).toMatchObject({ type: "json_schema", name: "bbox_annotation", strict: true });
    expect(seen.find((r) => r.images?.[0]?.id === "a")?.user).toContain("before [Image: a] after");
    expect(out.annotations.map((a) => a.data?.image_type)).toEqual(["stamp", "stamp"]);
    expect(out.usage.total_tokens).toBe(30);
    expect(events.at(-1)?.status).toBe("done");
  });

  it("stops scheduling boxes after a systematic error and fails fast on auth errors", async () => {
    const { ApiError } = await import("../http/apiError");
    let calls = 0;
    const rateLimited = fakeProvider(() => {
      calls++;
      throw new ApiError("HTTP 429", "rate_limit", "openai", 429);
    });
    const out = await annotateBboxes(rateLimited, ocr, { ...base, concurrency: 1 });
    expect(calls).toBe(1);
    expect(out.annotations.every((a) => a.error)).toBe(true);
    const unauthorized = fakeProvider(() => {
      throw new ApiError("HTTP 401", "auth", "openai", 401);
    });
    await expect(annotateBboxes(unauthorized, ocr, { ...base })).rejects.toMatchObject({ kind: "auth" });
  });

  it("explains a zero limit instead of claiming there are no images", async () => {
    const provider = fakeProvider(() => "unused");
    const events: { message: string }[] = [];
    const out = await annotateBboxes(provider, ocr, { ...base, maxBoxes: 0, onProgress: (e) => events.push(e) });
    expect(out.skipped).toBe(2);
    expect(events[0]?.message).toMatch(/limit in Settings is 0/);
  });

  it("respects the limit and keeps going when one box fails", async () => {
    let n = 0;
    const provider = fakeProvider(() => {
      n++;
      if (n === 1) throw new Error("boom");
      return JSON.stringify({ image_type: "t", short_description: "d", summary: "s", text_in_image: "", text_translated: "" });
    });
    const out = await annotateBboxes(provider, ocr, { ...base, maxBoxes: 1, concurrency: 1 });
    expect(out.annotations).toHaveLength(1);
    expect(out.skipped).toBe(1);
    expect(out.annotations[0]?.error).toBe("boom");
  });
});
