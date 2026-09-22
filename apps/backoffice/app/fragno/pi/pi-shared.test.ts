import { assert, describe, expect, it } from "vitest";

import { resolvePiModelThinkingLevel } from "./pi-shared";

describe("pi-shared helpers", () => {
  it("uses medium reasoning for OpenAI models selected by the UI", () => {
    assert(resolvePiModelThinkingLevel("openai") === "medium");
    expect(resolvePiModelThinkingLevel("anthropic")).toBeUndefined();
    expect(resolvePiModelThinkingLevel("gemini")).toBeUndefined();
  });
});
