import { describe, expect, it } from "vitest";

import {
  createPiAgentName,
  DEFAULT_PI_HARNESSES,
  DEFAULT_PI_HARNESS,
  findPiModelOption,
  parsePiAgentName,
  PI_MODEL_CATALOG,
  resolvePiHarnesses,
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

  it("resolves known model options", () => {
    const first = PI_MODEL_CATALOG[0];
    expect(first).toBeDefined();
    if (first) {
      const option = findPiModelOption(first.provider, first.name);
      expect(option?.label).toBe(first.label);
    }
  });

  it("falls back to the single default harness", () => {
    const harnesses = resolvePiHarnesses([]);
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]?.id).toBe(DEFAULT_PI_HARNESS.id);
    expect(harnesses).toEqual(DEFAULT_PI_HARNESSES);
    expect(harnesses[0]?.tools).toEqual([
      "execCodeMode",
      "read",
      "bash",
      "listAutomations",
      "showWorkflow",
      "validateAutomation",
      "writeAutomation",
      "runAutomation",
    ]);
  });
});
