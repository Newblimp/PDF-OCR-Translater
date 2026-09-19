/**
 * JSON Schema utilities.
 *
 * Mistral's `json_schema` response format with `strict: true` constrains
 * decoding to the schema. Constrained decoding supports a subset of JSON
 * Schema, so schemas that come from the model (inferred) or from the user
 * (custom) are normalised into a conservative subset first:
 *   - types limited to string/number/integer/boolean/object/array
 *   - every object lists all its properties as `required`
 *   - `additionalProperties: false` on every object
 *   - arrays always declare `items`
 *   - unsupported keywords are dropped
 */
import type { JsonSchemaObject } from "../mistral/types";
import { isPlainObject } from "../util/json";

export type PrimitiveType = "string" | "number" | "integer" | "boolean";
export type SchemaType = PrimitiveType | "object" | "array";

export interface SanitizeOptions {
  /** Maximum nesting depth of objects/arrays (root = 1). */
  maxDepth?: number;
  /** Maximum properties per object; extra ones are dropped. */
  maxProperties?: number;
}

export interface SanitizedSchema {
  schema: JsonSchemaObject;
  warnings: string[];
}

const DEFAULTS: Required<SanitizeOptions> = { maxDepth: 5, maxProperties: 80 };
const ALLOWED_TYPES = new Set<string>(["string", "number", "integer", "boolean", "object", "array"]);
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Normalise a (possibly sloppy) schema into the strict-mode-safe subset. */
export function sanitizeSchema(input: unknown, options: SanitizeOptions = {}): SanitizedSchema {
  const opts = { ...DEFAULTS, ...options };
  const warnings: string[] = [];
  const root = unwrapRoot(input, warnings);
  const schema = sanitizeNode(root, 1, opts, warnings, "$");
  if (schema["type"] !== "object") {
    warnings.push("Root schema was not an object; wrapped it in {\"content\": ...}.");
    return {
      schema: {
        type: "object",
        properties: { content: schema },
        required: ["content"],
        additionalProperties: false,
      },
      warnings,
    };
  }
  return { schema, warnings };
}

/** Accept `{schema: {...}}`, `{json_schema: {schema}}` or a bare schema. */
function unwrapRoot(input: unknown, warnings: string[]): unknown {
  if (!isPlainObject(input)) {
    warnings.push("Schema was not a JSON object.");
    return { type: "object", properties: {} };
  }
  if (isPlainObject(input["json_schema"]) && isPlainObject(input["json_schema"]["schema"])) {
    return input["json_schema"]["schema"];
  }
  if (isPlainObject(input["schema"]) && !("type" in input) && !("properties" in input)) {
    return input["schema"];
  }
  return input;
}

function sanitizeNode(
  node: unknown,
  depth: number,
  opts: Required<SanitizeOptions>,
  warnings: string[],
  path: string,
): JsonSchemaObject {
  if (!isPlainObject(node)) {
    warnings.push(`${path}: not a schema object, treated as string.`);
    return { type: "string" };
  }

  const type = resolveType(node, warnings, path);
  const out: JsonSchemaObject = { type };
  if (typeof node["description"] === "string" && node["description"].trim()) {
    out["description"] = node["description"].trim().slice(0, 500);
  }

  if (type === "object") {
    if (depth > opts.maxDepth) {
      warnings.push(`${path}: nesting deeper than ${opts.maxDepth}, flattened to string.`);
      return { type: "string", ...(out["description"] ? { description: out["description"] } : {}) };
    }
    const rawProps = isPlainObject(node["properties"]) ? node["properties"] : {};
    const properties: JsonSchemaObject = {};
    const required: string[] = [];
    let count = 0;
    for (const [key, value] of Object.entries(rawProps)) {
      if (!KEY_PATTERN.test(key)) {
        warnings.push(`${path}.${key}: key renamed to a safe identifier.`);
      }
      const safeKey = toSafeKey(key, properties);
      if (count >= opts.maxProperties) {
        warnings.push(`${path}: more than ${opts.maxProperties} properties, "${key}" dropped.`);
        continue;
      }
      properties[safeKey] = sanitizeNode(value, depth + 1, opts, warnings, `${path}.${safeKey}`);
      required.push(safeKey);
      count++;
    }
    out["properties"] = properties;
    out["required"] = required;
    out["additionalProperties"] = false;
    return out;
  }

  if (type === "array") {
    if (depth > opts.maxDepth) {
      warnings.push(`${path}: nesting deeper than ${opts.maxDepth}, flattened to string.`);
      return { type: "string" };
    }
    const items = node["items"];
    out["items"] =
      items === undefined
        ? { type: "string" }
        : sanitizeNode(Array.isArray(items) ? items[0] : items, depth + 1, opts, warnings, `${path}[]`);
    return out;
  }

  // Primitive: keep an enum of strings if present, drop everything else.
  if (type === "string" && Array.isArray(node["enum"])) {
    const values = node["enum"].filter((v): v is string => typeof v === "string");
    if (values.length > 0 && values.length <= 50) out["enum"] = values;
  }
  return out;
}

