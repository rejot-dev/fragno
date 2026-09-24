import { describe, expect, it } from "vitest";

import {
  parsePiWorkflowBenchmarkClientMessage,
  parsePiWorkflowBenchmarkServerMessage,
} from "./pi-workflow-benchmark-protocol";

describe("Pi workflow benchmark process protocol", () => {
  it("accepts a complete server workload configuration", () => {
    expect(
      parsePiWorkflowBenchmarkServerMessage({
        type: "prepare",
        config: {
          mode: "stream",
          piBaseUrl: "http://127.0.0.1:1234/api/pi-harness",
          workflowsBaseUrl: "http://127.0.0.1:1234/api/workflows",
          workflowName: "poem-chat",
          sessionId: "session-1",
          prompt: "Write a poem.",
          pollIntervalMs: 300,
          waitTimeoutMs: 900_000,
        },
      }),
    ).toMatchObject({ type: "prepare", config: { mode: "stream", sessionId: "session-1" } });
  });

  it("accepts the completed workflow and outbox result", () => {
    expect(
      parsePiWorkflowBenchmarkClientMessage({
        type: "complete",
        result: {
          outboxEntriesRead: 700,
          status: { status: "waiting", runGeneration: 1 },
        },
      }),
    ).toEqual({
      type: "complete",
      result: {
        outboxEntriesRead: 700,
        status: { status: "waiting", runGeneration: 1 },
      },
    });
  });

  it("rejects malformed process messages", () => {
    expect(() =>
      parsePiWorkflowBenchmarkServerMessage({ type: "prepare", config: { mode: "poll" } }),
    ).toThrow("invalid workload configuration");
    expect(() => parsePiWorkflowBenchmarkClientMessage({ type: "complete", result: {} })).toThrow(
      "invalid client result",
    );
  });
});
