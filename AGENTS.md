# Guide for agents and contributors

This file is the map of the codebase for whoever works on it next (human or
AI). Keep it current when you change the architecture.

## Purpose and hard constraints

- Browser-only PDF → OCR (Mistral) → translation (OpenAI GPT Luna, or
  Mistral) → structured JSON. See README.md for the user-facing description.
- **The document may only ever be sent to `https://api.mistral.ai` (OCR), and
  the extracted text plus the OCR's cropped bounding-box images only to the
  selected translation provider (`https://api.openai.com` or
  `https://api.mistral.ai`).** There is no server
  component, no analytics, no third-party scripts. `public/_headers` enforces
  this with a CSP (`connect-src 'self' https://api.mistral.ai https://api.openai.com`).
  Do not add Cloudflare Pages Functions, proxies, or remote fonts/scripts
  without an explicit product decision.
- API keys are stored in `localStorage` only (one per provider). Never put
  keys in the repo, in build-time env vars, or in URLs.
- TypeScript everywhere, `strict` plus `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. `npm run typecheck` must pass.
- Responsiveness first: heavy libraries (pdf.js, marked/DOMPurify) are loaded
  lazily; long lists use `content-visibility`; network calls are cancellable
  via `AbortController`; the translation streams so progress is visible.

## Stack

- [Vite 8](https://vite.dev) + [Preact](https://preactjs.com) (React-compatible
  hooks, ~4 kB) + plain CSS with design tokens (`src/styles/global.css`).
- No runtime dependency on the Mistral or OpenAI SDKs; the REST calls are
  hand-written (`src/lib/mistral/client.ts`, `src/lib/openai/client.ts`) on a
  shared fetch/error/SSE layer (`src/lib/http/`), with wire types derived
  from the official SDKs.
- Tests: Vitest for pure modules, Playwright for end-to-end flows against
  mocked Mistral and OpenAI APIs (`e2e/helpers.ts`). CI runs both
  (`.github/workflows/ci.yml`).

## Code map

```
src/
  main.tsx                     entry; mounts <App/>
  app/
    App.tsx                    layout + wiring of components to the store
    store.ts                   AppState, Action union, reducer, selectors
    runner.ts                  side effects: load document, verify key, run jobs
  components/                  presentational Preact components
    JsonBrowser/               browsable view of the translated JSON
    BboxView.tsx               bounding boxes drawn over the rendered page
  lib/
    http/
      apiFetch.ts              the one authenticated fetch + error mapping
      apiError.ts              ApiError (kind, provider, hint)
      sse.ts                   pure SSE parser
    llm/
      provider.ts              ChatProvider interface (JSON completions)
      openaiProvider.ts        OpenAI implementation (GPT Luna)
      mistralProvider.ts       Mistral implementation
      registry.ts              provider metadata, defaults, factory
    mistral/
      client.ts                OCR + chat + models REST client
      types.ts                 request/response wire types (snake_case)
      models.ts                Mistral model ids, model-list filtering
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
                               fallbacks: without images → non-streaming → json_object
      pipeline.ts              ocrOnly / translateText / ocrAndTranslate
      events.ts                progress events shared by the steps
    files/                     hashing, data-URL encoding, pdf.js preview, page render cache, file kinds
    storage/                   localStorage (keys, settings, theme), IndexedDB OCR cache
    util/                      JSON extraction, partial-JSON parser for streaming, page selection, text helpers
  styles/global.css
