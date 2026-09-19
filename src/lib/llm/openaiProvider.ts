import { OpenAIClient } from "../openai/client";
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
    const body: ChatCompletionRequest = {
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format:
        request.format.type === "json_schema"
          ? {
              type: "json_schema",
              json_schema: {
                name: request.format.name,
                ...(request.format.description ? { description: request.format.description } : {}),
                schema: request.format.schema,
                strict: request.format.strict,
              },
            }
          : { type: "json_object" },
    };
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
    if (request.maxOutputTokens) body.max_completion_tokens = request.maxOutputTokens;

    const result = request.stream
      ? await this.client.chatStream(body, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.onDelta ? { onDelta: request.onDelta } : {}),
        })
      : await this.client.chat(body, request.signal);

    if (result.refusal && !result.content) {
      throw new ApiError(`The model refused to answer: ${result.refusal}`, "request", "openai");
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
          }
        : null,
      model: result.model,
    };
  }
}
