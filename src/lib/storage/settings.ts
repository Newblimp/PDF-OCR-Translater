/** User settings, persisted in localStorage. Bump VERSION when the shape changes. */
import type { ProviderId, ReasoningEffort } from "../llm/provider";
import { PROVIDERS } from "../llm/registry";
import { DEFAULT_OCR_MODEL } from "../mistral/models";
import { DEFAULT_DOMAIN_HINT } from "../pipeline/prompts";

export type SchemaModeSetting =
  | { kind: "infer" }
  | { kind: "builtin"; id: string }
  | { kind: "custom"; schemaText: string };

export type ThemeSetting = "system" | "light" | "dark";

/** Languages offered by the target-language toggle. Add entries here to extend it. */
export const TARGET_LANGUAGES = ["English", "German"] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export interface Settings {
  /** Provider used for schema inference and translation. OCR is always Mistral. */
  provider: ProviderId;
  ocrModel: string;
  /** Chat model per provider, so switching providers keeps each choice. */
  chatModels: Record<ProviderId, string>;
  targetLanguage: TargetLanguage;
  sourceLanguage: string;
  domainHint: string;
  schemaMode: SchemaModeSetting;
  streaming: boolean;
  /** Mistral only; OpenAI GPT-5.x models do not accept a temperature. */
  temperature: number;
  /** OpenAI only. "none" keeps translation fast and cheap. */
  reasoningEffort: ReasoningEffort;
  /** Cache OCR results in this browser (IndexedDB) so "Translate only" can reuse them. */
  cacheOcr: boolean;
  theme: ThemeSetting;
}

const VERSION = 2;
const STORAGE_KEY = `pdf-ocr-translater.settings.v${VERSION}`;

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  ocrModel: DEFAULT_OCR_MODEL,
  chatModels: { openai: PROVIDERS.openai.defaultModel, mistral: PROVIDERS.mistral.defaultModel },
  targetLanguage: "English",
  sourceLanguage: "auto",
  domainHint: DEFAULT_DOMAIN_HINT,
  schemaMode: { kind: "infer" },
  streaming: true,
  temperature: 0.2,
  reasoningEffort: "none",
  cacheOcr: true,
  theme: "system",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      chatModels: { ...DEFAULT_SETTINGS.chatModels, ...(parsed.chatModels ?? {}) },
    };
    if (!(TARGET_LANGUAGES as readonly string[]).includes(merged.targetLanguage)) merged.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
    if (!(merged.provider in PROVIDERS)) merged.provider = DEFAULT_SETTINGS.provider;
    if (!["system", "light", "dark"].includes(merged.theme)) merged.theme = "system";
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings then live in memory only.
  }
}
