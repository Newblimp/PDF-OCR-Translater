# Guide for agents and contributors

This file is the map of the codebase for whoever works on it next (human or
AI). Keep it current when you change the architecture.

## Purpose and hard constraints

- Browser-only PDF → OCR (Mistral) → translation (Mistral Small,
  `mistral-small-latest`, by default; or Anthropic Claude Haiku 5.5, or
  OpenAI GPT Luna), block by block by default, or into a structured JSON
  format with `Settings.jsonOutput`. See
  README.md for the user-facing description.
- **The document may only ever be sent to `https://api.mistral.ai` (OCR), and
  the extracted text plus the OCR's cropped bounding-box images only to the
  selected translation provider (`https://api.mistral.ai` by default,
  `https://api.anthropic.com` or `https://api.openai.com`).** There is no server
  component, no analytics, no third-party scripts. `public/_headers` enforces
  this with a CSP (`connect-src 'self' https://api.mistral.ai https://api.anthropic.com https://api.openai.com`).
  Do not add Cloudflare Pages Functions, proxies, or remote fonts/scripts
  without an explicit product decision.
- API keys are stored in `localStorage` (or `sessionStorage` when the user
  turns "Remember keys" off), one per provider. Never put keys in the repo,
  in build-time env vars, or in URLs.
- TypeScript everywhere, `strict` plus `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. `npm run typecheck` must pass.
- Responsiveness first: the page loads only what its first screen needs.
  Heavy libraries (pdf.js, marked/DOMPurify, the Anthropic SDK) and the
  app's own heavy parts are imported on first use, each its own chunk: the
  result views (`lazyView()` in `ResultsPanel.tsx`), the pipeline's stages
  (`pipeline()` in `runner/translation.ts`), the provider implementations
  (`createProvider()` in `registry.ts`) and the Mistral client
  (`ocrClient()` in `runner/jobs.ts`). Keep it that way: a static import of one of
  them from the shell (App, store, side panel, settings) puts it back into
  the first download (`src/architecture.test.ts` fails); `npx vite build`
  lists the chunks. Long lists use
  `content-visibility`;
  network calls are cancellable via `AbortController`; the translation
  streams so progress is visible; independent stages run concurrently;
  components are memoised with stable handlers so streaming does not
  re-render the whole app.

## Stack

- [Vite 8](https://vite.dev) + [Preact](https://preactjs.com) (React-compatible
  hooks, ~4 kB) + plain CSS with design tokens (`src/styles/global.css`).
- Anthropic is called through the official
  [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
  (`src/lib/anthropic/client.ts`). It is imported on first use (its own
  ~58 kB gzip chunk, so the initial bundle stays small), with the base URL
  pinned to `https://api.anthropic.com`, the SDK's retries (2, with backoff)
  and an explicit one-hour timeout (which also lifts the SDK's
  "streaming required" guard for non-streaming 64k-token requests).
  `dangerouslyAllowBrowser: true` sends the
  `anthropic-dangerous-direct-browser-access` CORS opt-in; that is fine here
  because the key is the user's own and stays in their browser, sent only to
  the API. `toAnthropicApiError()` maps SDK errors onto `ApiError`. Use the
  SDK's types (`Anthropic.MessageCreateParamsNonStreaming`, `Message`,
  `ModelInfo`, ...); do not redefine them.
- Mistral and OpenAI have no SDK dependency: they share the Chat Completions
  protocol, so one hand-written client serves both
  (`ChatCompletionsClient` in `src/lib/http/chatClient.ts`: models, chat,
  streamed chat; `src/lib/mistral/client.ts` adds OCR), on a shared
  fetch/error/SSE layer (`apiFetch` with the SDK's retry policy,
  `readChatStream` for their common streaming format), and their providers
  build the request with `chatCompletionsRequest()` (`llm/content.ts`). Wire
  types are derived from the official SDKs.
