/**
 * Anthropic API access through the official `@anthropic-ai/sdk`.
 *
 * The SDK is loaded lazily (its own chunk, ~58 kB gzip) the first time a
 * client is created, so it stays out of the initial bundle. Only
 * https://api.anthropic.com is ever contacted: the base URL is pinned here
 * (no env or profile override) and the CSP in `public/_headers` enforces it.
 * `dangerouslyAllowBrowser` sends the `anthropic-dangerous-direct-browser-access`
 * CORS opt-in; that is fine here because the key is the user's own and never
 * leaves this browser except to the API.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { ApiError, kindForStatus } from "../http/apiError";
import { extractErrorMessage, toApiError } from "../http/apiFetch";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Per-request timeout. An explicit timeout also turns off the SDK's guard
 * that refuses non-streaming requests whose `max_tokens` could take over 10
 * minutes (64k does); the pipeline makes several non-streaming calls. One hour
 * is the SDK's own estimate for a full 128k-token answer, so only a hung
 * connection hits it; the user can cancel at any time.
 */
export const ANTHROPIC_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The SDK's default: 429, 5xx (including 529 overloaded), 408/409 and
 * connections that fail before a response are retried twice with backoff,
 * honouring `retry-after`. A retry only happens before any output arrived (a
 * stream is never restarted midway), and cancelling also stops the backoff.
 * The pipeline's own fallback ladder (`translate.ts`) only reshapes rejected
 * 4xx requests, so the two layers do not stack, except for 408/409: the SDK
 * retries those, and they then reach the ladder as "request" errors (at most
 * 3 attempts per request shape).
 */
export const ANTHROPIC_MAX_RETRIES = 2;

type Sdk = typeof import("@anthropic-ai/sdk");
let sdk: Sdk | undefined;
let sdkPromise: Promise<Sdk> | null = null;

/** Import the SDK once; a failed chunk load is retried on the next call. */
function loadSdk(): Promise<Sdk> {
  if (!sdkPromise) {
    sdkPromise = import("@anthropic-ai/sdk").then(
      (module) => (sdk = module),
      (err: unknown) => {
        sdkPromise = null;
        throw err;
      },
    );
  }
  return sdkPromise;
}

export interface AnthropicClientOptions {
  /** Replaces the global `fetch` (tests). */
  fetch?: typeof fetch;
}

export async function createAnthropicClient(apiKey: string, options: AnthropicClientOptions = {}): Promise<Anthropic> {
  const { default: Anthropic } = await loadSdk();
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    dangerouslyAllowBrowser: true,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
    fetch: options.fetch,
  });
}

/**
 * Map whatever a call through the SDK threw onto the app's `ApiError`, with
 * the kinds and messages `apiFetch` gives the other providers' errors.
 */
export function toAnthropicApiError(err: unknown): ApiError {
  if (sdk && err instanceof sdk.AnthropicError) return fromSdkError(err, sdk);
  if (err instanceof SyntaxError) return new ApiError(`Unreadable response: ${err.message}`, "protocol", "anthropic");
  return toApiError(err, "anthropic"); // an ApiError, a DOM AbortError, or the SDK chunk failing to load
}

function fromSdkError(err: InstanceType<Sdk["AnthropicError"]>, errors: Sdk): ApiError {
  if (err instanceof errors.APIUserAbortError) return new ApiError("Request cancelled", "aborted", "anthropic");
  if (err instanceof errors.APIConnectionError) {
    // Also APIConnectionTimeoutError; `cause` is what fetch threw (offline, CORS, CSP).
    const reason = err.cause instanceof Error ? err.cause.message : err.message;
    return new ApiError(`Network error: ${reason}`, "network", "anthropic");
  }
  if (err instanceof errors.APIError) {
    // No status: an `error` event in the middle of a stream (e.g. overloaded_error).
    if (err.status === undefined) return new ApiError(extractErrorMessage(err.error) || err.message, "server", "anthropic", undefined, err.error);
    return httpError(err.status, err);
  }
  // MessageStream wraps foreign errors (a connection dropped mid-stream, malformed event JSON) and keeps them as `cause`.
  if (err.cause instanceof Error && !(err.cause instanceof errors.AnthropicError)) return toAnthropicApiError(err.cause);
  return new ApiError(err.message, "protocol", "anthropic"); // e.g. a stream that ended without a message
}

/** Like `apiFetch`: "HTTP 401: invalid x-api-key" (the SDK keeps no status text) and the parsed or raw body. */
function httpError(status: number, err: InstanceType<Sdk["APIError"]>): ApiError {
  // A JSON body is parsed into `err.error`; any other body is in the message, after the status.
  const body: unknown = err.error ?? (err.message.replace(/^\d+ (status code \(no body\))?/, "") || undefined);
  const detail = typeof body === "string" ? body : extractErrorMessage(body);
  return new ApiError(detail ? `HTTP ${status}: ${detail.slice(0, 500)}` : `HTTP ${status}`, kindForStatus(status), "anthropic", status, body);
}
