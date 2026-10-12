import { useEffect, useMemo, useState } from "preact/hooks";
import type { DocState } from "@/app/store";
import { getPageRenderer, PAGE_RENDER_WIDTH, type PageRenderer } from "@/lib/files/pageRenderCache";

export { PAGE_RENDER_WIDTH };

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

/**
 * Object URLs of the pages rendered so far (by 0-based index), updated as the
 * renderer finishes more. Pages already rendered (by another view, or by this
 * one before it was hidden) are there on the first paint.
 */
export function useRenderedPages(renderer: PageRenderer | null, pageIndexes: number[]): Record<number, string> {
  const seed = () => {
    const urls: Record<number, string> = {};
    for (const index of pageIndexes) {
      const url = renderer?.peek(index);
      if (url) urls[index] = url;
    }
    return urls;
  };
  const [rendered, setRendered] = useState(seed);
  const first = pageIndexes[0] ?? 0;
  useEffect(() => {
    if (!renderer) return;
    const unsubscribe = renderer.subscribe((index) => {
      const url = renderer.peek(index);
      if (url) setRendered((r) => (r[index] ? r : { ...r, [index]: url }));
    });
    setRendered(seed()); // another renderer, or pages finished since the first paint
    renderer.prefetchAll(first);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe per renderer; the page list belongs to it
  }, [renderer]);
  return rendered;
}

/** Render the page on screen ahead of the background prefetch (unless it is `ready`); the error, if it cannot be. */
export function usePageFirst(renderer: PageRenderer | null, pageIndex: number, ready: boolean): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!renderer || ready) return;
    let cancelled = false;
    setError(null);
    renderer.get(pageIndex).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [renderer, pageIndex, ready]);
  return error;
}
