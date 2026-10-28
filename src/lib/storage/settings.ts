/** User settings, persisted in localStorage. Bump VERSION when the shape changes. */
import type { ProviderId, ReasoningEffort } from "../llm/provider";
import type { StructureOriginalMode } from "../pipeline/pipeline";
import { isProviderId } from "../apiProviders";
import { perProvider, PROVIDERS } from "../llm/registry";
import { DEFAULT_OCR_MODEL } from "../mistral/models";

export type SchemaModeSetting = { kind: "infer" } | { kind: "builtin"; id: string } | { kind: "custom"; schemaText: string };

export type ThemeSetting = "system" | "light" | "dark";

/** Languages offered as translation targets. Add entries here to extend the list. */
export const TARGET_LANGUAGES = [
  "English",
  "German",
  "French",
  "Spanish",
  "Italian",
  "Portuguese",
  "Dutch",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
] as const;
/** Shown as one-click buttons; the rest are in a dropdown next to them. */
export const QUICK_TARGET_LANGUAGES: ReadonlyArray<TargetLanguage> = ["English", "German"];
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

/** The document family the prompts describe by default (Settings → "Document family hint"). */
export const DEFAULT_DOMAIN_HINT =
  "Official communications from a patent office (for example CNIPA, the China National Intellectual Property Administration): office actions, notifications, decisions and similar correspondence to applicants or agents.";

export interface Settings {
  /** Provider used for translation (and schema inference). OCR is always Mistral. */
  provider: ProviderId;
  ocrModel: string;
  /** Chat model per provider, so switching providers keeps each choice. */
  chatModels: Record<ProviderId, string>;
  targetLanguage: TargetLanguage;
  sourceLanguage: string;
  domainHint: string;
  schemaMode: SchemaModeSetting;
  streaming: boolean;
  /** Mistral only; OpenAI GPT-5.x and current Claude models do not accept a temperature. */
  temperature: number;
  /** Every provider (Mistral offers "none" and "high"; Anthropic's lowest is "low"). "none", the default, keeps translation fast and cheap. */
  reasoningEffort: ReasoningEffort;
  /** Cache OCR results in this browser (IndexedDB) so "Translate only" can reuse them. */
  cacheOcr: boolean;
  theme: ThemeSetting;
  /** Optional ceiling for generated tokens per translation; null = provider default (model maximum). */
  maxOutputTokens: number | null;
  /** Send the first bounding-box images with the text to the vision model (document annotation). */
  sendImages: boolean;
  /** Describe each bounding box with the vision model (bbox annotation). */
  bboxAnnotations: boolean;
  /** Upper bound on bounding boxes described per run (cost control). */
  maxBboxAnnotations: number;
  /** With the JSON format: also translate each OCR text block so the bounding-box view and the OCR text view can show it. */
  blockTranslations: boolean;
  /**
   * Fill the JSON format with the document's own wording too, so "Structured
   * text" can show the original: after every translation, only when "Show
   * translation" is switched off (the default, saving a full generation), or never.
   */
  structureOriginal: StructureOriginalMode;
  /** Required terminology, one `source = target` pair per line; empty = none. */
  glossary: string;
  /** Keep API keys in localStorage (true) or only for this browser tab's session (false). */
  rememberKeys: boolean;
  /** Keep finished translations in this browser (IndexedDB) for the "Recent translations" list. */
  saveTranslations: boolean;
  /**
   * Fill a JSON format with the translation (schema inference or a given
   * schema, then the document annotation) and show the Structured text, JSON
   * format and Raw JSON tabs. Off: the OCR text is translated block by block.
   */
  jsonOutput: boolean;
  /** OCR text tab: show the document's pages beside the text. */
  ocrShowPdf: boolean;
  /** OCR text tab: scroll the pages and the text together, page by page. */
  ocrLinkScroll: boolean;
  /** OCR text tab: block types left out of the text (and not translated block by block). */
  ocrHiddenTypes: string[];
  /** OCR text tab: place each block where it is on the page, its text sized to fit. */
  ocrMatchLayout: boolean;
  /** OCR text tab: the blocks are drawn over the pages beside the text, and clicking one leaves it out or takes it back. */
  ocrPickBlocks: boolean;
  /** The side panel (document, actions, settings, recent translations) is folded into a narrow rail. */
  sidePanelCollapsed: boolean;
  /** Number of default migrations applied (see DEFAULT_MIGRATIONS); each runs once. */
  modelDefaultsRevision: number;
}

/**
 * Defaults that a newer one replaced (a provider's model, or the provider).
 * Each entry moves a saved choice that still holds the old default over
 * once; picking the old one again later sticks. Append entries; the revision
 * is the entry's 1-based position.
 */
type DefaultMigration = { kind: "model"; provider: ProviderId; from: string; to: string } | { kind: "provider"; from: ProviderId; to: ProviderId };

const DEFAULT_MIGRATIONS: ReadonlyArray<DefaultMigration> = [
  { kind: "model", provider: "openai", from: "gpt-5.6-luna", to: PROVIDERS.openai.defaultModel },
  // Mistral Small replaced Claude Haiku 5.5 as the default translation model.
  { kind: "provider", from: "anthropic", to: "mistral" },
  { kind: "model", provider: "mistral", from: "mistral-large-latest", to: PROVIDERS.mistral.defaultModel },
];

