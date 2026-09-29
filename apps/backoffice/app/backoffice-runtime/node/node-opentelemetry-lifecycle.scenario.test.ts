import { afterEach, describe, expect, test, vi } from "vitest";

import {
  registerNodeOpenTelemetryLifecycle,
  shutdownNodeOpenTelemetry,
} from "./node-opentelemetry-lifecycle";

describe("Node OpenTelemetry lifecycle", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shutdownNodeOpenTelemetry();
  });

  test("continues process shutdown when telemetry does not stop before the deadline", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerNodeOpenTelemetryLifecycle({
      shutdown: () => new Promise<void>(() => {}),
    });

    const shutdown = shutdownNodeOpenTelemetry();
    await vi.advanceTimersByTimeAsync(5_000);
    await shutdown;

    expect(warn).toHaveBeenCalledWith(
      "Node OpenTelemetry shutdown exceeded 5000ms; continuing process shutdown.",
    );
  });

  test("continues process shutdown when telemetry shutdown fails", async () => {
    const error = new Error("Collector connection failed.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerNodeOpenTelemetryLifecycle({
      shutdown: async () => {
        throw error;
      },
    });

    await expect(shutdownNodeOpenTelemetry()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Node OpenTelemetry shutdown failed; continuing process shutdown.",
      error,
    );
  });
});
