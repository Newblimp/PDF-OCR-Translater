import { memo } from "preact/compat";
import { maskApiKey } from "@/lib/storage/apiKeys";
import { PROVIDERS } from "@/lib/llm/registry";
import type { ProviderId } from "@/lib/llm/provider";
import type { ThemeSetting } from "@/lib/storage/settings";
import type { KeyState } from "@/app/store";
import { ThemeSwitch } from "./ThemeSwitch";
import { LogoIcon, SidePanelIcon } from "./icons";

interface Props {
  keys: Record<ProviderId, KeyState>;
  activeProvider: ProviderId;
  theme: ThemeSetting;
  onChangeKeys: () => void;
  onForgetKeys: () => void;
  onTheme: (theme: ThemeSetting) => void;
  /** The side panel (document, actions, settings) is folded into a rail. */
  sidePanelCollapsed: boolean;
  onToggleSidePanel: () => void;
}

const STATUS_LABEL: Record<KeyState["status"], string> = {
  missing: "missing",
  unverified: "not verified",
  checking: "verifying…",
  valid: "verified",
  invalid: "rejected",
};

export const Header = memo(function Header({ keys, activeProvider, theme, onChangeKeys, onForgetKeys, onTheme, sidePanelCollapsed, onToggleSidePanel }: Props) {
  const shown: ProviderId[] = activeProvider === "mistral" ? ["mistral"] : ["mistral", activeProvider];
  const anyKey = shown.some((p) => keys[p].value);
  // Shortened with an ellipsis when the bar is narrow; the tooltip keeps it whole.
  const by = activeProvider === "mistral" ? "OCR and translation by Mistral" : `OCR by Mistral, translation by ${PROVIDERS[activeProvider].label}`;
  const tagline = `${by}. Runs in your browser; documents go only to ${shown.map((p) => PROVIDERS[p].host).join(" and ")}.`;
  return (
    <header class="header">
      <button
        type="button"
        class={`btn btn-ghost header-panel-toggle${sidePanelCollapsed ? "" : " is-on"}`}
        aria-label={sidePanelCollapsed ? "Show the side panel" : "Hide the side panel"}
        title={sidePanelCollapsed ? "Show the side panel (document, actions, settings)" : "Hide the side panel (document, actions, settings)"}
        aria-expanded={!sidePanelCollapsed}
        aria-controls="side-panel"
        onClick={onToggleSidePanel}
      >
        <SidePanelIcon />
      </button>
      <div class="header-title">
        <LogoIcon />
        <div>
          <h1>
            PDF OCR<em> Translator</em>
          </h1>
          <p title={tagline}>{tagline}</p>
        </div>
      </div>
      <div class="header-key">
        {shown.map((p) => (
          <span key={p} class={`pill pill-${keys[p].status}`} title={`${PROVIDERS[p].keyLabel}: ${STATUS_LABEL[keys[p].status]}`}>
            {PROVIDERS[p].shortLabel} key {STATUS_LABEL[keys[p].status]}
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
});