const VERSION = 2;
const STORAGE_KEY = `pdf-ocr-translater.settings.v${VERSION}`;
/** Read once and removed: the first release stored a single `chatModel` (Mistral) and a free-text target language. */
const LEGACY_V1_KEY = "pdf-ocr-translater.settings.v1";
/** Keep in sync with public/theme-init.js, which reads the theme before the bundle loads. */
export const SETTINGS_STORAGE_KEY = STORAGE_KEY;

export const DEFAULT_SETTINGS: Settings = {
  provider: "mistral",
  ocrModel: DEFAULT_OCR_MODEL,
  chatModels: { anthropic: PROVIDERS.anthropic.defaultModel, openai: PROVIDERS.openai.defaultModel, mistral: PROVIDERS.mistral.defaultModel },
  targetLanguage: "English",
  sourceLanguage: "auto",
  domainHint: DEFAULT_DOMAIN_HINT,
  schemaMode: { kind: "infer" },
  streaming: true,
  temperature: 0.2,
  reasoningEffort: "none",
  cacheOcr: true,
  theme: "dark",
  maxOutputTokens: null,
  sendImages: true,
  bboxAnnotations: true,
  maxBboxAnnotations: 20,
  blockTranslations: true,
  structureOriginal: "on_demand",
  glossary: "",
  rememberKeys: true,
  saveTranslations: true,
  jsonOutput: false,
  ocrShowPdf: false,
  ocrLinkScroll: true,
  // Mistral OCR moves page headers and footers out of the page text (extract_header / extract_footer); their blocks stay out too.
  ocrHiddenTypes: ["header", "footer"],
  ocrMatchLayout: false,
  ocrPickBlocks: false,
  sidePanelCollapsed: false,
  modelDefaultsRevision: DEFAULT_MIGRATIONS.length,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateV1() ?? structuredClone(DEFAULT_SETTINGS);
    return normalise(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

const REASONING_EFFORTS: readonly string[] = ["none", "low", "medium", "high"] satisfies ReasoningEffort[];
const THEMES: readonly string[] = ["system", "light", "dark"] satisfies ThemeSetting[];

/**
 * What a stored value must be beyond having its default's type (checked for
 * every setting); a value that is not falls back to the default. A setting
 * whose default is an object or null needs an entry here or in `normalise()`.
 */
const VALID: { [K in keyof Settings]?: (value: unknown) => boolean } = {
  provider: isProviderId,
  targetLanguage: (v) => (TARGET_LANGUAGES as readonly unknown[]).includes(v),
  theme: (v) => THEMES.includes(v as string),
  reasoningEffort: (v) => REASONING_EFFORTS.includes(v as string),
  ocrModel: (v) => typeof v === "string" && v.trim() !== "",
  temperature: (v) => typeof v === "number" && v >= 0 && v <= 1,
  maxBboxAnnotations: (v) => Number.isInteger(v) && (v as number) >= 0,
  ocrHiddenTypes: (v) => Array.isArray(v) && v.every((t) => typeof t === "string"),
  schemaMode: isSchemaModeSetting,
};

function isFiniteIfNumber(v: unknown): boolean {
  return typeof v !== "number" || Number.isFinite(v);
}

function isSchemaModeSetting(v: unknown): v is SchemaModeSetting {
  if (typeof v !== "object" || v === null) return false;
  const mode = v as Record<string, unknown>;
  return (
    mode["kind"] === "infer" ||
    (mode["kind"] === "builtin" && typeof mode["id"] === "string") ||
    (mode["kind"] === "custom" && typeof mode["schemaText"] === "string")
  );
}

/**
 * The settings in a stored (possibly partial, outdated or hand-edited)
 * object: each setting that is there and valid, the default for the rest.
 * Keys that are not settings (any more) are dropped.
 */
function normalise(stored: unknown): Settings {
  const parsed = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const merged = structuredClone(DEFAULT_SETTINGS);
  const values = merged as unknown as Record<keyof Settings, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const value = parsed[key];
    const fallback = DEFAULT_SETTINGS[key];
    const sameType = typeof fallback === "object" && fallback !== null ? typeof value === "object" && value !== null : typeof value === typeof fallback;
    if (sameType && (VALID[key] ?? isFiniteIfNumber)(value)) values[key] = structuredClone(value);
  }
  // One model per provider, each falling back on its own.
  const models = (typeof parsed["chatModels"] === "object" && parsed["chatModels"] !== null ? parsed["chatModels"] : {}) as Record<string, unknown>;
  merged.chatModels = perProvider((id) => {
    const model = models[id];
    return typeof model === "string" && model.trim() ? model : DEFAULT_SETTINGS.chatModels[id];
  });
  const max = parsed["maxOutputTokens"];
  merged.maxOutputTokens = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : null;
  merged.structureOriginal = structureOriginalMode(parsed["structureOriginal"]);
  const revision = typeof parsed["modelDefaultsRevision"] === "number" ? parsed["modelDefaultsRevision"] : 0;
  for (const m of DEFAULT_MIGRATIONS.slice(revision)) {
    if (m.kind === "provider") {
      if (merged.provider === m.from) merged.provider = m.to;
    } else if (merged.chatModels[m.provider] === m.from) {
      merged.chatModels[m.provider] = m.to;
    }
  }
  merged.modelDefaultsRevision = DEFAULT_MIGRATIONS.length;
  return merged;
}

/** Earlier releases stored a boolean (always / never); "always" becomes the cheaper on-demand default. */
function structureOriginalMode(value: unknown): StructureOriginalMode {
  if (value === "always" || value === "on_demand" || value === "never") return value;
  if (value === false) return "never";
  return DEFAULT_SETTINGS.structureOriginal;
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
