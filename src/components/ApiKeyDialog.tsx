import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "@/app/store";

interface Props {
  status: AppState["keyStatus"];
  canClose: boolean;
  errorMessage: string | null;
  onSubmit: (key: string) => Promise<boolean>;
  onClose: () => void;
}

export function ApiKeyDialog({ status, canClose, errorMessage, onSubmit, onClose }: Props) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status === "checking";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!canClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canClose, onClose]);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    void onSubmit(value);
  };

  return (
    <div class="modal-backdrop" role="presentation">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="key-title" onSubmit={submit}>
        <h2 id="key-title">Mistral API key</h2>
        <p>
          This app calls the Mistral API directly from your browser. The key is cached in this browser's local
          storage only and is never sent anywhere else. Create one at{" "}
          <a href="https://console.mistral.ai/api-keys" target="_blank" rel="noopener noreferrer">
            console.mistral.ai/api-keys
          </a>
          .
        </p>
        <label class="field">
          <span>API key</span>
          <div class="input-row">
            <input
              ref={inputRef}
              type={show ? "text" : "password"}
              autocomplete="off"
              spellcheck={false}
              value={value}
              disabled={busy}
              placeholder="Paste your key"
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            />
            <button type="button" class="btn btn-ghost" onClick={() => setShow((s) => !s)} aria-pressed={show}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        {errorMessage && <p class="error-text">{errorMessage}</p>}
        <div class="modal-actions">
          {canClose && (
            <button type="button" class="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" class="btn btn-primary" disabled={busy || !value.trim()}>
            {busy ? "Verifying…" : "Save and verify"}
          </button>
        </div>
      </form>
    </div>
  );
}
