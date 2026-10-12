import { describe, expect, it } from "vitest";
import { ApiError } from "../http/apiError";
import type { MistralClient } from "../mistral/client";
import type { ChatCompletionRequest } from "../mistral/types";
import { MistralProvider } from "./mistralProvider";
import type { JsonChatRequest } from "./provider";

/** A client that records the request bodies and rejects `reasoning_effort` for the models listed. */
function fakeClient(rejecting: string[] = []): { client: MistralClient; bodies: ChatCompletionRequest[] } {
  const bodies: ChatCompletionRequest[] = [];
  const client = {
    complete: async (body: ChatCompletionRequest) => {
      bodies.push(body);
      if (body.reasoning_effort && rejecting.includes(body.model))
        throw new ApiError("Extra inputs are not permitted: reasoning_effort", "request", "mistral", 422);
      return { content: "{}", finishReason: "stop", usage: null, model: body.model };
    },
  } as unknown as MistralClient;
  return { client, bodies };
}

const request = (model: string, reasoningEffort: JsonChatRequest["reasoningEffort"]): JsonChatRequest => ({
  model,
  system: "s",
  user: "u",
  format: { type: "json_object" },
  stream: false,
  reasoningEffort,
});

describe("MistralProvider reasoning effort", () => {
  it('sends "none", and "high" for any effort above it', async () => {
    const { client, bodies } = fakeClient();
    const provider = new MistralProvider(client);
    await provider.completeJson(request("mistral-small-latest", "none"));
    await provider.completeJson(request("mistral-small-latest", "medium"));
    await provider.completeJson(request("mistral-small-latest", "high"));
    await provider.completeJson(request("mistral-small-latest", undefined));
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["none", "high", "high", undefined]);
  });

  it("asks again without it when a model rejects it, and stops sending it to that model", async () => {
    const { client, bodies } = fakeClient(["mistral-large-latest"]);
    const provider = new MistralProvider(client);
    await expect(provider.completeJson(request("mistral-large-latest", "none"))).resolves.toMatchObject({ content: "{}" });
    await provider.completeJson(request("mistral-large-latest", "none"));
    await provider.completeJson(request("mistral-small-latest", "none"));
    expect(bodies.map((b) => [b.model, b.reasoning_effort])).toEqual([
      ["mistral-large-latest", "none"],
      ["mistral-large-latest", undefined],
      ["mistral-large-latest", undefined],
      ["mistral-small-latest", "none"],
    ]);
  });

  it("does not retry other errors", async () => {
    const client = {
      complete: async () => {
        throw new ApiError("Unauthorized", "auth", "mistral", 401);
      },
    } as unknown as MistralClient;
    await expect(new MistralProvider(client).completeJson(request("mistral-small-latest", "none"))).rejects.toMatchObject({ kind: "auth" });
  });
});
