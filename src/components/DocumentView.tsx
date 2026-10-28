import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DocState } from "@/app/store";
import { parsePageSelection } from "@/lib/util/pageSelection";
import { formatBytes } from "@/lib/util/text";
import { usePageRenderer, useRenderedPages } from "./pageImages";

/**
 * The loaded document, large, before there is a result: its pages (the ones
 * outside "Pages to OCR" dimmed), the image, or the text of a text file. The
 * job's progress and errors show above it (`ResultsPanel`).
 */
/** `idle`: no job runs and no error is shown, so the next step is the user's. */
export const DocumentView = memo(function DocumentView({ doc, idle }: { doc: DocState; idle: boolean }) {
  const selection = parsePageSelection(doc.pageSelection, doc.pageCount);
  const selected = selection.error || !selection.pages ? null : new Set(selection.pages);
  const pages = doc.kind === "text" ? null : (doc.pageCount ?? (doc.kind === "image" ? 1 : 0));
  return (
    <div class="tab-panel document-view" aria-label="Document">
      <div class="toolbar">
        <span class="muted small">
          {doc.name} · {formatBytes(doc.size)}
          {pages ? ` · ${pages} page(s)` : ""}
          {selected ? ` · ${selected.size} selected for OCR` : ""}
        </span>
        {idle && <span class="muted small">Press “Translate” to read and translate it.</span>}
      </div>
      {doc.kind === "text" ? (
        <pre class="doc-text">{doc.textContent ?? "Reading the file…"}</pre>
      ) : doc.previewStatus === "error" ? (
        <p class="muted small">The document could not be shown ({doc.previewError}); it can still be sent to OCR.</p>
      ) : doc.kind === "image" ? (
        doc.previews[0] && <img class="doc-image" src={doc.previews[0]} alt={doc.name} />
      ) : pages ? (
        <DocPages doc={doc} count={pages} selected={selected} />
      ) : (
        <p class="muted small">Opening the document…</p>
      )}
    </div>
  );
});

/** The PDF's pages, rendered as they come into view (the rest in the background), the small previews standing in until then. */
function DocPages({ doc, count, selected }: { doc: DocState; count: number; selected: ReadonlySet<number> | null }) {
  const renderer = usePageRenderer(doc);
  const indexes = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
  const rendered = useRenderedPages(renderer, indexes);
  const column = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    const root = column.current;
    if (!renderer || !root) return;
    let cancelled = false;
    // The viewport as root: the column scrolls on its own on wide screens, with the page on narrow ones.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset["page"]);
          if (!entry.isIntersecting || renderer.peek(index)) continue;
          renderer.get(index).catch((err: unknown) => {
            if (!cancelled) setErrors((e) => ({ ...e, [index]: err instanceof Error ? err.message : String(err) }));
          });
        }
      },
      { rootMargin: "50% 0px" },
    );
    for (const el of root.querySelectorAll(":scope > [data-page]")) observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [renderer, count]);

  return (
    <div class="doc-pages" ref={column}>
      {indexes.map((index) => {
        const url = rendered[index] ?? doc.previews[index];
        const skipped = selected !== null && !selected.has(index);
        return (
          <section key={index} class={`doc-page${skipped ? " doc-page-skipped" : ""}`} data-page={index}>
            <h3 class="ocr-page-title">
              Page {index + 1}
              {skipped && <span class="muted"> · not in “Pages to OCR”</span>}
            </h3>
            {url ? (
              <img src={url} alt={`Page ${index + 1}`} />
            ) : (
              <div class="doc-page-placeholder small">{errors[index] ? `Page could not be rendered: ${errors[index]}` : "Rendering page…"}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
