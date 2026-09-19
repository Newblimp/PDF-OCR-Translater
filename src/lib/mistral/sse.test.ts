import { describe, expect, it } from "vitest";
import { SseParser } from "./sse";

describe("SseParser", () => {
  it("parses complete events", () => {
    const p = new SseParser();
    const events = p.push('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(events).toEqual([{ data: '{"a":1}' }, { data: "[DONE]" }]);
  });

  it("handles events split across chunks and CRLF", () => {
    const p = new SseParser();
    expect(p.push("data: {\"x\":")).toEqual([]);
    expect(p.push("1}\r\n\r\n")).toEqual([{ data: '{"x":1}' }]);
  });

  it("joins multi-line data and ignores comments", () => {
    const p = new SseParser();
    const events = p.push(": keep-alive\nevent: message\ndata: a\ndata: b\n\n");
    expect(events).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("flushes a trailing event on end()", () => {
    const p = new SseParser();
    expect(p.push("data: tail")).toEqual([]);
    expect(p.end()).toEqual([{ data: "tail" }]);
  });
});
