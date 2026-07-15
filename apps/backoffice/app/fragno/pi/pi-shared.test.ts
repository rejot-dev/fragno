import { describe, expect, it, assert } from "vitest";

import {
  createPiAgentName,
  DEFAULT_PI_HARNESSES,
  DEFAULT_PI_HARNESS,
  findPiModelOption,
  parsePiAgentName,
  PI_MODEL_CATALOG,
  resolvePiHarnesses,
  resolvePiModelThinkingLevel,
} from "./pi-shared";

describe("pi-shared helpers", () => {
  it("builds and parses agent names", () => {
    const agent = createPiAgentName({
      harnessId: "support",
      provider: "openai",
      model: "gpt-5.2",
    });

    expect(agent).toBe("support::openai::gpt-5.2");
    expect(parsePiAgentName(agent)).toEqual({
      harnessId: "support",
      provider: "openai",
      model: "gpt-5.2",
    });
  });

  it("returns null for invalid agent names", () => {
    expect(parsePiAgentName("invalid")).toBeNull();
    expect(parsePiAgentName("a::b")).toBeNull();
  });

  it("offers GPT-5.6 Luna as the default OpenAI model", () => {
    const openAiModels = PI_MODEL_CATALOG.filter((option) => option.provider === "openai");

    expect(openAiModels).toEqual([
      { provider: "openai", name: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { provider: "openai", name: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { provider: "openai", name: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]);
    expect(findPiModelOption("openai", "gpt-5.6-terra")).toEqual(openAiModels[1]);
  });

  it("uses medium reasoning for OpenAI models", () => {
    assert(resolvePiModelThinkingLevel("openai") === "medium");
    expect(resolvePiModelThinkingLevel("anthropic")).toBeUndefined();
    expect(resolvePiModelThinkingLevel("gemini")).toBeUndefined();
  });

  it("falls back to the single default harness", () => {
    const harnesses = resolvePiHarnesses([]);
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]?.id).toBe(DEFAULT_PI_HARNESS.id);
    expect(harnesses).toEqual(DEFAULT_PI_HARNESSES);
    expect(harnesses[0]?.tools).toEqual(["execCodeMode", "read", "bash"]);
    assert(harnesses[0]?.thinkingLevel === "low");
  });
});
