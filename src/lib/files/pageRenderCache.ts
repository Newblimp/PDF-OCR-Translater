/**
 * Per-document cache of rendered page images for the bounding-box view.
 * The PDF is opened once; pages render on demand and, in the background, in
 * reading order so that navigating to the next page is instant.
 */
import { openPdfPreview, type PdfPreview } from "./pdfPreview";

export interface PageRenderer {
  /** Data URL of a rendered page (0-based index), rendering it if needed. */
  get(pageIndex: number): Promise<string>;
  /** Cached data URL if already rendered. */
  peek(pageIndex: number): string | null;
  /** Render every page, starting at `startIndex`, in the background. */
  prefetchAll(startIndex: number): void;
  /** Subscribe to "a page finished rendering"; returns an unsubscribe function. */
  subscribe(listener: (pageIndex: number) => void): () => void;
  readonly renderedCount: number;
  dispose(): void;
}

interface Entry {
  renderer: PageRenderer;
  docId: string;
}

let current: Entry | null = null;
/** Do not pre-render giant documents in full; beyond this, pages render on demand. */
const PREFETCH_LIMIT = 60;

/** Get (or create) the renderer for a document. Switching documents disposes the previous one. */
export function getPageRenderer(docId: string, file: Blob, kind: "pdf" | "image", imageUrl: string | null, width: number): PageRenderer {
  if (current && current.docId === docId) return current.renderer;
  current?.renderer.dispose();
  current = { docId, renderer: createRenderer(file, kind, imageUrl, width) };
  return current.renderer;
}

export function disposePageRenderer(docId?: string): void {
  if (!current || (docId && current.docId !== docId)) return;
  current.renderer.dispose();
  current = null;
}

function createRenderer(file: Blob, kind: "pdf" | "image", imageUrl: string | null, width: number): PageRenderer {
  const rendered = new Map<number, string>();
  const pending = new Map<number, Promise<string>>();
  const listeners = new Set<(pageIndex: number) => void>();
  let doc: Promise<PdfPreview> | null = null;
  let disposed = false;
  let queue: number[] = [];
  let pumping = false;

  const open = () => {
    if (!doc) doc = file.arrayBuffer().then((buf) => openPdfPreview(buf));
    return doc;
  };

  const renderOne = (pageIndex: number): Promise<string> => {
    const cached = rendered.get(pageIndex);
    if (cached) return Promise.resolve(cached);
    const inFlight = pending.get(pageIndex);
    if (inFlight) return inFlight;
    const task = (async () => {
      let url: string;
      if (kind === "image") {
        url = imageUrl ?? "";
      } else {
        const preview = await open();
        if (disposed) throw new Error("Renderer disposed");
        if (pageIndex < 0 || pageIndex >= preview.pageCount) throw new Error(`Page ${pageIndex + 1} does not exist`);
        url = await preview.renderPage(pageIndex + 1, width);
      }
      if (!disposed) {
        rendered.set(pageIndex, url);
        for (const l of listeners) l(pageIndex);
      }
      return url;
    })();
    pending.set(pageIndex, task);
    void task.finally(() => pending.delete(pageIndex));
    return task;
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && !disposed) {
        const next = queue.shift()!;
        if (rendered.has(next)) continue;
        try {
          await renderOne(next);
        } catch {
          // A page that fails to render is skipped; on-demand access reports the error.
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    get(pageIndex) {
      // Move the requested page to the front of the background queue.
      queue = [pageIndex, ...queue.filter((p) => p !== pageIndex)];
      return renderOne(pageIndex);
    },
    peek(pageIndex) {
      return rendered.get(pageIndex) ?? null;
    },
    prefetchAll(startIndex) {
      if (kind === "image") return;
      void open().then((preview) => {
        if (disposed) return;
        const count = Math.min(preview.pageCount, PREFETCH_LIMIT);
        const order: number[] = [];
        for (let p = startIndex; p < count; p++) order.push(p);
        for (let p = 0; p < Math.min(startIndex, count); p++) order.push(p);
        queue = [...queue, ...order.filter((p) => !queue.includes(p) && !rendered.has(p))];
        void pump();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get renderedCount() {
      return rendered.size;
    },
    dispose() {
      disposed = true;
      queue = [];
      listeners.clear();
      void doc?.then((d) => d.destroy()).catch(() => undefined);
      doc = null;
    },
  };
}
