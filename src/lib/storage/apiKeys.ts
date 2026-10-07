/**
 * API key persistence, one key per provider. Keys are kept in localStorage of
 * this origin, or, when the user turns "Remember keys" off, in sessionStorage
 * (gone when the tab closes). They are never embedded in the build or sent
 * anywhere except the provider's own API (see the CSP in public/_headers).
 */
import type { ProviderId } from "../llm/provider";

const STORAGE_PREFIX = "pdf-ocr-translater.apiKey";
/** Key name used by the first release (Mistral only); migrated on load. */
const LEGACY_MISTRAL_KEY = "pdf-ocr-translater.apiKey";

function storageKey(provider: ProviderId): string {
  return `${STORAGE_PREFIX}.${provider}`;
}

export function loadApiKey(provider: ProviderId): string | null {
  try {
    let value = localStorage.getItem(storageKey(provider)) ?? sessionStorage.getItem(storageKey(provider));
    if (!value && provider === "mistral") {
      value = localStorage.getItem(LEGACY_MISTRAL_KEY);
      if (value) {
        localStorage.setItem(storageKey("mistral"), value);
        localStorage.removeItem(LEGACY_MISTRAL_KEY);
      }
    }
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Store a key in localStorage (`remember`) or sessionStorage, removing it from the other. */
export function saveApiKey(provider: ProviderId, key: string, remember = true): void {
  try {
    const [keep, drop] = remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
    keep.setItem(storageKey(provider), key.trim());
    drop.removeItem(storageKey(provider));
  } catch {
    // Storage unavailable (private mode): the key lives in memory only.
  }
}

export function clearApiKey(provider: ProviderId): void {
  try {
    localStorage.removeItem(storageKey(provider));
    sessionStorage.removeItem(storageKey(provider));
  } catch {
    // ignore
  }
}

/** Show only the tail of a key in the UI. */
export function maskApiKey(key: string): string {
  if (key.length <= 6) return "••••";
  return `••••${key.slice(-4)}`;
}
