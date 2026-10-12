import { ApiError } from "../http/apiError";
import { MistralClient } from "../mistral/client";
import { chatModelOptions } from "../mistral/models";
import { plainUserText, userMessage } from "./content";
import type { ChatCompletionRequest, ContentChunk } from "../mistral/types";
import type { ChatProvider, JsonChatRequest, JsonChatResult, ReasoningEffort } from "./provider";

/** Mistral documents "none" and "high" for its reasoning models; the app's "low" and "medium" think too. */
function mistralEffort(effort: ReasoningEffort): "none" | "high" {
  return effort === "none" ? "none" : "high";
}

/** Models that rejected `reasoning_effort` in this session (not every Mistral model reasons): it is no longer sent to them. */
const NO_REASONING_EFFORT = new Set<string>();

/** Context, images, then the task (see `userMessage()`). */
function userContent(request: JsonChatRequest): string | ContentChunk[] {
  const message = userMessage(request);
  return plainUserText(message) ?? message.parts.map((part): ContentChunk => (part.type === "text" ? part : { type: "image_url", image_url: part.dataUrl }));
}

/** Mistral chat provider: the default for translation (Mistral Small), with Anthropic and OpenAI as alternatives. */
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
    if (request.reasoningEffort && !NO_REASONING_EFFORT.has(request.model)) body.reasoning_effort = mistralEffort(request.reasoningEffort);

    try {
      return await this.send(body, request);
    } catch (err) {
      if (!body.reasoning_effort || !(err instanceof ApiError) || err.kind !== "request" || request.signal?.aborted) throw err;
      // Rejected: if the same request without `reasoning_effort` goes through, the model does not take it.
      const { reasoning_effort: _rejected, ...without } = body;
      const result = await this.send(without, request);
      NO_REASONING_EFFORT.add(request.model);
      return result;
    }
  }

  private async send(body: ChatCompletionRequest, request: JsonChatRequest): Promise<JsonChatResult> {
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
