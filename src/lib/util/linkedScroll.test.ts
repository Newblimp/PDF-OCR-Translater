import { describe, expect, it } from "vitest";
import { linkedScrollTop, type ScrollColumn } from "./linkedScroll";

/** A column of pages of the given heights, viewed through `view` pixels. */
function column(heights: number[], view: number, scrollTop = 0): ScrollColumn {
  let top = 0;
  const pages = heights.map((h, i) => {
    const page = { key: String(i), top };
    top += h;
    return page;
  });
  return { scrollTop, viewHeight: view, contentHeight: top, pages };
}

describe("linked scrolling", () => {
  it("keeps identical columns at the same position", () => {
    for (const scrollTop of [0, 120, 555, 900]) {
      expect(linkedScrollTop(column([300, 300, 300, 300], 300, scrollTop), column([300, 300, 300, 300], 300))).toBeCloseTo(scrollTop, 6);
    }
  });

  it("starts and ends both columns together", () => {
    const text = (scrollTop: number) => column([200, 150, 400], 300, scrollTop);
    const pdf = column([900, 900, 900], 500);
    expect(linkedScrollTop(text(0), pdf)).toBe(0);
    expect(linkedScrollTop(text(450), pdf)).toBeCloseTo(2200, 6); // the end: 2700 - 500
  });

  it("follows page by page, proportionally within a page", () => {
    // The reading point of the text is at the top of its second page: the pages column shows its second page there.
    const text = column([400, 400, 400, 400], 400, 400); // range 1200, progress 1/3, reading point 400 + 133.3
    const pdf = column([1000, 1000, 1000, 1000], 400);
    const top = linkedScrollTop(text, pdf);
    const point = top + 400 * (top / 3600);
    expect(point).toBeGreaterThan(1000);
    expect(point).toBeLessThan(2000);
    // Same fraction into the page on both sides.
    expect((point - 1000) / 1000).toBeCloseTo((400 + 400 / 3 - 400) / 400, 6);
  });

  it("maps pages by key and ignores pages only one side has", () => {
    const text: ScrollColumn = { scrollTop: 100, viewHeight: 100, contentHeight: 300, pages: [{ key: "0", top: 0 }, { key: "2", top: 150 }] };
    const pdf: ScrollColumn = { scrollTop: 0, viewHeight: 100, contentHeight: 900, pages: [{ key: "0", top: 0 }, { key: "1", top: 300 }, { key: "2", top: 600 }] };
    // Reading point 150 is the top of page "2" in the text; in the pages column, page "2" starts at 600.
    const top = linkedScrollTop(text, pdf);
    expect(top + 100 * (top / 800)).toBeCloseTo(600, 6);
  });

  it("leaves a column that cannot scroll at the top", () => {
    expect(linkedScrollTop(column([300, 300], 400, 100), column([100], 400))).toBe(0);
    expect(linkedScrollTop(column([100], 400), column([300, 300], 400))).toBe(0);
  });
});
