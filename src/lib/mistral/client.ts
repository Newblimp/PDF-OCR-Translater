/**
 * Dependency-free client for the Mistral API: OCR, plus the chat and model
 * endpoints it shares with OpenAI (`http/chatClient.ts`).
 *
 * The only host contacted is `baseUrl` (https://api.mistral.ai by default,
 * also enforced by the CSP in `public/_headers`).
 */
import { apiBaseUrl } from "../apiProviders";
import { ChatCompletionsClient, type ChatClientOptions } from "../http/chatClient";
import type { ChatCompletionRequest, ContentChunk, ModelCard, OcrRequest, OcrResponse, UsageInfo } from "./types";

export const DEFAULT_BASE_URL = apiBaseUrl("mistral");

/** What the OCR steps need of the client: the pipeline takes any object with `ocr()` (the runner's imports the client on first use). */
export type OcrClient = Pick<MistralClient, "ocr">;

export class MistralClient extends ChatCompletionsClient<ChatCompletionRequest, UsageInfo, ModelCard> {
  constructor(options: ChatClientOptions) {
    super("mistral", DEFAULT_BASE_URL, options);
  }

  /** POST /v1/ocr */
  ocr(request: OcrRequest, signal?: AbortSignal): Promise<OcrResponse> {
    return this.getJson<OcrResponse>("/v1/ocr", "OCR response", (json) => Array.isArray(json?.pages), {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  protected override contentText(content: unknown): string {
    return contentToText(content);
  }
}

/** Normalise `content` (string | chunk[] | null) into plain text. Thinking chunks are ignored. */
export function contentToText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentChunk[]).map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : "")).join("");
}
