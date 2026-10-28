/** Settings changes, with what they take along: saving them, the theme, where the keys are kept, the key dialog. */
import { PROVIDER_IDS } from "@/lib/llm/registry";
import { loadApiKey, saveApiKey } from "@/lib/storage/apiKeys";
import { saveSettings, type Settings } from "@/lib/storage/settings";
import { applyTheme } from "@/lib/storage/theme";
import { missingKeys } from "../store";
import type { Runtime } from "./runtime";

export function updateSettings(rt: Runtime, patch: Partial<Settings>): void {
  const before = rt.getState().settings;
  rt.dispatch({ type: "settings/update", patch });
  const settings = rt.getState().settings;
  saveSettings(settings);
  if (patch.theme) applyTheme(patch.theme);
  // "Remember keys" changed: move the stored keys between localStorage and sessionStorage.
  if (patch.rememberKeys !== undefined && patch.rememberKeys !== before.rememberKeys) {
    for (const provider of PROVIDER_IDS) {
      const stored = loadApiKey(provider);
      if (stored) saveApiKey(provider, stored, patch.rememberKeys);
    }
  }
  // Switching to a provider without a usable key: ask for it right away.
  if (patch.provider && missingKeys(rt.getState(), settings).length > 0) rt.dispatch({ type: "key/dialog", open: true });
}