- Tests: Vitest for pure modules and for the runner's jobs
  (`src/app/runner.test.ts`: the real store and pipeline, fake OCR and chat
  providers, saved translations in memory; the quick way to see a runner
  change work), Playwright for end-to-end flows against
  mocked Mistral, Anthropic and OpenAI APIs (`e2e/helpers.ts`; `chatStep()`
  tells the pipeline steps apart for every provider). ESLint
  (`eslint.config.js`: typescript-eslint, React hooks rules, floating
  promises). Prettier formats everything (`.prettierrc.json`: print width
  160, otherwise its defaults; pinned to an exact version so formatting does
  not shift under an update). CI runs all of them (`.github/workflows/ci.yml`).
- `src/architecture.test.ts` checks rules this guide states in prose: the
  CSP connects to exactly the providers' hosts, `public/theme-init.js` reads
  the settings key, every module the code imports on first use (`import()`)
  stays out of `src/main.tsx`'s static imports, and the files and names
  quoted in this guide exist. When it fails, fix the code or this guide,
  not the test.

## Code map

```
src/
  main.tsx                     entry: the store (from what this browser saved), mounts <App/>
  app/
    App.tsx                    layout + wiring of components to the store
    store.ts                   AppState, Action union, reducer, selectors, translation defaults
    runner/                    side effects that drive the store; index.ts lists what the components call
      runtime.ts               the store as the runner sees it (`Runtime`)
      keys.ts                  API keys: stored, verified against the model list, forgotten
      settings.ts              a settings change and what it takes along (theme, where keys are kept, key dialog)
      document.ts              loading a document, its cached OCR result and saved translation; releasing it
      savedTranslations.ts     "Recent translations": saving, listing, reopening, deleting
      jobs.ts                  what every job shares: withJob() (start, always end), cancelJob(), followUps(), Settings → PipelineSettings
      translation.ts           runJob() (OCR, translate, both; with or without the JSON output), the structure in the
                               original language, retries of failed parts
      boxEdits.ts              "Edit bounding boxes": editBoxes(), undo, reset; edits kept with the cached OCR result
  components/                  presentational Preact components (memoised; handlers come from App, created once)
    JsonBrowser/               browsable view of the translated JSON
    ResultsPanel.tsx           the result tabs: which are available, and their views (loaded on first use, lazyView.tsx)
    JsonViews.tsx              with JSON output: structured text, JSON format, raw JSON, the live stream view
    OcrView.tsx                OCR text tab: blocks filtered by type and one by one, PDF beside it (block picking), page layout
    resultControls.tsx         download, clipboard, "Show translation" switch, token usage (shared by the views)
    QuickOptions.tsx           above the settings: target language (English / German) and glossary
    DraftText.tsx              text input that commits on blur / Enter (settings, glossary)
    Check.tsx                  a checkbox with its label (every switch in the toolbars and settings)
    PageNav.tsx                previous / next page, for the views that show one page at a time
    SideRail.tsx               the side panel's title bar (fold button) and the panel folded into a rail (running job, error)
    useFitText.ts              "Match page layout": text sized to fill each block's box (cqw units, fitted once per content)
    blockColors.ts             colour per OCR block type; boxStyle() places a box over a page (in percent)
    BboxView.tsx               bounding boxes drawn over the rendered page
    EditBoxesView.tsx          "Edit bounding boxes": marquee / click selection, cut, make a block, delete, change, undo
    pageImages.ts              hooks: the document's page renderer, pages rendered so far (there on the first paint),
                               the page on screen rendered first
    useLinkedScroll.ts         scrolls two page columns together (OCR text beside the PDF)
    Dock.tsx                   result tabs in groups and split views (drag and drop, splitters)
    HistoryPanel.tsx           "Recent translations" (saved in IndexedDB)
  lib/
    apiProviders.ts            each API declared once: id (ProviderId), name, label, host; isProviderId(), apiBaseUrl()
    http/
      apiFetch.ts              authenticated fetch + retries with backoff (Mistral, OpenAI)
      apiError.ts              ApiError (kind, provider, hint); error mapping; permanent / image rejection checks
      sse.ts                   pure SSE parser
      chatClient.ts            Chat Completions client shared by Mistral and OpenAI (models, chat, streamed chat)
      chatStream.ts            streamed Chat Completions reader shared by Mistral and OpenAI
    llm/
      provider.ts              ChatProvider interface (JSON completions), token usage helpers
      content.ts               user message order shared by the providers: context, images, task;
                               the Chat Completions request of Mistral and OpenAI
      anthropicProvider.ts     Anthropic implementation (Claude Haiku 5.5)
      openaiProvider.ts        OpenAI implementation (GPT Luna)
      mistralProvider.ts       Mistral implementation (Mistral Small, the default)
      registry.ts              provider metadata, defaults, factory
    mistral/
      client.ts                the shared chat client plus OCR
      types.ts                 request/response wire types (snake_case)
      models.ts                Mistral model ids, model-list filtering
    anthropic/
      client.ts                lazy-loaded official SDK client + SDK error → ApiError mapping
      models.ts                Claude model ids, default max_tokens, model-list filtering
    openai/
      client.ts                the shared chat client (asks for usage in streams)
      types.ts                 wire types
      models.ts                OpenAI model ids, model-list filtering
    pipeline/
      runOcr.ts                document → OCR (headers/footers extracted, bbox images + blocks)
      bboxAnnotate.ts          vision model, one call per bounding box (bbox annotation)
      blockEdits.ts            edits of the OCR's blocks: rectangles, cut plan, ids, applyEdits() (OCR text + edits)
      regionOcr.ts             an area of a page read again by Mistral OCR (image_url)
      blocks.ts                the text as blocks: view and text blocks, type/one-by-one filter, text of the kept blocks,
                               text input split into paragraph blocks (textPages)
      blockTranslate.ts        batch translation of text blocks (the translation without JSON output; a follow-up with it)
      ocrText.ts               OCR response → clean text for translation; block ids (blockId, pageBlockId)
      inferSchema.ts           text → JSON Schema (json_object mode)
      schema.ts                schema sanitiser for strict mode + light validator
      schemas/                 built-in schemas (registry in index.ts)
      prompts.ts               all prompt text
      glossary.ts              the glossary setting parsed into term pairs
      translate.ts             text + first 8 bbox images + schema → JSON (document annotation);
                               fallbacks: without images → non-streaming → json_object; keeps truncated output
      chunks.ts                long documents: split along pages/paragraphs, merge the parts' JSON
      pipeline.ts              the stages: ocrOnly, resolveSchema, describeBboxes, translateDocument,
                               structureOriginal, blockTranslations (composed by app/runner/translation.ts);
                               PipelineSettings.structured = JSON output
      events.ts                every stage declared once (STAGES: label, streaming, follow-up name, when a translation runs it);
                               progress events shared by the steps
    export/bilingual.ts        bilingual HTML export (translation next to the original)
    markdown.ts                lazy marked + DOMPurify renderers (app view; export without remote resources)
    files/                     hashing, data-URL encoding, pdf.js preview (WebP object URLs), page render cache, file kinds
    storage/                   localStorage/sessionStorage (keys, settings, theme, result layout); IndexedDB (db.ts):
                               OCR cache (ocrCache.ts), saved translations (history.ts)
    util/                      JSON extraction, partial-JSON parser for streaming, page selection, text helpers, worker pool,
                               dock.ts (split-view layout model), linkedScroll.ts (page-by-page scroll mapping),
                               createStore.ts (the app's store)
  styles/global.css
e2e/                           Playwright specs + API mock
public/_headers                Cloudflare Pages headers (CSP etc.)
vite.config.ts                 Preact preset, pdf.js asset serving, _headers in dev/preview
```

