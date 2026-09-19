/** Helpers for coaxing JSON out of model output. */

/**
 * Extract the first top-level JSON object or array from free text.
 * Handles ```json fences and leading/trailing prose. Returns the raw slice
 * or `null` if nothing that looks like JSON is found.
 */
export function extractJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() || trimmed;

  const firstObj = candidate.indexOf("{");
  const firstArr = candidate.indexOf("[");
  let start: number;
  let close: string;
  if (firstObj === -1 && firstArr === -1) return null;
  if (firstArr === -1 || (firstObj !== -1 && firstObj < firstArr)) {
    start = firstObj;
    close = "}";
  } else {
    start = firstArr;
    close = "]";
  }
  const end = candidate.lastIndexOf(close);
  if (end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

export interface ParseResult<T> {
  ok: true;
  value: T;
}
export interface ParseFailure {
  ok: false;
  error: string;
}

/** Parse model output as JSON, tolerating fences and surrounding prose. */
export function parseModelJson<T = unknown>(text: string): ParseResult<T> | ParseFailure {
  const slice = extractJsonText(text);
  if (slice === null) return { ok: false, error: "No JSON object found in the model output." };
  try {
    return { ok: true, value: JSON.parse(slice) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Model output is not valid JSON: ${message}` };
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable pretty-printer used for display and download. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
