import { describe, expect, it } from "vitest";
import { MistralClient } from "../mistral/client";
import type { ProgressEvent } from "./events";
import { runOcr } from "./runOcr";

const input = { dataUrl: "data:application/pdf;base64,AA==", mimeType: "application/pdf", fileName: "a.pdf" };

function client(bodies: Record<string, unknown>[], rejectBlocks = false) {
  return new MistralClient({
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (rejectBlocks && body["include_blocks"]) {
        return new Response(JSON.stringify({ message: "Extra inputs are not permitted: include_blocks" }), { status: 422 });
      }
      return new Response(
        JSON.stringify({
          model: "mistral-ocr-latest",
          pages: [{ index: 0, markdown: "x ![f](img-0.jpeg)", images: [{ id: "img-0.jpeg", top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1, image_base64: "data:image/png;base64,AA" }], dimensions: { dpi: 200, width: 10, height: 10 } }],
          usage_info: { pages_processed: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
}

describe("runOcr", () => {
  it("requests bounding-box images and paragraph blocks, headers/footers extracted", async () => {
    const bodies: Record<string, unknown>[] = [];
    const out = await runOcr(client(bodies), input, { model: "mistral-ocr-latest" });
    expect(bodies[0]).toMatchObject({ include_image_base64: true, include_blocks: true, extract_header: true, extract_footer: true });
    expect(bodies[0]).not.toHaveProperty("document_annotation_format");
    expect(out.text.bboxes).toHaveLength(1);
    expect(out.text.bboxes[0]?.dataUrl).toBe("data:image/png;base64,AA");
  });

  it("retries without include_blocks when the API rejects it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: ProgressEvent[] = [];
    await runOcr(client(bodies, true), input, { model: "m", onProgress: (e) => events.push(e) });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("include_blocks");
    expect(events.some((e) => e.status === "warning")).toBe(true);
  });
});
