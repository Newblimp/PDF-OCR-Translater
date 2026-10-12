import { memo } from "preact/compat";
import { useEffect, useMemo } from "preact/hooks";
import { ocrBelongsTo, type JobKind, type OcrState, type TranslationState } from "@/app/store";
import { bilingualHtml } from "@/lib/export/bilingual";
import { PROVIDERS } from "@/lib/llm/registry";
import { loadExportMarkdownRenderer } from "@/lib/markdown";
import type { JsonSchemaObject } from "@/lib/mistral/types";
import type { StructureOriginalMode } from "@/lib/pipeline/pipeline";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { parsePartialJson } from "@/lib/util/partialJson";
import { formatNumber } from "@/lib/util/text";
import { JsonBrowser } from "./JsonBrowser/JsonBrowser";
import { copy, download, TranslationToggle, usageText } from "./resultControls";
import type { ResultActions } from "./ResultsPanel";

/**
 * The views of a translation that filled a JSON format ("JSON output" in
 * Settings): the structured text, the JSON format, the raw JSON, and the
 * live view while the translation streams. Loaded with the first of them.
 */

/** A translation that filled a JSON format. */
type StructuredTranslation = TranslationState & { schema: JsonSchemaObject };

export const SchemaView = memo(function SchemaView({ translation, actions }: { translation: StructuredTranslation; actions: ResultActions }) {
  const text = useMemo(() => prettyJson(translation.schema), [translation.schema]);
  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {translation.schemaSource === "inferred"
            ? `Inferred from the document by ${translation.model}`
            : translation.schemaSource === "builtin"
              ? "Built-in schema"
              : "Custom schema"}
          {translation.inferUsage ? ` · ${formatNumber(translation.inferUsage.total_tokens)} tokens for inference` : ""}
        </span>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(text)}>
            Copy
          </button>
          <button type="button" class="btn btn-ghost small" onClick={() => actions.useSchema(text)}>
            Reuse as custom schema
          </button>
        </div>
      </div>
      {translation.schemaWarnings.length > 0 && (
        <details class="banner banner-warn">
          <summary>{translation.schemaWarnings.length} adjustment(s) were made so the schema works in strict mode</summary>
          <pre class="details-pre">{translation.schemaWarnings.join("\n")}</pre>
        </details>
      )}
      <pre class="code-block">{text}</pre>
    </div>
  );
});

/** Props of the views that show the JSON translated or in the document's own language. */
interface ShownJsonProps {
  translation: TranslationState;
  /** "Show translation" (the switch shared by the tabs). */
  showTranslation: boolean;
  jobKind: JobKind | null;
  structureMode: StructureOriginalMode;
  baseName: string;
  actions: ResultActions;
}

/**
 * The JSON a view shows: the translation, or with "Show translation" off the
 * structure in the original language once there is one. While it is missing
 * it is asked for, once (on-demand mode), rather than on every flip of the
 * switch in the OCR tab, which does not need it.
 */
function useShownJson({ translation, showTranslation: want, jobKind, structureMode, baseName, actions }: ShownJsonProps) {
  const original = hasOriginal(translation);
  useEffect(() => {
    if (!want && !original && !jobKind && structureMode !== "never") actions.requestOriginal();
  }, [want, original, jobKind, structureMode, actions, translation.id]);
  const translated = want || !original;
  return {
    original,
    translated,
    data: translated ? translation.data : translation.originalData,
    fileName: `${baseName}.${translated ? "translation" : "original"}.json`,
  };
}

/** True when the original-language structured text is available for the toggle. */
function hasOriginal(translation: TranslationState): boolean {
  return translation.originalData !== null && translation.originalData !== undefined;
}

