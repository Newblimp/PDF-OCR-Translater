import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ANTHROPIC_KEY,
  chatStep,
  installStreamingTranslationMock,
  jsonBody,
  makePdf,
  MISTRAL_KEY,
  mockApis,
  OCR_PAGE,
  OPENAI_KEY,
  REGION_TEXT,
  systemPrompt,
  type RecordedRequest,
} from "./helpers";

const APP_HOST = "localhost:4173";
const ALLOWED_HOSTS = new Set([APP_HOST, "api.mistral.ai", "api.anthropic.com", "api.openai.com"]);

/** `json`: start with "JSON output" on in Settings (the structured text and its tabs); it is off by default. */
async function setup(page: Page, options: { json?: boolean } = {}): Promise<{ recorded: RecordedRequest[]; foreign: string[] }> {
  const recorded: RecordedRequest[] = [];
  const foreign: string[] = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).host;
    if (!ALLOWED_HOSTS.has(host)) foreign.push(req.url());
  });
  await mockApis(page, recorded);
  if (options.json) {
    await page.addInitScript(() => {
      const key = "pdf-ocr-translater.settings.v2";
      let saved: Record<string, unknown> = {};
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      } catch {
        // start from the defaults
      }
      localStorage.setItem(key, JSON.stringify({ ...saved, jsonOutput: true }));
    });
  }
  await page.goto("/");
  return { recorded, foreign };
}

/** Both keys, translating with Anthropic (Claude): the tests of Claude's requests. `enterMistralKey()` keeps the default, Mistral. */
async function enterKeys(page: Page, mistral = MISTRAL_KEY, anthropic = ANTHROPIC_KEY): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Translate with").selectOption("anthropic");
  await dialog.getByPlaceholder("Paste your Mistral key").fill(mistral);
  await dialog.getByPlaceholder("Paste your Anthropic (Claude) key").fill(anthropic);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
}

/** The Mistral key only: OCR and translation by Mistral (Mistral Small), the default. */
async function enterMistralKey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Paste your Mistral key").fill(MISTRAL_KEY);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
}

/** The shared "Show translation" switch of the OCR text, Structured text and Raw JSON tabs. */
function translationSwitch(page: Page) {
  return page.getByRole("checkbox", { name: "Show translation", exact: true });
}

/** The pipeline step a recorded chat request belongs to. */
function step(request: RecordedRequest): string {
  return chatStep(request.body);
}

const path = (request: RecordedRequest) => new URL(request.url).pathname;

/** Chat requests of any provider (Anthropic messages, OpenAI/Mistral chat completions). */
function chatRequests(recorded: RecordedRequest[]): RecordedRequest[] {
  return recorded.filter((r) => path(r) === "/v1/messages" || path(r) === "/v1/chat/completions");
}

async function loadPdf(page: Page): Promise<void> {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "office-action.pdf",
      mimeType: "application/pdf",
      buffer: makePdf("Hello patent office"),
    });
}

/** Drags a result tab onto a side (or the centre) of a view, as a user arranging split views would. */
async function dragTab(page: Page, name: string, target: Locator, side: "left" | "right" | "top" | "bottom" | "center"): Promise<void> {
  const box = (await target.boundingBox())!;
  const x = side === "left" ? 10 : side === "right" ? box.width - 10 : box.width / 2;
  const y = side === "top" ? 10 : side === "bottom" ? box.height - 10 : box.height / 2;
  await page.getByRole("tab", { name, exact: true }).dragTo(target, { targetPosition: { x, y } });
}

