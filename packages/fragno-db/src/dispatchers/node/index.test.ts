import { describe, expect, it, vi } from "vitest";

import { createDurableHooksDispatcher } from "./dispatcher";

describe("createDurableHooksDispatcher", () => {
  it("should notify via macrotask wake hint", async () => {
    vi.useFakeTimers();
    try {
      const processDue = vi.fn().mockResolvedValue(0);
      const dispatcher = createDurableHooksDispatcher({
        processor: {
          processDue,
          process: processDue,
          getNextWakeAt: vi.fn().mockResolvedValue(null),
          drain: vi.fn().mockResolvedValue(undefined),
          namespace: "test",
        },
      });

      dispatcher.notify({ source: "request" });
      dispatcher.notify({ source: "request" });

      expect(processDue).toHaveBeenCalledTimes(0);
      await Promise.resolve();
      expect(processDue).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(processDue).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should wake and process hooks", async () => {
    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { processDue, process: processDue, getNextWakeAt, drain, namespace: "test" },
    });

    await dispatcher.wake();

    expect(processDue).toHaveBeenCalledTimes(1);
  });

  it("should coalesce overlapping wake calls", async () => {
    let resolveFirst!: (value: number) => void;
    const firstPromise = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    const processDue = vi.fn().mockReturnValueOnce(firstPromise).mockResolvedValue(0);
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: {
        processDue,
        process: processDue,
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain,
        namespace: "test",
      },
    });

    const first = dispatcher.wake();
    const second = dispatcher.wake();

    expect(processDue).toHaveBeenCalledTimes(1);

    resolveFirst(0);
    await first;
    await second;

    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("should poll and process when due", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() - 1000));
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { processDue, process: processDue, getNextWakeAt, drain, namespace: "test" },
      pollIntervalMs: 1000,
    });

    dispatcher.startPolling();
    await vi.advanceTimersByTimeAsync(1000);
    dispatcher.stopPolling();

    expect(processDue).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("should skip polling when next wake is in the future", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const processDue = vi.fn().mockResolvedValue(0);
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() + 60000));
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { processDue, process: processDue, getNextWakeAt, drain, namespace: "test" },
      pollIntervalMs: 1000,
    });

    dispatcher.startPolling();
    await vi.advanceTimersByTimeAsync(1000);
    dispatcher.stopPolling();

    expect(processDue).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
