import { useEffect, useMemo, useState } from "preact/hooks";
import { getPageRenderer } from "@/lib/files/pageRenderCache";
import type { OcrBlock } from "@/lib/mistral/types";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import { blockId } from "@/lib/pipeline/blockTranslate";
import type { OcrBbox, OcrText } from "@/lib/pipeline/ocrText";
import type { DocState } from "@/app/store";
import { MarkdownText } from "./MarkdownText";

interface Props {
  doc: DocState | null;
  ocr: OcrText;
  annotations: BboxAnnotation[];
  /** Translation per block id, from the block-translation stage. */
  blockTranslations: Record<string, string>;
}

/** Colours per block type (kept readable in both themes). */
const BLOCK_COLORS: Record<string, string> = {
  image: "#d6336c",
  title: "#7048e8",
  text: "#1c7ed6",
  table: "#f08c00",
  header: "#868e96",
  footer: "#868e96",
  caption: "#0ca678",
  list: "#1098ad",
  equation: "#5c940d",
  code: "#5c940d",
  signature: "#e03131",
  references: "#862e9c",
  aside_text: "#adb5bd",
};
const IMAGE_COLOR = "#d6336c";
const RENDER_WIDTH = 1000;

type Selected = { kind: "bbox"; bbox: OcrBbox } | { kind: "block"; block: OcrBlock; id: string } | null;

/**
 * Bounding-box overview: one page at a time, with the OCR bounding boxes
 * (figures) and paragraph blocks drawn over the rendered page. Pages render
 * in the background so navigation is instant. Clicking a box shows its
 * translation and original text, or the cropped image and the vision
 * model's description.
 */
