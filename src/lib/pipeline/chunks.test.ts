import { describe, expect, it } from "vitest";
import { mergeStructured, splitDocument } from "./chunks";
import type { OcrText } from "./ocrText";

function ocrPages(texts: string[]): OcrText {
  const pages = texts.map((markdown, index) => ({ index, markdown, header: null, footer: null, imageCount: 0, width: 1, height: 1, blocks: [] }));
  return { text: texts.join("\n\n"), pages, bboxes: [], pagesProcessed: pages.length, chars: 0 };
}

describe("splitDocument", () => {
  it("keeps a short document whole", () => {
    expect(splitDocument("short", undefined)).toEqual([{ text: "short", pageIndices: null }]);
  });

  it("groups OCR pages up to the token budget and labels the page ranges", () => {
    const ocr = ocrPages(["a".repeat(400), "b".repeat(400), "c".repeat(400)]); // ~100 tokens each
    const chunks = splitDocument(ocr.text, ocr, 250);
    expect(chunks.map((c) => c.pageIndices)).toEqual([[0, 1], [2]]);
    expect(chunks.map((c) => c.label)).toEqual(["pages 1-2", "page 3"]);
    expect(chunks[0]!.text).toBe(`----- Page 1 -----\n\n${"a".repeat(400)}\n\n----- Page 2 -----\n\n${"b".repeat(400)}`);
  });

  it("splits text input on paragraphs", () => {
    const text = ["x".repeat(400), "y".repeat(400), "z".repeat(400)].join("\n\n");
    const chunks = splitDocument(text, undefined, 250);
    expect(chunks.map((c) => c.text.length)).toEqual([802, 400]);
    expect(chunks[1]!.label).toBe("section 2 of 2");
  });
});

describe("mergeStructured", () => {
  it("merges parts field by field", () => {
    const a = { number: "CN1", summary: "Part one.", sections: [{ h: "1" }], claims: 3, final: false, notes: "" };
    const b = { number: "CN1", summary: "Part two.", sections: [{ h: "2" }], claims: 0, final: true, notes: "Smudged." };
    expect(mergeStructured(a, b)).toEqual({
      number: "CN1",
      summary: "Part one.\n\nPart two.",
      sections: [{ h: "1" }, { h: "2" }],
      claims: 3,
      final: true,
      notes: "Smudged.",
    });
  });

  it("starts from nothing and keeps keys only one part has", () => {
    expect(mergeStructured(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeStructured({ a: { x: "1" } }, { a: { y: "2" }, b: [] })).toEqual({ a: { x: "1", y: "2" }, b: [] });
  });
});
