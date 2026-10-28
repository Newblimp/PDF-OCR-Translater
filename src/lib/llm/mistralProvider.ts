import { API_PROVIDERS } from "../apiProviders";
import { ApiError } from "../http/apiError";
import { MistralClient } from "../mistral/client";
import { chatModelOptions } from "../mistral/models";
import { chatCompletionsRequest } from "./content";
import type { ChatCompletionRequest } from "../mistral/types";
import type { ChatProvider, JsonChatRequest, JsonChatResult, ReasoningEffort } from "./provider";

/** Mistral documents "none" and "high" for its reasoning models; the app's "low" and "medium" think too. */
function mistralEffort(effort: ReasoningEffort): "none" | "high" {
  return effort === "none" ? "none" : "high";
}

/** Models that rejected `reasoning_effort` in this session (not every Mistral model reasons): it is no longer sent to them. */
const NO_REASONING_EFFORT = new Set<string>();

/** Mistral chat provider: the default for translation (Mistral Small), with Anthropic and OpenAI as alternatives. */
export class MistralProvider implements ChatProvider {
  readonly id = "mistral" as const;
  readonly label = API_PROVIDERS.mistral.label;

  constructor(private readonly client: MistralClient) {}

  static fromKey(apiKey: string): MistralProvider {
    return new MistralProvider(new MistralClient({ apiKey }));
  }

  async listModels(signal?: AbortSignal) {
    return chatModelOptions(await this.client.listModels(signal));
  }

  async completeJson(request: JsonChatRequest): Promise<JsonChatResult> {
    const body: ChatCompletionRequest = chatCompletionsRequest(request, (url) => ({ type: "image_url" as const, image_url: url }));
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
    const result = await this.client.complete(body, request);
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
