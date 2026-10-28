/**
 * Dependency-free client for the OpenAI Chat Completions API: the chat and
 * model endpoints it shares with Mistral (`http/chatClient.ts`). Only
 * `baseUrl` (https://api.openai.com) is ever contacted; the CSP in
 * `public/_headers` enforces this.
 */
import { apiBaseUrl } from "../apiProviders";
import { ChatCompletionsClient, type ChatClientOptions } from "../http/chatClient";
import type { ChatCompletionRequest, ModelObject, Usage } from "./types";

export const DEFAULT_OPENAI_BASE_URL = apiBaseUrl("openai");

export class OpenAIClient extends ChatCompletionsClient<ChatCompletionRequest, Usage, ModelObject> {
  constructor(options: ChatClientOptions) {
    super("openai", DEFAULT_OPENAI_BASE_URL, options);
  }

  /** Usage arrives in the final chunk of a stream only when asked for. */
  protected override streamFields(): object {
    return { stream_options: { include_usage: true } };
  }
}
