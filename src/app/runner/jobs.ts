/**
 * What every job shares: `withJob()` starts one (keys and settings checked,
 * the pipeline context built) and always ends it (its error shown unless it
 * was cancelled); cancelling it; steps whose failure only leaves a warning.
 */
import { ApiError } from "@/lib/http/apiError";
import { createProvider, effortFor, PROVIDERS } from "@/lib/llm/registry";
import type { OcrClient } from "@/lib/mistral/client";
import { emit, type StageId } from "@/lib/pipeline/events";
import type { PipelineContext, PipelineSettings, SchemaMode } from "@/lib/pipeline/pipeline";
import type { Settings } from "@/lib/storage/settings";
import { isPlainObject } from "@/lib/util/json";
import { usableKey, type AppError, type JobKind, type TranslationState } from "../store";
import type { Runtime } from "./runtime";

export function cancelJob(rt: Runtime): void {
  rt.getState().job?.controller.abort();
}

/** A job to run: its kind, the stages its status card lists, whether it needs the translation provider's key. */
export interface JobSpec {
  kind: JobKind;
  stages: StageId[];
  needsChat: boolean;
  /** The translation the job adds to (original-language structure, retries); see `beginJob()`. */
  forTranslation?: TranslationState | undefined;
}

/** A running job, as `withJob()` hands it to its work. */
export interface Job {
  kind: JobKind;
  ctx: PipelineContext;
  controller: AbortController;
  /** Id of the translation this job put on screen, once it has. */
  producedId?: string;
}

/**
 * Run `work` as a job, unless one is running or it cannot start (a key is
 * missing, the settings are invalid: the reason is shown and `work` does not
 * run). The job always ends, whatever `work` does: when it throws, the error
 * is shown (titled by the job's kind) unless the job was cancelled, and the
 * stages still running in the background are stopped.
 */
export async function withJob(rt: Runtime, spec: JobSpec, work: (job: Job) => Promise<void>): Promise<void> {
  const job = beginJob(rt, spec);
  if (!job) return;
  try {
    await work(job);
    endJob(rt, job);
  } catch (err) {
    endJob(rt, job, err);
  }
}

/**
 * Check keys and settings and start a job in the store; null when it cannot
 * start (the reason is shown). `forTranslation` runs a job that adds to that
 * translation (original-language structure, retries) in its own target
 * language, whatever Settings say now, with the provider and model from
 * Settings (so picking another model there recovers from a failing one);
 * such jobs do not use the schema setting.
 */
function beginJob(rt: Runtime, { kind, stages, needsChat, forTranslation }: JobSpec): Job | null {
  const state = rt.getState();
  if (state.job) return null;
  let settings = state.settings;
  // Editing boxes uses OCR only: an invalid custom schema in Settings must not block it.
  if (kind === "edit") settings = { ...settings, schemaMode: { kind: "infer" } };
  if (forTranslation) {
    settings = {
      ...settings,
      targetLanguage: forTranslation.targetLanguage as Settings["targetLanguage"],
      // Its schema travels with the translation; an invalid custom schema in Settings must not block it.
      schemaMode: { kind: "infer" },
    };
  }
  const mistralKey = usableKey(state.keys, "mistral");
  const chatKey = usableKey(state.keys, settings.provider);
  const needsOcr = kind === "ocr" || kind === "both" || kind === "edit";
  if ((needsOcr && !mistralKey) || (needsChat && !chatKey)) {
    rt.dispatch({ type: "key/dialog", open: true });
    return null;
  }
  const pipelineSettings = toPipelineSettings(settings);
  if ("error" in pipelineSettings) {
    rt.dispatch({ type: "error/set", error: pipelineSettings.error });
    return null;
  }
  const controller = new AbortController();
  rt.dispatch({ type: "job/start", job: { kind, startedAt: Date.now(), stages, events: [], receivedChars: {}, streamText: "", controller } });
  return {
    kind,
    controller,
    ctx: {
      ocr: ocrClient(mistralKey ?? ""),
      chat: createProvider(settings.provider, chatKey ?? mistralKey ?? ""),
      settings: pipelineSettings,
      signal: controller.signal,
      onProgress: (event) => rt.dispatch({ type: "job/event", event }),
    },
  };
}

