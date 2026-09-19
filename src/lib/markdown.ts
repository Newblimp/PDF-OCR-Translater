/**
 * Markdown → sanitised HTML, loaded lazily (marked + DOMPurify live in their
 * own chunk, fetched the first time a rendered view is shown).
 */
type Renderer = (markdown: string) => string;
let rendererPromise: Promise<Renderer> | null = null;

export function loadMarkdownRenderer(): Promise<Renderer> {
  if (!rendererPromise) {
    rendererPromise = Promise.all([import("marked"), import("dompurify")]).then(([markedModule, purifyModule]) => {
      const marked = new markedModule.Marked({ gfm: true, breaks: true });
      const purify = purifyModule.default;
      return (markdown: string) => {
        const html = marked.parse(markdown, { async: false });
        return purify.sanitize(typeof html === "string" ? html : "", {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
          FORBID_ATTR: ["style", "onerror", "onload"],
        });
      };
    });
  }
  return rendererPromise;
}
