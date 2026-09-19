import type { JobKind } from "@/app/store";

interface Props {
  running: JobKind | null;
  canOcr: boolean;
  canTranslate: boolean;
  translateSource: "ocr" | "textfile" | "pasted" | null;
  hasDocument: boolean;
  onRun: (kind: JobKind) => void;
  onCancel: () => void;
}

const SOURCE_LABEL = {
  ocr: "Translates the OCR text of the loaded document.",
  textfile: "Translates the text file.",
  pasted: "Translates the pasted text.",
} as const;

export function ActionBar({ running, canOcr, canTranslate, translateSource, hasDocument, onRun, onCancel }: Props) {
  const translateHint = translateSource
    ? SOURCE_LABEL[translateSource]
    : hasDocument
      ? "Run OCR first (or drop a text file / paste text) to enable translation."
      : "";

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
          Translate only
        </button>
        {running && (
          <button type="button" class="btn btn-danger" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {hasDocument && !running && <p class="muted small">{translateHint}</p>}
    </div>
  );
}
