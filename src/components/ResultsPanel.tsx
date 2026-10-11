import { memo } from "preact/compat";
import type { RefObject } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { defaultResultLayout, ocrBelongsTo, RESULT_TABS, type AppState, type DocState, type JobKind, type OcrState, type ResultTab, type TranslationState } from "@/app/store";
import { bilingualHtml } from "@/lib/export/bilingual";
import type { TokenUsage } from "@/lib/llm/provider";
import { PROVIDERS } from "@/lib/llm/registry";
import { loadExportMarkdownRenderer } from "@/lib/markdown";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import { textBlocks, translatedPageMarkdown } from "@/lib/pipeline/blockTranslate";
import type { OcrCleanPage } from "@/lib/pipeline/ocrText";
import type { StructureOriginalMode } from "@/lib/pipeline/pipeline";
import { sameArrangement, type DockTarget } from "@/lib/util/dock";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { parsePartialJson } from "@/lib/util/partialJson";
import { estimateTokens, formatNumber } from "@/lib/util/text";
import { BboxView } from "./BboxView";
import { Dock } from "./Dock";
import { JsonBrowser } from "./JsonBrowser/JsonBrowser";
import { MarkdownText } from "./MarkdownText";
import { usePageRenderer, useRenderedPages } from "./pageImages";
import { useLinkedScroll } from "./useLinkedScroll";

/** Stable callbacks from the app (created once, so the memoised views below skip unrelated re-renders). */
export interface ResultActions {
  /** Show a tab (in whichever group of the split views it is). */
  setTab: (tab: ResultTab) => void;
  /** Drag and drop of a tab: into another group, or into a new split view beside a group. */
  moveTab: (tab: ResultTab, target: DockTarget) => void;
  resizeSplit: (split: string, sizes: number[]) => void;
  resetLayout: () => void;
  /** "Show translation", shared by the OCR text, Structured text and Raw JSON tabs. */
  setShowTranslation: (show: boolean) => void;
  /** The structured text in the original language is on screen but missing: produce it (once per translation). */
  requestOriginal: () => void;
  /** Produce the structured text in the original language now (the user asked). */
  produceOriginal: () => void;
  /** Run the bounding boxes or text blocks that failed again. */
  retry: (what: "bboxes" | "blocks") => void;
  useSchema: (schemaText: string) => void;
  /** OCR text tab: show the document's pages beside the text (saved with the settings). */
  setOcrShowPdf: (show: boolean) => void;
  /** OCR text tab: scroll the pages and the text together. */
  setOcrLinkScroll: (link: boolean) => void;
}

interface Props {
  state: AppState;
  actions: ResultActions;
}

