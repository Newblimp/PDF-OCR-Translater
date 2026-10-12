import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DocState, OcrState } from "@/app/store";
import {
  blockAt,
  editableBlocks,
  isEditedBlock,
  isEmptyRect,
  normaliseRect,
  rectOf,
  selectionBlocks,
  type BoxEdit,
  type EditedBlock,
  type Rect,
} from "@/lib/pipeline/blockEdits";
import { blockColor, blockTypeLabel, boxStyle } from "./blockColors";
import { usePageFirst, usePageRenderer, useRenderedPages } from "./pageImages";
import { PageNav } from "./PageNav";

/** Block types a selection can be made into (the OCR API's labels). */
const BLOCK_TYPES = ["text", "title", "list", "table", "caption", "equation", "code", "references", "aside_text", "signature", "header", "footer", "image"];

/** A drag shorter than this (screen px) is a click. */
const CLICK_SLOP = 4;

type Selection = { kind: "rect"; rect: Rect } | { kind: "block"; id: string } | null;

interface Props {
  doc: DocState | null;
  ocr: OcrState;
  busy: boolean;
  onEdit: (edit: BoxEdit) => void;
  onUndo: () => void;
  onReset: (pageIndex?: number) => void;
}

/**
 * "Edit bounding boxes": the OCR's blocks over the page. Drag a rectangle
 * (like a rectangular marquee) or click a block to select it, then cut the
 * area out of the blocks, make a block of it, delete blocks, or change a
 * block's type or text. The edits apply to every view and to the
 * translation (`blockEdits.ts`, `runner.editBoxes()`).
 */