function resolveType(node: Record<string, unknown>, warnings: string[], path: string): SchemaType {
  let raw = node["type"];
  if (Array.isArray(raw)) {
    raw = raw.find((t) => t !== "null") ?? "string";
  }
  if (typeof raw !== "string") {
    if (isPlainObject(node["properties"])) return "object";
    if (node["items"] !== undefined) return "array";
    if (node["anyOf"] || node["oneOf"] || node["allOf"]) {
      warnings.push(`${path}: anyOf/oneOf/allOf are not supported, treated as string.`);
    }
    return "string";
  }
  if (!ALLOWED_TYPES.has(raw)) {
    warnings.push(`${path}: type "${raw}" not supported, treated as string.`);
    return "string";
  }
  return raw as SchemaType;
}

function toSafeKey(key: string, existing: JsonSchemaObject): string {
  let safe = key.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) safe = "field";
  if (/^[0-9]/.test(safe)) safe = `f_${safe}`;
  let candidate = safe;
  let n = 2;
  while (candidate in existing) candidate = `${safe}_${n++}`;
  return candidate;
}

// ---------------------------------------------------------------------------
// Light validation of model output against a sanitised schema.
// Not a full validator: it reports missing required keys and gross type
// mismatches so the UI can flag them. Strict mode should make this a no-op.
// ---------------------------------------------------------------------------

export function findSchemaViolations(data: unknown, schema: JsonSchemaObject, path = "$"): string[] {
  const problems: string[] = [];
  const type = schema["type"];
  if (type === "object") {
    if (!isPlainObject(data)) {
      problems.push(`${path}: expected object`);
      return problems;
    }
    const props = isPlainObject(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const key of required) {
      if (!(key in data)) problems.push(`${path}.${key}: missing`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in data && isPlainObject(sub)) {
        problems.push(...findSchemaViolations(data[key], sub, `${path}.${key}`));
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(data)) {
      problems.push(`${path}: expected array`);
      return problems;
    }
    const items = schema["items"];
    if (isPlainObject(items)) {
      data.forEach((item, i) => problems.push(...findSchemaViolations(item, items, `${path}[${i}]`)));
    }
  } else if (type === "string" && typeof data !== "string" && data !== null) {
    problems.push(`${path}: expected string`);
  } else if ((type === "number" || type === "integer") && typeof data !== "number" && data !== null) {
    problems.push(`${path}: expected number`);
  } else if (type === "boolean" && typeof data !== "boolean" && data !== null) {
    problems.push(`${path}: expected boolean`);
  }
  return problems;
}

/** Count leaf fields (rough size indicator for the UI). */
export function countSchemaFields(schema: JsonSchemaObject): number {
  if (schema["type"] === "object" && isPlainObject(schema["properties"])) {
    return Object.values(schema["properties"]).reduce<number>(
      (sum, sub) => sum + (isPlainObject(sub) ? countSchemaFields(sub) : 1),
      0,
    );
  }
  if (schema["type"] === "array" && isPlainObject(schema["items"])) {
    return countSchemaFields(schema["items"]);
  }
  return 1;
}
