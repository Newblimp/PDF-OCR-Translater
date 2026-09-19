/**
 * Side-effectful operations that drive the store: loading a document,
 * verifying API keys, running the pipeline. Components call these and
 * render whatever ends up in the state.
 */
import { ApiError } from "@/lib/http/apiError";
import { createProvider, PROVIDERS } from "@/lib/llm/registry";
import type { ProviderId } from "@/lib/llm/provider";
import { MistralClient } from "@/lib/mistral/client";
import { classifyFile } from "@/lib/files/fileKind";
import { fileToDataUrl } from "@/lib/files/dataUrl";
import { sha256Hex } from "@/lib/files/hash";
import { openPdfPreview } from "@/lib/files/pdfPreview";
import { emit } from "@/lib/pipeline/events";
import { ocrOnly, translateText, type PipelineContext, type PipelineSettings, type SchemaMode } from "@/lib/pipeline/pipeline";
import { buildOcrText } from "@/lib/pipeline/ocrText";
import { OCR_MAX_FILE_BYTES } from "@/lib/pipeline/runOcr";
import { clearApiKey, saveApiKey } from "@/lib/storage/apiKeys";
import { getCachedOcr, ocrCacheKey, putCachedOcr } from "@/lib/storage/ocrCache";
import { saveSettings, type Settings } from "@/lib/storage/settings";
import { applyTheme } from "@/lib/storage/theme";
import { formatBytes } from "@/lib/util/text";
import { canRunOcr, missingKeys, selectSourceText, type Action, type AppState, type DocState, type JobKind } from "./store";

export interface Runtime {
  getState(): AppState;
  dispatch(action: Action): void;
}

/** How many pages to render as thumbnails when a PDF is dropped. */
const PREVIEW_PAGES = 4;
const PREVIEW_WIDTH_PX = 260;

// -------------------------------------------------------------------- keys

/**
 * Store a key and verify it against the provider's model list (which also
 * fills the model dropdown). Returns true when the key was accepted.
 */
export async function verifyAndSaveApiKey(rt: Runtime, provider: ProviderId, key: string): Promise<boolean> {
  const trimmed = key.trim();
  if (!trimmed) {
    clearApiKey(provider);
    rt.dispatch({ type: "key/set", provider, key: null });
    return false;
  }
  rt.dispatch({ type: "key/set", provider, key: trimmed });
  rt.dispatch({ type: "key/status", provider, status: "checking" });
  try {
    const options = await createProvider(provider, trimmed).listModels();
    rt.dispatch({ type: "models/set", provider, models: options.length ? options : [...PROVIDERS[provider].fallbackModels] });
    rt.dispatch({ type: "key/status", provider, status: "valid" });
    saveApiKey(provider, trimmed);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.kind === "auth") {
      rt.dispatch({ type: "key/status", provider, status: "invalid", error: `${PROVIDERS[provider].label} rejected this key (${err.message}).` });
      return false;
    }
    // Network trouble: keep the key so the user can retry later.
    saveApiKey(provider, trimmed);
    rt.dispatch({ type: "models/set", provider, models: [...PROVIDERS[provider].fallbackModels] });
    rt.dispatch({
      type: "key/status",
      provider,
      status: "unverified",
      error: `Could not verify the ${PROVIDERS[provider].label} key: ${err instanceof Error ? err.message : String(err)}. It was saved anyway.`,
    });
    return false;
  }
}

/** Verify every key entered in the dialog; closes it when all required keys are accepted. */
export async function submitApiKeys(rt: Runtime, keys: Partial<Record<ProviderId, string>>): Promise<void> {
  await Promise.all(
    (Object.entries(keys) as Array<[ProviderId, string]>).map(([provider, key]) => {
      const current = rt.getState().keys[provider];
      if (key.trim() === (current.value ?? "") && current.status === "valid") return Promise.resolve(true);
      return verifyAndSaveApiKey(rt, provider, key);
    }),
  );
  const state = rt.getState();
  const blocking = missingKeys(state).length > 0 || Object.values(state.keys).some((k) => k.status === "invalid" && k.value);
  if (!blocking) rt.dispatch({ type: "key/dialog", open: false });
}

export function forgetApiKeys(rt: Runtime): void {
  for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
    clearApiKey(provider);
    rt.dispatch({ type: "key/set", provider, key: null });
    rt.dispatch({ type: "models/set", provider, models: [] });
  }
  rt.dispatch({ type: "key/dialog", open: true });
}

export function updateSettings(rt: Runtime, patch: Partial<Settings>): void {
  rt.dispatch({ type: "settings/update", patch });
  const settings = { ...rt.getState().settings, ...patch };
  saveSettings(settings);
  if (patch.theme) applyTheme(patch.theme);
  if (patch.provider && missingKeys(rt.getState()).length > 0) rt.dispatch({ type: "key/dialog", open: true });
}

