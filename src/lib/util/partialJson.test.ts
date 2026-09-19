import { describe, expect, it } from "vitest";
import { parsePartialJson } from "./partialJson";

describe("parsePartialJson", () => {
  it("parses complete JSON", () => {
    expect(parsePartialJson('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, "x"] });
  });

  it("closes unfinished strings, arrays and objects", () => {
    expect(parsePartialJson('{"title":"First Off')).toEqual({ title: "First Off" });
    expect(parsePartialJson('{"items":[{"h":"a","c":"b"},{"h":"c')).toEqual({ items: [{ h: "a", c: "b" }, { h: "c" }] });
    expect(parsePartialJson('{"a":{"b":{"c":"d"')).toEqual({ a: { b: { c: "d" } } });
  });

  it("drops keys without a value yet and handles escapes", () => {
    expect(parsePartialJson('{"a":"x","b"')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x","b":')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"line\\nbreak \\"q\\" \\u4e2d')).toEqual({ a: 'line\nbreak "q" 中' });
    expect(parsePartialJson('{"a":"trunc\\')).toEqual({ a: "trunc" });
  });

  it("returns undefined for nothing usable and tolerates fences/prose", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("   ")).toBeUndefined();
    expect(parsePartialJson('```json\n{"a":tr')).toEqual({});
    expect(parsePartialJson('Sure: {"n": -12.5e1, "ok": false')).toEqual({ n: -125, ok: false });
    expect(parsePartialJson('Here is the translation:\n{"document_type":"First')).toEqual({ document_type: "First" });
    expect(parsePartialJson('The 3 fields are: {"a":1}')).toEqual({ a: 1 });
    expect(parsePartialJson("no json at all")).toBeUndefined();
  });

  it("does not overflow the stack on long non-JSON preambles", () => {
    const preamble = "thinking… ".repeat(5000);
    expect(parsePartialJson(`${preamble}{"a":"b"}`)).toEqual({ a: "b" });
    expect(parsePartialJson(preamble)).toBeUndefined();
  });

  it("is monotonic over a streamed prefix sequence", () => {
    const full = '{"document_type":"First Office Action","body":[{"heading":"A","content":"long text here"}],"n":3}';
    let lastKeys = 0;
    for (let i = 1; i <= full.length; i++) {
      const v = parsePartialJson(full.slice(0, i));
      const keys = v && typeof v === "object" ? Object.keys(v as object).length : 0;
      expect(keys).toBeGreaterThanOrEqual(lastKeys);
      lastKeys = keys;
    }
    expect(parsePartialJson(full)).toEqual(JSON.parse(full));
  });
});
