import type { ComponentChildren } from "preact";

/** A small "ⓘ" that opens technical details (models, counts, tokens), kept out of the way of the reading. */
export function InfoPop({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <details class="info-pop">
      <summary aria-label={label} title={label}>
        ⓘ
      </summary>
      <div class="info-pop-body small">{children}</div>
    </details>
  );
}
