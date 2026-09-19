/**
 * All prompts live here so they can be tuned in one place.
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

export function schemaInferenceSystemPrompt(ctx: PromptContext): string {
  return [
    "You design JSON Schemas that describe the structure of official documents so that a translator can later fill every field with translated text.",
    "",
    `Document family: ${ctx.domainHint}`,
    `The translation will be into ${ctx.targetLanguage}.`,
    "",
    "Return ONLY one JSON object: a JSON Schema for the document. No prose, no Markdown fences.",
    "",
    "Requirements for the schema:",
    "- Root: {\"type\":\"object\",\"properties\":{...},\"required\":[...]} listing every property in `required`.",
    "- Keys in English snake_case. Each property has a concise English `description` that says what goes in it.",
    "- Cover ALL the document's content, in reading order, so nothing is lost when the fields are filled: identification data (issuing authority, document type/title, application and publication numbers, applicant, agent, examiner, dates, response deadlines, form/reference codes), the complete body text split into meaningful sections, per-claim findings, cited references, legal provisions, instructions to the recipient, and any tables or lists.",
    "- Use arrays of objects for repeated structures (sections, objections per claim, cited references, list items).",
    "- Prefer 8 to 30 well-named fields. Nest at most 3 levels deep.",
    "- Allowed types only: string, number, boolean, object, array. Dates are strings. Do NOT use enum, oneOf, anyOf, allOf, $ref, pattern, format, minimum, maximum or default.",
    "- Long passages are string fields that will hold Markdown (lists and tables preserved).",
    "- Always include `summary` (string) and `notes_for_reader` (string, for illegible or uncertain passages).",
    "- If the text contains `[Image: ...]` placeholders (figures, stamps, signatures, seals), include a `figures` array of objects (id, description) so their content can be captured.",
    "- Do not invent fields for content that is absent from the document.",
    `- The text contains page delimiters such as "${pageDelimiter(1)}"; they are not content.`,
  ].join("\n");
}

export function schemaInferenceUserPrompt(documentText: string): string {
  const sample =
    documentText.length > SCHEMA_INFERENCE_SAMPLE_CHARS
      ? `${documentText.slice(0, SCHEMA_INFERENCE_SAMPLE_CHARS)}\n\n[... document truncated for schema design ...]`
      : documentText;
  return `Design the JSON Schema for the following document.\n\n<document>\n${sample}\n</document>`;
}

/**
 * Document annotation (Mistral's workflow, performed by the vision model):
 * OCR Markdown + the first bounding-box images + the JSON format → JSON.
 * Here the JSON is also the translation.
 */
export function translationSystemPrompt(ctx: PromptContext): string {
  return [
    `You are a professional legal and patent translator working with a vision model. You receive the OCR text of a document (Markdown) and, when available, the images of its bounding boxes (figures, stamps, seals, signatures, tables rendered as images). Translate the document from ${sourceClause(ctx.sourceLanguage)} into ${ctx.targetLanguage} and return the result as a JSON object that follows the provided JSON Schema exactly.`,
    "",
    `Document family: ${ctx.domainHint}`,
    "",
    "Translation rules:",
    "- Translate faithfully and completely. Do not summarise or omit passages unless a field's description explicitly asks for a summary.",
    "- Every passage of the source must end up, translated, in the most relevant field. If nothing fits, use the closest section-like field rather than dropping content.",
    "- Keep identifiers verbatim: application, publication and reference numbers, claim numbers, form codes, addresses in the original script where customary.",
    "- Use the established official terminology of the target language for legal provisions and institutions (e.g. 'Patent Law of the People's Republic of China, Article 22, Paragraph 3').",
    "- Dates: use ISO 8601 (YYYY-MM-DD) when the date is unambiguous; otherwise keep the original wording.",
    "- Inside string fields, preserve numbering, bullet lists and Markdown tables from the source.",
    "- \"[Image: id]\" placeholders mark where a bounding box sits in the text; the attached images carry the same ids. Read text inside the images (stamps, seals, handwritten notes, figure labels, tables) and translate it into the relevant field; describe non-text figures briefly where the schema has a place for them. Never reproduce the placeholders themselves.",
    `- Page delimiters like "${pageDelimiter(1)}" are not content; never reproduce them.`,
    "- For data the document does not contain, use an empty string, an empty array or 0. Never invent facts.",
    "- Note illegible or uncertain passages in `notes_for_reader` when such a field exists.",
    "- Output JSON only.",
  ].join("\n");
}

