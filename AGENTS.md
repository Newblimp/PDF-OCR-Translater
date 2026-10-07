# Guide for agents and contributors

This file is the map of the codebase for whoever works on it next (human or
AI). Keep it current when you change the architecture.

## Purpose and hard constraints

- Browser-only PDF → OCR (Mistral) → translation (Anthropic Claude Haiku
  5.5 by default, or OpenAI GPT Luna, or Mistral) → structured JSON. See
  README.md for the user-facing description.
- **The document may only ever be sent to `https://api.mistral.ai` (OCR), and
  the extracted text plus the OCR's cropped bounding-box images only to the
  selected translation provider (`https://api.anthropic.com`,
  `https://api.openai.com` or `https://api.mistral.ai`).** There is no server
  component, no analytics, no third-party scripts. `public/_headers` enforces
  this with a CSP (`connect-src 'self' https://api.mistral.ai https://api.anthropic.com https://api.openai.com`).
  Do not add Cloudflare Pages Functions, proxies, or remote fonts/scripts
  without an explicit product decision.
- API keys are stored in `localStorage` (or `sessionStorage` when the user
  turns "Remember keys" off), one per provider. Never put keys in the repo,
  in build-time env vars, or in URLs.
- TypeScript everywhere, `strict` plus `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. `npm run typecheck` must pass.
- Responsiveness first: heavy libraries (pdf.js, marked/DOMPurify, the
  Anthropic SDK) are loaded lazily; long lists use `content-visibility`;
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
- Mistral and OpenAI have no SDK dependency: their REST calls are
  hand-written (`src/lib/mistral/client.ts`, `src/lib/openai/client.ts`) on a
  shared fetch/error/SSE layer (`src/lib/http/`: `apiFetch` with the SDK's
  retry policy, `readChatStream` for their common streaming format), with
  wire types derived from the official SDKs.
- Tests: Vitest for pure modules, Playwright for end-to-end flows against
  mocked Mistral, Anthropic and OpenAI APIs (`e2e/helpers.ts`; `chatStep()`
  tells the pipeline steps apart for every provider). ESLint
  (`eslint.config.js`: typescript-eslint, React hooks rules, floating
  promises). CI runs all of them (`.github/workflows/ci.yml`).

## Code map

```
src/
  main.tsx                     entry; mounts <App/>
  app/
    App.tsx                    layout + wiring of components to the store
    store.ts                   AppState, Action union, reducer, selectors
    runner.ts                  side effects: load document, verify key, run jobs
  components/                  presentational Preact components (memoised; handlers come from App, created once)
    JsonBrowser/               browsable view of the translated JSON
    BboxView.tsx               bounding boxes drawn over the rendered page
    HistoryPanel.tsx           "Recent translations" (saved in IndexedDB)
  lib/
    http/
      apiFetch.ts              authenticated fetch + error mapping + retries with backoff (Mistral, OpenAI)
      apiError.ts              ApiError (kind, provider, hint); permanent / image rejection checks
      sse.ts                   pure SSE parser
      chatStream.ts            streamed Chat Completions reader shared by Mistral and OpenAI
    llm/
      provider.ts              ChatProvider interface (JSON completions), token usage helpers
      content.ts               user message order shared by the providers: context, images, task
      pricing.ts               list prices for the cost estimate
      anthropicProvider.ts     Anthropic implementation (Claude Haiku 5.5, the default)
      openaiProvider.ts        OpenAI implementation (GPT Luna)
      mistralProvider.ts       Mistral implementation
      registry.ts              provider metadata, defaults, factory
    mistral/
      client.ts                OCR + chat + models REST client
      types.ts                 request/response wire types (snake_case)
      models.ts                Mistral model ids, model-list filtering
    anthropic/
      client.ts                lazy-loaded official SDK client + SDK error → ApiError mapping
      models.ts                Claude model ids, default max_tokens, model-list filtering
    openai/
      client.ts                chat completions + models REST client
      types.ts                 wire types
      models.ts                OpenAI model ids, model-list filtering
    pipeline/
      runOcr.ts                document → OCR (headers/footers extracted, bbox images + blocks)
      bboxAnnotate.ts          vision model, one call per bounding box (bbox annotation)
      blockTranslate.ts        batch translation of OCR text blocks (bounding-box view)
      ocrText.ts               OCR response → clean text for translation
      inferSchema.ts           text → JSON Schema (json_object mode)
      schema.ts                schema sanitiser for strict mode + light validator
      schemas/                 built-in schemas (registry in index.ts)
      prompts.ts               all prompt text
      translate.ts             text + first 8 bbox images + schema → JSON (document annotation);
                               fallbacks: without images → non-streaming → json_object; keeps truncated output
      chunks.ts                long documents: split along pages/paragraphs, merge the parts' JSON
      pipeline.ts              the stages: ocrOnly, resolveSchema, describeBboxes, translateDocument,
                               structureOriginal, blockTranslations (composed by app/runner.ts)
      estimate.ts              token / cost estimate shown before a run
      events.ts                progress events shared by the steps
    export/bilingual.ts        bilingual HTML export (translation next to the original)
    files/                     hashing, data-URL encoding, pdf.js preview (WebP object URLs), page render cache, file kinds
    storage/                   localStorage/sessionStorage (keys, settings, theme); IndexedDB (db.ts):
                               OCR cache (ocrCache.ts), saved translations (history.ts)
    util/                      JSON extraction, partial-JSON parser for streaming, page selection, text helpers, worker pool
  styles/global.css