Data flow: `components → app/runner/ → pipeline/* → llm/<provider> or
mistral/client.ts (OCR) → http/apiFetch.ts` (Mistral, OpenAI) or the
Anthropic SDK (`anthropic/client.ts`), with results dispatched back into
`store.ts` and rendered by the components.

## How to extend

- **New document family / schema**: add a file under
  `src/lib/pipeline/schemas/` and register it in `schemas/index.ts`. Adjust
  `DEFAULT_DOMAIN_HINT` in `storage/settings.ts` if the default should change.
- **Prompt tuning**: only `src/lib/pipeline/prompts.ts`. Prompts must keep
  the word "JSON" (required by Mistral's `json_object` mode). The document
  calls share `documentSystemPrompt()` (settings only, never the document or
  the task) and put `documentContext()` (the document) and the images first,
  the task (`*Instruction()`, with the schema) last: keep anything that varies
  between the calls of a run out of the system prompt and the context, or
  the prompt cache stops hitting (`JsonChatRequest.cachePrefix` puts the
  Anthropic breakpoint on the last shared block). Schema inference sets no
  breakpoint: the translation adds a structured-output format (and usually
  images), so it cannot read that prefix back.
- **New pipeline step** (e.g. a review pass): declare its stage once in
  `STAGES` (`events.ts`): the key is its `StageId`, `label` its title on
  the job status card, `streams` whether the card counts characters,
  `produces` what a failure as a follow-up names, and `inTranslation` when
  a translation runs it (`translationStages()` lists the stages in
  `STAGES` order). Add a module in `src/lib/pipeline/` that emits progress
  with `emit()`, expose it from `pipeline.ts`, and compose it in
  `runner/translation.ts` (`translateStructured()` and/or
  `translateByBlocks()`). A step after the translation should go through
  `followUps()` (its stage must have `produces`) so its failure becomes a
  warning on the result rather than a failed job. Then surface results through a new field in `AppState` and a
  component.
- **JSON output** (`Settings.jsonOutput`, off by default; the last option
  in `SettingsPanel`, with every JSON-only setting under it):
  `runner.runTranslation()` runs `translateByBlocks()` without it and
  `translateStructured()` (the annotation workflow below) with it. Without
  it there is no schema and no document annotation: the text blocks the OCR
  text tab keeps (`blocks.shownTextBlockIds()` with `Settings.ocrHiddenTypes`
  and `excludedBlocks()`) are translated by `pipeline.blockTranslations()`,
  the translation (`schema`, `data`, `mode` null; `hasStructure()` false) is
  on screen from the start and filled batch by batch (`onTranslated`), and it
  keeps its blocks in `TranslationState.pages` so it can be shown without its
  OCR result (text input is split by `blocks.textPages()`).
  `ResultsPanel` offers the Structured text, JSON format and Raw JSON tabs
  only with `jsonOutput` on and a translation with a structure; a new
  translation opens on the structured text then, on the OCR text otherwise.
- **Annotation workflow** (`runner.translateStructured()`): mirrors Mistral's
  Document AI annotations with the vision LLM swapped for the selected chat
  provider. Schema first; then `describeBboxes()` runs alongside
  `translateDocument()` (the annotations do not feed the translation); then
  the follow-ups side by side. `bboxAnnotate.ts` describes each `OcrText.bboxes` entry that has
  an image (stage `bbox_annotate`); `translate.ts` attaches the first
  `DOCUMENT_ANNOTATION_MAX_IMAGES` box images to the user message
  (`JsonChatRequest.images`, rendered as `image_url` parts by each provider).
  `ResultsPanel`'s `PipelineStrip` tells the user what ran; `BboxView` draws
  `OcrText.bboxes` and `OcrCleanPage.blocks` over the page its
  `PageRenderer` renders (`usePageRenderer()`, see "Page rendering").
- **Result tabs**: `RESULT_TABS` in `store.ts` fixes the default order —
  Bounding boxes (shown first), OCR text, Structured text, JSON format, Raw
  JSON. The user arranges them in split views like VS Code's editor groups:
  `AppState.resultLayout` is a `DockNode` tree (`util/dock.ts`: splits with
  relative `sizes`, leaves are groups with their `tabs` and `active` tab;
  every tab in exactly one group). The reducer applies `activateTab()`
  (`tab/set`, and wherever the app switches tabs itself), `moveTab()`
  (`layout/move`), `resizeSplit()` and the reset; `App.tsx` saves the layout
  (`storage/layout.ts`, repaired by `parseDock()` on load). `Dock.tsx` hides
  tabs with nothing to show (`visibleDock()`; empty groups give their room
  away) and places frames, views and splitters as absolutely positioned
  siblings from `dockGeometry()`, with the views in the fixed `RESULT_TABS`
  order, so rearranging never remounts a view. Drag and drop is native HTML
  (dragenter and dragover both cancelled; a custom data type, not text);
  splitters use pointer capture and commit on release. Below 960px the
  groups are stacked (CSS `order`), and views size themselves by their
  group with container queries (`.dock-view` is the container), not the
  window. On wide screens `.app` is a fixed-height shell: the input pane and
  each view scroll on their own. There is no separate translation tab: `AppState.showTranslation` ("Show translation", one
  switch rendered in several toolbars) decides whether the OCR text, the
  structured text and the raw JSON are shown translated or in the document's
  own language.
- **Structured text in the original language**: `pipeline.structureOriginal()`
  (stage `structure_original`, `translateStructured(..., target: "original")`
  with the same schema and bbox images, non-streaming) patches
  `TranslationState.originalData`. `Settings.structureOriginal` decides when:
  `"on_demand"` (default) runs it once per translation when the Structured
  text or Raw JSON tab is shown with "Show translation" off
  (`runner.ensureOriginalStructure()`, job kind `"original"`), `"always"`
  runs it as a follow-up of every translation, `"never"` not at all. Without
  it the tab falls back to the translation and says so.
- **Block translations**: with the JSON output, after `translation/set`, the
  runner runs `pipeline.blockTranslations()` (stage `block_translate`,
  batches of OCR blocks as JSON) as a follow-up and patches
  `TranslationState.blockTranslations`; without it they are the translation.
  `BboxView` shows them above the original block text, and the OCR text view
  shows each block translated when "Show translation" is on (blocks without
  a translation keep their original text, marked).
- **Edit bounding boxes** (`EditBoxesView.tsx`, `runner.editBoxes()`,
  `pipeline/blockEdits.ts`): `OcrState` keeps the OCR text as returned
  (`base`), the user's `edits` (`BlockEdits`: the block lists of the edited
  pages, images made of selections, an id counter) and an `undo` stack;
  `text` is `applyEdits(base, edits)` (edited pages rebuilt from their
  blocks, headers and footers out of the Markdown), so every view and the
  translation read the edited text without knowing about edits. Block ids:
  the OCR's blocks keep `${page}:${index}` (stored on edited pages, see
  `PageBlock.id` / `pageBlockId()`), new or changed blocks get
  `${page}:e${n}`, so translations of untouched blocks stay valid and changed
  ones show as untranslated. Translations remember their OCR result by
  `OcrState.fingerprint` (of `base`), not by their source text, so
  `ocrBelongsTo()` holds across edits. Cutting through text, making a block
  and reading a block again render the area with the cut blanked
  (`PageRenderer.region()`) and send it to `ocrRegion()` (job kind "edit",
  stage `region_ocr`). Edits are saved with the OCR cache entry (`edits`)
  and restored with it; the reducer carries the blocks left out one by one
  over to the edited pages.
