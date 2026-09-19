/**
 * Turns a raw OCR response into what the later steps need:
 *   - the plain Markdown text for the vision model (headers and footers are
 *     already separated by the API; image references become `[Image: id]`
 *     placeholders that match the ids of the attached bounding-box images);
 *   - the list of extracted bounding boxes (figures) with coordinates and,
 *     when the API returned them, the cropped images.
 */
import type { OcrBlock, OcrResponse } from "../mistral/types";

export interface OcrCleanPage {
  /** 0-based page index as reported by the API. */
  index: number;
  /** Page Markdown with image references turned into placeholders. */
  markdown: string;
  header: string | null;
  footer: string | null;
  imageCount: number;
  /** Pixel size of the page image the coordinates refer to. */
  width: number | null;
  height: number | null;
  blocks: OcrBlock[];
}

/** One bounding box extracted by the OCR model (a figure, chart, stamp, ...). */
export interface OcrBbox {
  id: string;
  pageIndex: number;
  /** Pixel coordinates in the page image. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pageWidth: number | null;
  pageHeight: number | null;
  /** `data:image/...;base64,...` when `include_image_base64` was requested. */
  dataUrl: string | null;
}

export interface OcrText {
  /** Full text sent to the vision model. */
  text: string;
  pages: OcrCleanPage[];
  bboxes: OcrBbox[];
  /** Number of pages the API billed. */
  pagesProcessed: number;
  /** Total characters of `text`. */
  chars: number;
}

/** Delimiter placed between pages. Referenced in the prompts. */
export function pageDelimiter(pageNumber: number): string {
  return `----- Page ${pageNumber} -----`;
}

const MARKDOWN_IMAGE = /!\[([^\]]*)]\(([^)]*)\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;

/**
 * Replace image references with `[Image: id]` placeholders (the id is what
 * the OCR API uses for the bounding box) and tidy blank lines.
 */
export function replaceImageReferences(markdown: string): { text: string; count: number } {
  let count = 0;
  let text = markdown.replace(MARKDOWN_IMAGE, (_m, alt: string, src: string) => {
    count++;
    return `[Image: ${src || alt || `image-${count}`}]`;
  });
  text = text.replace(HTML_IMAGE, (tag) => {
    count++;
    const src = /src="([^"]*)"/i.exec(tag)?.[1];
    return `[Image: ${src || `image-${count}`}]`;
  });
  return { text: normaliseWhitespace(text), count };
}

export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ensure a base64 payload from the API is a usable data URL. */
export function toImageDataUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("data:")) return value;
  const mime = value.startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${value}`;
}

export function buildOcrText(response: OcrResponse): OcrText {
  const pages: OcrCleanPage[] = [];
  const bboxes: OcrBbox[] = [];
  for (const page of response.pages) {
    const { text, count } = replaceImageReferences(page.markdown ?? "");
    const width = page.dimensions?.width ?? null;
    const height = page.dimensions?.height ?? null;
    pages.push({
      index: page.index,
      markdown: text,
      header: page.header?.trim() || null,
      footer: page.footer?.trim() || null,
      imageCount: count,
      width,
      height,
      blocks: Array.isArray(page.blocks) ? page.blocks : [],
    });
    for (const image of page.images ?? []) {
      if (image.top_left_x === null || image.top_left_y === null || image.bottom_right_x === null || image.bottom_right_y === null) continue;
      bboxes.push({
        id: image.id,
        pageIndex: page.index,
        x0: image.top_left_x,
        y0: image.top_left_y,
        x1: image.bottom_right_x,
        y1: image.bottom_right_y,
        pageWidth: width,
        pageHeight: height,
        dataUrl: toImageDataUrl(image.image_base64),
      });
    }
  }
  pages.sort((a, b) => a.index - b.index);
  bboxes.sort((a, b) => a.pageIndex - b.pageIndex || a.y0 - b.y0 || a.x0 - b.x0);

  const text =
    pages.length === 1
      ? (pages[0]?.markdown ?? "")
      : pages.map((p) => `${pageDelimiter(p.index + 1)}\n\n${p.markdown}`).join("\n\n");

  return {
    text,
    pages,
    bboxes,
    pagesProcessed: response.usage_info?.pages_processed ?? pages.length,
    chars: text.length,
  };
}
