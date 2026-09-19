# PDF OCR Translator

A browser-only tool that turns a scanned or digital PDF (for example a
communication from the China National Intellectual Property Administration,
CNIPA) into a translated, structured JSON document using
[Mistral Document AI](https://docs.mistral.ai/capabilities/document_ai/basic_ocr)
for OCR and OpenAI's GPT Luna
([`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna))
with JSON-schema structured outputs for translation. Mistral chat models
remain available as an alternative translation provider.

**Privacy model:** the site is a static bundle. The document is read in your
browser, base64-encoded there and sent **only** to `https://api.mistral.ai`
(OCR). The extracted text is then sent **only** to the translation provider
(`https://api.openai.com` by default). Nothing is uploaded to GitHub,
Cloudflare, or any other server. A Content-Security-Policy header
(`public/_headers`) enforces this in production: the page cannot connect
anywhere else.

## What it does

1. **Drop or pick a file** — PDF, PNG/JPEG/WebP (OCR), or `.txt`/`.md`
   (translation only). A preview of the first pages is rendered locally with
   pdf.js.
2. **Choose an action**
   - **OCR + Translate** — full pipeline.
   - **OCR only** — get the Markdown text of the document.
   - **Translate only** — translate the OCR text of the loaded file (this
     session's result or the local cache), a dropped text file, or pasted text.
3. **OCR** runs on `mistral-ocr-latest` with `extract_header` /
   `extract_footer` on and images disabled, so headers, footers and images
   never reach the translation step.
4. **JSON format inference** (default) asks the translation model to design a
   JSON Schema for *this* document — the API-side counterpart of Mistral's
   playground option "infer a JSON format from the document". You can instead
   pick the built-in *patent office communication* schema or paste your own.
5. **Mistral OCR annotation** (on by default) sends that JSON format back to
   Mistral OCR as `document_annotation_format`, so the OCR model itself fills
   the fields from the page images, in the source language. This is a second
   OCR pass (the format is only known after the first read) and the API
   annotates at most the first 8 pages. The result is shown in its own tab
   and handed to the translation model together with the full text. The
   "Translation" tab shows a step strip that states whether this happened.
6. **Translation** calls the provider's `/v1/chat/completions` with
   `response_format: { type: "json_schema", strict: true }`, so the API only
   returns well-formed JSON that matches the schema. Tokens are streamed to
   show progress. If the API rejects the request, the app falls back
   step by step (non-streaming, then `json_object` mode).
   Target language is a toggle: **English** or **German**.
7. **Browse the result**: an outline of the fields, one collapsible card per
   field (expand/collapse all), long text collapsible and rendered as
   Markdown (tables, lists), arrays as lists or grids, full-text search
   across fields, copy/download of the JSON, and tabs for the OCR text and
   the schema that was used.

Two API keys are requested on first use (Mistral for OCR, OpenAI for
translation), verified against each provider's `GET /v1/models`, and cached
in this browser's `localStorage` only. The key dialog also lets you pick
Mistral as the translation provider, in which case only the Mistral key is
needed. "Forget" in the header removes all keys.
OCR results are cached in the browser's IndexedDB (keyed by a SHA-256 of the
file) so re-running "Translate only" on the same file costs no OCR credits.
Both caches can be cleared from the UI. The header also offers a
light / dark / system theme switch.

## Development

Requires Node.js 22.13+ (see `.node-version`).

```bash
npm install
npm run dev          # http://localhost:5173, with the production CSP applied
npm run typecheck    # strict TypeScript
npm test             # unit tests (Vitest)
npm run e2e          # Playwright end-to-end tests against mocked Mistral and OpenAI APIs
npm run build        # typecheck + production build into dist/
npm run preview      # serve dist/ locally
```

The e2e suite needs a Chromium. Either `npx playwright install chromium` or
point `CHROMIUM_EXECUTABLE_PATH` at an existing binary. Set `SCREENSHOTS=1`
to generate screenshots with `npx playwright test e2e/screenshots.spec.ts`.

## Deploying to Cloudflare Pages

Cloudflare Pages builds directly from this repository; there are no Pages
Functions and no secrets to configure.

1. In the Cloudflare dashboard choose **Workers & Pages → Create → Pages →
   Connect to Git** and select this repository.
2. Build settings:
   - Framework preset: **Vite** (or none)
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variable: `NODE_VERSION=22` (Pages also honours `.node-version`)
3. Deploy. `public/_headers` is picked up automatically and sets the CSP and
   other security headers. `public/_headers` also applies to preview
   deployments of pull requests.

Because everything happens client-side, the same `dist/` folder can be hosted
on any static host.

## Configuration reference

All defaults live in code so they can be changed in one place:

| Setting | Default | Where |
| --- | --- | --- |
| OCR model | `mistral-ocr-latest` | `src/lib/mistral/models.ts` |
| Translation provider | OpenAI (GPT Luna); Mistral selectable | `src/lib/llm/registry.ts` |
| Translation model | `gpt-5.6-luna` (OpenAI) / `mistral-large-latest` (Mistral); any model from `/v1/models` selectable | `src/lib/openai/models.ts`, `src/lib/mistral/models.ts` |
| Reasoning effort (OpenAI) | `none` | Settings panel |
| Max output tokens | provider default | Settings panel |
| Mistral OCR annotation | on (PDF/image input only, first 8 pages) | Settings panel |
| Target / source language | English or German toggle / auto-detect | `src/lib/storage/settings.ts` (`TARGET_LANGUAGES`) |
| JSON format | inferred from document; built-in `patent_communication`; custom | `src/lib/pipeline/schemas/` |
| Prompts | schema inference and translation | `src/lib/pipeline/prompts.ts` |
| Temperature (Mistral only) | 0.2 | Settings panel |
| API limits (50 MB, 1000 pages) | checked client-side | `src/lib/pipeline/runOcr.ts` |
| CSP / security headers | `connect-src https://api.mistral.ai https://api.openai.com` | `public/_headers` |

## Limitations and notes

- A single translation call must fit in the model's context window. Very
  long documents (hundreds of pages) would need a chunked strategy; the
  pipeline is structured so one can be added in `src/lib/pipeline/`.
- The browser calls `api.mistral.ai` and `api.openai.com` directly, which
  relies on the APIs' CORS headers. If a browser ever blocks a call, the app
  reports it as a network error with a hint.
- GPT-5.x models do not accept a `temperature`; the app never sends one to
  OpenAI. `reasoning_effort` defaults to `none` for speed and cost and can
  be raised in Settings.
- The API keys live in `localStorage` of this origin, as requested. Anyone
  with access to the browser profile can read them.
- Mistral's OCR *document annotation* covers at most 8 pages per the API;
  longer documents are annotated on their first 8 pages and the translation
  model fills the rest from the full text. "OCR only" never annotates.

See [AGENTS.md](AGENTS.md) for the code map and conventions.