- **OCR text view** (`OcrView.tsx`): renders `blocks.pageBlocks()` (a page
  without blocks is one stand-in block of its Markdown, id `${page}:page`,
  translated like any other: `textBlocks()` derives from `pageBlocks()`),
  so filters work on both languages. Block types are switched off in `Settings.ocrHiddenTypes`;
  single blocks in `AppState.blockSelection`, which belongs to the `pages`
  array it was picked on (`excludedBlocks(state, pages)`; other pages start
  with none, so no reset rules are needed). Copy and download use
  `blocks.filteredText()`. "Select blocks on the PDF" (`ocrPickBlocks`)
  draws `PickLayer` buttons over the pages beside the text (`aria-pressed` =
  in the text). "Match page layout" (`ocrMatchLayout`) puts each page on a
  `.ocr-sheet` with the page's aspect ratio (as tall as the PDF page beside
  it) and the blocks absolutely positioned; `useFitText()` searches each
  text block's font size in `cqw`, so the fit holds at any width and is
  only searched again when `data-fit-key` (translated or original, Markdown,
  length) changes. Preact owns `class` and `style`: the fit writes only the
  `--fit` custom property and `data-fitted` / `data-overflow`. Keep the text
  column the same element in every mode and its pages direct children with
  `data-page`; `useLinkedScroll()`'s `layoutKey` makes the text follow the
  pages again after filters or the layout change it. Locked, both columns
  get `overscroll-behavior: none` (`.ocr-compare-locked`): an elastic bounce
  cannot be mirrored on the other column by script.
