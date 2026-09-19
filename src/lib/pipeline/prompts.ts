/**
 * All prompts live here so they can be tuned in one place.
 *
 * Both prompts mention "JSON" explicitly: Mistral's `json_object` mode
 * requires the word to appear in the conversation.
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

export function translationSystemPrompt(ctx: PromptContext): string {
  return [
    `You are a professional legal and patent translator. Translate the document from ${sourceClause(ctx.sourceLanguage)} into ${ctx.targetLanguage} and return the result as a JSON object that follows the provided JSON Schema exactly.`,
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
    `- Page delimiters like "${pageDelimiter(1)}" are not content; never reproduce them.`,
    "- For data the document does not contain, use an empty string, an empty array or 0. Never invent facts.",
    "- Note illegible or uncertain passages in `notes_for_reader` when such a field exists.",
    "- Output JSON only.",
  ].join("\n");
}

export function translationUserPrompt(documentText: string, schemaJson: string): string {
  return [
    "JSON Schema of the expected output:",
    "```json",
    schemaJson,
    "```",
    "",
    "Document to translate (OCR text, Markdown):",
    "<document>",
    documentText,
    "</document>",
  ].join("\n");
}
