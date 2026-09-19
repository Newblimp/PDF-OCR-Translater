import type { ThemeSetting } from "@/lib/storage/settings";

interface Props {
  value: ThemeSetting;
  onChange: (theme: ThemeSetting) => void;
}

const OPTIONS: Array<{ id: ThemeSetting; label: string; icon: string }> = [
  { id: "system", label: "System", icon: "◐" },
  { id: "light", label: "Light", icon: "☀" },
  { id: "dark", label: "Dark", icon: "☾" },
];

/** Three-way theme selector: follow the OS, or force light/dark. */
export function ThemeSwitch({ value, onChange }: Props) {
  return (
    <div class="segmented" role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          aria-label={`${o.label} theme`}
          class={`segment${value === o.id ? " segment-active" : ""}`}
          title={`${o.label} theme`}
          onClick={() => onChange(o.id)}
        >
          <span aria-hidden="true">{o.icon}</span> {o.label}
        </button>
      ))}
    </div>
  );
}
