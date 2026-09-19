import { useState } from "preact/hooks";
import type { AppState, ResultTab, TranslationState } from "@/app/store";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { parsePartialJson } from "@/lib/util/partialJson";
import type { JsonSchemaObject } from "@/lib/mistral/types";
import { BboxView } from "./BboxView";
import { estimateTokens, formatNumber } from "@/lib/util/text";
import { PROVIDERS } from "@/lib/llm/registry";
import { JsonBrowser } from "./JsonBrowser/JsonBrowser";
import { MarkdownText } from "./MarkdownText";

interface Props {
  state: AppState;
  onTab: (tab: ResultTab) => void;
  onUseSchema: (schemaText: string) => void;
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

export function ResultsPanel({ state, onTab, onUseSchema }: Props) {
  const { translation, ocr } = state;
  const tabs: Array<{ id: ResultTab; label: string; available: boolean }> = [
    { id: "translation", label: "Translation", available: !!translation || !!state.job?.streamText },
    { id: "bboxes", label: "Bounding boxes", available: !!ocr },
    { id: "ocr", label: "OCR text", available: !!ocr },
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
          <li>Browse the translated fields, the OCR text, and the inferred JSON format.</li>
        </ol>
        <p class="muted small">
          The file is encoded in your browser and sent to api.mistral.ai for OCR; the OCR text goes to the translation provider. Nothing is
          uploaded to this site's host.
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

      {active === "translation" && state.job?.streamText && (
        <div class="tab-panel">
          <StreamingView text={state.job.streamText} schema={translation?.schema ?? null} />
        </div>
      )}

      {active === "translation" && translation && !state.job?.streamText && (
        <div class="tab-panel">
          <div class="toolbar">
            <span class="muted small">
              {PROVIDERS[translation.provider].label} · {translation.model} · → {translation.targetLanguage} ·{" "}
              {translation.mode === "json_schema" ? "strict JSON schema" : "JSON mode"} · {formatNumber(translation.usage?.prompt_tokens)} in /{" "}
              {formatNumber(translation.usage?.completion_tokens)} out tokens
              {translation.usage?.reasoning_tokens ? ` (${formatNumber(translation.usage.reasoning_tokens)} reasoning)` : ""}
            </span>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost small" onClick={() => void copy(prettyJson(translation.data))}>
                Copy JSON
              </button>
              <button
                type="button"
                class="btn btn-ghost small"
                onClick={() => download(`${baseName(state)}.translation.json`, prettyJson(translation.data), "application/json")}
              >
                Download JSON
              </button>
            </div>
          </div>
          <PipelineStrip translation={translation} ocr={ocr} onTab={onTab} />
          {(translation.violations.length > 0 || translation.finishReason === "length" || translation.finishReason === "model_length") && (
            <div class="banner banner-warn">
              {translation.finishReason === "length" || translation.finishReason === "model_length" ? (
                <p>The model reached its output limit, so the translation may be truncated. Try a model with a larger context or split the document.</p>
              ) : null}
              {translation.violations.length > 0 && (
                <details>
                  <summary>{translation.violations.length} deviation(s) from the JSON format</summary>
                  <pre class="details-pre">{translation.violations.join("\n")}</pre>
                </details>
              )}
            </div>
          )}
          <JsonBrowser data={translation.data} schema={translation.schema} />
        </div>
      )}

      {active === "bboxes" && ocr && <BboxView doc={state.doc} ocr={ocr.text} annotations={translation?.bboxAnnotations ?? []} />}

      {active === "ocr" && ocr && <OcrView state={state} />}

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

      {active === "json" && translation && (
        <div class="tab-panel">
          <div class="toolbar">
            <span class="muted small">{translation.rawText.length.toLocaleString()} characters</span>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost small" onClick={() => void copy(prettyJson(translation.data))}>
                Copy
              </button>
              <button
                type="button"
                class="btn btn-ghost small"
                onClick={() => download(`${baseName(state)}.translation.json`, prettyJson(translation.data), "application/json")}
              >
                Download
              </button>
            </div>
          </div>
          <pre class="code-block">{prettyJson(translation.data)}</pre>
        </div>
      )}
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
    </ol>
  );
}

/** Live view of the translation while it streams: partial JSON rendered as it grows. */
function StreamingView({ text, schema }: { text: string; schema: JsonSchemaObject | null }) {
  const partial = parsePartialJson(text);
  return (
    <div class="stream-panel" aria-live="polite">
      <div class="toolbar">
        <span class="small">
          <span class="stream-cursor">Translation streaming in… {text.length.toLocaleString()} characters</span>
        </span>
      </div>
      <pre class="stream-tail">{text.slice(-400)}</pre>
      {partial !== undefined && isPlainObject(partial) && Object.keys(partial).length > 0 && <JsonBrowser data={partial} schema={schema} />}
    </div>
  );
}

function OcrView({ state }: { state: AppState }) {
  const ocr = state.ocr;
  const [markdown, setMarkdown] = useState(true);
  if (!ocr) return null;
  const headersFooters = ocr.text.pages.filter((p) => p.header || p.footer);
  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {ocr.model} · {ocr.text.pagesProcessed} page(s) · {ocr.text.chars.toLocaleString()} characters (~{formatNumber(estimateTokens(ocr.text.text))} tokens)
          {ocr.source === "cache" ? " · from local cache" : ""}
          {ocr.text.bboxes.length ? ` · ${ocr.text.bboxes.length} bounding box(es)` : ""}
        </span>
        <div class="btn-row">
          <label class="checkbox small">
            <input type="checkbox" checked={markdown} onChange={(e) => setMarkdown((e.target as HTMLInputElement).checked)} />
            <span>Render Markdown</span>
          </label>
          <button type="button" class="btn btn-ghost small" onClick={() => void copy(ocr.text.text)}>
            Copy text
          </button>
          <button type="button" class="btn btn-ghost small" onClick={() => download(`${baseName(state)}.ocr.md`, ocr.text.text, "text/markdown")}>
            Download .md
          </button>
        </div>
      </div>
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
        {ocr.text.pages.map((p) => (
          <section class="ocr-page" key={p.index} id={`ocr-page-${p.index + 1}`}>
            <h3 class="ocr-page-title muted small">Page {p.index + 1}</h3>
            <MarkdownText text={p.markdown || "(no text)"} markdown={markdown} />
          </section>
        ))}
      </div>
    </div>
  );
}
