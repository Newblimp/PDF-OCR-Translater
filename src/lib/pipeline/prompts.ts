/**
 * All prompts live here so they can be tuned in one place.
 *
 * The document calls (schema inference, translation, structure in the
 * original language) share one system prompt and put the document first in
 * the user message (`documentContext()`), before the bounding-box images;
 * the task comes last. Within a run the system prompt, the document and the
 * images are identical, so providers can serve that prefix from their prompt
 * cache (Anthropic gets an explicit breakpoint, OpenAI caches automatically).
 *
 * The chat prompts mention "JSON" explicitly: `json_object` mode requires
 * the word to appear in the conversation.
 */
import { pageDelimiter } from "./ocrText";

export interface PromptContext {
  /** e.g. "English" */
  targetLanguage: string;
  /** e.g. "Chinese" or "auto" */
  sourceLanguage: string;
  /** Free-text hint about the document family, shown to the model. */
  domainHint: string;
  /** Required terminology, one `source = target` pair per line (optional). */
  glossary?: string | undefined;
}

export const DEFAULT_DOMAIN_HINT =
  "Official communications from a patent office (for example CNIPA, the China National Intellectual Property Administration): office actions, notifications, decisions and similar correspondence to applicants or agents.";

/** Characters of document text used for schema inference (a sample is enough). */
export const SCHEMA_INFERENCE_SAMPLE_CHARS = 60_000;

function sourceClause(sourceLanguage: string): string {
  return sourceLanguage.trim().toLowerCase() === "auto" || !sourceLanguage.trim()
    ? "the source language (detect it automatically)"
    : sourceLanguage.trim();
}

