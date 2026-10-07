# PDF OCR Translator

A browser-only tool that turns a scanned or digital PDF (for example a
communication from the China National Intellectual Property Administration,
CNIPA) into a translated, structured JSON document using
[Mistral Document AI](https://docs.mistral.ai/capabilities/document_ai/basic_ocr)
for OCR and Anthropic's Claude Haiku 5.5
([`claude-haiku-5-5`](https://platform.claude.com/docs/en/models/haiku-5-5/overview))
with JSON-schema structured outputs for translation. OpenAI's GPT Luna
(`gpt-6-luna`) and Mistral chat models remain available as alternative
translation providers.

**Privacy model:** the site is a static bundle. The document is read in your
browser, base64-encoded there and sent **only** to `https://api.mistral.ai`
(OCR). The extracted text **and the cropped bounding-box images that Mistral
OCR returns** (figures, stamps, seals; up to 8 with the translation request
and up to the configured limit for per-box descriptions, both can be turned
off in Settings) are then sent **only** to the translation provider
(`https://api.anthropic.com` by default, or `https://api.openai.com` /
`https://api.mistral.ai` when selected). Nothing is uploaded to GitHub,
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

   Below the buttons, a rough **token and cost estimate** of the translation
   is shown (cost for Claude models, whose prices the app knows; OCR is billed
   by Mistral per page on top). "OCR + Translate" reuses an OCR result that
   is already loaded for the same file, model and pages instead of paying for
   OCR again.
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
   `json_object` mode). If the output limit cuts the JSON off, the fields
   received up to that point are kept and the result says so. Target language:
   **English** or **German** in one click, eight more (French, Spanish,
   Italian, Portuguese, Dutch, Japanese, Korean, Chinese) from a dropdown. An
   optional **glossary** (`source = target`, one per line) is sent with every
   translation call. The "Structured text" tab starts with a step strip that
   states which model did what, including how many images were sent.

   The bbox annotation runs at the same time as the translation, and the
   follow-ups (block translations, original-language structure) run side by
   side once it is done. Long documents (over ~40k tokens of text) are
   translated in parts along page boundaries, each with its own images, and
   merged field by field: each request stays well below the output limit and
   below Claude Haiku 5.5's 100k-token price step. The document and its images
   come first in every request and are identical across the calls of a run,
   so the providers' prompt caches serve them again at a fraction of the
   price (an explicit cache breakpoint on Anthropic; automatic on OpenAI).
7. **Structured text in the original language** (on demand by default): the
   same JSON format is filled without translating, so the structured fields
   can be read in the document's own wording. It is produced the first time
   the structured text is viewed with **Show translation** switched off (one
   extra model call; "after every translation" and "never" are the other
   choices in Settings). Together with the per-block translations of the OCR
   text, this is what the **Show translation** switch turns on and off. If a
   follow-up step fails (block translations, box descriptions, this one), the
   translation stays and a warning names the step; failed boxes and
   untranslated blocks can be retried with one click.
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
   **Download bilingual HTML** saves one self-contained page with the
   translation next to the original, field by field and block by block; it
   prints to PDF and opens in Word.
9. **Recent translations**: finished translations are kept in this browser
   (IndexedDB, last 30). They can be reopened from the list (with their OCR
   result while the OCR cache still has it), and loading a document that was
   translated before shows its last translation right away.

Two API keys are requested on first use (Mistral for OCR, Anthropic for
translation), verified against each provider's `GET /v1/models`, and kept in
this browser's `localStorage`, or only for the tab's session when "Remember
keys" is switched off in the key dialog. The key dialog also lets you pick
OpenAI or Mistral as the translation provider; with Mistral only the Mistral
key is needed. "Forget" in the header removes all keys.
OCR results are cached in the browser's IndexedDB (keyed by a SHA-256 of the
file, the OCR model and the pages) so translating the same file again costs
no OCR credits. The OCR cache and the saved translations can be cleared from
the UI. Mistral and OpenAI requests that hit a rate limit (429), a server
error (5xx) or a dropped connection are retried twice with backoff, as the
Anthropic SDK does for Anthropic. The header also offers a
light / system / dark theme switch; the look (Gruvbox dark by default) is
shared with [refcheck](https://github.com/Newblimp/refcheck).

## Development

Requires Node.js 22.13+ (see `.node-version`).

```bash
npm install
npm run dev          # http://localhost:5173, with the production CSP applied
npm run typecheck    # strict TypeScript
npm run lint         # ESLint (typescript-eslint, React hooks rules)
npm test             # unit tests (Vitest)
npm run e2e          # Playwright end-to-end tests against mocked Mistral, Anthropic and OpenAI APIs
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
| Translation provider | Anthropic (Claude Haiku 5.5); OpenAI and Mistral selectable | `src/lib/llm/registry.ts` |
| Translation model | `claude-haiku-5-5` (Anthropic) / `gpt-6-luna` (OpenAI) / `mistral-large-latest` (Mistral); dropdown of the models from `/v1/models` | `src/lib/anthropic/models.ts`, `src/lib/openai/models.ts`, `src/lib/mistral/models.ts` |
| Reasoning effort (Anthropic, OpenAI) | `none` (Anthropic: effort `low`, its lowest) | Settings panel |
| Max output tokens | provider default (Anthropic: 64k, the API requires a value) | Settings panel, `src/lib/anthropic/models.ts` |
| Anthropic retries / timeout | 2 retries with backoff (the SDK's default) / 1 hour per request | `src/lib/anthropic/client.ts` |
| Document annotation with images | on (first 8 boxes, `DOCUMENT_ANNOTATION_MAX_IMAGES`) | Settings panel, `src/lib/pipeline/runOcr.ts` |
| BBox annotation | on, up to 20 boxes per run | Settings panel; format in `src/lib/pipeline/schemas/bboxAnnotation.ts` |
| Block translations | on | Settings panel; `src/lib/pipeline/blockTranslate.ts` |
| Structured text in the original language | on demand (when viewed with "Show translation" off); always; never | Settings panel; `src/lib/pipeline/pipeline.ts` (`structureOriginal()`) |
| Glossary | empty | Settings panel; `src/lib/pipeline/prompts.ts` (`parseGlossary()`) |
| Long documents | split above ~40k estimated tokens (`TRANSLATION_CHUNK_TOKENS`) | `src/lib/pipeline/chunks.ts` |
| Saved translations | on, last 30 | Settings panel; `src/lib/storage/history.ts` |
| Mistral / OpenAI retries | 2 with backoff, honouring `retry-after` | `src/lib/http/apiFetch.ts` |
| Model prices for the estimate | Claude Haiku/Sonnet/Opus 5.5 | `src/lib/llm/pricing.ts` |
| Pages to OCR | all | Document card (`src/lib/util/pageSelection.ts`) |
| Target / source language | English or German in one click, eight more in a dropdown / auto-detect | `src/lib/storage/settings.ts` (`TARGET_LANGUAGES`) |
| JSON format | inferred from document; built-in `patent_communication`; custom | `src/lib/pipeline/schemas/` |
| Prompts | schema inference and translation | `src/lib/pipeline/prompts.ts` |
| Temperature (Mistral only) | 0.2 | Settings panel |
| API limits (50 MB, 1000 pages) | checked client-side | `src/lib/pipeline/runOcr.ts` |
| CSP / security headers | `connect-src https://api.mistral.ai https://api.anthropic.com https://api.openai.com` | `public/_headers` |

## Limitations and notes

- Long documents are translated in parts and merged: arrays are concatenated
  and text fields joined, so a field such as `summary` holds one paragraph per
  part. Schema inference sees the first 60,000 characters only.
- The browser calls `api.mistral.ai`, `api.anthropic.com` and
  `api.openai.com` directly, which relies on the APIs' CORS headers. If a
  browser ever blocks a call, the app reports it as a network error with a
  hint.
- Anthropic is called through Anthropic's official TypeScript SDK
  (`@anthropic-ai/sdk`, bundled with the site and loaded the first time it is
  needed) with its browser opt-in, `dangerouslyAllowBrowser`, which sends the
  `anthropic-dangerous-direct-browser-access: true` header. The SDK warns
  about browser use because a key shipped inside a website would leak; here
  the key is your own, typed into your browser and sent only to
  `api.anthropic.com`. Rate-limited (429) and overloaded or failing (5xx)
  requests, and connections that fail before a response arrives, are retried
  twice with backoff; an error after the answer has started arriving (for
  example in the middle of a streamed translation) is reported straight away.
- GPT-5.x and current Claude models do not accept a custom `temperature`;
  the app never sends one to OpenAI or Anthropic. The reasoning effort
  defaults to `none` (OpenAI `reasoning_effort`; Anthropic
  `output_config.effort: "low"`, since Claude has no "none") for speed and
  cost and can be raised in Settings. Claude's adaptive thinking stays on;
  its thinking blocks are discarded.
- Anthropic's structured outputs carry no schema name and have no
  `json_object` mode: schema inference (and the last translation fallback)
  rely on the prompt and the app's JSON extraction. Only Claude models that
  accept `effort` (Opus 4.5 and later, Sonnet 4.6 and later, Haiku 5.5) are
  offered in the model dropdown.
- Settings saved by an earlier version keep their translation provider, so a
  browser that already used OpenAI keeps it until you switch in Settings.
- The API keys live in `localStorage` of this origin (or `sessionStorage`
  with "Remember keys" off). Anyone with access to the browser profile can
  read them.
- Saved translations and the OCR cache stay in this browser's IndexedDB until
  cleared; they contain the document's text.
- The vision steps need a model with image input (Claude Haiku 5.5 and GPT
  Luna have it; for the Mistral provider pick a multimodal model). If the model rejects images, the
  translation is retried text-only and the step strip says so.
- OCR results cached in the browser before this workflow (without images)
  are ignored; the file is OCR'd again once.

See [AGENTS.md](AGENTS.md) for the code map and conventions.