test("asks for both API keys once, verifies them and caches them in the browser", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKeys(page, MISTRAL_KEY, "wrong-anthropic-key");
  await expect(page.getByRole("dialog").getByText("rejected this key")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByRole("dialog").getByPlaceholder("Paste your Anthropic (Claude) key").fill(ANTHROPIC_KEY);
  await page.getByRole("dialog").getByRole("button", { name: "Save and verify" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  expect(
    recorded
      .filter((r) => path(r) === "/v1/models")
      .map((r) => r.host)
      .sort(),
  ).toEqual(["api.anthropic.com", "api.anthropic.com", "api.mistral.ai"]);
  // Anthropic takes the key in x-api-key and needs the browser CORS opt-in.
  const anthropicModels = recorded.find((r) => r.host === "api.anthropic.com" && r.headers["x-api-key"] === ANTHROPIC_KEY)!;
  expect(anthropicModels.headers).toMatchObject({ "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
  expect(anthropicModels.headers).not.toHaveProperty("authorization");
  expect(anthropicModels.url).toBe("https://api.anthropic.com/v1/models?limit=1000");

  await page.reload();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.mistral"))).toBe(MISTRAL_KEY);
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBe(ANTHROPIC_KEY);
});

test("OCR + translate: Mistral OCR, Claude Haiku 5.5 translation, browsable JSON, and no other hosts", async ({ page }) => {
  const { recorded, foreign } = await setup(page, { json: true });
  await enterKeys(page);
  await expect(page.getByText("Anthropic key verified")).toBeVisible();

  await loadPdf(page);
  await expect(page.getByRole("heading", { name: "office-action.pdf" })).toBeVisible();
  await expect(page.getByText("1 page")).toBeVisible();
  await expect(page.locator(".preview-page img")).toHaveCount(1);

  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });

  // Browsable output.
  await expect(page.getByRole("heading", { name: "Application number" })).toBeVisible();
  await expect(page.getByText("CN202310000001.2").first()).toBeVisible();
  await expect(page.locator(".field-card .prose table")).toBeVisible();
  await expect(page.locator(".field-card table.value-table")).toContainText("CN123456A");
  await expect(page.locator(".toolbar")).toContainText("Anthropic (Claude) · claude-haiku-5-5");

  // OCR tab: headers/footers separated, images gone, and the shared "Show translation" switch.
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(page.getByText("Page headers and footers kept out of the page text")).toBeVisible();
  const showTranslation = translationSwitch(page);
  await expect(showTranslation).toBeEnabled({ timeout: 20_000 }); // enabled once the per-block translations are in
  await expect(showTranslation).toBeChecked();
  await expect(page.locator(".ocr-page")).toContainText("[EN] 申请号：CN202310000001.2"); // per-block translation
  await showTranslation.uncheck();
  await expect(page.locator(".ocr-page")).toContainText("权利要求1不具备创造性");
  await expect(page.locator(".ocr-page")).toContainText("[Image: img-0.jpeg]"); // placeholder, not the raw image
  await showTranslation.check();

  // Requests: OCR went to Mistral with a base64 data URI, bounding-box images requested, headers/footers extracted.
  const ocr = recorded.find((r) => r.url.endsWith("/v1/ocr"));
  expect(ocr?.host).toBe("api.mistral.ai");
  expect(ocr!.body).toMatchObject({ model: "mistral-ocr-latest", include_image_base64: true, extract_header: true, extract_footer: true });
  expect(String((ocr!.body!["document"] as { document_url: string }).document_url)).toMatch(/^data:application\/pdf;base64,/);

  // One OCR call, asking for bounding-box images and paragraph blocks (Mistral's annotation workflow).
  const ocrCalls = recorded.filter((r) => r.url.endsWith("/v1/ocr"));
  expect(ocrCalls).toHaveLength(1);
  expect(ocrCalls[0]!.body).toMatchObject({ include_image_base64: true, include_blocks: true });
  expect(ocrCalls[0]!.body).not.toHaveProperty("document_annotation_format");

  // The strip explains the workflow.
  await page.getByRole("tab", { name: "Structured text" }).click();
  await expect(page.locator(".pipeline-strip")).toContainText("Mistral OCR: 1 page(s), 2 bounding box(es)");
  await expect(page.locator(".pipeline-strip")).toContainText("BBox annotation: 2 of 2 box(es) described by the vision model");
  await expect(page.locator(".pipeline-strip")).toContainText("from the text + 2 bounding-box image(s)");
  // The switch in the OCR tab does not need the original-language structure, so it was not requested.
  await expect(page.locator(".pipeline-strip")).toContainText("Structured text in the original language not produced yet");

  // Chat on Anthropic: schema inference (no JSON Schema), one bbox annotation per box (structured outputs), the translation and
  // the block translations; the original-language structure only on demand.
  let chats = chatRequests(recorded);
  expect(chats.every((c) => c.host === "api.anthropic.com" && path(c) === "/v1/messages")).toBe(true);
  expect(chats).toHaveLength(5);
  expect(step(chats[0]!)).toBe("infer_schema");
  expect(chats[0]!.body!["output_config"]).toEqual({ effort: "low" });
  expect(chats.map(step).sort()).toEqual(["bbox_annotation", "bbox_annotation", "block_translations", "infer_schema", "translated_document"]);

  // Switched off here, the structured text in the original language is produced once.
  await translationSwitch(page).uncheck();
  await expect(page.locator(".pipeline-strip")).toContainText("Structured text in the original language: filled by", { timeout: 20_000 });
  await translationSwitch(page).check();
  await translationSwitch(page).uncheck();
  chats = chatRequests(recorded);
  expect(chats.map(step).filter((s) => s === "original_document")).toHaveLength(1);
  expect(step(chats.at(-1)!)).toBe("original_document");
  const bboxCalls = chats.filter((c) => step(c) === "bbox_annotation");
  expect(bboxCalls).toHaveLength(2);
  const bboxContent = (bboxCalls[0]!.body!["messages"] as Array<{ role: string; content: unknown }>)[0]!.content as Array<{ type: string }>;
  expect(bboxContent.some((p) => p.type === "image")).toBe(true);
  const translate = chats.find((c) => step(c) === "translated_document")!.body!;
  expect(translate).toMatchObject({
    model: "claude-haiku-5-5",
    max_tokens: 64_000,
    stream: true,
    output_config: { effort: "low", format: { type: "json_schema" } },
  });
  expect(translate).not.toHaveProperty("temperature");
  expect(translate).not.toHaveProperty("thinking");
  expect(typeof translate["system"]).toBe("string");
  // Document annotation input: the document first, then the bounding-box images (ids referenced in the text), then the task.
  const messages = translate["messages"] as Array<{ role: string; content: unknown }>;
  expect(messages.map((m) => m.role)).toEqual(["user"]);
  const userContent = messages[0]!.content as Array<{
    type: string;
    text?: string;
    source?: { type: string; media_type: string; data: string };
    cache_control?: unknown;
  }>;
  expect(Array.isArray(userContent)).toBe(true);
  const userMessage = userContent[0]!.text!;
  expect(userContent.at(-1)!.text).toMatch(/^Task: /);
  // Prompt caching: the breakpoint sits on the last image, the end of the prefix shared with the original-language structure.
  expect(userContent.filter((p) => p.cache_control)).toEqual([expect.objectContaining({ type: "image", cache_control: { type: "ephemeral" } })]);
  const original = chats.find((c) => step(c) === "original_document")!.body!;
  expect(original["system"]).toBe(translate["system"]);
  expect((original["messages"] as Array<{ content: unknown[] }>)[0]!.content.slice(0, -1)).toEqual(userContent.slice(0, -1));
  expect(userMessage).toContain("权利要求1不具备创造性");
  expect(userMessage).toContain("[Image: img-0.jpeg]");
  expect(userMessage).toContain('"img-0.jpeg", "img-1.jpeg"');
  expect(userMessage).not.toContain("国家知识产权局"); // header excluded
  expect(userMessage).not.toContain("第 1 页"); // footer excluded
  expect(userContent.filter((p) => p.type === "image")).toHaveLength(2);
  expect(userContent.find((p) => p.type === "image")?.source).toMatchObject({ type: "base64", media_type: "image/png" });
  expect(foreign).toEqual([]);
});

test("sections collapse and expand individually, in bulk, and via the outline", async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });

  const summary = page.locator("#field-summary");
  await expect(summary.locator(".field-body")).toBeVisible();
  await summary.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible(); // heading semantics kept
  await expect(summary.locator(".field-body")).toHaveCount(0);
  await expect(summary.locator(".field-preview")).toContainText("lacks inventive step");

  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(page.locator(".field-card .field-body")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.locator("#field-body_sections .field-body").first()).toBeVisible();

  await page.getByRole("button", { name: "Collapse all" }).click();
  await page.locator(".outline-link", { hasText: "Cited references" }).click();
  await expect(page.locator("#field-cited_references .field-body")).toBeVisible();
  await expect(page.locator("#field-summary .field-body")).toHaveCount(0);
});

test("German toggle changes the target language of the next translation", async ({ page }) => {
  const { recorded } = await setup(page, { json: true });
  await enterKeys(page);
  await page.locator(".settings > summary").click();
  await page.getByRole("radio", { name: "German" }).click();
  await expect(page.getByRole("radio", { name: "German" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("申请号：CN202310000001.2\n\n权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Erster Prüfungsbescheid")).toBeVisible();
  await expect(page.locator(".toolbar")).toContainText("→ German");
  // Pasted text: no OCR, no bounding boxes, and the UI says so.
  await expect(page.locator(".pipeline-strip")).toContainText("Text input (no OCR)");
  await expect(page.locator(".pipeline-strip")).toContainText("BBox annotation skipped");
  await expect(page.getByRole("tab", { name: "Bounding boxes", exact: true })).toHaveCount(0);

  const translate = chatRequests(recorded).find((r) => step(r) === "translated_document")!.body!;
  expect(systemPrompt(translate)).toContain("Target language of the translation: German");
  expect(recorded.some((r) => r.url.endsWith("/v1/ocr"))).toBe(false);

  await page.reload();
  await page.locator(".settings > summary").click();
  await expect(page.getByRole("radio", { name: "German" })).toHaveAttribute("aria-checked", "true");
});

test('the structured text and the OCR text follow one "Show translation" switch', async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });

  // Translated by default.
  await expect(page.locator(".fields")).toContainText("The examiner finds claim 1 lacks inventive step.");
  const toggle = translationSwitch(page);
  await expect(toggle).toBeChecked();

  // Switched off, the same fields hold the document's own wording.
  await toggle.uncheck();
  await expect(page.locator(".fields")).toContainText("审查员认为权利要求1不具备创造性。", { timeout: 20_000 });
  await expect(page.locator(".toolbar").first()).toContainText("original language");

  // The switch is shared with the OCR text tab and the raw JSON.
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(translationSwitch(page)).not.toBeChecked();
  await expect(page.locator(".ocr-page")).toContainText("权利要求1不具备创造性");
  await page.getByRole("tab", { name: "Raw JSON" }).click();
  await expect(page.locator(".code-block")).toContainText("第一次审查意见通知书");

  // And back: the translation again, everywhere.
  await translationSwitch(page).check();
  await page.getByRole("tab", { name: "Structured text" }).click();
  await expect(page.locator(".fields")).toContainText("The examiner finds claim 1 lacks inventive step.");
});

