/**
 * Step 1: send the document to Mistral OCR.
 *
 * Following Mistral's annotation workflow, the OCR call returns the Markdown
 * text plus the extracted image bounding boxes (with their cropped images)
 * and paragraph-level blocks. The vision LLM steps use the text and the
 * bounding boxes; the UI overlays the boxes on the page images.
 */
import { ApiError } from "../http/apiError";
import type { MistralClient } from "../mistral/client";
import type { OcrRequest, OcrResponse } from "../mistral/types";
import { emit, type ProgressListener } from "./events";
import { buildOcrText, type OcrText } from "./ocrText";

/** API limits documented at https://docs.mistral.ai/capabilities/document_ai/basic_ocr */
export const OCR_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const OCR_MAX_PAGES = 1000;
/** Mistral's document annotation sends the first eight bounding boxes to the vision model; we do the same. */
export const DOCUMENT_ANNOTATION_MAX_IMAGES = 8;

export interface OcrInput {
  /** `data:<mime>;base64,...` of the PDF or image. */
  dataUrl: string;
  mimeType: string;
  fileName: string;
}

export interface RunOcrOptions {
  model: string;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

export interface OcrOutcome {
  /** Raw API response, including the bounding-box images (base64). */
  response: OcrResponse;
  text: OcrText;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export async function runOcr(client: MistralClient, input: OcrInput, options: RunOcrOptions): Promise<OcrOutcome> {
  const { onProgress } = options;
  emit(onProgress, "ocr", "start", `Sending ${input.fileName} to ${options.model}`);

  const request: OcrRequest = {
    model: options.model,
    document: isImageMime(input.mimeType)
      ? { type: "image_url", image_url: input.dataUrl }
      : { type: "document_url", document_url: input.dataUrl, document_name: input.fileName },
    // Bounding boxes with their images: the figures the vision model gets.
    include_image_base64: true,
    // Paragraph-level boxes for the bounding-box overview.
    include_blocks: true,
    extract_header: true,
    extract_footer: true,
    table_format: "markdown",
  };

  let response: OcrResponse;
  try {
    response = await client.ocr(request, options.signal);
  } catch (err) {
    // `include_blocks` is newer than the rest of the request; degrade gracefully if the API rejects it.
    if (err instanceof ApiError && err.kind === "request" && /include_blocks|blocks/i.test(err.message)) {
      emit(onProgress, "ocr", "warning", "The OCR API rejected block extraction; retrying without paragraph boxes", { detail: err.message });
      delete request.include_blocks;
      response = await client.ocr(request, options.signal);
    } else {
      throw err;
    }
  }

  const text = buildOcrText(response);
  const withImages = text.bboxes.filter((b) => b.dataUrl).length;
  emit(
    onProgress,
    "ocr",
    "done",
    `OCR finished: ${text.pagesProcessed} page(s), ${text.chars.toLocaleString()} characters, ${text.bboxes.length} bounding box(es)`,
    { detail: text.bboxes.length && withImages < text.bboxes.length ? `${withImages} of them came with an image` : undefined },
  );
  return { response, text };
}
