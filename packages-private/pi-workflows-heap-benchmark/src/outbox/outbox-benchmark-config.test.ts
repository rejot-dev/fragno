import { describe, expect, it } from "vitest";

import { parseOutboxBenchmarkArguments } from "./outbox-benchmark-config";

describe("parseOutboxBenchmarkArguments", () => {
  it("uses the canonical backlog workload by default", () => {
    expect(parseOutboxBenchmarkArguments([])).toEqual({
      mode: "poll",
      scenario: "backlog",
      profile: false,
      entryCount: 1_000,
      historyEntryCount: 100,
      payloadBytes: 128 * 1_024,
      consumerDelayMs: 5,
      clientCount: 1,
      laggingClientCount: 1,
    });
  });

  it("accepts streaming and explicit workload dimensions", () => {
    expect(
      parseOutboxBenchmarkArguments([
        "--stream",
        "--live",
        "--profile",
        "--entries",
        "250",
        "--history-entries",
        "40",
        "--payload-kib",
        "64",
        "--consumer-delay-ms",
        "2",
        "--clients",
        "10",
        "--lagging-clients",
        "2",
      ]),
    ).toEqual({
      mode: "stream",
      scenario: "live",
      profile: true,
      entryCount: 250,
      historyEntryCount: 40,
      payloadBytes: 64 * 1_024,
      consumerDelayMs: 2,
      clientCount: 10,
      laggingClientCount: 2,
    });
  });

  it.each([
    ["--entries", "0"],
    ["--history-entries", "0"],
    ["--payload-kib", "1.5"],
    ["--consumer-delay-ms", "later"],
    ["--clients", "0"],
    ["--lagging-clients", "0"],
  ])("rejects an invalid %s value", (flag, value) => {
    expect(() => parseOutboxBenchmarkArguments([flag, value])).toThrow(
      `${flag} must be a positive integer.`,
    );
  });

  it("requires streaming for the live-tail scenario", () => {
    expect(() => parseOutboxBenchmarkArguments(["--live"])).toThrow("--live requires --stream.");
  });

  it("restricts lagging clients to a live workload with distinct historical positions", () => {
    expect(() => parseOutboxBenchmarkArguments(["--lagging-clients", "2"])).toThrow(
      "--lagging-clients requires --live.",
    );
    expect(() =>
      parseOutboxBenchmarkArguments([
        "--stream",
        "--live",
        "--history-entries",
        "1",
        "--lagging-clients",
        "2",
      ]),
    ).toThrow("--lagging-clients cannot exceed --history-entries.");
  });
});
