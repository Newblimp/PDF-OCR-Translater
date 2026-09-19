import { describe, expect, it } from "vitest";
import { countSchemaFields, findSchemaViolations, sanitizeSchema } from "./schema";
import { PATENT_COMMUNICATION_SCHEMA } from "./schemas/patentCommunication";

describe("sanitizeSchema", () => {
  it("makes every property required and forbids additional properties", () => {
    const { schema, warnings } = sanitizeSchema({
      type: "object",
      properties: {
        title: { type: "string", description: "Title", format: "x" },
        items: { type: "array", items: { type: "object", properties: { a: { type: "number" } } } },
        flags: { type: "array" },
      },
      required: ["title"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", description: "Title" },
        items: {
          type: "array",
          items: { type: "object", properties: { a: { type: "number" } }, required: ["a"], additionalProperties: false },
        },
        flags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "items", "flags"],
      additionalProperties: false,
    });
    expect(warnings).toEqual([]);
  });

  it("unwraps json_schema envelopes and wraps non-object roots", () => {
    const wrapped = sanitizeSchema({ json_schema: { name: "x", schema: { type: "object", properties: { a: { type: "string" } } } } });
    expect(Object.keys(wrapped.schema["properties"] as object)).toEqual(["a"]);
    const arr = sanitizeSchema({ type: "array", items: { type: "string" } });
    expect(arr.schema["type"]).toBe("object");
    expect(Object.keys(arr.schema["properties"] as object)).toEqual(["content"]);
  });

  it("renames unsafe keys, drops unknown types and nullable unions", () => {
    const { schema, warnings } = sanitizeSchema({
      type: "object",
      properties: { "申请号 (no)": { type: ["string", "null"] }, weird: { type: "date" }, "1st": { type: "boolean" } },
    });
    const props = schema["properties"] as Record<string, { type: string }>;
    expect(Object.keys(props)).toEqual(["no", "weird", "f_1st"]);
    expect(props["no"]?.type).toBe("string");
    expect(props["weird"]?.type).toBe("string");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("keeps the built-in schema unchanged", () => {
    const { schema, warnings } = sanitizeSchema(PATENT_COMMUNICATION_SCHEMA);
    expect(warnings).toEqual([]);
    expect(countSchemaFields(schema)).toBe(countSchemaFields(PATENT_COMMUNICATION_SCHEMA));
  });
});

describe("findSchemaViolations", () => {
  it("reports missing keys and wrong types", () => {
    const schema = sanitizeSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "array", items: { type: "number" } } },
    }).schema;
    expect(findSchemaViolations({ a: "x", b: [1, "2"] }, schema)).toEqual(["$.b[1]: expected number"]);
    expect(findSchemaViolations({ b: [] }, schema)).toEqual(["$.a: missing"]);
  });
});
