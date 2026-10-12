import { OpenAIClient } from "../openai/client";
import { chatCompletionsRequest } from "./content";
import { openaiModelOptions } from "../openai/models";
import type { ChatCompletionRequest } from "../openai/types";
import type { ChatProvider, JsonChatRequest, JsonChatResult } from "./provider";
import { ApiError } from "../http/apiError";

/**
 * OpenAI Chat Completions provider (GPT Luna by default).
 * Notes:
 *  - GPT-5.x models reject `temperature`, so it is never sent.
 *  - `reasoning_effort` is sent when set; "none" keeps outputs fast and cheap.
 *  - Streaming requests ask for usage in the final chunk.
 *  - Prompt caching is automatic for long shared prefixes, which is why the
 *    context and images come before the task (`userMessage()`).
 */
export class OpenAIProvider implements ChatProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI (GPT Luna)";

  constructor(private readonly client: OpenAIClient) {}

  static fromKey(apiKey: string): OpenAIProvider {
    return new OpenAIProvider(new OpenAIClient({ apiKey }));
  }

  async listModels(signal?: AbortSignal) {
    return openaiModelOptions(await this.client.listModels(signal));
  }

  async completeJson(request: JsonChatRequest): Promise<JsonChatResult> {
    const body: ChatCompletionRequest = chatCompletionsRequest(request, (url) => ({ type: "image_url" as const, image_url: { url, detail: "auto" as const } }));
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
    if (request.maxOutputTokens) body.max_completion_tokens = request.maxOutputTokens;

    const result = await this.client.complete(body, request);
    if (result.refusal && !result.content) {
      throw new ApiError(`The model refused to answer: ${result.refusal}`, "refusal", "openai");
    }
    return {
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage
        ? {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
            reasoning_tokens: result.usage.completion_tokens_details?.reasoning_tokens,
            cache_read_tokens: result.usage.prompt_tokens_details?.cached_tokens || undefined,
          }
        : null,
      model: result.model,
    };
  }
}
