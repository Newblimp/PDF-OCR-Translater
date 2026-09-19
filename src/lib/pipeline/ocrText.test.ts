import { describe, expect, it } from "vitest";
import type { OcrResponse } from "../mistral/types";
import { buildOcrText, stripImages } from "./ocrText";

describe("stripImages", () => {
  it("removes markdown and html images and collapses blank lines", () => {
    const { text, removed } = stripImages("Title\n\n![img-0.jpeg](img-0.jpeg)\n\n\n\nBody <img src=\"x\"> end  \n");
    expect(removed).toBe(2);
    expect(text).toBe("Title\n\nBody  end");
  });
});

describe("buildOcrText", () => {
  const response: OcrResponse = {
    model: "mistral-ocr-latest",
    usage_info: { pages_processed: 2 },
    pages: [
      { index: 1, markdown: "Second page", images: [], dimensions: null, header: "HDR", footer: null },
      { index: 0, markdown: "First page ![a](a.png)", images: [], dimensions: null, header: null, footer: "p. 1" },
    ],
  };

  it("orders pages, joins with delimiters and separates headers/footers", () => {
    const out = buildOcrText(response);
    expect(out.pages.map((p) => p.index)).toEqual([0, 1]);
    expect(out.text).toBe("----- Page 1 -----\n\nFirst page\n\n----- Page 2 -----\n\nSecond page");
    expect(out.pages[0]?.footer).toBe("p. 1");
    expect(out.pages[1]?.header).toBe("HDR");
    expect(out.imagesRemoved).toBe(1);
    expect(out.pagesProcessed).toBe(2);
  });

  it("does not add delimiters for a single page", () => {
    const single: OcrResponse = { ...response, pages: [response.pages[1]!] };
    expect(buildOcrText(single).text).toBe("First page");
  });
});
