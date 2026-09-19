/**
 * Theme handling. The choice is stored with the other settings; this module
 * only applies it to the document so CSS can react via `[data-theme]`.
 * "system" removes the attribute and lets `prefers-color-scheme` decide.
 */
import type { ThemeSetting } from "./settings";

export function applyTheme(theme: ThemeSetting): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}
