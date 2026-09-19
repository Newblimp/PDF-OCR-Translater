import type { ModelOption } from "@/lib/mistral/models";
import { BUILTIN_SCHEMAS } from "@/lib/pipeline/schemas";
import { clearOcrCache } from "@/lib/storage/ocrCache";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/storage/settings";
import { prettyJson } from "@/lib/util/json";

interface Props {
  settings: Settings;
  models: ModelOption[];
  open: boolean;
  onToggle: (open: boolean) => void;
  onChange: (patch: Partial<Settings>) => void;
}

const LANGUAGES = ["English", "German", "French", "Spanish", "Italian", "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)"];

export function SettingsPanel({ settings, models, open, onToggle, onChange }: Props) {
  const modelInList = models.some((m) => m.id === settings.chatModel);
  const schemaKind = settings.schemaMode.kind;

  return (
    <details class="card settings" open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span>Settings</span>
        <span class="muted small">
          {settings.chatModel} · → {settings.targetLanguage} ·{" "}
          {schemaKind === "infer" ? "inferred JSON format" : schemaKind === "builtin" ? "built-in schema" : "custom schema"}
        </span>
      </summary>

      <div class="settings-grid">
        <label class="field">
          <span>Translation model</span>
          <select
            value={modelInList ? settings.chatModel : "__custom"}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v !== "__custom") onChange({ chatModel: v });
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ""}
              </option>
            ))}
            {!modelInList && <option value="__custom">{settings.chatModel} (custom)</option>}
          </select>
          <input
            type="text"
            value={settings.chatModel}
            spellcheck={false}
            aria-label="Translation model id"
            onChange={(e) => onChange({ chatModel: (e.target as HTMLInputElement).value.trim() })}
          />
        </label>

        <label class="field">
          <span>OCR model</span>
          <input
            type="text"
            value={settings.ocrModel}
            spellcheck={false}
            onChange={(e) => onChange({ ocrModel: (e.target as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.ocrModel })}
          />
        </label>

        <label class="field">
          <span>Target language</span>
          <input
            type="text"
            list="target-languages"
            value={settings.targetLanguage}
            onChange={(e) => onChange({ targetLanguage: (e.target as HTMLInputElement).value })}
          />
          <datalist id="target-languages">
            {LANGUAGES.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </label>

        <label class="field">
          <span>Source language</span>
          <input
            type="text"
            value={settings.sourceLanguage}
            placeholder="auto"
            onChange={(e) => onChange({ sourceLanguage: (e.target as HTMLInputElement).value || "auto" })}
          />
          <span class="muted small">“auto” lets the model detect it.</span>
        </label>

        <fieldset class="field field-wide">
          <legend>JSON format of the translation</legend>
          <label class="radio">
            <input type="radio" name="schema" checked={schemaKind === "infer"} onChange={() => onChange({ schemaMode: { kind: "infer" } })} />
            <span>
              Infer from the document <span class="muted small">(one extra model call designs the fields, like the playground's auto-schema)</span>
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
            <textarea
              class="code-area"
              rows={12}
              spellcheck={false}
              value={settings.schemaMode.kind === "custom" ? settings.schemaMode.schemaText : ""}
              onChange={(e) => onChange({ schemaMode: { kind: "custom", schemaText: (e.target as HTMLTextAreaElement).value } })}
            />
          )}
        </fieldset>

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

        <div class="field field-wide">
          <span>Behaviour</span>
          <label class="checkbox">
            <input type="checkbox" checked={settings.streaming} onChange={(e) => onChange({ streaming: (e.target as HTMLInputElement).checked })} />
            <span>Stream the translation (shows progress while it is generated)</span>
          </label>
          <label class="checkbox">
            <input type="checkbox" checked={settings.cacheOcr} onChange={(e) => onChange({ cacheOcr: (e.target as HTMLInputElement).checked })} />
            <span>Keep OCR results in this browser so the same file is not OCR'd twice</span>
          </label>
          <div class="btn-row">
            <button type="button" class="btn btn-ghost small" onClick={() => void clearOcrCache()}>
              Clear local OCR cache
            </button>
            <button type="button" class="btn btn-ghost small" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
              Reset to defaults
            </button>
          </div>
        </div>

        <label class="field field-wide">
          <span>Document family hint (shown to the model)</span>
          <textarea rows={3} value={settings.domainHint} onChange={(e) => onChange({ domainHint: (e.target as HTMLTextAreaElement).value })} />
        </label>
      </div>
    </details>
  );
}