e2e/                           Playwright specs + API mock
public/_headers                Cloudflare Pages headers (CSP etc.)
vite.config.ts                 Preact preset, pdf.js asset serving, _headers in dev/preview
```

Data flow: `components → runner.ts → pipeline/* → llm/<provider> or
mistral/client.ts (OCR) → http/apiFetch.ts`, with results dispatched back
into `store.ts` and rendered by the components.

## How to extend

- **New document family / schema**: add a file under
  `src/lib/pipeline/schemas/` and register it in `schemas/index.ts`. Adjust
  `DEFAULT_DOMAIN_HINT` in `prompts.ts` if the default should change.
- **Prompt tuning**: only `src/lib/pipeline/prompts.ts`. Both prompts must keep
  the word "JSON" (required by Mistral's `json_object` mode).
- **New pipeline step** (e.g. chunked translation for very long documents,
  glossary enforcement, a review pass): add a module in `src/lib/pipeline/`,
  emit progress with `emit()` from `events.ts` (add a `StageId` if needed),
  and compose it in `pipeline.ts`. Then surface results through a new field in
  `AppState` and a component.
- **Annotation workflow** (`pipeline.translateText()`): mirrors Mistral's
  Document AI annotations with the vision LLM swapped for the selected chat
  provider. `bboxAnnotate.ts` describes each `OcrText.bboxes` entry that has
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
- **Structured text in the original language**: after `translation/set` the
  runner calls `pipeline.structureOriginal()` (stage `structure_original`,
  `translateStructured(..., target: "original")` with the same schema and bbox
  images, non-streaming) and patches `TranslationState.originalData`. Without
  it (setting off, or an older run) the tab falls back to the translation and
  says so.
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
  (throttled); the store keeps it in `job.streamText`; `ResultsPanel`'s
  `StreamingView` renders it through `util/partialJson.ts`.
- **Another translation provider**: (1) widen the `ApiProvider` union in
  `src/lib/http/apiError.ts` (it is the `ProviderId` type); (2) implement
  `ChatProvider` (`src/lib/llm/provider.ts`) on a client in `src/lib/<name>/`;
  (3) add a `ProviderInfo` entry to `PROVIDERS` in `src/lib/llm/registry.ts`
  (labels, key URL, default/fallback models, capability flags, `create`);
  (4) add its host to the CSP in `public/_headers` and to the e2e mocks.
  Everything else (key storage, key dialog fields, header pills, settings
  model lists, `initialState`) iterates `PROVIDER_IDS` / `perProvider()`.
- **Another API host or a proxy**: the clients take `baseUrl`; update the
  CSP accordingly. This changes the privacy model, so document it.
- **Model line-up changes**: edit `src/lib/openai/models.ts` or
  `src/lib/mistral/models.ts`. The translation-model dropdown lists whatever
  `/v1/models` returns (fallback list when it has not answered); the OCR-model
  dropdown lists `OCR_MODELS`. Both are dropdowns only — no free-text model
  ids — so a model id stored earlier appears as a "(custom)" entry.
  When the default changes, append the old default to
  `MODEL_DEFAULT_MIGRATIONS` in `src/lib/storage/settings.ts` so saved
  choices move over once.
- **More target languages**: extend `TARGET_LANGUAGES` in
  `src/lib/storage/settings.ts`; the toggle renders from it.
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
  a user-facing `hint`; the runner converts anything else with `toAppError()`.
- OpenAI GPT-5.x models reject `temperature`; the OpenAI provider never sends
  it. `reasoning_effort` is sent only to providers that support it.
- `Runtime.getState()` (see `App.tsx`) mirrors the reducer synchronously, so
  code in `runner.ts` can read the state right after a `dispatch`. Async
  work that dispatches late must check it is still relevant (see
  `verifyAndSaveApiKey`, `loadDocument`).
- Settings text inputs use `DraftText` (commit on blur/Enter) so unrelated
  re-renders do not clobber typing.
- `public/theme-init.js` applies the saved theme before the first paint; it
  reads the same localStorage key as `storage/settings.ts` (keep in sync).
- Anything reaching the DOM from the model goes through `MarkdownText`
  (marked + DOMPurify) or is rendered as text. Never inject raw HTML.
- Keep `README.md` (user-facing) and this file (developer-facing) in sync
  with behaviour changes.

## Checks before you push

```bash
npm run typecheck && npm test && npm run e2e && npm run build
```