test("theme switch forces dark or light and persists; system removes the override", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  const html = page.locator("html");
  // Dark is the default, as in refcheck.
  await expect(html).toHaveAttribute("data-theme", "dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.getByRole("radio", { name: "Light theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkBg).not.toBe(lightBg);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(lightBg);

  await page.getByRole("radio", { name: "System theme" }).click();
  await expect(html).not.toHaveAttribute("data-theme", /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(darkBg);

  await page.getByRole("radio", { name: "Dark theme" }).click();
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // theme-init.js applied the attribute before the bundle ran.
  await page.goto("/", { waitUntil: "commit" });
  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "dark");
});

test("Mistral is the default: one key, Mistral Small translates block by block, and nothing goes anywhere else", async ({ page }) => {
  const { recorded, foreign } = await setup(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Translate with")).toHaveValue("mistral");
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeDisabled();
  await dialog.getByPlaceholder("Paste your Mistral key").fill(MISTRAL_KEY);
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeEnabled(); // the Anthropic and OpenAI keys are optional
  await dialog.getByRole("button", { name: "Save and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  await expect(page.getByText(/Anthropic key/)).toHaveCount(0);
  await expect(page.locator(".header-title p")).toHaveText("OCR and translation by Mistral. Runs in your browser; documents go only to api.mistral.ai.");

  // Settings start closed; the target language (English or German) and the glossary sit above them.
  expect(await page.locator(".settings").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  const options = page.getByRole("region", { name: "Translation options" });
  await expect(options.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
  await expect(options.getByLabel("Glossary")).toBeVisible();

  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("权利要求1不具备创造性。");
  await expect(page.getByText(/estimate|≈ \$/)).toHaveCount(0); // no cost hint
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".ocr-page")).toContainText("[EN] 权利要求1不具备创造性。", { timeout: 20_000 });
  expect(recorded.every((r) => r.host === "api.mistral.ai")).toBe(true);
  const chats = chatRequests(recorded);
  expect(chats.map(step)).toEqual(["block_translations"]);
  expect(chats[0]!.body).toMatchObject({
    model: "mistral-small-latest",
    reasoning_effort: "none", // the default
    response_format: { type: "json_schema", json_schema: { name: "block_translations", strict: true } },
  });
  expect(foreign).toEqual([]);

  // The reasoning effort offers what Mistral Small takes: "none" and "high".
  await page.locator(".settings > summary").click();
  const effort = page.getByLabel("Reasoning effort");
  await expect(effort).toHaveValue("none");
  await expect(effort.locator("option")).toHaveText(["none (fastest)", "high"]);
  await effort.selectOption("high");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect.poll(() => chatRequests(recorded).length).toBe(2);
  expect(chatRequests(recorded)[1]!.body).toMatchObject({ reasoning_effort: "high" });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();

  // Switching to OpenAI without a key asks for it immediately; the dialog can be cancelled. (The settings are still open.)
  await page.getByLabel("Translation provider").selectOption("openai");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await page.getByRole("dialog").getByLabel("Translate with").selectOption("mistral");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("a rejected required key keeps the dialog open and is never used for requests", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKeys(page, "wrong-mistral-key", ANTHROPIC_KEY);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("rejected this key")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await dialog.getByPlaceholder("Paste your Mistral key").fill(MISTRAL_KEY);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
  await expect(dialog).toBeHidden();
  expect(recorded.filter((r) => r.host === "api.mistral.ai" && r.headers["authorization"] === "Bearer wrong-mistral-key").length).toBe(1);
});

test("Forget during an in-flight verification does not resurrect the keys", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  // Slow down the model list so the reload-time verification is still pending when we click Forget.
  await page.route("https://api.mistral.ai/v1/models", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
  await page.route(
    (url) => url.host === "api.anthropic.com" && url.pathname === "/v1/models",
    async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fallback();
    },
  );
  await page.reload();
  await expect(page.getByText("Mistral key verifying…")).toBeVisible();
  await page.getByRole("button", { name: "Forget" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.mistral"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBeNull();
  await expect(page.getByText(/key verified/)).toHaveCount(0);
});

test("with the JSON output, Mistral Small infers the JSON format and fills it", async ({ page }) => {
  const { recorded } = await setup(page, { json: true });
  await enterMistralKey(page);
  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".toolbar").first()).toContainText("Mistral · mistral-small-latest");
  const chats = chatRequests(recorded);
  expect(chats.map((c) => c.host)).toEqual(["api.mistral.ai", "api.mistral.ai"]);
  expect(chats.map(step)).toEqual(["infer_schema", "translated_document"]);
  expect(chats[1]!.body).toMatchObject({ model: "mistral-small-latest", temperature: 0.2, reasoning_effort: "none" });
});

test("OpenAI (GPT Luna) can still be chosen as translation provider", async ({ page }) => {
  const { recorded } = await setup(page, { json: true });
  await enterKeys(page);
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  await page.locator(".settings > summary").click();
  await page.getByLabel("Translation provider").selectOption("openai");
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Paste your OpenAI (GPT Luna) key").fill(OPENAI_KEY);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("OpenAI key verified")).toBeVisible();

  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".toolbar")).toContainText("OpenAI (GPT Luna) · gpt-6-luna");
  const chats = chatRequests(recorded);
  expect(chats.map((c) => c.host)).toEqual(["api.openai.com", "api.openai.com"]);
  expect(chats.map(step)).toEqual(["infer_schema", "translated_document"]);
  expect(chats[1]!.body).toMatchObject({
    model: "gpt-6-luna",
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "none",
    response_format: { type: "json_schema", json_schema: { name: "translated_document", strict: true } },
  });
  expect(chats[1]!.body).not.toHaveProperty("temperature");
});

test("bounding boxes are drawn over the page with the vision model's descriptions", async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".pipeline-strip")).toBeVisible();

  await page.getByRole("tab", { name: "Bounding boxes", exact: true }).click();
  await expect(page.locator(".bbox-stage img")).toBeVisible(); // page rendered by pdf.js
  await expect(page.locator(".bbox-box")).toHaveCount(9); // 7 blocks + 2 image boxes
  await page.getByLabel("Paragraph blocks").uncheck();
  await expect(page.locator(".bbox-box")).toHaveCount(2);
  const box = page.getByRole("button", { name: "Image box img-0.jpeg" });
  const style = (await box.getAttribute("style")) ?? "";
  expect(style).toMatch(/left: ?5\.88/); // 100 / 1700 of the page width
  expect(style).toMatch(/top: ?13\.63/); // 300 / 2200 of the page height
  await box.click();
  await expect(page.locator(".bbox-detail")).toContainText("stamp");
  await expect(page.locator(".bbox-detail")).toContainText("China National Intellectual Property Administration");
  await expect(page.locator(".bbox-detail img")).toBeVisible();
  await page.getByLabel("Image boxes (sent to the vision model)").uncheck();
  await expect(page.locator(".bbox-box")).toHaveCount(0);

  // Clicking a text block shows its translation above the original.
  await page.getByLabel("Paragraph blocks").check();
  await page.getByRole("button", { name: "text block 3" }).click();
  const detail = page.locator(".bbox-detail");
  await expect(detail.locator(".block-translation")).toContainText("[EN] 申请号：CN202310000001.2");
  await expect(detail.locator(".text-preview")).toContainText("申请号：CN202310000001.2");
  const translationBox = await detail.locator(".block-translation").boundingBox();
  const originalBox = await detail.locator(".text-preview").boundingBox();
  expect(translationBox!.y).toBeLessThan(originalBox!.y);
});

