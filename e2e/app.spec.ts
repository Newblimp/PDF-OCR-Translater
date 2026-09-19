import { expect, test, type Page } from "@playwright/test";
import { makePdf, MISTRAL_KEY, mockApis, OPENAI_KEY, type RecordedRequest } from "./helpers";

const APP_HOST = "localhost:4173";
const ALLOWED_HOSTS = new Set([APP_HOST, "api.mistral.ai", "api.openai.com"]);

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

async function enterKeys(page: Page, mistral = MISTRAL_KEY, openai = OPENAI_KEY): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Paste your Mistral key").fill(mistral);
  await dialog.getByPlaceholder("Paste your OpenAI (GPT Luna) key").fill(openai);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
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
  await enterKeys(page, MISTRAL_KEY, "wrong-openai-key");
  await expect(page.getByRole("dialog").getByText("rejected this key")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByRole("dialog").getByPlaceholder("Paste your OpenAI (GPT Luna) key").fill(OPENAI_KEY);
  await page.getByRole("dialog").getByRole("button", { name: "Save and verify" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  await expect(page.getByText("OpenAI key verified")).toBeVisible();
  expect(recorded.filter((r) => r.url.endsWith("/v1/models")).map((r) => r.host).sort()).toEqual([
    "api.mistral.ai",
    "api.openai.com",
    "api.openai.com",
  ]);

  await page.reload();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("OpenAI key verified")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.mistral"))).toBe(MISTRAL_KEY);
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.openai"))).toBe(OPENAI_KEY);
});

test("OCR + translate: Mistral OCR, GPT Luna translation, browsable JSON, and no other hosts", async ({ page }) => {
  const { recorded, foreign } = await setup(page);
  await enterKeys(page);
  await expect(page.getByText("OpenAI key verified")).toBeVisible();

  await loadPdf(page);
  await expect(page.getByRole("heading", { name: "office-action.pdf" })).toBeVisible();
  await expect(page.getByText("1 page")).toBeVisible();
  await expect(page.locator(".preview-page img")).toHaveCount(1);

  await page.getByRole("button", { name: "OCR + Translate" }).click();
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });

  // Browsable output.
  await expect(page.getByRole("heading", { name: "Application number" })).toBeVisible();
  await expect(page.getByText("CN202310000001.2").first()).toBeVisible();
  await expect(page.locator(".field-card .prose table")).toBeVisible();
  await expect(page.locator(".field-card table.value-table")).toContainText("CN123456A");
  await expect(page.locator(".toolbar")).toContainText("OpenAI (GPT Luna) · gpt-5.6-luna");

  // OCR tab: headers/footers separated, images gone.
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(page.getByText("Headers and footers removed from the translated text")).toBeVisible();
  await expect(page.locator(".ocr-page")).toContainText("权利要求1不具备创造性");
  await expect(page.locator(".ocr-page")).not.toContainText("img-0.jpeg");

  // Requests: OCR went to Mistral with a base64 data URI, no images, headers/footers extracted.
  const ocr = recorded.find((r) => r.url.endsWith("/v1/ocr"));
  expect(ocr?.host).toBe("api.mistral.ai");
  expect(ocr!.body).toMatchObject({ model: "mistral-ocr-latest", include_image_base64: false, extract_header: true, extract_footer: true });
  expect(String((ocr!.body!["document"] as { document_url: string }).document_url)).toMatch(/^data:application\/pdf;base64,/);

  // Chat: schema inference (json_object) then translation (strict json_schema, streamed) both on OpenAI.
  const chats = recorded.filter((r) => r.url.endsWith("/v1/chat/completions"));
  expect(chats.map((c) => c.host)).toEqual(["api.openai.com", "api.openai.com"]);
  expect((chats[0]!.body!["response_format"] as { type: string }).type).toBe("json_object");
  const translate = chats[1]!.body!;
  expect(translate).toMatchObject({
    model: "gpt-5.6-luna",
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "none",
    response_format: { type: "json_schema", json_schema: { name: "translated_document", strict: true } },
  });
  expect(translate).not.toHaveProperty("temperature");
  const userMessage = (translate["messages"] as Array<{ role: string; content: string }>)[1]!.content;
  expect(userMessage).toContain("权利要求1不具备创造性");
  expect(userMessage).not.toContain("img-0.jpeg");
  expect(userMessage).not.toContain("国家知识产权局");
  expect(userMessage).not.toContain("第 1 页");
  expect(foreign).toEqual([]);
});

test("sections collapse and expand individually, in bulk, and via the outline", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  await loadPdf(page);
  await page.getByRole("button", { name: "OCR + Translate" }).click();
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });

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
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Erster Prüfungsbescheid")).toBeVisible();
  await expect(page.locator(".toolbar")).toContainText("→ German");

  const translate = recorded.filter((r) => r.url.endsWith("/v1/chat/completions")).at(-1)!.body!;
  const system = (translate["messages"] as Array<{ role: string; content: string }>)[0]!.content;
  expect(system).toContain("into German");
  expect(recorded.some((r) => r.url.endsWith("/v1/ocr"))).toBe(false);

  await page.reload();
  await page.locator(".settings > summary").click();
  await expect(page.getByRole("radio", { name: "German" })).toHaveAttribute("aria-checked", "true");
});

test("theme switch forces dark or light and persists; system removes the override", async ({ page }) => {
  await setup(page);
  await enterKeys(page);
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-theme", /.+/);

  await page.getByRole("radio", { name: "Dark theme" }).click();
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

test("a Mistral-only user can pick Mistral in the key dialog and never needs an OpenAI key", async ({ page }) => {
  const { recorded } = await setup(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeDisabled();
  await dialog.getByPlaceholder("Paste your Mistral key").fill(MISTRAL_KEY);
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeDisabled(); // OpenAI key still required
  await dialog.getByLabel("Translate with").selectOption("mistral");
  await expect(dialog.getByRole("button", { name: "Save and verify" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Mistral key verified")).toBeVisible();
  await expect(page.getByText(/OpenAI key/)).toHaveCount(0);

  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate only" }).click();
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });
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
  await enterKeys(page, "wrong-mistral-key", OPENAI_KEY);
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
  await expect(page.getByText("OpenAI key verified")).toBeVisible();
  // Slow down the model list so the reload-time verification is still pending when we click Forget.
  await page.route("https://api.mistral.ai/v1/models", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
  await page.route("https://api.openai.com/v1/models", async (route) => {
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
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey.openai"))).toBeNull();
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
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });
  const chats = recorded.filter((r) => r.url.endsWith("/v1/chat/completions"));
  expect(chats.map((c) => c.host)).toEqual(["api.mistral.ai", "api.mistral.ai"]);
  expect(chats[1]!.body).toMatchObject({ model: "mistral-large-latest", temperature: 0.2 });
  expect(chats[1]!.body).not.toHaveProperty("reasoning_effort");
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
