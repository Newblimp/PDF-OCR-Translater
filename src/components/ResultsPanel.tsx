import { memo } from "preact/compat";
import { useMemo, useState } from "preact/hooks";
import type { AppState, JobKind, OcrState, ResultTab, TranslationState } from "@/app/store";
import { bilingualHtml } from "@/lib/export/bilingual";
import type { TokenUsage } from "@/lib/llm/provider";
import { PROVIDERS } from "@/lib/llm/registry";
import { loadMarkdownRenderer } from "@/lib/markdown";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import { textBlocks, translatedPageMarkdown } from "@/lib/pipeline/blockTranslate";
import type { StructureOriginalMode } from "@/lib/pipeline/pipeline";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { parsePartialJson } from "@/lib/util/partialJson";
import { estimateTokens, formatNumber } from "@/lib/util/text";
import { BboxView } from "./BboxView";
import { JsonBrowser } from "./JsonBrowser/JsonBrowser";
import { MarkdownText } from "./MarkdownText";

/** Stable callbacks from the app (created once, so the memoised views below skip unrelated re-renders). */
export interface ResultActions {
  setTab: (tab: ResultTab) => void;
  /** "Show translation", shared by the OCR text, Structured text and Raw JSON tabs. */
  setShowTranslation: (show: boolean) => void;
  /** Produce the structured text in the original language now. */
  produceOriginal: () => void;
  /** Run the bounding boxes or text blocks that failed again. */
  retry: (what: "bboxes" | "blocks") => void;
  useSchema: (schemaText: string) => void;
}

interface Props {
  state: AppState;
  actions: ResultActions;
}

const NO_ANNOTATIONS: BboxAnnotation[] = [];
const NO_BLOCK_TRANSLATIONS: Record<string, string> = {};

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
  const name = state.doc?.name ?? state.translation?.sourceName ?? "document";
  return name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_") || "document";
}

/** True when the original-language structured text is available for the toggle. */
function hasOriginal(translation: TranslationState): boolean {
  return translation.originalData !== null && translation.originalData !== undefined;
}

