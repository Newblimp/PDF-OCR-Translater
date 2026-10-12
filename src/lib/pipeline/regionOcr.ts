/**
 * "Edit bounding boxes": an area of a page read again with Mistral OCR. The
 * area goes as a PNG rendered in the browser (the parts cut away blanked),
 * to api.mistral.ai like the document itself, and its Markdown becomes the
 * block's text.
 */
import type { OcrClient } from "../mistral/client";
import { normaliseWhitespace, replaceImageReferences } from "./ocrText";

export async function ocrRegion(client: OcrClient, model: string, dataUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await client.ocr({ model, document: { type: "image_url", image_url: dataUrl } }, signal);
  const text = response.pages.map((p) => replaceImageReferences(p.markdown ?? "").text).join("\n\n");
  // Images found inside the area are not among the document's extracted images: their placeholders go.
  return normaliseWhitespace(text.replace(/\[Image: [^\]]*\]/g, ""));
}
