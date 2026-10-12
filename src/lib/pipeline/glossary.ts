/** The glossary setting: required terminology, one `source = target` pair per line (the prompts list it; the options card counts it). */

/** Glossary entries as `source = target` pairs; blank lines and `#` comments are ignored. */
export function parseGlossary(glossary: string | undefined): Array<{ source: string; target: string }> {
  const entries: Array<{ source: string; target: string }> = [];
  for (const raw of (glossary ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(.+?)\s*(?:=>|=|→|\t)\s*(.+)$/.exec(line);
    if (match) entries.push({ source: match[1]!.trim(), target: match[2]!.trim() });
  }
  return entries;
}
