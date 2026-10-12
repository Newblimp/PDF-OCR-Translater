import { defaultResultLayout, excludedBlocks, hasStructure, ocrBelongsTo, RESULT_TABS, selectTextPages, type AppState, type ResultTab } from "@/app/store";
import type { BboxAnnotation } from "@/lib/pipeline/bboxAnnotate";
import type { BoxEdit } from "@/lib/pipeline/blockEdits";
import type { OcrCleanPage } from "@/lib/pipeline/ocrText";
import { sameArrangement, type DockTarget } from "@/lib/util/dock";
import { Dock } from "./Dock";
import { lazyView } from "./lazyView";

// The views load with the first result that needs them; the JSON views only with "JSON output" on.
const BboxView = lazyView(() => import("./BboxView").then((m) => m.BboxView));
const EditBoxesView = lazyView(() => import("./EditBoxesView").then((m) => m.EditBoxesView));
const OcrView = lazyView(() => import("./OcrView").then((m) => m.OcrView));
const SchemaView = lazyView(() => import("./JsonViews").then((m) => m.SchemaView));
const StructuredView = lazyView(() => import("./JsonViews").then((m) => m.StructuredView));
const RawJsonView = lazyView(() => import("./JsonViews").then((m) => m.RawJsonView));
const StreamingView = lazyView(() => import("./JsonViews").then((m) => m.StreamingView));

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
  /** "Edit bounding boxes": an edit of a page's blocks, undo, and back to the OCR as returned (one page or all). */
  editBoxes: (edit: BoxEdit) => void;
  undoBoxEdit: () => void;
  resetBoxEdits: (pageIndex?: number) => void;
}

interface Props {
  state: AppState;
  actions: ResultActions;
}

const TAB_LABELS: Record<ResultTab, string> = {
  bboxes: "Bounding boxes",
  edit: "Edit bounding boxes",
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
        case "edit":
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
      case "edit":
        return (
          ocr && (
            <EditBoxesView
              doc={state.doc}
              ocr={ocr}
              busy={!!state.job}
              onEdit={actions.editBoxes}
              onUndo={actions.undoBoxEdit}
              onReset={actions.resetBoxEdits}
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
