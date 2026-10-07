/**
 * Markdown → sanitised HTML, loaded lazily (marked + DOMPurify live in their
 * own chunk, fetched the first time a rendered view is shown).
 *
 * Two flavours: the app's renderer (the page's CSP blocks remote images), and
 * the export renderer for files the app writes, which get no CSP from the
 * site: it also removes every attribute that would fetch a URL when the file
 * is opened (anything but `data:` in src, srcset, background, poster, ...).
 */
export type MarkdownRenderer = (markdown: string) => string;

type Libraries = [typeof import("marked"), typeof import("dompurify")];
let librariesPromise: Promise<Libraries> | null = null;
let rendererPromise: Promise<MarkdownRenderer> | null = null;
let exportRendererPromise: Promise<MarkdownRenderer> | null = null;

const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
  FORBID_ATTR: ["style", "onerror", "onload"],
};

/** Attributes that make a browser or a word processor load a resource when the document opens. */
const FETCHING_ATTRIBUTES = ["src", "srcset", "background", "poster", "lowsrc", "dynsrc", "data", "xlink:href"];

function loadLibraries(): Promise<Libraries> {
  if (!librariesPromise) {
    librariesPromise = Promise.all([import("marked"), import("dompurify")]).catch((err: unknown) => {
      librariesPromise = null; // a failed chunk load is retried next time
      throw err;
    });
  }
  return librariesPromise;
}

function makeRenderer([markedModule]: Libraries, purify: typeof import("dompurify").default): MarkdownRenderer {
  const marked = new markedModule.Marked({ gfm: true, breaks: true });
  return (markdown: string) => {
    const html = marked.parse(markdown, { async: false });
    return purify.sanitize(typeof html === "string" ? html : "", SANITIZE);
  };
}

export function loadMarkdownRenderer(): Promise<MarkdownRenderer> {
  if (!rendererPromise) {
    rendererPromise = loadLibraries().then(
      (libraries) => makeRenderer(libraries, libraries[1].default),
      (err: unknown) => {
        rendererPromise = null;
        throw err;
      },
    );
  }
  return rendererPromise;
}

/** Renderer for exported files: like the app's, minus anything that would load a remote resource. */
export function loadExportMarkdownRenderer(): Promise<MarkdownRenderer> {
  if (!exportRendererPromise) {
    exportRendererPromise = loadLibraries().then(
      (libraries) => {
        // A separate DOMPurify instance, so its hook does not change the app's renderer.
        const purify = libraries[1].default(window);
        purify.addHook("afterSanitizeAttributes", (node) => {
          for (const name of FETCHING_ATTRIBUTES) {
            const value = node.getAttribute(name);
            if (value !== null && !/^\s*data:/i.test(value)) node.removeAttribute(name);
          }
        });
        return makeRenderer(libraries, purify);
      },
      (err: unknown) => {
        exportRendererPromise = null;
        throw err;
      },
    );
  }
  return exportRendererPromise;
}
