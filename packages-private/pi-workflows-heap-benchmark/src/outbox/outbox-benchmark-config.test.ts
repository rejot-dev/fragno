import { describe, expect, it } from "vitest";

import { parseOutboxBenchmarkArguments } from "./outbox-benchmark-config";

describe("parseOutboxBenchmarkArguments", () => {
  it("uses the canonical backlog workload by default", () => {
    expect(parseOutboxBenchmarkArguments([])).toEqual({
      mode: "poll",
      profile: false,
      entryCount: 1_000,
      payloadBytes: 128 * 1_024,
      consumerDelayMs: 5,
    });
  });

  it("accepts streaming and explicit workload dimensions", () => {
    expect(
      parseOutboxBenchmarkArguments([
        "--stream",
        "--profile",
        "--entries",
        "250",
        "--payload-kib",
        "64",
        "--consumer-delay-ms",
        "2",
      ]),
    ).toEqual({
      mode: "stream",
      profile: true,
      entryCount: 250,
      payloadBytes: 64 * 1_024,
      consumerDelayMs: 2,
    });
  });

  it.each([
    ["--entries", "0"],
    ["--payload-kib", "1.5"],
    ["--consumer-delay-ms", "later"],
  ])("rejects an invalid %s value", (flag, value) => {
    expect(() => parseOutboxBenchmarkArguments([flag, value])).toThrow(
      `${flag} must be a positive integer.`,
    );
  });
});
