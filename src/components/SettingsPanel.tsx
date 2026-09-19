import { useEffect, useRef, useState } from "preact/hooks";
import type { ProviderId, ReasoningEffort } from "@/lib/llm/provider";
import { PROVIDER_IDS, PROVIDERS } from "@/lib/llm/registry";
import type { ModelOption } from "@/lib/mistral/models";
import { BUILTIN_SCHEMAS } from "@/lib/pipeline/schemas";
import { clearOcrCache } from "@/lib/storage/ocrCache";
import { DEFAULT_SETTINGS, TARGET_LANGUAGES, type Settings, type TargetLanguage } from "@/lib/storage/settings";
import { prettyJson } from "@/lib/util/json";

interface Props {
  settings: Settings;
  models: Record<ProviderId, ModelOption[]>;
  open: boolean;
  onToggle: (open: boolean) => void;
  onChange: (patch: Partial<Settings>) => void;
}

const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];

interface DraftProps {
  value: string;
  /** Called on blur / Enter with the trimmed text (or `fallback` when empty). */
  onCommit: (value: string) => void;
  fallback?: string;
  placeholder?: string;
  rows?: number;
  class?: string;
  spellcheck?: boolean;
  "aria-label"?: string;
}

/**
 * Text input that keeps a local draft while focused and commits on blur or
 * Enter. Controlled inputs that commit on every keystroke would be reset by
 * unrelated re-renders (streaming progress, model lists arriving).
 */
