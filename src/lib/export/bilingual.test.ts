import { describe, expect, it } from "vitest";
import { bilingualHtml, escapeHtml } from "./bilingual";

const render = (text: string) => `<p>${escapeHtml(text)}</p>`;

describe("bilingualHtml", () => {
  it("puts translation and original side by side and escapes everything it does not render", () => {
    const html = bilingualHtml(
      {
        title: "office <action>.pdf",
        targetLanguage: "English",
        producedBy: "Anthropic (Claude) · claude-haiku-5-5",
        completedAt: Date.UTC(2026, 9, 7),
        schema: { type: "object", properties: { summary: { type: "string" }, refs: { type: "array" } } },
        translated: { summary: "Not inventive.", refs: [{ label: "D1" }] },
        original: { summary: "不具备创造性。", refs: [{ label: "D1" }] },
        ocr: {
          text: "",
          chars: 0,
          pagesProcessed: 1,
          bboxes: [],
          pages: [{ index: 0, markdown: "", header: null, footer: null, imageCount: 0, width: 1, height: 1, blocks: [{ type: "text", top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1, content: "正文" }] }],
        },
        blockTranslations: { "0:0": "Body" },
      },
      render,
    );
    expect(html).toContain("<title>office &lt;action&gt;.pdf — bilingual</title>");
    expect(html).toContain("2026-10-07");
    expect(html).toMatch(/<th class="field" scope="row">Summary<\/th><td class="value"><p>Not inventive.<\/p><\/td><td class="value"><p>不具备创造性。<\/p><\/td>/);
    expect(html).toContain("<dt>Label</dt><dd><p>D1</p></dd>");
    expect(html).toContain("<h3>Page 1</h3>");
    expect(html).toContain("<td class=\"value\"><p>正文</p></td><td class=\"value\"><p>Body</p></td>");
    expect(html).not.toMatch(/<script/i);
  });

  it("says so when the original-language structure was not produced", () => {
    const html = bilingualHtml(
      { title: "t", targetLanguage: "German", producedBy: "p", completedAt: 0, schema: {}, translated: { a: "x" }, original: null, ocr: null, blockTranslations: {} },
      render,
    );
    expect(html).toContain("only the translation is shown");
    expect(html).not.toContain("Page by page");
  });
});
