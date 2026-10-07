import { MistralClient } from "../mistral/client";
import { chatModelOptions } from "../mistral/models";
import { plainUserText, userMessage } from "./content";
import type { ChatCompletionRequest, ContentChunk } from "../mistral/types";
import type { ChatProvider, JsonChatRequest, JsonChatResult } from "./provider";

/** Context, images, then the task (see `userMessage()`). */
function userContent(request: JsonChatRequest): string | ContentChunk[] {
  const message = userMessage(request);
  return plainUserText(message) ?? message.parts.map((part): ContentChunk => (part.type === "text" ? part : { type: "image_url", image_url: part.dataUrl }));
}

/** Mistral chat provider (kept as an alternative to Anthropic and OpenAI for translation). */
export class MistralProvider implements ChatProvider {
  readonly id = "mistral" as const;
  readonly label = "Mistral";

  constructor(private readonly client: MistralClient) {}

  static fromKey(apiKey: string): MistralProvider {
    return new MistralProvider(new MistralClient({ apiKey }));
  }

  async listModels(signal?: AbortSignal) {
    return chatModelOptions(await this.client.listModels(signal));
  }

  async completeJson(request: JsonChatRequest): Promise<JsonChatResult> {
    const body: ChatCompletionRequest = {
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: userContent(request) },
      ],
      response_format:
        request.format.type === "json_schema"
          ? {
              type: "json_schema",
              json_schema: {
                name: request.format.name,
                description: request.format.description ?? null,
                schema: request.format.schema,
                strict: request.format.strict,
              },
            }
          : { type: "json_object" },
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;

    const result = request.stream
      ? await this.client.chatStream(body, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.onDelta ? { onDelta: request.onDelta } : {}),
        })
      : await this.client.chat(body, request.signal);
    return {
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage
        ? {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          }
        : null,
      model: result.model,
    };
  }
}
