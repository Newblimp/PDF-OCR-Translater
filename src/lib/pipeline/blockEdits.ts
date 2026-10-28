/**
 * Edits of the OCR's blocks ("Fix OCR"): the user deletes
 * blocks, cuts a rectangle out of them (margin line numbers, stamps over
 * text), makes a block of a rectangle, or changes a block's type or text.
 *
 * The OCR result stays as the API returned it; the edits are kept beside it
 * (and in the OCR cache) and applied on top (`applyEdits()`), so every view
 * and the translation read the edited text.
 *
 * Ids: the OCR's blocks keep the id of their position in the OCR result
 * (`blockId()`), so their translations stay valid; a new or changed block
 * gets a new id (`${page}:e${n}`) and is translated afresh.
 */
import type { OcrBlock } from "../mistral/types";
import { joinPages, pageBlockId, type OcrBbox, type OcrCleanPage, type OcrText, type PageBlock } from "./ocrText";

/** A rectangle in the pixel coordinates of the OCR's page image. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A block of an edited page, always with its id. */
export type EditedBlock = OcrBlock & { id: string };

/** An image made of a selection ("Make a block" as an image); it joins the images the OCR extracted. */
export interface EditedImage {
  id: string;
  pageIndex: number;
  box: Rect;
  dataUrl: string;
}

export interface BlockEdits {
  /** The blocks of the edited pages, by 0-based page index, in reading order; the other pages are as OCR'd. */
  pages: Record<number, EditedBlock[]>;
  images: EditedImage[];
  /** Next number for the ids of new blocks and images. */
  next: number;
}

/** An edit of the blocks of one page ("Fix OCR"; `runner.editBoxes()`); rectangles are in the OCR's page pixels. */
export type BoxEdit =
  | { kind: "delete"; pageIndex: number; ids: string[] }
  | { kind: "change"; pageIndex: number; id: string; type: string; content: string }
  | { kind: "cut"; pageIndex: number; rect: Rect }
  | { kind: "make"; pageIndex: number; rect: Rect; type: string }
  | { kind: "reread"; pageIndex: number; id: string };

/** Whether a block was made or changed by an edit (its id is not the OCR's). */
export function isEditedBlock(id: string): boolean {
  return /:e\d+$/.test(id);
}

export function emptyEdits(): BlockEdits {
  return { pages: {}, images: [], next: 1 };
}

export function hasEdits(edits: BlockEdits | null | undefined): edits is BlockEdits {
  return !!edits && (Object.keys(edits.pages).length > 0 || edits.images.length > 0);
}

/** Number of edited pages. */
export function editedPageCount(edits: BlockEdits | null | undefined): number {
  return edits ? Object.keys(edits.pages).length : 0;
}

/** A page's blocks with their ids (the page as shown: edited, or as OCR'd). */
export function editableBlocks(page: OcrCleanPage): EditedBlock[] {
  return page.blocks.map((b, i) => ({ ...b, id: pageBlockId(page, i) }));
}

// ---------------------------------------------------------------- geometry

export function rectOf(block: OcrBlock): Rect {
  return { x0: block.top_left_x, y0: block.top_left_y, x1: block.bottom_right_x, y1: block.bottom_right_y };
}

export function withRect<B extends OcrBlock>(block: B, r: Rect): B {
  return { ...block, top_left_x: r.x0, top_left_y: r.y0, bottom_right_x: r.x1, bottom_right_y: r.y1 };
}

/** A rectangle from two corners in any order, rounded to whole pixels and kept on the page. */
export function normaliseRect(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number): Rect {
  const clampX = (v: number) => Math.round(Math.min(width, Math.max(0, v)));
  const clampY = (v: number) => Math.round(Math.min(height, Math.max(0, v)));
  return { x0: clampX(Math.min(a.x, b.x)), y0: clampY(Math.min(a.y, b.y)), x1: clampX(Math.max(a.x, b.x)), y1: clampY(Math.max(a.y, b.y)) };
}

