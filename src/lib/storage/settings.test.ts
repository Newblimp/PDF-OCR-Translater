// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";
import { clearApiKey, loadApiKey, saveApiKey } from "./apiKeys";

describe("settings persistence", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings().provider).toBe("openai");
    expect(loadSettings().chatModels.openai).toBe("gpt-5.6-luna");
  });

  it("round-trips and repairs invalid values", () => {
    saveSettings({ ...DEFAULT_SETTINGS, targetLanguage: "German", theme: "dark" });
    expect(loadSettings()).toMatchObject({ targetLanguage: "German", theme: "dark" });
    localStorage.setItem("pdf-ocr-translater.settings.v2", JSON.stringify({ targetLanguage: "Klingon", theme: "neon", provider: "nope" }));
    expect(loadSettings()).toMatchObject({ targetLanguage: "English", theme: "system", provider: "openai" });
  });
});

describe("api key storage", () => {
  beforeEach(() => localStorage.clear());

  it("stores one key per provider and migrates the legacy Mistral key", () => {
    localStorage.setItem("pdf-ocr-translater.apiKey", "old-mistral");
    expect(loadApiKey("mistral")).toBe("old-mistral");
    expect(localStorage.getItem("pdf-ocr-translater.apiKey")).toBeNull();
    expect(loadApiKey("openai")).toBeNull();
    saveApiKey("openai", " sk-x ");
    expect(loadApiKey("openai")).toBe("sk-x");
    clearApiKey("openai");
    expect(loadApiKey("openai")).toBeNull();
  });
});