- **Side panel**: `Settings.sidePanelCollapsed` (the button in the panel's
  own title bar, `SidePanelHead`, or the rail) folds the input pane
  into `SideRail` (a running job with Cancel, an error). The pane's content
  stays mounted in a hidden `.pane-body`, so drafts and open sections
  survive folding.
- **Page rendering**: `files/pageRenderCache.ts` keeps one pdf.js document
  open per loaded file, renders on demand and pre-renders the rest in the
  background (`PREFETCH_LIMIT`); `BboxView` and the OCR text view's pages
  get it through `usePageRenderer()` (`components/pageImages.ts`, one
  `PAGE_RENDER_WIDTH` for both, since the renderer is shared).
- **OCR text beside the PDF**: `Settings.ocrShowPdf` / `ocrLinkScroll`
  (toolbar switches, saved). `OcrView` then lays out two scrolling columns
  whose pages are direct children marked `data-page` (`PdfPages` renders the
  visible ones first with an IntersectionObserver, placeholders keep each
  page's aspect ratio). `useLinkedScroll()` measures both columns on scroll
  and applies `linkedScrollTop()` (`util/linkedScroll.ts`): the reading point
  runs from the top of the view to its bottom, so both columns start and end
  together, and is mapped page by page in between. Only shown while the
  document the OCR result was made from is loaded.
- **Page selection**: `DocState.pageSelection` (1-based text) is parsed by
  `util/pageSelection.ts` into the OCR API's 0-based `pages`; the OCR cache
  key includes it.
- **Live streaming**: `translate.ts` emits `streamText` on progress events
  (throttled); the store keeps it in `job.streamText` (cleared when the
  translation is set, so the follow-ups run under the finished result);
  `ResultsPanel`'s `StreamingView` renders it through `util/partialJson.ts`.
  For a document in parts, `pipeline.ts` merges the finished parts into the
  stream text.
- **Long documents**: `chunks.splitDocument()` splits above
  `TRANSLATION_CHUNK_TOKENS` along OCR pages (or paragraphs for text input);
  `fillStructure()` in `pipeline.ts` fills each part (with that part's
  images) and merges with `mergeStructured()`.
- **Saved translations**: `storage/history.ts` keeps `TranslationState`s
  (with `sourceText`, `sourceHash`, `ocrKey`) in IndexedDB; the runner saves
  after every job that changed the translation, restores the newest one when
  the same document (and cached OCR result) is loaded, and reopens entries
  from `HistoryPanel`. Bump `HISTORY_VERSION` when `TranslationState`
  changes shape incompatibly.
- **Retries of failed parts**: `runner.retryFailed()` (job kind `"retry"`)
  re-runs `describeBboxes()` / `blockTranslations()` with `onlyIds` and
  merges the results. For blocks: the ones the OCR text tab keeps that have
  no translation, which includes blocks taken back after the translation.
- **Jobs that add to a translation** (original-language structure, retries)
  pass it to `withJob()` as `JobSpec.forTranslation`: they run in its target
  language (provider and model come from Settings, so a failing model can be
  swapped), ignore the schema setting, and use the OCR result on screen only when it is the one
  the translation was made from (`ocrBelongsTo()` / `ocrOf()`; the retry
  buttons are hidden otherwise). The automatic original-language request
  fires once per translation (`session.originalRequested`), never while an error is
  shown, and not after the job that produced the translation was cancelled
  or failed.
- **Another translation provider**: (1) add its identity to `API_PROVIDERS`
  in `src/lib/apiProviders.ts` (the key is its `ProviderId`; `name`,
  `label`, `host`: the error hints, the key pills and the client's base URL
  read them there); (2) implement `ChatProvider` (`src/lib/llm/provider.ts`)
  on a client in `src/lib/<name>/` (its `label` is `API_PROVIDERS.<id>.label`,
  its base URL `apiBaseUrl()`); (3) add its entry to `PROVIDERS` in
  `src/lib/llm/registry.ts` with `provider()` (purpose, key URL,
  default/fallback models, capability flags, and `load`, a dynamic import of
  the implementation); (4) add its host to the CSP in `public/_headers`
  (`src/architecture.test.ts` fails until it is there) and to the e2e mocks.
  Everything else (key storage, key dialog fields, header pills, settings
  model lists, `initialState`) iterates `PROVIDER_IDS` / `perProvider()`.
- **Another API host or a proxy**: the Mistral and OpenAI clients take
  `baseUrl`, the Anthropic client pins `ANTHROPIC_BASE_URL`; update the CSP
  accordingly. This changes the privacy model, so document it.
- **Model line-up changes**: edit `src/lib/anthropic/models.ts`,
  `src/lib/openai/models.ts` or `src/lib/mistral/models.ts`. The translation-model dropdown lists whatever
  `/v1/models` returns (fallback list when it has not answered); the OCR-model
  dropdown lists `OCR_MODELS`. Both are dropdowns only — no free-text model
  ids — so a model id stored earlier appears as a "(custom)" entry.
  When a default model or the default provider changes, append the old
  default to `DEFAULT_MIGRATIONS` in `src/lib/storage/settings.ts` so saved
  choices move over once.
- **More target languages**: extend `TARGET_LANGUAGES` in
  `src/lib/storage/settings.ts`; the dropdown renders from it and
  `QUICK_TARGET_LANGUAGES` picks the one-click buttons.
- **Theme / visual style**: shared with github.com/Newblimp/refcheck (Gruvbox
  dark default, warm high-contrast light, system font stacks, orange accent,
  uppercase letter-spaced section labels, dot chips). Tokens keep refcheck's
  names in `src/styles/global.css`, each declared once as
  `light-dark(light, dark)`; `color-scheme` picks the side (`light dark`
  follows the OS for "system", `:root[data-theme]` forces one; this needs
  Chrome 123 / Firefox 120 / Safari 17.5 or later). The uppercase section
  labels share one rule (after `.error-text`): a new label adds its selector
  there and sets only its colour; icons live in
  `src/components/icons.tsx`; `storage/theme.ts` and `public/theme-init.js`
  apply the choice. Keep the two apps' stylesheets in step when changing
  tokens.

## Conventions

- Formatting is Prettier's: run `npm run format` instead of formatting by
  hand (CI fails on unformatted files). The commit that first formatted the
  code base is listed in `.git-blame-ignore-revs`, so `git blame` (and
  GitHub's blame view) skips it.
- Wire types use the API's snake_case; app types use camelCase.
- Errors thrown from the clients are `ApiError` with a `kind`, `provider` and
  a user-facing `hint` (the Anthropic provider passes every SDK error through
  `toAnthropicApiError()`); the runner converts anything else with
  `toAppError()`.
- OpenAI GPT-5.x and current Claude models reject `temperature`; those
  providers never send it. The reasoning effort is sent only to providers
  that support it, offered per provider (`ProviderInfo.reasoningEfforts`,
  `effortFor()`): Anthropic maps "none" to `output_config.effort: "low"`;
  Mistral takes "none" or "high" (the others map to "high"), and
  `MistralProvider` resends a rejected request without it and stops sending
  it to that model for the session.
- The Anthropic provider streams with `messages.stream()` (text deltas via
  `on("text")`, result from `finalMessage()`), reads only `text` blocks
  (adaptive thinking adds `thinking` blocks first), maps `stop_reason` onto
  the pipeline's names (`max_tokens` and `model_context_window_exceeded` →
  "length", `refusal` → "content_filter", or an `ApiError` of kind "refusal"
  when nothing was produced), and always sends `max_tokens` (required by the
  API).
- There is one state: the store `main.tsx` creates (`util/createStore.ts`),
  which `App.tsx` renders with `useSyncExternalStore`; the runner reaches
  it through its `Runtime` (`createRuntime()` in `runner/runtime.ts`). The
  reducer runs once per action, so `rt.getState()` holds an action's
  result as soon as it is dispatched, the very objects the view renders.
  What the runner remembers outside the store (key checks in flight, the
  latest "Open", deleted saved translations, original-language requests)
  lives in `Runtime.session`, never in module variables, so every runtime
  (each test's) starts fresh: add new such state there. Async
  work that dispatches late must check it is still relevant (see
  `verifyAndSaveApiKey`, `loadDocument`, the `translation.id` checks in
  `retryFailed`).
- A job is `withJob(rt, spec, work)` (`runner/jobs.ts`): it starts the job
  in the store when keys and settings allow (else `work` never runs and the
  reason is shown) and always ends it, showing the error `work` throws
  unless the job was cancelled. Write a new job as its `work`; never start
  or end one by hand.
- Components that receive callbacks get them from the `on` / `results`
  objects in `App.tsx`, created once: an inline arrow function as a prop
  defeats `memo()` and re-renders the subtree on every streaming update.
- Page images and previews are object URLs: whoever creates one revokes it
  (`releaseDocument()` in the runner, `dispose()` in `pageRenderCache.ts`).
- Settings text inputs use `DraftText` (`components/DraftText.tsx`, commit
  on blur/Enter) so unrelated re-renders do not clobber typing. The target
  language buttons and the glossary live in `QuickOptions` above the
  settings (which start closed); Settings keeps the full language dropdown.
- Checkboxes are `Check` (`components/Check.tsx`); event handlers read
  `e.currentTarget` (typed by Preact) rather than casting `e.target`.
- `public/theme-init.js` applies the saved theme before the first paint; it
  reads the same localStorage key as `storage/settings.ts` (keep in sync).
- Anything reaching the DOM from the model goes through `MarkdownText`
  (marked + DOMPurify) or is rendered as text. Never inject raw HTML. Files
  the app writes (the bilingual export) get no CSP from `public/_headers`:
  they must not reference anything outside themselves, so they render
  Markdown with `loadExportMarkdownRenderer()` (a separate DOMPurify instance
  whose hook drops non-`data:` src/srcset/background/... attributes) and
  carry their own CSP meta tag.
- Keep `README.md` (user-facing) and this file (developer-facing) in sync
  with behaviour changes.

## Checks before you push

```bash
npm run format && npm run typecheck && npm run lint && npm test && npm run e2e && npm run build
```
