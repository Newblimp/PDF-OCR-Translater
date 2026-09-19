/** Helpers that decide how a JSON value should be displayed. */
import { isPlainObject } from "@/lib/util/json";

export type Primitive = string | number | boolean | null;

export function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Arrays of flat objects with short values render nicely as a table. */
export function isTabular(value: unknown[]): value is Record<string, Primitive>[] {
  if (value.length === 0) return false;
  const keys = new Set<string>();
  for (const row of value) {
    if (!isPlainObject(row)) return false;
    for (const [k, v] of Object.entries(row)) {
      if (!isPrimitive(v)) return false;
      if (typeof v === "string" && (v.length > 120 || v.includes("\n"))) return false;
      keys.add(k);
    }
  }
  return keys.size <= 8;
}

/** Flatten a value into searchable text. */
export function valueToSearchText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isPrimitive(value)) return String(value);
  if (Array.isArray(value)) return value.map(valueToSearchText).join(" ");
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([k, v]) => `${k} ${valueToSearchText(v)}`)
      .join(" ");
  }
  return "";
}

export function pathId(path: string[]): string {
  return `field-${path.map((p) => p.replace(/[^A-Za-z0-9_-]/g, "_")).join("-")}`;
}
