/**
 * Registry of translation providers. The OCR step is always Mistral; the
 * chat step (schema inference + translation) can use any provider listed here.
 */
import { DEFAULT_CHAT_MODEL, FALLBACK_CHAT_MODELS, type ModelOption } from "../mistral/models";
import { DEFAULT_OPENAI_MODEL, FALLBACK_OPENAI_MODELS } from "../openai/models";
import { MistralProvider } from "./mistralProvider";
import { OpenAIProvider } from "./openaiProvider";
import type { ChatProvider, ProviderId } from "./provider";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Short name for pills and compact UI. */
  shortLabel: string;
  /** What the key is used for, shown in the key dialog. */
  purpose: string;
  /** Host the browser talks to; must be listed in the CSP (public/_headers). */
  host: string;
  keyLabel: string;
  keyUrl: string;
  defaultModel: string;
  fallbackModels: ReadonlyArray<ModelOption>;
  supportsTemperature: boolean;
  supportsReasoningEffort: boolean;
  create: (apiKey: string) => ChatProvider;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI (GPT Luna)",
    shortLabel: "OpenAI",
    purpose: "used for translation (GPT Luna)",
    host: "api.openai.com",
    keyLabel: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: DEFAULT_OPENAI_MODEL,
    fallbackModels: FALLBACK_OPENAI_MODELS,
    supportsTemperature: false,
    supportsReasoningEffort: true,
    create: (apiKey) => OpenAIProvider.fromKey(apiKey),
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    shortLabel: "Mistral",
    purpose: "used for OCR (always) and, if selected, for translation",
    host: "api.mistral.ai",
    keyLabel: "Mistral API key",
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: DEFAULT_CHAT_MODEL,
    fallbackModels: FALLBACK_CHAT_MODELS,
    supportsTemperature: true,
    supportsReasoningEffort: false,
    create: (apiKey) => MistralProvider.fromKey(apiKey),
  },
};

/** All providers, in the order they are offered for translation. */
export const PROVIDER_IDS: ProviderId[] = Object.keys(PROVIDERS) as ProviderId[];

/** The provider whose key is always required because it performs OCR. */
export const OCR_PROVIDER: ProviderId = "mistral";

export function createProvider(id: ProviderId, apiKey: string): ChatProvider {
  return PROVIDERS[id].create(apiKey);
}

/** Build a record with one entry per provider (keeps `Record<ProviderId, T>` literals out of the app). */
export function perProvider<T>(make: (id: ProviderId) => T): Record<ProviderId, T> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, make(id)])) as Record<ProviderId, T>;
}