const TAB_LABELS: Record<ResultTab, string> = {
  bboxes: "Bounding boxes",
  ocr: "OCR text",
  structured: "Structured text",
  schema: "JSON format",
  json: "Raw JSON",
};
const DEFAULT_LAYOUT = defaultResultLayout();

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
  const available = new Set<ResultTab>(
    RESULT_TABS.filter((tab) => {
      switch (tab) {
        case "bboxes":
        case "ocr":
          return !!ocr;
        case "structured":
          return !!translation || !!streamText;
        case "schema":
        case "json":
          return !!translation;
      }
    }),
  );
  const name = baseName(state);
  const jobKind = state.job?.kind ?? null;

  if (available.size === 0) {
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

  const renderTab = (tab: ResultTab) => {
    switch (tab) {
      case "bboxes":
        return (
          ocr && (
            <BboxView
              doc={state.doc}
              ocr={ocr.text}
              annotations={translation?.bboxAnnotations ?? NO_ANNOTATIONS}
              blockTranslations={translation?.blockTranslations ?? NO_BLOCK_TRANSLATIONS}
            />
          )
        );
      case "ocr":
        return (
          ocr && (
            <OcrView
              ocr={ocr}
              doc={state.doc}
              showPdf={state.settings.ocrShowPdf}
              linkScroll={state.settings.ocrLinkScroll}
              translation={translation}
              canRetry={!!translation && ocrBelongsTo(ocr, translation)}
              showTranslation={state.showTranslation}
              busy={!!state.job}
              baseName={name}
              actions={actions}
            />
          )
        );
      case "structured":
        if (streamText) {
          return (
            <div class="tab-panel">
              <StreamingView text={streamText} />
            </div>
          );
        }
        return (
          translation && (
            <StructuredView
              translation={translation}
              ocr={ocr}
              showTranslation={state.showTranslation}
              jobKind={jobKind}
              structureMode={state.settings.structureOriginal}
              baseName={name}
              actions={actions}
            />
          )
        );
      case "schema":
        return translation && <SchemaView translation={translation} actions={actions} />;
      case "json":
        return (
          translation && (
            <RawJsonView
              translation={translation}
              showTranslation={state.showTranslation}
              jobKind={jobKind}
              structureMode={state.settings.structureOriginal}
              baseName={name}
              actions={actions}
            />
          )
        );
    }
  };

  return (
    <Dock
      layout={state.resultLayout}
      tabs={RESULT_TABS}
      labels={TAB_LABELS}
      available={available}
      renderTab={renderTab}
      customised={!sameArrangement(state.resultLayout, DEFAULT_LAYOUT)}
      onActivate={actions.setTab}
      onMove={actions.moveTab}
      onResize={actions.resizeSplit}
      onReset={actions.resetLayout}
    />
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

/**
 * With "Show translation" off, a view of the structured text needs it in the
 * original language: ask for it once (on-demand mode), rather than on every
 * flip of the switch in the OCR tab, which does not need it.
 */
function useOriginalOnDemand(translation: TranslationState, wantTranslation: boolean, jobKind: JobKind | null, structureMode: StructureOriginalMode, actions: ResultActions): void {
  const missing = !hasOriginal(translation);
  useEffect(() => {
    if (!wantTranslation && missing && !jobKind && structureMode !== "never") actions.requestOriginal();
  }, [wantTranslation, missing, jobKind, structureMode, actions, translation.id]);
}

/** Bilingual HTML: the translation next to the original, field by field and block by block. */
async function downloadBilingual(translation: TranslationState, ocr: OcrState | null, name: string): Promise<void> {
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
  useOriginalOnDemand(translation, wantTranslation, jobKind, structureMode, actions);
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
  jobKind,
  structureMode,
  baseName: name,
  actions,
}: {
  translation: TranslationState;
  showTranslation: boolean;
  jobKind: JobKind | null;
  structureMode: StructureOriginalMode;
  baseName: string;
  actions: ResultActions;
}) {
  useOriginalOnDemand(translation, wantTranslation, jobKind, structureMode, actions);
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
          Structured text in the original language {structureMode === "never" ? "turned off" : "not produced yet (switch off “Show translation” here to produce it)"}
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
  doc,
  showPdf,
  linkScroll,
  translation,
  canRetry,
  showTranslation: wantTranslation,
  busy,
  baseName: name,
  actions,
}: {
  ocr: OcrState;
  /** The loaded document, for its pages beside the text. */
  doc: DocState | null;
  showPdf: boolean;
  linkScroll: boolean;
  translation: TranslationState | null;
  /** The translation was made from this OCR result, so its blocks can be (re)translated into it. */
  canRetry: boolean;
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
  // The pages can be shown while the document this OCR result was made from is loaded.
  const pagesAvailable = !!doc && doc.id === ocr.docId && (doc.kind === "pdf" || doc.kind === "image");
  const comparing = showPdf && pagesAvailable;
  const pdfColumn = useRef<HTMLDivElement>(null);
  const textColumn = useRef<HTMLDivElement>(null);
  useLinkedScroll(pdfColumn, textColumn, comparing && linkScroll);

  const textPages = (
    <div class={`ocr-pages${comparing ? " ocr-compare-col" : ""}`} ref={textColumn} aria-label={comparing ? "OCR text" : undefined}>
      {pages.map(({ page, text, total }) => (
        <section class="ocr-page" key={page.index} id={`ocr-page-${page.index + 1}`} data-page={page.index}>
          <h3 class="ocr-page-title muted small">Page {page.index + 1}</h3>
          {showTranslation && total === 0 ? (
            <p class="muted small">The OCR API returned no text blocks for this page, so it cannot be shown translated.</p>
          ) : (
            <MarkdownText text={text || "(no text)"} markdown={markdown} />
          )}
        </section>
      ))}
    </div>
  );

  return (
    <div class={`tab-panel${comparing ? " tab-panel-fill" : ""}`}>
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
          <label class="checkbox small" title={pagesAvailable ? "Show the document's pages beside the text" : "Load the document to see its pages beside the text"}>
            <input
              type="checkbox"
              checked={comparing}
              disabled={!pagesAvailable}
              onChange={(e) => actions.setOcrShowPdf((e.target as HTMLInputElement).checked)}
            />
            <span>Show {doc?.kind === "image" ? "image" : "PDF"}</span>
          </label>
          {comparing && (
            <label class="checkbox small" title="Scroll the pages and the text together, page by page">
              <input type="checkbox" checked={linkScroll} onChange={(e) => actions.setOcrLinkScroll((e.target as HTMLInputElement).checked)} />
              <span>Lock scrolling</span>
            </label>
          )}
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
          {!busy && canRetry && hasTextBlocks && (
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
          {untranslated} block(s) came back without a translation; they are shown in the original language.
          {canRetry && (
            <>
              {" "}
              <button type="button" class="btn btn-ghost small" disabled={busy} onClick={() => actions.retry("blocks")}>
                Retry them
              </button>
            </>
          )}
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
      {comparing && doc ? (
        <div class="ocr-compare">
          <PdfPages doc={doc} pages={ocr.text.pages} column={pdfColumn} />
          {textPages}
        </div>
      ) : (
        textPages
      )}
    </div>
  );
});

/**
 * The document's pages, rendered in the background (visible ones first),
 * laid out like the OCR text beside them: a title, then the page.
 */
const PdfPages = memo(function PdfPages({ doc, pages, column }: { doc: DocState; pages: OcrCleanPage[]; column: RefObject<HTMLDivElement> }) {
  const renderer = usePageRenderer(doc);
  const indexes = useMemo(() => pages.map((p) => p.index), [pages]);
  const rendered = useRenderedPages(renderer, indexes);
  const [errors, setErrors] = useState<Record<number, string>>({});

  // Pages coming into view render first; the rest follow in the background.
  useEffect(() => {
    const root = column.current;
    if (!renderer || !root) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset["page"]);
          if (!entry.isIntersecting || renderer.peek(index)) continue;
          renderer.get(index).catch((err: unknown) => {
            if (!cancelled) setErrors((e) => ({ ...e, [index]: err instanceof Error ? err.message : String(err) }));
          });
        }
      },
      { root, rootMargin: "100% 0px" },
    );
    for (const el of root.querySelectorAll(":scope > [data-page]")) observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [renderer, column, indexes]);

  return (
    <div class="ocr-compare-col ocr-pdf-pages" ref={column} aria-label="Document pages">
      {pages.map((page) => {
        const url = rendered[page.index];
        const error = errors[page.index];
        return (
          <section class="ocr-pdf-page" key={page.index} data-page={page.index}>
            <h3 class="ocr-page-title muted small">Page {page.index + 1}</h3>
            <div class="ocr-pdf-sheet" style={`aspect-ratio:${page.width ?? 1000}/${page.height ?? 1414}`}>
              {url ? (
                <img src={url} alt={`Page ${page.index + 1}`} />
              ) : (
                <div class="ocr-pdf-placeholder small">{error ? `Page could not be rendered: ${error}` : "Rendering page…"}</div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
});
