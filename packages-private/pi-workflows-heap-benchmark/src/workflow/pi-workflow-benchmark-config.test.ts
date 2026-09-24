import { describe, expect, it } from "vitest";

import { parsePiWorkflowBenchmarkArguments } from "./pi-workflow-benchmark-config";

describe("parsePiWorkflowBenchmarkArguments", () => {
  it("replays the deterministic trace in polling mode by default", () => {
    expect(parsePiWorkflowBenchmarkArguments([], {})).toEqual({
      mode: "poll",
      profile: false,
      agent: { kind: "recorded", replaySpeed: 4 },
    });
  });

  it("accepts server profiling and streaming replay", () => {
    expect(
      parsePiWorkflowBenchmarkArguments(["--stream", "--profile", "--replay-speed", "2"], {}),
    ).toEqual({
      mode: "stream",
      profile: true,
      agent: { kind: "recorded", replaySpeed: 2 },
    });
  });

  it("requires capture before selecting a paid provider", () => {
    expect(() =>
      parsePiWorkflowBenchmarkArguments(["--provider", "openai"], { OPENAI_API_KEY: "test" }),
    ).toThrow("require --capture");

    expect(
      parsePiWorkflowBenchmarkArguments(["--capture", "--provider", "openai"], {
        OPENAI_API_KEY: "test",
      }),
    ).toEqual({
      mode: "poll",
      profile: false,
      agent: { kind: "capture", provider: "openai", modelId: "gpt-5.6-luna" },
    });
  });
});
