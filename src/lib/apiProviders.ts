/**
 * The APIs the app talks to, each declared once: its id, its name, the label
 * it is offered under and the host the browser contacts (which the CSP in
 * `public/_headers` must list; `src/architecture.test.ts` checks it). The
 * HTTP layer's error hints, the clients' base URLs, the provider
 * implementations and the registry (`llm/registry.ts`: models,
 * capabilities, key links) all build on this. Kept free of imports, so
 * every layer can use it.
 */
export const API_PROVIDERS = {
  // The default, offered first: OCR is always Mistral.
  mistral: { name: "Mistral", label: "Mistral", host: "api.mistral.ai" },
  anthropic: { name: "Anthropic", label: "Anthropic (Claude)", host: "api.anthropic.com" },
  openai: { name: "OpenAI", label: "OpenAI (GPT Luna)", host: "api.openai.com" },
} as const satisfies Record<string, ApiProviderIdentity>;

export interface ApiProviderIdentity {
  /** Short name: key pills, error hints, "Recent translations". */
  name: string;
  /** What the provider is offered as for translation (the dropdowns, "translated by …"). */
  label: string;
  /** The only host the browser contacts for it. */
  host: string;
}

export type ProviderId = keyof typeof API_PROVIDERS;

/** All providers, in the order they are offered (the default first). */
export const PROVIDER_IDS = Object.keys(API_PROVIDERS) as ProviderId[];

/** Whether a stored or received string names a provider (`in` would also accept "constructor" and the like). */
export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === "string" && Object.hasOwn(API_PROVIDERS, id);
}

/** The base URL of a provider's API: its host, over HTTPS. */
export function apiBaseUrl(id: ProviderId): string {
  return `https://${API_PROVIDERS[id].host}`;
}
