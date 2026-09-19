/**
 * Registry of built-in output schemas. The settings panel lists these.
 * Add new document families here (e.g. EPO or USPTO forms).
 */
import type { JsonSchemaObject } from "../../mistral/types";
import { PATENT_COMMUNICATION_SCHEMA } from "./patentCommunication";

export interface BuiltinSchema {
  id: string;
  label: string;
  description: string;
  schema: JsonSchemaObject;
}

export const BUILTIN_SCHEMAS: readonly BuiltinSchema[] = [
  {
    id: "patent_communication",
    label: "Patent office communication",
    description: "Office actions, notifications and decisions from a patent office (CNIPA and similar).",
    schema: PATENT_COMMUNICATION_SCHEMA,
  },
];

export function getBuiltinSchema(id: string): BuiltinSchema | undefined {
  return BUILTIN_SCHEMAS.find((s) => s.id === id);
}
