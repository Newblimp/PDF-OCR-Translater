/**
 * Error type shared by every API client in the app. `kind` drives the
 * user-facing hint and the pipeline's retry decisions.
 */
import { API_PROVIDERS, type ProviderId } from "../apiProviders";

export type ApiErrorKind =
  | "network" // fetch itself failed: offline, DNS, CORS, blocked by CSP
  | "auth" // 401 / 403
  | "rate_limit" // 429
  | "request" // other 4xx (bad schema, unsupported parameter, file too large, ...)
  | "server" // 5xx
  | "aborted" // the caller cancelled
  | "refusal" // the model declined to answer (a completed, billed response)
  | "protocol"; // unexpected response shape

/** The kind of an HTTP error response (used by `apiFetch` and the Anthropic SDK error mapping). */
export function kindForStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return status >= 500 ? "server" : "request";
}

/** Messages of 4xx rejections that fail the same way whatever the request shape: unsupported parameters, unknown or inaccessible models. */
const PERMANENT_REJECTION = /unsupported parameter|unsupported value|model_not_found|does not exist|do not have access|invalid model/i;

/** A rejected request ("request" kind) that resending in another shape (no images, no streaming, json_object) cannot fix. */
export function isPermanentRejection(err: ApiError): boolean {
  return err.kind === "request" && PERMANENT_REJECTION.test(err.message);
}

/** The provider complained about the images themselves: no vision support, bad content type, payload too large. */
export function isImageRejection(err: ApiError): boolean {
  return err.status === 413 || /image|vision|content type|multimodal|too large|payload/i.test(err.message);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** A short, user-facing explanation with a hint on what to do. */
  get hint(): string {
    const name = API_PROVIDERS[this.provider].name;
    switch (this.kind) {
      case "network":
        return `The request never reached the ${name} API. Check your connection. If you are online, the browser may have blocked the call (CORS or Content-Security-Policy).`;
      case "auth":
        return `The ${name} API key was rejected. Open the key dialog and enter a valid key.`;
      case "rate_limit":
        return `Rate limit or quota exceeded on your ${name} account. Wait a moment and retry.`;
      case "request":
        return `The ${name} API rejected the request. See the details below.`;
      case "server":
        return `The ${name} API had an internal problem. Retrying usually helps.`;
      case "aborted":
        return "The request was cancelled.";
      case "refusal":
        return `The ${name} model declined to produce the translation. Check the document content or try another model.`;
      case "protocol":
        return `The ${name} API answered with an unexpected payload.`;
    }
  }
}

/** Whatever a request threw, as an `ApiError`: cancellations are "aborted", anything else that is not one already a network failure. */
export function toApiError(err: unknown, provider: ProviderId): ApiError {
  if (err instanceof ApiError) return err;
  if ((err instanceof DOMException || err instanceof Error) && err.name === "AbortError") {
    return new ApiError("Request cancelled", "aborted", provider);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(`Network error: ${message}`, "network", provider);
}

/** Best-effort extraction of a human-readable message from an error payload. */
export function extractErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  if (typeof b["message"] === "string") return b["message"];
  const error = b["error"];
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>)["message"] === "string") {
    return (error as Record<string, string>)["message"] ?? "";
  }
  const detail = b["detail"];
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d))).join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return "";
}
