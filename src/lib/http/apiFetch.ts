/**
 * Minimal authenticated JSON fetch used by every API client, with uniform
 * error mapping. Keeping all outbound requests on this one function makes the
 * app's network surface auditable: grep for `apiFetch(` to see every call.
 */
import { ApiError, type ApiErrorKind, type ApiProvider } from "./apiError";

export interface ApiFetchOptions {
  provider: ApiProvider;
  apiKey: string;
  method: "GET" | "POST";
  body?: string;
  signal?: AbortSignal | undefined;
  accept?: string;
  fetchImpl?: typeof fetch;
}

export async function apiFetch(url: string, options: ApiFetchOptions): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    Accept: options.accept ?? "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const init: RequestInit = { method: options.method, headers };
  if (options.body !== undefined) init.body = options.body;
  if (options.signal) init.signal = options.signal;

  let res: Response;
  try {
    res = await (options.fetchImpl ?? ((input, i) => fetch(input, i)))(url, init);
  } catch (err) {
    throw toApiError(err, options.provider);
  }
  if (!res.ok) throw await errorFromResponse(res, options.provider);
  return res;
}

export function toApiError(err: unknown, provider: ApiProvider): ApiError {
  if (err instanceof ApiError) return err;
  if ((err instanceof DOMException || err instanceof Error) && err.name === "AbortError") {
    return new ApiError("Request cancelled", "aborted", provider);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(`Network error: ${message}`, "network", provider);
}

async function errorFromResponse(res: Response, provider: ApiProvider): Promise<ApiError> {
  let body: unknown = null;
  let message = `HTTP ${res.status} ${res.statusText}`.trim();
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
      const extracted = extractErrorMessage(body);
      if (extracted) message = `${message}: ${extracted}`;
    } catch {
      body = text;
      if (text) message = `${message}: ${text.slice(0, 500)}`;
    }
  } catch {
    // body could not be read
  }
  const kind: ApiErrorKind =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 429
        ? "rate_limit"
        : res.status >= 500
          ? "server"
          : "request";
  return new ApiError(message, kind, provider, res.status, body);
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
    return detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
      .join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return "";
}
