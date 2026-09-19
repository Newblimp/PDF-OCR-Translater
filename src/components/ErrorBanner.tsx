import type { AppError } from "@/app/store";

interface Props {
  error: AppError;
  onDismiss: () => void;
}

export function ErrorBanner({ error, onDismiss }: Props) {
  return (
    <div class="banner banner-error" role="alert">
      <div class="banner-body">
        <strong>{error.title}</strong>
        <p>{error.message}</p>
        {error.hint && <p class="muted">{error.hint}</p>}
        {error.details && (
          <details>
            <summary>Details</summary>
            <pre class="details-pre">{error.details}</pre>
          </details>
        )}
      </div>
      <button type="button" class="btn btn-ghost" onClick={onDismiss} aria-label="Dismiss error">
        ✕
      </button>
    </div>
  );
}
