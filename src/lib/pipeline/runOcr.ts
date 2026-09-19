/**
 * Step 1: send the document to Mistral OCR and clean the result.
 */
import type { MistralClient } from "../mistral/client";
import type { JsonSchemaObject, OcrRequest, OcrResponse } from "../mistral/types";
import { parseModelJson } from "../util/json";
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

export interface AnnotationOutcome {
  /** Parsed `document_annotation` (source language, shaped by the schema). */
  data: unknown;
  raw: string;
  /** Number of pages the annotation covered (the API caps this at OCR_ANNOTATION_MAX_PAGES). */
  pagesAnnotated: number;
  model: string;
}

export interface AnnotateOptions {
  model: string;
  schema: JsonSchemaObject;
  /** Total pages of the document, if known; longer documents are annotated on their first pages only. */
  pageCount?: number | null | undefined;
  prompt?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

/**
 * Ask Mistral OCR to extract the document into the given JSON Schema
 * ("document annotation"): the OCR model itself fills the fields, in the
 * source language, page images in hand. This is a second OCR call because
 * an inferred schema is only known after the text has been read once.
 */
export async function annotateWithOcr(client: MistralClient, input: OcrInput, options: AnnotateOptions): Promise<AnnotationOutcome> {
  const { onProgress } = options;
  const limited = (options.pageCount ?? 0) > OCR_ANNOTATION_MAX_PAGES;
  emit(
    onProgress,
    "annotate",
    "start",
    `Sending the JSON format to ${options.model} as document annotation${limited ? ` (first ${OCR_ANNOTATION_MAX_PAGES} of ${options.pageCount} pages)` : ""}`,
  );
  const request: OcrRequest = {
    model: options.model,
    document: isImageMime(input.mimeType)
      ? { type: "image_url", image_url: input.dataUrl }
      : { type: "document_url", document_url: input.dataUrl, document_name: input.fileName },
    include_image_base64: false,
    extract_header: true,
    extract_footer: true,
    table_format: "markdown",
    document_annotation_format: {
      type: "json_schema",
      json_schema: { name: "document_annotation", schema: options.schema, strict: true },
    },
    document_annotation_prompt: options.prompt ?? null,
  };
  if (limited) request.pages = Array.from({ length: OCR_ANNOTATION_MAX_PAGES }, (_, i) => i);

  const response = await client.ocr(request, options.signal);
  const raw = response.document_annotation ?? "";
  const parsed = parseModelJson(raw);
  if (!parsed.ok) throw new Error(`Mistral OCR returned no usable document annotation: ${parsed.error}`);
  const pagesAnnotated = response.usage_info?.pages_processed ?? response.pages.length;
  emit(onProgress, "annotate", "done", `Mistral OCR filled the JSON format from ${pagesAnnotated} page(s)`, {
    detail: limited ? `Only the first ${OCR_ANNOTATION_MAX_PAGES} pages can be annotated by the API` : undefined,
  });
  return { data: parsed.value, raw, pagesAnnotated, model: response.model };
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
