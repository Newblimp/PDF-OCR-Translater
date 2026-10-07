import { describe, expect, it } from "vitest";
import type { ChatProvider, JsonChatRequest } from "../llm/provider";
import type { ProgressEvent } from "./events";
import { translateDocument, type PipelineContext, type PipelineSettings } from "./pipeline";
import type { OcrText } from "./ocrText";

const settings: PipelineSettings = {
  ocrModel: "ocr",
  chatModel: "m",
  schemaMode: { kind: "infer" },
  streaming: true,
  temperature: 0.2,
  sendImages: true,
  bboxAnnotations: false,
  maxBboxAnnotations: 0,
  blockTranslations: false,
  structureOriginal: "on_demand",
  targetLanguage: "English",
  sourceLanguage: "auto",
  domainHint: "test",
};

const schema = { type: "object", properties: { body: { type: "string" }, refs: { type: "array", items: { type: "string" } } }, required: ["body", "refs"], additionalProperties: false };

/** Pages of ~30k estimated tokens each, so every page becomes its own part. */
function longOcr(): OcrText {
  const pages = [0, 1].map((index) => ({ index, markdown: "字".repeat(30_000), header: null, footer: null, imageCount: 0, width: 1, height: 1, blocks: [] }));
  const bboxes = [0, 1].map((pageIndex) => ({ id: `img-${pageIndex}`, pageIndex, x0: 0, y0: 0, x1: 1, y1: 1, pageWidth: 1, pageHeight: 1, dataUrl: "data:image/png;base64,AA" }));
  return { text: pages.map((p) => p.markdown).join("\n\n"), pages, bboxes, pagesProcessed: 2, chars: 60_001 };
}

describe("translateDocument", () => {
  it("fills a long document in parts, with each part's own images, and merges the results", async () => {
    const seen: JsonChatRequest[] = [];
    const events: ProgressEvent[] = [];
    const chat: ChatProvider = {
      id: "anthropic",
      label: "Fake",
      listModels: async () => [],
      completeJson: async (req) => {
        seen.push(req);
        const part = seen.length;
        const content = JSON.stringify({ body: `Part ${part}.`, refs: [`D${part}`] });
        req.onDelta?.(content, content);
        return { content, finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: "m" };
      },
    };
    const ctx: PipelineContext = { ocr: null as never, chat, settings, onProgress: (e) => events.push(e) };
    const ocr = longOcr();
    const out = await translateDocument(ctx, ocr.text, schema, ocr);

    expect(seen).toHaveLength(2);
    expect(seen.map((r) => r.images?.map((i) => i.id))).toEqual([["img-0"], ["img-1"]]);
    expect(seen[1]!.context).toMatch(/^This is part 2 of 2 of a longer document \(page 2\)/);
    expect(out.data).toEqual({ body: "Part 1.\n\nPart 2.", refs: ["D1", "D2"] });
    expect(out.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
    expect(out.imagesSent).toBe(2);
    expect(out.violations).toEqual([]);
    // While part 2 streams, the live view shows it merged with part 1.
    const streamed = events.filter((e) => e.streamText).map((e) => JSON.parse(e.streamText!) as unknown);
    expect(streamed.at(-1)).toEqual({ body: "Part 1.\n\nPart 2.", refs: ["D1", "D2"] });
  });
});
