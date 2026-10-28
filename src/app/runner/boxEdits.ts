/**
 * "Edit bounding boxes": deleting and changing blocks at once; cutting
 * through text, making a block of a selection and reading a block again
 * send those areas to Mistral OCR (job "edit"). The edits are kept with the
 * OCR result (and in the OCR cache) and can be undone.
 */
import { getPageRenderer, PAGE_RENDER_WIDTH } from "@/lib/files/pageRenderCache";
import {
  applyCut,
  editableBlocks,
  emptyEdits,
  hasEdits,
  insertionIndex,
  newBlockId,
  newImageId,
  planCut,
  rectOf,
  withoutPage,
  withPage,
  type BlockEdits,
  type BoxEdit,
  type EditedBlock,
  type Rect,
} from "@/lib/pipeline/blockEdits";
import { emit } from "@/lib/pipeline/events";
import { ocrRegion } from "@/lib/pipeline/regionOcr";
import { getCachedOcr, putCachedOcr } from "@/lib/storage/ocrCache";
import { runPool } from "@/lib/util/pool";
import { beginJob, endJob } from "./jobs";
import type { Runtime } from "./runtime";

/**
 * Edit the boxes of the OCR result on screen. Deleting and changing blocks
 * happen at once; cutting through text, making a block of a selection and
 * reading a block again send those areas to Mistral OCR (job "edit"). The
 * edits are kept with the OCR result (and in the OCR cache) and can be
 * undone.
 */
export async function editBoxes(rt: Runtime, edit: BoxEdit): Promise<void> {
  const state = rt.getState();
  const ocr = state.ocr;
  const page = ocr?.text.pages.find((p) => p.index === edit.pageIndex);
  if (!ocr || !page || state.job) return;
  const blocks = editableBlocks(page);
  let edits = ocr.edits ?? emptyEdits();

  if (edit.kind === "delete") {
    const ids = new Set(edit.ids);
    return commitEdits(
      rt,
      withPage(
        edits,
        page.index,
        blocks.filter((b) => !ids.has(b.id)),
      ),
    );
  }
  if (edit.kind === "change") {
    const block = blocks.find((b) => b.id === edit.id);
    if (!block) return;
    let id = block.id;
    // Another text is another block: a translation of the old text no longer fits it.
    if (edit.content !== block.content) [id, edits] = newBlockId(edits, page.index);
    const changed = blocks.map((b) => (b.id === block.id ? { ...b, id, type: edit.type, content: edit.content } : b));
    return commitEdits(rt, withPage(edits, page.index, changed));
  }

  // The areas to read again: what is left of the text blocks a selection crosses, the selection itself, a block.
  const plan = edit.kind === "reread" ? null : planCut(blocks, edit.rect);
  if (edit.kind === "cut" && plan && !plan.removed.length && !plan.trimmed.length) return; // it touches no block
  const reads: Array<{ key: string; region: Rect; blank: Rect[] }> = [];
  for (const t of plan?.trimmed ?? []) if (t.reread) reads.push({ key: t.block.id, region: t.box, blank: [t.blank] });
  if (edit.kind === "make" && edit.type !== "image") reads.push({ key: "selection", region: edit.rect, blank: [] });
  if (edit.kind === "reread") {
    const block = blocks.find((b) => b.id === edit.id);
    if (!block) return;
    reads.push({ key: block.id, region: rectOf(block), blank: [] });
  }
  if (edit.kind === "cut" && plan && !reads.length) return commitEdits(rt, withPage(edits, page.index, applyCut(blocks, plan, new Map())));

  const doc = state.doc;
  if (!doc || doc.id !== ocr.docId || !page.width) {
    rt.dispatch({
      type: "error/set",
      error: { title: "The page is needed", message: "Load the document this OCR result was made from to read parts of its pages again." },
    });
    return;
  }
  const renderer = getPageRenderer(
    doc.id,
    doc.file,
    doc.kind === "image" ? "image" : "pdf",
    doc.kind === "image" ? (doc.previews[0] ?? null) : null,
    PAGE_RENDER_WIDTH,
  );
  const pageWidth = page.width;
  const job = beginJob(rt, "edit", ["region_ocr"], false);
  if (!job) return;
  const { ctx, controller } = job;
  try {
    const model = rt.getState().settings.ocrModel;
    const texts = new Map<string, string>();
    emit(
      ctx.onProgress,
      "region_ocr",
      "start",
      reads.length ? `Reading ${reads.length} area(s) of page ${page.index + 1} again with ${model}` : `Cutting the image out of page ${page.index + 1}`,
    );
    let done = 0;
    await runPool(reads, 3, async (r) => {
      const image = await renderer.region(page.index, pageWidth, r.region, r.blank);
      texts.set(r.key, await ocrRegion(ctx.ocr, model, image, controller.signal));
      emit(ctx.onProgress, "region_ocr", "progress", `Read ${++done} of ${reads.length} area(s)`);
    });
    controller.signal.throwIfAborted();
    // Another OCR result or other edits meanwhile: these would not fit them.
    if (rt.getState().ocr !== ocr) return endJob(rt, job);

    let next: EditedBlock[];
    if (edit.kind === "reread") {
      const content = texts.get(edit.id) ?? "";
      if (!content.trim()) throw new Error("Mistral OCR found no text in this block.");
      let id: string;
      [id, edits] = newBlockId(edits, page.index);
      next = blocks.map((b) => (b.id === edit.id ? { ...b, id, content } : b));
    } else {
      const reread = new Map<string, { id: string; content: string }>();
      for (const t of plan!.trimmed) {
        if (!t.reread) continue;
        let id: string;
        [id, edits] = newBlockId(edits, page.index);
        reread.set(t.block.id, { id, content: texts.get(t.block.id) ?? "" });
      }
      next = applyCut(blocks, plan!, reread);
      if (edit.kind === "make")
        [next, edits] = await addSelectionBlock(blocks, next, edits, edit, texts.get("selection") ?? "", () =>
          renderer.region(page.index, pageWidth, edit.rect, []),
        );
    }
    emit(ctx.onProgress, "region_ocr", "done", `Page ${page.index + 1} edited`);
    commitEdits(rt, withPage(edits, page.index, next));
    endJob(rt, job);
  } catch (err) {
    endJob(rt, job, err);
  }
}

