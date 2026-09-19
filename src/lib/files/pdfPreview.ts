/**
 * Renders PDF pages to PNG data URLs with pdf.js, entirely in the browser.
 * pdf.js is loaded lazily (separate chunk) the first time a PDF is dropped.
 */

export interface PdfPreview {
  pageCount: number;
  /** Render a page (1-based) to a PNG data URL at roughly `width` CSS px. */
  renderPage(pageNumber: number, width: number): Promise<string>;
  destroy(): void;
}

// The "legacy" build ships polyfills for very recent JavaScript features that
// the modern build assumes (e.g. Map.prototype.getOrInsertComputed), so the
// preview also works in browsers that are a few releases behind.
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Render one page of a PDF file to a PNG data URL at the given CSS width.
 * Opens and closes the document each time; callers cache the result.
 */
export async function renderPdfPage(file: Blob, pageNumber: number, width: number): Promise<string> {
  const preview = await openPdfPreview(await file.arrayBuffer());
  try {
    return await preview.renderPage(pageNumber, width);
  } finally {
    preview.destroy();
  }
}

export async function openPdfPreview(data: ArrayBuffer): Promise<PdfPreview> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableAutoFetch: true,
    // Auxiliary files are served from our own origin (see vite.config.ts).
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
  });
  const doc = await loadingTask.promise;

  return {
    pageCount: doc.numPages,
    async renderPage(pageNumber, width) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = (width / base.width) * dpr;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      page.cleanup();
      return canvas.toDataURL("image/png");
    },
    destroy() {
      void loadingTask.destroy();
    },
  };
}
