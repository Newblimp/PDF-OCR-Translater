import { describe, expect, it } from "vitest";
import { extractJsonText, parseModelJson } from "./json";

describe("extractJsonText / parseModelJson", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it("strips fences and prose", () => {
    expect(extractJsonText('Sure!\n```json\n{"a": [1,2]}\n```\nDone.')).toBe('{"a": [1,2]}');
    expect(parseModelJson('Here you go: {"b":"x"} thanks')).toEqual({ ok: true, value: { b: "x" } });
  });
  it("fails clearly when there is no JSON", () => {
    expect(parseModelJson("nothing here").ok).toBe(false);
    expect(parseModelJson("{oops").ok).toBe(false);
  });
});
