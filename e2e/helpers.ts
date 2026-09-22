/**
 * Test helpers: a tiny PDF generator and mocks of the Mistral (OCR) and
 * OpenAI (translation) endpoints the app uses. Kept dependency-free so the
 * e2e suite runs offline.
 */
import type { Page, Route } from "@playwright/test";

/** Build a minimal, valid PDF (one page per text entry) that pdf.js can render. ASCII only. */
export function makePdf(text: string, morePages: string[] = []): Buffer {
  const texts = [text, ...morePages];
  const escape = (t: string) => t.replace(/[()\\]/g, "\\$&");
  // Object numbering: 1 catalog, 2 pages, 3 font, then per page: page object + content stream.
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  texts.forEach((t, i) => {
    const content = `BT /F1 18 Tf 72 720 Td (${escape(t)}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
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

/** Same JSON format as TRANSLATION, but untranslated: the "original_document" call. */
export const ORIGINAL_STRUCTURE = {
  document_type: "第一次审查意见通知书",
  application_number: "CN202310000001.2",
  summary: "审查员认为权利要求1不具备创造性。",
  body_sections: [{ heading: "创造性", content: "权利要求1不具备创造性。" }],
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
      const requested = body?.["pages"] as number[] | undefined;
      // Without a selection, "OCR" every page of the uploaded PDF (count the page objects in the data URL).
      const documentUrl = String((body?.["document"] as { document_url?: string } | undefined)?.document_url ?? "");
      const pdfText = documentUrl.startsWith("data:") ? Buffer.from(documentUrl.split(",")[1] ?? "", "base64").toString("latin1") : "";
      const pageCount = Math.max(1, (pdfText.match(/\/Type \/Page\b/g) ?? []).length);
      const indices = requested?.length ? requested : Array.from({ length: pageCount }, (_, i) => i);
      const pages = indices.map((index) => ({ ...OCR_PAGE, index, images: index === 0 ? OCR_PAGE.images : [], blocks: index === 0 ? OCR_PAGE.blocks : [OCR_PAGE.blocks[1]] }));
      return json(route, 200, { model: "mistral-ocr-latest", pages, usage_info: { pages_processed: pages.length, doc_size_bytes: 1234 } });
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
          { id: "gpt-6-luna", object: "model", owned_by: "openai" },
          { id: "gpt-5.6-luna", object: "model", owned_by: "openai" },
          { id: "gpt-5.6-luna-pro", object: "model", owned_by: "openai" },
          { id: "gpt-5.6-terra", object: "model", owned_by: "openai" },
          { id: "gpt-image-2", object: "model", owned_by: "openai" },
        ],
      });
    }
    if (url.endsWith("/v1/chat/completions")) return chatCompletion(route, body, "gpt-6-luna", true);
    return json(route, 404, { error: { message: "not mocked" } });
  });
}

/**
 * Schema inference answers in json_object mode; bbox annotation, the
 * original-language structure and the translation in json_schema mode
 * (the translation streamed).
 */
function chatCompletion(route: Route, body: Record<string, unknown> | null, model: string, openai: boolean) {
  const responseFormat = body?.["response_format"] as { type?: string; json_schema?: { name?: string } } | undefined;
  const format = responseFormat?.type;
  const messages = (body?.["messages"] as Array<{ role: string; content: string | unknown[] }> | undefined) ?? [];
  const systemContent = messages.find((m) => m.role === "system")?.content;
  const system = typeof systemContent === "string" ? systemContent : "";
  const german = /into German/.test(system);
  if (format === "json_schema" && responseFormat?.json_schema?.name === "block_translations") {
    const user = messages.find((m) => m.role === "user")?.content;
    const items = JSON.parse(String(user).replace(/^[^[]*/, "")) as Array<{ id: string; text: string }>;
    return json(route, 200, {
      id: "cmpl-blocks",
      object: "chat.completion",
      model,
      created: 0,
      usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 },
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify({ translations: items.map((i) => ({ id: i.id, text: `[${german ? "DE" : "EN"}] ${i.text}` })) }) },
          finish_reason: "stop",
        },
      ],
    });
  }
  if (format === "json_schema" && responseFormat?.json_schema?.name === "original_document") {
    return json(route, 200, {
      id: "cmpl-original",
      object: "chat.completion",
      model,
      created: 0,
      usage: { prompt_tokens: 400, completion_tokens: 150, total_tokens: 550 },
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(ORIGINAL_STRUCTURE) }, finish_reason: "stop" }],
    });
  }
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
  // Frames are token-sized so several land inside one throttle window; the stream honours AbortSignal.
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
              `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", model: "gpt-6-luna", created: 0, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
            const signal = init.signal ?? null;
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                for (let i = 0; i < chunks; i++) {
                  await new Promise((r) => setTimeout(r, delayMs));
                  if (signal?.aborted) {
                    controller.error(new DOMException("Aborted", "AbortError"));
                    return;
                  }
                  const piece = text.slice(i * size, (i + 1) * size);
                  // Split each piece into small frames, like real token streaming.
                  for (let j = 0; j < piece.length; j += 4) {
                    const last = i === chunks - 1 && j + 4 >= piece.length;
                    controller.enqueue(encoder.encode(frame(piece.slice(j, j + 4), last ? "stop" : null)));
                  }
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
