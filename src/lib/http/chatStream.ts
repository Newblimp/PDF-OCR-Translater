/**
 * Reader for the streamed Chat Completions format that Mistral and OpenAI
 * share: `data: {chunk}` SSE frames ending with `data: [DONE]`, text in
 * `choices[].delta.content`, usage in a late chunk, and errors as a chunk
 * without `choices` that carries `error` (or Mistral's `message`).
 */
import { ApiError, type ApiProvider } from "./apiError";
import { extractErrorMessage, toApiError } from "./apiFetch";
import { readSseStream } from "./sse";

export interface StreamedChat<U> {
  content: string;
  /** Refusal text streamed in `delta.refusal` (OpenAI). */
  refusal: string;
  finishReason: string | null;
  usage: U | null;
  model: string;
}

interface Chunk<U> {
  model?: string;
  usage?: U | null;
  error?: unknown;
  message?: unknown;
  choices?: Array<{ delta?: { content?: unknown; refusal?: string | null }; finish_reason?: string | null }>;
}

export interface ReadChatStreamOptions {
  provider: ApiProvider;
  /** Model reported until a chunk names the one that answered. */
  model: string;
  /** Text of a `delta.content` value (a string, or Mistral's chunk array). */
  deltaText: (content: unknown) => string;
  onDelta?: ((delta: string, accumulated: string) => void) | undefined;
}

export async function readChatStream<U>(res: Response, options: ReadChatStreamOptions): Promise<StreamedChat<U>> {
  if (!res.body) throw new ApiError("Streaming response has no body", "protocol", options.provider, res.status);
  const out: StreamedChat<U> = { content: "", refusal: "", finishReason: null, usage: null, model: options.model };
  let streamError: ApiError | null = null;
  try {
    await readSseStream(res.body, (ev) => {
      if (ev.data === "[DONE]") return;
      let chunk: Chunk<U>;
      try {
        chunk = JSON.parse(ev.data) as Chunk<U>;
      } catch {
        return; // ignore malformed keep-alive frames
      }
      if (!chunk.choices && (chunk.error || chunk.message)) {
        streamError = new ApiError(extractErrorMessage(chunk) || "Error in the response stream", "server", options.provider, res.status, chunk);
        return;
      }
      if (chunk.model) out.model = chunk.model;
      if (chunk.usage) out.usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = options.deltaText(choice.delta?.content);
        if (delta) {
          out.content += delta;
          options.onDelta?.(delta, out.content);
        }
        if (choice.delta?.refusal) out.refusal += choice.delta.refusal;
        if (choice.finish_reason) out.finishReason = choice.finish_reason;
      }
    });
  } catch (err) {
    throw toApiError(err, options.provider);
  }
  if (streamError) throw streamError;
  return out;
}
