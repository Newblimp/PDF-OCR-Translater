import { expect, test, type Page } from "@playwright/test";
import { makePdf, mockMistral, type RecordedRequest } from "./helpers";

const APP_HOST = "localhost:4173";

async function setup(page: Page): Promise<{ recorded: RecordedRequest[]; foreign: string[] }> {
  const recorded: RecordedRequest[] = [];
  const foreign: string[] = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).host;
    if (host !== APP_HOST && host !== "api.mistral.ai") foreign.push(req.url());
  });
  await mockMistral(page, recorded);
  await page.goto("/");
  return { recorded, foreign };
}

async function enterKey(page: Page, key = "sk-test-key"): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Paste your key").fill(key);
  await dialog.getByRole("button", { name: "Save and verify" }).click();
}

test("asks for the API key once, verifies it and caches it in the browser", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKey(page, "wrong-key");
  await expect(page.getByRole("dialog").getByText("rejected this key")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("dialog").getByPlaceholder("Paste your key").fill("sk-test-key");
  await page.getByRole("dialog").getByRole("button", { name: "Save and verify" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Key verified")).toBeVisible();
  expect(recorded.filter((r) => r.url.endsWith("/v1/models")).length).toBe(2);

  await page.reload();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Key verified")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pdf-ocr-translater.apiKey"))).toBe("sk-test-key");
});

test("OCR + translate: preview, pipeline, browsable JSON, and the document only goes to api.mistral.ai", async ({ page }) => {
  const { recorded, foreign } = await setup(page);
  await enterKey(page);
  await expect(page.getByText("Key verified")).toBeVisible();

  await page.locator('input[type="file"]').first().setInputFiles({
    name: "office-action.pdf",
    mimeType: "application/pdf",
    buffer: makePdf("Hello patent office"),
  });
  await expect(page.getByRole("heading", { name: "office-action.pdf" })).toBeVisible();
  await expect(page.getByText("1 page")).toBeVisible();
  await expect(page.locator(".preview-page img")).toHaveCount(1);

  await page.getByRole("button", { name: "OCR + Translate" }).click();
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });

  // Browsable output.
  await expect(page.getByRole("heading", { name: "Application number" })).toBeVisible();
  await expect(page.getByText("CN202310000001.2").first()).toBeVisible();
  await expect(page.locator(".field-card .prose table")).toBeVisible(); // Markdown inside a long field is rendered
  await expect(page.getByRole("heading", { name: "Cited references" })).toBeVisible();
  await expect(page.locator(".field-card table.value-table")).toContainText("CN123456A"); // flat object arrays become grids
  await page.getByPlaceholder("Find in fields…").fill("inventive");
  await expect(page.locator(".outline-link")).toHaveCount(2); // summary + body_sections mention it
  await page.getByPlaceholder("Find in fields…").fill("");

  // OCR tab: headers/footers separated, images gone.
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(page.getByText("Headers and footers removed from the translated text")).toBeVisible();
  await expect(page.locator(".ocr-page")).toContainText("权利要求1不具备创造性");
  await expect(page.locator(".ocr-page")).not.toContainText("img-0.jpeg");

  // JSON format tab shows the inferred, strict-mode schema.
  await page.getByRole("tab", { name: "JSON format" }).click();
  await expect(page.getByText("Inferred from the document")).toBeVisible();
  await expect(page.locator(".code-block")).toContainText('"additionalProperties": false');

  // Requests: OCR got a base64 data URI with headers/footers extracted and no images.
  const ocr = recorded.find((r) => r.url.endsWith("/v1/ocr"));
  expect(ocr).toBeDefined();
  expect(ocr!.body).toMatchObject({
    model: "mistral-ocr-latest",
    include_image_base64: false,
    extract_header: true,
    extract_footer: true,
    document: { type: "document_url", document_name: "office-action.pdf" },
  });
  expect(String((ocr!.body!["document"] as { document_url: string }).document_url)).toMatch(/^data:application\/pdf;base64,/);

  // Chat: schema inference in json_object mode, then translation in strict json_schema mode.
  const chats = recorded.filter((r) => r.url.endsWith("/v1/chat/completions"));
  expect(chats.length).toBe(2);
  expect((chats[0]!.body!["response_format"] as { type: string }).type).toBe("json_object");
  const translate = chats[1]!.body!;
  expect(translate["response_format"]).toMatchObject({ type: "json_schema", json_schema: { name: "translated_document", strict: true } });
  expect(translate["stream"]).toBe(true);
  const userMessage = (translate["messages"] as Array<{ role: string; content: string }>)[1]!.content;
  expect(userMessage).toContain("权利要求1不具备创造性");
  expect(userMessage).not.toContain("img-0.jpeg");
  expect(userMessage).not.toContain("国家知识产权局"); // header excluded
  expect(userMessage).not.toContain("第 1 页"); // footer excluded

  // Privacy: nothing was sent anywhere but our own origin and the Mistral API.
  expect(foreign).toEqual([]);
});

test("Translate only works on pasted text", async ({ page }) => {
  const { recorded } = await setup(page);
  await enterKey(page);
  await page.getByRole("button", { name: "…or paste text to translate" }).click();
  await page.getByPlaceholder("Paste the source text").fill("申请号：CN202310000001.2\n\n权利要求1不具备创造性。");
  await page.getByRole("button", { name: "Translate only" }).click();
  await expect(page.getByRole("tab", { name: "Translation" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Document type" })).toBeVisible();
  expect(recorded.some((r) => r.url.endsWith("/v1/ocr"))).toBe(false);
  expect(recorded.filter((r) => r.url.endsWith("/v1/chat/completions")).length).toBe(2);
});

test("cancel stops a running job without an error", async ({ page }) => {
  await setup(page);
  await enterKey(page);
  // Slow down OCR so we can cancel it.
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
