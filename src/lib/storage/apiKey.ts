/**
 * API key persistence. The key is cached in localStorage of this origin
 * only, as requested; it is never embedded in the build or sent anywhere
 * except the Mistral API (see the CSP in public/_headers).
 */
const STORAGE_KEY = "pdf-ocr-translater.apiKey";

export function loadApiKey(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function saveApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Show only the tail of a key in the UI. */
export function maskApiKey(key: string): string {
  if (key.length <= 6) return "••••";
  return `••••${key.slice(-4)}`;
}
