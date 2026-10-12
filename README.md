# PDF OCR Translator

A browser-only tool that turns a scanned or digital PDF (for example a
communication from the China National Intellectual Property Administration,
CNIPA) into a translation, block by block (paragraphs, titles, tables,
figures), that can be filtered and laid out like the page, and optionally
into a structured JSON document, using
[Mistral Document AI](https://docs.mistral.ai/capabilities/document_ai/basic_ocr)
for OCR and Mistral Small
([`mistral-small-latest`](https://mistral.ai/news/mistral-small-4/), Mistral
Small 4) with JSON-schema structured outputs for translation, so one Mistral
key does everything. Anthropic's Claude Haiku 5.5 (`claude-haiku-5-5`),
OpenAI's GPT Luna (`gpt-6-luna`) and the other Mistral chat models remain
available as alternative translation models.

**Privacy model:** the site is a static bundle. The document is read in your
browser, base64-encoded there and sent **only** to `https://api.mistral.ai`
(OCR). The extracted text **and the cropped bounding-box images that Mistral
OCR returns** (figures, stamps, seals; up to 8 with the translation request
and up to the configured limit for per-box descriptions, both can be turned
off in Settings) are then sent **only** to the translation provider
(`https://api.mistral.ai` by default, the same host as the OCR, or
`https://api.anthropic.com` / `https://api.openai.com` when selected). Nothing is uploaded to GitHub,
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

   Below the buttons, the **target language** (English or German in one
   click; the other languages are in Settings) and the **glossary** are
   always at hand; the settings start closed. "OCR + Translate" reuses an OCR result that
   is already loaded for the same file, model and pages instead of paying for
   OCR again.

3. **OCR** runs on `mistral-ocr-latest` with `extract_header` /
   `extract_footer` on, `include_image_base64` (the extracted bounding boxes
   with their cropped images) and `include_blocks` (paragraph-level boxes).
   Headers and footers never reach the translation step; image references in
   the text become `[Image: id]` placeholders that match the box ids.
4. **Translation, block by block** (the default): the OCR's text blocks are
   translated in batches (strict JSON-schema structured output keyed by block
   id) and the OCR text tab fills in as each batch arrives. Only the blocks
   the OCR text tab keeps are translated: block types switched off there
   (page headers and footers by default) and blocks left out one by one are
   skipped, and a block taken back later is translated on its own with one
   click. Pasted text and text files are split into paragraphs and go the same
   way. No JSON format, no summary, no extra calls.

   With **JSON output** switched on (the last option in Settings; off by
   default), the steps below fill a JSON format with the translation as well,
   and the Structured text, JSON format and Raw JSON tabs appear. All the JSON
   settings (format, streaming, images, original-language structure, max
   output tokens, block translations as a follow-up) sit under that switch.
   **JSON format inference** asks the translation model to design a
   JSON Schema for _this_ document — the API-side counterpart of Mistral's
   playground option "infer a JSON format from the document". You can instead
   pick the built-in _patent office communication_ schema or paste your own.

5. **BBox annotation** (Mistral's workflow, performed by the selected vision
   model): one call per extracted bounding box with a fixed format
   (`image_type`, `short_description`, `summary`, plus the text in the image
   and its translation). Capped by a setting (default 20 boxes per run).
6. **Document annotation = translation** (JSON output; Mistral's workflow, performed by
   the vision model): the OCR Markdown, the first 8 bounding-box images and
   the JSON format go to the model in one `/v1/chat/completions` call with
   `response_format: { type: "json_schema", strict: true }`, so the API only
   returns well-formed JSON that matches the schema. Tokens are streamed and
   the partial JSON is rendered live. If the API rejects the request, the app
   falls back step by step (without images, non-streaming, then
   `json_object` mode). If the output limit cuts the JSON off, the fields
   received up to that point are kept and the result says so. Target language:
   **English** or **German** in one click above the settings, eight more (French, Spanish,
   Italian, Portuguese, Dutch, Japanese, Korean, Chinese) from a dropdown in Settings. An
   optional **glossary** (`source = target`, one per line, above the settings) is sent with every
   translation call. The "Structured text" tab starts with a step strip that
   states which model did what, including how many images were sent.

   The bbox annotation runs at the same time as the translation, and the
   follow-ups (block translations, original-language structure) run side by
   side once it is done. Long documents (over ~40k tokens of text) are
   translated in parts along page boundaries, each with its own images, and
   merged field by field: each request stays well below the output limit and
   below Claude Haiku 5.5's 100k-token price step. The document and its images
   come first in every request, so the translation and the structure in the
   original language share a prefix that the providers' prompt caches serve
   again at a fraction of the price (an explicit cache breakpoint on
   Anthropic; automatic on OpenAI).

7. **Structured text in the original language** (JSON output; on demand by default): the
   same JSON format is filled without translating, so the structured fields
   can be read in the document's own wording. It is produced the first time
   the structured text is viewed with **Show translation** switched off (one
   extra model call; "after every translation" and "never" are the other
   choices in Settings). Together with the per-block translations of the OCR
   text, this is what the **Show translation** switch turns on and off. If a
   follow-up step fails (block translations, box descriptions, this one), the
   translation stays and a warning names the step; failed boxes and
   untranslated blocks can be retried with one click.
8. **Browse the result** in two tabs, five with the JSON output, left to right:
   - **Bounding boxes** (the default): the OCR boxes (figures and paragraph
     blocks) drawn over the rendered page, with the cropped image and the
     vision model's description for each box; clicking a text block shows its
     translation above the original. Pages render in the background so
     browsing is instant.
   - **Edit bounding boxes**: fix what the OCR got wrong, on the page. Drag
     a rectangle (like a rectangular marquee) or click a block, then:
     **Cut out of the blocks** takes the area out of every block it touches
     (blocks inside it go; a text block it crosses keeps the rest, its text
     read again by Mistral OCR from an image of that rest with the area
     blanked; made for margin line numbers and stamps over text); **Make a
     block** reads the area as one block of the type you pick (an image
     keeps it as a picture) and cuts it out of the blocks around it, which
     also merges or splits blocks; **Delete** removes blocks; a selected
     block's type and text can be changed by hand or read again by OCR.
     Undo (Ctrl+Z) and reset per page or for all pages. The edits apply to
     every view and to the next translation; they are kept with the OCR
     result in this browser's cache. A translation made before stays: the
     blocks that were not changed keep their translations, and the changed
     ones are translated with one click ("Translate them").
   - **OCR text**: the text block by block, page by page, as OCR'd or
     translated, with the cropped figures where they are in the text. One
     switch per **block type** found in the document (title, text, list,
     table, caption, image, header, footer, signature, ...; headers and
     footers off by default) leaves that type out of the text, the copy, the
     download and the block translations. **Show PDF** puts the document's
     pages beside the text, each side scrolling on its own; **Lock
     scrolling** (on by default) scrolls both together page by page, so the
     same page stays in view on both sides; while locked, neither side
     bounces (elastic overscroll) past its ends, so they never drift apart.
     **Select blocks on the PDF**
     draws the blocks over the pages: a click leaves a block out of the text
     (it is hatched on the page), another click takes it back, and hovering
     one highlights it in the text; "Take them all back" undoes it.
     **Match page layout** places every block where it is on the page, on a
     sheet shaped like the page, its text (original or translated) sized to
     fill the block's box, so the text lines up with the PDF beside it. These
     choices are remembered; the blocks left out one by one belong to the
     document on screen.
   - **Structured text** (JSON output): an outline of the fields, one collapsible card per
     field (expand/collapse all), long text collapsible and rendered as
     Markdown (tables, lists), arrays as lists or grids, full-text search
     across fields, copy/download of the JSON, and fields that can be hidden
     and shown individually (checkboxes in the outline, Hide all / Show all).
   - **JSON format** (JSON output): the schema that was used.
   - **Raw JSON** (JSON output): the result as text.

   The tabs can be arranged in **split views**, like editor tabs in VS Code:
   drag a tab onto a side of another view to open it beside or below it,
   onto the middle of a view or onto another tab bar to join that group, or
   along a tab bar to reorder. Drag the bar between two views to resize them
   (or focus it and use the arrow keys; double-click shares the space
   equally). The buttons next to a group's tabs move the shown tab into a
   new group on the right or below without dragging, and the reset button
   puts all tabs back in one group. Moving tabs around keeps each view as it
   was (page, scroll position, switches). The arrangement is saved in this
   browser. On narrow screens the groups are stacked.

   A **Show translation** switch in the OCR text, Structured text and Raw JSON
   toolbars flips all three between the translation and the document's own
   language; it is one shared setting, not one per tab. The document card
   takes a page selection (e.g. `1-3, 7`) to OCR only part of a PDF.
   **Download bilingual HTML** (Structured text) saves one self-contained page with the
   translation next to the original, field by field and block by block; it
   prints to PDF and opens in Word. The file loads nothing from outside
   (remote image URLs in the text are removed and it carries its own CSP).

9. **Recent translations**: finished translations are kept in this browser
   (IndexedDB, last 30). They can be reopened from the list (with their OCR
   result while the OCR cache still has it), and loading a document that was
   translated before shows its last translation right away.

One API key is requested on first use, Mistral's (for OCR and translation),
verified against the provider's `GET /v1/models` and kept in this browser's
`localStorage`, or only for the tab's session when "Remember keys" is
switched off in the key dialog. The key dialog also lets you pick Anthropic
(Claude) or OpenAI as the translation provider; its key is then needed as
well. "Forget" in the header removes all keys.
OCR results are cached in the browser's IndexedDB (keyed by a SHA-256 of the
file, the OCR model and the pages) so translating the same file again costs
no OCR credits. The OCR cache and the saved translations can be cleared from
the UI. Mistral and OpenAI requests that hit a rate limit (429), a server
error (5xx) or a dropped connection are retried twice with backoff, as the
Anthropic SDK does for Anthropic. The panel button in the side panel's
title bar folds the side panel (document, actions, settings, recent
translations) into a narrow rail, leaving the width to the results; the rail
shows a running job (with Cancel) and an error, and the choice is
remembered. The header also offers a
light / system / dark theme switch; the look (Gruvbox dark by default) is
shared with [refcheck](https://github.com/Newblimp/refcheck).

## Development

Requires Node.js 22.13+ (see `.node-version`).

```bash
npm install
npm run dev          # http://localhost:5173, with the production CSP applied
npm run typecheck    # strict TypeScript
npm run lint         # ESLint (typescript-eslint, React hooks rules)
npm run format       # Prettier: format everything (format:check only checks, as CI does)
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

| Setting                                                | Default                                                                                                                             | Where                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| OCR model                                              | `mistral-ocr-latest` (dropdown of `OCR_MODELS`)                                                                                     | `src/lib/mistral/models.ts`                                                            |
| Translation provider                                   | Mistral (Mistral Small); Anthropic and OpenAI selectable                                                                            | `src/lib/llm/registry.ts`                                                              |
| Translation model                                      | `mistral-small-latest` (Mistral) / `claude-haiku-5-5` (Anthropic) / `gpt-6-luna` (OpenAI); dropdown of the models from `/v1/models` | `src/lib/anthropic/models.ts`, `src/lib/openai/models.ts`, `src/lib/mistral/models.ts` |
| Reasoning effort                                       | `none` (Mistral: `none` or `high`; Anthropic: effort `low`, its lowest)                                                             | Settings panel                                                                         |
| JSON output                                            | off: the text blocks are translated one by one; on: JSON format + document annotation, and the JSON tabs                            | Settings panel (last option); `src/lib/storage/settings.ts` (`jsonOutput`)             |
| Block types left out of the OCR text                   | page headers and footers                                                                                                            | OCR text tab; `src/lib/storage/settings.ts` (`ocrHiddenTypes`)                         |
| Max output tokens (JSON output)                        | provider default (Anthropic: 64k, the API requires a value)                                                                         | Settings panel, `src/lib/anthropic/models.ts`                                          |
| Anthropic retries / timeout                            | 2 retries with backoff (the SDK's default) / 1 hour per request                                                                     | `src/lib/anthropic/client.ts`                                                          |
| Document annotation with images (JSON output)          | on (first 8 boxes, `DOCUMENT_ANNOTATION_MAX_IMAGES`)                                                                                | Settings panel, `src/lib/pipeline/runOcr.ts`                                           |
| BBox annotation                                        | on, up to 20 boxes per run                                                                                                          | Settings panel; format in `src/lib/pipeline/schemas/bboxAnnotation.ts`                 |
| Block translations as a follow-up (JSON output)        | on                                                                                                                                  | Settings panel; `src/lib/pipeline/blockTranslate.ts`                                   |
| Structured text in the original language (JSON output) | on demand (when viewed with "Show translation" off); always; never                                                                  | Settings panel; `src/lib/pipeline/pipeline.ts` (`structureOriginal()`)                 |
| Glossary                                               | empty                                                                                                                               | Above the settings; `src/lib/pipeline/glossary.ts` (`parseGlossary()`)                 |
| Long documents                                         | split above ~40k estimated tokens (`TRANSLATION_CHUNK_TOKENS`)                                                                      | `src/lib/pipeline/chunks.ts`                                                           |
| Saved translations                                     | on, last 30                                                                                                                         | Settings panel; `src/lib/storage/history.ts`                                           |
| Mistral / OpenAI retries                               | 2 with backoff, honouring `retry-after`                                                                                             | `src/lib/http/apiFetch.ts`                                                             |
| Pages to OCR                                           | all                                                                                                                                 | Document card (`src/lib/util/pageSelection.ts`)                                        |
| Target / source language                               | English or German in one click, eight more in a dropdown / auto-detect                                                              | `src/lib/storage/settings.ts` (`TARGET_LANGUAGES`)                                     |
| JSON format (JSON output)                              | inferred from document; built-in `patent_communication`; custom                                                                     | `src/lib/pipeline/schemas/`                                                            |
| Prompts                                                | schema inference and translation                                                                                                    | `src/lib/pipeline/prompts.ts`                                                          |
| Temperature (Mistral only)                             | 0.2                                                                                                                                 | Settings panel                                                                         |
| API limits (50 MB, 1000 pages)                         | checked client-side                                                                                                                 | `src/lib/pipeline/runOcr.ts`                                                           |
| CSP / security headers                                 | `connect-src https://api.mistral.ai https://api.anthropic.com https://api.openai.com`                                               | `public/_headers`                                                                      |

## Limitations and notes

- Block by block, each block is translated with the others of its batch (up
  to 40 blocks or 12,000 characters) as context, not the whole document: a
  sentence split across a page break can read awkwardly, and the glossary
  keeps terms consistent across batches. "Match page layout" shrinks the
  font of a block whose translation is longer than the original; at the
  smallest size the block scrolls (marked with a line at its bottom).
- Reading an area again sends an image of it (rendered in the browser from
  the loaded document) to `api.mistral.ai`, like the document itself; each
  area is one OCR page for Mistral. It needs the document loaded; a result
  reopened from "Recent translations" without it can still have blocks
  deleted or changed by hand.
- The blocks left out one by one are not saved with a translation: they are
  kept for the document on screen until another OCR result or document is
  loaded.
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
  defaults to `none` (Mistral and OpenAI `reasoning_effort`; Anthropic
  `output_config.effort: "low"`, since Claude has no "none") for speed and
  cost and can be raised in Settings. Mistral documents `none` and `high`
  for Mistral Small 4, so Settings offers those two for Mistral (`high`
  makes the model think first; its thinking is discarded, like Claude's
  adaptive thinking). A Mistral model that rejects the parameter is asked
  again without it, and it is not sent to that model again in the session.
- Anthropic's structured outputs carry no schema name and have no
  `json_object` mode: schema inference (and the last translation fallback)
  rely on the prompt and the app's JSON extraction. Only Claude models that
  accept `effort` (Opus 4.5 and later, Sonnet 4.6 and later, Haiku 5.5) are
  offered in the model dropdown.
- Settings saved before Mistral Small became the default move over once:
  Anthropic (the previous default provider) to Mistral, and Mistral Large
  (the previous Mistral default) to Mistral Small. Picking them again in
  Settings sticks; a browser that used OpenAI keeps it.
- The API keys live in `localStorage` of this origin (or `sessionStorage`
  with "Remember keys" off). Anyone with access to the browser profile can
  read them.
- Saved translations and the OCR cache stay in this browser's IndexedDB until
  cleared; they contain the document's text.
- The vision steps need a model with image input (Mistral Small 4, Claude
  Haiku 5.5 and GPT Luna have it; another Mistral model may not). If the model rejects images, the
  translation is retried text-only and the step strip says so.
- OCR results cached in the browser before this workflow (without images)
  are ignored; the file is OCR'd again once.

See [AGENTS.md](AGENTS.md) for the code map and conventions.
