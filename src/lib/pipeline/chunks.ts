/**
 * Long documents are translated in parts so that each request stays well
 * below the output limit (64k tokens by default on Anthropic) and below the
 * prompt size where some prices step up (Claude Haiku 5.5 charges 5× more
 * for prompts over 100k tokens). Parts follow page boundaries when the OCR
 * pages are known, and paragraph boundaries otherwise; each part fills the
 * same JSON format and the results are merged field by field.
 */
import { isPlainObject } from "../util/json";
import { estimateTokens } from "../util/text";
import { pageDelimiter, type OcrText } from "./ocrText";

/** Estimated tokens of document text per request. Output is roughly as long as the input, so this leaves room under a 64k output limit. */
export const TRANSLATION_CHUNK_TOKENS = 40_000;

export interface DocumentChunk {
  text: string;
  /** OCR page indices (0-based) the chunk covers; null for text input. */
  pageIndices: number[] | null;
  /** e.g. "pages 3-5"; undefined for a single-part document. */
  label?: string | undefined;
}

/** Split the document into parts of at most `maxTokens` estimated tokens (a single oversized page or paragraph stays whole). */
export function splitDocument(text: string, ocr: OcrText | undefined, maxTokens = TRANSLATION_CHUNK_TOKENS): DocumentChunk[] {
  if (estimateTokens(text) <= maxTokens) return [{ text, pageIndices: ocr ? ocr.pages.map((p) => p.index) : null }];
  if (ocr && ocr.pages.length > 1) return splitPages(ocr, maxTokens);
  return splitParagraphs(text, maxTokens);
}

function splitPages(ocr: OcrText, maxTokens: number): DocumentChunk[] {
  const groups: Array<OcrText["pages"]> = [];
  let group: OcrText["pages"] = [];
  let tokens = 0;
  for (const page of ocr.pages) {
    const pageTokens = estimateTokens(page.markdown);
    if (group.length && tokens + pageTokens > maxTokens) {
      groups.push(group);
      group = [];
      tokens = 0;
    }
    group.push(page);
    tokens += pageTokens;
  }
  if (group.length) groups.push(group);
  return groups.map((pages) => {
    const first = pages[0]!.index + 1;
    const last = pages.at(-1)!.index + 1;
    return {
      text: pages.map((p) => `${pageDelimiter(p.index + 1)}\n\n${p.markdown}`).join("\n\n"),
      pageIndices: pages.map((p) => p.index),
      label: first === last ? `page ${first}` : `pages ${first}-${last}`,
    };
  });
}

function splitParagraphs(text: string, maxTokens: number): DocumentChunk[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const paragraph of text.split(/\n{2,}/)) {
    const paragraphTokens = estimateTokens(paragraph);
    if (current.length && tokens + paragraphTokens > maxTokens) {
      chunks.push(current.join("\n\n"));
      current = [];
      tokens = 0;
    }
    current.push(paragraph);
    tokens += paragraphTokens;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks.map((chunk, i) => ({ text: chunk, pageIndices: null, label: `section ${i + 1} of ${chunks.length}` }));
}

/**
 * Merge the JSON of two consecutive parts: objects key by key, arrays
 * concatenated, strings joined (an empty or repeated value is kept once),
 * numbers and booleans from the first part unless it left them empty.
 */
export function mergeStructured(a: unknown, b: unknown): unknown {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = key in a ? mergeStructured(a[key], value) : value;
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a === "string" && typeof b === "string") {
    const left = a.trim();
    const right = b.trim();
    if (!right || left === right) return a;
    if (!left) return b;
    return `${left}\n\n${right}`;
  }
  if (typeof a === "number") return a !== 0 ? a : b;
  if (typeof a === "boolean") return a || b === true;
  return a;
}