export function BboxView({ doc, ocr, annotations, blockTranslations }: Props) {
  const pages = ocr.pages;
  const [position, setPosition] = useState(0); // index into `pages` (which may be a subset of the document)
  const [showBlocks, setShowBlocks] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [selected, setSelected] = useState<Selected>(null);
  const [rendered, setRendered] = useState<Record<number, string>>({});
  const [renderedCount, setRenderedCount] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  const page = pages[Math.min(position, pages.length - 1)];
  const pageIndex = page?.index ?? 0;
  const pageBoxes = useMemo(() => ocr.bboxes.filter((b) => b.pageIndex === pageIndex), [ocr, pageIndex]);
  const pageBlocks = page?.blocks ?? [];
  const annotationById = useMemo(() => new Map(annotations.map((a) => [a.id, a])), [annotations]);

  // One renderer per document; it keeps the PDF open and pre-renders pages in the background.
  const renderer = useMemo(
    () => (doc ? getPageRenderer(doc.id, doc.file, doc.kind === "image" ? "image" : "pdf", doc.previews[0] ?? null, RENDER_WIDTH) : null),
    [doc],
  );

  useEffect(() => {
    if (!renderer) return;
    const unsubscribe = renderer.subscribe((index) => {
      const url = renderer.peek(index);
      if (url) setRendered((r) => (r[index] ? r : { ...r, [index]: url }));
      setRenderedCount(renderer.renderedCount);
    });
    // Seed from what is already rendered (e.g. the tab was re-opened).
    const seed: Record<number, string> = {};
    for (const p of pages) {
      const url = renderer.peek(p.index);
      if (url) seed[p.index] = url;
    }
    setRendered(seed);
    setRenderedCount(renderer.renderedCount);
    renderer.prefetchAll(pageIndex);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer]);

  // Make sure the current page renders first when the user navigates.
  useEffect(() => {
    if (!renderer || rendered[pageIndex]) return;
    let cancelled = false;
    setRenderError(null);
    renderer
      .get(pageIndex)
      .then((url) => {
        if (!cancelled) setRendered((r) => ({ ...r, [pageIndex]: url }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [renderer, pageIndex, rendered]);

  // Selection belongs to the page it was made on.
  useEffect(() => setSelected(null), [pageIndex]);

  if (!page) return <p class="muted">No pages.</p>;
  const image = rendered[pageIndex];
  const width = page.width ?? 1;
  const height = page.height ?? 1;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const boxStyle = (x0: number, y0: number, x1: number, y1: number, color: string) =>
    `left:${pct(x0, width)};top:${pct(y0, height)};width:${pct(x1 - x0, width)};height:${pct(y1 - y0, height)};--box-color:${color}`;

  const blockTypes = Array.from(new Set(pageBlocks.map((b) => b.type)));
  const hasTranslations = Object.keys(blockTranslations).length > 0;

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <div class="btn-row">
          <button type="button" class="btn btn-ghost small" disabled={position <= 0} onClick={() => setPosition((i) => i - 1)}>
            ← Previous
          </button>
          <span class="muted small">
            Page {pageIndex + 1} · {position + 1} of {pages.length} OCR'd page(s) · {pageBoxes.length} bounding box(es) · {pageBlocks.length} block(s)
          </span>
          <button type="button" class="btn btn-ghost small" disabled={position >= pages.length - 1} onClick={() => setPosition((i) => i + 1)}>
            Next →
          </button>
          {doc?.kind === "pdf" && (
            <span class="muted small" data-rendered-pages={renderedCount}>
              {renderedCount}/{doc.pageCount ?? pages.length} page(s) rendered
            </span>
          )}
        </div>
        <div class="btn-row">
          <label class="checkbox small">
            <input type="checkbox" checked={showImages} onChange={(e) => setShowImages((e.target as HTMLInputElement).checked)} />
            <span>Image boxes (sent to the vision model)</span>
          </label>
          <label class="checkbox small">
            <input type="checkbox" checked={showBlocks} onChange={(e) => setShowBlocks((e.target as HTMLInputElement).checked)} />
            <span>Paragraph blocks</span>
          </label>
        </div>
      </div>

      {blockTypes.length > 0 && showBlocks && (
        <div class="bbox-legend small muted">
          {blockTypes.map((t) => (
            <span key={t}>
              <span class="swatch" style={`--box-color:${BLOCK_COLORS[t] ?? "#495057"}`} />
              {t}
            </span>
          ))}
        </div>
      )}

      <div class="bbox-layout">
        <div>
          <div class="bbox-stage" style={image ? "" : `width:100%;aspect-ratio:${width}/${height}`}>
            {image ? (
              <img src={image} alt={`Page ${pageIndex + 1}`} />
            ) : (
              <div class="bbox-stage-placeholder">
                {renderError ? `Page could not be rendered: ${renderError}` : doc ? "Rendering page…" : "Load the document to see the page image."}
              </div>
            )}
            <div class="bbox-layer" aria-label="Bounding boxes">
              {showBlocks &&
                pageBlocks.map((block, i) => {
                  const id = blockId(pageIndex, i);
                  return (
                    <button
                      type="button"
                      key={id}
                      class={`bbox-box${selected?.kind === "block" && selected.id === id ? " bbox-box-selected" : ""}`}
                      style={boxStyle(block.top_left_x, block.top_left_y, block.bottom_right_x, block.bottom_right_y, BLOCK_COLORS[block.type] ?? "#495057")}
                      title={`${block.type}: ${block.content.slice(0, 80)}`}
                      aria-label={`${block.type} block ${i + 1}`}
                      onClick={() => setSelected({ kind: "block", block, id })}
                    />
                  );
                })}
              {showImages &&
                pageBoxes.map((bbox) => (
                  <button
                    type="button"
                    key={bbox.id}
                    class={`bbox-box${selected?.kind === "bbox" && selected.bbox.id === bbox.id ? " bbox-box-selected" : ""}`}
                    style={boxStyle(bbox.x0, bbox.y0, bbox.x1, bbox.y1, IMAGE_COLOR)}
                    title={bbox.id}
                    aria-label={`Image box ${bbox.id}`}
                    onClick={() => setSelected({ kind: "bbox", bbox })}
                  >
                    <span class="bbox-box-label">{bbox.id}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>

        <aside class="card bbox-detail">
          {selected?.kind === "bbox" ? (
            <BboxDetails bbox={selected.bbox} annotation={annotationById.get(selected.bbox.id) ?? null} />
          ) : selected?.kind === "block" ? (
            <BlockDetails block={selected.block} translation={blockTranslations[selected.id] ?? null} hasTranslations={hasTranslations} />
          ) : (
            <p class="muted">Click a box on the page to see its translation, its content and the vision model's description.</p>
          )}
          {pageBoxes.length > 0 && (
            <div>
              <h3 class="small muted">Image boxes on this page</h3>
              <ul class="bbox-list">
                {pageBoxes.map((bbox) => {
                  const a = annotationById.get(bbox.id);
                  return (
                    <li key={bbox.id}>
                      <button type="button" class="btn btn-ghost small" onClick={() => setSelected({ kind: "bbox", bbox })}>
                        {bbox.id}
                        {a?.data ? ` · ${a.data.image_type}` : ""}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function BlockDetails({ block, translation, hasTranslations }: { block: OcrBlock; translation: string | null; hasTranslations: boolean }) {
  return (
    <div class="block-details">
      <h3>{block.type} block</h3>
      <p class="muted small">
        ({block.top_left_x}, {block.top_left_y}) – ({block.bottom_right_x}, {block.bottom_right_y}) px
      </p>
      <h4 class="small muted">Translation</h4>
      {translation ? (
        <div class="block-translation">
          <MarkdownText text={translation} markdown={true} />
        </div>
      ) : (
        <p class="muted small">
          {hasTranslations
            ? "No translation was returned for this block."
            : "Not translated yet: run OCR + Translate (block translations are produced after the main translation)."}
        </p>
      )}
      <h4 class="small muted">Original</h4>
      <pre class="text-preview">{block.content || "(no text)"}</pre>
    </div>
  );
}

function BboxDetails({ bbox, annotation }: { bbox: OcrBbox; annotation: BboxAnnotation | null }) {
  return (
    <div>
      <h3>{bbox.id}</h3>
      <p class="muted small">
        Page {bbox.pageIndex + 1} · ({bbox.x0}, {bbox.y0}) – ({bbox.x1}, {bbox.y1}) px
      </p>
      {bbox.dataUrl ? <img src={bbox.dataUrl} alt={`Extracted image ${bbox.id}`} /> : <p class="muted small">No image returned by the OCR API.</p>}
      {annotation?.data ? (
        <dl class="bbox-annotation">
          <dt>Type</dt>
          <dd>{annotation.data.image_type}</dd>
          <dt>Description</dt>
          <dd>{annotation.data.short_description}</dd>
          <dt>Summary</dt>
          <dd>{annotation.data.summary}</dd>
          {annotation.data.text_in_image && (
            <>
              <dt>Text in image</dt>
              <dd>{annotation.data.text_in_image}</dd>
              <dt>Translated</dt>
              <dd>{annotation.data.text_translated}</dd>
            </>
          )}
        </dl>
      ) : annotation?.error ? (
        <p class="error-text small">Description failed: {annotation.error}</p>
      ) : (
        <p class="muted small">Not described by the vision model (run OCR + Translate, or enable bounding-box annotation in Settings).</p>
      )}
    </div>
  );
}
