import { describe, expect, it } from "vitest";
import { MistralClient } from "../mistral/client";
import type { ProgressEvent } from "./events";
import { annotateWithOcr, OCR_ANNOTATION_MAX_PAGES, runOcr } from "./runOcr";

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
const input = { dataUrl: "data:application/pdf;base64,AA==", mimeType: "application/pdf", fileName: "a.pdf" };

function clientCapturing(bodies: Record<string, unknown>[], annotation: string | null) {
  return new MistralClient({
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const pages = ((body["pages"] as number[] | undefined) ?? [0]).map((i) => ({ index: i, markdown: `p${i}`, images: [], dimensions: null }));
      return new Response(
        JSON.stringify({ model: "mistral-ocr-latest", pages, usage_info: { pages_processed: pages.length }, document_annotation: annotation }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
}

describe("runOcr", () => {
  it("sends no annotation schema by default", async () => {
    const bodies: Record<string, unknown>[] = [];
    await runOcr(clientCapturing(bodies, null), input, { model: "mistral-ocr-latest" });
    expect(bodies[0]).not.toHaveProperty("document_annotation_format");
    expect(bodies[0]).toMatchObject({ extract_header: true, extract_footer: true, include_image_base64: false });
  });
});

describe("annotateWithOcr", () => {
  it("sends the schema as strict json_schema document annotation and parses the result", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: ProgressEvent[] = [];
    const out = await annotateWithOcr(clientCapturing(bodies, '{"title":"标题"}'), input, {
      model: "mistral-ocr-latest",
      schema,
      pageCount: 3,
      prompt: "extract",
      onProgress: (e) => events.push(e),
    });
    expect(bodies[0]).toMatchObject({
      document_annotation_format: { type: "json_schema", json_schema: { name: "document_annotation", strict: true, schema } },
      document_annotation_prompt: "extract",
    });
    expect(bodies[0]).not.toHaveProperty("pages");
    expect(out.data).toEqual({ title: "标题" });
    expect(out.pagesAnnotated).toBe(1);
    expect(events.map((e) => `${e.stage}:${e.status}`)).toEqual(["annotate:start", "annotate:done"]);
  });

  it("limits long documents to the first pages the API can annotate", async () => {
    const bodies: Record<string, unknown>[] = [];
    await annotateWithOcr(clientCapturing(bodies, '{"title":"t"}'), input, { model: "m", schema, pageCount: 30 });
    expect(bodies[0]!["pages"]).toEqual(Array.from({ length: OCR_ANNOTATION_MAX_PAGES }, (_, i) => i));
  });

  it("fails clearly when the API returns no annotation", async () => {
    await expect(annotateWithOcr(clientCapturing([], null), input, { model: "m", schema })).rejects.toThrow(/no usable document annotation/);
  });
});
