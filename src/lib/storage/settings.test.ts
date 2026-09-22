// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";
import { clearApiKey, loadApiKey, saveApiKey } from "./apiKeys";

describe("settings persistence", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings().provider).toBe("openai");
    expect(loadSettings().chatModels.openai).toBe("gpt-6-luna");
    expect(loadSettings()).toMatchObject({ sendImages: true, bboxAnnotations: true, maxBboxAnnotations: 20, blockTranslations: true });
  });

  it("round-trips and repairs invalid values", () => {
    saveSettings({ ...DEFAULT_SETTINGS, targetLanguage: "German", theme: "dark" });
    expect(loadSettings()).toMatchObject({ targetLanguage: "German", theme: "dark" });
    localStorage.setItem("pdf-ocr-translater.settings.v2", JSON.stringify({ targetLanguage: "Klingon", theme: "neon", provider: "nope" }));
    expect(loadSettings()).toMatchObject({ targetLanguage: "English", theme: "dark", provider: "openai" });
  });
});

describe("model default migration", () => {
  beforeEach(() => localStorage.clear());

  it("moves a saved gpt-5.6-luna choice to the new default once", () => {
    localStorage.setItem(
      "pdf-ocr-translater.settings.v2",
      JSON.stringify({ chatModels: { openai: "gpt-5.6-luna", mistral: "mistral-medium-latest" } }),
    );
    const migrated = loadSettings();
    expect(migrated.chatModels).toEqual({ openai: "gpt-6-luna", mistral: "mistral-medium-latest" });
    saveSettings({ ...migrated, chatModels: { ...migrated.chatModels, openai: "gpt-5.6-luna" } });
    expect(loadSettings().chatModels.openai).toBe("gpt-5.6-luna"); // choosing it again sticks
  });

  it("leaves other saved models alone", () => {
    localStorage.setItem("pdf-ocr-translater.settings.v2", JSON.stringify({ chatModels: { openai: "gpt-5.6-terra" } }));
    expect(loadSettings().chatModels.openai).toBe("gpt-5.6-terra");
  });
});

describe("settings v1 migration", () => {
  beforeEach(() => localStorage.clear());

  it("carries compatible v1 fields over, maps chatModel to Mistral, and removes the v1 entry", () => {
    localStorage.setItem(
      "pdf-ocr-translater.settings.v1",
      JSON.stringify({
        chatModel: "mistral-medium-latest",
        targetLanguage: "French",
        domainHint: "custom hint",
        schemaMode: { kind: "custom", schemaText: "{\"type\":\"object\"}" },
        temperature: 0.5,
        cacheOcr: false,
      }),
    );
    const settings = loadSettings();
    expect(settings.chatModels.mistral).toBe("mistral-medium-latest");
    expect(settings.chatModels.openai).toBe(DEFAULT_SETTINGS.chatModels.openai);
    expect(settings.targetLanguage).toBe("English"); // French is not in the toggle
    expect(settings.domainHint).toBe("custom hint");
    expect(settings.schemaMode).toEqual({ kind: "custom", schemaText: "{\"type\":\"object\"}" });
    expect(settings.temperature).toBe(0.5);
    expect(settings.cacheOcr).toBe(false);
    expect(settings.provider).toBe("openai");
    expect(localStorage.getItem("pdf-ocr-translater.settings.v1")).toBeNull();
    expect(localStorage.getItem("pdf-ocr-translater.settings.v2")).not.toBeNull();
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
