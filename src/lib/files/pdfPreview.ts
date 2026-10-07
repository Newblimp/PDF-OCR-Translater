/**
 * Renders PDF pages to images with pdf.js, entirely in the browser.
 * pdf.js is loaded lazily (separate chunk) the first time a PDF is dropped.
 *
 * Pages are encoded asynchronously (`canvas.toBlob`) as WebP, which is far
 * smaller than PNG for scanned pages, and handed out as object URLs: the
 * pixels live outside the JS heap and the caller frees them with
 * `URL.revokeObjectURL()`. Browsers without a WebP encoder fall back to PNG.
 */

export interface PdfPreview {
  pageCount: number;
  /** Render a page (1-based) at roughly `width` CSS px; returns an object URL the caller must revoke. */
  renderPage(pageNumber: number, width: number): Promise<string>;
  destroy(): void;
}

const PAGE_IMAGE_TYPE = "image/webp";
const PAGE_IMAGE_QUALITY = 0.9;

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
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PAGE_IMAGE_TYPE, PAGE_IMAGE_QUALITY));
      // Release the canvas backing store right away (large at 2x density).
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error("The page could not be encoded");
      return URL.createObjectURL(blob);
    },
    destroy() {
      void loadingTask.destroy();
    },
  };
}
