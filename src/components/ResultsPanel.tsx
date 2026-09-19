import { useState } from "preact/hooks";
import type { AppState, ResultTab, TranslationState } from "@/app/store";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { parsePartialJson } from "@/lib/util/partialJson";
import { BboxView } from "./BboxView";
import { estimateTokens, formatNumber } from "@/lib/util/text";
import { PROVIDERS } from "@/lib/llm/registry";
import { translatedPageMarkdown } from "@/lib/pipeline/blockTranslate";
import { JsonBrowser } from "./JsonBrowser/JsonBrowser";
import { MarkdownText } from "./MarkdownText";

interface Props {
  state: AppState;
  onTab: (tab: ResultTab) => void;
  onUseSchema: (schemaText: string) => void;
  /** "Show translation", shared by the OCR text and Structured text tabs. */
  onShowTranslation: (show: boolean) => void;
}

function download(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

function baseName(state: AppState): string {
  const name = state.doc?.name ?? "document";
  return name.replace(/\.[^.]+$/, "");
}

/** True when the original-language structured text is available for the toggle. */
function hasOriginal(translation: TranslationState): boolean {
  return translation.originalData !== null && translation.originalData !== undefined;
}

export function ResultsPanel({ state, onTab, onUseSchema, onShowTranslation }: Props) {
  const { translation, ocr } = state;
  const streamText = state.job?.streamText;
  const tabs: Array<{ id: ResultTab; label: string; available: boolean }> = [
    { id: "bboxes", label: "Bounding boxes", available: !!ocr },
    { id: "ocr", label: "OCR text", available: !!ocr },
    { id: "structured", label: "Structured text", available: !!translation || !!streamText },
    { id: "schema", label: "JSON format", available: !!translation },
    { id: "json", label: "Raw JSON", available: !!translation },
  ];
  const active = tabs.find((t) => t.id === state.activeTab && t.available)?.id ?? tabs.find((t) => t.available)?.id ?? null;

  if (!active) {
    return (
      <div class="empty-state">
        <h2>Results appear here</h2>
        <ol>
          <li>Drop a PDF (for example a CNIPA office action).</li>
          <li>Choose “OCR + Translate”.</li>
          <li>Browse the bounding boxes, the OCR text and the structured text — original or translated.</li>
        </ol>
        <p class="muted small">
          The file is encoded in your browser and sent to api.mistral.ai for OCR; the OCR text and the cropped figure images it returns go to
          the translation provider (configurable in Settings). Nothing is uploaded to this site's host.
        </p>
      </div>
    );
  }

  return (
    <div class="results">
      <div class="tabs" role="tablist">
        {tabs
          .filter((t) => t.available)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active === t.id}
              class={`tab${active === t.id ? " tab-active" : ""}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
      </div>

      {active === "bboxes" && ocr && (
        <BboxView doc={state.doc} ocr={ocr.text} annotations={translation?.bboxAnnotations ?? []} blockTranslations={translation?.blockTranslations ?? {}} />
      )}

      {active === "ocr" && ocr && <OcrView state={state} onShowTranslation={onShowTranslation} />}

      {active === "structured" && streamText && (
        <div class="tab-panel">
          <StreamingView text={streamText} />
        </div>
      )}

      {active === "structured" && translation && !streamText && (
        <StructuredView state={state} translation={translation} onTab={onTab} onShowTranslation={onShowTranslation} />
      )}

      {active === "schema" && translation && (
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
              <button type="button" class="btn btn-ghost small" onClick={() => void copy(prettyJson(translation.schema))}>
                Copy
              </button>
              <button type="button" class="btn btn-ghost small" onClick={() => onUseSchema(prettyJson(translation.schema))}>
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
          <pre class="code-block">{prettyJson(translation.schema)}</pre>
        </div>
      )}

      {active === "json" && translation && <RawJsonView state={state} translation={translation} onShowTranslation={onShowTranslation} />}
    </div>
  );
}

/**
 * "Show translation": switches the OCR text and the structured text between
 * the document's own language and the translation. One shared state, so both
 * tabs always show the same language.
 */
function TranslationToggle({
  show,
  available,
  onShowTranslation,
  label = "Show translation",
}: {
  show: boolean;
  /** False when nothing translated is at hand yet: the switch stays off and explains itself. */
  available: boolean;
  onShowTranslation: (show: boolean) => void;
  label?: string;
}) {
  return (
    <label class="checkbox small" title={available ? "Switch between the document's language and the translation" : "Nothing translated yet"}>
      <input
        type="checkbox"
        checked={show && available}
        disabled={!available}
        onChange={(e) => onShowTranslation((e.target as HTMLInputElement).checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** The JSON format filled by the model: translated, or in the document's own language. */
function StructuredView({
  state,
  translation,
  onTab,
  onShowTranslation,
}: {
  state: AppState;
  translation: TranslationState;
  onTab: (tab: ResultTab) => void;
  onShowTranslation: (show: boolean) => void;
}) {
  const original = hasOriginal(translation);
  const showTranslation = state.showTranslation || !original;
  const data = showTranslation ? translation.data : translation.originalData;
  const violations = showTranslation ? translation.violations : translation.originalViolations;
  const usage = showTranslation ? translation.usage : translation.originalUsage;
  const truncated = showTranslation && (translation.finishReason === "length" || translation.finishReason === "model_length");
  const waiting = !original && !!state.job;

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {PROVIDERS[translation.provider].label} · {translation.model} ·{" "}
          {showTranslation ? `→ ${translation.targetLanguage}` : "original language"} ·{" "}
          {translation.mode === "json_schema" ? "strict JSON schema" : "JSON mode"} · {formatNumber(usage?.prompt_tokens)} in /{" "}
          {formatNumber(usage?.completion_tokens)} out tokens
          {usage?.reasoning_tokens ? ` (${formatNumber(usage.reasoning_tokens)} reasoning)` : ""}
        </span>
        <div class="btn-row">
          <TranslationToggle show={state.showTranslation} available={true} onShowTranslation={onShowTranslation} />
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(prettyJson(data))}>
            Copy JSON
          </button>
          <button
            type="button"
            class="btn btn-ghost small"
            onClick={() =>
              download(`${baseName(state)}.${showTranslation ? "translation" : "original"}.json`, prettyJson(data), "application/json")
            }
          >
            Download JSON
          </button>
        </div>
      </div>
      <PipelineStrip translation={translation} ocr={state.ocr} onTab={onTab} />
      {!state.showTranslation && !original && (
        <div class="banner banner-warn">
          <p>
            {waiting
              ? "The structured text in the original language is still being produced; the translation is shown meanwhile."
              : "This run produced no structured text in the original language, so the translation is shown. Enable “Structured text in the original language” in Settings and run the translation again."}
          </p>
        </div>
      )}
      {(violations.length > 0 || truncated) && (
        <div class="banner banner-warn">
          {truncated ? (
            <p>The model reached its output limit, so the translation may be truncated. Try a model with a larger context or split the document.</p>
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
}

function RawJsonView({
  state,
  translation,
  onShowTranslation,
}: {
  state: AppState;
  translation: TranslationState;
  onShowTranslation: (show: boolean) => void;
}) {
  const original = hasOriginal(translation);
  const showTranslation = state.showTranslation || !original;
  const data = showTranslation ? translation.data : translation.originalData;
  const text = prettyJson(data);
  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {showTranslation ? `translation → ${translation.targetLanguage}` : "original language"} · {text.length.toLocaleString()} characters
        </span>
        <div class="btn-row">
          <TranslationToggle show={state.showTranslation} available={true} onShowTranslation={onShowTranslation} />
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(text)}>
            Copy
          </button>
          <button
            type="button"
            class="btn btn-ghost small"
            onClick={() => download(`${baseName(state)}.${showTranslation ? "translation" : "original"}.json`, text, "application/json")}
          >
            Download
          </button>
        </div>
      </div>
      <pre class="code-block">{text}</pre>
    </div>
  );
}

/** Shows which model did what, mirroring Mistral's annotation workflow. */
function PipelineStrip({ translation, ocr, onTab }: { translation: TranslationState; ocr: AppState["ocr"]; onTab: (tab: ResultTab) => void }) {
  const chat = `${PROVIDERS[translation.provider].label} · ${translation.model}`;
  const boxes = ocr?.text.bboxes.length ?? 0;
  const described = translation.bboxAnnotations.filter((a) => a.data).length;
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
          <button type="button" class="btn btn-link small" onClick={() => onTab("bboxes")}>
            Mistral OCR: {ocr.text.pagesProcessed} page(s), {boxes} bounding box(es)
          </button>
        ) : (
          "Text input (no OCR)"
        )}
      </li>
      <li class="step step-done">
        <button type="button" class="btn btn-link small" onClick={() => onTab("schema")}>
          {schemaStep}
        </button>
      </li>
      {translation.bboxAnnotations.length > 0 ? (
        <li class="step step-done">
          <button type="button" class="btn btn-link small" onClick={() => onTab("bboxes")}>
            BBox annotation: {described} of {translation.bboxAnnotations.length} box(es) described by the vision model
          </button>
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
        <li class="step step-skipped">Structured text in the original language skipped</li>
      )}
    </ol>
  );
}

/** Live view of the translation while it streams: partial JSON rendered as it grows. */
function StreamingView({ text }: { text: string }) {
  let partial: unknown;
  try {
    partial = parsePartialJson(text);
  } catch {
    partial = undefined; // never let a parser edge case take the page down
  }
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
}

function OcrView({ state, onShowTranslation }: { state: AppState; onShowTranslation: (show: boolean) => void }) {
  const ocr = state.ocr;
  const [markdown, setMarkdown] = useState(true);
  if (!ocr) return null;
  const blockTranslations = state.translation?.blockTranslations ?? {};
  const translationsAvailable = Object.keys(blockTranslations).length > 0;
  const showTranslation = state.showTranslation && translationsAvailable;
  const headersFooters = ocr.text.pages.filter((p) => p.header || p.footer);
  const pages = ocr.text.pages.map((p) => {
    if (!showTranslation) return { page: p, text: p.markdown, missing: 0, translated: 0, total: 0 };
    const { text, total, translated } = translatedPageMarkdown(p, blockTranslations);
    return { page: p, text, missing: total - translated, translated, total };
  });
  const untranslated = pages.reduce((n, p) => n + p.missing, 0);
  // Untranslated, the full text keeps the page delimiters the model saw.
  const fullText = showTranslation ? pages.map((p) => p.text).join("\n\n") : ocr.text.text;

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {ocr.model} · {ocr.text.pagesProcessed} page(s) · {ocr.text.chars.toLocaleString()} characters (~{formatNumber(estimateTokens(ocr.text.text))} tokens)
          {ocr.source === "cache" ? " · from local cache" : ""}
          {ocr.text.bboxes.length ? ` · ${ocr.text.bboxes.length} bounding box(es)` : ""}
          {showTranslation ? ` · translated into ${state.translation?.targetLanguage} per text block` : ""}
        </span>
        <div class="btn-row">
          <TranslationToggle show={state.showTranslation} available={translationsAvailable} onShowTranslation={onShowTranslation} />
          <label class="checkbox small">
            <input type="checkbox" checked={markdown} onChange={(e) => setMarkdown((e.target as HTMLInputElement).checked)} />
            <span>Render Markdown</span>
          </label>
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(fullText)}>
            Copy text
          </button>
          <button
            type="button"
            class="btn btn-ghost small"
            onClick={() =>
              download(`${baseName(state)}.ocr${showTranslation ? ".translated" : ""}.md`, fullText, "text/markdown")
            }
          >
            Download .md
          </button>
        </div>
      </div>
      {state.showTranslation && !translationsAvailable && (state.translation || state.job) && (
        <p class="muted small">
          {state.job
            ? "The per-block translations are still being produced; the OCR text is shown in its original language."
            : "No per-block translations for this text yet: run “OCR + Translate” (the blocks are translated after the main translation) or keep “Translate each OCR text block” enabled in Settings."}
        </p>
      )}
      {showTranslation && untranslated > 0 && (
        <p class="muted small">{untranslated} block(s) came back without a translation; they are shown in the original language.</p>
      )}
      {headersFooters.length > 0 && (
        <details class="banner">
          <summary>Headers and footers removed from the translated text ({headersFooters.length} page(s))</summary>
          <ul class="hf-list">
            {headersFooters.map((p) => (
              <li key={p.index}>
                <strong>Page {p.index + 1}</strong>
                {p.header && <div class="muted small">Header: {p.header}</div>}
                {p.footer && <div class="muted small">Footer: {p.footer}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div class="ocr-pages">
        {pages.map(({ page, text, total }) => (
          <section class="ocr-page" key={page.index} id={`ocr-page-${page.index + 1}`}>
            <h3 class="ocr-page-title muted small">Page {page.index + 1}</h3>
            {showTranslation && total === 0 ? (
              <p class="muted small">The OCR API returned no text blocks for this page, so it cannot be shown translated.</p>
            ) : (
              <MarkdownText text={text || "(no text)"} markdown={markdown} />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
