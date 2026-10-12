import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { linkedScrollTop, type ScrollColumn } from "@/lib/util/linkedScroll";

/** Scroll geometry of a column whose direct children marked `data-page` are its pages. */
function measure(el: HTMLElement): ScrollColumn {
  const origin = el.getBoundingClientRect().top + el.clientTop - el.scrollTop;
  const pages = Array.from(el.querySelectorAll<HTMLElement>(":scope > [data-page]"), (page) => ({
    key: page.dataset["page"] ?? "",
    top: page.getBoundingClientRect().top - origin,
  }));
  return { scrollTop: el.scrollTop, viewHeight: el.clientHeight, contentHeight: el.scrollHeight, pages };
}

/**
 * While `enabled`, scrolling either column scrolls the other to the same
 * page (see `linkedScrollTop`). When switched on, `first` follows `second`.
 * When `layoutKey` changes (the content of `second` was laid out anew:
 * blocks left out, the page layout switched), `second` follows `first`,
 * which did not move.
 */
export function useLinkedScroll(first: RefObject<HTMLElement>, second: RefObject<HTMLElement>, enabled: boolean, layoutKey = ""): void {
  const followFirst = useRef<(() => void) | null>(null);
  useEffect(() => {
    const a = first.current;
    const b = second.current;
    if (!enabled || !a || !b) return;
    // The position each column was moved to by the other; its scroll event is then not the user's.
    const moved = new Map<HTMLElement, number>();
    const follow = (source: HTMLElement, target: HTMLElement) => {
      const expected = moved.get(source);
      moved.delete(source);
      if (expected !== undefined && Math.abs(source.scrollTop - expected) < 1) return;
      const top = linkedScrollTop(measure(source), measure(target));
      if (Math.abs(target.scrollTop - top) < 1) return;
      target.scrollTop = top;
      moved.set(target, target.scrollTop);
    };
    const onFirst = () => follow(a, b);
    const onSecond = () => follow(b, a);
    a.addEventListener("scroll", onFirst, { passive: true });
    b.addEventListener("scroll", onSecond, { passive: true });
    follow(b, a);
    followFirst.current = onFirst;
    return () => {
      followFirst.current = null;
      a.removeEventListener("scroll", onFirst);
      b.removeEventListener("scroll", onSecond);
    };
  }, [enabled, first, second]);
  useEffect(() => followFirst.current?.(), [layoutKey]);
}