export function isEmptyRect(r: Rect): boolean {
  return r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1;
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return isEmptyRect(r) ? null : r;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

/**
 * What is left of `box` once `cut` is taken out, as a rectangle: narrower or
 * shorter when the cut runs across the whole box from one side, the box
 * itself when the cut lies inside it (its text is then read again with the
 * cut area blanked), null when nothing is left.
 */
export function subtractRect(box: Rect, cut: Rect): Rect | null {
  const overlap = intersection(box, cut);
  if (!overlap) return box;
  if (contains(cut, box)) return null;
  const r = { ...box };
  if (overlap.y0 <= box.y0 && overlap.y1 >= box.y1) {
    // The cut runs top to bottom: trim the side it touches.
    if (overlap.x0 <= box.x0) r.x0 = overlap.x1;
    else if (overlap.x1 >= box.x1) r.x1 = overlap.x0;
  } else if (overlap.x0 <= box.x0 && overlap.x1 >= box.x1) {
    if (overlap.y0 <= box.y0) r.y0 = overlap.y1;
    else if (overlap.y1 >= box.y1) r.y1 = overlap.y0;
  }
  return isEmptyRect(r) ? null : r;
}

/** The blocks a selection touches: the ones inside it, and the ones it only crosses. */
export function selectionBlocks(blocks: EditedBlock[], rect: Rect): { inside: EditedBlock[]; crossed: EditedBlock[] } {
  const inside: EditedBlock[] = [];
  const crossed: EditedBlock[] = [];
  for (const b of blocks) {
    const box = rectOf(b);
    if (!intersection(box, rect)) continue;
    (contains(rect, box) ? inside : crossed).push(b);
  }
  return { inside, crossed };
}

/** The block at a point (the smallest one, so a block inside another can be picked). */
export function blockAt(blocks: EditedBlock[], x: number, y: number): EditedBlock | null {
  let best: EditedBlock | null = null;
  let bestArea = Infinity;
  for (const b of blocks) {
    const r = rectOf(b);
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    const a = (r.x1 - r.x0) * (r.y1 - r.y0);
    if (a < bestArea) {
      best = b;
      bestArea = a;
    }
  }
  return best;
}

// --------------------------------------------------------------- operations

/** A new block id on a page, with the edits that count it. */
export function newBlockId(edits: BlockEdits, pageIndex: number): [string, BlockEdits] {
  return [`${pageIndex}:e${edits.next}`, { ...edits, next: edits.next + 1 }];
}

/** A new image id, with the edits that count it. */
export function newImageId(edits: BlockEdits): [string, BlockEdits] {
  return [`edit-img-${edits.next}`, { ...edits, next: edits.next + 1 }];
}

/** The edits with a page's blocks replaced. */
export function withPage(edits: BlockEdits, pageIndex: number, blocks: EditedBlock[]): BlockEdits {
  return { ...edits, pages: { ...edits.pages, [pageIndex]: blocks } };
}

/** The edits without a page's changes (and the images made on it). */
export function withoutPage(edits: BlockEdits, pageIndex: number): BlockEdits {
  const pages = { ...edits.pages };
  delete pages[pageIndex];
  return { ...edits, pages, images: edits.images.filter((i) => i.pageIndex !== pageIndex) };
}

/** Where a block made of `rect` goes in reading order: before the first block that starts below it (or level with it, to its right). */
export function insertionIndex(blocks: EditedBlock[], rect: Rect): number {
  const i = blocks.findIndex((b) => b.top_left_y > rect.y0 + 2 || (Math.abs(b.top_left_y - rect.y0) <= 2 && b.top_left_x > rect.x0));
  return i < 0 ? blocks.length : i;
}

export interface CutPlan {
  /** Blocks inside the selection: they go. */
  removed: string[];
  /** Blocks the selection crosses, with what is left of each; a text block's text is read again from that area, the cut blanked. */
  trimmed: Array<{ block: EditedBlock; box: Rect; blank: Rect; reread: boolean }>;
}

/** What cutting `rect` out of a page's blocks does to them. */
export function planCut(blocks: EditedBlock[], rect: Rect): CutPlan {
  const plan: CutPlan = { removed: [], trimmed: [] };
  for (const b of blocks) {
    const box = rectOf(b);
    const blank = intersection(box, rect);
    if (!blank) continue;
    const left = subtractRect(box, rect);
    if (!left) plan.removed.push(b.id);
    else plan.trimmed.push({ block: b, box: left, blank, reread: b.type !== "image" });
  }
  return plan;
}

/**
 * The page's blocks after a cut: the removed ones gone, the trimmed ones
 * with their new box and, for text, the text read again (`reread`, by old
 * id: the new id and content; an empty text drops the block).
 */
export function applyCut(blocks: EditedBlock[], plan: CutPlan, reread: ReadonlyMap<string, { id: string; content: string }>): EditedBlock[] {
  const removed = new Set(plan.removed);
  const trimmed = new Map(plan.trimmed.map((t) => [t.block.id, t]));
  const out: EditedBlock[] = [];
  for (const b of blocks) {
    if (removed.has(b.id)) continue;
    const t = trimmed.get(b.id);
    if (!t) {
      out.push(b);
      continue;
    }
    const again = reread.get(b.id);
    if (t.reread && again) {
      if (again.content.trim()) out.push({ ...withRect(b, t.box), id: again.id, content: again.content });
    } else if (!t.reread) {
      out.push(withRect(b, t.box));
    } else {
      out.push(b); // not read again (cancelled): left as it was
    }
  }
  return out;
}

// ----------------------------------------------------------------- applying

/**
 * Page Markdown rebuilt from its blocks (on an edited page): headers and
 * footers stay out, as the OCR API keeps them out of the page text; images
 * become the placeholders the model knows.
 */
export function blocksMarkdown(blocks: readonly PageBlock[]): string {
  return blocks
    .filter((b) => b.type !== "header" && b.type !== "footer")
    .map((b) => (b.type === "image" ? (b.image_id ? `[Image: ${b.image_id}]` : "") : (b.content ?? "").trim()))
    .filter(Boolean)
    .join("\n\n");
}

/** The OCR text with the edits applied: edited pages rebuilt from their blocks, the images updated. */
export function applyEdits(base: OcrText, edits: BlockEdits | null | undefined): OcrText {
  if (!hasEdits(edits)) return base;
  const pages = base.pages.map((p): OcrCleanPage => {
    const blocks = edits.pages[p.index];
    if (!blocks) return p;
    return { ...p, blocks, markdown: blocksMarkdown(blocks), imageCount: blocks.filter((b) => b.type === "image").length };
  });
  const byIndex = new Map(pages.map((p) => [p.index, p]));
  // On an edited page, an image stays while an image block shows it.
  const shown = (pageIndex: number, imageId: string) => {
    if (!edits.pages[pageIndex]) return true;
    return !!byIndex.get(pageIndex)?.blocks.some((b) => b.type === "image" && b.image_id === imageId);
  };
  const made: OcrBbox[] = edits.images.map((img) => ({
    id: img.id,
    pageIndex: img.pageIndex,
    ...img.box,
    pageWidth: byIndex.get(img.pageIndex)?.width ?? null,
    pageHeight: byIndex.get(img.pageIndex)?.height ?? null,
    dataUrl: img.dataUrl,
  }));
  const bboxes = [...base.bboxes, ...made].filter((b) => byIndex.has(b.pageIndex) && shown(b.pageIndex, b.id));
  bboxes.sort((a, b) => a.pageIndex - b.pageIndex || a.y0 - b.y0 || a.x0 - b.x0);
  const text = joinPages(pages);
  return { text, pages, bboxes, pagesProcessed: base.pagesProcessed, chars: text.length };
}
