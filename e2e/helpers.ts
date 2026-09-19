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

/** 1×1 PNG, enough for an <img> and for a vision request body. */
export const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const OCR_MARKDOWN = [
  "# 第一次审查意见通知书",
  "",
  "申请号：CN202310000001.2",
  "",
  "![img-0.jpeg](img-0.jpeg)",
  "",
  "权利要求1不具备创造性。",
  "",
  "![img-1.jpeg](img-1.jpeg)",
].join("\n");

export const OCR_PAGE = {
  index: 0,
  markdown: OCR_MARKDOWN,
  images: [
    { id: "img-0.jpeg", top_left_x: 100, top_left_y: 300, bottom_right_x: 500, bottom_right_y: 600, image_base64: TINY_PNG },
    { id: "img-1.jpeg", top_left_x: 900, top_left_y: 1500, bottom_right_x: 1300, bottom_right_y: 1900, image_base64: TINY_PNG },
  ],
  dimensions: { dpi: 200, height: 2200, width: 1700 },
  header: "国家知识产权局",
  footer: "第 1 页",
  blocks: [
    { type: "title", top_left_x: 100, top_left_y: 100, bottom_right_x: 1600, bottom_right_y: 200, content: "第一次审查意见通知书" },
    { type: "text", top_left_x: 100, top_left_y: 220, bottom_right_x: 1600, bottom_right_y: 280, content: "申请号：CN202310000001.2" },
    { type: "image", top_left_x: 100, top_left_y: 300, bottom_right_x: 500, bottom_right_y: 600, content: "", image_id: "img-0.jpeg" },
  ],
};

export const BBOX_ANNOTATION = {
  image_type: "stamp",
  short_description: "Official seal of the patent office.",
  summary: "A red circular seal.",
  text_in_image: "国家知识产权局",
  text_translated: "China National Intellectual Property Administration",
};

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
      return json(route, 200, { model: "mistral-ocr-latest", pages: [OCR_PAGE], usage_info: { pages_processed: 1, doc_size_bytes: 1234 } });
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

/** Schema inference answers in json_object mode; bbox annotation and translation in json_schema mode (translation streamed). */
function chatCompletion(route: Route, body: Record<string, unknown> | null, model: string, openai: boolean) {
  const responseFormat = body?.["response_format"] as { type?: string; json_schema?: { name?: string } } | undefined;
  const format = responseFormat?.type;
  const messages = (body?.["messages"] as Array<{ role: string; content: string | unknown[] }> | undefined) ?? [];
  const systemContent = messages.find((m) => m.role === "system")?.content;
  const system = typeof systemContent === "string" ? systemContent : "";
  const german = /into German/.test(system);
  if (format === "json_schema" && responseFormat?.json_schema?.name === "bbox_annotation") {
    return json(route, 200, {
      id: "cmpl-bbox",
      object: "chat.completion",
      model,
      created: 0,
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(BBOX_ANNOTATION) }, finish_reason: "stop" }],
    });
  }
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

/**
 * Make the translation request truly stream inside the browser: patches
 * `window.fetch` so the streamed chat completion arrives as SSE frames with
 * a delay between them. Playwright's `route.fulfill` delivers bodies at once,
 * so this is the only way to exercise the live-streaming UI.
 */
export async function installStreamingTranslationMock(page: Page, delayMs = 150, chunks = 8): Promise<void> {
  await page.addInitScript(
    ({ translation, delayMs, chunks }) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("api.openai.com/v1/chat/completions") && init?.body) {
          const body = JSON.parse(String(init.body)) as { stream?: boolean; response_format?: { json_schema?: { name?: string } } };
          if (body.stream && body.response_format?.json_schema?.name === "translated_document") {
            const text = JSON.stringify(translation);
            const size = Math.ceil(text.length / chunks);
            const encoder = new TextEncoder();
            const frame = (content: string, finish: string | null) =>
              `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", model: "gpt-5.6-luna", created: 0, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                for (let i = 0; i < chunks; i++) {
                  await new Promise((r) => setTimeout(r, delayMs));
                  const piece = text.slice(i * size, (i + 1) * size);
                  controller.enqueue(encoder.encode(frame(piece, i === chunks - 1 ? "stop" : null)));
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            });
            return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
          }
        }
        return original(input, init);
      };
    },
    { translation: TRANSLATION, delayMs, chunks },
  );
}
