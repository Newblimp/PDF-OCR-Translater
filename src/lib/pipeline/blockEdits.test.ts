import { describe, expect, it } from "vitest";
import {
  applyCut,
  applyEdits,
  blockAt,
  blocksMarkdown,
  editableBlocks,
  emptyEdits,
  hasEdits,
  newBlockId,
  normaliseRect,
  planCut,
  selectionBlocks,
  subtractRect,
  withoutPage,
  withPage,
  type EditedBlock,
} from "./blockEdits";
import { pageBlocks } from "./blocks";
import { textBlocks } from "./blockTranslate";
import type { OcrText } from "./ocrText";

function block(type: string, x0: number, y0: number, x1: number, y1: number, content: string, image_id?: string) {
  return { type, top_left_x: x0, top_left_y: y0, bottom_right_x: x1, bottom_right_y: y1, content, ...(image_id ? { image_id } : {}) };
}

function ocr(): OcrText {
  const pages = [
    {
      index: 0,
      markdown: "# 标题\n\n第一段\n\n[Image: img-0.jpeg]\n\n第二段",
      header: "页眉",
      footer: null,
      imageCount: 1,
      width: 1000,
      height: 1400,
      blocks: [
        block("header", 100, 20, 900, 60, "页眉"),
        block("title", 100, 100, 900, 150, "# 标题"),
        block("text", 100, 200, 900, 300, "5 第一段"),
        block("image", 100, 400, 500, 700, "", "img-0.jpeg"),
        block("text", 100, 800, 900, 900, "第二段"),
      ],
    },
    {
      index: 1,
      markdown: "第三段",
      header: null,
      footer: null,
      imageCount: 0,
      width: 1000,
      height: 1400,
      blocks: [block("text", 100, 100, 900, 200, "第三段")],
    },
  ];
  const bboxes = [
    { id: "img-0.jpeg", pageIndex: 0, x0: 100, y0: 400, x1: 500, y1: 700, pageWidth: 1000, pageHeight: 1400, dataUrl: "data:image/png;base64,AA" },
  ];
  const text = "----- Page 1 -----\n\n# 标题\n\n第一段\n\n[Image: img-0.jpeg]\n\n第二段\n\n----- Page 2 -----\n\n第三段";
  return { text, pages, bboxes, pagesProcessed: 2, chars: text.length };
}

describe("geometry", () => {
  it("normalises a dragged rectangle onto the page", () => {
    expect(normaliseRect({ x: 300.4, y: -20 }, { x: 50, y: 99.6 }, 200, 1400)).toEqual({ x0: 50, y0: 0, x1: 200, y1: 100 });
  });

  it("subtracts a cut from a box: trimmed when it runs across, unchanged inside, gone when covered", () => {
    const box = { x0: 100, y0: 200, x1: 900, y1: 300 };
    expect(subtractRect(box, { x0: 50, y0: 150, x1: 160, y1: 350 })).toEqual({ x0: 160, y0: 200, x1: 900, y1: 300 }); // left margin strip
    expect(subtractRect(box, { x0: 850, y0: 0, x1: 1000, y1: 1400 })).toEqual({ x0: 100, y0: 200, x1: 850, y1: 300 });
    expect(subtractRect(box, { x0: 0, y0: 280, x1: 1000, y1: 400 })).toEqual({ x0: 100, y0: 200, x1: 900, y1: 280 });
    expect(subtractRect(box, { x0: 400, y0: 220, x1: 500, y1: 260 })).toEqual(box); // a hole: same box, text read again
    expect(subtractRect(box, { x0: 0, y0: 0, x1: 1000, y1: 1000 })).toBeNull();
    expect(subtractRect(box, { x0: 0, y0: 0, x1: 50, y1: 50 })).toEqual(box);
  });

  it("finds the blocks a selection touches and the smallest block at a point", () => {
    const blocks = editableBlocks(ocr().pages[0]!);
    const { inside, crossed } = selectionBlocks(blocks, { x0: 50, y0: 90, x1: 950, y1: 250 });
    expect(inside.map((b) => b.id)).toEqual(["0:1"]);
    expect(crossed.map((b) => b.id)).toEqual(["0:2"]);
    expect(blockAt(blocks, 200, 500)?.id).toBe("0:3");
    expect(blockAt(blocks, 950, 500)).toBeNull();
  });
});

