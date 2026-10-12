import type { ComponentChildren } from "preact";

/** A checkbox with its label (`.checkbox`); `onChange` gets the new state. */
export function Check({
  checked,
  onChange,
  children,
  small = false,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ComponentChildren;
  small?: boolean;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <label class={small ? "checkbox small" : "checkbox"} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span>{children}</span>
    </label>
  );
}
