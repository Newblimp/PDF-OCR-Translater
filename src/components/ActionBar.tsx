import { memo } from "preact/compat";
import type { JobKind, SourceOrigin } from "@/app/store";

interface Props {
  running: JobKind | null;
  /** What "Translate" does (`primaryAction()`): OCR first ("both"), translate the text at hand, or nothing yet. */
  primary: "both" | "translate" | null;
  /** "both" reuses the OCR result already loaded for these pages. */
  reusesOcr: boolean;
  /** Where the text "translate" translates comes from. */
  translateSource: SourceOrigin | null;
  /** A PDF or an image is loaded: "OCR only" is offered. */
  ocrDocument: boolean;
  onRun: (kind: "ocr" | "translate" | "both") => void;
  onCancel: () => void;
}

const SOURCE_HINT: Record<SourceOrigin, string> = {
  ocr: "Translates the OCR text of the reopened document.",
  textfile: "Translates the text file.",
  pasted: "Translates the pasted text.",
  saved: "Translates the source text of the reopened translation again.",
};

/** The one main action, "Translate" (with OCR first when a PDF or image needs it), and "OCR only" beside it. */
export const ActionBar = memo(function ActionBar({ running, primary, reusesOcr, translateSource, ocrDocument, onRun, onCancel }: Props) {
  const hint =
    primary === "both"
      ? reusesOcr
        ? "Translates the text already read from this document: no new OCR."
        : "Reads the text with Mistral OCR, then translates it."
      : primary === "translate" && translateSource
        ? SOURCE_HINT[translateSource]
        : "";
  return (
    <div class="action-bar">
      <div class="btn-row">
        {running ? (
          <button type="button" class="btn btn-danger btn-wide" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" class="btn btn-primary btn-wide" disabled={!primary} onClick={() => primary && onRun(primary)}>
            {translateSource === "saved" && primary === "translate" ? "Translate again" : "Translate"}
          </button>
        )}
        {ocrDocument && (
          <button
            type="button"
            class="btn btn-ghost"
            disabled={!!running}
            onClick={() => onRun("ocr")}
            title="Read the text with Mistral OCR without translating it"
          >
            OCR only
          </button>
        )}
      </div>
      {hint && !running && <p class="muted small">{hint}</p>}
    </div>
  );
});
