/**
 * Test helpers: a tiny PDF generator and a mock of the Mistral endpoints the
 * app uses. Kept dependency-free so the e2e suite runs offline.
 */
import type { Page, Route } from "@playwright/test";

/** Build a minimal, valid single-page PDF that pdf.js can render. ASCII only. */
export function makePdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export const OCR_MARKDOWN = [
  "# 第一次审查意见通知书",
  "",
  "申请号：CN202310000001.2",
  "",
  "![img-0.jpeg](img-0.jpeg)",
  "",
  "权利要求1不具备创造性。",
].join("\n");

export const INFERRED_SCHEMA = {
  type: "object",
  properties: {
    document_type: { type: "string", description: "Kind of notification" },
    application_number: { type: "string", description: "Application number" },
    summary: { type: "string", description: "Short summary" },
    body_sections: {
      type: "array",
      description: "Body",
      items: { type: "object", properties: { heading: { type: "string" }, content: { type: "string" } } },
    },
    cited_references: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, identifier: { type: "string" } } },
    },
    notes_for_reader: { type: "string" },
  },
};

export const TRANSLATION = {
  document_type: "First Office Action",
  application_number: "CN202310000001.2",
  summary: "The examiner finds claim 1 lacks inventive step.",
  body_sections: [
    {
      heading: "Inventive step",
      content: "Claim 1 does not involve an inventive step.\n\n| Claim | Finding |\n|---|---|\n| 1 | Not inventive |",
    },
  ],
  cited_references: [{ label: "D1", identifier: "CN123456A" }],
  notes_for_reader: "",
};

function sse(objects: unknown[]): string {
  return `${objects.map((o) => `data: ${JSON.stringify(o)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

/** Intercept every call to api.mistral.ai and answer like the real API would. */
export async function mockMistral(page: Page, recorded: RecordedRequest[]): Promise<void> {
  await page.route("https://api.mistral.ai/**", async (route: Route) => {
    const req = route.request();
    const url = req.url();
    let body: Record<string, unknown> | null = null;
    try {
      body = req.postDataJSON() as Record<string, unknown>;
    } catch {
      body = null;
    }
    recorded.push({ url, headers: req.headers(), body });

    if (req.headers()["authorization"] !== "Bearer sk-test-key") {
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Unauthorized" }) });
    }

    if (url.endsWith("/v1/models")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          object: "list",
          data: [
            { id: "mistral-large-latest", type: "base", capabilities: { completion_chat: true }, max_context_length: 262144, name: "Mistral Large" },
            { id: "mistral-small-latest", type: "base", capabilities: { completion_chat: true }, max_context_length: 131072 },
            { id: "mistral-ocr-latest", type: "base", capabilities: { completion_chat: false, ocr: true } },
          ],
        }),
      });
    }

    if (url.endsWith("/v1/ocr")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model: "mistral-ocr-latest",
          pages: [
            {
              index: 0,
              markdown: OCR_MARKDOWN,
              images: [{ id: "img-0.jpeg", top_left_x: 0, top_left_y: 0, bottom_right_x: 1, bottom_right_y: 1 }],
              dimensions: { dpi: 200, height: 2200, width: 1700 },
              header: "国家知识产权局",
              footer: "第 1 页",
            },
          ],
          usage_info: { pages_processed: 1, doc_size_bytes: 1234 },
        }),
      });
    }

    if (url.endsWith("/v1/chat/completions")) {
      const format = (body?.["response_format"] as { type?: string } | undefined)?.type;
      if (format === "json_object") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "cmpl-1",
            object: "chat.completion",
            model: "mistral-large-latest",
            created: 0,
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(INFERRED_SCHEMA) }, finish_reason: "stop" }],
          }),
        });
      }
      const text = JSON.stringify(TRANSLATION);
      const mid = Math.floor(text.length / 2);
      const chunk = (content: string, finish?: string) => ({
        id: "cmpl-2",
        object: "chat.completion.chunk",
        model: "mistral-large-latest",
        created: 0,
        choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }],
        ...(finish ? { usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } } : {}),
      });
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([chunk(text.slice(0, mid)), chunk(text.slice(mid), "stop")]),
      });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "not mocked" }) });
  });
}
