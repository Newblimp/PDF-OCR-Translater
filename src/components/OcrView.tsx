import { memo } from "preact/compat";
import type { RefObject } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DocState, OcrState, TranslationState } from "@/app/store";
import { blockTypeCounts, filteredText, isShown, pageBlocks, shownTextBlockIds, type BlockFilter, type ViewBlock } from "@/lib/pipeline/blocks";
import type { OcrCleanPage } from "@/lib/pipeline/ocrText";
import { estimateTokens, formatNumber } from "@/lib/util/text";
import { blockColor, blockTypeLabel, boxStyle } from "./blockColors";
import { MarkdownText } from "./MarkdownText";
import { usePageRenderer, useRenderedPages } from "./pageImages";
import { copy, download, TranslationToggle, usageText } from "./resultControls";
import type { ResultActions } from "./ResultsPanel";
import { FIT_BLOCK, useFitText } from "./useFitText";
import { useLinkedScroll } from "./useLinkedScroll";
import { Check } from "./Check";

const NO_TRANSLATIONS: Record<string, string> = {};
/** "Match page layout": a block's font is at most one line filling its box, and never larger than a heading (in cqw of the sheet). */
const MAX_FONT_CQW = 4;
const LINE_HEIGHT = 1.25;

interface PageView {
  page: OcrCleanPage;
  blocks: ViewBlock[];
}

/** Picking blocks on the pages beside the text: what is left out, and what a click or a hover does. */
interface Picker {
  hidden: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  toggle: (id: string) => void;
  highlight: (id: string, on: boolean) => void;
}

interface Props {
  /** The pages shown: the OCR result's, or the blocks of a translation made without the JSON format. */
  pages: OcrCleanPage[];
  /** The OCR result the pages come from; null for text input and for a saved translation without it. */
  ocr: OcrState | null;
  /** The loaded document, for its pages beside the text. */
  doc: DocState | null;
  /** The translation made from these pages (its per-block translations are shown), if any. */
  translation: TranslationState | null;
  showPdf: boolean;
  linkScroll: boolean;
  matchLayout: boolean;
  pickBlocks: boolean;
  /** Block types left out of the text (Settings). */
  hiddenTypes: string[];
  /** Blocks left out one by one. */
  excluded: ReadonlySet<string>;
  /** The translation's blocks can be (re)translated into it. */
  canRetry: boolean;
  showTranslation: boolean;
  busy: boolean;
  baseName: string;
  actions: ResultActions;
}

/**
 * The OCR text block by block, in the document's language or translated:
 * filtered by block type and block by block (picked on the pages beside
 * it), in reading order or placed as on the page ("Match page layout").
 */
