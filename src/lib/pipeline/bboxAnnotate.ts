/**
 * BBox annotation, as in Mistral's workflow: after OCR, the vision model is
 * called once per extracted bounding box with the bbox annotation format.
 * Calls run a few at a time; one failing box never fails the pipeline.
 */
import { ApiError, isImageRejection, isPermanentRejection } from "../http/apiError";
import { addUsage, emptyUsage, type ChatProvider, type ReasoningEffort, type TokenUsage } from "../llm/provider";
import { runPool } from "../util/pool";
import { parseModelJson } from "../util/json";
import { emit, type ProgressListener } from "./events";
import type { OcrBbox, OcrText } from "./ocrText";
import { bboxAnnotationSystemPrompt, bboxAnnotationUserPrompt, type PromptContext } from "./prompts";
import { BBOX_ANNOTATION_SCHEMA, type BboxAnnotationData } from "./schemas/bboxAnnotation";

export interface BboxAnnotation {
  id: string;
  pageIndex: number;
  data: BboxAnnotationData | null;
  error: string | null;
}

export interface BboxAnnotateOptions extends PromptContext {
  model: string;
  /** Upper bound on boxes annotated (cost control). */
  maxBoxes: number;
  concurrency?: number | undefined;
  /** Only describe these boxes (retrying the ones that failed); all boxes with an image when undefined. */
  onlyIds?: ReadonlySet<string> | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

export interface BboxAnnotateOutcome {
  annotations: BboxAnnotation[];
  usage: TokenUsage;
  skipped: number;
}

/** A few hundred characters of page text around the box's placeholder, for context. */
function contextFor(bbox: OcrBbox, ocr: OcrText): string {
  const page = ocr.pages.find((p) => p.index === bbox.pageIndex);
  if (!page) return "";
  const marker = `[Image: ${bbox.id}]`;
  const at = page.markdown.indexOf(marker);
  if (at === -1) return page.markdown.slice(0, 400);
  return page.markdown.slice(Math.max(0, at - 300), at + marker.length + 300);
}

/** Rate-limit failures (after the client's own retries) tolerated before the remaining boxes are skipped. */
const RATE_LIMIT_FAILURES_BEFORE_STOP = 2;

/** An error that would repeat for every box: stop scheduling the rest. */
function isSystemic(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.kind === "protocol") return true;
  return err.kind === "request" && (isPermanentRejection(err) || isImageRejection(err) || /unsupported/i.test(err.message));
}

export async function annotateBboxes(provider: ChatProvider, ocr: OcrText, options: BboxAnnotateOptions): Promise<BboxAnnotateOutcome> {
  const { onProgress, onlyIds } = options;
  const candidates = ocr.bboxes.filter((b) => b.dataUrl && (!onlyIds || onlyIds.has(b.id)));
  const targets = candidates.slice(0, onlyIds ? candidates.length : options.maxBoxes);
  const skipped = candidates.length - targets.length;
  const usage = emptyUsage();

  if (targets.length === 0) {
    emit(
      onProgress,
      "bbox_annotate",
      "skipped",
      candidates.length ? `${candidates.length} bounding box(es) skipped: the limit in Settings is 0` : "No bounding-box images to describe",
    );
    return { annotations: [], usage, skipped };
  }
  emit(onProgress, "bbox_annotate", "start", `Describing ${targets.length} bounding box(es) with ${options.model}`, {
    detail: skipped ? `${skipped} more box(es) skipped (limit in Settings)` : undefined,
  });

  const annotations: BboxAnnotation[] = targets.map((b) => ({ id: b.id, pageIndex: b.pageIndex, data: null, error: null }));
  let done = 0;
  let rateLimited = 0;
  /** Set when an error would repeat for every box (quota, unsupported model or images); remaining boxes are skipped. */
  let systemic: string | null = null;
  const system = bboxAnnotationSystemPrompt(options);
  await runPool(
    targets,
    options.concurrency ?? 4,
    async (bbox, index) => {
      const slot = annotations[index]!;
      try {
        const result = await provider.completeJson({
          model: options.model,
          system,
          user: bboxAnnotationUserPrompt(bbox.id, bbox.pageIndex + 1, contextFor(bbox, ocr)),
          images: [{ id: bbox.id, dataUrl: bbox.dataUrl! }],
          format: { type: "json_schema", name: "bbox_annotation", schema: BBOX_ANNOTATION_SCHEMA, strict: true },
          stream: false,
          reasoningEffort: options.reasoningEffort,
          signal: options.signal,
        });
        const parsed = parseModelJson<BboxAnnotationData>(result.content);
        if (parsed.ok) slot.data = parsed.value;
        else slot.error = parsed.error;
        addUsage(usage, result.usage);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (err instanceof ApiError && err.kind === "auth") throw err; // a bad key fails everything; stop now
        slot.error = err instanceof Error ? err.message : String(err);
        if (err instanceof ApiError && err.kind === "rate_limit") rateLimited++;
        if (isSystemic(err) || rateLimited >= RATE_LIMIT_FAILURES_BEFORE_STOP) systemic = slot.error;
      }
      done++;
      emit(onProgress, "bbox_annotate", "progress", `Described ${done} of ${targets.length} bounding box(es)`);
    },
    () => systemic !== null,
  );

  if (systemic) {
    for (const a of annotations) if (!a.data && !a.error) a.error = `Skipped after a systematic error: ${systemic}`;
  }
  const failed = annotations.filter((a) => a.error).length;
  emit(onProgress, "bbox_annotate", failed ? "warning" : "done", `${annotations.length - failed} of ${annotations.length} bounding box(es) described`, {
    detail: failed ? `${failed} failed: ${annotations.find((a) => a.error)?.error ?? ""}` : undefined,
  });
  if (failed) emit(onProgress, "bbox_annotate", "done", "Bounding-box descriptions finished");
  return { annotations, usage, skipped };
}