test("pages are pre-rendered in the background so navigating is instant", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "three-pages.pdf",
      mimeType: "application/pdf",
      buffer: makePdf("Page one", ["Page two", "Page three"]),
    });
  await expect(page.getByText("3 pages")).toBeVisible();
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "Bounding boxes", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Bounding boxes", exact: true }).click();
  await expect(page.locator(".bbox-stage img")).toBeVisible();
  // All three pages render in the background without navigating.
  await expect(page.locator("[data-rendered-pages]")).toHaveAttribute("data-rendered-pages", "3", { timeout: 20_000 });
  // OCR covered all pages (no selection): navigation shows the next page immediately.
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Rendering page…")).toHaveCount(0);
  await expect(page.locator(".bbox-stage img")).toHaveAttribute("alt", "Page 2");
});

test("only the selected pages are sent to OCR", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKeys(page);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "three-pages.pdf",
      mimeType: "application/pdf",
      buffer: makePdf("Page one", ["Page two", "Page three"]),
    });
  await expect(page.getByText("3 pages")).toBeVisible();
  const pagesInput = page.getByLabel("Pages to OCR");
  await pagesInput.fill("4");
  await expect(page.getByText("Page 4 does not exist")).toBeVisible();
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("alert")).toContainText("Pages to OCR");
  await page.getByRole("alert").getByRole("button", { name: "Dismiss error" }).click();

  await pagesInput.fill("3, 1");
  await expect(page.getByText("2 page(s) selected: 1, 3")).toBeVisible();
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toBeVisible({ timeout: 20_000 });
  const ocr = recorded.find((r) => r.url.endsWith("/v1/ocr"));
  expect(ocr!.body!["pages"]).toEqual([0, 2]);
  await expect(page.locator(".ocr-page")).toHaveCount(2);
  await expect(page.locator("#ocr-page-3")).toBeVisible();
});

test("fields can be hidden and shown individually and in bulk", async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".pipeline-strip")).toBeVisible();
  await expect(page.locator(".fields > .field-card")).toHaveCount(5);

  await page.getByRole("button", { name: "Hide Summary" }).click();
  await expect(page.locator("#field-summary")).toHaveCount(0);
  await expect(page.locator(".fields > .field-card")).toHaveCount(4);
  await expect(page.getByLabel("Show Summary")).not.toBeChecked();

  await page.getByLabel("Show Summary").check();
  await expect(page.locator("#field-summary")).toBeVisible();

  await page.getByRole("button", { name: "Hide all" }).click();
  await expect(page.locator(".fields > .field-card")).toHaveCount(0);
  await expect(page.getByText("All fields are hidden")).toBeVisible();
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.locator(".fields > .field-card")).toHaveCount(5);
});

test("the translation is shown live while it streams, even when another tab was active", async ({ page }) => {
  await installStreamingTranslationMock(page, 200, 8);
  const { recorded } = await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  // "OCR only" leaves the OCR tab active; a following translation must still show its stream.
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await page.getByRole("button", { name: "Translate", exact: true }).click();

  // While the job is still running, partial output is visible and grows.
  const panel = page.locator(".stream-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  const first = (await panel.locator(".stream-tail").textContent()) ?? "";
  await expect(panel.getByRole("heading", { name: "Document type", exact: true })).toBeVisible();
  await expect.poll(async () => ((await panel.locator(".stream-tail").textContent()) ?? "").length, { timeout: 5_000 }).toBeGreaterThan(first.length);

  // Then the final, parsed translation replaces it.
  await expect(panel).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".pipeline-strip")).toBeVisible();
  await expect(page.getByText("CN202310000001.2").first()).toBeVisible();
  // The SDK used the patched window.fetch: the streamed request never reached the route mock.
  expect(chatRequests(recorded).map(step)).not.toContain("translated_document");
});

test("cancelling during streaming stops cleanly", async ({ page }) => {
  await installStreamingTranslationMock(page, 400, 10);
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".stream-panel")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".stream-panel")).toHaveCount(0);
});

test("cancel stops a running job without an error", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await page.route("https://api.mistral.ai/v1/ocr", async (route) => {
    await new Promise((r) => setTimeout(r, 5_000));
    await route.abort();
  });
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "a.pdf", mimeType: "application/pdf", buffer: makePdf("x") });
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "OCR only" })).toBeEnabled();
});

/** Answer the Anthropic requests of one pipeline step with an error (registered after the mocks, so it takes precedence). */
async function failStep(page: Page, failing: string, status: number, times = Infinity): Promise<{ failed: () => number }> {
  let failed = 0;
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    if (chatStep(jsonBody(route.request())) !== failing || failed >= times) return route.fallback();
    failed++;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "invalid_request_error", message: `mocked ${status}` } }),
    });
  });
  return { failed: () => failed };
}

test("a failing follow-up step leaves a warning on the translation instead of failing the job", async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await failStep(page, "block_translations", 401);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".pipeline-strip")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Some follow-up steps failed; the translation itself is complete.")).toBeVisible();
  await expect(page.getByText(/Block translations failed: HTTP 401/)).toBeVisible();
  await expect(page.getByText("The examiner finds claim 1 lacks inventive step.")).toBeVisible();
});

