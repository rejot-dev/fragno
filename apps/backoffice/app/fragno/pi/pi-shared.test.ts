import { assert, describe, expect, it } from "vitest";

import {
  findPiModelOption,
  PI_SUPPORTED_MODELS,
  PI_SYSTEM_PROMPT,
  PI_THINKING_LEVEL,
  PI_TOOL_IDS,
  resolvePiModelThinkingLevel,
} from "./pi-shared";

describe("pi-shared helpers", () => {
  it("offers the supported OpenAI models", () => {
    const openAiModels = PI_SUPPORTED_MODELS.filter((option) => option.provider === "openai");

    expect(openAiModels).toEqual([
      { provider: "openai", name: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { provider: "openai", name: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { provider: "openai", name: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]);
    expect(findPiModelOption("openai", "gpt-5.6-terra")).toEqual(openAiModels[1]);
  });

  it("defines the built-in Pi tools", () => {
    expect(PI_TOOL_IDS).toEqual(["execCodeMode", "read", "search"]);
    expect(PI_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    assert(PI_THINKING_LEVEL === "low");
  });

  it("uses medium reasoning for OpenAI models selected by the UI", () => {
    assert(resolvePiModelThinkingLevel("openai") === "medium");
    expect(resolvePiModelThinkingLevel("anthropic")).toBeUndefined();
    expect(resolvePiModelThinkingLevel("gemini")).toBeUndefined();
  });
});
