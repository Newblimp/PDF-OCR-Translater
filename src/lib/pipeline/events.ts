/** Progress reporting shared by all pipeline steps, and the steps' stages, each declared once (`STAGES`). */
import type { PipelineSettings } from "./pipeline";

/** What a translation job is about to run, which decides the stages it lists (`translationStages()`). */
export interface TranslationPlan {
  /** The job OCRs the document first ("Translate" with a PDF or an image). */
  withOcr: boolean;
  /** The text comes with its OCR result: its bounding boxes can be described and its blocks translated. */
  withBoxes: boolean;
  settings: Pick<PipelineSettings, "structured" | "bboxAnnotations" | "blockTranslations" | "structureOriginal">;
}

export interface Stage {
  /** Its title on the job status card. */
  label: string;
  /** It streams its output: the status card shows the characters received so far. */
  streams?: boolean;
  /** What it produces, as the warning names it when it fails as a follow-up (`followUps()`: "… failed: …"). */
  produces?: string;
  /** Whether a translation runs it; absent for the stages of other jobs. */
  inTranslation?: (plan: TranslationPlan) => boolean;
}

/**
 * Every stage of the pipeline, in the order the job status card lists them.
 * A new stage is an entry here (its id is the key) plus the `emit()` calls
 * of the step that runs it; `inTranslation` puts it on the card of the
 * translations that run it.
 */
export const STAGES = {
  prepare: { label: "Preparing document", inTranslation: (p) => p.withOcr },
  ocr: { label: "OCR (Mistral Document AI)", inTranslation: (p) => p.withOcr },
  infer_schema: { label: "Inferring JSON format", inTranslation: (p) => p.settings.structured },
  bbox_annotate: {
    label: "Describing bounding boxes (vision model)",
    produces: "Bounding-box descriptions",
    inTranslation: (p) => p.withBoxes && p.settings.bboxAnnotations,
  },
  translate: { label: "Document annotation: translating (vision model)", streams: true, inTranslation: (p) => p.settings.structured },
  structure_original: {
    label: "Structured text in the original language (vision model)",
    streams: true,
    produces: "Structured text in the original language",
    inTranslation: (p) => p.settings.structured && p.settings.structureOriginal === "always",
  },
  block_translate: {
    label: "Translating text blocks",
    produces: "Block translations",
    // Without the JSON output the block translations are the translation; with it, a follow-up for the OCR views.
    inTranslation: (p) => !p.settings.structured || (p.withBoxes && p.settings.blockTranslations),
  },
  region_ocr: { label: "Reading the selection again (Mistral OCR)" },
} as const satisfies Record<string, Stage>;

export type StageId = keyof typeof STAGES;

/** The stages that can run as a follow-up: the ones that name what they produce. */
export type FollowUpStage = { [K in StageId]: (typeof STAGES)[K] extends { produces: string } ? K : never }[StageId];

const STAGE_IDS = Object.keys(STAGES) as StageId[];

export function stage(id: StageId): Stage {
  return STAGES[id];
}

/** The stages a translation runs, in the status card's order. */
export function translationStages(plan: TranslationPlan): StageId[] {
  return STAGE_IDS.filter((id) => stage(id).inTranslation?.(plan) ?? false);
}

export type ProgressStatus = "start" | "progress" | "done" | "warning" | "skipped";

export interface ProgressEvent {
  stage: StageId;
  status: ProgressStatus;
  message: string;
  /** Free-form detail (counts, model names, warnings). */
  detail?: string;
  /** For streaming stages: characters received so far. */
  receivedChars?: number;
  /** For streaming stages: the text received so far (throttled). */
  streamText?: string;
  timestamp: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

export function emit(
  listener: ProgressListener | undefined,
  stage: StageId,
  status: ProgressStatus,
  message: string,
  extra: { detail?: string | undefined; receivedChars?: number | undefined; streamText?: string | undefined } = {},
): void {
  if (!listener) return;
  const event: ProgressEvent = { stage, status, message, timestamp: Date.now() };
  if (extra.detail !== undefined) event.detail = extra.detail;
  if (extra.receivedChars !== undefined) event.receivedChars = extra.receivedChars;
  if (extra.streamText !== undefined) event.streamText = extra.streamText;
  listener(event);
}
