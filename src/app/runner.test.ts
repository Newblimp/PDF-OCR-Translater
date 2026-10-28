// @vitest-environment jsdom
/**
 * The runner's jobs against the real store and pipeline, with the network
 * replaced: Mistral OCR and the chat provider are fakes, saved translations
 * live in memory. The e2e suite drives the same flows through the browser;
 * these show a runner change working (or not) in a second.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatProvider, JsonChatRequest, JsonChatResult } from "@/lib/llm/provider";
import type { OcrRequest, OcrResponse } from "@/lib/mistral/types";
import type { SavedTranslation } from "@/lib/storage/history";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/storage/settings";
import type { ProgressEvent } from "@/lib/pipeline/events";
import { createStore, type Store } from "@/lib/util/createStore";
import { cancelJob, createRuntime, deleteSaved, retryFailed, runJob, type Runtime } from "./runner";
import { retryLastJob, withJob } from "./runner/jobs";
import { initialState, reducer, type Action, type AppState, type DocState, type TranslationState } from "./store";

/** What the fake chat provider answers; a test replaces it to fail or hold a step. */
let answer: (request: JsonChatRequest) => Promise<JsonChatResult>;
const chatRequests: JsonChatRequest[] = [];
/** What the fake Mistral OCR answers (`OCR_RESPONSE` unless a test changes it). */
let ocrResponse: OcrResponse;
const ocrRequests: OcrRequest[] = [];
const saved = new Map<string, SavedTranslation<TranslationState>>();

vi.mock("@/lib/llm/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/registry")>()),
  createProvider: (id: ChatProvider["id"]): ChatProvider => ({
    id,
    label: "Fake",
    listModels: async () => [],
    completeJson: (request) => {
      chatRequests.push(request);
      return answer(request);
    },
  }),
}));

vi.mock("@/lib/mistral/client", () => ({
  MistralClient: class {
    async ocr(request: OcrRequest): Promise<OcrResponse> {
      ocrRequests.push(request);
      return ocrResponse;
    }
  },
}));

vi.mock("@/lib/storage/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/history")>()),
  listSavedTranslations: async () => [...saved.values()].map(({ translation: _t, version: _v, ...summary }) => summary),
  findSavedTranslation: async () => null,
  putSavedTranslation: async (entry: SavedTranslation<TranslationState>) => void saved.set(entry.id, structuredClone(entry)),
  deleteSavedTranslation: async (id: string) => void saved.delete(id),
}));

const block = (type: string, y: number, content: string, image_id?: string) => ({
  type,
  top_left_x: 100,
  top_left_y: y,
  bottom_right_x: 900,
  bottom_right_y: y + 50,
  content,
  ...(image_id ? { image_id } : {}),
});

const OCR_RESPONSE: OcrResponse = {
  model: "mistral-ocr-latest",
  pages: [
    {
      index: 0,
      markdown: "# 通知书\n\n![img-0.jpeg](img-0.jpeg)\n\n权利要求1不具备创造性。",
      images: [{ id: "img-0.jpeg", top_left_x: 100, top_left_y: 300, bottom_right_x: 500, bottom_right_y: 600, image_base64: "data:image/png;base64,AA==" }],
      dimensions: { dpi: 200, width: 1000, height: 1400 },
      header: "国家知识产权局",
      blocks: [
        block("header", 10, "国家知识产权局"),
        block("title", 100, "通知书"),
        block("image", 300, "", "img-0.jpeg"),
        block("text", 700, "权利要求1不具备创造性。"),
      ],
    },
  ],
  usage_info: { pages_processed: 1 },
};

/** The fake model: every block translated as "[EN] …", every box described. */
async function translateEverything(request: JsonChatRequest): Promise<JsonChatResult> {
  const name = request.format.type === "json_schema" ? request.format.name : "";
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (name === "block_translations") {
    const blocks = JSON.parse(request.user.slice(request.user.indexOf("["))) as Array<{ id: string; text: string }>;
    return {
      content: JSON.stringify({ translations: blocks.map((b) => ({ id: b.id, text: `[EN] ${b.text}` })) }),
      finishReason: "stop",
      usage,
      model: request.model,
    };
  }
  if (name === "bbox_annotation") {
    const description = { image_type: "stamp", short_description: "A seal.", summary: "A red seal.", text_in_image: "", text_translated: "" };
    return { content: JSON.stringify(description), finishReason: "stop", usage, model: request.model };
  }
  throw new Error(`unexpected request: ${name || request.format.type}`);
}

