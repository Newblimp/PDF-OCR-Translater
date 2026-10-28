import { describe, expect, it } from "vitest";
import { anthropicModelOptions } from "../anthropic/models";
import { chatModelOptions } from "../mistral/models";
import { openaiModelOptions } from "../openai/models";
import type { ProviderId } from "./provider";
import { effortFor, PROVIDER_IDS, PROVIDERS } from "./registry";

/** What each provider keeps of a model list with these ids (its own `/v1/models` filter). */
const OFFERED: Record<ProviderId, (ids: string[]) => string[]> = {
  mistral: (ids) => chatModelOptions(ids.map((id) => ({ id, type: "base", capabilities: { completion_chat: true } }))).map((m) => m.id),
  anthropic: (ids) => anthropicModelOptions(ids.map((id) => ({ id, display_name: id, max_input_tokens: 1 }))).map((m) => m.id),
  openai: (ids) => openaiModelOptions(ids.map((id) => ({ id, object: "model" }))).map((m) => m.id),
};

describe("provider registry", () => {
  it.each(PROVIDER_IDS)("%s: the fallback models are ones its model filter offers, the default among them", (id) => {
    const fallback = PROVIDERS[id].fallbackModels.map((m) => m.id);
    // Shown before /v1/models answers (or when it fails): a model there must be one the app can use.
    expect([...OFFERED[id](fallback)].sort()).toEqual([...fallback].sort());
    expect(fallback).toContain(PROVIDERS[id].defaultModel);
  });

  it.each(PROVIDER_IDS)("%s: every reasoning effort maps onto one it offers", (id) => {
    for (const effort of ["none", "low", "medium", "high"] as const) expect(PROVIDERS[id].reasoningEfforts).toContain(effortFor(id, effort));
  });
});
