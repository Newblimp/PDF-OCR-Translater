/** User settings, persisted in localStorage. Bump VERSION when the shape changes. */
import { DEFAULT_CHAT_MODEL, DEFAULT_OCR_MODEL } from "../mistral/models";
import { DEFAULT_DOMAIN_HINT } from "../pipeline/prompts";

export type SchemaModeSetting =
  | { kind: "infer" }
  | { kind: "builtin"; id: string }
  | { kind: "custom"; schemaText: string };

export interface Settings {
  ocrModel: string;
  chatModel: string;
  targetLanguage: string;
  sourceLanguage: string;
  domainHint: string;
  schemaMode: SchemaModeSetting;
  streaming: boolean;
  temperature: number;
  /** Cache OCR results in this browser (IndexedDB) so "Translate only" can reuse them. */
  cacheOcr: boolean;
}

const VERSION = 1;
const STORAGE_KEY = `pdf-ocr-translater.settings.v${VERSION}`;

export const DEFAULT_SETTINGS: Settings = {
  ocrModel: DEFAULT_OCR_MODEL,
  chatModel: DEFAULT_CHAT_MODEL,
  targetLanguage: "English",
  sourceLanguage: "auto",
  domainHint: DEFAULT_DOMAIN_HINT,
  schemaMode: { kind: "infer" },
  streaming: true,
  temperature: 0.2,
  cacheOcr: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings then live in memory only.
  }
}
