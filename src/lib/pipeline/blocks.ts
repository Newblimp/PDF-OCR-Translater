/**
 * The OCR text as blocks (paragraphs, titles, tables, images, headers, ...):
 * what the OCR text view shows and filters, by block type and one by one,
 * and what is translated block by block when the JSON format is off.
 *
 * Text input has no OCR blocks: `textPages()` splits it into paragraph
 * blocks (without positions) so it goes through the same path.
 */
import type { OcrBlock } from "../mistral/types";
import { blockId } from "./blockTranslate";
import { pageDelimiter, type OcrCleanPage, type OcrText } from "./ocrText";

export interface ViewBlock {
  id: string;
  /** Block type from the OCR API: "text", "title", "table", "image", "header", "footer", "caption", ... */
  type: string;
  /** Original text (Markdown); empty for image blocks. */
  text: string;
  /** For image blocks: the id of the extracted image (`OcrText.bboxes`). */
  imageId: string | null;
  /** Pixel box in the page image; null when unknown (text input, a page without blocks). */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Stand-in for a page the OCR API returned no blocks for: its whole Markdown, which has no block translation. */
  wholePage: boolean;
}

/** What is left out of the text: whole block types (a setting) and single blocks (picked on the page). */
export interface BlockFilter {
  hiddenTypes: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
}

/** Order of the type filters; types the app does not know follow alphabetically. */
const TYPE_ORDER = ["title", "text", "list", "table", "caption", "equation", "code", "references", "aside_text", "signature", "image", "header", "footer"];

const IMAGE_PLACEHOLDER = /^\[Image: ([^\]]+)\]$/;
const MARKDOWN_IMAGE = /^!\[[^\]]*]\(([^)]*)\)$/;

function boxOf(block: OcrBlock): ViewBlock["box"] {
  const { top_left_x: x0, top_left_y: y0, bottom_right_x: x1, bottom_right_y: y1 } = block;
  return [x0, y0, x1, y1].every(Number.isFinite) && x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** The blocks of a page in reading order (the OCR API's order); a page without blocks is one stand-in block. */
export function pageBlocks(page: OcrCleanPage): ViewBlock[] {
  if (!page.blocks.length) {
    return page.markdown.trim() ? [{ id: `${page.index}:page`, type: "text", text: page.markdown, imageId: null, box: null, wholePage: true }] : [];
  }
  const out: ViewBlock[] = [];
  page.blocks.forEach((block, i) => {
    const type = block.type || "text";
    const text = block.content?.trim() ?? "";
    if (type === "image") {
      const imageId = block.image_id || MARKDOWN_IMAGE.exec(text)?.[1] || IMAGE_PLACEHOLDER.exec(text)?.[1] || null;
      out.push({ id: blockId(page.index, i), type, text: "", imageId, box: boxOf(block), wholePage: false });
    } else if (text) {
      out.push({ id: blockId(page.index, i), type, text, imageId: null, box: boxOf(block), wholePage: false });
    }
  });
  return out;
}

export function isShown(block: Pick<ViewBlock, "id" | "type">, filter: BlockFilter): boolean {
  return !filter.hiddenTypes.has(block.type) && !filter.excluded.has(block.id);
}

/** Ids of the text blocks (the ones that get a translation) the filter keeps. */
export function shownTextBlockIds(pages: readonly OcrCleanPage[], filter: BlockFilter): Set<string> {
  const ids = new Set<string>();
  for (const page of pages) {
    // The same blocks as `textBlocks()`: every non-image block with text.
    for (const b of pageBlocks(page)) if (b.type !== "image" && !b.wholePage && isShown(b, filter)) ids.add(b.id);
  }
  return ids;
}

/** Block types present in the pages with their counts, in a stable order for the filters. */
export function blockTypeCounts(pages: readonly OcrCleanPage[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const page of pages) for (const b of pageBlocks(page)) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  const rank = (t: string) => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length);
  return Array.from(counts, ([type, count]) => ({ type, count })).sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type));
}

/**
 * The text the filter keeps, original or translated (blocks without a
 * translation keep their original text), for copying and downloading. Pages
 * are separated by the delimiters the model sees when there are several.
 */
export function filteredText(pages: readonly OcrCleanPage[], filter: BlockFilter, translations: Record<string, string> | null): string {
  const bodies = pages.map((page) => {
    const parts = pageBlocks(page)
      .filter((b) => isShown(b, filter))
      .map((b) => (b.type === "image" ? `[Image: ${b.imageId ?? "image"}]` : (translations?.[b.id]?.trim() ?? "") || b.text));
    return { page, body: parts.join("\n\n") };
  });
  if (bodies.length === 1) return bodies[0]!.body;
  return bodies.map(({ page, body }) => `${pageDelimiter(page.index + 1)}\n\n${body}`.trimEnd()).join("\n\n");
}

// ---------------------------------------------------------------- text input

const DELIMITER_LINE = /^----- Page (\d+) -----$/;

/** Paragraphs of Markdown: separated by blank lines, a fenced code block kept whole. */
function paragraphs(markdown: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  return out;
}

function paragraphBlock(text: string): OcrBlock {
  const position = { top_left_x: 0, top_left_y: 0, bottom_right_x: 0, bottom_right_y: 0 };
  const image = IMAGE_PLACEHOLDER.exec(text);
  if (image) return { type: "image", ...position, content: "", image_id: image[1]! };
  const lines = text.split("\n");
  const type = /^#{1,6}\s/.test(text)
    ? "title"
    : lines.every((l) => l.trim().startsWith("|"))
      ? "table"
      : /^(```|~~~)/.test(text)
        ? "code"
        : /^([-*+]|\d+[.)])\s/.test(text)
          ? "list"
          : "text";
  return { type, ...position, content: text };
}

/**
 * Text input (pasted, a text file, or a saved OCR text) as pages of
 * paragraph blocks without positions. The page delimiters of an OCR text
 * start new pages.
 */
export function textPages(text: string): OcrCleanPage[] {
  const pages: Array<{ index: number; lines: string[] }> = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const delimiter = DELIMITER_LINE.exec(line.trim());
    if (delimiter) {
      const last = pages.at(-1)?.index ?? -1;
      pages.push({ index: Math.max(Number(delimiter[1]) - 1, last + 1), lines: [] });
      continue;
    }
    if (!pages.length) pages.push({ index: 0, lines: [] });
    pages.at(-1)!.lines.push(line);
  }
  return pages.map(({ index, lines }) => {
    const markdown = lines.join("\n").trim();
    return { index, markdown, header: null, footer: null, imageCount: 0, width: null, height: null, blocks: paragraphs(markdown).map(paragraphBlock) };
  });
}

/** An `OcrText` for pages that have no OCR result behind them (text input, a saved translation). */
export function ocrTextFromPages(text: string, pages: OcrCleanPage[]): OcrText {
  return { text, pages, bboxes: [], pagesProcessed: pages.length, chars: text.length };
}
