/**
 * Anthropic model defaults for the translation step.
 * Model ids: https://platform.claude.com/docs/en/about-claude/models/overview
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelOption } from "../mistral/models";

/**
 * Claude Haiku 5.5: Anthropic's fastest, cheapest current model for
 * high-volume tasks; 1M-token context, up to 128k output tokens, text and
 * image input, structured outputs, adaptive thinking steered by effort
 * (default `medium`). Rejects non-default `temperature`/`top_p`/`top_k`.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

/**
 * `max_tokens` is required by the Messages API and counts thinking tokens.
 * 64k leaves room for long translations on every listed model.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 64_000;

export const FALLBACK_ANTHROPIC_MODELS: ReadonlyArray<ModelOption> = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (claude-haiku-5-5)", contextLength: 1_000_000 },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (claude-sonnet-5-5)", contextLength: 1_000_000 },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (claude-opus-5-5)", contextLength: 1_000_000 },
];

/** Models that reject `output_config.effort`: everything before Opus 4.5, and Sonnet/Haiku 4.5. */
const EXCLUDED_ID = /^claude-(?:[0-3]|instant)|^claude-(?:sonnet|haiku)-4-5|^claude-(?:opus|sonnet)-4-(?:0|1|2\d{7})/;

/** Keep the usable Claude models from /v1/models, Haiku first, otherwise newest first (the API's order). */
export function anthropicModelOptions(models: ReadonlyArray<Pick<Anthropic.ModelInfo, "id" | "display_name" | "max_input_tokens">>): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const m of models) {
    if (!m.id.startsWith("claude-") || EXCLUDED_ID.test(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    options.push({
      id: m.id,
      label: m.display_name ? `${m.display_name} (${m.id})` : m.id,
      ...(m.max_input_tokens ? { contextLength: m.max_input_tokens } : {}),
    });
  }
  return options.sort((a, b) => rank(a.id) - rank(b.id));
}

function rank(id: string): number {
  if (id.includes("haiku")) return 0;
  if (id.includes("sonnet")) return 1;
  if (id.includes("opus")) return 2;
  return 3;
}
