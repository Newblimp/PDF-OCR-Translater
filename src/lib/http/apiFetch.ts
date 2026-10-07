/**
 * Minimal authenticated JSON fetch used by the Mistral and OpenAI clients,
 * with uniform error mapping and the same retry policy as the Anthropic SDK:
 * 408, 409, 429, 5xx and connection failures are retried twice with
 * exponential backoff, honouring `retry-after`. A retry only happens before a
 * response body is read (a stream is never restarted midway), and cancelling
 * also stops the backoff. Anthropic goes through the official SDK instead
 * (`src/lib/anthropic/client.ts`, pinned to https://api.anthropic.com), whose
 * errors are mapped onto the same `ApiError`s. Together they are the app's
 * whole network surface: grep for `apiFetch(` and `createAnthropicClient(`.
 */
import { ApiError, kindForStatus, type ApiProvider } from "./apiError";

export interface ApiFetchOptions {
  provider: ApiProvider;
  apiKey: string;
  method: "GET" | "POST";
  body?: string;
  signal?: AbortSignal | undefined;
  accept?: string;
  fetchImpl?: typeof fetch;
  /** Retries after the first attempt (default `DEFAULT_MAX_RETRIES`). */
  maxRetries?: number | undefined;
}

export const DEFAULT_MAX_RETRIES = 2;
/** Longest wait honoured from a `retry-after` header; anything longer fails right away. */
const MAX_RETRY_AFTER_MS = 60_000;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Delay before retry number `attempt` (0-based): the server's `retry-after(-ms)` when given, else 0.5 s, 1 s, 2 s, ... (max 8 s) with jitter. */
export function retryDelayMs(attempt: number, headers: Headers | null): number | null {
  const ms = Number(headers?.get("retry-after-ms"));
  if (headers?.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms <= MAX_RETRY_AFTER_MS ? ms : null;
  const after = headers?.get("retry-after");
  if (after) {
    const seconds = Number(after);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
    if (Number.isFinite(wait)) return wait <= MAX_RETRY_AFTER_MS ? Math.max(0, wait) : null;
  }
  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
}

/** Wait, unless the signal fires first (then reject with an AbortError). */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, i?: RequestInit) => fetch(input, i));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      const error = toApiError(err, options.provider);
      if (error.kind !== "network" || attempt >= maxRetries) throw error;
      await waitBeforeRetry(retryDelayMs(attempt, null), options);
      continue;
    }
    if (res.ok) return res;
    const delay = isRetryableStatus(res.status) && attempt < maxRetries ? retryDelayMs(attempt, res.headers) : null;
    if (delay === null) throw await errorFromResponse(res, options.provider);
    void res.body?.cancel().catch(() => undefined);
    await waitBeforeRetry(delay, options);
  }
}

async function waitBeforeRetry(ms: number | null, options: ApiFetchOptions): Promise<void> {
  try {
    await sleep(ms ?? 0, options.signal);
  } catch (err) {
    throw toApiError(err, options.provider);
  }
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
  return new ApiError(message, kindForStatus(res.status), provider, res.status, body);
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
