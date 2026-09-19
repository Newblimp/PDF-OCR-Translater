/**
 * Output format for the per-bounding-box annotation (Mistral's example
 * `Image` model: image_type, short_description, summary), extended with the
 * transcription/translation of any text the box contains.
 */
import type { JsonSchemaObject } from "../../mistral/types";

export const BBOX_ANNOTATION_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    image_type: { type: "string", description: "The type of the image, e.g. 'stamp', 'seal', 'signature', 'table', 'chart', 'diagram', 'photo', 'logo', 'barcode', 'handwriting'." },
    short_description: { type: "string", description: "One sentence describing the image, in the target language." },
    summary: { type: "string", description: "Summarise the image and its role in the document, in the target language." },
    text_in_image: { type: "string", description: "Any text visible in the image, transcribed verbatim in the original script; empty string if none." },
    text_translated: { type: "string", description: "Translation of text_in_image into the target language; empty string if none." },
  },
  required: ["image_type", "short_description", "summary", "text_in_image", "text_translated"],
  additionalProperties: false,
};

export interface BboxAnnotationData {
  image_type: string;
  short_description: string;
  summary: string;
  text_in_image: string;
  text_translated: string;
}
