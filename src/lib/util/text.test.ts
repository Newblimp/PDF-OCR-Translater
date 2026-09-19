import { describe, expect, it } from "vitest";
import { estimateTokens, formatBytes, humanizeKey } from "./text";

describe("text helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(52428800)).toBe("50.0 MB");
  });
  it("humanizes keys", () => {
    expect(humanizeKey("application_number")).toBe("Application number");
    expect(humanizeKey("citedReferences")).toBe("Cited references");
  });
  it("estimates CJK-heavy text as roughly one token per character", () => {
    expect(estimateTokens("专利申请")).toBeGreaterThanOrEqual(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});
