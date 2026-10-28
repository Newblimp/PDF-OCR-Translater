import { memo } from "preact/compat";
import type { ProviderId, ReasoningEffort } from "@/lib/llm/provider";
import { effortFor, PROVIDER_IDS, PROVIDERS } from "@/lib/llm/registry";
import { OCR_MODELS, type ModelOption } from "@/lib/mistral/models";
import { BUILTIN_SCHEMAS } from "@/lib/pipeline/schemas";
import type { StructureOriginalMode } from "@/lib/pipeline/pipeline";
import { clearOcrCache } from "@/lib/storage/ocrCache";
import { DEFAULT_SETTINGS, TARGET_LANGUAGES, type Settings, type TargetLanguage } from "@/lib/storage/settings";
import { prettyJson } from "@/lib/util/json";
import { DraftText } from "./DraftText";
import { Check } from "./Check";

interface Props {
  settings: Settings;
  models: Record<ProviderId, ModelOption[]>;
  open: boolean;
  onToggle: (open: boolean) => void;
  onChange: (patch: Partial<Settings>) => void;
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = { none: "none (fastest)", low: "low", medium: "medium", high: "high" };

const EFFORT_HINTS: Record<ProviderId, string> = {
  mistral: "“none” answers straight away (the default); “high” makes Mistral Small think first: slower, more tokens. Models that do not reason get none.",
  anthropic: "“none” is fastest and cheapest (Claude's lowest effort, “low”); higher values spend reasoning tokens before answering.",
  openai: "“none” is fastest and cheapest; higher values spend reasoning tokens before answering.",
};

const STRUCTURE_ORIGINAL: Array<{ value: StructureOriginalMode; label: string }> = [
  { value: "on_demand", label: "When “Show translation” is switched off (one extra call, only if needed)" },
  { value: "always", label: "After every translation (one extra call per run)" },
  { value: "never", label: "Never" },
];

export const SettingsPanel = memo(function SettingsPanel({ settings, models, open, onToggle, onChange }: Props) {
  const provider = PROVIDERS[settings.provider];
  const chatModel = settings.chatModels[settings.provider];
  const options = models[settings.provider].length ? models[settings.provider] : provider.fallbackModels;
  const modelInList = options.some((m) => m.id === chatModel);
  const ocrModelInList = OCR_MODELS.some((m) => m.id === settings.ocrModel);
  const schemaKind = settings.schemaMode.kind;
  const setChatModel = (id: string) => onChange({ chatModels: { ...settings.chatModels, [settings.provider]: id } });

  return (
    <details class="card settings" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>
        <span>Settings</span>
        <span class="muted small">
          {chatModel} · → {settings.targetLanguage} ·{" "}
          {!settings.jsonOutput
            ? "block by block"
            : schemaKind === "infer"
              ? "JSON: inferred format"
              : schemaKind === "builtin"
                ? "JSON: built-in schema"
                : "JSON: custom schema"}
        </span>
      </summary>

      <section class="settings-group" aria-label="Translation">
        <h3 class="settings-group-title">Translation</h3>
        <div class="settings-grid">
          <label class="field">
            <span>Target language (all languages)</span>
            <select value={settings.targetLanguage} onChange={(e) => onChange({ targetLanguage: e.currentTarget.value as TargetLanguage })}>
              {TARGET_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
            <span class="muted small">English and German are one click away above the settings.</span>
          </label>
          <label class="field">
            <span>Source language</span>
            <DraftText value={settings.sourceLanguage} fallback="auto" placeholder="auto" onCommit={(sourceLanguage) => onChange({ sourceLanguage })} />
            <span class="muted small">“auto” lets the model detect it.</span>
          </label>
          <label class="field">
            <span>Translation provider</span>
            <select value={settings.provider} onChange={(e) => onChange({ provider: e.currentTarget.value as ProviderId })}>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                </option>
              ))}
            </select>
            <span class="muted small">OCR always uses Mistral.</span>
          </label>
          <label class="field">
            <span>Translation model</span>
            <select
              value={modelInList ? chatModel : "__custom"}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v !== "__custom") setChatModel(v);
              }}
            >
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ""}
                </option>
              ))}
              {!modelInList && <option value="__custom">{chatModel} (custom)</option>}
            </select>
            <span class="muted small">The list comes from the provider's /v1/models.</span>
          </label>
          <label class="field field-wide">
            <span>Document family hint (shown to the model)</span>
            <DraftText rows={3} value={settings.domainHint} fallback={DEFAULT_SETTINGS.domainHint} onCommit={(domainHint) => onChange({ domainHint })} />
          </label>
        </div>
      </section>

      <details class="settings-group settings-advanced">
        <summary>
          <span>Advanced</span>
          <span class="muted small">reasoning, OCR model, figure descriptions, JSON output</span>
        </summary>
        <div class="settings-grid">
          {provider.supportsReasoningEffort && (
            <label class="field">
              <span>Reasoning effort</span>
              <select
                value={effortFor(settings.provider, settings.reasoningEffort)}
                onChange={(e) => onChange({ reasoningEffort: e.currentTarget.value as ReasoningEffort })}
              >
                {provider.reasoningEfforts.map((e) => (
                  <option key={e} value={e}>
                    {EFFORT_LABELS[e]}
                  </option>
                ))}
              </select>
              <span class="muted small">{EFFORT_HINTS[settings.provider]}</span>
            </label>
          )}
          {provider.supportsTemperature && (
            <label class="field">
              <span>Temperature</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={settings.temperature}
                onChange={(e) => {
                  const n = Number(e.currentTarget.value);
                  onChange({ temperature: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SETTINGS.temperature });
                }}
              />
            </label>
          )}
          <label class="field">
            <span>OCR model (Mistral)</span>
            <select
              value={ocrModelInList ? settings.ocrModel : "__custom"}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v !== "__custom") onChange({ ocrModel: v });
              }}
            >
              {OCR_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!ocrModelInList && <option value="__custom">{settings.ocrModel} (custom)</option>}
            </select>
          </label>
          <div class="field field-wide">
            <span>Figures</span>
            <Check checked={settings.bboxAnnotations} onChange={(bboxAnnotations) => onChange({ bboxAnnotations })}>
              Describe every figure the OCR cut out (stamps, seals, signatures, tables as images) with the vision model, one call per figure, up to{" "}
              <input
                type="number"
                class="inline-number"
                min={0}
                step={1}
                value={settings.maxBboxAnnotations}
                aria-label="Maximum figures to describe"
                onChange={(e) => {
                  const raw = e.currentTarget.value.trim();
                  const n = Number(raw);
                  onChange({ maxBboxAnnotations: raw && Number.isInteger(n) && n >= 0 ? n : DEFAULT_SETTINGS.maxBboxAnnotations });
                }}
              />{" "}
              figures per run.
            </Check>
          </div>
          <fieldset class="field field-wide settings-json">
            <legend>JSON output</legend>
            <Check checked={settings.jsonOutput} onChange={(jsonOutput) => onChange({ jsonOutput })}>
              Fill a JSON format with the translation: the Structured text, JSON format and Raw JSON tabs.{" "}
              <span class="muted small">Off, the text is translated block by block (the Text tab), without a JSON format, a summary or the extra calls.</span>
            </Check>
            {settings.jsonOutput && (
              <div class="settings-json-body">
                <fieldset class="field field-wide">
                  <legend>JSON format of the translation</legend>
                  <label class="radio">
                    <input type="radio" name="schema" checked={schemaKind === "infer"} onChange={() => onChange({ schemaMode: { kind: "infer" } })} />
                    <span>
                      Infer from the document <span class="muted small">(one extra model call designs the fields)</span>
                    </span>
                  </label>
                  <label class="radio">
                    <input
                      type="radio"
                      name="schema"
                      checked={schemaKind === "builtin"}
                      onChange={() => onChange({ schemaMode: { kind: "builtin", id: BUILTIN_SCHEMAS[0]?.id ?? "patent_communication" } })}
                    />
                    <span>Built-in schema</span>
                  </label>
                  {schemaKind === "builtin" && (
                    <select
                      value={settings.schemaMode.kind === "builtin" ? settings.schemaMode.id : ""}
                      onChange={(e) => onChange({ schemaMode: { kind: "builtin", id: e.currentTarget.value } })}
                    >
                      {BUILTIN_SCHEMAS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label} — {s.description}
                        </option>
                      ))}
                    </select>
                  )}
                  <label class="radio">
                    <input
                      type="radio"
                      name="schema"
                      checked={schemaKind === "custom"}
                      onChange={() =>
                        onChange({
                          schemaMode: {
                            kind: "custom",
                            schemaText:
                              settings.schemaMode.kind === "custom" && settings.schemaMode.schemaText
                                ? settings.schemaMode.schemaText
                                : prettyJson(BUILTIN_SCHEMAS[0]?.schema ?? {}),
                          },
                        })
                      }
                    />
                    <span>Custom JSON Schema</span>
                  </label>
                  {schemaKind === "custom" && (
                    <DraftText
                      class="code-area"
                      rows={12}
                      spellcheck={false}
                      value={settings.schemaMode.kind === "custom" ? settings.schemaMode.schemaText : ""}
                      onCommit={(schemaText) => onChange({ schemaMode: { kind: "custom", schemaText } })}
                    />
                  )}
                </fieldset>
                <label class="field field-wide">
                  <span>Structured text in the original language</span>
                  <select value={settings.structureOriginal} onChange={(e) => onChange({ structureOriginal: e.currentTarget.value as StructureOriginalMode })}>
                    {STRUCTURE_ORIGINAL.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span class="muted small">
                    Fills the same JSON format without translating, so the Structured text tab can show the document's own wording. It reads the document from
                    the prompt cache when it runs soon after the translation.
                  </span>
                </label>
                <label class="field">
                  <span>Max output tokens (optional)</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    placeholder="provider default"
                    value={settings.maxOutputTokens ?? ""}
                    onChange={(e) => {
                      const n = Number(e.currentTarget.value);
                      onChange({ maxOutputTokens: Number.isFinite(n) && n > 0 ? Math.round(n) : null });
                    }}
                  />
                  <span class="muted small">Leave empty to allow the model's maximum. Set it if translations get cut off unexpectedly.</span>
                </label>
                <div class="field field-wide">
                  <span>JSON behaviour</span>
                  <Check checked={settings.streaming} onChange={(streaming) => onChange({ streaming })}>
                    Stream the translation (shows progress while it is generated)
                  </Check>
                  <Check checked={settings.sendImages} onChange={(sendImages) => onChange({ sendImages })}>
                    Send the first 8 figures the OCR cut out together with the text to the vision model (Mistral's annotation workflow).
                  </Check>
                  <Check checked={settings.blockTranslations} onChange={(blockTranslations) => onChange({ blockTranslations })}>
                    Also translate each text block after the JSON translation, so the Text tab and the Page view can be shown translated.
                  </Check>
                </div>
              </div>
            )}
          </fieldset>
        </div>
      </details>

      <section class="settings-group" aria-label="Privacy and storage">
        <h3 class="settings-group-title">Privacy &amp; storage</h3>
        <div class="settings-grid">
          <div class="field field-wide">
            <span>Kept in this browser</span>
            <Check checked={settings.rememberKeys} onChange={(rememberKeys) => onChange({ rememberKeys })}>
              API keys, after this tab closes (off: only for this tab)
            </Check>
            <Check checked={settings.cacheOcr} onChange={(cacheOcr) => onChange({ cacheOcr })}>
              Keep OCR results in this browser so the same file is not OCR'd twice
            </Check>
            <Check checked={settings.saveTranslations} onChange={(saveTranslations) => onChange({ saveTranslations })}>
              Keep translations in this browser (“Recent translations”; reopened automatically when the same document is loaded)
            </Check>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost small" onClick={() => void clearOcrCache()}>
                Clear local OCR cache
              </button>
              <button
                type="button"
                class="btn btn-ghost small"
                onClick={() => onChange({ ...structuredClone(DEFAULT_SETTINGS), theme: settings.theme, rememberKeys: settings.rememberKeys })}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        </div>
      </section>
    </details>
  );
});
