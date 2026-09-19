import { useEffect, useRef, useState } from "preact/hooks";
import { isPlainObject, prettyJson } from "@/lib/util/json";
import { humanizeKey } from "@/lib/util/text";
import { MarkdownText } from "../MarkdownText";
import { isEmptyValue, isPrimitive, isTabular, pathId, type Primitive } from "./valueUtils";

/** Strings longer than this start collapsed. */
const COLLAPSE_CHARS = 1200;

export interface RenderOptions {
  markdown: boolean;
  showEmpty: boolean;
  /**
   * Bulk expand/collapse request from the browser toolbar. Every card
   * re-applies `mode` whenever `epoch` changes, then keeps its own state.
   */
  bulk: { mode: "expand" | "collapse"; epoch: number };
  /** A path the user jumped to from the outline; cards on that path expand. */
  reveal: { path: string; epoch: number } | null;
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

/** One field of the translated document: collapsible label, optional description, value. */
export function FieldCard({ path, label, description, value, options, depth }: FieldProps) {
  const [collapsed, setCollapsed] = useState(options.bulk.mode === "collapse");
  const id = pathId(path);
  const joined = path.join("/");

  // Bulk and reveal requests are one-shot: remember which epoch was applied so
  // a remounted card (search filter, new data) does not replay an old request.
  const appliedBulk = useRef(options.bulk.epoch);
  useEffect(() => {
    if (appliedBulk.current === options.bulk.epoch) return;
    appliedBulk.current = options.bulk.epoch;
    setCollapsed(options.bulk.mode === "collapse");
  }, [options.bulk.epoch, options.bulk.mode]);

  const appliedReveal = useRef(options.reveal?.epoch ?? 0);
  useEffect(() => {
    const reveal = options.reveal;
    if (!reveal || appliedReveal.current === reveal.epoch) return;
    appliedReveal.current = reveal.epoch;
    if (reveal.path === joined || reveal.path.startsWith(`${joined}/`)) setCollapsed(false);
  }, [options.reveal, joined]);

  const empty = isEmptyValue(value);
  if (empty && !options.showEmpty) return null;
  const copyValue = () => copyText(typeof value === "string" ? value : prettyJson(value));
  const contentId = `${id}-content`;

  return (
    <section class={`field-card depth-${Math.min(depth, 3)}${collapsed ? " field-card-collapsed" : ""}`} id={id} aria-labelledby={`${id}-label`}>
      <header class="field-head">
        {/* Accordion pattern: the heading wraps the disclosure button, so headings stay navigable. */}
        <h3 id={`${id}-label`} class="field-title">
          <button type="button" class="field-toggle" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed((c) => !c)}>
            <span class="chevron" aria-hidden="true">
              {collapsed ? "▸" : "▾"}
            </span>
            {label}
          </button>
        </h3>
        <div class="field-tools">
          {typeof value === "string" && value.length > 0 && <span class="muted small">{value.length.toLocaleString()} chars</span>}
          {Array.isArray(value) && value.length > 0 && <span class="muted small">{value.length} item(s)</span>}
          {!empty && (
            <button type="button" class="btn btn-ghost small" onClick={() => void copyValue()} title="Copy value">
              Copy
            </button>
          )}
        </div>
      </header>
      {!collapsed && (
        <div id={contentId} class="field-body">
          {description && <p class="field-description muted small">{description}</p>}
          <ValueView value={value} path={path} options={options} depth={depth} />
        </div>
      )}
      {collapsed && <p class="field-preview muted small">{preview(value)}</p>}
    </section>
  );
}

/** One-line summary shown while a card is collapsed. */
function preview(value: unknown, depth = 0): string {
  if (isEmptyValue(value)) return "— empty —";
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
  }
  if (isPrimitive(value)) return String(value);
  if (Array.isArray(value)) {
    if (depth > 0) return `${value.length} item(s)`;
    const head = value.slice(0, 3).map((item) => preview(item, depth + 1));
    return value.length > 3 ? `${head.join(" · ")} · …` : head.join(" · ");
  }
  if (isPlainObject(value)) {
    if (depth > 0) {
      const firstText = Object.values(value).find((v) => typeof v === "string" && v.trim());
      return typeof firstText === "string" ? preview(firstText, depth + 1) : Object.keys(value).map(humanizeKey).join(", ");
    }
    return Object.keys(value).map(humanizeKey).join(", ");
  }
  return "";
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