export const EditBoxesView = memo(function EditBoxesView({ doc, ocr, busy, onEdit, onUndo, onReset }: Props) {
  const pages = ocr.text.pages;
  const [position, setPosition] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; current: { x: number; y: number }; screen: { x: number; y: number } } | null>(null);
  const [makeType, setMakeType] = useState("text");
  const layer = useRef<HTMLDivElement>(null);

  const page = pages[Math.min(position, pages.length - 1)];
  const pageIndex = page?.index ?? 0;
  const width = page?.width ?? null;
  const height = page?.height ?? null;
  const blocks = useMemo(() => (page ? editableBlocks(page) : []), [page]);
  const pageEdited = !!ocr.edits?.pages[pageIndex];
  // The pages can be shown, and read again, while the document this OCR result was made from is loaded.
  const pagesAvailable = !!doc && doc.id === ocr.docId && (doc.kind === "pdf" || doc.kind === "image");
  const renderer = usePageRenderer(pagesAvailable ? doc : null);
  const indexes = useMemo(() => pages.map((p) => p.index), [pages]);
  const rendered = useRenderedPages(renderer, indexes);
  const renderError = usePageFirst(renderer, pageIndex, !!rendered[pageIndex]);

  // A selection belongs to its page and to the blocks as they were.
  useEffect(() => setSelection(null), [pageIndex, ocr.text]);
  useEffect(() => setPosition((p) => Math.min(p, Math.max(0, pages.length - 1))), [pages.length]);

  if (!page) return <p class="muted">No pages.</p>;
  if (!width || !height) {
    return (
      <div class="tab-panel">
        <p class="muted">The OCR API returned no page size for this page, so its boxes cannot be edited.</p>
      </div>
    );
  }

  const toPage = (e: PointerEvent) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
  };
  const onPointerDown = (e: PointerEvent) => {
    if (busy || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPage(e);
    setDrag({ start: p, current: p, screen: { x: e.clientX, y: e.clientY } });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (drag) setDrag({ ...drag, current: toPage(e) });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return;
    const end = toPage(e);
    const moved = Math.hypot(e.clientX - drag.screen.x, e.clientY - drag.screen.y) > CLICK_SLOP;
    setDrag(null);
    if (moved) {
      const rect = normaliseRect(drag.start, end, width, height);
      setSelection(isEmptyRect(rect) ? null : { kind: "rect", rect });
    } else {
      const hit = blockAt(blocks, end.x, end.y);
      setSelection(hit ? { kind: "block", id: hit.id } : null);
    }
  };

  const marquee = drag ? normaliseRect(drag.start, drag.current, width, height) : selection?.kind === "rect" ? selection.rect : null;
  const touched = marquee ? selectionBlocks(blocks, marquee) : { inside: [], crossed: [] };
  const insideIds = new Set(touched.inside.map((b) => b.id));
  const crossedIds = new Set(touched.crossed.map((b) => b.id));
  const selectedBlock = selection?.kind === "block" ? (blocks.find((b) => b.id === selection.id) ?? null) : null;
  const crossesText = touched.crossed.some((b) => b.type !== "image");

  const run = (edit: BoxEdit) => {
    setSelection(null);
    onEdit(edit);
  };
  const deleteSelected = () => {
    if (selectedBlock) run({ kind: "delete", pageIndex, ids: [selectedBlock.id] });
    else if (selection?.kind === "rect" && (touched.inside.length || touched.crossed.length))
      run({ kind: "delete", pageIndex, ids: [...touched.inside, ...touched.crossed].map((b) => b.id) });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (busy || target.closest("textarea, input, select")) return;
    if (e.key === "Escape") setSelection(null);
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      onUndo();
    }
  };

  const image = rendered[pageIndex];
  const editedPages = Object.keys(ocr.edits?.pages ?? {}).length;

  return (
    <div class="tab-panel edit-boxes" tabIndex={0} onKeyDown={onKeyDown} aria-label="Edit bounding boxes">
      <div class="toolbar">
        <div class="btn-row">
          <PageNav position={position} count={pages.length} onMove={setPosition}>
            Page {pageIndex + 1} · {position + 1} of {pages.length} OCR'd page(s) · {blocks.length} block(s)
            {pageEdited ? " · edited" : ""}
          </PageNav>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost small" disabled={busy || !ocr.undo.length} onClick={onUndo} title="Undo the last edit (Ctrl+Z)">
            Undo
          </button>
          <button type="button" class="btn btn-ghost small" disabled={busy || !pageEdited} onClick={() => onReset(pageIndex)}>
            Reset this page
          </button>
          <button type="button" class="btn btn-ghost small" disabled={busy || !ocr.edits} onClick={() => onReset()}>
            Reset all edits{editedPages ? ` (${editedPages} page(s))` : ""}
          </button>
        </div>
      </div>
      <p class="muted small">
        Drag on the page to select an area, or click a block. Delete removes the selected blocks, Esc clears the selection, Ctrl+Z undoes. The edits apply to
        the OCR text and to the next translation; blocks they change are translated anew.
      </p>

      <div class="bbox-layout">
        <div>
          <div class="edit-stage" style={image ? "" : `width:100%;aspect-ratio:${width}/${height}`}>
            {image ? (
              <img src={image} alt={`Page ${pageIndex + 1}`} draggable={false} />
            ) : (
              <div class="bbox-stage-placeholder">
                {!pagesAvailable
                  ? "Load the document to see the page under its boxes."
                  : renderError
                    ? `Page could not be rendered: ${renderError}`
                    : "Rendering page…"}
              </div>
            )}
            <div
              class={`edit-layer${busy ? " is-busy" : ""}`}
              ref={layer}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              aria-label={`Blocks on page ${pageIndex + 1}`}
            >
              {blocks.map((b) => {
                const state = selectedBlock?.id === b.id ? " is-selected" : insideIds.has(b.id) ? " is-inside" : crossedIds.has(b.id) ? " is-crossed" : "";
                return (
                  <div
                    key={b.id}
                    class={`edit-box${state}${isEditedBlock(b.id) ? " is-edited" : ""}`}
                    style={boxStyle(rectOf(b), width, height, blockColor(b.type))}
                    data-block={b.id}
                    data-type={b.type}
                    title={`${blockTypeLabel(b.type)}: ${b.content.slice(0, 80)}`}
                  />
                );
              })}
              {marquee && !isEmptyRect(marquee) && <div class="edit-marquee" style={boxStyle(marquee, width, height)} />}
            </div>
          </div>
        </div>

        <aside class="card bbox-detail edit-detail">
          {selection?.kind === "rect" ? (
            <div class="edit-actions">
              <h3>Selection</h3>
              <p class="muted small">
                {Math.round(selection.rect.x1 - selection.rect.x0)} × {Math.round(selection.rect.y1 - selection.rect.y0)} px · {touched.inside.length} block(s)
                inside · {touched.crossed.length} crossed
              </p>
              <button
                type="button"
                class="btn small"
                disabled={busy || (!touched.inside.length && !touched.crossed.length) || (crossesText && !pagesAvailable)}
                title={crossesText && !pagesAvailable ? "Load the document: the blocks it crosses are read again by OCR" : undefined}
                onClick={() => run({ kind: "cut", pageIndex, rect: selection.rect })}
              >
                Cut out of the blocks
              </button>
              <p class="muted small">
                Blocks inside the area go; blocks it crosses keep the rest, their text read again by Mistral OCR without the area (for margin line numbers,
                stamps over text).
              </p>
              <div class="btn-row">
                <button
                  type="button"
                  class="btn small"
                  disabled={busy || !pagesAvailable}
                  title={pagesAvailable ? undefined : "Load the document: the area is read by OCR"}
                  onClick={() => run({ kind: "make", pageIndex, rect: selection.rect, type: makeType })}
                >
                  Make a block
                </button>
                <select aria-label="Type of the new block" value={makeType} onChange={(e) => setMakeType(e.currentTarget.value)}>
                  {BLOCK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {blockTypeLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
              <p class="muted small">
                The area becomes one block (its text read by OCR; an image keeps it as a picture) and is cut out of the blocks around it.
              </p>
              <button
                type="button"
                class="btn btn-ghost small"
                disabled={busy || (!touched.inside.length && !touched.crossed.length)}
                onClick={() => run({ kind: "delete", pageIndex, ids: [...touched.inside, ...touched.crossed].map((b) => b.id) })}
              >
                Delete the {touched.inside.length + touched.crossed.length} block(s) it touches
              </button>
            </div>
          ) : selectedBlock ? (
            <BlockEditor
              key={selectedBlock.id}
              block={selectedBlock}
              busy={busy}
              canRead={pagesAvailable}
              onChange={(type, content) => run({ kind: "change", pageIndex, id: selectedBlock.id, type, content })}
              onReread={() => run({ kind: "reread", pageIndex, id: selectedBlock.id })}
              onDelete={() => run({ kind: "delete", pageIndex, ids: [selectedBlock.id] })}
            />
          ) : (
            <div>
              <p class="muted">Drag on the page to select an area, or click a block (or pick it here).</p>
              <ul class="bbox-list">
                {blocks.map((b) => (
                  <li key={b.id}>
                    <button type="button" class="btn btn-ghost small" onClick={() => setSelection({ kind: "block", id: b.id })}>
                      {blockTypeLabel(b.type)}: {b.content.slice(0, 40) || (b.image_id ? `[Image: ${b.image_id}]` : "(empty)")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
});

function BlockEditor({
  block,
  busy,
  canRead,
  onChange,
  onReread,
  onDelete,
}: {
  block: EditedBlock;
  busy: boolean;
  canRead: boolean;
  onChange: (type: string, content: string) => void;
  onReread: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(block.content);
  const isImage = block.type === "image";
  return (
    <div class="edit-actions">
      <h3>{blockTypeLabel(block.type)} block</h3>
      <p class="muted small">
        ({block.top_left_x}, {block.top_left_y}) – ({block.bottom_right_x}, {block.bottom_right_y}) px{isEditedBlock(block.id) ? " · edited" : ""}
      </p>
      <label class="field">
        <span>Type</span>
        <select value={block.type} disabled={busy} onChange={(e) => onChange(e.currentTarget.value, block.content)}>
          {[...new Set([...BLOCK_TYPES, block.type])].map((t) => (
            <option key={t} value={t}>
              {blockTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>
      {!isImage && (
        <label class="field">
          <span>Text</span>
          <textarea rows={8} class="code-area" value={draft} spellcheck={false} onInput={(e) => setDraft(e.currentTarget.value)} />
        </label>
      )}
      <div class="btn-row">
        {!isImage && (
          <button type="button" class="btn small" disabled={busy || draft === block.content} onClick={() => onChange(block.type, draft)}>
            Save text
          </button>
        )}
        {!isImage && (
          <button
            type="button"
            class="btn btn-ghost small"
            disabled={busy || !canRead}
            title={canRead ? "Read the block's area again with Mistral OCR" : "Load the document to read the block again"}
            onClick={onReread}
          >
            Read again with OCR
          </button>
        )}
        <button type="button" class="btn btn-ghost small" disabled={busy} onClick={onDelete}>
          Delete block
        </button>
      </div>
    </div>
  );
}
