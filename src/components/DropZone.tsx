import { useRef, useState } from "preact/hooks";
import { ACCEPT_ATTRIBUTE } from "@/lib/files/fileKind";

interface Props {
  onFile: (file: File) => void;
  onPaste: () => void;
}

export function DropZone({ onFile, onPaste }: Props) {
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      class={`dropzone${active ? " dropzone-active" : ""}`}
      role="button"
      tabIndex={0}
      aria-label="Drop a PDF here or press Enter to choose a file"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        pick(e.dataTransfer?.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        hidden
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          pick(input.files);
          input.value = "";
        }}
      />
      <div class="dropzone-icon" aria-hidden="true">
        ⇩
      </div>
      <p class="dropzone-title">Drop a PDF here, or click to choose a file</p>
      <p class="muted">PDF, PNG, JPEG or WebP for OCR · .txt / .md for translation only · up to 50 MB</p>
      <button
        type="button"
        class="btn btn-link"
        onClick={(e) => {
          e.stopPropagation();
          onPaste();
        }}
      >
        …or paste text to translate
      </button>
    </div>
  );
}