/** Glossary entries as `source = target` pairs; blank lines and `#` comments are ignored. */
export function parseGlossary(glossary: string | undefined): Array<{ source: string; target: string }> {
  const entries: Array<{ source: string; target: string }> = [];
  for (const raw of (glossary ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(.+?)\s*(?:=>|=|→|\t)\s*(.+)$/.exec(line);
    if (match) entries.push({ source: match[1]!.trim(), target: match[2]!.trim() });
  }
  return entries;
}

function glossaryLines(ctx: PromptContext): string[] {
  const entries = parseGlossary(ctx.glossary);
  if (!entries.length) return [];
  return [
    "",
    `Glossary: when a source term below occurs, always translate it with the given ${ctx.targetLanguage} term.`,
    ...entries.map((e) => `- ${e.source} → ${e.target}`),
  ];
}

/**
 * Shared system prompt of the document calls. It depends only on the
 * settings, never on the document or the task, so it stays byte-identical
 * across the calls of a run (a cacheable prefix).
 */
export function documentSystemPrompt(ctx: PromptContext): string {
  return [
    "You work on official documents in a translation workflow, as a vision model. Each request gives you the OCR text of a document (Markdown) and, when available, images of its bounding boxes (figures, stamps, seals, signatures, tables rendered as images). The task to perform comes last in the request: follow it exactly and output JSON only.",
    "",
    `Document family: ${ctx.domainHint}`,
    `Source language: ${sourceClause(ctx.sourceLanguage)}. Target language of the translation: ${ctx.targetLanguage}.`,
    ...glossaryLines(ctx),
    "",
    "Conventions of the input:",
    '- "[Image: id]" placeholders mark where a bounding box sits in the text; the attached images carry the same ids. Never reproduce the placeholders themselves.',
    `- Page delimiters like "${pageDelimiter(1)}" are not content; never reproduce them.`,
  ].join("\n");
}

export interface DocumentPart {
  /** 0-based index of this part. */
  index: number;
  count: number;
  /** e.g. "pages 3-5". */
  label?: string | undefined;
}

/**
 * The document as the first part of the user message: the shared, cacheable
 * prefix (followed by the images). `part` marks one chunk of a long document.
 */
export function documentContext(documentText: string, attachedImageIds: string[] = [], part?: DocumentPart): string {
  const lines: string[] = [];
  if (part && part.count > 1) {
    lines.push(
      `This is part ${part.index + 1} of ${part.count} of a longer document${part.label ? ` (${part.label})` : ""}. Work on this part only: fill the fields with what this part contains and leave fields for content found elsewhere empty. The parts are merged afterwards.`,
      "",
    );
  }
  if (attachedImageIds.length) {
    lines.push(
      `Attached after the text: ${attachedImageIds.length} bounding-box image(s) extracted by the OCR model, with ids ${attachedImageIds.map((id) => `"${id}"`).join(", ")}.`,
      "",
    );
  }
  lines.push("Document (OCR text, Markdown):", "<document>", documentText, "</document>");
  return lines.join("\n");
}

/** Context for schema inference: the document, or its beginning when it is long. */
export function schemaInferenceContext(documentText: string): string {
  if (documentText.length <= SCHEMA_INFERENCE_SAMPLE_CHARS) return documentContext(documentText);
  return documentContext(`${documentText.slice(0, SCHEMA_INFERENCE_SAMPLE_CHARS)}\n\n[... document truncated for schema design ...]`);
}

export function schemaInferenceInstruction(ctx: PromptContext): string {
  return [
    "Task: design a JSON Schema that describes the structure of the document above, so that a translator can later fill every field with translated text.",
    `The translation will be into ${ctx.targetLanguage}.`,
    "",
    "Return ONLY one JSON object: a JSON Schema for the document. No prose, no Markdown fences.",
    "",
    "Requirements for the schema:",
    '- Root: {"type":"object","properties":{...},"required":[...]} listing every property in `required`.',
    "- Keys in English snake_case. Each property has a concise English `description` that says what goes in it.",
    "- Cover ALL the document's content, in reading order, so nothing is lost when the fields are filled: identification data (issuing authority, document type/title, application and publication numbers, applicant, agent, examiner, dates, response deadlines, form/reference codes), the complete body text split into meaningful sections, per-claim findings, cited references, legal provisions, instructions to the recipient, and any tables or lists.",
    "- Use arrays of objects for repeated structures (sections, objections per claim, cited references, list items).",
    "- Prefer 8 to 30 well-named fields. Nest at most 3 levels deep.",
    "- Allowed types only: string, number, boolean, object, array. Dates are strings. Do NOT use enum, oneOf, anyOf, allOf, $ref, pattern, format, minimum, maximum or default.",
    "- Long passages are string fields that will hold Markdown (lists and tables preserved).",
    "- Always include `summary` (string) and `notes_for_reader` (string, for illegible or uncertain passages).",
    "- If the text contains `[Image: ...]` placeholders (figures, stamps, signatures, seals), include a `figures` array of objects (id, description) so their content can be captured.",
    "- Do not invent fields for content that is absent from the document.",
  ].join("\n");
}

function schemaBlock(schemaJson: string): string[] {
  return ["", "JSON Schema of the expected output:", "```json", schemaJson, "```"];
}

/**
 * Document annotation (Mistral's workflow, performed by the vision model):
 * OCR Markdown + the first bounding-box images + the JSON format → JSON.
 * Here the JSON is also the translation.
 */
export function translationInstruction(ctx: PromptContext, schemaJson: string): string {
  return [
    `Task: you are a professional legal and patent translator. Translate the document above from ${sourceClause(ctx.sourceLanguage)} into ${ctx.targetLanguage} and return the result as a JSON object that follows the JSON Schema below exactly.`,
    "",
    "Translation rules:",
    "- Translate faithfully and completely. Do not summarise or omit passages unless a field's description explicitly asks for a summary.",
    "- Every passage of the source must end up, translated, in the most relevant field. If nothing fits, use the closest section-like field rather than dropping content.",
    "- Keep identifiers verbatim: application, publication and reference numbers, claim numbers, form codes, addresses in the original script where customary.",
    "- Use the established official terminology of the target language for legal provisions and institutions (e.g. 'Patent Law of the People's Republic of China, Article 22, Paragraph 3'). Glossary terms take precedence.",
    "- Dates: use ISO 8601 (YYYY-MM-DD) when the date is unambiguous; otherwise keep the original wording.",
    "- Inside string fields, preserve numbering, bullet lists and Markdown tables from the source.",
    "- Read text inside the attached images (stamps, seals, handwritten notes, figure labels, tables) and translate it into the relevant field; describe non-text figures briefly where the schema has a place for them.",
    "- For data the document does not contain, use an empty string, an empty array or 0. Never invent facts.",
    "- Note illegible or uncertain passages in `notes_for_reader` when such a field exists.",
    "- Output JSON only.",
    ...schemaBlock(schemaJson),
  ].join("\n");
}

/**
 * Same call, but the JSON keeps the document's own language: it is the
 * "Structured text" view with the translation toggle switched off.
 */
export function originalStructureInstruction(ctx: PromptContext, schemaJson: string): string {
  return [
    `Task: you are a document analyst. Put the content of the document above into a JSON object that follows the JSON Schema below exactly, keeping every passage in ${sourceClause(ctx.sourceLanguage)}.`,
    "",
    "Rules:",
    `- Do NOT translate. Never write ${ctx.targetLanguage} where the document uses another language; copy the wording of the source, only re-arranged into the JSON fields. Ignore the glossary.`,
    "- Transcribe faithfully and completely. Do not summarise or omit passages unless a field's description explicitly asks for a summary.",
    "- Every passage of the source must end up in the most relevant field. If nothing fits, use the closest section-like field rather than dropping content.",
    "- Keep identifiers, numbers and dates exactly as printed.",
    "- Inside string fields, preserve numbering, bullet lists and Markdown tables from the source.",
    "- Transcribe text inside the attached images (stamps, seals, handwritten notes, figure labels, tables) in its original script; describe non-text figures briefly, in the document's language, where the schema has a place for them.",
    "- For data the document does not contain, use an empty string, an empty array or 0. Never invent facts.",
    "- Field names stay as the schema spells them; only the values are in the document's language.",
    "- Output JSON only.",
    ...schemaBlock(schemaJson),
  ].join("\n");
}

/** BBox annotation (Mistral's workflow, performed by the vision model): one call per bounding box. */
export function bboxAnnotationSystemPrompt(ctx: PromptContext): string {
  return [
    `You describe one image that the OCR model cut out of a document. Document family: ${ctx.domainHint}`,
    `Write all text in ${ctx.targetLanguage}. If the image contains text (a stamp, seal, signature block, handwritten note, table or figure labels), transcribe it in the original script where relevant and translate it into ${ctx.targetLanguage}.`,
    ...glossaryLines(ctx),
    "Return JSON only, following the provided schema.",
  ].join("\n");
}

export function bboxAnnotationUserPrompt(imageId: string, pageNumber: number, context: string): string {
  return [
    `Image "${imageId}" from page ${pageNumber}.`,
    context ? `Surrounding text (for context only):\n<context>\n${context}\n</context>` : "",
    "Describe this image according to the JSON schema.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Block translation for the bounding-box view: batches of OCR blocks as JSON. */
export function blockTranslationSystemPrompt(ctx: PromptContext): string {
  return [
    `You translate short text blocks of an official document from ${sourceClause(ctx.sourceLanguage)} into ${ctx.targetLanguage}. Document family: ${ctx.domainHint}`,
    "Translate each block faithfully and completely, keeping numbering, Markdown tables and identifiers verbatim. Use official legal terminology.",
    ...glossaryLines(ctx),
    "Return JSON only: an object with a `translations` array holding exactly one {id, text} per input block, with the ids unchanged.",
  ].join("\n");
}

export function blockTranslationUserPrompt(blocks: Array<{ id: string; text: string }>): string {
  return `Blocks to translate (JSON):\n${JSON.stringify(blocks, null, 1)}`;
}