// ---------------------------------------------------------------- document

export async function loadDocument(rt: Runtime, file: File): Promise<void> {
  const classified = classifyFile(file);
  if (!classified) {
    rt.dispatch({
      type: "error/set",
      error: { title: "Unsupported file", message: `"${file.name}" is not a PDF, image (PNG/JPEG/WebP) or text file.` },
    });
    return;
  }
  rt.getState().job?.controller.abort();

  const doc: DocState = {
    id: crypto.randomUUID(),
    file,
    name: file.name,
    size: file.size,
    kind: classified.kind,
    mimeType: classified.mimeType,
    hash: null,
    pageCount: null,
    previews: [],
    previewStatus: classified.kind === "text" ? "ready" : "loading",
    previewError: null,
    textContent: null,
  };
  rt.dispatch({ type: "doc/set", doc });
  const patch = (p: Partial<DocState>) => rt.dispatch({ type: "doc/patch", id: doc.id, patch: p });
  const stillCurrent = () => rt.getState().doc?.id === doc.id;

  if (file.size > OCR_MAX_FILE_BYTES && classified.kind !== "text") {
    rt.dispatch({
      type: "error/set",
      error: {
        title: "File too large for Mistral OCR",
        message: `${file.name} is ${formatBytes(file.size)}; the OCR API accepts up to ${formatBytes(OCR_MAX_FILE_BYTES)}.`,
      },
    });
  }

  try {
    if (classified.kind === "text") {
      const text = await file.text();
      if (stillCurrent()) patch({ textContent: text, previewStatus: "ready" });
      return;
    }

    const buffer = await file.arrayBuffer();
    // Hash and preview in parallel; both are local computations.
    const hashing = sha256Hex(buffer).then(async (hash) => {
      if (!stillCurrent()) return;
      patch({ hash });
      await restoreCachedOcr(rt, doc.id, hash);
    });

    if (classified.kind === "image") {
      patch({ previews: [URL.createObjectURL(file)], pageCount: 1, previewStatus: "ready" });
    } else {
      const preview = await openPdfPreview(buffer);
      try {
        if (!stillCurrent()) return;
        patch({ pageCount: preview.pageCount });
        const pages = Math.min(PREVIEW_PAGES, preview.pageCount);
        const previews: string[] = [];
        for (let i = 1; i <= pages; i++) {
          previews.push(await preview.renderPage(i, PREVIEW_WIDTH_PX));
          if (!stillCurrent()) return;
          patch({ previews: [...previews], previewStatus: i === pages ? "ready" : "loading" });
        }
        if (pages === 0) patch({ previewStatus: "ready" });
      } finally {
        preview.destroy();
      }
    }
    await hashing;
  } catch (err) {
    if (stillCurrent()) {
      patch({ previewStatus: "error", previewError: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function restoreCachedOcr(rt: Runtime, docId: string, hash: string): Promise<void> {
  const state = rt.getState();
  if (!state.settings.cacheOcr) return;
  const entry = await getCachedOcr(ocrCacheKey(hash, state.settings.ocrModel));
  if (!entry) return;
  if (rt.getState().doc?.id !== docId || rt.getState().ocr) return;
  rt.dispatch({
    type: "ocr/set",
    ocr: { source: "cache", model: entry.model, response: entry.response, text: buildOcrText(entry.response), docId },
  });
}

export function clearDocument(rt: Runtime): void {
  const state = rt.getState();
  state.job?.controller.abort();
  for (const url of state.doc?.previews ?? []) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  rt.dispatch({ type: "doc/clear" });
}

// --------------------------------------------------------------------- jobs

export function cancelJob(rt: Runtime): void {
  rt.getState().job?.controller.abort();
}

export async function runJob(rt: Runtime, kind: JobKind): Promise<void> {
  const state = rt.getState();
  if (state.job) return;

  const needsChat = kind !== "ocr";
  const mistralKey = state.keys.mistral.value;
  const chatKey = state.keys[state.settings.provider].value;
  if (!mistralKey || (needsChat && !chatKey)) {
    rt.dispatch({ type: "key/dialog", open: true });
    return;
  }

  const pipelineSettings = toPipelineSettings(state.settings);
  if ("error" in pipelineSettings) {
    rt.dispatch({ type: "error/set", error: pipelineSettings.error });
    return;
  }

  const controller = new AbortController();
  rt.dispatch({
    type: "job/start",
    job: { kind, startedAt: Date.now(), events: [], currentStage: "prepare", receivedChars: 0, controller },
  });
  const onProgress: PipelineContext["onProgress"] = (event) => rt.dispatch({ type: "job/event", event });
  const ctx: PipelineContext = {
    ocr: new MistralClient({ apiKey: mistralKey }),
    chat: createProvider(state.settings.provider, chatKey ?? mistralKey),
    settings: pipelineSettings,
    signal: controller.signal,
    onProgress,
  };

  try {
    let sourceText: string | null = null;

    if (kind === "ocr" || kind === "both") {
      const doc = state.doc;
      if (!doc || !canRunOcr(state)) throw new Error("Load a PDF or image first.");
      emit(onProgress, "prepare", "start", `Encoding ${doc.name} (${formatBytes(doc.size)})`);
      const dataUrl = await fileToDataUrl(doc.file, doc.mimeType);
      emit(onProgress, "prepare", "done", "Document encoded");
      const outcome = await ocrOnly(ctx, { dataUrl, mimeType: doc.mimeType, fileName: doc.name });
      controller.signal.throwIfAborted();
      rt.dispatch({
        type: "ocr/set",
        ocr: { source: "api", model: outcome.response.model, response: outcome.response, text: outcome.text, docId: doc.id },
      });
      if (kind === "ocr") rt.dispatch({ type: "tab/set", tab: "ocr" });
      if (state.settings.cacheOcr && doc.hash) {
        void putCachedOcr({
          key: ocrCacheKey(doc.hash, state.settings.ocrModel),
          fileName: doc.name,
          fileSize: doc.size,
          model: outcome.response.model,
          createdAt: Date.now(),
          response: outcome.response,
        });
      }
      sourceText = outcome.text.text;
    }

    if (kind === "translate") {
      const source = selectSourceText(state);
      if (!source) throw new Error("Nothing to translate: run OCR first, drop a text file, or paste text.");
      sourceText = source.text;
    }

    if (kind === "translate" || kind === "both") {
      if (!sourceText?.trim()) throw new Error("OCR returned no text to translate.");
      const result = await translateText(ctx, sourceText);
      controller.signal.throwIfAborted();
      rt.dispatch({
        type: "translation/set",
        translation: {
          data: result.translation.data,
          rawText: result.translation.rawText,
          schema: result.schema.schema,
          schemaSource: result.schema.source,
          schemaWarnings: result.schema.warnings,
          usage: result.translation.usage,
          inferUsage: result.schema.inferred?.usage ?? null,
          provider: state.settings.provider,
          model: result.translation.model,
          mode: result.translation.mode,
          violations: result.translation.violations,
          finishReason: result.translation.finishReason,
          targetLanguage: state.settings.targetLanguage,
          completedAt: Date.now(),
          sourceChars: sourceText.length,
        },
      });
    }
  } catch (err) {
    if (controller.signal.aborted || (err instanceof ApiError && err.kind === "aborted")) {
      // Cancelled by the user: nothing to report.
    } else {
      rt.dispatch({ type: "error/set", error: toAppError(err, jobTitle(kind)) });
    }
  } finally {
    rt.dispatch({ type: "job/end" });
  }
}

function jobTitle(kind: JobKind): string {
  return kind === "ocr" ? "OCR failed" : kind === "translate" ? "Translation failed" : "OCR + translation failed";
}

function toPipelineSettings(settings: Settings): PipelineSettings | { error: NonNullable<AppState["error"]> } {
  let schemaMode: SchemaMode;
  switch (settings.schemaMode.kind) {
    case "infer":
      schemaMode = { kind: "infer" };
      break;
    case "builtin":
      schemaMode = { kind: "builtin", id: settings.schemaMode.id };
      break;
    case "custom": {
      try {
        const parsed: unknown = JSON.parse(settings.schemaMode.schemaText || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Schema must be a JSON object");
        schemaMode = { kind: "custom", schema: parsed as Record<string, unknown> };
      } catch (err) {
        return {
          error: {
            title: "Custom schema is not valid JSON",
            message: err instanceof Error ? err.message : String(err),
            hint: "Fix the schema in Settings or switch to inferred / built-in schema.",
          },
        };
      }
      break;
    }
  }
  const info = PROVIDERS[settings.provider];
  return {
    ocrModel: settings.ocrModel,
    chatModel: settings.chatModels[settings.provider] || info.defaultModel,
    schemaMode,
    streaming: settings.streaming,
    temperature: settings.temperature,
    reasoningEffort: info.supportsReasoningEffort ? settings.reasoningEffort : undefined,
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
    domainHint: settings.domainHint,
  };
}

export function toAppError(err: unknown, title: string): NonNullable<AppState["error"]> {
  if (err instanceof ApiError) {
    const error: NonNullable<AppState["error"]> = { title, message: err.message, hint: err.hint };
    if (err.body !== undefined && err.body !== null) {
      error.details = typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2);
    }
    return error;
  }
  if (err instanceof Error) {
    const error: NonNullable<AppState["error"]> = { title, message: err.message };
    if (err.stack) error.details = err.stack;
    return error;
  }
  return { title, message: String(err) };
}
