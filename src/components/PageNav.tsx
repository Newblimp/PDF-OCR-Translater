import type { ComponentChildren } from "preact";

/** "← Previous · what is on this page · Next →" for the views that show one page at a time. */
export function PageNav({
  position,
  count,
  onMove,
  children,
}: {
  position: number;
  count: number;
  onMove: (position: number) => void;
  children: ComponentChildren;
}) {
  return (
    <>
      <button type="button" class="btn btn-ghost small" disabled={position <= 0} onClick={() => onMove(position - 1)}>
        ← Previous
      </button>
      <span class="muted small">{children}</span>
      <button type="button" class="btn btn-ghost small" disabled={position >= count - 1} onClick={() => onMove(position + 1)}>
        Next →
      </button>
    </>
  );
}
