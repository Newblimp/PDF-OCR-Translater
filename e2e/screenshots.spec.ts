import { test } from "@playwright/test";
import { makePdf, MISTRAL_KEY, mockApis, OPENAI_KEY } from "./helpers";

// Not a real test: produces screenshots for a visual check. Run with
//   npx playwright test e2e/screenshots.spec.ts
test.skip(!process.env["SCREENSHOTS"], "set SCREENSHOTS=1 to generate screenshots");

for (const [name, width] of [
  ["desktop", 1400],
  ["mobile", 420],
] as const) {
  test(`screenshots ${name}`, async ({ page }) => {
    const out = process.env["SCREENSHOTS_DIR"] ?? "test-results/screenshots";
    await page.setViewportSize({ width, height: 900 });
    await mockApis(page, []);
    await page.goto("/");
    await page.screenshot({ path: `${out}/${name}-1-key.png`, fullPage: true });
    await page.getByRole("dialog").getByPlaceholder("Paste your Mistral key").fill(MISTRAL_KEY);
    await page.getByRole("dialog").getByPlaceholder("Paste your OpenAI (GPT Luna) key").fill(OPENAI_KEY);
    await page.getByRole("dialog").getByRole("button", { name: "Save and verify" }).click();
    await page.getByText("OpenAI key verified").waitFor();
    await page.screenshot({ path: `${out}/${name}-2-empty.png`, fullPage: true });
    await page.locator('input[type="file"]').first().setInputFiles({ name: "office-action.pdf", mimeType: "application/pdf", buffer: makePdf("Hello patent office") });
    await page.locator(".preview-page img").first().waitFor();
    await page.screenshot({ path: `${out}/${name}-3-loaded.png`, fullPage: true });
    await page.getByRole("button", { name: "OCR + Translate" }).click();
    await page.getByRole("tab", { name: "Translation" }).waitFor();
    await page.locator(".field-card .prose table").waitFor();
    await page.screenshot({ path: `${out}/${name}-4-translation.png`, fullPage: true });
    await page.getByRole("tab", { name: "OCR text" }).click();
    await page.screenshot({ path: `${out}/${name}-5-ocr.png`, fullPage: true });
    await page.getByRole("tab", { name: "Bounding boxes" }).click();
    await page.locator(".bbox-stage img").waitFor();
    await page.getByRole("button", { name: "Image box img-0.jpeg" }).click();
    await page.screenshot({ path: `${out}/${name}-5b-bboxes.png`, fullPage: true });
    await page.getByRole("tab", { name: "Translation" }).click();
    await page.locator(".settings > summary").click();
    await page.screenshot({ path: `${out}/${name}-6-settings.png`, fullPage: true });
    await page.getByRole("radio", { name: "Dark theme" }).click();
    await page.getByRole("button", { name: "Collapse all" }).click();
    await page.screenshot({ path: `${out}/${name}-7-dark-collapsed.png`, fullPage: true });
  });
}
