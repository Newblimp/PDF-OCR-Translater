import { useMemo, useState } from "preact/hooks";
import type { JsonSchemaObject } from "@/lib/mistral/types";
import { isPlainObject } from "@/lib/util/json";
import { humanizeKey } from "@/lib/util/text";
import { FieldCard, type RenderOptions } from "./FieldCard";
import { isEmptyValue, pathId, valueToSearchText } from "./valueUtils";

interface Props {
  data: unknown;
  schema: JsonSchemaObject | null;
}

interface TopField {
  key: string;
  label: string;
  description: string | undefined;
  value: unknown;
  searchText: string;
  empty: boolean;
}

/**
 * Browsable view of the translated document. Left: an outline of the
 * top-level fields (click to jump). Right: one card per field, long text
 * collapsible, arrays as lists or tables, nested objects as nested cards.
 */
export function JsonBrowser({ data, schema }: Props) {
  const [query, setQuery] = useState("");
  const [markdown, setMarkdown] = useState(true);
  const [showEmpty, setShowEmpty] = useState(false);

  const fields = useMemo<TopField[]>(() => {
    if (!isPlainObject(data)) return [{ key: "content", label: "Content", description: undefined, value: data, searchText: valueToSearchText(data), empty: isEmptyValue(data) }];
    const props = schema && isPlainObject(schema["properties"]) ? schema["properties"] : {};
    return Object.entries(data).map(([key, value]) => {
      const prop = props[key];
      const description = isPlainObject(prop) && typeof prop["description"] === "string" ? prop["description"] : undefined;
      return {
        key,
        label: humanizeKey(key),
        description,
        value,
        searchText: `${key} ${humanizeKey(key)} ${description ?? ""} ${valueToSearchText(value)}`.toLowerCase(),
        empty: isEmptyValue(value),
      };
    });
  }, [data, schema]);

  const needle = query.trim().toLowerCase();
  const visible = fields.filter((f) => (showEmpty || !f.empty) && (!needle || f.searchText.includes(needle)));
  const options: RenderOptions = { markdown, showEmpty };
  const emptyCount = fields.filter((f) => f.empty).length;

  const jumpTo = (key: string) => {
    document.getElementById(pathId([key]))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div class="json-browser">
      <aside class="outline" aria-label="Fields">
        <input
          type="search"
          class="outline-search"
          placeholder="Find in fields…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search fields"
        />
        <ul class="outline-list">
          {visible.map((f) => (
            <li key={f.key}>
              <button type="button" class="outline-link" onClick={() => jumpTo(f.key)}>
                {f.label}
                <span class="muted small">{summarise(f.value)}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 && <li class="muted small">No field matches.</li>}
        </ul>
        <div class="outline-options">
          <label class="checkbox small">
            <input type="checkbox" checked={markdown} onChange={(e) => setMarkdown((e.target as HTMLInputElement).checked)} />
            <span>Render Markdown</span>
          </label>
          {emptyCount > 0 && (
            <label class="checkbox small">
              <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty((e.target as HTMLInputElement).checked)} />
              <span>Show {emptyCount} empty field(s)</span>
            </label>
          )}
        </div>
      </aside>
      <div class="fields">
        {visible.map((f) => (
          <FieldCard key={f.key} path={[f.key]} label={f.label} description={f.description} value={f.value} options={options} depth={0} />
        ))}
        {visible.length === 0 && <p class="muted">Nothing to show.</p>}
      </div>
    </div>
  );
}

function summarise(value: unknown): string {
  if (isEmptyValue(value)) return "empty";
  if (typeof value === "string") return value.length > 80 ? `${(value.length / 1000).toFixed(1)}k chars` : "";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isPlainObject(value)) return `${Object.keys(value).length} fields`;
  return "";
}
