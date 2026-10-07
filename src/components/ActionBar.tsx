import { memo } from "preact/compat";
import type { JobKind, SourceOrigin } from "@/app/store";

interface Props {
  running: JobKind | null;
  canOcr: boolean;
  canTranslate: boolean;
  translateSource: SourceOrigin | null;
  hasDocument: boolean;
  /** Token/cost estimate of the translation, when one can be made. */
  estimate: string | null;
  onRun: (kind: "ocr" | "translate" | "both") => void;
  onCancel: () => void;
}

const SOURCE_LABEL = {
  ocr: "Translates the OCR text of the loaded document.",
  textfile: "Translates the text file.",
  pasted: "Translates the pasted text.",
  saved: "Translates the source text of the reopened translation again.",
} as const;

export const ActionBar = memo(function ActionBar({ running, canOcr, canTranslate, translateSource, hasDocument, estimate, onRun, onCancel }: Props) {
  const translateHint = translateSource
    ? SOURCE_LABEL[translateSource]
    : hasDocument
      ? "Run OCR first (or drop a text file / paste text) to enable translation."
      : "";
  const label = translateSource === "saved" ? "Translate again" : "Translate only";

  return (
    <div class="action-bar">
      <div class="btn-row">
        <button type="button" class="btn btn-primary" disabled={!canOcr || !!running} onClick={() => onRun("both")}>
          OCR + Translate
        </button>
        <button type="button" class="btn" disabled={!canOcr || !!running} onClick={() => onRun("ocr")}>
          OCR only
        </button>
        <button
          type="button"
          class="btn"
          disabled={!canTranslate || !!running}
          title={translateHint}
          onClick={() => onRun("translate")}
        >
          {label}
        </button>
        {running && (
          <button type="button" class="btn btn-danger" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {(hasDocument || translateSource) && !running && <p class="muted small">{translateHint}</p>}
      {estimate && !running && <p class="muted small estimate">{estimate}</p>}
    </div>
  );
});
