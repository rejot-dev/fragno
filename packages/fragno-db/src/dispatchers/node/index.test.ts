import { assert, describe, expect, it, vi } from "vitest";

import { createDurableHooksDispatcher } from "./dispatcher";

const completedRun = (count = 0) => ({
  claimedCount: count,
  completion: Promise.resolve(count),
});

describe("createDurableHooksDispatcher", () => {
  it("should notify via macrotask wake hint", async () => {
    vi.useFakeTimers();
    try {
      const processDue = vi.fn().mockResolvedValue(completedRun());
      const dispatcher = createDurableHooksDispatcher({
        processor: {
          processDue,
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

  it("should continue processing after a notified run completes", async () => {
    const firstCompletion = Promise.withResolvers<number>();
    const processDue = vi
      .fn()
      .mockResolvedValueOnce({ claimedCount: 1, completion: firstCompletion.promise })
      .mockResolvedValue(completedRun());
    const dispatcher = createDurableHooksDispatcher({
      processor: {
        processDue,
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain: vi.fn().mockResolvedValue(undefined),
        namespace: "test",
      },
    });

    dispatcher.notify({ source: "request" });
    await vi.waitFor(() => {
      expect(processDue).toHaveBeenCalledTimes(1);
    });

    firstCompletion.resolve(1);
    await vi.waitFor(() => {
      expect(processDue).toHaveBeenCalledTimes(2);
    });
  });

  it("should wake and process hooks", async () => {
    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(null);
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { processDue, getNextWakeAt, drain, namespace: "test" },
    });

    await dispatcher.wake();

    expect(processDue).toHaveBeenCalledTimes(1);
  });

  it("should wait for started hooks to complete", async () => {
    const completion = Promise.withResolvers<number>();
    const processDue = vi
      .fn()
      .mockResolvedValueOnce({
        claimedCount: 1,
        completion: completion.promise,
      })
      .mockResolvedValue(completedRun());
    const dispatcher = createDurableHooksDispatcher({
      processor: {
        processDue,
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain: vi.fn().mockResolvedValue(undefined),
        namespace: "test",
      },
    });

    let wakeCompleted = false;
    const wake = dispatcher.wake().then(() => {
      wakeCompleted = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    assert(!wakeCompleted);

    completion.resolve(1);
    await wake;

    assert(wakeCompleted);
  });

  it("should keep waking until newly available hooks complete", async () => {
    const firstCompletion = Promise.withResolvers<number>();
    const secondCompletion = Promise.withResolvers<number>();
    const processDue = vi
      .fn()
      .mockResolvedValueOnce({ claimedCount: 1, completion: firstCompletion.promise })
      .mockResolvedValueOnce({ claimedCount: 1, completion: secondCompletion.promise })
      .mockResolvedValue(completedRun());
    const dispatcher = createDurableHooksDispatcher({
      processor: {
        processDue,
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain: vi.fn().mockResolvedValue(undefined),
        namespace: "test",
      },
    });

    let wakeCompleted = false;
    const wake = dispatcher.wake().then(() => {
      wakeCompleted = true;
    });
    await vi.waitFor(() => {
      expect(processDue).toHaveBeenCalledTimes(1);
    });

    firstCompletion.resolve(1);
    await vi.waitFor(() => {
      expect(processDue).toHaveBeenCalledTimes(2);
    });
    assert(!wakeCompleted);

    secondCompletion.resolve(1);
    await wake;

    assert(wakeCompleted);
    expect(processDue).toHaveBeenCalledTimes(3);
  });

  it("should coalesce overlapping wake calls", async () => {
    let resolveFirst!: (value: ReturnType<typeof completedRun>) => void;
    const firstPromise = new Promise<ReturnType<typeof completedRun>>((resolve) => {
      resolveFirst = resolve;
    });
    const processDue = vi.fn().mockReturnValueOnce(firstPromise).mockResolvedValue(completedRun());
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: {
        processDue,
        getNextWakeAt: vi.fn().mockResolvedValue(null),
        drain,
        namespace: "test",
      },
    });

    const first = dispatcher.wake();
    const second = dispatcher.wake();

    expect(processDue).toHaveBeenCalledTimes(1);

    resolveFirst(completedRun());
    await first;
    await second;

    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("should poll and process when due", async () => {
    vi.useFakeTimers();
    const now = new Date("2024-01-01T00:00:00Z");
    vi.setSystemTime(now);

    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() - 1000));
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { processDue, getNextWakeAt, drain, namespace: "test" },
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

    const processDue = vi.fn().mockResolvedValue(completedRun());
    const getNextWakeAt = vi.fn().mockResolvedValue(new Date(now.getTime() + 60000));
    const drain = vi.fn().mockResolvedValue(undefined);

    const dispatcher = createDurableHooksDispatcher({
      processor: { processDue, getNextWakeAt, drain, namespace: "test" },
      pollIntervalMs: 1000,
    });

    dispatcher.startPolling();
    await vi.advanceTimersByTimeAsync(1000);
    dispatcher.stopPolling();

    expect(processDue).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
