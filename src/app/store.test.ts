import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/storage/settings";
import { initialState, missingKeys, reducer, requiredProviders, usableKey } from "./store";

describe("key gating", () => {
  it("requires only the Mistral key when Mistral translates, both otherwise", () => {
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "mistral" })).toEqual(["mistral"]);
    expect(requiredProviders({ ...DEFAULT_SETTINGS, provider: "openai" })).toEqual(["mistral", "openai"]);
  });

  it("treats a rejected key as missing", () => {
    let state = initialState({ mistral: "m", openai: "o" }, DEFAULT_SETTINGS);
    expect(missingKeys(state)).toEqual([]);
    state = reducer(state, { type: "key/status", provider: "openai", status: "invalid", error: "nope" });
    expect(usableKey(state.keys, "openai")).toBeNull();
    expect(missingKeys(state)).toEqual(["openai"]);
    // Unverified (network trouble) keys stay usable.
    state = reducer(state, { type: "key/status", provider: "openai", status: "unverified" });
    expect(missingKeys(state)).toEqual([]);
  });

  it("opens the key dialog initially only when a required key is missing", () => {
    expect(initialState({ mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "mistral" }).keyDialogOpen).toBe(false);
    expect(initialState({ mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "openai" }).keyDialogOpen).toBe(true);
  });

  it("evaluates missing keys against explicitly passed settings", () => {
    const state = initialState({ mistral: "m", openai: null }, { ...DEFAULT_SETTINGS, provider: "mistral" });
    expect(missingKeys(state, { ...state.settings, provider: "openai" })).toEqual(["openai"]);
  });
});
