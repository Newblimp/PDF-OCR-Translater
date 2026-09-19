import { describe, expect, it } from "vitest";
import { openaiModelOptions } from "./models";

describe("openaiModelOptions", () => {
  it("keeps GPT-5/6 text chat models, Luna first, and drops models that reject reasoning_effort or Chat Completions", () => {
    const ids = openaiModelOptions(
      [
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5-chat-latest",
        "gpt-5.2-pro",
        "gpt-5.2-pro-2025-12-11",
        "gpt-5.6-luna-pro",
        "gpt-image-2",
        "gpt-5.4-mini",
        "gpt-4.1",
        "gpt-realtime-2",
        "gpt-5.5-2026-04-23",
      ].map((id) => ({ id, object: "model" })),
    ).map((m) => m.id);
    expect(ids[0]).toBe("gpt-5.6-luna");
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).not.toContain("gpt-5-chat-latest");
    expect(ids).not.toContain("gpt-5.2-pro");
    expect(ids).not.toContain("gpt-5.6-luna-pro");
    expect(ids).not.toContain("gpt-image-2");
    expect(ids).not.toContain("gpt-4.1");
    expect(ids.at(-1)).toBe("gpt-5.5-2026-04-23"); // dated snapshots last
  });
});
