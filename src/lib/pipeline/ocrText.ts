/**
 * Turns a raw OCR response into the plain text that is sent for translation.
 *
 * Requirements from the product brief: headers, footers and images must not
 * be part of the translated content. Headers/footers are separated by the
 * API itself (`extract_header` / `extract_footer`); this module drops image
 * references from the Markdown and joins the pages with clear delimiters.
 */
import type { OcrResponse } from "../mistral/types";

export interface OcrCleanPage {
  /** 0-based page index as reported by the API. */
  index: number;
  /** Page Markdown without images and with whitespace normalised. */
  markdown: string;
  header: string | null;
  footer: string | null;
  imagesRemoved: number;
}

export interface OcrText {
  /** Full text sent to the translation model. */
  text: string;
  pages: OcrCleanPage[];
  /** Number of pages the API billed. */
  pagesProcessed: number;
  imagesRemoved: number;
  /** Total characters of `text`. */
  chars: number;
}

/** Delimiter placed between pages. Referenced in the translation prompt. */
export function pageDelimiter(pageNumber: number): string {
  return `----- Page ${pageNumber} -----`;
}

const MARKDOWN_IMAGE = /!\[[^\]]*]\([^)]*\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;

/** Remove image references from a Markdown string and tidy blank lines. */
export function stripImages(markdown: string): { text: string; removed: number } {
  let removed = 0;
  let text = markdown.replace(MARKDOWN_IMAGE, () => {
    removed++;
    return "";
  });
  text = text.replace(HTML_IMAGE, () => {
    removed++;
    return "";
  });
  return { text: normaliseWhitespace(text), removed };
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

export function buildOcrText(response: OcrResponse): OcrText {
  const pages: OcrCleanPage[] = [];
  let imagesRemoved = 0;
  for (const page of response.pages) {
    const { text, removed } = stripImages(page.markdown ?? "");
    imagesRemoved += removed;
    pages.push({
      index: page.index,
      markdown: text,
      header: page.header?.trim() || null,
      footer: page.footer?.trim() || null,
      imagesRemoved: removed,
    });
  }
  pages.sort((a, b) => a.index - b.index);

  const text =
    pages.length === 1
      ? (pages[0]?.markdown ?? "")
      : pages.map((p) => `${pageDelimiter(p.index + 1)}\n\n${p.markdown}`).join("\n\n");

  return {
    text,
    pages,
    pagesProcessed: response.usage_info?.pages_processed ?? pages.length,
    imagesRemoved,
    chars: text.length,
  };
}
