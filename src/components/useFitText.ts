/**
 * "Match page layout": every block of the OCR text sits where it is on the
 * page, its text sized to fill its box. Sizes are in container units of the
 * page sheet (`cqw`), so a fit holds at any width: it is searched once per
 * block content (`data-fit-key`) and only checked again when the block
 * changes size. The search writes all blocks of a sheet, then reads them, so
 * each step costs one layout of the sheet.
 */
import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

/** Smallest font size tried, in cqw (about 6 px on a 1300 px wide sheet). */
const MIN_FIT = 0.45;
const STEPS = 7;
/** Classes of a fitted block and of its content, which is what grows with the font. */
export const FIT_BLOCK = "ocr-block-fit";
const FIT_CONTENT = "ocr-fit";

function overflows(block: HTMLElement, content: HTMLElement): boolean {
  return content.offsetHeight > block.clientHeight + 0.5;
}

/** Binary search, for all blocks side by side, of the largest font size at which the content fits the block. */
export function fitBlocks(blocks: Iterable<HTMLElement>): void {
  const items = Array.from(blocks).flatMap((block) => {
    const content = block.firstElementChild;
    if (!block.isConnected || !(content instanceof HTMLElement)) return [];
    return [{ block, content, key: block.dataset["fitKey"] ?? "", lo: MIN_FIT, hi: Math.max(MIN_FIT, Number(block.dataset["fitMax"]) || 2) }];
  });
  // Fitted for the same content: the width changed and the sizes scaled with it, so the fit only needs a check.
  const todo = items.filter((it) => it.block.dataset["fitted"] !== it.key || overflows(it.block, it.content));
  if (!todo.length) return;
  for (let step = 0; step < STEPS; step++) {
    for (const it of todo) it.block.style.setProperty("--fit", String((it.lo + it.hi) / 2));
    for (const it of todo) {
      const mid = (it.lo + it.hi) / 2;
      if (overflows(it.block, it.content)) it.hi = mid;
      else it.lo = mid;
    }
  }
  for (const it of todo) {
    it.block.style.setProperty("--fit", it.lo.toFixed(3));
    it.block.dataset["fitted"] = it.key;
  }
  // Too much text even at the smallest size: the block scrolls. (An attribute: the component owns `class`.)
  for (const it of todo) it.block.toggleAttribute("data-overflow", overflows(it.block, it.content));
}

/**
 * Fits the text blocks of a sheet whenever their content changes size (new
 * text, the Markdown arriving, a resize) or their `data-fit-key` changes.
 * Fitting waits for the next frame: resizing observed elements inside the
 * observer's callback would loop.
 */
export function useFitText(sheet: RefObject<HTMLElement>): void {
  useEffect(() => {
    const root = sheet.current;
    if (!root) return;
    const pending = new Set<HTMLElement>();
    let frame = 0;
    const schedule = (block: HTMLElement) => {
      pending.add(block);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          const blocks = [...pending];
          pending.clear();
          fitBlocks(blocks);
        });
      }
    };
    const resizes = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const block = (entry.target as HTMLElement).parentElement;
        if (block) schedule(block);
      }
    });
    const observed = new WeakSet<Element>();
    const observeNew = () => {
      for (const content of root.querySelectorAll(`:scope > .${FIT_BLOCK} > .${FIT_CONTENT}`)) {
        if (observed.has(content)) continue;
        observed.add(content);
        resizes.observe(content);
      }
    };
    observeNew();
    // Blocks come and go with the filters; a block whose content switched (translation, Markdown) is fitted anew.
    const mutations = new MutationObserver((records) => {
      observeNew();
      for (const r of records) if (r.type === "attributes" && r.target instanceof HTMLElement) schedule(r.target);
    });
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-fit-key"] });
    return () => {
      resizes.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [sheet]);
}
