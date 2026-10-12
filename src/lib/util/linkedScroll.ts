/**
 * Linked scrolling of two columns that show the same pages at different
 * heights (the page images and the OCR text): the other column follows page
 * by page, so the same page is in view on both sides.
 */

export interface ScrollColumn {
  scrollTop: number;
  /** Visible height (clientHeight). */
  viewHeight: number;
  /** Full height of the content (scrollHeight). */
  contentHeight: number;
  /** Top of each page in content coordinates, in order, keyed by page. */
  pages: Array<{ key: string; top: number }>;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * The scrollTop at which `target` shows what `source` shows. The reading
 * point moves from the top of the view (at the start) to its bottom (at the
 * end), so both columns reach their start and their end together; in
 * between it is mapped through the pages both columns have, proportionally
 * within a page.
 */
export function linkedScrollTop(source: ScrollColumn, target: ScrollColumn): number {
  const sourceRange = Math.max(0, source.contentHeight - source.viewHeight);
  const targetRange = Math.max(0, target.contentHeight - target.viewHeight);
  if (targetRange === 0 || target.contentHeight <= 0) return 0;
  const progress = sourceRange > 0 ? clamp(source.scrollTop / sourceRange, 0, 1) : 0;
  const point = source.scrollTop + source.viewHeight * progress;

  // Matching positions in both columns: the start, every page both show (in order), the end.
  const targetTops = new Map(target.pages.map((p) => [p.key, p.top]));
  const pairs: Array<[number, number]> = [[0, 0]];
  for (const page of source.pages) {
    const top = targetTops.get(page.key);
    const [lastSource, lastTarget] = pairs[pairs.length - 1]!;
    if (top !== undefined && page.top > lastSource && top > lastTarget && page.top < source.contentHeight && top < target.contentHeight)
      pairs.push([page.top, top]);
  }
  pairs.push([source.contentHeight, target.contentHeight]);

  let k = 0;
  while (k < pairs.length - 2 && point >= pairs[k + 1]![0]) k++;
  const [s0, t0] = pairs[k]!;
  const [s1, t1] = pairs[k + 1]!;
  const mapped = s1 > s0 ? t0 + ((point - s0) / (s1 - s0)) * (t1 - t0) : t0;
  // Solve scrollTop + viewHeight * scrollTop / range = mapped for the target.
  return clamp((mapped * targetRange) / target.contentHeight, 0, targetRange);
}
