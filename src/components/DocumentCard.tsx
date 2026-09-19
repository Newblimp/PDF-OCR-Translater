import { useRef } from "preact/hooks";
import { ACCEPT_ATTRIBUTE } from "@/lib/files/fileKind";
import { formatBytes } from "@/lib/util/text";
import type { DocState, OcrState } from "@/app/store";

interface Props {
  doc: DocState;
  ocr: OcrState | null;
  busy: boolean;
  showPreview: boolean;
  onTogglePreview: (show: boolean) => void;
  onReplace: (file: File) => void;
  onRemove: () => void;
}

const KIND_LABEL = { pdf: "PDF", image: "Image", text: "Text" } as const;

export function DocumentCard({ doc, ocr, busy, showPreview, onTogglePreview, onReplace, onRemove }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
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
        <label class="checkbox small preview-toggle">
          <input type="checkbox" checked={showPreview} onChange={(e) => onTogglePreview((e.target as HTMLInputElement).checked)} />
          <span>Show document preview</span>
        </label>
      </div>

      {!showPreview ? null : doc.kind === "text" ? (
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
