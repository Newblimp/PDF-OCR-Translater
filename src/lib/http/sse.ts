/**
 * Minimal Server-Sent-Events parser for `fetch` response bodies.
 *
 * Mistral streams chat completions as `data: {json}` lines terminated by a
 * `data: [DONE]` sentinel. This helper is deliberately generic and pure so it
 * can be unit-tested without a network.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Incremental parser: feed it text chunks, it yields complete events.
 * Handles events split across chunk boundaries and CRLF line endings.
 */
export class SseParser {
  private buffer = "";

  /** Parse a chunk of text and return every complete event it completes. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    // An event ends with a blank line. Normalise CRLF first.
    let boundary: number;
    while ((boundary = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const parsed = parseEventBlock(rawEvent);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** Flush whatever is left (e.g. a final event without trailing blank line). */
  end(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = rest.trim() ? parseEventBlock(rest) : null;
    return parsed ? [parsed] : [];
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    // id / retry are ignored on purpose.
  }
  if (dataLines.length === 0) return null;
  const result: SseEvent = { data: dataLines.join("\n") };
  if (event !== undefined) result.event = event;
  return result;
}

/**
 * Read a streaming `Response` body and invoke `onEvent` for each SSE event.
 * Resolves when the stream ends. Honours the `AbortSignal` attached to the
 * original `fetch` call (the reader throws on abort).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
    }
    for (const ev of parser.push(decoder.decode())) onEvent(ev);
    for (const ev of parser.end()) onEvent(ev);
  } finally {
    reader.releaseLock();
  }
}
