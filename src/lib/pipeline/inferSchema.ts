/**
 * Step 2 (optional): let a chat model design a JSON Schema for the document.
 *
 * This is the API-side equivalent of the "infer a JSON format from the
 * document" helper in Mistral's playground: the model reads the OCR text and
 * proposes the fields, which are then used as the structured-output schema
 * for the translation step (and could equally be passed to the OCR
 * `document_annotation_format` parameter).
 */
import type { MistralClient } from "../mistral/client";
import type { JsonSchemaObject, UsageInfo } from "../mistral/types";
import { parseModelJson } from "../util/json";
import { emit, type ProgressListener } from "./events";
import { schemaInferenceSystemPrompt, schemaInferenceUserPrompt, type PromptContext } from "./prompts";
import { countSchemaFields, sanitizeSchema } from "./schema";

export interface InferSchemaOptions extends PromptContext {
  model: string;
  temperature?: number;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
}

export interface InferredSchema {
  schema: JsonSchemaObject;
  /** Exactly what the model returned, before sanitising. */
  rawSchema: unknown;
  warnings: string[];
  usage: UsageInfo | null;
  model: string;
}

export async function inferSchema(
  client: MistralClient,
  documentText: string,
  options: InferSchemaOptions,
): Promise<InferredSchema> {
  const { onProgress } = options;
  emit(onProgress, "infer_schema", "start", `Asking ${options.model} to design the JSON format`);

  const result = await client.chat(
    {
      model: options.model,
      temperature: options.temperature ?? 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: schemaInferenceSystemPrompt(options) },
        { role: "user", content: schemaInferenceUserPrompt(documentText) },
      ],
    },
    options.signal,
  );

  const parsed = parseModelJson(result.content);
  if (!parsed.ok) {
    throw new Error(`Schema inference failed: ${parsed.error}`);
  }
  const { schema, warnings } = sanitizeSchema(parsed.value);
  const fieldCount = countSchemaFields(schema);
  if (fieldCount === 0) {
    throw new Error("Schema inference produced an empty schema.");
  }
  emit(onProgress, "infer_schema", "done", `JSON format inferred: ${fieldCount} field(s)`, {
    detail: warnings.length ? `${warnings.length} adjustment(s) made for strict mode` : undefined,
  });
  return { schema, rawSchema: parsed.value, warnings, usage: result.usage, model: result.model };
}
