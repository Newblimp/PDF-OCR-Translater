import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * A view whose code is imported the first time it is shown (its own chunk),
 * so the page loads without it. Until then it shows a note; a chunk that
 * fails to load (offline, or a newer deployment replaced it) says so, and is
 * tried again the next time the view is shown.
 */
export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let view: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;

  return function LazyView(props: P) {
    const [, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      if (view) return;
      let live = true;
      (loading ??= load()).then(
        (loaded) => {
          view = loaded;
          if (live) setLoaded(true);
        },
        (err: unknown) => {
          loading = null;
          if (live) setError(err instanceof Error ? err.message : String(err));
        },
      );
      return () => {
        live = false;
      };
    }, []);
    if (view) {
      const View = view;
      return <View {...props} />;
    }
    return <p class="muted small view-loading">{error ? `This view could not be loaded (${error}). Reload the page to try again.` : "Loading…"}</p>;
  };
}
