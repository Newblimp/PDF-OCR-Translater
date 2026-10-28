/**
 * Registry of translation providers, the default (Mistral) first. The OCR
 * step is always Mistral; the chat steps (translation, schema inference) can
 * use any provider listed here.
 */
import { DEFAULT_ANTHROPIC_MODEL, FALLBACK_ANTHROPIC_MODELS } from "../anthropic/models";
import { toApiError } from "../http/apiError";
import { DEFAULT_CHAT_MODEL, FALLBACK_CHAT_MODELS, type ModelOption } from "../mistral/models";
import { DEFAULT_OPENAI_MODEL, FALLBACK_OPENAI_MODELS } from "../openai/models";
import { API_PROVIDERS, PROVIDER_IDS, type ApiProviderIdentity } from "../apiProviders";
import type { ChatProvider, ProviderId, ReasoningEffort } from "./provider";

/** A provider as the app offers it: its identity (`apiProviders.ts`: name, label, host) and everything built on it. */
export interface ProviderInfo extends ApiProviderIdentity {
  id: ProviderId;
  /** What the key is used for, shown in the key dialog. */
  purpose: string;
  /** "Mistral API key", ... */
  keyLabel: string;
  keyUrl: string;
  defaultModel: string;
  fallbackModels: ReadonlyArray<ModelOption>;
  supportsTemperature: boolean;
  supportsReasoningEffort: boolean;
  /** The reasoning efforts offered in Settings (the provider maps them onto its API). */
  reasoningEfforts: ReadonlyArray<ReasoningEffort>;
  /** Imports the implementation (its own chunk, with its client or SDK) and returns its factory. */
  load: () => Promise<(apiKey: string) => ChatProvider>;
}

/** What the registry adds to a provider's identity. */
type Offer = Omit<ProviderInfo, "id" | keyof ApiProviderIdentity | "keyLabel">;

function provider(id: ProviderId, offer: Offer): ProviderInfo {
  const identity = API_PROVIDERS[id];
  return { id, ...identity, keyLabel: `${identity.name} API key`, ...offer };
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  mistral: provider("mistral", {
    purpose: "used for OCR (always) and for translation (Mistral Small, the default)",
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: DEFAULT_CHAT_MODEL,
    fallbackModels: FALLBACK_CHAT_MODELS,
    supportsTemperature: true,
    supportsReasoningEffort: true,
    // Mistral Small 4 documents "none" and "high" (https://docs.mistral.ai/capabilities/reasoning).
    reasoningEfforts: ["none", "high"],
    load: () => import("./mistralProvider").then((m) => m.MistralProvider.fromKey),
  }),
  anthropic: provider("anthropic", {
    purpose: "used for translation if selected (Claude Haiku 5.5)",
    keyUrl: "https://platform.claude.com/settings/keys",
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    fallbackModels: FALLBACK_ANTHROPIC_MODELS,
    supportsTemperature: false,
    supportsReasoningEffort: true,
    reasoningEfforts: ["none", "low", "medium", "high"],
    load: () => import("./anthropicProvider").then((m) => m.AnthropicProvider.fromKey),
  }),
  openai: provider("openai", {
    purpose: "used for translation if selected (GPT Luna)",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: DEFAULT_OPENAI_MODEL,
    fallbackModels: FALLBACK_OPENAI_MODELS,
    supportsTemperature: false,
    supportsReasoningEffort: true,
    reasoningEfforts: ["none", "low", "medium", "high"],
    load: () => import("./openaiProvider").then((m) => m.OpenAIProvider.fromKey),
  }),
};

/** All providers, in the order they are offered for translation (the default first). */
export { PROVIDER_IDS };

/** The provider whose key is always required because it performs OCR. */
export const OCR_PROVIDER: ProviderId = "mistral";

/** The effort shown and sent for a provider: the setting, or the closest one the provider offers (Mistral: "low"/"medium" think, as "high"). */
export function effortFor(id: ProviderId, effort: ReasoningEffort): ReasoningEffort {
  const offered = PROVIDERS[id].reasoningEfforts;
  return offered.includes(effort) ? effort : effort === "none" ? "none" : (offered[offered.length - 1] ?? effort);
}

/**
 * The provider for a key. Its implementation is imported on the first call
 * (every call is async anyway), so no provider is in the initial bundle; a
 * chunk that fails to load is a network error and is tried again next time.
 */
export function createProvider(id: ProviderId, apiKey: string): ChatProvider {
  let provider: Promise<ChatProvider> | null = null;
  const get = () =>
    (provider ??= PROVIDERS[id].load().then(
      (create) => create(apiKey),
      (err: unknown) => {
        provider = null;
        throw toApiError(err, id);
      },
    ));
  return {
    id,
    label: PROVIDERS[id].label,
    completeJson: async (request) => (await get()).completeJson(request),
    listModels: async (signal) => (await get()).listModels(signal),
  };
}

/** Build a record with one entry per provider (keeps `Record<ProviderId, T>` literals out of the app). */
export function perProvider<T>(make: (id: ProviderId) => T): Record<ProviderId, T> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, make(id)])) as Record<ProviderId, T>;
}
