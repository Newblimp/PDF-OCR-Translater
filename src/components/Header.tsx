import { maskApiKey } from "@/lib/storage/apiKey";
import type { AppState } from "@/app/store";

interface Props {
  keyStatus: AppState["keyStatus"];
  apiKey: string | null;
  onChangeKey: () => void;
  onForgetKey: () => void;
}

const STATUS_LABEL: Record<AppState["keyStatus"], string> = {
  missing: "No API key",
  unverified: "Key saved (not verified)",
  checking: "Verifying key…",
  valid: "Key verified",
  invalid: "Key rejected",
};

export function Header({ keyStatus, apiKey, onChangeKey, onForgetKey }: Props) {
  return (
    <header class="header">
      <div class="header-title">
        <h1>PDF OCR Translator</h1>
        <p class="muted">Mistral Document AI, entirely in your browser. Documents go only to api.mistral.ai.</p>
      </div>
      <div class="header-key">
        <span class={`pill pill-${keyStatus}`} title={STATUS_LABEL[keyStatus]}>
          {STATUS_LABEL[keyStatus]}
          {apiKey && keyStatus !== "missing" ? ` · ${maskApiKey(apiKey)}` : ""}
        </span>
        <button type="button" class="btn btn-ghost" onClick={onChangeKey}>
          {apiKey ? "Change key" : "Enter key"}
        </button>
        {apiKey && (
          <button type="button" class="btn btn-ghost" onClick={onForgetKey} title="Remove the key from this browser">
            Forget
          </button>
        )}
      </div>
    </header>
  );
}
