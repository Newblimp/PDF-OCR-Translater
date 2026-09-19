import { useEffect, useState } from "preact/hooks";
import { loadMarkdownRenderer } from "@/lib/markdown";

interface Props {
  text: string;
  /** false = plain text with preserved whitespace. */
  markdown: boolean;
}

/**
 * Renders a string either as sanitised Markdown or as pre-wrapped text.
 * The Markdown renderer is fetched lazily; until it arrives (and on failure)
 * the plain text is shown so nothing ever looks empty.
 */
export function MarkdownText({ text, markdown }: Props) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!markdown) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    loadMarkdownRenderer()
      .then((render) => {
        if (!cancelled) setHtml(render(text));
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text, markdown]);

  if (markdown && html !== null) {
    return <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div class="prose prose-plain">{text}</div>;
}
