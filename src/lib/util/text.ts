/** Small text/number formatting helpers shared by UI and pipeline. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "–";
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * Rough token estimate good enough for warnings. CJK characters are roughly
 * one token each on Mistral's tokenizer; Latin text is ~4 characters/token.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0xac00 && code <= 0xd7af) || // hangul
      (code >= 0xf900 && code <= 0xfaff) // CJK compat
    ) {
      cjk++;
    }
  }
  const other = text.length - cjk;
  return Math.round(cjk * 1.1 + other / 4);
}

/** Convert `snake_case`, `camelCase` or `kebab-case` keys into a readable label. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
