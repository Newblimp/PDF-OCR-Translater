import { maskApiKey } from "@/lib/storage/apiKeys";
import { PROVIDERS } from "@/lib/llm/registry";
import type { ProviderId } from "@/lib/llm/provider";
import type { ThemeSetting } from "@/lib/storage/settings";
import type { KeyState } from "@/app/store";
import { ThemeSwitch } from "./ThemeSwitch";

interface Props {
  keys: Record<ProviderId, KeyState>;
  activeProvider: ProviderId;
  theme: ThemeSetting;
  onChangeKeys: () => void;
  onForgetKeys: () => void;
  onTheme: (theme: ThemeSetting) => void;
}

const STATUS_LABEL: Record<KeyState["status"], string> = {
  missing: "missing",
  unverified: "not verified",
  checking: "verifying…",
  valid: "verified",
  invalid: "rejected",
};

const SHORT: Record<ProviderId, string> = { mistral: "Mistral", openai: "OpenAI" };

export function Header({ keys, activeProvider, theme, onChangeKeys, onForgetKeys, onTheme }: Props) {
  const shown: ProviderId[] = activeProvider === "mistral" ? ["mistral"] : ["mistral", activeProvider];
  const anyKey = shown.some((p) => keys[p].value);
  return (
    <header class="header">
      <div class="header-title">
        <h1>PDF OCR Translator</h1>
        <p class="muted">
          OCR by Mistral, translation by {PROVIDERS[activeProvider].label}. Runs in your browser; documents go only to{" "}
          {shown.map((p) => PROVIDERS[p].host).join(" and ")}.
        </p>
      </div>
      <div class="header-key">
        {shown.map((p) => (
          <span key={p} class={`pill pill-${keys[p].status}`} title={`${PROVIDERS[p].keyLabel}: ${STATUS_LABEL[keys[p].status]}`}>
            {SHORT[p]} key {STATUS_LABEL[keys[p].status]}
            {keys[p].value ? ` · ${maskApiKey(keys[p].value)}` : ""}
          </span>
        ))}
        <button type="button" class="btn btn-ghost" onClick={onChangeKeys}>
          {anyKey ? "Keys" : "Enter keys"}
        </button>
        {anyKey && (
          <button type="button" class="btn btn-ghost" onClick={onForgetKeys} title="Remove all keys from this browser">
            Forget
          </button>
        )}
        <ThemeSwitch value={theme} onChange={onTheme} />
      </div>
    </header>
  );
}