function DraftText({ value, onCommit, fallback, rows, ...rest }: DraftProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim() || fallback || "";
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  const common = {
    value: draft,
    onFocus: () => {
      focused.current = true;
    },
    onInput: (e: Event) => setDraft((e.target as HTMLInputElement | HTMLTextAreaElement).value),
    onBlur: () => {
      focused.current = false;
      commit();
    },
    ...rest,
  };
  if (rows) return <textarea rows={rows} {...common} />;
  return (
    <input
      type="text"
      {...common}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function SettingsPanel({ settings, models, open, onToggle, onChange }: Props) {
  const provider = PROVIDERS[settings.provider];
  const chatModel = settings.chatModels[settings.provider];
  const options = models[settings.provider].length ? models[settings.provider] : provider.fallbackModels;
  const modelInList = options.some((m) => m.id === chatModel);
  const schemaKind = settings.schemaMode.kind;
  const setChatModel = (id: string) => onChange({ chatModels: { ...settings.chatModels, [settings.provider]: id } });

  return (
    <details class="card settings" open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span>Settings</span>
        <span class="muted small">
          {chatModel} · → {settings.targetLanguage} ·{" "}
          {schemaKind === "infer" ? "inferred JSON format" : schemaKind === "builtin" ? "built-in schema" : "custom schema"}
        </span>
      </summary>

      <div class="settings-grid">
        <div class="field field-wide">
          <span>Target language</span>
          <div class="segmented" role="radiogroup" aria-label="Target language">
            {TARGET_LANGUAGES.map((lang) => (
              <button
                key={lang}
                type="button"
                role="radio"
                aria-checked={settings.targetLanguage === lang}
                class={`segment${settings.targetLanguage === lang ? " segment-active" : ""}`}
                onClick={() => onChange({ targetLanguage: lang as TargetLanguage })}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>

        <label class="field">
          <span>Translation provider</span>
          <select value={settings.provider} onChange={(e) => onChange({ provider: (e.target as HTMLSelectElement).value as ProviderId })}>
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
              const v = (e.target as HTMLSelectElement).value;
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
          <DraftText value={chatModel} fallback={provider.defaultModel} spellcheck={false} aria-label="Translation model id" onCommit={setChatModel} />
        </label>

        {provider.supportsReasoningEffort && (
          <label class="field">
            <span>Reasoning effort</span>
            <select
              value={settings.reasoningEffort}
              onChange={(e) => onChange({ reasoningEffort: (e.target as HTMLSelectElement).value as ReasoningEffort })}
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <span class="muted small">“none” is fastest and cheapest; higher values spend reasoning tokens before answering.</span>
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
                const n = Number((e.target as HTMLInputElement).value);
                onChange({ temperature: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SETTINGS.temperature });
              }}
            />
          </label>
        )}

        <label class="field">
          <span>Max output tokens (optional)</span>
          <input
            type="number"
            min={1}
            step={1000}
            placeholder="provider default"
            value={settings.maxOutputTokens ?? ""}
            onChange={(e) => {
              const n = Number((e.target as HTMLInputElement).value);
              onChange({ maxOutputTokens: Number.isFinite(n) && n > 0 ? Math.round(n) : null });
            }}
          />
          <span class="muted small">Leave empty to allow the model's maximum. Set it if translations get cut off unexpectedly.</span>
        </label>

        <label class="field">
          <span>OCR model (Mistral)</span>
          <DraftText value={settings.ocrModel} fallback={DEFAULT_SETTINGS.ocrModel} spellcheck={false} onCommit={(ocrModel) => onChange({ ocrModel })} />
        </label>

        <label class="field">
          <span>Source language</span>
          <DraftText value={settings.sourceLanguage} fallback="auto" placeholder="auto" onCommit={(sourceLanguage) => onChange({ sourceLanguage })} />
          <span class="muted small">“auto” lets the model detect it.</span>
        </label>

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
              onChange={(e) => onChange({ schemaMode: { kind: "builtin", id: (e.target as HTMLSelectElement).value } })}
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

        <div class="field field-wide">
          <span>Behaviour</span>
          <label class="checkbox">
            <input type="checkbox" checked={settings.streaming} onChange={(e) => onChange({ streaming: (e.target as HTMLInputElement).checked })} />
            <span>Stream the translation (shows progress while it is generated)</span>
          </label>
          <label class="checkbox">
            <input type="checkbox" checked={settings.sendImages} onChange={(e) => onChange({ sendImages: (e.target as HTMLInputElement).checked })} />
            <span>
              Document annotation with images: send the first 8 bounding-box images extracted by Mistral OCR together with the
              text to the vision model (Mistral's annotation workflow).
            </span>
          </label>
          <label class="checkbox">
            <input
              type="checkbox"
              checked={settings.bboxAnnotations}
              onChange={(e) => onChange({ bboxAnnotations: (e.target as HTMLInputElement).checked })}
            />
            <span>
              Bounding-box annotation: describe every extracted box (stamps, seals, figures, tables) with the vision model, one
              call per box, up to{" "}
              <input
                type="number"
                class="inline-number"
                min={0}
                step={1}
                value={settings.maxBboxAnnotations}
                aria-label="Maximum bounding boxes to describe"
                onChange={(e) => {
                  const n = Number((e.target as HTMLInputElement).value);
                  onChange({ maxBboxAnnotations: Number.isInteger(n) && n >= 0 ? n : DEFAULT_SETTINGS.maxBboxAnnotations });
                }}
              />{" "}
              boxes per run.
            </span>
          </label>
          <label class="checkbox">
            <input type="checkbox" checked={settings.cacheOcr} onChange={(e) => onChange({ cacheOcr: (e.target as HTMLInputElement).checked })} />
            <span>Keep OCR results in this browser so the same file is not OCR'd twice</span>
          </label>
          <div class="btn-row">
            <button type="button" class="btn btn-ghost small" onClick={() => void clearOcrCache()}>
              Clear local OCR cache
            </button>
            <button type="button" class="btn btn-ghost small" onClick={() => onChange({ ...structuredClone(DEFAULT_SETTINGS), theme: settings.theme })}>
              Reset to defaults
            </button>
          </div>
        </div>

        <label class="field field-wide">
          <span>Document family hint (shown to the model)</span>
          <DraftText rows={3} value={settings.domainHint} fallback={DEFAULT_SETTINGS.domainHint} onCommit={(domainHint) => onChange({ domainHint })} />
        </label>
      </div>
    </details>
  );
}
