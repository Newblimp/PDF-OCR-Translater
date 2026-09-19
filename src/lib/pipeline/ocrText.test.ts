import { describe, expect, it } from "vitest";
import type { OcrResponse } from "../mistral/types";
import { buildOcrText, replaceImageReferences, toImageDataUrl } from "./ocrText";

describe("replaceImageReferences", () => {
  it("turns markdown and html images into id placeholders and collapses blank lines", () => {
    const { text, count } = replaceImageReferences("Title\n\n![img-0.jpeg](img-0.jpeg)\n\n\n\nBody <img src=\"x.png\"> end  \n");
    expect(count).toBe(2);
    expect(text).toBe("Title\n\n[Image: img-0.jpeg]\n\nBody [Image: x.png] end");
  });
});

describe("toImageDataUrl", () => {
  it("keeps data URLs and prefixes bare base64", () => {
    expect(toImageDataUrl("data:image/jpeg;base64,AAA")).toBe("data:image/jpeg;base64,AAA");
    expect(toImageDataUrl("iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(toImageDataUrl("/9j/4AAQ")).toBe("data:image/jpeg;base64,/9j/4AAQ");
    expect(toImageDataUrl(null)).toBeNull();
  });
});

describe("buildOcrText", () => {
  const response: OcrResponse = {
    model: "mistral-ocr-latest",
    usage_info: { pages_processed: 2 },
    pages: [
      {
        index: 1,
        markdown: "Second page",
        images: [{ id: "img-1.jpeg", top_left_x: 10, top_left_y: 20, bottom_right_x: 110, bottom_right_y: 120, image_base64: "data:image/jpeg;base64,BBB" }],
        dimensions: { dpi: 200, height: 2000, width: 1500 },
        header: "HDR",
        footer: null,
        blocks: [{ type: "text", top_left_x: 0, top_left_y: 0, bottom_right_x: 5, bottom_right_y: 5, content: "Second page" }],
      },
      {
        index: 0,
        markdown: "First page ![a](img-0.jpeg)",
        images: [{ id: "img-0.jpeg", top_left_x: 1, top_left_y: 2, bottom_right_x: 3, bottom_right_y: 4, image_base64: null }],
        dimensions: null,
        header: null,
        footer: "p. 1",
      },
    ],
  };

  it("orders pages, joins with delimiters, keeps placeholders, and collects bounding boxes", () => {
    const out = buildOcrText(response);
    expect(out.pages.map((p) => p.index)).toEqual([0, 1]);
    expect(out.text).toBe("----- Page 1 -----\n\nFirst page [Image: img-0.jpeg]\n\n----- Page 2 -----\n\nSecond page");
    expect(out.pages[0]?.footer).toBe("p. 1");
    expect(out.pages[1]?.header).toBe("HDR");
    expect(out.pages[1]?.blocks).toHaveLength(1);
    expect(out.pages[1]?.width).toBe(1500);
    expect(out.bboxes.map((b) => b.id)).toEqual(["img-0.jpeg", "img-1.jpeg"]);
    expect(out.bboxes[1]).toMatchObject({ pageIndex: 1, x0: 10, y0: 20, x1: 110, y1: 120, pageWidth: 1500, dataUrl: "data:image/jpeg;base64,BBB" });
    expect(out.bboxes[0]?.dataUrl).toBeNull();
    expect(out.pagesProcessed).toBe(2);
  });

  it("does not add delimiters for a single page", () => {
    const single: OcrResponse = { ...response, pages: [response.pages[1]!] };
    expect(buildOcrText(single).text).toBe("First page [Image: img-0.jpeg]");
  });
});