/** Mistral OCR with this key; the client (and the HTTP layer) is imported with the first request. */
function ocrClient(apiKey: string): OcrClient {
  return {
    async ocr(request, signal) {
      const { MistralClient } = await import("@/lib/mistral/client");
      return new MistralClient({ apiKey }).ocr(request, signal);
    },
  };
}

/** Report a job's failure (`err`) unless it was cancelled; always ends the job. */
function endJob(rt: Runtime, job: Job, err?: unknown): void {
  if (err !== undefined) {
    // A translation whose job was cancelled or failed after it appeared gets no automatic follow-up: the user decides.
    if (job.producedId) rt.session.originalRequested.add(job.producedId);
    if (!isCancellation(err, job)) {
      rt.dispatch({ type: "error/set", error: toAppError(err, JOB_TITLES[job.kind]) });
      job.controller.abort(); // stop stages still running in the background
    }
  }
  rt.dispatch({ type: "job/end" });
}

function isCancellation(err: unknown, job: Job): boolean {
  return job.controller.signal.aborted || (err instanceof ApiError && err.kind === "aborted");
}

/** Runs a step whose failure leaves a warning (collected in `warnings`) on the result instead of failing the job. */
export function followUps(job: Job, warnings: string[]) {
  return <T>(stage: StageId, label: string, task: Promise<T | null>): Promise<T | null> =>
    task.catch((err: unknown) => {
      if (isCancellation(err, job)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${label} failed: ${message}`);
      emit(job.ctx.onProgress, stage, "warning", `${label} failed`, { detail: message });
      emit(job.ctx.onProgress, stage, "done", "Stopped; the translation is unaffected");
      return null;
    });
}

/** The error title of a job of each kind. */
const JOB_TITLES: Record<JobKind, string> = {
  ocr: "OCR failed",
  translate: "Translation failed",
  both: "OCR + translation failed",
  original: "Structured text in the original language failed",
  retry: "Retry failed",
  edit: "Editing the bounding boxes failed",
};

function toPipelineSettings(settings: Settings): PipelineSettings | { error: AppError } {
  // Inferred and built-in schemas are named the same way in both; a custom one is parsed here.
  let schemaMode: SchemaMode;
  if (settings.schemaMode.kind !== "custom") schemaMode = settings.schemaMode;
  else {
    try {
      const parsed: unknown = JSON.parse(settings.schemaMode.schemaText || "{}");
      if (!isPlainObject(parsed)) throw new Error("Schema must be a JSON object");
      schemaMode = { kind: "custom", schema: parsed };
    } catch (err) {
      return {
        error: {
          title: "Custom schema is not valid JSON",
          message: err instanceof Error ? err.message : String(err),
          hint: "Fix the schema in Settings or switch to inferred / built-in schema.",
        },
      };
    }
  }
  const info = PROVIDERS[settings.provider];
  return {
    ocrModel: settings.ocrModel,
    chatModel: settings.chatModels[settings.provider] || info.defaultModel,
    structured: settings.jsonOutput,
    schemaMode,
    streaming: settings.streaming,
    temperature: settings.temperature,
    reasoningEffort: info.supportsReasoningEffort ? effortFor(settings.provider, settings.reasoningEffort) : undefined,
    maxOutputTokens: settings.maxOutputTokens ?? undefined,
    sendImages: settings.sendImages,
    bboxAnnotations: settings.bboxAnnotations,
    maxBboxAnnotations: settings.maxBboxAnnotations,
    blockTranslations: settings.blockTranslations,
    structureOriginal: settings.structureOriginal,
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
    domainHint: settings.domainHint,
    glossary: settings.glossary,
  };
}

export function toAppError(err: unknown, title: string): AppError {
  if (err instanceof ApiError) {
    const error: AppError = { title, message: err.message, hint: err.hint };
    if (err.body !== undefined && err.body !== null) {
      error.details = typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2);
    }
    return error;
  }
  if (err instanceof Error) {
    const error: AppError = { title, message: err.message };
    if (err.stack) error.details = err.stack;
    return error;
  }
  return { title, message: String(err) };
}
