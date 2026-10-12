import { describe, expect, it } from "vitest";
import type { ChatProvider, JsonChatRequest } from "../llm/provider";
import { batchBlocks, translateBlocks } from "./blockTranslate";
import { blockId } from "./ocrText";
import type { OcrText } from "./ocrText";

function ocrWith(blocks: Array<{ page: number; type: string; content: string }>): OcrText {
  const pages = new Map<number, OcrText["pages"][number]>();
  for (const b of blocks) {
    const page = pages.get(b.page) ?? { index: b.page, markdown: "", header: null, footer: null, imageCount: 0, width: 100, height: 100, blocks: [] };
    page.blocks.push({ type: b.type, top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1, content: b.content });
    pages.set(b.page, page);
  }
  return { text: "", chars: 0, pagesProcessed: pages.size, pages: Array.from(pages.values()), bboxes: [] };
}

describe("batchBlocks", () => {
  it("skips image and empty blocks and splits by count and size", () => {
    const blocks = [
      { page: 0, type: "title", content: "T" },
      { page: 0, type: "image", content: "" },
      { page: 0, type: "text", content: "   " },
      ...Array.from({ length: 45 }, (_, i) => ({ page: 1, type: "text", content: `b${i}` })),
      { page: 2, type: "text", content: "x".repeat(12_500) },
    ];
    const batches = batchBlocks(ocrWith(blocks));
    expect(batches.map((b) => b.length)).toEqual([40, 6, 1]);
    expect(batches[0]![0]).toEqual({ id: blockId(0, 0), text: "T" });
  });
});

describe("translateBlocks", () => {
  it("sends batches in strict json_schema mode and maps translations by id, tolerating a failed batch", async () => {
    const ocr = ocrWith([
      { page: 0, type: "text", content: "你好" },
      { page: 0, type: "text", content: "世界" },
    ]);
    const seen: JsonChatRequest[] = [];
    const provider: ChatProvider = {
      id: "openai",
      label: "Fake",
      listModels: async () => [],
      completeJson: async (req) => {
        seen.push(req);
        const items = JSON.parse(req.user.replace(/^[^[]*/, "")) as Array<{ id: string; text: string }>;
        return {
          content: JSON.stringify({ translations: items.map((i) => ({ id: i.id, text: `EN(${i.text})` })) }),
          finishReason: "stop",
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          model: "m",
        };
      },
    };
    const batches: Array<Record<string, string>> = [];
    const out = await translateBlocks(provider, ocr, {
      model: "m",
      targetLanguage: "English",
      sourceLanguage: "auto",
      domainHint: "t",
      onTranslated: (t) => batches.push(t),
    });
    expect(seen).toHaveLength(1);
    expect(batches).toEqual([{ "0:0": "EN(你好)", "0:1": "EN(世界)" }]);
    expect(seen[0]?.format).toMatchObject({ type: "json_schema", name: "block_translations", strict: true });
    expect(out.translations).toEqual({ "0:0": "EN(你好)", "0:1": "EN(世界)" });
    expect(out.usage.total_tokens).toBe(10);
    expect(out.missing).toBe(0);
  });

  it("translates only the given blocks", async () => {
    const ocr = ocrWith([
      { page: 0, type: "text", content: "你好" },
      { page: 0, type: "header", content: "页眉" },
    ]);
    const sent: string[] = [];
    const provider: ChatProvider = {
      id: "openai",
      label: "Fake",
      listModels: async () => [],
      completeJson: async (req) => {
        const items = JSON.parse(req.user.replace(/^[^[]*/, "")) as Array<{ id: string; text: string }>;
        sent.push(...items.map((i) => i.id));
        return { content: JSON.stringify({ translations: items.map((i) => ({ id: i.id, text: "x" })) }), finishReason: "stop", usage: null, model: "m" };
      },
    };
    const out = await translateBlocks(provider, ocr, {
      model: "m",
      targetLanguage: "English",
      sourceLanguage: "auto",
      domainHint: "t",
      onlyIds: new Set(["0:0"]),
    });
    expect(sent).toEqual(["0:0"]);
    expect(out.translations).toEqual({ "0:0": "x" });
  });
});
