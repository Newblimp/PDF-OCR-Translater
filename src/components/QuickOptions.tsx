import { memo } from "preact/compat";
import { parseGlossary } from "@/lib/pipeline/glossary";
import { QUICK_TARGET_LANGUAGES, type Settings, type TargetLanguage } from "@/lib/storage/settings";
import { DraftText } from "./DraftText";

interface Props {
  targetLanguage: TargetLanguage;
  glossary: string;
  onChange: (patch: Partial<Settings>) => void;
}

/**
 * Above the settings: what changes from one document to the next, the target
 * language (English or German in one click; the others are in Settings) and
 * the glossary.
 */
export const QuickOptions = memo(function QuickOptions({ targetLanguage, glossary, onChange }: Props) {
  const terms = parseGlossary(glossary).length;
  const quick = QUICK_TARGET_LANGUAGES.includes(targetLanguage);
  return (
    <section class="card quick-options" aria-label="Translation options">
      <div class="field">
        <span>Target language</span>
        <div class="segmented" role="radiogroup" aria-label="Target language">
          {QUICK_TARGET_LANGUAGES.map((lang) => (
            <button
              key={lang}
              type="button"
              role="radio"
              aria-checked={targetLanguage === lang}
              class={`segment${targetLanguage === lang ? " segment-active" : ""}`}
              onClick={() => onChange({ targetLanguage: lang })}
            >
              {lang}
            </button>
          ))}
          {/* Another language chosen in Settings stays visible here. */}
          {!quick && (
            <button type="button" role="radio" aria-checked={true} class="segment segment-active" title="Chosen in Settings">
              {targetLanguage}
            </button>
          )}
        </div>
      </div>
      <label class="field">
        <span>Glossary (optional)</span>
        <DraftText
          rows={3}
          class="code-area"
          spellcheck={false}
          value={glossary}
          placeholder={"One term per line: source = target\n审查员 = examiner\n驳回 = rejection"}
          aria-label="Glossary"
          onCommit={(next) => onChange({ glossary: next })}
        />
        <span class="muted small">
          {terms ? `${terms} term(s) the translation must use.` : "Required translations of specific terms, sent with every translation call."}
        </span>
      </label>
    </section>
  );
});
