/**
 * BBox annotation, as in Mistral's workflow: after OCR, the vision model is
 * called once per extracted bounding box with the bbox annotation format.
 * Calls run a few at a time; one failing box never fails the pipeline.
 */
import { ApiError } from "../http/apiError";
import type { ChatProvider, ReasoningEffort, TokenUsage } from "../llm/provider";
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

export async function annotateBboxes(provider: ChatProvider, ocr: OcrText, options: BboxAnnotateOptions): Promise<BboxAnnotateOutcome> {
  const { onProgress } = options;
  const candidates = ocr.bboxes.filter((b) => b.dataUrl);
  const targets = candidates.slice(0, options.maxBoxes);
  const skipped = candidates.length - targets.length;
  const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

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
  let next = 0;
  /** Set when an error would repeat for every box (auth, quota, unsupported model); remaining boxes are skipped. */
  let systemic: string | null = null;
  const worker = async () => {
    while (next < targets.length && !systemic) {
      const index = next++;
      const bbox = targets[index]!;
      const slot = annotations[index]!;
      try {
        const result = await provider.completeJson({
          model: options.model,
          system: bboxAnnotationSystemPrompt(options),
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
        usage.prompt_tokens = (usage.prompt_tokens ?? 0) + (result.usage?.prompt_tokens ?? 0);
        usage.completion_tokens = (usage.completion_tokens ?? 0) + (result.usage?.completion_tokens ?? 0);
        usage.total_tokens = (usage.total_tokens ?? 0) + (result.usage?.total_tokens ?? 0);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (err instanceof ApiError && err.kind === "auth") throw err; // a bad key fails everything; stop now
        slot.error = err instanceof Error ? err.message : String(err);
        if (err instanceof ApiError && (err.kind === "rate_limit" || err.kind === "protocol" || (err.kind === "request" && /unsupported|model_not_found|does not exist|do not have access|invalid model|image|vision/i.test(err.message)))) {
          systemic = slot.error;
        }
      }
      done++;
      emit(onProgress, "bbox_annotate", "progress", `Described ${done} of ${targets.length} bounding box(es)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, targets.length) }, worker));

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
