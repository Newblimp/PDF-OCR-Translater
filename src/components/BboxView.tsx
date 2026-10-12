import { memo } from "preact/compat";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { OcrBlock } from "@/lib/mistral/types";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import { pageBlockId, type OcrBbox, type OcrText } from "@/lib/pipeline/ocrText";
import type { DocState } from "@/app/store";
import { rectOf } from "@/lib/pipeline/blockEdits";
import { blockColor, boxStyle, IMAGE_COLOR } from "./blockColors";
import { MarkdownText } from "./MarkdownText";
import { usePageFirst, usePageRenderer, useRenderedPages } from "./pageImages";
import { PageNav } from "./PageNav";
import { Check } from "./Check";

interface Props {
  doc: DocState | null;
  ocr: OcrText;
  annotations: BboxAnnotation[];
  /** Translation per block id, from the block-translation stage. */
  blockTranslations: Record<string, string>;
}

type Selected = { kind: "bbox"; bbox: OcrBbox } | { kind: "block"; block: OcrBlock; id: string } | null;

/**
 * Bounding-box overview: one page at a time, with the OCR bounding boxes
 * (figures) and paragraph blocks drawn over the rendered page. Pages render
 * in the background so navigation is instant. Clicking a box shows its
 * translation and original text, or the cropped image and the vision
 * model's description.
 */
export const BboxView = memo(function BboxView({ doc, ocr, annotations, blockTranslations }: Props) {
  const pages = ocr.pages;
  const [position, setPosition] = useState(0); // index into `pages` (which may be a subset of the document)
  const [showBlocks, setShowBlocks] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [selected, setSelected] = useState<Selected>(null);

  const page = pages[Math.min(position, pages.length - 1)];
  const pageIndex = page?.index ?? 0;
  const pageBoxes = useMemo(() => ocr.bboxes.filter((b) => b.pageIndex === pageIndex), [ocr, pageIndex]);
  const pageBlocks = page?.blocks ?? [];
  const annotationById = useMemo(() => new Map(annotations.map((a) => [a.id, a])), [annotations]);
  const renderer = usePageRenderer(doc);
  const indexes = useMemo(() => pages.map((p) => p.index), [pages]);
  const rendered = useRenderedPages(renderer, indexes);
  const renderError = usePageFirst(renderer, pageIndex, !!rendered[pageIndex]);

  // Selection belongs to the page and OCR result it was made on.
  useEffect(() => setSelected(null), [pageIndex, ocr]);
  useEffect(() => setPosition(0), [ocr]);

  if (!page) return <p class="muted">No pages.</p>;
  const image = rendered[pageIndex];
  // Coordinates are pixels of the OCR page image; without its size the boxes cannot be placed.
  const width = page.width ?? pageBoxes[0]?.pageWidth ?? null;
  const height = page.height ?? pageBoxes[0]?.pageHeight ?? null;
  const canOverlay = !!width && !!height;
  const renderedCount = renderer?.renderedCount ?? 0;

  const blockTypes = Array.from(new Set(pageBlocks.map((b) => b.type)));
  const hasTranslations = Object.keys(blockTranslations).length > 0;

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <div class="btn-row">
          <PageNav position={position} count={pages.length} onMove={setPosition}>
            Page {pageIndex + 1} · {position + 1} of {pages.length} OCR'd page(s) · {pageBoxes.length} bounding box(es) · {pageBlocks.length} block(s)
          </PageNav>
          {doc?.kind === "pdf" && (
            <span class="muted small" data-rendered-pages={renderedCount}>
              {renderedCount}/{doc.pageCount ?? pages.length} page(s) rendered
            </span>
          )}
        </div>
        <div class="btn-row">
          <Check checked={showImages} onChange={setShowImages} small>
            Image boxes (sent to the vision model)
          </Check>
          <Check checked={showBlocks} onChange={setShowBlocks} small>
            Paragraph blocks
          </Check>
        </div>
      </div>

      {blockTypes.length > 0 && showBlocks && (
        <div class="bbox-legend small muted">
          {blockTypes.map((t) => (
            <span key={t}>
              <span class="swatch" style={`--box-color:${blockColor(t)}`} />
              {t}
            </span>
          ))}
        </div>
      )}

      <div class="bbox-layout">
        <div>
          {!canOverlay && <p class="muted small">The OCR API returned no page dimensions for this page, so boxes cannot be drawn over it.</p>}
          <div class="bbox-stage" style={image ? "" : `width:100%;aspect-ratio:${width ?? 1}/${height ?? 1.4}`}>
            {image ? (
              <img src={image} alt={`Page ${pageIndex + 1}`} />
            ) : (
              <div class="bbox-stage-placeholder">
                {renderError ? `Page could not be rendered: ${renderError}` : doc ? "Rendering page…" : "Load the document to see the page image."}
              </div>
            )}
            <div class="bbox-layer" aria-label="Bounding boxes">
              {canOverlay &&
                showBlocks &&
                pageBlocks.map((block, i) => {
                  const id = pageBlockId(page, i);
                  return (
                    <button
                      type="button"
                      key={id}
                      class={`bbox-box${selected?.kind === "block" && selected.id === id ? " bbox-box-selected" : ""}`}
                      style={boxStyle(rectOf(block), width, height, blockColor(block.type))}
                      title={`${block.type}: ${block.content.slice(0, 80)}`}
                      aria-label={`${block.type} block ${i + 1}${block.content ? `: ${block.content.slice(0, 60)}` : ""}`}
                      onClick={() => setSelected({ kind: "block", block, id })}
                    />
                  );
                })}
              {canOverlay &&
                showImages &&
                pageBoxes.map((bbox) => (
                  <button
                    type="button"
                    key={bbox.id}
                    class={`bbox-box${selected?.kind === "bbox" && selected.bbox.id === bbox.id ? " bbox-box-selected" : ""}`}
                    style={boxStyle(bbox, width, height, IMAGE_COLOR)}
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
});

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
          {hasTranslations ? "No translation was returned for this block." : "Not translated yet: run OCR + Translate (or Translate only)."}
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
