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
  /** Host the browser talks to; must be listed in the CSP (public/_headers). */
  host: string;
  keyLabel: string;
  keyUrl: string;
  defaultModel: string;
  fallbackModels: ReadonlyArray<ModelOption>;
  supportsTemperature: boolean;
  supportsReasoningEffort: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI (GPT Luna)",
    host: "api.openai.com",
    keyLabel: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: DEFAULT_OPENAI_MODEL,
    fallbackModels: FALLBACK_OPENAI_MODELS,
    supportsTemperature: false,
    supportsReasoningEffort: true,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    host: "api.mistral.ai",
    keyLabel: "Mistral API key",
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: DEFAULT_CHAT_MODEL,
    fallbackModels: FALLBACK_CHAT_MODELS,
    supportsTemperature: true,
    supportsReasoningEffort: false,
  },
};

export const PROVIDER_IDS: ProviderId[] = ["openai", "mistral"];

export function createProvider(id: ProviderId, apiKey: string): ChatProvider {
  return id === "openai" ? OpenAIProvider.fromKey(apiKey) : MistralProvider.fromKey(apiKey);
}
