import type { JSX } from "preact";
import type { ThemeSetting } from "@/lib/storage/settings";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

interface Props {
  value: ThemeSetting;
  onChange: (theme: ThemeSetting) => void;
}

/** Same order and icons as refcheck's theme toggle: light, system, dark. */
const OPTIONS: Array<{ id: ThemeSetting; label: string; Icon: () => JSX.Element }> = [
  { id: "light", label: "Light", Icon: SunIcon },
  { id: "system", label: "System", Icon: MonitorIcon },
  { id: "dark", label: "Dark", Icon: MoonIcon },
];

/** Three-way theme selector: follow the OS, or force light/dark. */
export function ThemeSwitch({ value, onChange }: Props) {
  return (
    <div class="segmented" role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          aria-label={`${label} theme`}
          class={`segment segment-icon${value === id ? " segment-active" : ""}`}
          title={`${label} theme`}
          onClick={() => onChange(id)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
