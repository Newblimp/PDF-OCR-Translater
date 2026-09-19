/**
 * Model defaults and helpers. Keep every model id in this file so future
 * changes to Mistral's line-up only need to be made here.
 *
 * Model ids: https://docs.mistral.ai/getting-started/models/models_overview
 */
import type { ModelCard } from "./types";

/** Document AI OCR model. `-latest` always points at the newest release. */
export const DEFAULT_OCR_MODEL = "mistral-ocr-latest";

/**
 * Chat model used for schema inference and translation. Patent-office
 * correspondence is dense legal text, so we default to the most capable
 * general model. The UI lets the user pick any chat-capable model returned
 * by GET /v1/models.
 */
export const DEFAULT_CHAT_MODEL = "mistral-large-latest";

/**
 * Fallback list shown before /v1/models has answered (or when it fails).
 * Ordered from most to least capable.
 */
export const FALLBACK_CHAT_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "mistral-large-latest", label: "Mistral Large (latest)" },
  { id: "mistral-medium-latest", label: "Mistral Medium (latest)" },
  { id: "mistral-small-latest", label: "Mistral Small (latest)" },
];

export interface ModelOption {
  id: string;
  label: string;
  contextLength?: number;
}

/**
 * Turn the raw model list into dropdown options for the translation model.
 * Keeps chat-capable, non-deprecated base models and collapses aliases so
 * the same weights are not listed several times.
 */
export function chatModelOptions(cards: ModelCard[]): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const card of cards) {
    if (!card.capabilities?.completion_chat) continue;
    if (card.type && card.type !== "base") continue;
    if (card.deprecation && new Date(card.deprecation) < new Date()) continue;
    if (/ocr|embed|moderation|codestral|pixtral|voxtral|devstral/i.test(card.id)) continue;
    // Prefer the `-latest` alias when present so users track new releases.
    const latestAlias = card.aliases?.find((a) => a.endsWith("-latest"));
    const id = card.id.endsWith("-latest") ? card.id : (latestAlias ?? card.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const option: ModelOption = { id, label: card.name ? `${card.name} (${id})` : id };
    if (card.max_context_length) option.contextLength = card.max_context_length;
    options.push(option);
  }
  options.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return options;
}

function rank(id: string): number {
  if (id.startsWith("mistral-large")) return 0;
  if (id.startsWith("mistral-medium")) return 1;
  if (id.startsWith("magistral")) return 2;
  if (id.startsWith("mistral-small")) return 3;
  if (id.startsWith("ministral")) return 4;
  return 5;
}
