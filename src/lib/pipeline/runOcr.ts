/**
 * Step 1: send the document to Mistral OCR and clean the result.
 */
import type { MistralClient } from "../mistral/client";
import type { OcrRequest, OcrResponse } from "../mistral/types";
import { emit, type ProgressListener } from "./events";
import { buildOcrText, type OcrText } from "./ocrText";

/** API limits documented at https://docs.mistral.ai/capabilities/document_ai/basic_ocr */
export const OCR_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const OCR_MAX_PAGES = 1000;
/** Document annotation (`document_annotation_format`) is only applied to documents of up to this many pages. */
export const OCR_ANNOTATION_MAX_PAGES = 8;

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
  /**
   * Optional structured extraction performed by the OCR model itself
   * (Mistral "document annotation"). Unused by the default flows; kept as an
   * extension point. Ignored by the API for documents longer than 8 pages.
   */
  documentAnnotation?: { schema: OcrRequest["document_annotation_format"]; prompt?: string };
}

export interface OcrOutcome {
  /** Raw API response minus image payloads (kept small for caching). */
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
    include_image_base64: false,
    extract_header: true,
    extract_footer: true,
    table_format: "markdown",
  };
  if (options.documentAnnotation?.schema) {
    request.document_annotation_format = options.documentAnnotation.schema;
    if (options.documentAnnotation.prompt) request.document_annotation_prompt = options.documentAnnotation.prompt;
  }

  const response = await client.ocr(request, options.signal);
  // Drop any image payloads defensively; they are never shown or translated.
  for (const page of response.pages) {
    page.images = (page.images ?? []).map((img) => ({ ...img, image_base64: null }));
  }
  const text = buildOcrText(response);
  emit(onProgress, "ocr", "done", `OCR finished: ${text.pagesProcessed} page(s), ${text.chars.toLocaleString()} characters`, {
    detail: text.imagesRemoved ? `${text.imagesRemoved} image reference(s) removed` : undefined,
  });
  return { response, text };
}
