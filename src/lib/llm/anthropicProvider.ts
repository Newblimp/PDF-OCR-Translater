import { AnthropicClient } from "../anthropic/client";
import { ANTHROPIC_DEFAULT_MAX_TOKENS, anthropicModelOptions } from "../anthropic/models";
import type { ContentBlockParam, Effort, ImageSource, MessageCreateRequest } from "../anthropic/types";
import type { ChatProvider, JsonChatRequest, JsonChatResult, ReasoningEffort } from "./provider";
import { ApiError } from "../http/apiError";

/**
 * Anthropic Messages API provider (Claude Haiku 5.5 by default).
 * Notes:
 *  - Current Claude models reject non-default `temperature`, so it is never sent.
 *  - Thinking is adaptive (on by default); `output_config.effort` steers it.
 *    There is no "none" level, so "none" maps to "low".
 *  - `json_schema` uses structured outputs (`output_config.format`); the API
 *    has no `json_object` mode, so that mode relies on the prompt alone.
 *  - A safety refusal (`stop_reason: "refusal"`) without output is an error;
 *    with partial output it is reported like a content filter.
 */
const EFFORT: Record<ReasoningEffort, Effort> = { none: "low", low: "low", medium: "medium", high: "high" };

/** Text first, then each image preceded by a short label carrying its id. */
function userContent(request: JsonChatRequest): string | ContentBlockParam[] {
  if (!request.images?.length) return request.user;
  const blocks: ContentBlockParam[] = [{ type: "text", text: request.user }];
  for (const image of request.images) {
    blocks.push({ type: "text", text: `Image "${image.id}":` });
    blocks.push({ type: "image", source: imageSource(image.dataUrl) });
  }
  return blocks;
}

/** `data:image/png;base64,...` → base64 source; anything else is passed as a URL. */
function imageSource(dataUrl: string): ImageSource {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/s.exec(dataUrl);
  if (!match) return { type: "url", url: dataUrl };
  return { type: "base64", media_type: match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: match[2]! };
}

/** Map Anthropic stop reasons onto the names the pipeline checks ("length", "content_filter"). */
function finishReason(stopReason: string | null): string | null {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return stopReason;
  }
}

export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic (Claude)";

  constructor(private readonly client: AnthropicClient) {}

  static fromKey(apiKey: string): AnthropicProvider {
    return new AnthropicProvider(new AnthropicClient({ apiKey }));
  }

  async listModels(signal?: AbortSignal) {
    return anthropicModelOptions(await this.client.listModels(signal));
  }

  async completeJson(request: JsonChatRequest): Promise<JsonChatResult> {
    const body: MessageCreateRequest = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: userContent(request) }],
    };
    const outputConfig: NonNullable<MessageCreateRequest["output_config"]> = {};
    if (request.reasoningEffort) outputConfig.effort = EFFORT[request.reasoningEffort];
    if (request.format.type === "json_schema") outputConfig.format = { type: "json_schema", schema: request.format.schema };
    if (outputConfig.effort || outputConfig.format) body.output_config = outputConfig;

    const result = request.stream
      ? await this.client.messagesStream(body, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.onDelta ? { onDelta: request.onDelta } : {}),
        })
      : await this.client.messages(body, request.signal);

    if (result.stopReason === "refusal" && !result.content) {
      const reason = result.stopDetails?.explanation || result.stopDetails?.category || "no reason given";
      throw new ApiError(`The model refused to answer: ${reason}`, "refusal", "anthropic");
    }
    const usage = result.usage;
    const prompt = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0;
    return {
      content: result.content,
      finishReason: finishReason(result.stopReason),
      usage: usage
        ? { prompt_tokens: prompt, completion_tokens: usage.output_tokens ?? undefined, total_tokens: prompt + (usage.output_tokens ?? 0) }
        : null,
      model: result.model,
    };
  }
}