describe("edits", () => {
  it("plans a cut: blocks inside go, crossed text is read again, crossed images are trimmed", () => {
    const blocks = editableBlocks(ocr().pages[0]!);
    const plan = planCut(blocks, { x0: 50, y0: 90, x1: 300, y1: 750 });
    expect(plan.removed).toEqual([]);
    expect(plan.trimmed.map((t) => [t.block.id, t.reread, t.box])).toEqual([
      ["0:1", true, { x0: 300, y0: 100, x1: 900, y1: 150 }],
      ["0:2", true, { x0: 300, y0: 200, x1: 900, y1: 300 }],
      ["0:3", false, { x0: 300, y0: 400, x1: 500, y1: 700 }],
    ]);
    const cut = applyCut(
      blocks,
      plan,
      new Map([
        ["0:2", { id: "0:e1", content: "第一段" }],
        ["0:1", { id: "0:e2", content: "" }],
      ]),
    );
    expect(cut.map((b) => [b.id, b.content, b.top_left_x])).toEqual([
      ["0:0", "页眉", 100],
      // the title came back empty: it goes
      ["0:e1", "第一段", 300],
      ["0:3", "", 300],
      ["0:4", "第二段", 100],
    ]);
  });

  it("applies edits: the page rebuilt from its blocks (headers out), ids kept, images follow their blocks", () => {
    const base = ocr();
    const [id, counted] = newBlockId(emptyEdits(), 0);
    expect(id).toBe("0:e1");
    let edits = counted;
    const blocks: EditedBlock[] = editableBlocks(base.pages[0]!)
      .filter((b) => b.type !== "image")
      .map((b) => (b.id === "0:2" ? { ...b, id, content: "第一段" } : b));
    edits = withPage(edits, 0, blocks);
    expect(hasEdits(edits)).toBe(true);
    const out = applyEdits(base, edits);
    expect(out.pages[0]!.markdown).toBe("# 标题\n\n第一段\n\n第二段");
    expect(out.text).toBe("----- Page 1 -----\n\n# 标题\n\n第一段\n\n第二段\n\n----- Page 2 -----\n\n第三段");
    expect(out.bboxes).toEqual([]); // its image block is gone
    expect(out.pages[1]).toBe(base.pages[1]); // other pages untouched
    // The ids hold: the untouched blocks keep the OCR's, the changed one is new.
    expect(textBlocks(out.pages[0]!).map((b) => b.id)).toEqual(["0:0", "0:1", "0:e1", "0:4"]);
    expect(pageBlocks(out.pages[0]!).map((b) => b.id)).toEqual(["0:0", "0:1", "0:e1", "0:4"]);
    expect(applyEdits(base, withoutPage(edits, 0))).toBe(base);
    expect(applyEdits(base, null)).toBe(base);
  });

  it("adds images made of a selection to the page's images", () => {
    const base = ocr();
    const blocks = [...editableBlocks(base.pages[1]!), { id: "1:e1", ...block("image", 100, 300, 400, 600, "", "edit-img-2") }];
    const edits = {
      ...withPage(emptyEdits(), 1, blocks),
      images: [{ id: "edit-img-2", pageIndex: 1, box: { x0: 100, y0: 300, x1: 400, y1: 600 }, dataUrl: "data:image/png;base64,BB" }],
    };
    const out = applyEdits(base, edits);
    expect(out.bboxes.map((b) => [b.id, b.pageIndex])).toEqual([
      ["img-0.jpeg", 0],
      ["edit-img-2", 1],
    ]);
    expect(out.pages[1]!.markdown).toBe("第三段\n\n[Image: edit-img-2]");
  });

  it("keeps headers and footers out of the rebuilt page text", () => {
    expect(blocksMarkdown([block("header", 0, 0, 1, 1, "页眉"), block("text", 0, 0, 1, 1, " 正文 "), block("footer", 0, 0, 1, 1, "第 1 页")])).toBe("正文");
  });
});
