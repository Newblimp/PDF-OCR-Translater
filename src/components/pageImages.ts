import { useEffect, useMemo, useState } from "preact/hooks";
import type { DocState } from "@/app/store";
import { getPageRenderer, type PageRenderer } from "@/lib/files/pageRenderCache";

/** Width pages render at; one renderer serves every view of a document, so they all use it. */
export const PAGE_RENDER_WIDTH = 1000;

/**
 * The page renderer of the loaded document: it keeps the PDF open and
 * renders pages in the background. Null without a document, and for an
 * image document until its preview URL (shown as the page) is ready.
 */
export function usePageRenderer(doc: DocState | null): PageRenderer | null {
  const imageUrl = doc?.kind === "image" ? (doc.previews[0] ?? null) : null;
  return useMemo(
    () =>
      doc && (doc.kind !== "image" || imageUrl) ? getPageRenderer(doc.id, doc.file, doc.kind === "image" ? "image" : "pdf", imageUrl, PAGE_RENDER_WIDTH) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one renderer per document id; the file never changes for an id
    [doc?.id, imageUrl],
  );
}

/** Object URLs of the pages rendered so far (by 0-based index), updated as the renderer finishes more. */
export function useRenderedPages(renderer: PageRenderer | null, pageIndexes: number[]): Record<number, string> {
  const [rendered, setRendered] = useState<Record<number, string>>({});
  const first = pageIndexes[0] ?? 0;
  useEffect(() => {
    if (!renderer) return;
    const unsubscribe = renderer.subscribe((index) => {
      const url = renderer.peek(index);
      if (url) setRendered((r) => (r[index] ? r : { ...r, [index]: url }));
    });
    // Seed from what is already rendered (another view, or this one before it was hidden).
    const seed: Record<number, string> = {};
    for (const index of pageIndexes) {
      const url = renderer.peek(index);
      if (url) seed[index] = url;
    }
    setRendered(seed);
    renderer.prefetchAll(first);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe per renderer; the page list belongs to it
  }, [renderer]);
  return rendered;
}
