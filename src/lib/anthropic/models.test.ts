import { describe, expect, it } from "vitest";
import { anthropicModelOptions } from "./models";

describe("anthropicModelOptions", () => {
  it("keeps Claude models that accept effort, Haiku first, newest first otherwise", () => {
    const options = anthropicModelOptions(
      [
        ["claude-opus-5-5", "Claude Opus 5.5"],
        ["claude-haiku-5-5", "Claude Haiku 5.5"],
        ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
        ["claude-fable-5-1", "Claude Fable 5.1"],
        ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
        ["claude-opus-4-5-20251101", "Claude Opus 4.5"],
        ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
        ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
        ["claude-opus-4-1-20250805", "Claude Opus 4.1"],
        ["claude-opus-4-20250514", "Claude Opus 4"],
        ["claude-3-haiku-20240307", "Claude Haiku 3"],
      ].map(([id, display_name]) => ({ id: id!, display_name: display_name!, max_input_tokens: 1_000_000 })),
    );
    expect(options.map((o) => o.id)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-4-6",
      "claude-opus-5-5",
      "claude-opus-4-5-20251101",
      "claude-fable-5-1",
    ]);
    expect(options[0]).toEqual({ id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (claude-haiku-5-5)", contextLength: 1_000_000 });
  });
});
