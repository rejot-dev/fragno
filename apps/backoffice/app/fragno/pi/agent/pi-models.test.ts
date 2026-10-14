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
      { provider: "openai", modelId: "gpt-6-luna", label: "GPT-6 Luna" },
      { provider: "openai", modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { provider: "anthropic", modelId: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { provider: "google", modelId: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ]);
  });
});