export const OcrView = memo(function OcrView({
  pages,
  ocr,
  doc,
  translation,
  showPdf,
  linkScroll,
  matchLayout,
  pickBlocks,
  hiddenTypes,
  excluded,
  canRetry,
  showTranslation: wantTranslation,
  busy,
  baseName: name,
  actions,
}: Props) {
  const [markdown, setMarkdown] = useState(true);
  const blockTranslations = translation?.blockTranslations ?? NO_TRANSLATIONS;
  const translationsAvailable = Object.keys(blockTranslations).length > 0;
  const showTranslation = wantTranslation && translationsAvailable;
  const translations = showTranslation ? blockTranslations : null;

  const views = useMemo<PageView[]>(() => pages.map((page) => ({ page, blocks: pageBlocks(page) })), [pages]);
  const types = useMemo(() => blockTypeCounts(pages), [pages]);
  const hidden = useMemo(() => new Set(hiddenTypes), [hiddenTypes]);
  const filter = useMemo<BlockFilter>(() => ({ hiddenTypes: hidden, excluded }), [hidden, excluded]);
  const shownIds = useMemo(() => shownTextBlockIds(pages, filter), [pages, filter]);
  const translated = useMemo(() => [...shownIds].filter((id) => blockTranslations[id]?.trim()).length, [shownIds, blockTranslations]);
  const fullText = useMemo(() => filteredText(pages, filter, translations), [pages, filter, translations]);
  const sourceText = ocr?.text.text ?? translation?.sourceText ?? "";
  const tokens = useMemo(() => estimateTokens(sourceText), [sourceText]);
  const images = useMemo(() => new Map((ocr?.text.bboxes ?? []).flatMap((b) => (b.dataUrl ? [[b.id, b.dataUrl] as const] : []))), [ocr]);
  const headersFooters = pages.filter((p) => p.header || p.footer);
  const canLayout = views.some((v) => v.page.width && v.page.height && v.blocks.some((b) => b.box));
  const layout = matchLayout && canLayout;
  // The pages can be shown while the document this OCR result was made from is loaded.
  const pagesAvailable = !!ocr && !!doc && doc.id === ocr.docId && (doc.kind === "pdf" || doc.kind === "image");
  const comparing = showPdf && pagesAvailable;
  const pdfColumn = useRef<HTMLDivElement>(null);
  const textColumn = useRef<HTMLDivElement>(null);
  // Leaving blocks out or switching the layout moves the text under the pages: it follows them again.
  useLinkedScroll(pdfColumn, textColumn, comparing && linkScroll, `${layout}|${hiddenTypes.join()}|${[...excluded].join()}`);

  const highlight = useCallback((id: string, on: boolean) => {
    textColumn.current?.querySelector(`[data-block="${CSS.escape(id)}"]`)?.classList.toggle("ocr-block-hot", on);
  }, []);
  const picker = useMemo<Picker | null>(
    () => (comparing && pickBlocks ? { hidden, excluded, toggle: (id) => actions.toggleBlock(pages, id), highlight } : null),
    [comparing, pickBlocks, hidden, excluded, actions, pages, highlight],
  );
  const setTypeShown = (type: string, shown: boolean) => actions.setOcrHiddenTypes(shown ? hiddenTypes.filter((t) => t !== type) : [...hiddenTypes, type]);

  const source = ocr
    ? `${ocr.model} · ${ocr.text.pagesProcessed} page(s) · ${ocr.text.chars.toLocaleString()} characters (~${formatNumber(tokens)} tokens)${ocr.source === "cache" ? " · from local cache" : ""}${ocr.text.bboxes.length ? ` · ${ocr.text.bboxes.length} bounding box(es)` : ""}`
    : `${translation?.sourceName ?? "Text"} · ${pages.length} page(s) · ${sourceText.length.toLocaleString()} characters (~${formatNumber(tokens)} tokens) · paragraphs as blocks`;
  const translatedBy =
    showTranslation && translation
      ? ` · translated into ${translation.targetLanguage} per text block${translation.blockUsage ? ` (${usageText(translation.blockUsage)})` : ""}`
      : "";

  const textPages = (
    <div class={`ocr-pages${comparing ? " ocr-compare-col" : ""}`} ref={textColumn} aria-label={comparing ? "OCR text" : undefined}>
      {views.map(({ page, blocks }) => (
        <TextPage
          key={page.index}
          page={page}
          blocks={blocks}
          filter={filter}
          translations={translations}
          markdown={markdown}
          layout={layout}
          images={images}
        />
      ))}
    </div>
  );

  return (
    <div class={`tab-panel${comparing ? " tab-panel-fill" : ""}`}>
      <div class="toolbar">
        <span class="muted small">
          {source}
          {translatedBy}
        </span>
        <div class="btn-row">
          <TranslationToggle show={wantTranslation} available={translationsAvailable} onShowTranslation={actions.setShowTranslation} />
          <Check checked={markdown} onChange={setMarkdown} small>
            Render Markdown
          </Check>
          <Check
            checked={layout}
            onChange={actions.setOcrMatchLayout}
            disabled={!canLayout}
            small
            title={
              canLayout ? "Place each block where it is on the page, its text sized to fit the block" : "These blocks have no positions on a page (text input)"
            }
          >
            Match page layout
          </Check>
          <Check
            checked={comparing}
            onChange={actions.setOcrShowPdf}
            disabled={!pagesAvailable}
            small
            title={pagesAvailable ? "Show the document's pages beside the text" : "Load the document to see its pages beside the text"}
          >
            Show {doc?.kind === "image" ? "image" : "PDF"}
          </Check>
          {comparing && (
            <Check checked={linkScroll} onChange={actions.setOcrLinkScroll} small title="Scroll the pages and the text together, page by page">
              Lock scrolling
            </Check>
          )}
          {comparing && (
            <Check
              checked={pickBlocks}
              onChange={actions.setOcrPickBlocks}
              small
              title="Draw the blocks over the pages: click one to leave it out of the text, click again to take it back"
            >
              Select blocks on the {doc?.kind === "image" ? "image" : "PDF"}
            </Check>
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
      {types.length > 0 && (
        <div class="block-filter" role="group" aria-label="Blocks in the text">
          <span class="muted small">Blocks in the text:</span>
          {types.map(({ type, count }) => (
            <label key={type} class="block-chip small" style={`--box-color:${blockColor(type)}`}>
              <input
                type="checkbox"
                checked={!hidden.has(type)}
                aria-label={`${blockTypeLabel(type)} blocks (${count})`}
                onChange={(e) => setTypeShown(type, e.currentTarget.checked)}
              />
              <span class="swatch" />
              <span>{blockTypeLabel(type)}</span>
              <span class="muted">{count}</span>
            </label>
          ))}
          {excluded.size > 0 && (
            <span class="small">
              {excluded.size} block(s) left out one by one{" "}
              <button type="button" class="btn btn-ghost small" onClick={actions.includeAllBlocks}>
                Take them all back
              </button>
            </span>
          )}
        </div>
      )}
      {wantTranslation && !translationsAvailable && (translation || busy) && (
        <p class="muted small">
          {busy
            ? "The block translations are still being produced; the OCR text is shown in its original language."
            : "No per-block translations for this text yet: run “OCR + Translate” (with the JSON output, keep “Translate each OCR text block” enabled in Settings)."}
          {!busy && canRetry && shownIds.size > 0 && (
            <>
              {" "}
              <button type="button" class="btn btn-ghost small" onClick={() => actions.retry("blocks")}>
                Translate the blocks now
              </button>
            </>
          )}
        </p>
      )}
      {showTranslation && translated < shownIds.size && (
        <p class="muted small">
          {busy
            ? `${translated} of ${shownIds.size} block(s) translated so far; the rest are shown in the original language.`
            : `${shownIds.size - translated} block(s) have no translation; they are shown in the original language.`}
          {!busy && canRetry && (
            <>
              {" "}
              <button type="button" class="btn btn-ghost small" onClick={() => actions.retry("blocks")}>
                Translate them
              </button>
            </>
          )}
        </p>
      )}
      {headersFooters.length > 0 && (
        <details class="banner">
          <summary>Page headers and footers kept out of the page text ({headersFooters.length} page(s))</summary>
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
        // Locked, neither column bounces past its ends (see `.ocr-compare-locked`): a bounce cannot be passed on to the other.
        <div class={`ocr-compare${linkScroll ? " ocr-compare-locked" : ""}`}>
          <PdfPages doc={doc} views={views} column={pdfColumn} picker={picker} />
          {textPages}
        </div>
      ) : (
        textPages
      )}
    </div>
  );
});

/** One page of the text: its blocks in reading order, or placed on a sheet shaped like the page. */
const TextPage = memo(function TextPage({
  page,
  blocks,
  filter,
  translations,
  markdown,
  layout,
  images,
}: {
  page: OcrCleanPage;
  blocks: ViewBlock[];
  filter: BlockFilter;
  translations: Record<string, string> | null;
  markdown: boolean;
  layout: boolean;
  images: ReadonlyMap<string, string>;
}) {
  const shown = blocks.filter((b) => isShown(b, filter));
  const sheet = layout && !!page.width && !!page.height && blocks.some((b) => b.box);
  const flowing = sheet ? shown.filter((b) => !b.box) : shown;
  return (
    <section class={`ocr-page${sheet ? " ocr-page-layout" : ""}`} id={`ocr-page-${page.index + 1}`} data-page={page.index}>
      <h3 class="ocr-page-title">Page {page.index + 1}</h3>
      {sheet && <LayoutSheet page={page} blocks={shown.filter((b) => b.box)} translations={translations} markdown={markdown} images={images} />}
      {flowing.map((b) => {
        const translated = translations?.[b.id]?.trim();
        return (
          <div
            key={b.id}
            class={`ocr-block${translations && !translated && b.type !== "image" ? " ocr-block-untranslated" : ""}`}
            data-block={b.id}
            data-type={b.type}
          >
            <BlockContent block={b} text={translated || b.text} markdown={markdown} image={b.imageId ? (images.get(b.imageId) ?? null) : null} />
          </div>
        );
      })}
      {!sheet && !shown.length && <p class="muted small">{blocks.length ? "Every block of this page is left out." : "(no text)"}</p>}
    </section>
  );
});

/** "Match page layout": the blocks where they are on the page, each text sized to fill its box (`useFitText`). */
function LayoutSheet({
  page,
  blocks,
  translations,
  markdown,
  images,
}: {
  page: OcrCleanPage;
  blocks: ViewBlock[];
  translations: Record<string, string> | null;
  markdown: boolean;
  images: ReadonlyMap<string, string>;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  useFitText(sheet);
  const width = page.width ?? 1;
  const height = page.height ?? 1;
  return (
    <div class="ocr-sheet" ref={sheet} style={`aspect-ratio:${width}/${height}`}>
      {blocks.map((b) => {
        const box = b.box!;
        const style = boxStyle(box, width, height, blockColor(b.type));
        if (b.type === "image") {
          return (
            <div key={b.id} class="ocr-block ocr-block-abs ocr-block-image" data-block={b.id} data-type={b.type} style={style}>
              <BlockContent block={b} text="" markdown={markdown} image={b.imageId ? (images.get(b.imageId) ?? null) : null} />
            </div>
          );
        }
        const translated = translations ? translations[b.id]?.trim() : undefined;
        const text = translated || b.text;
        const fitMax = Math.min(MAX_FONT_CQW, (((box.y1 - box.y0) / width) * 100) / LINE_HEIGHT);
        return (
          <div
            key={b.id}
            class={`ocr-block ocr-block-abs ${FIT_BLOCK}${translations && !translated ? " ocr-block-untranslated" : ""}`}
            data-block={b.id}
            data-type={b.type}
            data-fit-max={fitMax.toFixed(3)}
            data-fit-key={`${translated ? "translated" : "original"}|${markdown ? "markdown" : "plain"}|${text.length}`}
            style={style}
          >
            <div class="ocr-fit">
              <BlockContent block={b} text={text} markdown={markdown} image={null} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BlockContent({ block, text, markdown, image }: { block: ViewBlock; text: string; markdown: boolean; image: string | null }) {
  if (block.type === "image") {
    const label = `[Image: ${block.imageId ?? "image"}]`;
    return image ? (
      <figure class="ocr-figure">
        <img src={image} alt={label} />
        <figcaption class="muted small">{label}</figcaption>
      </figure>
    ) : (
      <p class="muted small">{label}</p>
    );
  }
  return <MarkdownText text={text} markdown={markdown} />;
}

/**
 * The document's pages, rendered in the background (visible ones first),
 * laid out like the OCR text beside them: a title, then the page. With a
 * picker, the blocks are drawn over each page and a click leaves one out of
 * the text or takes it back.
 */
const PdfPages = memo(function PdfPages({
  doc,
  views,
  column,
  picker,
}: {
  doc: DocState;
  views: PageView[];
  column: RefObject<HTMLDivElement>;
  picker: Picker | null;
}) {
  const renderer = usePageRenderer(doc);
  const indexes = useMemo(() => views.map((v) => v.page.index), [views]);
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
      {views.map(({ page, blocks }) => {
        const url = rendered[page.index];
        const error = errors[page.index];
        return (
          <section class="ocr-pdf-page" key={page.index} data-page={page.index}>
            <h3 class="ocr-page-title">Page {page.index + 1}</h3>
            <div class="ocr-pdf-sheet" style={`aspect-ratio:${page.width ?? 1000}/${page.height ?? 1414}`}>
              {url ? (
                <img src={url} alt={`Page ${page.index + 1}`} />
              ) : (
                <div class="ocr-pdf-placeholder small">{error ? `Page could not be rendered: ${error}` : "Rendering page…"}</div>
              )}
              {picker && page.width && page.height && <PickLayer page={page} blocks={blocks} picker={picker} />}
            </div>
          </section>
        );
      })}
    </div>
  );
});

function PickLayer({ page, blocks, picker }: { page: OcrCleanPage; blocks: ViewBlock[]; picker: Picker }) {
  const width = page.width ?? 1;
  const height = page.height ?? 1;
  return (
    <div class="bbox-layer" aria-label={`Blocks on page ${page.index + 1}`}>
      {blocks.map((b, i) => {
        if (!b.box) return null;
        const hiddenType = picker.hidden.has(b.type);
        const out = hiddenType || picker.excluded.has(b.id);
        const content = b.text || (b.imageId ? `[Image: ${b.imageId}]` : "");
        return (
          <button
            type="button"
            key={b.id}
            class={`ocr-pick${out ? " ocr-pick-out" : ""}`}
            style={boxStyle(b.box, width, height, blockColor(b.type))}
            aria-pressed={!out}
            disabled={hiddenType}
            title={
              hiddenType
                ? `${blockTypeLabel(b.type)} blocks are hidden by the block filter above the text`
                : out
                  ? "Left out of the text: click to take it back"
                  : "In the text: click to leave it out"
            }
            aria-label={`${blockTypeLabel(b.type)} block ${i + 1}${content ? `: ${content.slice(0, 60)}` : ""}`}
            onClick={() => picker.toggle(b.id)}
            onMouseEnter={() => picker.highlight(b.id, true)}
            onMouseLeave={() => picker.highlight(b.id, false)}
            onFocus={() => picker.highlight(b.id, true)}
            onBlur={() => picker.highlight(b.id, false)}
          />
        );
      })}
    </div>
  );
}
