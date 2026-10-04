import { describe, expect, test, vi } from "vitest";

import type { Models } from "@earendil-works/pi-ai/models";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

import { createAuthorizedPiDurableModels } from "./pi-durable-authorized-models";

const model = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
} as Model<"openai-responses">;

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "One response" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("authorized durable Pi models", () => {
  test("forwards a provider stream result when completion has no done event", async () => {
    const expected = assistantMessage();
    const source = createAssistantMessageEventStream();
    source.end(expected);
    const streamSimple = vi.fn(() => source);
    const models = { streamSimple } as unknown as Models;
    const authorize = vi.fn(async () => undefined);
    const authorized = createAuthorizedPiDurableModels(models, authorize);

    const result = await authorized.streamSimple(model, [] as never).result();

    expect(result).toEqual(expected);
    expect(authorize).toHaveBeenCalledOnce();
    expect(streamSimple).toHaveBeenCalledOnce();
  });
});
