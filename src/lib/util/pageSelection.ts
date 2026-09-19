/**
 * Parse a human page selection such as "1-3, 7, 10-12" (1-based, as printed
 * in PDF viewers) into sorted, unique 0-based page indices for the OCR API.
 */
export interface PageSelection {
  /** 0-based indices, sorted and unique; `null` means all pages. */
  pages: number[] | null;
  /** Normalised text, e.g. "1-3, 7". Empty when all pages. */
  text: string;
  error: string | null;
}

export function parsePageSelection(input: string, pageCount: number | null): PageSelection {
  const raw = input.trim();
  if (!raw) return { pages: null, text: "", error: null };
  const indices = new Set<number>();
  // "2 - 4" is a range; "1 3" are two pages.
  for (const part of raw.replace(/\s*-\s*/g, "-").split(/[,\s;]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return { pages: null, text: raw, error: `"${part}" is not a page number or range (use e.g. 1-3, 7).` };
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from) return { pages: null, text: raw, error: `"${part}" is not a valid range.` };
    if (pageCount !== null && to > pageCount) return { pages: null, text: raw, error: `Page ${to} does not exist (the document has ${pageCount} pages).` };
    if (to - from > 2000) return { pages: null, text: raw, error: `"${part}" covers too many pages.` };
    for (let p = from; p <= to; p++) indices.add(p - 1);
  }
  const pages = Array.from(indices).sort((a, b) => a - b);
  if (pageCount !== null && pages.length === pageCount) return { pages: null, text: "", error: null };
  return { pages, text: formatPageSelection(pages), error: null };
}

/** Format 0-based indices as "1-3, 7". */
export function formatPageSelection(pages: number[]): string {
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const from = sorted[i]! + 1;
    const to = sorted[j]! + 1;
    parts.push(from === to ? String(from) : `${from}-${to}`);
    i = j + 1;
  }
  return parts.join(", ");
}
