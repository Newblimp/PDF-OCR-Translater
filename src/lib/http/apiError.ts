/**
 * Error type shared by every API client in the app. `kind` drives the
 * user-facing hint and the pipeline's retry decisions.
 */
export type ApiErrorKind =
  | "network" // fetch itself failed: offline, DNS, CORS, blocked by CSP
  | "auth" // 401 / 403
  | "rate_limit" // 429
  | "request" // other 4xx (bad schema, unsupported parameter, file too large, ...)
  | "server" // 5xx
  | "aborted" // the caller cancelled
  | "refusal" // the model declined to answer (a completed, billed response)
  | "protocol"; // unexpected response shape

export type ApiProvider = "mistral" | "openai";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly provider: ApiProvider,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** A short, user-facing explanation with a hint on what to do. */
  get hint(): string {
    const name = this.provider === "openai" ? "OpenAI" : "Mistral";
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
