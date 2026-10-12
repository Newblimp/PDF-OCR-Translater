import { useEffect, useRef, useState } from "preact/hooks";

interface DraftProps {
  value: string;
  /** Called on blur / Enter with the trimmed text (or `fallback` when empty). */
  onCommit: (value: string) => void;
  fallback?: string;
  placeholder?: string;
  rows?: number;
  class?: string;
  spellcheck?: boolean;
  "aria-label"?: string;
}

/**
 * Text input that keeps a local draft while focused and commits on blur or
 * Enter. Controlled inputs that commit on every keystroke would be reset by
 * unrelated re-renders (streaming progress, model lists arriving).
 */
export function DraftText({ value, onCommit, fallback, rows, ...rest }: DraftProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim() || fallback || "";
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  const common = {
    value: draft,
    onFocus: () => {
      focused.current = true;
    },
    onInput: (e: Event) => setDraft((e.target as HTMLInputElement | HTMLTextAreaElement).value),
    onBlur: () => {
      focused.current = false;
      commit();
    },
    ...rest,
  };
  if (rows) return <textarea rows={rows} {...common} />;
  return (
    <input
      type="text"
      {...common}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
