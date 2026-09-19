/**
 * Test helpers: a tiny PDF generator and mocks of the Mistral (OCR) and
 * OpenAI (translation) endpoints the app uses. Kept dependency-free so the
 * e2e suite runs offline.
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
  host: "api.mistral.ai" | "api.openai.com";
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export const MISTRAL_KEY = "mistral-test-key";
export const OPENAI_KEY = "sk-openai-test-key";

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

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** Intercept every call to api.mistral.ai and api.openai.com and answer like the real APIs would. */
export async function mockApis(page: Page, recorded: RecordedRequest[]): Promise<void> {
  await page.route("https://api.mistral.ai/**", async (route: Route) => {
    const req = route.request();
    const url = req.url();
    let body: Record<string, unknown> | null = null;
    try {
      body = req.postDataJSON() as Record<string, unknown>;
    } catch {
      body = null;
    }
    recorded.push({ host: "api.mistral.ai", url, headers: req.headers(), body });

    if (req.headers()["authorization"] !== `Bearer ${MISTRAL_KEY}`) return json(route, 401, { message: "Unauthorized" });

    if (url.endsWith("/v1/models")) {
      return json(route, 200, {
        object: "list",
        data: [
          { id: "mistral-large-latest", type: "base", capabilities: { completion_chat: true }, max_context_length: 262144, name: "Mistral Large" },
          { id: "mistral-small-latest", type: "base", capabilities: { completion_chat: true }, max_context_length: 131072 },
          { id: "mistral-ocr-latest", type: "base", capabilities: { completion_chat: false, ocr: true } },
        ],
      });
    }

    if (url.endsWith("/v1/ocr")) {
      const annotate = !!body?.["document_annotation_format"];
      return json(route, 200, {
        ...(annotate
          ? {
              document_annotation: JSON.stringify({
                document_type: "第一次审查意见通知书",
                application_number: "CN202310000001.2",
                summary: "审查员认为权利要求1不具备创造性。",
                body_sections: [{ heading: "创造性", content: "权利要求1不具备创造性。" }],
                cited_references: [{ label: "D1", identifier: "CN123456A" }],
                notes_for_reader: "",
              }),
            }
          : {}),
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
      });
    }

    if (url.endsWith("/v1/chat/completions")) return chatCompletion(route, body, "mistral-large-latest", false);
    return json(route, 404, { message: "not mocked" });
  });

  await page.route("https://api.openai.com/**", async (route: Route) => {
    const req = route.request();
    const url = req.url();
    let body: Record<string, unknown> | null = null;
    try {
      body = req.postDataJSON() as Record<string, unknown>;
    } catch {
      body = null;
    }
    recorded.push({ host: "api.openai.com", url, headers: req.headers(), body });

    if (req.headers()["authorization"] !== `Bearer ${OPENAI_KEY}`) {
      return json(route, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    if (url.endsWith("/v1/models")) {
      return json(route, 200, {
        object: "list",
        data: [
          { id: "gpt-5.6-luna", object: "model", owned_by: "openai" },
          { id: "gpt-5.6-luna-pro", object: "model", owned_by: "openai" },
          { id: "gpt-5.6-terra", object: "model", owned_by: "openai" },
          { id: "gpt-image-2", object: "model", owned_by: "openai" },
        ],
      });
    }
    if (url.endsWith("/v1/chat/completions")) return chatCompletion(route, body, "gpt-5.6-luna", true);
    return json(route, 404, { error: { message: "not mocked" } });
  });
}

/** Schema inference answers in json_object mode; translation streams JSON in json_schema mode. */
function chatCompletion(route: Route, body: Record<string, unknown> | null, model: string, openai: boolean) {
  const format = (body?.["response_format"] as { type?: string } | undefined)?.type;
  const messages = (body?.["messages"] as Array<{ role: string; content: string }> | undefined) ?? [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const german = /into German/.test(system);
  if (format === "json_object") {
    return json(route, 200, {
      id: "cmpl-1",
      object: "chat.completion",
      model,
      created: 0,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(INFERRED_SCHEMA) }, finish_reason: "stop" }],
    });
  }
  const translation = german
    ? { ...TRANSLATION, document_type: "Erster Prüfungsbescheid", summary: "Der Prüfer hält Anspruch 1 für nicht erfinderisch." }
    : TRANSLATION;
  const text = JSON.stringify(translation);
  const mid = Math.floor(text.length / 2);
  const chunk = (content: string, finish?: string) => ({
    id: "cmpl-2",
    object: "chat.completion.chunk",
    model,
    created: 0,
    choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }],
  });
  const frames: unknown[] = [chunk(text.slice(0, mid)), chunk(text.slice(mid), "stop")];
  if (openai) {
    frames.push({
      id: "cmpl-2",
      object: "chat.completion.chunk",
      model,
      created: 0,
      choices: [],
      usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700, completion_tokens_details: { reasoning_tokens: 0 } },
    });
  }
  if (body?.["stream"] !== true) {
    return json(route, 200, {
      id: "cmpl-2",
      object: "chat.completion",
      model,
      created: 0,
      usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    });
  }
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(frames) });
}
