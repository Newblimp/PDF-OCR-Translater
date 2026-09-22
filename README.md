# PDF OCR Translator

A browser-only tool that turns a scanned or digital PDF (for example a
communication from the China National Intellectual Property Administration,
CNIPA) into a translated, structured JSON document using
[Mistral Document AI](https://docs.mistral.ai/capabilities/document_ai/basic_ocr)
for OCR and OpenAI's GPT Luna
([`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna))
with JSON-schema structured outputs for translation. Mistral chat models
remain available as an alternative translation provider.

**Privacy model:** the site is a static bundle. The document is read in your
browser, base64-encoded there and sent **only** to `https://api.mistral.ai`
(OCR). The extracted text **and the cropped bounding-box images that Mistral
OCR returns** (figures, stamps, seals; up to 8 with the translation request
and up to the configured limit for per-box descriptions, both can be turned
off in Settings) are then sent **only** to the translation provider
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
   `extract_footer` on, `include_image_base64` (the extracted bounding boxes
   with their cropped images) and `include_blocks` (paragraph-level boxes).
   Headers and footers never reach the translation step; image references in
   the text become `[Image: id]` placeholders that match the box ids.
4. **JSON format inference** (default) asks the translation model to design a
   JSON Schema for *this* document — the API-side counterpart of Mistral's
   playground option "infer a JSON format from the document". You can instead
   pick the built-in *patent office communication* schema or paste your own.
5. **BBox annotation** (Mistral's workflow, performed by the selected vision
   model): one call per extracted bounding box with a fixed format
   (`image_type`, `short_description`, `summary`, plus the text in the image
   and its translation). Capped by a setting (default 20 boxes per run).
6. **Document annotation = translation** (Mistral's workflow, performed by
   the vision model): the OCR Markdown, the first 8 bounding-box images and
   the JSON format go to the model in one `/v1/chat/completions` call with
   `response_format: { type: "json_schema", strict: true }`, so the API only
   returns well-formed JSON that matches the schema. Tokens are streamed and
   the partial JSON is rendered live. If the API rejects the request, the app
   falls back step by step (without images, non-streaming, then
   `json_object` mode). Target language is a toggle: **English** or **German**.
   The "Structured text" tab starts with a step strip that states which model
   did what, including how many images were sent.
7. **Structured text in the original language** (on by default, one extra
   model call): the same JSON format is filled a second time without
   translating, so the structured fields can be read in the document's own
   wording. Together with the per-block translations of the OCR text, this is
   what the **Show translation** switch turns on and off.
8. **Browse the result** in five tabs, left to right:
   - **Bounding boxes** (the default): the OCR boxes (figures and paragraph
     blocks) drawn over the rendered page, with the cropped image and the
     vision model's description for each box; clicking a text block shows its
     translation above the original. Pages render in the background so
     browsing is instant.
   - **OCR text**: the Markdown per page, either as OCR'd or rebuilt from the
     per-block translations.
   - **Structured text**: an outline of the fields, one collapsible card per
     field (expand/collapse all), long text collapsible and rendered as
     Markdown (tables, lists), arrays as lists or grids, full-text search
     across fields, copy/download of the JSON, and fields that can be hidden
     and shown individually (checkboxes in the outline, Hide all / Show all).
   - **JSON format**: the schema that was used.
   - **Raw JSON**: the result as text.

   A **Show translation** switch in the OCR text, Structured text and Raw JSON
   toolbars flips all three between the translation and the document's own
   language; it is one shared setting, not one per tab. The document card
   takes a page selection (e.g. `1-3, 7`) to OCR only part of a PDF.

Two API keys are requested on first use (Mistral for OCR, OpenAI for
translation), verified against each provider's `GET /v1/models`, and cached
in this browser's `localStorage` only. The key dialog also lets you pick
Mistral as the translation provider, in which case only the Mistral key is
needed. "Forget" in the header removes all keys.
OCR results are cached in the browser's IndexedDB (keyed by a SHA-256 of the
file) so re-running "Translate only" on the same file costs no OCR credits.
Both caches can be cleared from the UI. The header also offers a
light / system / dark theme switch; the look (Gruvbox dark by default) is
shared with [refcheck](https://github.com/Newblimp/refcheck).

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
| OCR model | `mistral-ocr-latest` (dropdown of `OCR_MODELS`) | `src/lib/mistral/models.ts` |
| Translation provider | OpenAI (GPT Luna); Mistral selectable | `src/lib/llm/registry.ts` |
| Translation model | `gpt-6-luna` (OpenAI) / `mistral-large-latest` (Mistral); dropdown of the models from `/v1/models` | `src/lib/openai/models.ts`, `src/lib/mistral/models.ts` |
| Reasoning effort (OpenAI) | `none` | Settings panel |
| Max output tokens | provider default | Settings panel |
| Document annotation with images | on (first 8 boxes, `DOCUMENT_ANNOTATION_MAX_IMAGES`) | Settings panel, `src/lib/pipeline/runOcr.ts` |
| BBox annotation | on, up to 20 boxes per run | Settings panel; format in `src/lib/pipeline/schemas/bboxAnnotation.ts` |
| Block translations | on | Settings panel; `src/lib/pipeline/blockTranslate.ts` |
| Structured text in the original language | on (one extra model call) | Settings panel; `src/lib/pipeline/translate.ts` (`target: "original"`) |
| Pages to OCR | all | Document card (`src/lib/util/pageSelection.ts`) |
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
- The vision steps need a model with image input (GPT Luna has it; for the
  Mistral provider pick a multimodal model). If the model rejects images, the
  translation is retried text-only and the step strip says so.
- OCR results cached in the browser before this workflow (without images)
  are ignored; the file is OCR'd again once.

See [AGENTS.md](AGENTS.md) for the code map and conventions.
