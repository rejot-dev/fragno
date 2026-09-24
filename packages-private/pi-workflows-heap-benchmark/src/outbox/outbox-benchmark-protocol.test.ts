import { describe, expect, it } from "vitest";

import {
  parseOutboxBenchmarkClientMessage,
  parseOutboxBenchmarkServerMessage,
} from "./outbox-benchmark-protocol";

describe("outbox benchmark process protocol", () => {
  it("accepts a complete client workload result", () => {
    expect(
      parseOutboxBenchmarkClientMessage({
        type: "complete",
        result: { payloadBytesConsumed: 131_072_000, checksum: 102_000 },
      }),
    ).toEqual({
      type: "complete",
      result: { payloadBytesConsumed: 131_072_000, checksum: 102_000 },
    });
  });

  it("accepts a server workload configuration", () => {
    expect(
      parseOutboxBenchmarkServerMessage({
        type: "start",
        config: {
          mode: "stream",
          baseUrl: "http://127.0.0.1:1234/outbox-benchmark",
          entryCount: 1_000,
          payloadBytes: 128 * 1_024,
          consumerDelayMs: 5,
          pageSize: 50,
          pollIntervalMs: 300,
        },
      }),
    ).toMatchObject({ type: "start", config: { mode: "stream", entryCount: 1_000 } });
  });

  it("rejects malformed process messages", () => {
    expect(() => parseOutboxBenchmarkClientMessage({ type: "complete", result: {} })).toThrow(
      "invalid client result",
    );
    expect(() =>
      parseOutboxBenchmarkServerMessage({
        type: "start",
        config: { mode: "stream", baseUrl: "http://localhost" },
      }),
    ).toThrow("invalid workload configuration");
  });
});
