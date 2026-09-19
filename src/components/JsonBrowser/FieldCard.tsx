import { useState } from "preact/hooks";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { humanizeKey } from "@/lib/util/text";
import { MarkdownText } from "../MarkdownText";
import { isEmptyValue, isPrimitive, isTabular, pathId, type Primitive } from "./valueUtils";

/** Strings longer than this start collapsed. */
const COLLAPSE_CHARS = 1200;

export interface RenderOptions {
  markdown: boolean;
  showEmpty: boolean;
}

interface FieldProps {
  path: string[];
  label: string;
  description?: string | undefined;
  value: unknown;
  options: RenderOptions;
  depth: number;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard may be unavailable; ignore.
  }
}

/** One field of the translated document: label, optional description, value. */
export function FieldCard({ path, label, description, value, options, depth }: FieldProps) {
  const empty = isEmptyValue(value);
  if (empty && !options.showEmpty) return null;
  const id = pathId(path);
  const copyValue = () => copyText(typeof value === "string" ? value : prettyJson(value));

  return (
    <section class={`field-card depth-${Math.min(depth, 3)}`} id={id} aria-labelledby={`${id}-label`}>
      <header class="field-head">
        <h3 id={`${id}-label`}>{label}</h3>
        <div class="field-tools">
          {typeof value === "string" && value.length > 0 && <span class="muted small">{value.length.toLocaleString()} chars</span>}
          {!empty && (
            <button type="button" class="btn btn-ghost small" onClick={() => void copyValue()} title="Copy value">
              Copy
            </button>
          )}
        </div>
      </header>
      {description && <p class="field-description muted small">{description}</p>}
      <ValueView value={value} path={path} options={options} depth={depth} />
    </section>
  );
}

interface ValueProps {
  value: unknown;
  path: string[];
  options: RenderOptions;
  depth: number;
}

export function ValueView({ value, path, options, depth }: ValueProps) {
  if (isEmptyValue(value)) return <p class="value-empty muted">— empty —</p>;
  if (typeof value === "string") return <LongText text={value} markdown={options.markdown} />;
  if (isPrimitive(value)) return <code class="value-inline">{String(value)}</code>;

  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) {
      return (
        <ol class="value-list">
          {value.map((item, i) => (
            <li key={i}>
              {typeof item === "string" ? <LongText text={item} markdown={options.markdown} /> : <code class="value-inline">{String(item)}</code>}
            </li>
          ))}
        </ol>
      );
    }
    if (isTabular(value)) return <PrimitiveTable rows={value} />;
    return (
      <ol class="value-items">
        {value.map((item, i) => (
          <li key={i} class="value-item">
            <div class="value-item-index muted small">#{i + 1}</div>
            {isPlainObject(item) ? (
              <ObjectView value={item} path={[...path, String(i)]} options={options} depth={depth + 1} />
            ) : (
              <ValueView value={item} path={[...path, String(i)]} options={options} depth={depth + 1} />
            )}
          </li>
        ))}
      </ol>
    );
  }

  if (isPlainObject(value)) return <ObjectView value={value} path={path} options={options} depth={depth + 1} />;
  return <code class="value-inline">{prettyJson(value)}</code>;
}

function ObjectView({ value, path, options, depth }: { value: Record<string, unknown>; path: string[]; options: RenderOptions; depth: number }) {
  return (
    <div class="object-view">
      {Object.entries(value).map(([key, sub]) => (
        <FieldCard key={key} path={[...path, key]} label={humanizeKey(key)} value={sub} options={options} depth={depth} />
      ))}
    </div>
  );
}

function PrimitiveTable({ rows }: { rows: Record<string, Primitive>[] }) {
  const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return (
    <div class="table-wrap">
      <table class="value-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{humanizeKey(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{row[c] === null || row[c] === undefined ? "" : String(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LongText({ text, markdown }: { text: string; markdown: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > COLLAPSE_CHARS;
  const shown = long && !expanded ? `${text.slice(0, COLLAPSE_CHARS)}…` : text;
  return (
    <div class={`long-text${long && !expanded ? " long-text-collapsed" : ""}`}>
      <MarkdownText text={shown} markdown={markdown} />
      {long && (
        <button type="button" class="btn btn-link small" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}
