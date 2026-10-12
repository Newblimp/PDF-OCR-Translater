import { memo } from "preact/compat";
import { useEffect, useMemo } from "preact/hooks";
import {
  defaultResultLayout,
  excludedBlocks,
  hasStructure,
  ocrBelongsTo,
  RESULT_TABS,
  selectTextPages,
  type AppState,
  type JobKind,
  type OcrState,
  type ResultTab,
  type TranslationState,
} from "@/app/store";
import { bilingualHtml } from "@/lib/export/bilingual";
import { PROVIDERS } from "@/lib/llm/registry";
import { loadExportMarkdownRenderer } from "@/lib/markdown";
import type { JsonSchemaObject } from "@/lib/mistral/types";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import type { OcrCleanPage } from "@/lib/pipeline/ocrText";
import type { StructureOriginalMode } from "@/lib/pipeline/pipeline";
import { sameArrangement, type DockTarget } from "@/lib/util/dock";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { parsePartialJson } from "@/lib/util/partialJson";
import { formatNumber } from "@/lib/util/text";
import { BboxView } from "./BboxView";
import { Dock } from "./Dock";
import { JsonBrowser } from "./JsonBrowser/JsonBrowser";
import { OcrView } from "./OcrView";
import { copy, download, TranslationToggle, usageText } from "./resultControls";

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
  /** OCR text tab: the block types left out of the text (saved with the settings). */
  setOcrHiddenTypes: (types: string[]) => void;
  /** OCR text tab: place the blocks as on the page. */
  setOcrMatchLayout: (match: boolean) => void;
  /** OCR text tab: pick blocks on the pages beside the text. */
  setOcrPickBlocks: (pick: boolean) => void;
  /** Leave a block of these pages out of the OCR text, or take it back. */
  toggleBlock: (pages: readonly OcrCleanPage[], id: string) => void;
  /** Take back every block left out one by one. */
  includeAllBlocks: () => void;
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

function baseName(state: AppState): string {
  const name = state.doc?.name ?? state.translation?.sourceName ?? "document";
  return name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_") || "document";
}

/** True when the original-language structured text is available for the toggle. */
function hasOriginal(translation: TranslationState): boolean {
  return translation.originalData !== null && translation.originalData !== undefined;
}

export function ResultsPanel({ state, actions }: Props) {
  const { translation, ocr, settings } = state;
  const streamText = state.job?.streamText;
  // The JSON tabs only with "JSON output" on in Settings, and for a translation that filled a JSON format.
  const structured = settings.jsonOutput && translation && hasStructure(translation) ? translation : null;
  const text = selectTextPages(state);
  // The translation made from the pages shown in the OCR text tab (its block translations fit them).
  const textTranslation = translation && text && (!text.fromOcr || (ocr && ocrBelongsTo(ocr, translation))) ? translation : null;
  const available = new Set<ResultTab>(
    RESULT_TABS.filter((tab) => {
      switch (tab) {
        case "bboxes":
          return !!ocr;
        case "ocr":
          return !!text;
        case "structured":
          return !!structured || (settings.jsonOutput && !!streamText);
        case "schema":
        case "json":
          return !!structured;
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
          <li>
            Browse the bounding boxes and the OCR text, original or translated block by block; leave out block types or single blocks.
            {settings.jsonOutput ? " The structured text fills a JSON format with the translation." : " Turn on “JSON output” in Settings for structured text."}
          </li>
        </ol>
        <p class="muted small">
          The file is encoded in your browser and sent to api.mistral.ai for OCR; the OCR text and the cropped figure images it returns go to the translation
          provider (configurable in Settings). Nothing is uploaded to this site's host.
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
              blockTranslations={translation && ocrBelongsTo(ocr, translation) ? translation.blockTranslations : NO_BLOCK_TRANSLATIONS}
            />
          )
        );
      case "ocr":
        return (
          text && (
            <OcrView
              pages={text.pages}
              ocr={text.fromOcr ? ocr : null}
              doc={state.doc}
              translation={textTranslation}
              showPdf={settings.ocrShowPdf}
              linkScroll={settings.ocrLinkScroll}
              matchLayout={settings.ocrMatchLayout}
              pickBlocks={settings.ocrPickBlocks}
              hiddenTypes={settings.ocrHiddenTypes}
              excluded={excludedBlocks(state, text.pages)}
              canRetry={!!textTranslation}
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
          structured && (
            <StructuredView
              translation={structured}
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
        return structured && <SchemaView translation={structured} actions={actions} />;
      case "json":
        return (
          structured && (
            <RawJsonView
              translation={structured}
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

/** A translation that filled a JSON format. */
type StructuredTranslation = TranslationState & { schema: JsonSchemaObject };

const SchemaView = memo(function SchemaView({ translation, actions }: { translation: StructuredTranslation; actions: ResultActions }) {
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
 * With "Show translation" off, a view of the structured text needs it in the
 * original language: ask for it once (on-demand mode), rather than on every
 * flip of the switch in the OCR tab, which does not need it.
 */
function useOriginalOnDemand(
  translation: TranslationState,
  wantTranslation: boolean,
  jobKind: JobKind | null,
  structureMode: StructureOriginalMode,
  actions: ResultActions,
): void {
  const missing = !hasOriginal(translation);
  useEffect(() => {
    if (!wantTranslation && missing && !jobKind && structureMode !== "never") actions.requestOriginal();
  }, [wantTranslation, missing, jobKind, structureMode, actions, translation.id]);
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
const StructuredView = memo(function StructuredView({
  translation,
  ocr,
  showTranslation: wantTranslation,
  jobKind,
  structureMode,
  baseName: name,
  actions,
}: {
  translation: StructuredTranslation;
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
          Structured text in the original language{" "}
          {structureMode === "never" ? "turned off" : "not produced yet (switch off “Show translation” here to produce it)"}
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
