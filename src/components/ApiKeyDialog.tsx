import { useEffect, useRef, useState } from "preact/hooks";
import type { ProviderId } from "@/lib/llm/provider";
import { PROVIDERS } from "@/lib/llm/registry";
import type { KeyState } from "@/app/store";

interface Props {
  keys: Record<ProviderId, KeyState>;
  /** Providers whose key is needed for the current settings. */
  required: ProviderId[];
  canClose: boolean;
  onSubmit: (keys: Partial<Record<ProviderId, string>>) => Promise<void>;
  onClose: () => void;
}

const PURPOSE: Record<ProviderId, string> = {
  mistral: "used for OCR (Mistral Document AI)",
  openai: "used for translation (GPT Luna)",
};

export function ApiKeyDialog({ keys, required, canClose, onSubmit, onClose }: Props) {
  const providers: ProviderId[] = ["mistral", "openai"];
  const [values, setValues] = useState<Record<ProviderId, string>>({
    mistral: keys.mistral.value ?? "",
    openai: keys.openai.value ?? "",
  });
  const [show, setShow] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const busy = providers.some((p) => keys[p].status === "checking");
  const complete = required.every((p) => values[p].trim());

  useEffect(() => {
    firstRef.current?.focus();
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
    if (busy || !complete) return;
    const entered: Partial<Record<ProviderId, string>> = {};
    for (const p of providers) {
      if (values[p].trim() || keys[p].value) entered[p] = values[p];
    }
    void onSubmit(entered);
  };

  return (
    <div class="modal-backdrop" role="presentation">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="key-title" onSubmit={submit}>
        <h2 id="key-title">API keys</h2>
        <p>
          This app calls the providers' APIs directly from your browser. Keys are cached in this browser's local storage only
          and are never sent anywhere else.
        </p>
        {providers.map((p, i) => {
          const info = PROVIDERS[p];
          const isRequired = required.includes(p);
          return (
            <label class="field" key={p}>
              <span>
                {info.keyLabel} <span class="muted">— {PURPOSE[p]}{isRequired ? "" : " (optional)"}</span>
              </span>
              <div class="input-row">
                <input
                  {...(i === 0 ? { ref: firstRef } : {})}
                  type={show ? "text" : "password"}
                  autocomplete="off"
                  spellcheck={false}
                  value={values[p]}
                  disabled={busy}
                  placeholder={`Paste your ${info.label} key`}
                  aria-invalid={keys[p].status === "invalid"}
                  onInput={(e) => setValues((v) => ({ ...v, [p]: (e.target as HTMLInputElement).value }))}
                />
                <a href={info.keyUrl} target="_blank" rel="noopener noreferrer" class="btn btn-ghost small">
                  Get key
                </a>
              </div>
              {keys[p].error && <span class="error-text small">{keys[p].error}</span>}
            </label>
          );
        })}
        <label class="checkbox small">
          <input type="checkbox" checked={show} onChange={(e) => setShow((e.target as HTMLInputElement).checked)} />
          <span>Show keys</span>
        </label>
        <div class="modal-actions">
          {canClose && (
            <button type="button" class="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" class="btn btn-primary" disabled={busy || !complete}>
            {busy ? "Verifying…" : "Save and verify"}
          </button>
        </div>
      </form>
    </div>
  );
}
