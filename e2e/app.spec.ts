import { expect, test, type Page } from "@playwright/test";
import { ANTHROPIC_KEY, chatStep, installStreamingTranslationMock, jsonBody, makePdf, MISTRAL_KEY, mockApis, OPENAI_KEY, systemPrompt, type RecordedRequest } from "./helpers";

const APP_HOST = "localhost:4173";
const ALLOWED_HOSTS = new Set([APP_HOST, "api.mistral.ai", "api.anthropic.com", "api.openai.com"]);

async function setup(page: Page): Promise<{ recorded: RecordedRequest[]; foreign: string[] }> {
  const recorded: RecordedRequest[] = [];
  const foreign: string[] = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).host;
    if (!ALLOWED_HOSTS.has(host)) foreign.push(req.url());
  });
  await mockApis(page, recorded);
  await page.goto("/");
  return { recorded, foreign };
}

async function enterKeys(page: Page, mistral = MISTRAL_KEY, anthropic = ANTHROPIC_KEY): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Paste your Mistral key").fill(mistral);
  await dialog.getByPlaceholder("Paste your Anthropic (Claude) key").fill(anthropic);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
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
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "office-action.pdf",
    mimeType: "application/pdf",
    buffer: makePdf("Hello patent office"),
  });
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
  expect(recorded.filter((r) => path(r) === "/v1/models").map((r) => r.host).sort()).toEqual([
    "api.anthropic.com",
    "api.anthropic.com",
    "api.mistral.ai",
  ]);
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
  const { recorded, foreign } = await setup(page);
  await enterKeys(page);
  await expect(page.getByText("Anthropic key verified")).toBeVisible();

  await loadPdf(page);
  await expect(page.getByRole("heading", { name: "office-action.pdf" })).toBeVisible();
  await expect(page.getByText("1 page")).toBeVisible();
  await expect(page.locator(".preview-page img")).toHaveCount(1);

  await page.getByRole("button", { name: "OCR + Translate" }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });

  // Browsable output.
  await expect(page.getByRole("heading", { name: "Application number" })).toBeVisible();
  await expect(page.getByText("CN202310000001.2").first()).toBeVisible();
  await expect(page.locator(".field-card .prose table")).toBeVisible();
  await expect(page.locator(".field-card table.value-table")).toContainText("CN123456A");
  await expect(page.locator(".toolbar")).toContainText("Anthropic (Claude) · claude-haiku-5-5");

  // OCR tab: headers/footers separated, images gone, and the shared "Show translation" switch.
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(page.getByText("Headers and footers removed from the translated text")).toBeVisible();
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
  const userContent = messages[0]!.content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string }; cache_control?: unknown }>;
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
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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
  const { recorded } = await setup(page);
  await enterKeys(page);
  await page.locator(".settings > summary").click();
  await page.getByRole("radio", { name: "German" }).click();
  await expect(page.getByRole("radio", { name: "German" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("申请号：CN202310000001.2\n\n权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate only" }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Erster Prüfungsbescheid")).toBeVisible();
  await expect(page.locator(".toolbar")).toContainText("→ German");
  // Pasted text: no OCR, no bounding boxes, and the UI says so.
  await expect(page.locator(".pipeline-strip")).toContainText("Text input (no OCR)");
  await expect(page.locator(".pipeline-strip")).toContainText("BBox annotation skipped");
  await expect(page.getByRole("tab", { name: "Bounding boxes" })).toHaveCount(0);

  const translate = chatRequests(recorded).find((r) => step(r) === "translated_document")!.body!;
  expect(systemPrompt(translate)).toContain("Target language of the translation: German");
  expect(recorded.some((r) => r.url.endsWith("/v1/ocr"))).toBe(false);

  await page.reload();
  await page.locator(".settings > summary").click();
  await expect(page.getByRole("radio", { name: "German" })).toHaveAttribute("aria-checked", "true");
});

test("the structured text and the OCR text follow one \"Show translation\" switch", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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

test("a Mistral-only user can pick Mistral in the key dialog and never needs an Anthropic key", async ({ page }) => {
  const { recorded } = await setup(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeDisabled();
  await dialog.getByPlaceholder("Paste your Mistral key").fill(MISTRAL_KEY);
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeDisabled(); // Anthropic key still required
  await dialog.getByLabel("Translate with").selectOption("mistral");
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  await expect(page.getByText(/Anthropic key/)).toHaveCount(0);

  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate only" }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  expect(recorded.every((r) => r.host === "api.mistral.ai")).toBe(true);

  // Switching to OpenAI without a key asks for it immediately; the dialog can be cancelled.
  await page.locator(".settings > summary").click();
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
  await page.route((url) => url.host === "api.anthropic.com" && url.pathname === "/v1/models", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
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

test("Mistral can still be chosen as translation provider", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKeys(page);
  await page.locator(".settings > summary").click();
  await page.getByLabel("Translation provider").selectOption("mistral");
  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate only" }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  const chats = chatRequests(recorded);
  expect(chats.map((c) => c.host)).toEqual(["api.mistral.ai", "api.mistral.ai"]);
  expect(chats.map(step)).toEqual(["infer_schema", "translated_document"]);
  expect(chats[1]!.body).toMatchObject({ model: "mistral-large-latest", temperature: 0.2 });
  expect(chats[1]!.body).not.toHaveProperty("reasoning_effort");
});

test("OpenAI (GPT Luna) can still be chosen as translation provider", async ({ page }) => {
  const { recorded } = await setup(page);
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
  await page.getByRole("button", { name: "Translate only" }).click();
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
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
  await expect(page.getByRole("tab", { name: "Structured text" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".pipeline-strip")).toBeVisible();

  await page.getByRole("tab", { name: "Bounding boxes" }).click();
  await expect(page.locator(".bbox-stage img")).toBeVisible(); // page rendered by pdf.js
  await expect(page.locator(".bbox-box")).toHaveCount(5); // 3 blocks + 2 image boxes
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
  await page.getByRole("button", { name: "text block 2" }).click();
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
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "three-pages.pdf",
    mimeType: "application/pdf",
    buffer: makePdf("Page one", ["Page two", "Page three"]),
  });
  await expect(page.getByText("3 pages")).toBeVisible();
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "Bounding boxes" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Bounding boxes" }).click();
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
  await page.locator('input[type="file"]').first().setInputFiles({
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
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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
  const { recorded } = await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  // "OCR only" leaves the OCR tab active; a following translation must still show its stream.
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await page.getByRole("button", { name: "Translate only" }).click();

  // While the job is still running, partial output is visible and grows.
  const panel = page.locator(".stream-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  const first = (await panel.locator(".stream-tail").textContent()) ?? "";
  await expect(panel.getByRole("heading", { name: "Document type", exact: true })).toBeVisible();
  await expect
    .poll(async () => ((await panel.locator(".stream-tail").textContent()) ?? "").length, { timeout: 5_000 })
    .toBeGreaterThan(first.length);

  // Then the final, parsed translation replaces it.
  await expect(panel).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".pipeline-strip")).toBeVisible();
  await expect(page.getByText("CN202310000001.2").first()).toBeVisible();
  // The SDK used the patched window.fetch: the streamed request never reached the route mock.
  expect(chatRequests(recorded).map(step)).not.toContain("translated_document");
});

test("cancelling during streaming stops cleanly", async ({ page }) => {
  await installStreamingTranslationMock(page, 400, 10);
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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
  await page.locator('input[type="file"]').first().setInputFiles({ name: "a.pdf", mimeType: "application/pdf", buffer: makePdf("x") });
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
  await setup(page);
  await enterKeys(page);
  await failStep(page, "block_translations", 401);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
  await expect(page.locator(".pipeline-strip")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Some follow-up steps failed; the translation itself is complete.")).toBeVisible();
  await expect(page.getByText(/Block translations failed: HTTP 401/)).toBeVisible();
  await expect(page.getByText("The examiner finds claim 1 lacks inventive step.")).toBeVisible();
});

test("blocks that came back without a translation can be retried", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKeys(page);
  const failing = await failStep(page, "block_translations", 400, 1);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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
  const { recorded } = await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR only" }).click();
  await expect(page.getByRole("tab", { name: "OCR text" })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(page.getByText(/Translation estimate: ≈ .* tokens over \d+ call\(s\) ≈ \$/)).toBeVisible();
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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
  await expect(page.getByText("The examiner finds claim 1 lacks inventive step.")).toBeVisible();
  await expect(page.locator(".toolbar").first()).toContainText("saved in this browser");
  expect(recorded.slice(before).filter((r) => path(r) !== "/v1/models")).toEqual([]);

  // Reopening from the list works without the document, too.
  await page.getByRole("button", { name: "Remove" }).click();
  await history.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("The examiner finds claim 1 lacks inventive step.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "OCR text" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Translate only" })).toBeEnabled();
});

test("the glossary and other target languages reach the translation prompt", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKeys(page);
  await page.locator(".settings > summary").click();
  await page.getByLabel("Other target language").selectOption("French");
  await page.getByLabel("Glossary").fill("审查员 = examinateur\n# a comment\n驳回 = rejet");
  await page.getByLabel("Glossary").blur();
  await expect(page.getByText("2 term(s) the translation must use.")).toBeVisible();
  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("审查员认为权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate only" }).click();
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
  await page.getByRole("dialog").getByLabel(/Remember keys in this browser/).check();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBe(ANTHROPIC_KEY);
  expect(await page.evaluate(() => sessionStorage.getItem("pdf-ocr-translater.apiKey.anthropic"))).toBeNull();
});

test("the bilingual export holds the translation next to the original", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
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