/** A runtime of its own (store and session) with a PDF loaded; it can also be subscribed to. */
function loadedStore(settings: Partial<Settings> = {}): Store<AppState, Action> & Runtime {
  const store = createStore(reducer, initialState({ mistral: "mistral-key", anthropic: null, openai: null }, { ...DEFAULT_SETTINGS, ...settings }));
  const doc: DocState = {
    id: "doc-1",
    file: new File(["%PDF-1.4"], "notice.pdf", { type: "application/pdf" }),
    name: "notice.pdf",
    size: 8,
    kind: "pdf",
    mimeType: "application/pdf",
    hash: "hash-1",
    pageCount: 1,
    previews: [],
    previewStatus: "ready",
    previewError: null,
    textContent: null,
    pageSelection: "",
  };
  store.dispatch({ type: "doc/set", doc });
  return { ...store, ...createRuntime(store) };
}

/** Every progress event of the jobs run on `store` from now on. */
function recordEvents(store: Store<AppState, Action>): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  store.subscribe(() => {
    const last = store.getState().job?.events.at(-1);
    if (last && events.at(-1) !== last) events.push(last);
  });
  return events;
}

beforeEach(() => {
  answer = translateEverything;
  ocrResponse = OCR_RESPONSE;
  chatRequests.length = 0;
  ocrRequests.length = 0;
  saved.clear();
  localStorage.clear();
});

describe("Translate a PDF without the JSON output", () => {
  it("OCRs the document, translates the blocks the OCR text tab keeps, describes the boxes and saves the result", async () => {
    const store = loadedStore();
    const events = recordEvents(store);
    await runJob(store, "both");

    const { translation, job, error, ocr } = store.getState();
    expect(error).toBeNull();
    expect(job).toBeNull();
    expect(ocrRequests).toHaveLength(1);
    expect(ocrRequests[0]).toMatchObject({ include_blocks: true, include_image_base64: true });
    expect(ocr?.source).toBe("api");
    // The header block is left out by default (Settings.ocrHiddenTypes); the image is described, not translated.
    expect(translation?.blockTranslations).toEqual({ "0:1": "[EN] 通知书", "0:3": "[EN] 权利要求1不具备创造性。" });
    expect(translation?.bboxAnnotations).toMatchObject([{ id: "img-0.jpeg", data: { image_type: "stamp" }, error: null }]);
    expect(translation).toMatchObject({
      schema: null,
      data: null,
      provider: "mistral",
      model: "mistral-small-latest",
      warnings: [],
      ocrKey: "hash-1:mistral-ocr-latest",
    });
    expect(translation?.blockUsage?.total_tokens).toBe(15);
    // Each stage's last word: all done.
    expect(Object.fromEntries(events.map((e) => [e.stage, e.status]))).toEqual({
      prepare: "done",
      ocr: "done",
      bbox_annotate: "done",
      block_translate: "done",
    });
    expect([...saved.values()].map((s) => s.translation.id)).toEqual([translation?.id]);
  });

  it("leaves a warning on the translation when the box descriptions fail", async () => {
    const store = loadedStore();
    answer = async (request) => {
      if (request.format.type === "json_schema" && request.format.name === "bbox_annotation") throw new Error("vision unavailable");
      return translateEverything(request);
    };
    await runJob(store, "both");
    const { translation, error } = store.getState();
    expect(error).toBeNull();
    expect(translation?.blockTranslations["0:3"]).toBe("[EN] 权利要求1不具备创造性。");
    expect(translation?.bboxAnnotations).toMatchObject([{ id: "img-0.jpeg", data: null, error: "vision unavailable" }]);
  });

  it("keeps what was translated when the job is cancelled, without an error", async () => {
    // 45 text blocks: two batches; the second one waits until the job is cancelled.
    ocrResponse = {
      ...OCR_RESPONSE,
      pages: [{ ...OCR_RESPONSE.pages[0]!, images: [], blocks: Array.from({ length: 45 }, (_, i) => block("text", i * 10, `第${i}段`)) }],
    };
    const store = loadedStore({ bboxAnnotations: false });
    let batch = 0;
    answer = (request) => {
      if (++batch === 1) return translateEverything(request);
      return new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    };
    const running = runJob(store, "both");
    await vi.waitFor(() => expect(chatRequests).toHaveLength(2));
    cancelJob(store);
    await running;
    const { translation, error, job } = store.getState();
    expect(error).toBeNull();
    expect(job).toBeNull();
    expect(Object.keys(translation?.blockTranslations ?? {})).toHaveLength(40);
    expect(saved.size).toBe(1);

    // "Translate the blocks now": only the five that are missing, merged in.
    answer = translateEverything;
    chatRequests.length = 0;
    await retryFailed(store, "blocks");
    expect(chatRequests).toHaveLength(1);
    expect(JSON.parse(chatRequests[0]!.user.slice(chatRequests[0]!.user.indexOf("["))) as unknown[]).toHaveLength(5);
    expect(Object.keys(store.getState().translation?.blockTranslations ?? {})).toHaveLength(45);
  });
});

