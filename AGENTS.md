# Guide for agents and contributors

This file is the map of the codebase for whoever works on it next (human or
AI). Keep it current when you change the architecture.

## Purpose and hard constraints

- Browser-only PDF → OCR → translation → structured JSON, using the Mistral
  API. See README.md for the user-facing description.
- **The document may only ever be sent to `https://api.mistral.ai`.** There is
  no server component, no analytics, no third-party scripts. `public/_headers`
  enforces this with a CSP (`connect-src 'self' https://api.mistral.ai`).
  Do not add Cloudflare Pages Functions, proxies, or remote fonts/scripts
  without an explicit product decision.
- The API key is stored in `localStorage` only. Never put keys in the repo,
  in build-time env vars, or in URLs.
- TypeScript everywhere, `strict` plus `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. `npm run typecheck` must pass.
- Responsiveness first: heavy libraries (pdf.js, marked/DOMPurify) are loaded
  lazily; long lists use `content-visibility`; network calls are cancellable
  via `AbortController`; the translation streams so progress is visible.

## Stack

- [Vite 8](https://vite.dev) + [Preact](https://preactjs.com) (React-compatible
  hooks, ~4 kB) + plain CSS with design tokens (`src/styles/global.css`).
- No runtime dependency on the Mistral SDK; the REST calls are hand-written in
  `src/lib/mistral/client.ts` with wire types in `src/lib/mistral/types.ts`
  (derived from the official SDK's models).
- Tests: Vitest for pure modules, Playwright for end-to-end flows against a
  mocked Mistral API (`e2e/helpers.ts`). CI runs both (`.github/workflows/ci.yml`).

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
  lib/
    mistral/
      client.ts                fetch wrapper, error mapping, SSE streaming
      sse.ts                   pure SSE parser
      types.ts                 request/response wire types (snake_case)
      models.ts                default model ids, model-list filtering
    pipeline/
      runOcr.ts                document → OCR (headers/footers extracted, no images)
      ocrText.ts               OCR response → clean text for translation
      inferSchema.ts           text → JSON Schema (json_object mode)
      schema.ts                schema sanitiser for strict mode + light validator
      schemas/                 built-in schemas (registry in index.ts)
      prompts.ts               all prompt text
      translate.ts             text + schema → JSON (json_schema strict, fallback json_object)
      pipeline.ts              ocrOnly / translateText / ocrAndTranslate
      events.ts                progress events shared by the steps
    files/                     hashing, data-URL encoding, pdf.js preview, file kinds
    storage/                   localStorage (key, settings), IndexedDB OCR cache
    util/                      JSON extraction, text helpers
  styles/global.css
e2e/                           Playwright specs + API mock
public/_headers                Cloudflare Pages headers (CSP etc.)
vite.config.ts                 Preact preset, pdf.js asset serving, _headers in dev/preview
```

Data flow: `components → runner.ts → pipeline/* → mistral/client.ts`, with
results dispatched back into `store.ts` and rendered by the components.

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
- **Using Mistral document annotations** (structured extraction by the OCR
  model itself, ≤ 8 pages): pass `documentAnnotation` to `runOcr()`; the
  response's `document_annotation` string is already typed.
- **Another API host or a proxy**: `MistralClient` takes `baseUrl`; update the
  CSP in `public/_headers` accordingly. This changes the privacy model, so
  document it.
- **Model line-up changes**: edit `src/lib/mistral/models.ts`. The UI already
  lists whatever `/v1/models` returns.

## Conventions

- Wire types use the API's snake_case; app types use camelCase.
- Errors thrown from `client.ts` are `MistralApiError` with a `kind` and a
  user-facing `hint`; the runner converts anything else with `toAppError()`.
- Anything reaching the DOM from the model goes through `MarkdownText`
  (marked + DOMPurify) or is rendered as text. Never inject raw HTML.
- Keep `README.md` (user-facing) and this file (developer-facing) in sync
  with behaviour changes.

## Checks before you push

```bash
npm run typecheck && npm test && npm run e2e && npm run build
```