test("blocks that came back without a translation can be retried", async ({ page }) => {
  const { recorded } = await setup(page, { json: true });
  await enterKeys(page);
  const failing = await failStep(page, "block_translations", 400, 1);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".pipeline-strip")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  // A later change of the target language does not leak into the retry: it runs in the translation's own language.
  await page.locator(".settings > summary").click();
  await page.getByRole("radio", { name: "German" }).click();
  await page.getByRole("tab", { name: "OCR text" }).click();
  await page.getByRole("button", { name: "Translate the blocks now" }).click();
  await expect(page.locator(".ocr-page")).toContainText("[EN] 申请号：CN202310000001.2", { timeout: 20_000 });
  // The first batch was rejected (it never reached the recording mock); the retry went through.
  expect(failing.failed()).toBe(1);
  expect(chatRequests(recorded).filter((r) => step(r) === "block_translations")).toHaveLength(1);
});

test("OCR + Translate reuses the OCR result already loaded, and results are kept in this browser", async ({ page }) => {
  const { recorded } = await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".pipeline-strip")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  expect(recorded.filter((r) => r.url.endsWith("/v1/ocr"))).toHaveLength(1);

  // After a reload the translation is listed, and loading the same file brings back OCR and translation without any request.
  await page.reload();
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  const history = page.locator(".history");
  await expect(history).toContainText("Recent translations");
  await history.locator("summary").click();
  await expect(history).toContainText("office-action.pdf");
  const before = recorded.length;
  await loadPdf(page);
  await expect(page.getByText("OCR result from this browser's cache")).toBeVisible();
  // The long badge wraps inside the narrow document card rather than running past its border.
  const badge = (await page.locator(".document-card .badge").boundingBox())!;
  const card = (await page.locator(".document-card").boundingBox())!;
  expect(badge.x + badge.width).toBeLessThanOrEqual(card.x + card.width);
  await expect(page.getByText("The examiner finds claim 1 lacks inventive step.")).toBeVisible();
  await expect(page.locator(".toolbar").first()).toContainText("saved in this browser");
  expect(recorded.slice(before).filter((r) => path(r) !== "/v1/models")).toEqual([]);

  // Reopening from the list works without the document, too.
  await page.getByRole("button", { name: "Remove" }).click();
  await history.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("The examiner finds claim 1 lacks inventive step.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "OCR text" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Translate", exact: true })).toBeEnabled();
});