/** Bilingual HTML: the translation next to the original, field by field and block by block. */
async function downloadBilingual(translation: StructuredTranslation, ocr: OcrState | null, name: string): Promise<void> {
  const render = await loadExportMarkdownRenderer().catch(() => null);
  const html = bilingualHtml(
    {
      title: translation.sourceName,
      targetLanguage: translation.targetLanguage,
      producedBy: `${PROVIDERS[translation.provider].label} · ${translation.model}`,
      completedAt: translation.completedAt,
      schema: translation.schema,
      translated: translation.data,
      original: hasOriginal(translation) ? translation.originalData : null,
      ocr: ocr?.text ?? null,
      blockTranslations: translation.blockTranslations,
    },
    render ?? ((text) => `<p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, "<br>")}</p>`),
  );
  download(`${name}.bilingual.html`, html, "text/html");
}

/** The JSON format filled by the model: translated, or in the document's own language. */
export const StructuredView = memo(function StructuredView(props: ShownJsonProps & { translation: StructuredTranslation; ocr: OcrState | null }) {
  const { translation, ocr, showTranslation: wantTranslation, jobKind, structureMode, baseName: name, actions } = props;
  const { original, translated: showTranslation, data, fileName } = useShownJson(props);
  const violations = showTranslation ? translation.violations : translation.originalViolations;
  const usage = showTranslation ? translation.usage : translation.originalUsage;
  const truncated = showTranslation && (translation.finishReason === "length" || translation.finishReason === "model_length");

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {PROVIDERS[translation.provider].label} · {translation.model} · {showTranslation ? `→ ${translation.targetLanguage}` : "original language"} ·{" "}
          {translation.mode === "json_schema" ? "strict JSON schema" : "JSON mode"} · {usageText(usage)}
          {translation.restored ? ` · saved in this browser on ${new Date(translation.completedAt).toLocaleString()}` : ""}
        </span>
        <div class="btn-row">
          <TranslationToggle show={wantTranslation} available={true} onShowTranslation={actions.setShowTranslation} />
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(prettyJson(data))}>
            Copy JSON
          </button>
          <button type="button" class="btn btn-ghost small" onClick={() => download(fileName, prettyJson(data), "application/json")}>
            Download JSON
          </button>
          <button type="button" class="btn btn-ghost small" onClick={() => void downloadBilingual(translation, ocr, name)}>
            Download bilingual HTML
          </button>
        </div>
      </div>
      <PipelineStrip translation={translation} ocr={ocr} structureMode={structureMode} busy={jobKind !== null} actions={actions} />
      {!wantTranslation && !original && (
        <div class="banner banner-warn">
          <p>
            {jobKind === "original"
              ? "The structured text in the original language is being produced; the translation is shown meanwhile."
              : jobKind
                ? "The structured text in the original language is produced after the current job; the translation is shown meanwhile."
                : structureMode === "never"
                  ? "Structured text in the original language is turned off in Settings, so the translation is shown."
                  : "There is no structured text in the original language for this translation yet, so the translation is shown."}
          </p>
          {!jobKind && structureMode !== "never" && (
            <button type="button" class="btn small" onClick={actions.produceOriginal}>
              Produce it now
            </button>
          )}
        </div>
      )}
      {translation.warnings.length > 0 && (
        <div class="banner banner-warn">
          <p>Some follow-up steps failed; the translation itself is complete.</p>
          <ul>
            {translation.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {(violations.length > 0 || truncated) && (
        <div class="banner banner-warn">
          {truncated ? (
            <p>
              {translation.partial
                ? "The model reached its output limit before the JSON was complete; the fields received up to that point are shown."
                : "The model reached its output limit, so the translation may be truncated."}{" "}
              Raise “Max output tokens” in Settings or try a model with a larger output limit.
            </p>
          ) : null}
          {violations.length > 0 && (
            <details>
              <summary>{violations.length} deviation(s) from the JSON format</summary>
              <pre class="details-pre">{violations.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
      <JsonBrowser data={data} schema={translation.schema} />
    </div>
  );
});

export const RawJsonView = memo(function RawJsonView(props: ShownJsonProps) {
  const { translation, showTranslation: wantTranslation, actions } = props;
  const { translated: showTranslation, data, fileName } = useShownJson(props);
  const text = useMemo(() => prettyJson(data), [data]);
  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {showTranslation ? `translation → ${translation.targetLanguage}` : "original language"} · {text.length.toLocaleString()} characters
        </span>
        <div class="btn-row">
          <TranslationToggle show={wantTranslation} available={true} onShowTranslation={actions.setShowTranslation} />
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(text)}>
            Copy
          </button>
          <button type="button" class="btn btn-ghost small" onClick={() => download(fileName, text, "application/json")}>
            Download
          </button>
        </div>
      </div>
      <pre class="code-block">{text}</pre>
    </div>
  );
});

/** Shows which model did what, mirroring Mistral's annotation workflow. */
function PipelineStrip({
  translation,
  ocr,
  structureMode,
  busy,
  actions,
}: {
  translation: TranslationState;
  ocr: OcrState | null;
  structureMode: StructureOriginalMode;
  busy: boolean;
  actions: ResultActions;
}) {
  const chat = `${PROVIDERS[translation.provider].label} · ${translation.model}`;
  const boxes = ocr?.text.bboxes.length ?? 0;
  const described = translation.bboxAnnotations.filter((a) => a.data).length;
  const failed = translation.bboxAnnotations.length - described;
  const schemaStep =
    translation.schemaSource === "inferred"
      ? `JSON format inferred by ${chat}`
      : translation.schemaSource === "builtin"
        ? "Built-in JSON format"
        : "Custom JSON format";
  return (
    <ol class="pipeline-strip" aria-label="Processing steps">
      <li class="step step-done">
        {ocr ? (
          <button type="button" class="btn btn-link small" onClick={() => actions.setTab("bboxes")}>
            Mistral OCR: {ocr.text.pagesProcessed} page(s), {boxes} bounding box(es)
          </button>
        ) : (
          "Text input (no OCR)"
        )}
      </li>
      <li class="step step-done">
        <button type="button" class="btn btn-link small" onClick={() => actions.setTab("schema")}>
          {schemaStep}
        </button>
      </li>
      {translation.bboxAnnotations.length > 0 ? (
        <li class={`step ${failed ? "step-warning" : "step-done"}`}>
          <button type="button" class="btn btn-link small" onClick={() => actions.setTab("bboxes")}>
            BBox annotation: {described} of {translation.bboxAnnotations.length} box(es) described by the vision model
          </button>
          {failed > 0 && ocr && ocrBelongsTo(ocr, translation) && (
            <button type="button" class="btn btn-ghost small" disabled={busy} onClick={() => actions.retry("bboxes")}>
              Retry {failed} failed
            </button>
          )}
        </li>
      ) : (
        <li class="step step-skipped">BBox annotation skipped{boxes === 0 ? " (no boxes)" : ""}</li>
      )}
      <li class="step step-done">
        Document annotation: translated into {translation.targetLanguage} by {chat} from the text
        {translation.imagesSent ? ` + ${translation.imagesSent} bounding-box image(s)` : " only"}
      </li>
      {hasOriginal(translation) ? (
        <li class="step step-done">Structured text in the original language: filled by {chat} without translating</li>
      ) : (
        <li class="step step-skipped">
          Structured text in the original language{" "}
          {structureMode === "never" ? "turned off" : "not produced yet (switch off “Show translation” here to produce it)"}
        </li>
      )}
    </ol>
  );
}

/** Live view of the translation while it streams: partial JSON rendered as it grows. */
export const StreamingView = memo(function StreamingView({ text }: { text: string }) {
  const partial = useMemo(() => {
    try {
      return parsePartialJson(text);
    } catch {
      return undefined; // never let a parser edge case take the page down
    }
  }, [text]);
  return (
    <div class="stream-panel">
      <div class="toolbar">
        <span class="small" aria-live="polite" aria-atomic="true">
          <span class="stream-cursor">Translation streaming in… {Math.round(text.length / 1000)}k characters</span>
        </span>
      </div>
      <pre class="stream-tail" aria-hidden="true">
        {text.slice(-400)}
      </pre>
      {partial !== undefined && isPlainObject(partial) && Object.keys(partial).length > 0 && <JsonBrowser data={partial} schema={null} streaming />}
    </div>
  );
});