/** "Make a block": the selection as a new block (its text read by OCR, or the area as an image), where the blocks it took from were. */
async function addSelectionBlock(
  before: EditedBlock[],
  after: EditedBlock[],
  edits: BlockEdits,
  edit: Extract<BoxEdit, { kind: "make" }>,
  text: string,
  image: () => Promise<string>,
): Promise<[EditedBlock[], BlockEdits]> {
  const { rect } = edit;
  const place = { top_left_x: rect.x0, top_left_y: rect.y0, bottom_right_x: rect.x1, bottom_right_y: rect.y1 };
  let id: string;
  [id, edits] = newBlockId(edits, edit.pageIndex);
  let block: EditedBlock;
  if (edit.type === "image") {
    let imageId: string;
    [imageId, edits] = newImageId(edits);
    edits = { ...edits, images: [...edits.images, { id: imageId, pageIndex: edit.pageIndex, box: rect, dataUrl: await image() }] };
    block = { id, type: "image", ...place, content: "", image_id: imageId };
  } else {
    if (!text.trim()) throw new Error("Mistral OCR found no text in the selection.");
    block = { id, type: edit.type, ...place, content: text };
  }
  // In reading order where the first block it took from was; else by its place on the page.
  const kept = new Set(after.map((b) => b.id));
  const first = before.findIndex((b) => {
    const r = rectOf(b);
    return r.x0 < rect.x1 && r.x1 > rect.x0 && r.y0 < rect.y1 && r.y1 > rect.y0;
  });
  const index = first >= 0 ? before.slice(0, first).filter((b) => kept.has(b.id)).length : insertionIndex(after, rect);
  return [[...after.slice(0, index), block, ...after.slice(index)], edits];
}

/** Put new block edits on screen (none left: the OCR as returned) and keep them with the cached OCR result. */
function commitEdits(rt: Runtime, edits: BlockEdits | null): void {
  rt.dispatch({ type: "ocr/edit", edits: hasEdits(edits) ? edits : null });
  void persistOcrEdits(rt);
}

/** Undo the last edit of the boxes. */
export function undoBoxEdit(rt: Runtime): void {
  const { ocr, job } = rt.getState();
  if (!ocr?.undo.length || job) return;
  rt.dispatch({ type: "ocr/undo" });
  void persistOcrEdits(rt);
}

/** Back to the OCR as returned: one page, or every page. */
export function resetBoxEdits(rt: Runtime, pageIndex?: number): void {
  const { ocr, job } = rt.getState();
  if (!ocr?.edits || job) return;
  commitEdits(rt, pageIndex === undefined ? null : withoutPage(ocr.edits, pageIndex));
}

async function persistOcrEdits(rt: Runtime): Promise<void> {
  const { ocr, settings } = rt.getState();
  if (!ocr?.cacheKey || !settings.cacheOcr) return;
  const entry = await getCachedOcr(ocr.cacheKey);
  const current = rt.getState().ocr;
  if (!entry || current?.fingerprint !== ocr.fingerprint) return;
  await putCachedOcr({ ...entry, edits: current.edits });
}