test("the glossary and other target languages reach the translation prompt", async ({ page }) => {
  const { recorded } = await setup(page, { json: true });
  await enterKeys(page);
  await page.locator(".settings > summary").click();
  await page.getByLabel("Target language (all languages)").selectOption("French");
  await page.getByLabel("Glossary").fill("审查员 = examinateur\n# a comment\n驳回 = rejet");
  await page.getByLabel("Glossary").blur();
  await expect(page.getByText("2 term(s) the translation must use.")).toBeVisible();
  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("审查员认为权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  const translate = chatRequests(recorded).find((r) => step(r) === "translated_document")!.body!;
  expect(systemPrompt(translate)).toContain("Target language of the translation: French.");
  expect(systemPrompt(translate)).toContain("- 审查员 → examinateur\n- 驳回 → rejet");
});

test("keys can be kept for the session only", async ({ page }) => {
  await setup(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Remember keys in this browser/).uncheck();
  await enterKeys(page);
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBe(ANTHROPIC_KEY);
  // Turning it back on moves the keys to localStorage.
  await page.getByRole("button", { name: "Keys" }).click();
  await page
    .getByRole("dialog")
    .getByLabel(/Remember keys in this browser/)
    .check();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBe(ANTHROPIC_KEY);
  expect(await page.evaluate(() => sessionStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBeNull();
});

test("the bilingual export holds the translation next to the original", async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".pipeline-strip")).toBeVisible({ timeout: 20_000 });
  await translationSwitch(page).uncheck();
  await expect(page.locator(".fields")).toContainText("审查员认为权利要求1不具备创造性。", { timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download bilingual HTML" }).click()]);
  expect(download.suggestedFilename()).toBe("office-action.bilingual.html");
  const html = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
  expect(html).toContain("The examiner finds claim 1 lacks inventive step.");
  expect(html).toContain("审查员认为权利要求1不具备创造性。");
  expect(html).toContain("<h2>Page by page</h2>");
  expect(html).toContain("[EN] 申请号：CN202310000001.2");
  expect(html).not.toMatch(/<script/i);
});

test("result tabs are arranged in split views by drag and drop, and the arrangement is kept", async ({ page }) => {
  await setup(page, { json: true });
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.locator(".pipeline-strip")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Reset the layout" })).toHaveCount(0);

  // "OCR text" dropped on the right edge of the structured text: both side by side.
  const structured = page.locator("#dock-panel-structured");
  const ocr = page.locator("#dock-panel-ocr");
  await dragTab(page, "OCR text", structured, "right");
  await expect(page.getByRole("tablist")).toHaveCount(2);
  await expect(structured.locator(".pipeline-strip")).toBeVisible();
  await expect(ocr.locator(".ocr-page")).toBeVisible();
  let left = (await structured.boundingBox())!;
  let right = (await ocr.boundingBox())!;
  expect(right.x).toBeGreaterThan(left.x + left.width);
  expect(Math.abs(right.y - left.y)).toBeLessThan(2);

  // "Bounding boxes" below the OCR text; the OCR view keeps its state (it is not rebuilt).
  await ocr.getByLabel("Render Markdown").uncheck();
  await dragTab(page, "Bounding boxes", ocr, "bottom");
  await expect(page.getByRole("tablist")).toHaveCount(3);
  const bboxes = page.locator("#dock-panel-bboxes");
  await expect(bboxes.locator(".bbox-stage img")).toBeVisible();
  const top = (await ocr.boundingBox())!;
  const bottom = (await bboxes.boundingBox())!;
  expect(bottom.y).toBeGreaterThan(top.y + top.height);
  expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
  await expect(ocr.getByLabel("Render Markdown")).not.toBeChecked();

  // Within a tab bar, a tab dropped on the left half of another goes before it.
  await page.getByRole("tab", { name: "Raw JSON" }).dragTo(page.getByRole("tab", { name: "Structured text" }), { targetPosition: { x: 4, y: 10 } });
  await expect(page.getByRole("tablist").first().getByRole("tab")).toHaveText(["Edit bounding boxes", "Raw JSON", "Structured text", "JSON format"], {
    ignoreCase: true,
  });
  await expect(page.getByRole("tab", { name: "Raw JSON" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Structured text" }).click();

  // The splitter between the columns resizes them, by pointer and by keyboard.
  const splitter = page.getByRole("separator").first();
  const handle = (await splitter.boundingBox())!;
  const width = (await structured.boundingBox())!.width;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 100, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await structured.boundingBox())!.width).toBeLessThan(width - 90);
  expect((await structured.boundingBox())!.width).toBeGreaterThan(width - 110);
  const narrowed = (await structured.boundingBox())!.width;
  await splitter.press("ArrowRight");
  await expect.poll(async () => (await structured.boundingBox())!.width).toBeGreaterThan(narrowed + 30);

  // Kept after a reload.
  await page.reload();
  await expect(page.getByText("Anthropic key verified")).toBeVisible();
  const history = page.locator(".history");
  await history.locator("summary").click();
  await history.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("tablist")).toHaveCount(3);
  left = (await structured.boundingBox())!;
  right = (await ocr.boundingBox())!;
  expect(right.x).toBeGreaterThan(left.x + left.width);

  // Dropped in the centre of a view, a tab joins that group; the empty group closes.
  await dragTab(page, "OCR text", structured, "center");
  await expect(page.getByRole("tablist")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true");

  // The split buttons do the same without dragging, and one click puts everything back in one group.
  await page.getByRole("button", { name: "Move OCR text to a new group on the right" }).click();
  await expect(page.getByRole("tablist")).toHaveCount(3);
  await page.getByRole("button", { name: "Reset the layout" }).click();
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("tablist").getByRole("tab")).toHaveText(
    ["Bounding boxes", "Edit bounding boxes", "OCR text", "Structured text", "JSON format", "Raw JSON"],
    {
      ignoreCase: true,
    },
  );
});

test("the OCR text is shown beside the PDF pages, with the scrolling of both locked together", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "long.pdf",
      mimeType: "application/pdf",
      buffer: makePdf("Page one", ["Page two", "Page three", "Page four", "Page five", "Page six"]),
    });
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(page.getByRole("checkbox", { name: "Lock scrolling" })).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Show PDF" }).check();
  const pdf = page.locator(".ocr-pdf-pages");
  const text = page.locator(".ocr-pages");
  await expect(pdf.locator("img")).toHaveCount(6, { timeout: 20_000 }); // rendered by pdf.js
  const pdfBox = (await pdf.boundingBox())!;
  const textBox = (await text.boundingBox())!;
  expect(pdfBox.x + pdfBox.width).toBeLessThan(textBox.x); // the pages on the left, the text on the right
  const lock = page.getByRole("checkbox", { name: "Lock scrolling" });
  await expect(lock).toBeChecked();

  const scrollTo = (column: typeof pdf, top: number | "end") =>
    column.evaluate((el, to) => {
      el.scrollTop = to === "end" ? el.scrollHeight : to;
    }, top);
  const scrolled = (column: typeof pdf) => column.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  /** The page (0-based) at the middle of a column's view. */
  const pageInView = (column: typeof pdf) =>
    column.evaluate((el) => {
      const middle = el.getBoundingClientRect().top + el.clientHeight / 2;
      const pages = Array.from(el.querySelectorAll<HTMLElement>(":scope > [data-page]"));
      return Number(pages.filter((p) => p.getBoundingClientRect().top <= middle).pop()?.dataset["page"] ?? -1);
    });

  // Scrolling the text scrolls the pages to the same page, and both reach their end together.
  expect((await scrolled(text)).max).toBeGreaterThan(200);
  await text.evaluate((el) => {
    const page4 = el.querySelector<HTMLElement>('[data-page="3"]')!;
    el.scrollTop += page4.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
  });
  await expect.poll(() => pageInView(pdf)).toBe(await pageInView(text));
  await scrollTo(text, "end");
  await expect
    .poll(async () => {
      const s = await scrolled(pdf);
      return s.max - s.top;
    })
    .toBeLessThan(2);

  // And the other way round.
  await scrollTo(pdf, 0);
  await expect.poll(async () => (await scrolled(text)).top).toBeLessThan(2);

  // Locked, neither column can bounce past its ends on its own (elastic overscroll); unlocked, each may.
  const overscroll = (column: Locator) => column.evaluate((el) => getComputedStyle(el).overscrollBehaviorY);
  expect([await overscroll(pdf), await overscroll(text)]).toEqual(["none", "none"]);

  // Unlocked, each column scrolls on its own; locking again lines the pages up with the text.
  await lock.uncheck();
  expect([await overscroll(pdf), await overscroll(text)]).toEqual(["contain", "contain"]);
  await scrollTo(text, "end");
  await page.waitForTimeout(100);
  expect((await scrolled(pdf)).top).toBe(0);
  await lock.check();
  await expect
    .poll(async () => {
      const s = await scrolled(pdf);
      return s.max - s.top;
    })
    .toBeLessThan(2);

  // Matching the page layout makes the text pages as tall as the PDF's; the text follows the pages it sits beside.
  await page.getByRole("checkbox", { name: "Match page layout" }).check();
  await expect(text.locator(".ocr-sheet")).toHaveCount(6);
  await expect.poll(() => pageInView(text)).toBe(await pageInView(pdf));
  await text.evaluate((el) => {
    const page4 = el.querySelector<HTMLElement>('[data-page="3"]')!;
    el.scrollTop += page4.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
  });
  await expect.poll(() => pageInView(pdf)).toBe(3);
  await expect.poll(async () => Math.abs((await scrolled(pdf)).top - (await scrolled(text)).top)).toBeLessThan(3);
  // Picking blocks on the pages keeps the scrolling locked.
  await page.getByRole("checkbox", { name: "Select blocks on the PDF" }).check();
  await pdf
    .locator('[data-page="3"]')
    .getByRole("button", { name: /^title block 2/ })
    .click();
  await expect(text.locator('[data-page="3"] [data-type="title"]')).toHaveCount(0);
  await expect(text.locator('[data-page="2"] [data-type="title"]')).toHaveCount(1);
  await scrollTo(pdf, 0);
  await expect.poll(async () => (await scrolled(text)).top).toBeLessThan(2);
  await page.getByRole("checkbox", { name: "Match page layout" }).uncheck();

  // Switched off, the text is back on its own.
  await page.getByRole("checkbox", { name: "Show PDF" }).uncheck();
  await expect(pdf).toHaveCount(0);
  await expect(text.locator(".ocr-page")).toHaveCount(6);
});

