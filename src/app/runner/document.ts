/**
 * The loaded document: reading it (hash, page count, thumbnails), its OCR
 * result and translation from this browser's caches, the pages to OCR, and
 * what it holds outside the store (object URLs, the open pdf.js document).
 */
import { classifyFile } from "@/lib/files/fileKind";
import { sha256Hex } from "@/lib/files/hash";
import { disposePageRenderer } from "@/lib/files/pageRenderCache";
import { openPdfPreview } from "@/lib/files/pdfPreview";
import { buildOcrText } from "@/lib/pipeline/ocrText";
import { OCR_MAX_FILE_BYTES } from "@/lib/pipeline/runOcr";
import { findSavedTranslation } from "@/lib/storage/history";
import { getCachedOcr, ocrCacheKey, type OcrCacheEntry } from "@/lib/storage/ocrCache";
import { parsePageSelection } from "@/lib/util/pageSelection";
import { formatBytes } from "@/lib/util/text";
import { makeOcrState, ocrRequestKey, restoredTranslation, type DocState, type OcrState, type TranslationState } from "../store";
import type { Runtime } from "./runtime";

/** How many pages to render as thumbnails when a PDF is dropped. */
const PREVIEW_PAGES = 4;

const PREVIEW_WIDTH_PX = 260;

/** Free what the current document holds outside the store: preview object URLs and the open pdf.js document. */
export function releaseDocument(rt: Runtime): void {
  for (const url of rt.getState().doc?.previews ?? []) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  disposePageRenderer();
}

export async function loadDocument(rt: Runtime, file: File): Promise<void> {
  const classified = classifyFile(file);
  if (!classified) {
    rt.dispatch({
      type: "error/set",
      error: { title: "Unsupported file", message: `"${file.name}" is not a PDF, image (PNG/JPEG/WebP) or text file.` },
    });
    return;
  }
  rt.getState().job?.controller.abort();
  releaseDocument(rt);

  const doc: DocState = {
    id: crypto.randomUUID(),
    file,
    name: file.name,
    size: file.size,
    kind: classified.kind,
    mimeType: classified.mimeType,
    hash: null,
    pageCount: null,
    previews: [],
    previewStatus: classified.kind === "text" ? "ready" : "loading",
    previewError: null,
    textContent: null,
    pageSelection: "",
  };
  rt.dispatch({ type: "doc/set", doc });
  const patch = (p: Partial<DocState>) => rt.dispatch({ type: "doc/patch", id: doc.id, patch: p });
  const stillCurrent = () => rt.getState().doc?.id === doc.id;

  if (file.size > OCR_MAX_FILE_BYTES && classified.kind !== "text") {
    rt.dispatch({
      type: "error/set",
      error: {
        title: "File too large for Mistral OCR",
        message: `${file.name} is ${formatBytes(file.size)}; the OCR API accepts up to ${formatBytes(OCR_MAX_FILE_BYTES)}.`,
      },
    });
  }

  try {
    if (classified.kind === "text") {
      const text = await file.text();
      if (stillCurrent()) {
        patch({ textContent: text, previewStatus: "ready" });
        void restoreSavedTranslation(rt, doc.id, await hashText(text), null);
      }
      return;
    }

    const buffer = await file.arrayBuffer();
    // Hash and preview in parallel; both are local computations.
    const hashing = sha256Hex(buffer).then(async (hash) => {
      if (!stillCurrent()) return;
      patch({ hash });
      await restoreCachedOcr(rt, doc.id, hash);
    });

    if (classified.kind === "image") {
      patch({ previews: [URL.createObjectURL(file)], pageCount: 1, previewStatus: "ready" });
    } else {
      const preview = await openPdfPreview(buffer);
      try {
        if (!stillCurrent()) return;
        patch({ pageCount: preview.pageCount });
        const pages = Math.min(PREVIEW_PAGES, preview.pageCount);
        const previews: string[] = [];
        for (let i = 1; i <= pages; i++) {
          const url = await preview.renderPage(i, PREVIEW_WIDTH_PX);
          if (!stillCurrent()) {
            URL.revokeObjectURL(url);
            return;
          }
          previews.push(url);
          patch({ previews: [...previews], previewStatus: i === pages ? "ready" : "loading" });
        }
        if (pages === 0) patch({ previewStatus: "ready" });
      } finally {
        preview.destroy();
      }
    }
    await hashing;
  } catch (err) {
    if (stillCurrent()) {
      patch({ previewStatus: "error", previewError: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Update the pages-to-OCR selection of the loaded document and re-check the local cache for it. */
export function setPageSelection(rt: Runtime, text: string): void {
  const doc = rt.getState().doc;
  if (!doc) return;
  rt.dispatch({ type: "doc/patch", id: doc.id, patch: { pageSelection: text } });
  if (rt.getState().ocr?.source === "cache") rt.dispatch({ type: "ocr/set", ocr: null });
  if (doc.hash) void restoreCachedOcr(rt, doc.id, doc.hash);
}

function selectedPages(rt: Runtime): number[] | null {
  const doc = rt.getState().doc;
  if (!doc) return null;
  const parsed = parsePageSelection(doc.pageSelection, doc.pageCount);
  return parsed.error ? null : parsed.pages;
}

async function restoreCachedOcr(rt: Runtime, docId: string, hash: string): Promise<void> {
  const state = rt.getState();
  if (!state.settings.cacheOcr) return;
  const pages = selectedPages(rt);
  const key = ocrCacheKey(hash, state.settings.ocrModel, pages);
  const entry = await getCachedOcr(key);
  if (!entry) return;
  if (rt.getState().doc?.id !== docId || rt.getState().ocr) return;
  rt.dispatch({ type: "ocr/set", ocr: cachedOcrState(entry, docId, ocrRequestKey(state.settings.ocrModel, pages), key) });
  await restoreSavedTranslation(rt, docId, hash, key);
}

/** An OCR result from this browser's cache, with its saved edits. */
export function cachedOcrState(entry: OcrCacheEntry, docId: string, requestKey: string, cacheKey: string): OcrState {
  const { model, response, edits } = entry;
  return makeOcrState({ source: "cache", model, response, base: buildOcrText(response), edits: edits ?? null, docId, requestKey, cacheKey });
}

/** Show the newest saved translation of the same document (and OCR result) right away. */
async function restoreSavedTranslation(rt: Runtime, docId: string, sourceHash: string, ocrKey: string | null): Promise<void> {
  if (!rt.getState().settings.saveTranslations) return;
  const saved = await findSavedTranslation<TranslationState>(sourceHash, ocrKey);
  const state = rt.getState();
  if (!saved || state.doc?.id !== docId || state.translation || state.job) return;
  rt.dispatch({ type: "translation/set", translation: restoredTranslation(saved.translation) });
}

export function clearDocument(rt: Runtime): void {
  rt.getState().job?.controller.abort();
  releaseDocument(rt);
  rt.dispatch({ type: "doc/clear" });
}

export async function hashText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
}
