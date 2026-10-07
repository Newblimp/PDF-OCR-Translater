import { describe, expect, it } from "vitest";
import { estimateRun, formatUsd, type EstimateInput } from "./estimate";

const base: EstimateInput = {
  sourceTokens: 10_000,
  boxes: 2,
  hasBlocks: true,
  model: "claude-haiku-5-5",
  inferSchema: true,
  sendImages: true,
  bboxAnnotations: true,
  maxBboxAnnotations: 20,
  blockTranslations: true,
  structureOriginalAlways: false,
};

describe("estimateRun", () => {
  it("counts the pipeline's calls and prices them for known models", () => {
    const out = estimateRun(base);
    expect(out.calls).toBe(5); // inference, translation, 2 boxes, block translations
    expect(out.inputTokens).toBeGreaterThan(20_000);
    expect(out.outputTokens).toBeGreaterThan(20_000);
    expect(out.cost).toBeGreaterThan(0);
    expect(out.cost).toBeLessThan(0.05);
  });

  it("adds the original-language structure, mostly from the cache, and splits long documents", () => {
    const withOriginal = estimateRun({ ...base, structureOriginalAlways: true });
    expect(withOriginal.calls).toBe(6);
    const long = estimateRun({ ...base, sourceTokens: 100_000 });
    expect(long.calls).toBe(7); // three parts
  });

  it("gives tokens only when the price is unknown", () => {
    expect(estimateRun({ ...base, model: "gpt-6-luna" }).cost).toBeNull();
  });
});

describe("formatUsd", () => {
  it("keeps small amounts readable", () => {
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(0.0042)).toBe("$0.004");
    expect(formatUsd(1.234)).toBe("$1.23");
  });
});