/** "1,234 in / 567 out tokens (1,000 cached, 50 reasoning)". */
function usageText(usage: TokenUsage | null): string {
  const extras = [
    usage?.cache_read_tokens ? `${formatNumber(usage.cache_read_tokens)} cached` : "",
    usage?.reasoning_tokens ? `${formatNumber(usage.reasoning_tokens)} reasoning` : "",
  ].filter(Boolean);
  return `${formatNumber(usage?.prompt_tokens)} in / ${formatNumber(usage?.completion_tokens)} out tokens${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export function ResultsPanel({ state, actions }: Props) {
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
  const name = baseName(state);
  const jobKind = state.job?.kind ?? null;

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
              onClick={() => actions.setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
      </div>

      {active === "bboxes" && ocr && (
        <BboxView
          doc={state.doc}
          ocr={ocr.text}
          annotations={translation?.bboxAnnotations ?? NO_ANNOTATIONS}
          blockTranslations={translation?.blockTranslations ?? NO_BLOCK_TRANSLATIONS}
        />
      )}

      {active === "ocr" && ocr && (
        <OcrView ocr={ocr} translation={translation} showTranslation={state.showTranslation} busy={!!state.job} baseName={name} actions={actions} />
      )}

      {active === "structured" && streamText && (
        <div class="tab-panel">
          <StreamingView text={streamText} />
        </div>
      )}

      {active === "structured" && translation && !streamText && (
        <StructuredView
          translation={translation}
          ocr={ocr}
          showTranslation={state.showTranslation}
          jobKind={jobKind}
          structureMode={state.settings.structureOriginal}
          baseName={name}
          actions={actions}
        />
      )}

      {active === "schema" && translation && <SchemaView translation={translation} actions={actions} />}

      {active === "json" && translation && <RawJsonView translation={translation} showTranslation={state.showTranslation} baseName={name} actions={actions} />}
    </div>
  );
}

const SchemaView = memo(function SchemaView({ translation, actions }: { translation: TranslationState; actions: ResultActions }) {
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

/**
 * "Show translation": switches the OCR text and the structured text between
 * the document's own language and the translation. One shared state, so all
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

/** Bilingual HTML: the translation next to the original, field by field and block by block. */
async function downloadBilingual(translation: TranslationState, ocr: OcrState | null, name: string): Promise<void> {
  const render = await loadMarkdownRenderer().catch(() => null);
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
const StructuredView = memo(function StructuredView({
  translation,
  ocr,
  showTranslation: wantTranslation,
  jobKind,
  structureMode,
  baseName: name,
  actions,
}: {
  translation: TranslationState;
  ocr: OcrState | null;
  showTranslation: boolean;
  jobKind: JobKind | null;
  structureMode: StructureOriginalMode;
  baseName: string;
  actions: ResultActions;
}) {
  const original = hasOriginal(translation);
  const showTranslation = wantTranslation || !original;
  const data = showTranslation ? translation.data : translation.originalData;
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
          <button
            type="button"
            class="btn btn-ghost small"
            onClick={() => download(`${name}.${showTranslation ? "translation" : "original"}.json`, prettyJson(data), "application/json")}
          >
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

const RawJsonView = memo(function RawJsonView({
  translation,
  showTranslation: wantTranslation,
  baseName: name,
  actions,
}: {
  translation: TranslationState;
  showTranslation: boolean;
  baseName: string;
  actions: ResultActions;
}) {
  const original = hasOriginal(translation);
  const showTranslation = wantTranslation || !original;
  const data = showTranslation ? translation.data : translation.originalData;
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
          <button
            type="button"
            class="btn btn-ghost small"
            onClick={() => download(`${name}.${showTranslation ? "translation" : "original"}.json`, text, "application/json")}
          >
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
          {failed > 0 && ocr && (
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
          Structured text in the original language {structureMode === "never" ? "turned off" : "not produced yet (switch off “Show translation” to produce it)"}
        </li>
      )}
    </ol>
  );
}

/** Live view of the translation while it streams: partial JSON rendered as it grows. */
const StreamingView = memo(function StreamingView({ text }: { text: string }) {
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

const OcrView = memo(function OcrView({
  ocr,
  translation,
  showTranslation: wantTranslation,
  busy,
  baseName: name,
  actions,
}: {
  ocr: OcrState;
  translation: TranslationState | null;
  showTranslation: boolean;
  busy: boolean;
  baseName: string;
  actions: ResultActions;
}) {
  const [markdown, setMarkdown] = useState(true);
  const blockTranslations = translation?.blockTranslations ?? NO_BLOCK_TRANSLATIONS;
  const translationsAvailable = Object.keys(blockTranslations).length > 0;
  const showTranslation = wantTranslation && translationsAvailable;
  const headersFooters = ocr.text.pages.filter((p) => p.header || p.footer);
  const pages = useMemo(
    () =>
      ocr.text.pages.map((p) => {
        if (!showTranslation) return { page: p, text: p.markdown, missing: 0, translated: 0, total: 0 };
        const { text, total, translated } = translatedPageMarkdown(p, blockTranslations);
        return { page: p, text, missing: total - translated, translated, total };
      }),
    [ocr, showTranslation, blockTranslations],
  );
  const untranslated = pages.reduce((n, p) => n + p.missing, 0);
  // Untranslated, the full text keeps the page delimiters the model saw.
  const fullText = showTranslation ? pages.map((p) => p.text).join("\n\n") : ocr.text.text;
  const tokens = useMemo(() => estimateTokens(ocr.text.text), [ocr]);
  const hasTextBlocks = useMemo(() => ocr.text.pages.some((p) => textBlocks(p).length > 0), [ocr]);

  return (
    <div class="tab-panel">
      <div class="toolbar">
        <span class="muted small">
          {ocr.model} · {ocr.text.pagesProcessed} page(s) · {ocr.text.chars.toLocaleString()} characters (~{formatNumber(tokens)} tokens)
          {ocr.source === "cache" ? " · from local cache" : ""}
          {ocr.text.bboxes.length ? ` · ${ocr.text.bboxes.length} bounding box(es)` : ""}
          {showTranslation ? ` · translated into ${translation?.targetLanguage} per text block` : ""}
        </span>
        <div class="btn-row">
          <TranslationToggle show={wantTranslation} available={translationsAvailable} onShowTranslation={actions.setShowTranslation} />
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
            onClick={() => download(`${name}.ocr${showTranslation ? ".translated" : ""}.md`, fullText, "text/markdown")}
          >
            Download .md
          </button>
        </div>
      </div>
      {wantTranslation && !translationsAvailable && (translation || busy) && (
        <p class="muted small">
          {busy
            ? "The per-block translations are still being produced; the OCR text is shown in its original language."
            : "No per-block translations for this text yet: run “OCR + Translate” (the blocks are translated after the main translation) or keep “Translate each OCR text block” enabled in Settings."}
          {!busy && translation && hasTextBlocks && (
            <>
              {" "}
              <button type="button" class="btn btn-ghost small" onClick={() => actions.retry("blocks")}>
                Translate the blocks now
              </button>
            </>
          )}
        </p>
      )}
      {showTranslation && untranslated > 0 && (
        <p class="muted small">
          {untranslated} block(s) came back without a translation; they are shown in the original language.{" "}
          <button type="button" class="btn btn-ghost small" disabled={busy} onClick={() => actions.retry("blocks")}>
            Retry them
          </button>
        </p>
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
});