export function translationUserPrompt(documentText: string, schemaJson: string, attachedImageIds: string[] = []): string {
  return documentUserPrompt("Document to translate (OCR text, Markdown):", documentText, schemaJson, attachedImageIds);
}

/**
 * Same call, but the JSON keeps the document's own language: it is the
 * "Structured text" view with the translation toggle switched off.
 */
export function originalStructureSystemPrompt(ctx: PromptContext): string {
  return [
    `You are a document analyst working with a vision model. You receive the OCR text of a document (Markdown) and, when available, the images of its bounding boxes (figures, stamps, seals, signatures, tables rendered as images). Put the document's content into a JSON object that follows the provided JSON Schema exactly, keeping every passage in ${sourceClause(ctx.sourceLanguage)}.`,
    "",
    `Document family: ${ctx.domainHint}`,
    "",
    "Rules:",
    `- Do NOT translate. Never write ${ctx.targetLanguage} where the document uses another language; copy the wording of the source, only re-arranged into the JSON fields.`,
    "- Transcribe faithfully and completely. Do not summarise or omit passages unless a field's description explicitly asks for a summary.",
    "- Every passage of the source must end up in the most relevant field. If nothing fits, use the closest section-like field rather than dropping content.",
    "- Keep identifiers, numbers and dates exactly as printed.",
    "- Inside string fields, preserve numbering, bullet lists and Markdown tables from the source.",
    "- \"[Image: id]\" placeholders mark where a bounding box sits in the text; the attached images carry the same ids. Transcribe text inside the images (stamps, seals, handwritten notes, figure labels, tables) in its original script; describe non-text figures briefly, in the document's language, where the schema has a place for them. Never reproduce the placeholders themselves.",
    `- Page delimiters like "${pageDelimiter(1)}" are not content; never reproduce them.`,
    "- For data the document does not contain, use an empty string, an empty array or 0. Never invent facts.",
    "- Field names stay as the schema spells them; only the values are in the document's language.",
    "- Output JSON only.",
  ].join("\n");
}

export function originalStructureUserPrompt(documentText: string, schemaJson: string, attachedImageIds: string[] = []): string {
  return documentUserPrompt("Document to put into the JSON fields, untranslated (OCR text, Markdown):", documentText, schemaJson, attachedImageIds);
}

function documentUserPrompt(intro: string, documentText: string, schemaJson: string, attachedImageIds: string[]): string {
  const parts = ["JSON Schema of the expected output:", "```json", schemaJson, "```", ""];
  if (attachedImageIds.length) {
    parts.push(
      `Attached after the text: ${attachedImageIds.length} bounding-box image(s) extracted by the OCR model, with ids ${attachedImageIds.map((id) => `"${id}"`).join(", ")}.`,
      "",
    );
  }
  parts.push(intro, "<document>", documentText, "</document>");
  return parts.join("\n");
}

/** BBox annotation (Mistral's workflow, performed by the vision model): one call per bounding box. */
export function bboxAnnotationSystemPrompt(ctx: PromptContext): string {
  return [
    `You describe one image that the OCR model cut out of a document. Document family: ${ctx.domainHint}`,
    `Write all text in ${ctx.targetLanguage}. If the image contains text (a stamp, seal, signature block, handwritten note, table or figure labels), transcribe it in the original script where relevant and translate it into ${ctx.targetLanguage}.`,
    "Return JSON only, following the provided schema.",
  ].join("\n");
}

/** Block translation for the bounding-box view: batches of OCR blocks as JSON. */
export function blockTranslationSystemPrompt(ctx: PromptContext): string {
  return [
    `You translate short text blocks of an official document from ${sourceClause(ctx.sourceLanguage)} into ${ctx.targetLanguage}. Document family: ${ctx.domainHint}`,
    "Translate each block faithfully and completely, keeping numbering, Markdown tables and identifiers verbatim. Use official legal terminology.",
    "Return JSON only: an object with a `translations` array holding exactly one {id, text} per input block, with the ids unchanged.",
  ].join("\n");
}

export function blockTranslationUserPrompt(blocks: Array<{ id: string; text: string }>): string {
  return `Blocks to translate (JSON):\n${JSON.stringify(blocks, null, 1)}`;
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
