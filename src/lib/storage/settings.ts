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
  /** Optional ceiling for generated tokens per translation; null = provider default (model maximum). */
  maxOutputTokens: number | null;
}

const VERSION = 2;
const STORAGE_KEY = `pdf-ocr-translater.settings.v${VERSION}`;
/** Read once and removed: the first release stored a single `chatModel` (Mistral) and a free-text target language. */
const LEGACY_V1_KEY = "pdf-ocr-translater.settings.v1";
/** Keep in sync with public/theme-init.js, which reads the theme before the bundle loads. */
export const SETTINGS_STORAGE_KEY = STORAGE_KEY;

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
  maxOutputTokens: null,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateV1() ?? structuredClone(DEFAULT_SETTINGS);
    return normalise(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** Merge a stored (possibly partial or invalid) object over the defaults. */
function normalise(parsed: Partial<Settings>): Settings {
  const merged: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...parsed,
    chatModels: { ...DEFAULT_SETTINGS.chatModels, ...(parsed.chatModels ?? {}) },
  };
  if (!(TARGET_LANGUAGES as readonly string[]).includes(merged.targetLanguage)) merged.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
  if (!(merged.provider in PROVIDERS)) merged.provider = DEFAULT_SETTINGS.provider;
  if (!["system", "light", "dark"].includes(merged.theme)) merged.theme = "system";
  if (!["none", "low", "medium", "high"].includes(merged.reasoningEffort)) merged.reasoningEffort = DEFAULT_SETTINGS.reasoningEffort;
  if (typeof merged.maxOutputTokens !== "number" || !Number.isFinite(merged.maxOutputTokens) || merged.maxOutputTokens <= 0) merged.maxOutputTokens = null;
  return merged;
}

/** Carry compatible v1 fields over, store them as v2 and drop the v1 entry. */
function migrateV1(): Settings | null {
  const raw = localStorage.getItem(LEGACY_V1_KEY);
  if (!raw) return null;
  try {
    const v1 = JSON.parse(raw) as Partial<Settings> & { chatModel?: string; targetLanguage?: string };
    const { chatModel, ...rest } = v1;
    const migrated = normalise({
      ...rest,
      ...(chatModel ? { chatModels: { ...DEFAULT_SETTINGS.chatModels, mistral: chatModel } } : {}),
    } as Partial<Settings>);
    saveSettings(migrated);
    localStorage.removeItem(LEGACY_V1_KEY);
    return migrated;
  } catch {
    localStorage.removeItem(LEGACY_V1_KEY);
    return null;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings then live in memory only.
  }
}
