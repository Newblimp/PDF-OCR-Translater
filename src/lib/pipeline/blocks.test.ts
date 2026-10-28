import { describe, expect, it } from "vitest";
import { blockTypeCounts, filteredText, pageBlocks, shownTextBlockIds, textBlocks, textPages, type BlockFilter } from "./blocks";
import type { OcrCleanPage } from "./ocrText";

function page(index: number, blocks: Array<{ type: string; content: string; image_id?: string }>, markdown = ""): OcrCleanPage {
  return {
    index,
    markdown,
    header: null,
    footer: null,
    imageCount: 0,
    width: 1000,
    height: 1400,
    blocks: blocks.map((b, i) => ({ ...b, top_left_x: 10, top_left_y: 10 + i * 100, bottom_right_x: 900, bottom_right_y: 90 + i * 100 })),
  };
}

const filter = (hiddenTypes: string[] = [], excluded: string[] = []): BlockFilter => ({ hiddenTypes: new Set(hiddenTypes), excluded: new Set(excluded) });

const pages = [
  page(0, [
    { type: "header", content: "国家知识产权局" },
    { type: "title", content: "第一次审查意见通知书" },
    { type: "image", content: "", image_id: "img-0.jpeg" },
    { type: "text", content: "  " },
    { type: "text", content: "权利要求1不具备创造性。" },
  ]),
  page(2, [{ type: "text", content: "第二页" }]),
];

describe("pageBlocks", () => {
  it("keeps the reading order and the OCR block ids, drops empty text blocks and keeps image blocks", () => {
    const blocks = pageBlocks(pages[0]!);
    expect(blocks.map((b) => [b.id, b.type])).toEqual([
      ["0:0", "header"],
      ["0:1", "title"],
      ["0:2", "image"],
      ["0:4", "text"],
    ]);
    expect(blocks[2]).toMatchObject({ imageId: "img-0.jpeg", text: "" });
    expect(blocks[1]!.box).toEqual({ x0: 10, y0: 110, x1: 900, y1: 190 });
  });

  it("stands in the whole Markdown for a page without blocks", () => {
    const blocks = pageBlocks({ ...page(3, []), markdown: "# Page\n\ntext" });
    expect(blocks).toEqual([{ id: "3:page", type: "text", text: "# Page\n\ntext", imageId: null, box: null, wholePage: true }]);
  });
});

describe("filters", () => {
  it("leaves out hidden block types and single blocks from the blocks to translate", () => {
    expect([...shownTextBlockIds(pages, filter())]).toEqual(["0:0", "0:1", "0:4", "2:0"]);
    expect([...shownTextBlockIds(pages, filter(["header"], ["2:0"]))]).toEqual(["0:1", "0:4"]);
  });

  it("translates a page the OCR returned without blocks as one block, so its text is not lost", () => {
    const bare = { ...page(3, []), markdown: "# Page\n\ntext" };
    expect(textBlocks(bare)).toEqual([{ id: "3:page", text: "# Page\n\ntext" }]);
    expect([...shownTextBlockIds([...pages, bare], filter(["header"], ["2:0"]))]).toEqual(["0:1", "0:4", "3:page"]);
    expect(filteredText([bare], filter(), { "3:page": "# Seite\n\nText" })).toBe("# Seite\n\nText");
    expect(textBlocks({ ...page(4, []), markdown: "  " })).toEqual([]);
  });

  it("counts the block types in a stable order", () => {
    expect(blockTypeCounts(pages)).toEqual([
      { type: "title", count: 1 },
      { type: "text", count: 2 },
      { type: "image", count: 1 },
      { type: "header", count: 1 },
    ]);
  });

  it("gives the text the filter keeps, translated where a translation exists, with page delimiters", () => {
    const text = filteredText(pages, filter(["header"]), { "0:1": "First Office Action", "2:0": " " });
    expect(text).toBe("----- Page 1 -----\n\nFirst Office Action\n\n[Image: img-0.jpeg]\n\n权利要求1不具备创造性。\n\n----- Page 3 -----\n\n第二页");
    expect(filteredText([pages[1]!], filter(), null)).toBe("第二页");
    expect(filteredText(pages, filter(["image", "header"], ["0:4", "2:0"]), null)).toBe("----- Page 1 -----\n\n第一次审查意见通知书\n\n----- Page 3 -----");
  });
});

describe("textPages", () => {
  it("splits text input into paragraph blocks and guesses their type", () => {
    const [only, ...rest] = textPages("# 标题\n\n第一段\n第一段续\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n\n```\ncode\n\nmore\n```\n\n[Image: img-1.jpeg]");
    expect(rest).toEqual([]);
    expect(only!.index).toBe(0);
    expect(only!.blocks.map((b) => [b.type, b.content])).toEqual([
      ["title", "# 标题"],
      ["text", "第一段\n第一段续"],
      ["list", "- 一\n- 二"],
      ["table", "| a | b |\n|---|---|"],
      ["code", "```\ncode\n\nmore\n```"],
      ["image", ""],
    ]);
    expect(only!.blocks[5]!.image_id).toBe("img-1.jpeg");
    // No positions: nothing to place on a page.
    expect(pageBlocks(only!).every((b) => b.box === null)).toBe(true);
  });

  it("starts a new page at each page delimiter of an OCR text", () => {
    const out = textPages("----- Page 1 -----\n\n甲\n\n----- Page 3 -----\n\n乙\n\n丙");
    expect(out.map((p) => [p.index, p.blocks.map((b) => b.content)])).toEqual([
      [0, ["甲"]],
      [2, ["乙", "丙"]],
    ]);
  });
});