describe("saved translations", () => {
  it("does not write back a translation the user deleted, for as long as the runtime lives", async () => {
    const store = loadedStore();
    answer = async (request) => {
      if (request.format.type === "json_schema" && request.format.name === "bbox_annotation") throw new Error("vision unavailable");
      return translateEverything(request);
    };
    await runJob(store, "both");
    const id = store.getState().translation!.id;
    expect([...saved.keys()]).toEqual([id]);
    await deleteSaved(store, id);
    expect(saved.size).toBe(0);

    // Retrying the box that failed changes the translation on screen; it stays deleted.
    answer = translateEverything;
    await retryFailed(store, "bboxes");
    expect(store.getState().translation?.bboxAnnotations[0]?.data).not.toBeNull();
    expect(saved.size).toBe(0);
    // What a runtime remembers is its own: another one (a reload) saves it again.
    store.dispatch({ type: "translation/patch", patch: { bboxAnnotations: [{ id: "img-0.jpeg", pageIndex: 0, data: null, error: "again" }] } });
    await retryFailed(createRuntime(store), "bboxes");
    expect([...saved.keys()]).toEqual([id]);
  });
});

describe("withJob", () => {
  const spec = { kind: "translate", stages: ["block_translate"], needsChat: true } as const;
  const stages = [...spec.stages];

  it("ends the job whatever the work does, showing an error unless the job was cancelled", async () => {
    const store = loadedStore();
    let running: AppState["job"] = null;
    await withJob(store, { ...spec, stages }, async () => {
      running = store.getState().job;
    });
    expect(running).toMatchObject({ kind: "translate", stages: ["block_translate"] });
    // Stages can be told from the settings the job runs with.
    await withJob(store, { ...spec, stages: (settings) => (settings.structured ? ["translate"] : ["block_translate", "bbox_annotate"]) }, async () => {
      running = store.getState().job;
    });
    expect(running).toMatchObject({ stages: ["block_translate", "bbox_annotate"] });
    expect(store.getState()).toMatchObject({ job: null, error: null });

    let signal: AbortSignal | undefined;
    await withJob(store, { ...spec, stages }, async ({ controller }) => {
      signal = controller.signal;
      throw new Error("the model said no");
    });
    expect(store.getState().job).toBeNull();
    expect(store.getState().error).toMatchObject({ title: "Translation failed", message: "the model said no" });
    expect(signal?.aborted).toBe(true); // stages still running in the background stop

    store.dispatch({ type: "error/set", error: null });
    await withJob(store, { ...spec, stages }, async ({ controller }) => {
      cancelJob(store);
      controller.signal.throwIfAborted();
    });
    expect(store.getState()).toMatchObject({ job: null, error: null });
  });

  it("does not run the work while another job runs, or without the keys it needs", async () => {
    const store = loadedStore();
    let ran = 0;
    const work = async () => void ran++;
    await withJob(store, { ...spec, stages }, async () => {
      await withJob(store, { ...spec, stages }, work); // one job at a time
    });
    expect(ran).toBe(0);
    await withJob(store, { ...spec, stages, kind: "edit" }, work);
    expect(ran).toBe(1);

    store.dispatch({ type: "settings/update", patch: { provider: "openai" } }); // no OpenAI key
    await withJob(store, { ...spec, stages }, work);
    expect(ran).toBe(1);
    expect(store.getState()).toMatchObject({ job: null, keyDialogOpen: true });
  });

  it("offers to run a failed job again, as it was, and only that job", async () => {
    const store = loadedStore();
    let runs = 0;
    const job = async () =>
      withJob(store, { ...spec, stages, again: job }, async () => {
        if (++runs === 1) throw new Error("not yet");
      });
    await job();
    expect(store.getState().error).toMatchObject({ message: "not yet", retryable: true });
    await retryLastJob(store);
    expect(runs).toBe(2);
    expect(store.getState().error).toBeNull();
    await retryLastJob(store); // nothing left to retry
    expect(runs).toBe(2);
    // A job that cannot be repeated offers no retry.
    await withJob(store, { ...spec, stages }, async () => {
      throw new Error("once");
    });
    expect(store.getState().error).not.toHaveProperty("retryable");
  });
});
