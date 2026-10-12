/** Small pieces shared by the result views: downloads, the clipboard, the "Show translation" switch, token usage. */
import type { TokenUsage } from "@/lib/llm/provider";
import { formatNumber } from "@/lib/util/text";

export function download(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

/** "1,234 in / 567 out tokens (1,000 cached, 50 reasoning)". */
export function usageText(usage: TokenUsage | null): string {
  const extras = [
    usage?.cache_read_tokens ? `${formatNumber(usage.cache_read_tokens)} cached` : "",
    usage?.reasoning_tokens ? `${formatNumber(usage.reasoning_tokens)} reasoning` : "",
  ].filter(Boolean);
  return `${formatNumber(usage?.prompt_tokens)} in / ${formatNumber(usage?.completion_tokens)} out tokens${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/**
 * "Show translation": switches the OCR text and the structured text between
 * the document's own language and the translation. One shared state, so all
 * tabs always show the same language.
 */
export function TranslationToggle({
  show,
  available,
  onShowTranslation,
  label = "Show translation",
}: {
  show: boolean;
  /** False when nothing translated is at hand yet: the switch stays off and explains itself. */
  available: boolean;
  onShowTranslation: (show: boolean) => void;
  label?: string;
}) {
  return (
    <label class="checkbox small" title={available ? "Switch between the document's language and the translation" : "Nothing translated yet"}>
      <input
        type="checkbox"
        checked={show && available}
        disabled={!available}
        onChange={(e) => onShowTranslation((e.target as HTMLInputElement).checked)}
      />
      <span>{label}</span>
    </label>
  );
}
