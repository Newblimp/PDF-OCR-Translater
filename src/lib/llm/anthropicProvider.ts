import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient, toAnthropicApiError } from "../anthropic/client";
import { ANTHROPIC_DEFAULT_MAX_TOKENS, anthropicModelOptions } from "../anthropic/models";
import type { ChatProvider, JsonChatRequest, JsonChatResult, ReasoningEffort } from "./provider";
import { ApiError } from "../http/apiError";

/**
 * Anthropic Messages API provider (Claude Haiku 5.5 by default), on the
 * official SDK. Notes:
 *  - Current Claude models reject non-default `temperature`, so it is never sent.
 *  - Thinking is adaptive (on by default); `output_config.effort` steers it.
 *    There is no "none" level, so "none" maps to "low".
 *  - `json_schema` uses structured outputs (`output_config.format`); the API
 *    has no `json_object` mode, so that mode relies on the prompt alone.
 *  - A safety refusal (`stop_reason: "refusal"`) without output is an error;
 *    with partial output it is reported like a content filter.
 *  - Every SDK error is mapped onto `ApiError` by `toAnthropicApiError()`.
 */
const EFFORT: Record<ReasoningEffort, NonNullable<Anthropic.OutputConfig["effort"]>> = { none: "low", low: "low", medium: "medium", high: "high" };

/** Text first, then each image preceded by a short label carrying its id. */
function userContent(request: JsonChatRequest): string | Anthropic.ContentBlockParam[] {
  if (!request.images?.length) return request.user;
  const blocks: Anthropic.ContentBlockParam[] = [{ type: "text", text: request.user }];
  for (const image of request.images) {
    blocks.push({ type: "text", text: `Image "${image.id}":` });
    blocks.push({ type: "image", source: imageSource(image.dataUrl) });
  }
  return blocks;
}

/** `data:image/png;base64,...` → base64 source; anything else is passed as a URL. */
function imageSource(dataUrl: string): Anthropic.ImageBlockParam["source"] {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/s.exec(dataUrl);
  if (!match) return { type: "url", url: dataUrl };
  return { type: "base64", media_type: match[1] as Anthropic.Base64ImageSource["media_type"], data: match[2]! };
}

/** Map Anthropic stop reasons onto the names the pipeline checks ("length", "content_filter"). */
function finishReason(stopReason: Anthropic.StopReason | null): string | null {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "model_context_window_exceeded":
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return stopReason;
  }
}

/** Stream the message, reporting the text as it grows (thinking deltas are not text). */
async function streamMessage(client: Anthropic, body: Anthropic.MessageCreateParamsNonStreaming, request: JsonChatRequest): Promise<Anthropic.Message> {
  const stream = client.messages.stream(body, { signal: request.signal });
  const onDelta = request.onDelta;
  if (onDelta) {
    let accumulated = "";
    stream.on("text", (delta) => {
      accumulated += delta;
      onDelta(delta, accumulated);
    });
  }
  return stream.finalMessage();
}

export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic (Claude)";
  private readonly client: Promise<Anthropic>;

  /** Takes the SDK client, or the promise `createAnthropicClient()` returns while the SDK loads. */
  constructor(client: Anthropic | Promise<Anthropic>) {
    this.client = Promise.resolve(client);
    this.client.catch(() => {}); // a failed SDK load is reported by the first call
  }

  static fromKey(apiKey: string): AnthropicProvider {
    return new AnthropicProvider(createAnthropicClient(apiKey));
  }

  async listModels(signal?: AbortSignal) {
    try {
      const client = await this.client;
      const page = await client.models.list({ limit: 1000 }, { signal });
      return anthropicModelOptions(page.data);
    } catch (err) {
      throw toAnthropicApiError(err);
    }
  }

  async completeJson(request: JsonChatRequest): Promise<JsonChatResult> {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: userContent(request) }],
    };
    const outputConfig: Anthropic.OutputConfig = {};
    if (request.reasoningEffort) outputConfig.effort = EFFORT[request.reasoningEffort];
    if (request.format.type === "json_schema") outputConfig.format = { type: "json_schema", schema: request.format.schema };
    if (outputConfig.effort || outputConfig.format) body.output_config = outputConfig;

    let message: Anthropic.Message;
    try {
      const client = await this.client;
      message = request.stream ? await streamMessage(client, body, request) : await client.messages.create(body, { signal: request.signal });
    } catch (err) {
      throw toAnthropicApiError(err);
    }
    if (!Array.isArray(message?.content)) {
      throw new ApiError("Message response has no content", "protocol", "anthropic", undefined, message);
    }

    // Text blocks only: adaptive thinking adds `thinking` blocks first.
    const content = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    if (message.stop_reason === "refusal" && !content) {
      const reason = message.stop_details?.explanation || message.stop_details?.category || "no reason given";
      throw new ApiError(`The model refused to answer: ${reason}`, "refusal", "anthropic");
    }
    const { usage } = message;
    const prompt = usage ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : 0;
    return {
      content,
      finishReason: finishReason(message.stop_reason),
      usage: usage ? { prompt_tokens: prompt, completion_tokens: usage.output_tokens, total_tokens: prompt + usage.output_tokens } : null,
      model: message.model,
    };
  }
}
