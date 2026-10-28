import type { AppError } from "@/app/store";

interface Props {
  error: AppError;
  onDismiss: () => void;
  /** Runs the job that failed again (offered when `error.retryable`). */
  onRetry?: (() => void) | undefined;
}

export function ErrorBanner({ error, onDismiss, onRetry }: Props) {
  return (
    <div class="banner banner-error" role="alert" id="work-error">
      <div class="banner-body">
        <strong>{error.title}</strong>
        <p>{error.message}</p>
        {error.hint && <p class="muted">{error.hint}</p>}
        {error.retryable && onRetry && (
          <p>
            <button type="button" class="btn btn-primary small" onClick={onRetry}>
              Retry
            </button>
          </p>
        )}
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