e2e/                           Playwright specs + API mock
public/_headers                Cloudflare Pages headers (CSP etc.)
vite.config.ts                 Preact preset, pdf.js asset serving, _headers in dev/preview
```

Data flow: `components → runner.ts → pipeline/* → llm/<provider> or
mistral/client.ts (OCR) → http/apiFetch.ts` (Mistral, OpenAI) or the
Anthropic SDK (`anthropic/client.ts`), with results dispatched back into
`store.ts` and rendered by the components.

## How to extend

- **New document family / schema**: add a file under
  `src/lib/pipeline/schemas/` and register it in `schemas/index.ts`. Adjust
  `DEFAULT_DOMAIN_HINT` in `prompts.ts` if the default should change.
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
- **New pipeline step** (e.g. a review pass): add a module in
  `src/lib/pipeline/`, emit progress with `emit()` from `events.ts` (add a
  `StageId` if needed), expose it from `pipeline.ts`, and compose it in
  `runner.ts` (`runTranslation()`; add it to `translationStages()` so the job
  status lists it). A step after the translation should go through
  `followUp()` so its failure becomes a warning on the result rather than a
  failed job. Then surface results through a new field in `AppState` and a
  component.
- **Annotation workflow** (`runner.runTranslation()`): mirrors Mistral's
  Document AI annotations with the vision LLM swapped for the selected chat
  provider. Schema first; then `describeBboxes()` runs alongside
  `translateDocument()` (the annotations do not feed the translation); then
  the follow-ups side by side. `bboxAnnotate.ts` describes each `OcrText.bboxes` entry that has
  an image (stage `bbox_annotate`); `translate.ts` attaches the first
  `DOCUMENT_ANNOTATION_MAX_IMAGES` box images to the user message
  (`JsonChatRequest.images`, rendered as `image_url` parts by each provider).
  `ResultsPanel`'s `PipelineStrip` tells the user what ran; `BboxView` draws
  `OcrText.bboxes` and `OcrCleanPage.blocks` over the page rendered by
  `renderPdfPage()`.
- **Result tabs**: `ResultTab` in `store.ts` fixes the order — Bounding boxes
  (the default), OCR text, Structured text, JSON format, Raw JSON. There is no
  separate translation tab: `AppState.showTranslation` ("Show translation", one
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
- **Block translations**: after `translation/set`, the runner runs
  `pipeline.blockTranslations()` (stage `block_translate`, batches of OCR
  blocks as JSON) and patches `TranslationState.blockTranslations`;
  `BboxView` shows them above the original block text, and the OCR text view
  rebuilds each page from them (`translatedPageMarkdown()`) when "Show
  translation" is on.
- **Page rendering**: `files/pageRenderCache.ts` keeps one pdf.js document
  open per loaded file, renders on demand and pre-renders the rest in the
  background (`PREFETCH_LIMIT`); `BboxView` subscribes to it.
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
  merges the results.
- **Jobs that add to a translation** (original-language structure, retries)
  pass it to `beginJob(..., forTranslation)`: they run in its target
  language, with its provider and model while that key is usable, ignore the
  schema setting, and use the OCR result on screen only when it is the one
  the translation was made from (`ocrOf()`). After a cancelled or failed job
  nothing is started automatically (`originalRequested`).
- **Another translation provider**: (1) widen the `ApiProvider` union in
  `src/lib/http/apiError.ts` (it is the `ProviderId` type); (2) implement
  `ChatProvider` (`src/lib/llm/provider.ts`) on a client in `src/lib/<name>/`;
  (3) add a `ProviderInfo` entry to `PROVIDERS` in `src/lib/llm/registry.ts`
  (labels, key URL, default/fallback models, capability flags, `create`);
  (4) add its host to the CSP in `public/_headers` and to the e2e mocks.
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
  When the default changes, append the old default to
  `MODEL_DEFAULT_MIGRATIONS` in `src/lib/storage/settings.ts` so saved
  choices move over once.
- **More target languages**: extend `TARGET_LANGUAGES` in
  `src/lib/storage/settings.ts`; the dropdown renders from it and
  `QUICK_TARGET_LANGUAGES` picks the one-click buttons.
- **Prices for the estimate**: `src/lib/llm/pricing.ts`; models without an
  entry get a token estimate only.
- **Theme / visual style**: shared with github.com/Newblimp/refcheck (Gruvbox
  dark default, warm high-contrast light, system font stacks, orange accent,
  uppercase letter-spaced section labels, dot chips). Tokens keep refcheck's
  names in `src/styles/global.css` (`:root[data-theme]` plus a
  `prefers-color-scheme` block for "system"); icons live in
  `src/components/icons.tsx`; `storage/theme.ts` and `public/theme-init.js`
  apply the choice. Keep the two apps' stylesheets in step when changing
  tokens.

## Conventions

- Wire types use the API's snake_case; app types use camelCase.
- Errors thrown from the clients are `ApiError` with a `kind`, `provider` and
  a user-facing `hint` (the Anthropic provider passes every SDK error through
  `toAnthropicApiError()`); the runner converts anything else with
  `toAppError()`.
- OpenAI GPT-5.x and current Claude models reject `temperature`; those
  providers never send it. The reasoning effort is sent only to providers
  that support it (Anthropic maps "none" to `output_config.effort: "low"`).
- The Anthropic provider streams with `messages.stream()` (text deltas via
  `on("text")`, result from `finalMessage()`), reads only `text` blocks
  (adaptive thinking adds `thinking` blocks first), maps `stop_reason` onto
  the pipeline's names (`max_tokens` and `model_context_window_exceeded` →
  "length", `refusal` → "content_filter", or an `ApiError` of kind "refusal"
  when nothing was produced), and always sends `max_tokens` (required by the
  API).
- `Runtime.getState()` (see `App.tsx`) mirrors the reducer synchronously, so
  code in `runner.ts` can read the state right after a `dispatch`. Async
  work that dispatches late must check it is still relevant (see
  `verifyAndSaveApiKey`, `loadDocument`, the `translation.id` checks in
  `retryFailed`).
- Components that receive callbacks get them from the `on` / `results`
  objects in `App.tsx`, created once: an inline arrow function as a prop
  defeats `memo()` and re-renders the subtree on every streaming update.
- Page images and previews are object URLs: whoever creates one revokes it
  (`releaseDocument()` in the runner, `dispose()` in `pageRenderCache.ts`).
- Settings text inputs use `DraftText` (commit on blur/Enter) so unrelated
  re-renders do not clobber typing.
- `public/theme-init.js` applies the saved theme before the first paint; it
  reads the same localStorage key as `storage/settings.ts` (keep in sync).
- Anything reaching the DOM from the model goes through `MarkdownText`
  (marked + DOMPurify) or is rendered as text. Never inject raw HTML. Files
  the app writes (the bilingual export) get no CSP from `public/_headers`:
  they must not reference anything outside themselves.
- Keep `README.md` (user-facing) and this file (developer-facing) in sync
  with behaviour changes.

## Checks before you push

```bash
npm run typecheck && npm run lint && npm test && npm run e2e && npm run build
```
