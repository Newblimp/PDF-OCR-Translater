/**
 * Rough estimate of the tokens (and, for models with a known price, the
 * cost) a translation run will use, shown before the user starts it. It
 * mirrors the pipeline's calls; real counts depend on the model's tokenizer,
 * its thinking and the length of the translation.
 */
import { modelPrice, requestCost } from "../llm/pricing";
import { TRANSLATION_CHUNK_TOKENS } from "./chunks";
import { DOCUMENT_ANNOTATION_MAX_IMAGES } from "./runOcr";

/** Assumed document tokens per PDF page before OCR has run. */
export const TOKENS_PER_PAGE_GUESS = 900;
/** Typical prompt tokens of one bounding-box image. */
const IMAGE_TOKENS = 1_200;
/** System prompt, task and schema around the document. */
const DOCUMENT_CALL_OVERHEAD = 2_500;
/** A translation is about as long as its source; output also carries JSON keys. */
const OUTPUT_RATIO = 1.15;

export interface EstimateInput {
  /** Estimated tokens of the text to translate. */
  sourceTokens: number;
  /** Bounding boxes with an image (0 for text input). */
  boxes: number;
  /** Text blocks are translated too (OCR'd sources only). */
  hasBlocks: boolean;
  model: string;
  inferSchema: boolean;
  sendImages: boolean;
  bboxAnnotations: boolean;
  maxBboxAnnotations: number;
  blockTranslations: boolean;
  structureOriginalAlways: boolean;
}

export interface RunEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, or null when the model's price is unknown. */
  cost: number | null;
}

export function estimateRun(input: EstimateInput): RunEstimate {
  const price = modelPrice(input.model);
  const requests: Array<{ input: number; output: number; cached: number }> = [];
  const parts = Math.max(1, Math.ceil(input.sourceTokens / TRANSLATION_CHUNK_TOKENS));
  const partTokens = input.sourceTokens / parts;
  const images = input.sendImages ? Math.min(input.boxes, DOCUMENT_ANNOTATION_MAX_IMAGES) * IMAGE_TOKENS : 0;

  if (input.inferSchema) requests.push({ input: Math.min(input.sourceTokens, 20_000) + 1_000, output: 1_500, cached: 0 });
  for (let i = 0; i < parts; i++) {
    const prompt = partTokens + DOCUMENT_CALL_OVERHEAD + images;
    requests.push({ input: prompt, output: partTokens * OUTPUT_RATIO, cached: 0 });
    // The original-language structure reads the document prefix from the prompt cache.
    if (input.structureOriginalAlways) requests.push({ input: prompt, output: partTokens * OUTPUT_RATIO, cached: partTokens + images });
  }
  if (input.bboxAnnotations) {
    for (let i = 0; i < Math.min(input.boxes, input.maxBboxAnnotations); i++) requests.push({ input: IMAGE_TOKENS + 600, output: 250, cached: 0 });
  }
  if (input.blockTranslations && input.hasBlocks) {
    requests.push({ input: input.sourceTokens * 1.2 + 500, output: input.sourceTokens * OUTPUT_RATIO, cached: 0 });
  }

  const inputTokens = Math.round(requests.reduce((n, r) => n + r.input, 0));
  const outputTokens = Math.round(requests.reduce((n, r) => n + r.output, 0));
  const cost = price ? requests.reduce((sum, r) => sum + requestCost(price, r.input, r.output, r.cached), 0) : null;
  return { calls: requests.length, inputTokens, outputTokens, cost };
}

/** "$0.004", "$0.12", "$3.40". */
export function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(value < 0.001 ? 4 : 3)}`;
  return `$${value.toFixed(2)}`;
}
