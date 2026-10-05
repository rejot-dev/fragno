import { describe, expect, test } from "vitest";

import { createPiDurableModels, listSupportedPiDurableModels } from "./pi-durable-harness-options";

describe("listSupportedPiDurableModels", () => {
  test("returns no models when no durable provider credentials are configured", async () => {
    const models = createPiDurableModels({});

    expect(await listSupportedPiDurableModels(models)).toEqual([]);
  });

  test("returns only supported models from credential-configured providers", async () => {
    const models = createPiDurableModels({
      OPENAI_API_KEY: "test-openai-key",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      GEMINI_API_KEY: "test-gemini-key",
    });

    expect(await listSupportedPiDurableModels(models)).toEqual([
      { provider: "openai", modelId: "gpt-6-luna", label: "GPT-6 Luna" },
      { provider: "openai", modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { provider: "anthropic", modelId: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { provider: "google", modelId: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ]);
  });
});
