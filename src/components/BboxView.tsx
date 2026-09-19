import { useEffect, useMemo, useState } from "preact/hooks";
import { renderPdfPage } from "@/lib/files/pdfPreview";
import type { OcrBlock } from "@/lib/mistral/types";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import type { OcrBbox, OcrText } from "@/lib/pipeline/ocrText";
import type { DocState } from "@/app/store";

interface Props {
  doc: DocState | null;
  ocr: OcrText;
  annotations: BboxAnnotation[];
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

type Selected = { kind: "bbox"; bbox: OcrBbox } | { kind: "block"; block: OcrBlock } | null;

/**
 * Bounding-box overview: one page at a time, with the OCR bounding boxes
 * (figures) and paragraph blocks drawn over the rendered page. Clicking a box
 * shows its content, the cropped image and the vision model's description.
 */
export function BboxView({ doc, ocr, annotations }: Props) {
  const pages = ocr.pages;
  const [pageIndex, setPageIndex] = useState(pages[0]?.index ?? 0);
  const [showBlocks, setShowBlocks] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [selected, setSelected] = useState<Selected>(null);
  const [rendered, setRendered] = useState<Record<number, string>>({});
  const [renderError, setRenderError] = useState<string | null>(null);

  const page = pages.find((p) => p.index === pageIndex) ?? pages[0];
  const pageBoxes = useMemo(() => ocr.bboxes.filter((b) => b.pageIndex === pageIndex), [ocr, pageIndex]);
  const pageBlocks = page?.blocks ?? [];
  const annotationById = useMemo(() => new Map(annotations.map((a) => [a.id, a])), [annotations]);

  // Render the current page lazily from the loaded file.
  useEffect(() => {
    if (!doc || rendered[pageIndex]) return;
    let cancelled = false;
    setRenderError(null);
    const run = async () => {
      try {
        const url = doc.kind === "image" ? (doc.previews[0] ?? "") : await renderPdfPage(doc.file, pageIndex + 1, RENDER_WIDTH);
        if (!cancelled) setRendered((r) => ({ ...r, [pageIndex]: url }));
      } catch (err) {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [doc, pageIndex, rendered]);

  if (!page) return <p class="muted">No pages.</p>;
  const image = rendered[pageIndex];
  const width = page.width ?? 1;
  const height = page.height ?? 1;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const boxStyle = (x0: number, y0: number, x1: number, y1: number, color: string) =>
    `left:${pct(x0, width)};top:${pct(y0, height)};width:${pct(x1 - x0, width)};height:${pct(y1 - y0, height)};--box-color:${color}`;

  const blockTypes = Array.from(new Set(pageBlocks.map((b) => b.type)));

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <div class="btn-row">
          <button type="button" class="btn btn-ghost small" disabled={pageIndex <= (pages[0]?.index ?? 0)} onClick={() => setPageIndex((i) => i - 1)}>
            ← Previous
          </button>
          <span class="muted small">
            Page {pageIndex + 1} of {pages.length} · {pageBoxes.length} bounding box(es) · {pageBlocks.length} block(s)
          </span>
          <button
            type="button"
            class="btn btn-ghost small"
            disabled={pageIndex >= (pages.at(-1)?.index ?? 0)}
            onClick={() => setPageIndex((i) => i + 1)}
          >
            Next →
          </button>
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
              <div class="bbox-stage-placeholder">{renderError ? `Page could not be rendered: ${renderError}` : doc ? "Rendering page…" : "Load the document to see the page image."}</div>
            )}
            <div class="bbox-layer" aria-label="Bounding boxes">
              {showBlocks &&
                pageBlocks.map((block, i) => (
                  <button
                    type="button"
                    key={`b${i}`}
                    class={`bbox-box${selected?.kind === "block" && selected.block === block ? " bbox-box-selected" : ""}`}
                    style={boxStyle(block.top_left_x, block.top_left_y, block.bottom_right_x, block.bottom_right_y, BLOCK_COLORS[block.type] ?? "#495057")}
                    title={`${block.type}: ${block.content.slice(0, 80)}`}
                    aria-label={`${block.type} block`}
                    onClick={() => setSelected({ kind: "block", block })}
                  />
                ))}
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
            <div>
              <h3>{selected.block.type} block</h3>
              <p class="muted small">
                ({selected.block.top_left_x}, {selected.block.top_left_y}) – ({selected.block.bottom_right_x}, {selected.block.bottom_right_y}) px
              </p>
              <pre class="text-preview">{selected.block.content || "(no text)"}</pre>
            </div>
          ) : (
            <p class="muted">Click a box on the page to see its content and the vision model's description.</p>
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
