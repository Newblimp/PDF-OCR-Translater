/** Progress reporting shared by all pipeline steps. */

export type StageId = "prepare" | "ocr" | "infer_schema" | "translate";

export const STAGE_LABELS: Record<StageId, string> = {
  prepare: "Preparing document",
  ocr: "OCR (Mistral Document AI)",
  infer_schema: "Inferring JSON format",
  translate: "Translating",
};

export type ProgressStatus = "start" | "progress" | "done" | "warning" | "skipped";

export interface ProgressEvent {
  stage: StageId;
  status: ProgressStatus;
  message: string;
  /** Free-form detail (counts, model names, warnings). */
  detail?: string;
  /** For streaming stages: characters received so far. */
  receivedChars?: number;
  timestamp: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

export function emit(
  listener: ProgressListener | undefined,
  stage: StageId,
  status: ProgressStatus,
  message: string,
  extra: { detail?: string | undefined; receivedChars?: number | undefined } = {},
): void {
  if (!listener) return;
  const event: ProgressEvent = { stage, status, message, timestamp: Date.now() };
  if (extra.detail !== undefined) event.detail = extra.detail;
  if (extra.receivedChars !== undefined) event.receivedChars = extra.receivedChars;
  listener(event);
}
