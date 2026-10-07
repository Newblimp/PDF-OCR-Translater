/**
 * Bilingual export: one self-contained HTML file with the translation next
 * to the original, field by field (the structured text) and block by block
 * (the OCR pages). It opens in any browser, prints to PDF, and Word and
 * LibreOffice import it. No scripts and no external resources: the app's CSP
 * does not apply to a downloaded file, so every rendered fragment loses
 * `src`/`srcset`/`background`/`poster` URLs that are not `data:` (a document
 * or a model could otherwise make the file fetch a remote image whose URL
 * carries text), and the file declares its own CSP for browsers.
 */
import type { JsonSchemaObject } from "../mistral/types";
import { textBlocks } from "../pipeline/blockTranslate";
import type { OcrText } from "../pipeline/ocrText";
import { isPlainObject } from "../util/json";
import { humanizeKey } from "../util/text";

export interface BilingualExportInput {
  title: string;
  targetLanguage: string;
  /** e.g. "Anthropic (Claude) · claude-haiku-5-5". */
  producedBy: string;
  completedAt: number;
  schema: JsonSchemaObject;
  translated: unknown;
  /** The same JSON in the document's own language; null when it was not produced. */
  original: unknown;
  ocr: OcrText | null;
  blockTranslations: Record<string, string>;
}

/** Markdown → sanitised HTML (the app's renderer, or an escaping stand-in). */
export type MarkdownRenderer = (markdown: string) => string;

/** The exported file's own policy: inline styles and embedded images only. */
export const EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Attributes that make a browser or word processor fetch a URL when the file is opened. */
const REMOTE_ATTRIBUTE = /\s(?:src|srcset|background|poster|lowsrc|dynsrc|data)\s*=\s*(?:"(?!\s*data:)[^"]*"|'(?!\s*data:)[^']*'|(?!["'\s])(?!data:)[^\s>]+)/gi;

/** Remove every URL that would be fetched from outside the file (keeps `data:` images). */
export function stripRemoteResources(html: string): string {
  return html.replace(REMOTE_ATTRIBUTE, "");
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d2021; margin: 2rem auto; max-width: 75rem; padding: 0 1rem; }
h1 { font-size: 1.5rem; margin-bottom: .25rem; }
h2 { font-size: 1.15rem; margin-top: 2.5rem; border-bottom: 2px solid #d65d0e; padding-bottom: .25rem; }
h3 { font-size: 1rem; margin-top: 1.5rem; }
.meta { color: #665c54; margin-top: 0; }
table.bilingual { border-collapse: collapse; width: 100%; table-layout: fixed; }
table.bilingual > * > tr > th, table.bilingual > * > tr > td { border: 1px solid #d5c4a1; padding: .5rem .65rem; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
table.bilingual > thead th { background: #f2e5bc; }
table.bilingual th.field { width: 16%; background: #fbf1c7; font-weight: 600; }
.value p:first-child { margin-top: 0; } .value p:last-child { margin-bottom: 0; }
.value table { border-collapse: collapse; margin: .35rem 0; } .value table td, .value table th { border: 1px solid #d5c4a1; padding: .2rem .4rem; }
dl { margin: 0; } dt { font-weight: 600; margin-top: .35rem; } dd { margin: 0 0 0 .75rem; }
.item + .item { border-top: 1px dashed #d5c4a1; margin-top: .4rem; padding-top: .4rem; }
.empty { color: #928374; font-style: italic; }
@media print { body { margin: 0; max-width: none; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

/** One JSON value as HTML: strings as Markdown, lists, nested fields as a definition list. */
function renderValue(value: unknown, render: MarkdownRenderer): string {
  if (value === null || value === undefined || value === "") return '<span class="empty">—</span>';
  if (typeof value === "string") return render(value);
  if (typeof value === "number" || typeof value === "boolean") return escapeHtml(String(value));
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="empty">—</span>';
    return value.map((item) => `<div class="item">${renderValue(item, render)}</div>`).join("");
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return '<span class="empty">—</span>';
    return `<dl>${entries.map(([k, v]) => `<dt>${escapeHtml(humanizeKey(k))}</dt><dd>${renderValue(v, render)}</dd>`).join("")}</dl>`;
  }
  return escapeHtml(String(value));
}

function structuredSection(input: BilingualExportInput, render: MarkdownRenderer): string {
  const translated = isPlainObject(input.translated) ? input.translated : { content: input.translated };
  const original = isPlainObject(input.original) ? input.original : null;
  const props = isPlainObject(input.schema["properties"]) ? (input.schema["properties"] as Record<string, unknown>) : {};
  const keys = [...new Set([...Object.keys(props).filter((k) => k in translated), ...Object.keys(translated)])];
  const head = original
    ? `<tr><th class="field">Field</th><th>Translation (${escapeHtml(input.targetLanguage)})</th><th>Original</th></tr>`
    : `<tr><th class="field">Field</th><th>Translation (${escapeHtml(input.targetLanguage)})</th></tr>`;
  const rows = keys.map((key) => {
    const cells = [`<th class="field" scope="row">${escapeHtml(humanizeKey(key))}</th>`, `<td class="value">${renderValue(translated[key], render)}</td>`];
    if (original) cells.push(`<td class="value">${renderValue(original[key], render)}</td>`);
    return `<tr>${cells.join("")}</tr>`;
  });
  const note = original ? "" : '<p class="meta">The structured text in the original language was not produced for this translation, so only the translation is shown.</p>';
  return `<h2>Structured text</h2>${note}<table class="bilingual"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>`;
}

function pagesSection(input: BilingualExportInput, render: MarkdownRenderer): string {
  const { ocr } = input;
  if (!ocr || !Object.keys(input.blockTranslations).length) return "";
  const pages = ocr.pages
    .map((page) => {
      const blocks = textBlocks(page);
      if (!blocks.length) return "";
      const rows = blocks
        .map((b) => {
          const translation = input.blockTranslations[b.id];
          return `<tr><td class="value">${render(b.text)}</td><td class="value">${translation?.trim() ? render(translation) : '<span class="empty">not translated</span>'}</td></tr>`;
        })
        .join("");
      return `<h3>Page ${page.index + 1}</h3><table class="bilingual"><thead><tr><th>Original</th><th>Translation (${escapeHtml(input.targetLanguage)})</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("");
  return pages ? `<h2>Page by page</h2>${pages}` : "";
}

export function bilingualHtml(input: BilingualExportInput, renderMarkdown: MarkdownRenderer): string {
  const render: MarkdownRenderer = (markdown) => stripRemoteResources(renderMarkdown(markdown));
  const date = new Date(input.completedAt).toISOString().slice(0, 10);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)} — bilingual</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p class="meta">Translated into ${escapeHtml(input.targetLanguage)} by ${escapeHtml(input.producedBy)} on ${date}. Machine translation: check it against the original before relying on it.</p>`,
    structuredSection(input, render),
    pagesSection(input, render),
    "</body></html>",
  ].join("\n");
}
