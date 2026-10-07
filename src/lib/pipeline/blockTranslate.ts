/**
 * Translates the paragraph-level blocks returned by OCR (`include_blocks`),
 * so the bounding-box view can show each block's translation next to its
 * original text. Blocks are sent in batches as JSON and come back as JSON
 * keyed by block id, using the provider's strict structured output.
 */
import { ApiError } from "../http/apiError";
import { addUsage, emptyUsage, type ChatProvider, type ReasoningEffort, type TokenUsage } from "../llm/provider";
import { runPool } from "../util/pool";
import type { JsonSchemaObject } from "../mistral/types";
import { parseModelJson } from "../util/json";
import { emit, type ProgressListener } from "./events";
import type { OcrCleanPage, OcrText } from "./ocrText";
import { blockTranslationSystemPrompt, blockTranslationUserPrompt, type PromptContext } from "./prompts";

export interface BlockTranslateOptions extends PromptContext {
  model: string;
  reasoningEffort?: ReasoningEffort | undefined;
  concurrency?: number | undefined;
  /** Only translate these block ids (retrying the ones without a translation); every text block when undefined. */
  onlyIds?: ReadonlySet<string> | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ProgressListener | undefined;
}

export interface BlockTranslateOutcome {
  /** Translation per block id (`${pageIndex}:${blockIndex}`). */
  translations: Record<string, string>;
  usage: TokenUsage;
  /** Blocks that did not get a translation back. */
  missing: number;
}

export const BLOCK_TRANSLATIONS_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      description: "One entry per input block, same ids.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The block id exactly as given." },
          text: { type: "string", description: "The translated text (Markdown preserved)." },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

/** Id used for a block in the translations map and the bounding-box view. */
export function blockId(pageIndex: number, blockIndex: number): string {
  return `${pageIndex}:${blockIndex}`;
}

const MAX_BLOCKS_PER_BATCH = 40;
const MAX_CHARS_PER_BATCH = 12_000;

/** The blocks of a page that carry text, with the ids used for their translations. */
export function textBlocks(page: OcrCleanPage): Array<{ id: string; text: string }> {
  const items: Array<{ id: string; text: string }> = [];
  page.blocks.forEach((block, i) => {
    const text = block.content?.trim();
    if (!text || block.type === "image") return;
    items.push({ id: blockId(page.index, i), text });
  });
  return items;
}

/**
 * The page as translated Markdown, built from the per-block translations
 * (the OCR text view with the translation toggle on). Blocks without a
 * translation keep their original text so nothing disappears.
 */
export function translatedPageMarkdown(page: OcrCleanPage, translations: Record<string, string>): { text: string; total: number; translated: number } {
  const blocks = textBlocks(page);
  let translated = 0;
  const parts = blocks.map((b) => {
    const t = translations[b.id];
    if (t?.trim()) {
      translated++;
      return t.trim();
    }
    return b.text;
  });
  return { text: parts.join("\n\n"), total: blocks.length, translated };
}

export function batchBlocks(ocr: OcrText, onlyIds?: ReadonlySet<string>): Array<Array<{ id: string; text: string }>> {
  const items: Array<{ id: string; text: string }> = [];
  for (const page of ocr.pages) {
    for (const block of textBlocks(page)) if (!onlyIds || onlyIds.has(block.id)) items.push(block);
  }
  const batches: Array<Array<{ id: string; text: string }>> = [];
  let batch: Array<{ id: string; text: string }> = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length && (batch.length >= MAX_BLOCKS_PER_BATCH || chars + item.text.length > MAX_CHARS_PER_BATCH)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += item.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function translateBlocks(provider: ChatProvider, ocr: OcrText, options: BlockTranslateOptions): Promise<BlockTranslateOutcome> {
  const { onProgress } = options;
  const batches = batchBlocks(ocr, options.onlyIds);
  const total = batches.reduce((n, b) => n + b.length, 0);
  const translations: Record<string, string> = {};
  const usage = emptyUsage();
  if (total === 0) {
    emit(onProgress, "block_translate", "skipped", "No text blocks to translate");
    return { translations, usage, missing: 0 };
  }
  emit(onProgress, "block_translate", "start", `Translating ${total} text block(s) in ${batches.length} batch(es) with ${options.model}`);

  let done = 0;
  let failures = 0;
  const system = blockTranslationSystemPrompt(options);
  await runPool(batches, options.concurrency ?? 3, async (batch) => {
    try {
      const result = await provider.completeJson({
        model: options.model,
        system,
        user: blockTranslationUserPrompt(batch),
        format: { type: "json_schema", name: "block_translations", schema: BLOCK_TRANSLATIONS_SCHEMA, strict: true },
        stream: false,
        reasoningEffort: options.reasoningEffort,
        signal: options.signal,
      });
      const parsed = parseModelJson<{ translations?: Array<{ id?: unknown; text?: unknown }> }>(result.content);
      if (parsed.ok && Array.isArray(parsed.value.translations)) {
        const wanted = new Set(batch.map((b) => b.id));
        for (const t of parsed.value.translations) {
          if (typeof t.id === "string" && typeof t.text === "string" && wanted.has(t.id)) translations[t.id] = t.text;
        }
      }
      addUsage(usage, result.usage);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (err instanceof ApiError && err.kind === "auth") throw err; // a bad key fails every batch
      failures++;
      emit(onProgress, "block_translate", "warning", `A batch of ${batch.length} block(s) failed`, { detail: err instanceof Error ? err.message : String(err) });
    }
    done += batch.length;
    emit(onProgress, "block_translate", "progress", `Translated ${Math.min(done, total)} of ${total} text block(s)`);
  });

  const missing = total - Object.keys(translations).length;
  emit(onProgress, "block_translate", "done", `${total - missing} of ${total} text block(s) translated`, {
    detail: failures ? `${failures} batch(es) failed` : missing ? `${missing} block(s) without translation` : undefined,
  });
  return { translations, usage, missing };
}
