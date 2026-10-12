/**
 * Renders PDF pages to images with pdf.js, entirely in the browser.
 * pdf.js is loaded lazily (separate chunk) the first time a PDF is dropped.
 *
 * Pages are encoded asynchronously (`canvas.toBlob`) as WebP, which is far
 * smaller than PNG for scanned pages, and handed out as object URLs: the
 * pixels live outside the JS heap and the caller frees them with
 * `URL.revokeObjectURL()`. Browsers without a WebP encoder fall back to PNG.
 */

/** A rectangle in the pixel coordinates of a page image `pageWidth` px wide (the OCR's page coordinates). */
export interface PageRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfPreview {
  pageCount: number;
  /** Render a page (1-based) at roughly `width` CSS px; returns an object URL the caller must revoke. */
  renderPage(pageNumber: number, width: number): Promise<string>;
  /** A region of a page (1-based) as a PNG data URL, at the scale of a `pageWidth` px wide page image, with `blank` areas painted white. */
  renderRegion(pageNumber: number, pageWidth: number, region: PageRect, blank: PageRect[]): Promise<string>;
  destroy(): void;
}

/** White margin around a region, so the OCR model does not meet text right at the edge. */
const REGION_PADDING = 12;

/** A region image: white canvas, the page painted by `draw` (in page pixels, offset), the blank areas painted over. */
export async function regionImage(
  region: PageRect,
  blank: PageRect[],
  draw: (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dx: number, dy: number) => Promise<void>,
): Promise<string> {
  const width = Math.max(1, Math.round(region.x1 - region.x0));
  const height = Math.max(1, Math.round(region.y1 - region.y0));
  const canvas = document.createElement("canvas");
  canvas.width = width + 2 * REGION_PADDING;
  canvas.height = height + 2 * REGION_PADDING;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const dx = REGION_PADDING - region.x0;
  const dy = REGION_PADDING - region.y0;
  await draw(context, canvas, dx, dy);
  context.fillStyle = "#fff";
  // Outside the region (the padding) and the blank areas stay white.
  context.fillRect(0, 0, canvas.width, REGION_PADDING);
  context.fillRect(0, canvas.height - REGION_PADDING, canvas.width, REGION_PADDING);
  context.fillRect(0, 0, REGION_PADDING, canvas.height);
  context.fillRect(canvas.width - REGION_PADDING, 0, REGION_PADDING, canvas.height);
  for (const b of blank) context.fillRect(b.x0 + dx, b.y0 + dy, b.x1 - b.x0, b.y1 - b.y0);
  const url = canvas.toDataURL("image/png");
  canvas.width = 0;
  canvas.height = 0;
  return url;
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
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
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
    async renderRegion(pageNumber, pageWidth, region, blank) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pageWidth / base.width });
      try {
        return await regionImage(region, blank, async (context, canvas, dx, dy) => {
          await page.render({ canvas, canvasContext: context, viewport, transform: [1, 0, 0, 1, dx, dy] }).promise;
        });
      } finally {
        page.cleanup();
      }
    },
    destroy() {
      void loadingTask.destroy();
    },
  };
}
