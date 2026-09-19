import { useRef } from "preact/hooks";
import { ACCEPT_ATTRIBUTE } from "@/lib/files/fileKind";
import { formatBytes } from "@/lib/util/text";
import { parsePageSelection } from "@/lib/util/pageSelection";
import type { DocState, OcrState } from "@/app/store";

interface Props {
  doc: DocState;
  ocr: OcrState | null;
  busy: boolean;
  onPageSelection: (text: string) => void;
  onReplace: (file: File) => void;
  onRemove: () => void;
}

const KIND_LABEL = { pdf: "PDF", image: "Image", text: "Text" } as const;

export function DocumentCard({ doc, ocr, busy, onPageSelection, onReplace, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selection = parsePageSelection(doc.pageSelection, doc.pageCount);
  return (
    <div class="card document-card">
      <div class="card-head">
        <div>
          <h2 class="document-name" title={doc.name}>
            {doc.name}
          </h2>
          <p class="muted">
            {KIND_LABEL[doc.kind]} · {formatBytes(doc.size)}
            {doc.pageCount !== null ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : ""}
            {doc.kind === "text" && doc.textContent ? ` · ${doc.textContent.length.toLocaleString()} characters` : ""}
          </p>
        </div>
        <div class="btn-row">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            hidden
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const file = input.files?.[0];
              if (file) onReplace(file);
              input.value = "";
            }}
          />
          <button type="button" class="btn btn-ghost" onClick={() => inputRef.current?.click()} disabled={busy}>
            Replace
          </button>
          <button type="button" class="btn btn-ghost" onClick={onRemove} disabled={busy}>
            Remove
          </button>
        </div>
      </div>

      <div class="badge-row">
        {ocr && (
          <span class="badge badge-ok">
            {ocr.source === "cache" ? "OCR result in local cache (use “Translate only” to reuse it)" : "OCR done"} · {ocr.text.pagesProcessed} page(s)
            {ocr.text.bboxes.length ? ` · ${ocr.text.bboxes.length} bounding box(es)` : ""}
          </span>
        )}
      </div>

      {doc.kind === "pdf" && (
        <label class="field pages-field">
          <span>Pages to OCR</span>
          <input
            type="text"
            value={doc.pageSelection}
            placeholder={doc.pageCount ? `all (1-${doc.pageCount})` : "all"}
            disabled={busy}
            aria-invalid={!!selection.error}
            onInput={(e) => onPageSelection((e.target as HTMLInputElement).value)}
          />
          <span class={`small ${selection.error ? "error-text" : "muted"}`}>
            {selection.error
              ? selection.error
              : selection.pages
                ? `${selection.pages.length} page(s) selected: ${selection.text}`
                : "Ranges or single pages, e.g. 1-3, 7. Empty = all pages."}
          </span>
        </label>
      )}

      {doc.kind === "text" ? (
        <pre class="text-preview">{(doc.textContent ?? "").slice(0, 1500)}{(doc.textContent?.length ?? 0) > 1500 ? "\n…" : ""}</pre>
      ) : (
        <div class="preview-strip" aria-label="Document preview">
          {doc.previews.map((src, i) => (
            <figure class="preview-page" key={src}>
              <img src={src} alt={`Page ${i + 1} preview`} loading="lazy" decoding="async" />
              <figcaption>{doc.kind === "image" ? "Image" : `Page ${i + 1}`}</figcaption>
            </figure>
          ))}
          {doc.previewStatus === "loading" && <div class="preview-placeholder">Rendering preview…</div>}
          {doc.previewStatus === "error" && (
            <div class="preview-placeholder preview-error">Preview unavailable: {doc.previewError}</div>
          )}
          {doc.pageCount !== null && doc.pageCount > doc.previews.length && doc.previewStatus === "ready" && (
            <div class="preview-placeholder">+{doc.pageCount - doc.previews.length} more page(s)</div>
          )}
        </div>
      )}
    </div>
  );
}