test("the side panel folds into a rail that shows a running job, and stays folded after a reload", async ({ page }) => {
  await setup(page);
  await enterMistralKey(page);
  await page.route("https://api.mistral.ai/v1/ocr", async (route) => {
    await new Promise((r) => setTimeout(r, 5_000));
    await route.abort();
  });
  await loadPdf(page);
  const results = page.getByRole("region", { name: "Results" });
  const width = (await results.boundingBox())!.width;
  await page.getByRole("button", { name: "OCR only" }).click();

  // The button that folds the panel is part of the panel, not of the header.
  await expect(page.locator("header").getByRole("button", { name: "Hide the side panel" })).toHaveCount(0);
  await page.getByRole("region", { name: "Input" }).getByRole("button", { name: "Hide the side panel" }).click();
  await expect(page.getByRole("button", { name: "Translate", exact: true })).toBeHidden();
  await expect.poll(async () => (await results.boundingBox())!.width).toBeGreaterThan(width + 200);
  const rail = page.locator(".side-rail");
  await expect(rail.getByRole("status")).toContainText("Running");
  await rail.getByRole("button", { name: "Cancel the running job" }).click();
  await expect(rail.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  await expect(page.getByRole("button", { name: "…or paste text to translate" })).toBeHidden();
  await rail.getByRole("button", { name: "Show the side panel" }).click();
  await expect(page.getByRole("button", { name: "…or paste text to translate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide the side panel" })).toHaveAttribute("aria-expanded", "true");
});

test("without the JSON output the OCR text is translated block by block: no JSON format, no JSON tabs", async ({ page }) => {
  const { recorded, foreign } = await setup(page);
  await enterMistralKey(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden({ timeout: 20_000 });

  const text = page.locator(".ocr-page");
  await expect(text).toContainText("[EN] 第一次审查意见通知书");
  await expect(text).toContainText("[EN] 权利要求1不具备创造性。");
  await expect(text.locator(".ocr-figure img")).toHaveCount(2); // the cropped images, where they are in the text
  await expect(text).not.toContainText("国家知识产权局"); // page headers are left out by default
  await expect(page.locator(".toolbar").first()).toContainText("translated into English per text block");
  for (const tab of ["Structured text", "JSON format", "Raw JSON"]) await expect(page.getByRole("tab", { name: tab })).toHaveCount(0);

  // Only the bounding-box descriptions and the block translations: no schema inference, no document annotation.
  const chats = chatRequests(recorded);
  expect(chats.map(step).sort()).toEqual(["bbox_annotation", "bbox_annotation", "block_translations"]);
  expect(chats.every((c) => c.host === "api.mistral.ai" && c.body?.["model"] === "mistral-small-latest")).toBe(true);
  const sent = JSON.stringify(chats.find((c) => step(c) === "block_translations")!.body);
  expect(sent).toContain("权利要求1不具备创造性");
  expect(sent).not.toContain("国家知识产权局"); // header
  expect(sent).not.toContain("第 1 页"); // footer
  expect(foreign).toEqual([]);

  // The JSON settings are there only with the JSON output on.
  await page.locator(".settings > summary").click();
  await expect(page.getByText("JSON format of the translation")).toHaveCount(0);
  await page.getByLabel(/Fill a JSON format with the translation/).check();
  await expect(page.getByText("JSON format of the translation")).toBeVisible();
  await expect(page.getByLabel("Stream the translation (shows progress while it is generated)")).toBeVisible();
  // This translation filled no JSON format, so the JSON tabs stay away.
  await expect(page.getByRole("tab", { name: "Structured text" })).toHaveCount(0);
});

test("a page the OCR returns without blocks is translated as one block", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterMistralKey(page);
  // An OCR model or request without paragraph blocks: only the page Markdown.
  await page.route("https://api.mistral.ai/v1/ocr", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ model: "mistral-ocr-latest", pages: [{ ...OCR_PAGE, blocks: [] }], usage_info: { pages_processed: 1, doc_size_bytes: 1234 } }),
    }),
  );
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".ocr-page")).toContainText("[EN] # 第一次审查意见通知书");
  await expect(page.locator(".ocr-block-untranslated")).toHaveCount(0);
  const sent = JSON.stringify(chatRequests(recorded).find((c) => step(c) === "block_translations")!.body);
  expect(sent).toContain("0:page");
});

test("block types and single blocks are left out of the OCR text (picked on the PDF), and the page layout can be matched", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterMistralKey(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  const text = page.locator(".ocr-pages");

  // By block type: headers and footers are off by default.
  const header = page.getByRole("checkbox", { name: "header blocks (1)" });
  await expect(header).not.toBeChecked();
  await header.check();
  await expect(text).toContainText("国家知识产权局");
  await header.uncheck();
  await expect(text).not.toContainText("国家知识产权局");
  await page.getByRole("checkbox", { name: "image blocks (2)" }).uncheck();
  await expect(text.locator(".ocr-figure")).toHaveCount(0);

  // One by one, on the page beside the text.
  await page.getByRole("checkbox", { name: "Show PDF" }).check();
  await page.getByRole("checkbox", { name: "Select blocks on the PDF" }).check();
  const pdf = page.locator(".ocr-pdf-pages");
  await expect(pdf.getByRole("button", { name: /^header block 1/ })).toBeDisabled(); // left out with its type
  const number = pdf.getByRole("button", { name: /^text block 3: 申请号/ });
  await expect(number).toHaveAttribute("aria-pressed", "true");
  await number.hover();
  await expect(text.locator(".ocr-block-hot")).toContainText("申请号");
  await number.click();
  await expect(number).toHaveAttribute("aria-pressed", "false");
  await expect(text).not.toContainText("申请号");
  await expect(page.getByText("1 block(s) left out one by one")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download .md" }).click()]);
  const markdown = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
  expect(markdown).toBe("第一次审查意见通知书\n\n权利要求1不具备创造性。");

  // Only what is in the text is translated.
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(text).toContainText("[EN] 权利要求1不具备创造性。", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  const first = JSON.stringify(chatRequests(recorded).find((c) => step(c) === "block_translations")!.body);
  expect(first).toContain("第一次审查意见通知书");
  expect(first).not.toContain("申请号");
  // Taken back, the block is shown untranslated until it is translated on its own.
  await page.getByRole("button", { name: "Take them all back" }).click();
  await expect(number).toHaveAttribute("aria-pressed", "true");
  await expect(text).toContainText("申请号：CN202310000001.2");
  await expect(page.getByText("1 block(s) have no translation")).toBeVisible();
  await page.getByRole("button", { name: "Translate them" }).click();
  await expect(text).toContainText("[EN] 申请号：CN202310000001.2", { timeout: 20_000 });
  const blockCalls = chatRequests(recorded).filter((c) => step(c) === "block_translations");
  expect(blockCalls).toHaveLength(2);
  expect(JSON.stringify(blockCalls[1]!.body)).toContain("申请号");
  expect(JSON.stringify(blockCalls[1]!.body)).not.toContain("第一次审查意见通知书");

  // The page layout: each block where it is on the page, its text sized to fit, on a sheet shaped like the page.
  await page.getByRole("checkbox", { name: "Match page layout" }).check();
  const sheet = text.locator(".ocr-sheet");
  await expect(sheet).toHaveCount(1);
  const title = sheet.locator('[data-type="title"]');
  expect(await title.getAttribute("style")).toMatch(/left: ?5\.88/); // 100 / 1700 of the page width
  await expect(title).toHaveAttribute("data-fitted", /^translated\|/);
  expect(await title.evaluate((el) => (el.firstElementChild as HTMLElement).offsetHeight <= el.clientHeight + 1)).toBe(true);
  expect(await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(6);
  const sheetBox = (await sheet.boundingBox())!;
  const pageBox = (await pdf.locator(".ocr-pdf-sheet").boundingBox())!;
  expect(Math.abs(sheetBox.height / sheetBox.width - pageBox.height / pageBox.width)).toBeLessThan(0.01);
});

test("without the JSON output pasted text is translated paragraph by paragraph and reopens from this browser", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterMistralKey(page);
  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("申请号：CN202310000001.2\n\n权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  const text = page.locator(".ocr-page");
  await expect(text).toContainText("[EN] 申请号：CN202310000001.2");
  await expect(text).toContainText("[EN] 权利要求1不具备创造性。");
  await expect(page.getByRole("checkbox", { name: "Match page layout" })).toBeDisabled(); // paragraphs have no place on a page
  expect(chatRequests(recorded).map(step)).toEqual(["block_translations"]);
  expect(recorded.some((r) => r.url.endsWith("/v1/ocr"))).toBe(false);

  await page.reload();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  const history = page.locator(".history");
  await history.locator("summary").click();
  await history.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".ocr-page")).toContainText("[EN] 权利要求1不具备创造性。");
});

test("translations saved before the summaries store existed are listed and reopen after the upgrade", async ({ page }) => {
  // The database as the previous release left it (version 2: OCR cache and whole translations), seeded on a blank page of
  // the app's origin before the app first runs.
  await page.route("**/seed", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>seed</title>" }));
  await page.goto("/seed");
  const pages = [
    {
      index: 0,
      markdown: "旧的段落。",
      header: null,
      footer: null,
      imageCount: 0,
      width: null,
      height: null,
      blocks: [{ type: "text", top_left_x: 0, top_left_y: 0, bottom_right_x: 0, bottom_right_y: 0, content: "旧的段落。" }],
    },
  ];
  const translation = {
    id: "saved-in-v2",
    sourceName: "Pasted text",
    sourceKind: "pasted",
    sourceHash: "h",
    ocrKey: null,
    ocrFingerprint: null,
    sourceText: "旧的段落。",
    pages,
    provider: "mistral",
    model: "mistral-small-latest",
    targetLanguage: "English",
    completedAt: 1_700_000_000_000,
    sourceChars: 5,
    blockTranslations: { "0:0": "[EN] An old paragraph." },
  };
  await page.evaluate(
    async (entry) => {
      const open = indexedDB.open("pdf-ocr-translater", 2);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("ocr", { keyPath: "key" }).createIndex("createdAt", "createdAt");
        open.result.createObjectStore("translations", { keyPath: "id" }).createIndex("createdAt", "createdAt").objectStore.put(entry);
      };
      await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result.close());
        open.onerror = () => reject(open.error);
      });
    },
    {
      id: translation.id,
      version: 1,
      createdAt: translation.completedAt,
      sourceName: translation.sourceName,
      sourceKind: translation.sourceKind,
      sourceHash: translation.sourceHash,
      ocrKey: null,
      targetLanguage: "English",
      provider: "mistral",
      model: "mistral-small-latest",
      translation,
    },
  );

  await setup(page);
  await enterMistralKey(page);
  const history = page.locator(".history");
  await history.locator("summary").click();
  await expect(history).toContainText("Pasted text");
  await history.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".ocr-page")).toContainText("[EN] An old paragraph.");
});

