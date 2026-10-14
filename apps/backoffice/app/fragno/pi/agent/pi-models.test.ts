import { describe, expect, test } from "vitest";

import { createPiModels, listAvailablePiModels } from "./pi-models";

describe("listAvailablePiModels", () => {
  test("returns no models when no durable provider credentials are configured", async () => {
    const models = createPiModels({});

    expect(await listAvailablePiModels(models)).toEqual([]);
  });

  test("returns only supported models from credential-configured providers", async () => {
    const models = createPiModels({
      OPENAI_API_KEY: "test-openai-key",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      GEMINI_API_KEY: "test-gemini-key",
    });

    expect(await listAvailablePiModels(models)).toEqual([
      { provider: "openai", modelId: "gpt-6-luna", label: "GPT-6 Luna", contextWindow: 272_000 },
      { provider: "openai", modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol", contextWindow: 272_000 },
      {
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        contextWindow: 1_000_000,
      },
      {
        provider: "google",
        modelId: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        contextWindow: 1_048_576,
      },
    ]);
  });
});
