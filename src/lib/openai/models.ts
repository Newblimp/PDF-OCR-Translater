/**
 * OpenAI model defaults for the translation step.
 * Model ids: https://developers.openai.com/api/docs/models
 */
import type { ModelOption } from "../mistral/models";
import type { ModelObject } from "./types";

/**
 * GPT-5.6 Luna: OpenAI's fast, low-cost GPT-5.6 tier (released 2026-07-09),
 * 1M-token context, up to 128k output tokens, structured outputs supported.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

export const FALLBACK_OPENAI_MODELS: ReadonlyArray<ModelOption> = [
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (gpt-5.6-luna)" },
  { id: "gpt-5.6-luna-pro", label: "GPT-5.6 Luna Pro (gpt-5.6-luna-pro)" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (gpt-5.6-terra)" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (gpt-5.6-sol)" },
];

/**
 * Ids that are not usable for this app even though they start with gpt-5/6:
 * "-chat-latest" snapshots reject `reasoning_effort`, "-pro" models are only
 * served by the Responses API, and the rest are not text chat models.
 */
const EXCLUDED_ID = /(codex|realtime|audio|image|transcribe|tts|search|embedding|chat-latest|-pro\b|-pro-)/;

/** Keep the GPT-5.x chat models from /v1/models, Luna variants first. */
export function openaiModelOptions(models: ModelObject[]): ModelOption[] {
  const ids = models.map((m) => m.id).filter((id) => /^gpt-(5|6)/.test(id) && !EXCLUDED_ID.test(id));
  const unique = Array.from(new Set(ids));
  unique.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
  return unique.map((id) => ({ id, label: FALLBACK_OPENAI_MODELS.find((f) => f.id === id)?.label ?? id }));
}

function rank(id: string): number {
  if (id.includes("luna")) return 0;
  if (id.includes("terra")) return 1;
  if (id.includes("sol")) return 2;
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return 9; // dated snapshots last
  return 5;
}