test("bounding boxes are edited by selection: cut (read again), made, deleted, undone, and kept with the OCR result", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterMistralKey(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden({ timeout: 20_000 });
  const text = page.locator(".ocr-pages");
  await expect(text).toContainText("[EN] 权利要求1不具备创造性。");

  await page.getByRole("tab", { name: "Edit bounding boxes" }).click();
  await expect(page.locator(".edit-stage img")).toBeVisible();
  const layer = page.locator(".edit-layer");
  const box = (await layer.boundingBox())!;
  /** Screen position of a point in the OCR's page pixels (the mocked page is 1700 × 2200). */
  const at = (x: number, y: number) => ({ x: box.x + (x / 1700) * box.width, y: box.y + (y / 2200) * box.height });
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  };
  const detail = page.locator(".edit-detail");

  // A tall strip over the left margin of a paragraph (where line numbers would be): it crosses the block, which is read again without it.
  const before = recorded.filter((r) => r.url.endsWith("/v1/ocr")).length;
  await drag(at(40, 650), at(160, 850));
  await expect(detail).toContainText("0 block(s) inside · 1 crossed");
  await expect(page.locator(".edit-box.is-crossed")).toHaveCount(1);
  await detail.getByRole("button", { name: "Cut out of the blocks" }).click();
  await expect(page.locator(".edit-box.is-edited")).toHaveCount(1, { timeout: 20_000 });
  const reads = recorded.filter((r) => r.url.endsWith("/v1/ocr")).slice(before);
  expect(reads).toHaveLength(1);
  const document = reads[0]!.body!["document"] as { type: string; image_url: string };
  expect(document.type).toBe("image_url");
  expect(document.image_url).toMatch(/^data:image\/png;base64,/);
  const edited = page.locator('.edit-box[data-type="text"].is-edited');
  expect(await edited.getAttribute("style")).toMatch(/left: ?9\.41/); // trimmed to x = 160 of 1700

  // The OCR text reads the block as read again; the other blocks keep their translations, the edited one is translated on its own.
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(text).toContainText("[EN] 申请号：CN202310000001.2");
  await expect(text).toContainText(REGION_TEXT);
  await expect(page.getByText("1 block(s) have no translation")).toBeVisible();
  await page.getByRole("button", { name: "Translate them" }).click();
  await expect(text).toContainText(`[EN] ${REGION_TEXT}`, { timeout: 20_000 });
  const last = chatRequests(recorded).at(-1)!;
  expect(step(last)).toBe("block_translations");
  expect(JSON.stringify(last.body)).toContain("0:e1");
  expect(JSON.stringify(last.body)).not.toContain("申请号");

  // A click selects a block; Delete removes it; Undo brings it back.
  await page.getByRole("tab", { name: "Edit bounding boxes" }).click();
  await page.mouse.click(at(850, 150).x, at(850, 150).y);
  await expect(detail).toContainText("title block");
  await page.keyboard.press("Delete");
  await expect(page.locator('.edit-box[data-type="title"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('.edit-box[data-type="title"]')).toHaveCount(1);

  // A selection around the title and the application number made into one title block.
  await drag(at(60, 90), at(1650, 290));
  await expect(detail).toContainText("2 block(s) inside · 0 crossed");
  await detail.getByLabel("Type of the new block").selectOption("title");
  await detail.getByRole("button", { name: "Make a block" }).click();
  await expect(page.locator('.edit-box[data-type="title"].is-edited')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('.edit-box[data-type="text"]')).toHaveCount(1); // only the edited paragraph is left of the text blocks

  // The edits stay with the OCR result: after a reload the same document comes back edited, with no new OCR.
  await page.reload();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  const ocrCalls = recorded.filter((r) => r.url.endsWith("/v1/ocr")).length;
  await loadPdf(page);
  await expect(page.getByText("OCR result from this browser's cache")).toBeVisible();
  await page.getByRole("tab", { name: "Edit bounding boxes" }).click();
  await expect(page.locator(".edit-box.is-edited")).toHaveCount(2);
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(text).toContainText(REGION_TEXT);
  expect(recorded.filter((r) => r.url.endsWith("/v1/ocr"))).toHaveLength(ocrCalls);

  // And back to the OCR as returned.
  await page.getByRole("tab", { name: "Edit bounding boxes" }).click();
  await page.getByRole("button", { name: /Reset all edits/ }).click();
  await expect(page.locator(".edit-box.is-edited")).toHaveCount(0);
});
