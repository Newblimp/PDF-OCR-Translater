import { describe, expect, it } from "vitest";
import { formatPageSelection, parsePageSelection } from "./pageSelection";

describe("parsePageSelection", () => {
  it("means all pages when empty or when every page is listed", () => {
    expect(parsePageSelection("", 10)).toEqual({ pages: null, text: "", error: null });
    expect(parsePageSelection("1-3", 3)).toEqual({ pages: null, text: "", error: null });
  });
  it("parses ranges and single pages into sorted unique 0-based indices", () => {
    expect(parsePageSelection("3, 1-2, 7,7", 10)).toEqual({ pages: [0, 1, 2, 6], text: "1-3, 7", error: null });
    expect(parsePageSelection("2 - 4", null).pages).toEqual([1, 2, 3]);
  });
  it("reports invalid input and out-of-range pages", () => {
    expect(parsePageSelection("a-b", 10).error).toMatch(/not a page number/);
    expect(parsePageSelection("5-2", 10).error).toMatch(/not a valid range/);
    expect(parsePageSelection("0", 10).error).toMatch(/not a valid range/);
    expect(parsePageSelection("11", 10).error).toMatch(/does not exist/);
  });
});

describe("formatPageSelection", () => {
  it("collapses runs into ranges", () => {
    expect(formatPageSelection([0, 1, 2, 6, 8, 9])).toBe("1-3, 7, 9-10");
    expect(formatPageSelection([])).toBe("");
  });
});
