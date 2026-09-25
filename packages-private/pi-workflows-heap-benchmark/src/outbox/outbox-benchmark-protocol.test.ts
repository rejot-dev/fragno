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
        result: {
          clientCount: 10,
          payloadBytesConsumed: 1_310_720_000,
          checksum: 102_000,
          controlFramesConsumed: 25,
          slowestClientDurationMs: 12_500,
          laggingEntriesConsumedByClient: [19, 42],
        },
      }),
    ).toEqual({
      type: "complete",
      result: {
        clientCount: 10,
        payloadBytesConsumed: 1_310_720_000,
        checksum: 102_000,
        controlFramesConsumed: 25,
        slowestClientDurationMs: 12_500,
        laggingEntriesConsumedByClient: [19, 42],
      },
    });
  });

  it("accepts a server workload configuration", () => {
    expect(
      parseOutboxBenchmarkServerMessage({
        type: "start",
        config: {
          mode: "stream",
          workload: {
            kind: "live",
            afterVersionstamp: "000000000000000000630000",
            laggingObservers: [
              { afterVersionstamp: null, pageSize: 1 },
              { afterVersionstamp: "000000000000000000310000", pageSize: 50 },
            ],
          },
          baseUrl: "http://127.0.0.1:1234/outbox-benchmark",
          entryCount: 1_000,
          payloadBytes: 128 * 1_024,
          consumerDelayMs: 5,
          pageSize: 50,
          pollIntervalMs: 300,
          clientCount: 10,
        },
      }),
    ).toMatchObject({
      type: "start",
      config: {
        mode: "stream",
        workload: {
          kind: "live",
          laggingObservers: [
            { afterVersionstamp: null, pageSize: 1 },
            { afterVersionstamp: "000000000000000000310000", pageSize: 50 },
          ],
        },
        entryCount: 1_000,
        clientCount: 10,
      },
    });
  });

  it("accepts the workload handshakes", () => {
    expect(parseOutboxBenchmarkClientMessage({ type: "started" })).toEqual({ type: "started" });
    expect(parseOutboxBenchmarkServerMessage({ type: "run" })).toEqual({ type: "run" });
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
